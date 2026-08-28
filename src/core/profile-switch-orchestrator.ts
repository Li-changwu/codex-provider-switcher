import { lstat, open, readFile, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  removeActiveCustomAuth,
  validateProfileConfig,
  writeActiveConfig,
  writeActiveCustomAuth,
} from "./config";
import {
  applyRolloutChanges,
  createRolloutInversePatches,
  reverseRolloutInversePatch,
  scanRollouts,
  type RolloutChange,
} from "./rollouts";
import { updateProviderMetadata } from "./sqlite";
import {
  switchProfile as switchTransactionally,
  type MutationApplyContext,
  type PreparedSwitchMutation,
  type SwitchDependencies,
  type SwitchRequest,
  type SwitchResult,
} from "./switch-service";
import type { ActiveProfileSnapshot } from "./active-profile";
import type { AuthJournalTarget } from "./transaction";
import type { ProgressEvent } from "../ui/progress";
import { throwIfProgressCancelled } from "../ui/progress";
import type { CodexLayout, ProfileRecord } from "./types";

export interface ProfileLookup {
  get(id: string): Promise<ProfileRecord | undefined>;
  list(): Promise<readonly ProfileRecord[]>;
  withProfileLock?<Result>(operation: () => Promise<Result>): Promise<Result>;
}

export interface ProfileSecretReader {
  get(secretId: string): Promise<string | undefined>;
}

export interface ActiveProfileState {
  snapshot(): Promise<ActiveProfileSnapshot>;
  set(profileId: string): Promise<unknown>;
}

export interface StoredProfileSwitchDependencies {
  layout: CodexLayout;
  profiles: ProfileLookup;
  secrets: ProfileSecretReader;
  activeProfiles: ActiveProfileState;
  onProgress?: (event: ProgressEvent) => void;
  mutationHooks?: {
    afterSqliteUpdate?(): void | Promise<void>;
  };
}

export type ActiveProfileSwitchState =
  | "unchanged"
  | "updated"
  | "reconciliation-required";

export interface StoredProfileSwitchResult extends SwitchResult {
  readonly activeProfileState: ActiveProfileSwitchState;
}

/**
 * Materializes a stored Profile through the generic durable switch engine.
 * The active marker is deliberately an acknowledgement: it is written only
 * after the engine has committed, and a failed acknowledgement cannot undo a
 * committed configuration/session/database transition.
 */
export async function switchStoredProfile(
  request: SwitchRequest,
  dependencies: StoredProfileSwitchDependencies,
): Promise<StoredProfileSwitchResult> {
  if (request.signal?.aborted) {
    return {
      status: "cancelled",
      operationId: "unstarted",
      failureStage: "preflight",
      activeProfileState: "unchanged",
    };
  }

  let reconciliationRequired = false;
  const result = await switchTransactionally(
    request,
    createStoredProfileSwitchDependencies(
      request,
      dependencies,
      () => {
        reconciliationRequired = true;
      },
    ),
  );
  return {
    ...result,
    activeProfileState:
      result.status === "committed"
        ? result.acknowledgementFailed
          ? "reconciliation-required"
          : "updated"
        : reconciliationRequired
          ? "reconciliation-required"
          : "unchanged",
  };
}

interface PreparedStoredProfileSwitch {
  readonly target: ProfileRecord;
  readonly configText: string;
  readonly targetConfigIdentity: StoredConfigIdentity;
  readonly targetRecordFingerprint: string;
  readonly providerId: string;
  readonly targetApiKey?: string;
  readonly previous: ProfileRecord;
  readonly previousApiKey?: string;
  readonly priorAuthTarget: AuthJournalTarget;
}

function createStoredProfileSwitchDependencies(
  request: SwitchRequest,
  dependencies: StoredProfileSwitchDependencies,
  markReconciliationRequired: () => void,
): SwitchDependencies {
  let prepared: PreparedStoredProfileSwitch | undefined;
  let rolloutChanges: readonly RolloutChange[] = [];
  let inversePatches: ReturnType<typeof createRolloutInversePatches> = [];

  return {
    layout: dependencies.layout,
    onProgress: dependencies.onProgress,
    preflight: async () => {
      throwIfProgressCancelled(request.signal);
      const target = await requireProfile(
        dependencies.profiles,
        request.targetProfileId,
      );
      const configSnapshot = await readStoredConfigSnapshot(target, dependencies.layout);
      const validated = validateStoredConfig(configSnapshot.text, target);
      const providerId = validated.providerId ?? target.providerId;
      if (!providerId?.trim()) {
        throw preparationError();
      }

      const previous = await reconcileActiveStoredProfile(
        dependencies,
        markReconciliationRequired,
        request.signal,
      );
      const targetApiKey = await readCustomKey(target, dependencies.secrets);
      const previousApiKey = await readCustomKey(previous, dependencies.secrets);
      throwIfProgressCancelled(request.signal);
      prepared = {
        target,
        configText: configSnapshot.text,
        targetConfigIdentity: configSnapshot.identity,
        targetRecordFingerprint: profileRecordFingerprint(target),
        providerId,
        targetApiKey,
        previous,
        previousApiKey,
        priorAuthTarget: authTarget(dependencies.layout, previous),
      };
    },
    backup: async () => [
      { kind: "config" as const, path: dependencies.layout.configPath },
      { kind: "sqlite" as const, path: dependencies.layout.sqlitePath },
    ],
    scan: async (_context, report) => {
      throwIfProgressCancelled(request.signal);
      const scan = await scanRollouts(dependencies.layout, requirePrepared(prepared).providerId, {
        signal: request.signal,
        onProgress: (progress) => report(progress.completed, progress.total),
      });
      rolloutChanges = scan.changes;
      inversePatches = createRolloutInversePatches(scan.changes);
    },
    createMutationPlan: async () => {
      const materialization = requirePrepared(prepared);
      return {
        rollouts: rolloutChanges.map((change, index) => rolloutMutation(
          change,
          inversePatches[index],
          dependencies.layout,
          request.signal,
        )),
        sqlite: [{
          name: "update SQLite provider metadata",
          target: { kind: "sqlite" as const, path: dependencies.layout.sqlitePath },
          apply: async (context: MutationApplyContext) => {
            const result = await updateProviderMetadata(
              dependencies.layout,
              materialization.providerId,
              request.signal,
              { beforeUpdate: context.assertTargetUnchanged },
            );
            if (result.status !== "updated") {
              if (result.status === "cancelled") {
                throw abortError();
              }
              throw preparationError();
            }
          },
          rollback: async () => undefined,
        }],
        commit: [
          {
            name: "materialize active configuration",
            target: { kind: "config" as const, path: dependencies.layout.configPath },
            apply: async (context: MutationApplyContext) => {
              await assertPreparedTargetUnchanged(materialization, dependencies);
              await writeActiveConfig(dependencies.layout, materialization.configText, {
                beforePublish: context.assertTargetUnchanged,
              });
            },
            rollback: async () => undefined,
          },
          {
            name: "materialize active authentication mode",
            target: materialization.priorAuthTarget,
            apply: async () => {
              if (materialization.target.kind === "custom") {
                await writeActiveCustomAuth(
                  dependencies.layout,
                  materialization.targetApiKey as string,
                );
              } else {
                // Native login remains wholly under codex login; no OAuth data is read or stored.
                await removeActiveCustomAuth(dependencies.layout);
              }
            },
            rollback: async () => undefined,
          },
        ],
      };
    },
    verify: async () => {
      throwIfProgressCancelled(request.signal);
      await dependencies.mutationHooks?.afterSqliteUpdate?.();
    },
    restoreAuthMode: async (targetToRestore) => {
      await restoreActiveAuthMode(targetToRestore, dependencies, prepared);
    },
    acknowledge: async () => {
      await withProfileLock(dependencies.profiles, async () => {
        await assertPreparedTargetUnchanged(requirePrepared(prepared), dependencies);
        await dependencies.activeProfiles.set(requirePrepared(prepared).target.id);
      });
    },
  };
}

async function withProfileLock<Result>(
  profiles: ProfileLookup,
  operation: () => Promise<Result>,
): Promise<Result> {
  return profiles.withProfileLock
    ? profiles.withProfileLock(operation)
    : operation();
}

function rolloutMutation(
  change: RolloutChange,
  inversePatch: ReturnType<typeof createRolloutInversePatches>[number],
  layout: CodexLayout,
  signal?: AbortSignal,
): PreparedSwitchMutation {
  return {
    name: `synchronize rollout ${change.sessionId}`,
    target: { kind: "rollout" as const, path: change.path, inversePatch },
    apply: async (context: MutationApplyContext) => {
      await applyRolloutChanges([change], signal, {
        beforeRename: () => context.assertTargetUnchanged(),
      });
    },
    rollback: async () => {
      await reverseRolloutInversePatch(inversePatch, layout);
    },
  };
}

async function requireProfile(
  profiles: ProfileLookup,
  id: string,
): Promise<ProfileRecord> {
  let profile: ProfileRecord | undefined;
  try {
    profile = await profiles.get(id);
  } catch {
    throw preparationError();
  }
  if (!profile) {
    throw preparationError();
  }
  return profile;
}

async function readStoredConfig(profile: ProfileRecord, layout: CodexLayout): Promise<string> {
  return (await readStoredConfigSnapshot(profile, layout)).text;
}

interface StoredConfigSnapshot {
  readonly text: string;
  readonly identity: StoredConfigIdentity;
}

interface StoredConfigIdentity {
  readonly device: string;
  readonly inode: string;
  readonly links: string;
  readonly size: string;
  readonly modifiedAtNs: string;
  readonly changedAtNs: string;
}

async function readStoredConfigSnapshot(
  profile: ProfileRecord,
  layout: CodexLayout,
): Promise<StoredConfigSnapshot> {
  try {
    return await readTrustedStoredConfig(profile, layout);
  } catch {
    throw preparationError();
  }
}

async function readTrustedStoredConfig(
  profile: ProfileRecord,
  layout: CodexLayout,
): Promise<StoredConfigSnapshot> {
  if (!storedProfileIdPattern.test(profile.id)) {
    throw new Error("Profile identifier is not canonical.");
  }
  const codexHome = resolve(layout.codexHome);
  const switcher = resolve(layout.switcherDir);
  const profilesRoot = join(switcher, "profiles");
  const expectedSwitcher = join(codexHome, "provider-switcher");
  const profileDirectory = join(profilesRoot, profile.id);
  const expectedPath = join(profileDirectory, "config.toml");
  if (
    switcher !== expectedSwitcher ||
    profile.configFile !== expectedPath ||
    !isPathInsideOrEqual(codexHome, profilesRoot)
  ) {
    throw new Error("Profile configuration path is not managed.");
  }

  const rootBefore = await lstat(profilesRoot, { bigint: true });
  const directoryBefore = await lstat(profileDirectory, { bigint: true });
  const configBefore = await lstat(expectedPath, { bigint: true });
  assertSafeProfileDirectory(rootBefore);
  assertSafeProfileDirectory(directoryBefore);
  assertSafeProfileConfig(configBefore);
  const rootRealPath = await realpath(profilesRoot);
  const directoryRealPath = await realpath(profileDirectory);
  const configRealPath = await realpath(expectedPath);
  if (
    !isPathInsideOrEqual(codexHome, rootRealPath) ||
    !isDirectChild(rootRealPath, directoryRealPath) ||
    !sameResolvedPath(dirname(configRealPath), directoryRealPath)
  ) {
    throw new Error("Profile configuration escapes its managed directory.");
  }

  const handle = await open(expectedPath, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(configBefore, opened) || !isSafeProfileConfig(opened)) {
      throw new Error("Profile configuration changed before opening.");
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    const afterRead = await handle.stat({ bigint: true });
    const rootAfter = await lstat(profilesRoot, { bigint: true });
    const directoryAfter = await lstat(profileDirectory, { bigint: true });
    const configAfter = await lstat(expectedPath, { bigint: true });
    if (
      !sameFileIdentity(configBefore, afterRead) ||
      !sameFileIdentity(configBefore, configAfter) ||
      !sameFileIdentity(rootBefore, rootAfter) ||
      !sameFileIdentity(directoryBefore, directoryAfter) ||
      !isSafeProfileConfig(afterRead) ||
      !isSafeProfileConfig(configAfter) ||
      !isSafeProfileDirectory(rootAfter) ||
      !isSafeProfileDirectory(directoryAfter) ||
      !sameResolvedPath(await realpath(profilesRoot), rootRealPath) ||
      !sameResolvedPath(await realpath(profileDirectory), directoryRealPath) ||
      !sameResolvedPath(await realpath(expectedPath), configRealPath)
    ) {
      throw new Error("Profile configuration changed while being read.");
    }
    return {
      text: contents,
      identity: storedConfigIdentity(afterRead),
    };
  } finally {
    await handle.close();
  }
}

function storedConfigIdentity(stats: BigIntStats): StoredConfigIdentity {
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    links: stats.nlink.toString(),
    size: stats.size.toString(),
    modifiedAtNs: stats.mtimeNs.toString(),
    changedAtNs: stats.ctimeNs.toString(),
  };
}

function profileRecordFingerprint(profile: ProfileRecord): string {
  return JSON.stringify({
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    configFile: profile.configFile,
    providerId: profile.providerId,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  });
}

async function assertPreparedTargetUnchanged(
  prepared: PreparedStoredProfileSwitch,
  dependencies: StoredProfileSwitchDependencies,
): Promise<void> {
  const current = await requireProfile(dependencies.profiles, prepared.target.id);
  if (profileRecordFingerprint(current) !== prepared.targetRecordFingerprint) {
    throw preparationError();
  }
  const snapshot = await readStoredConfigSnapshot(current, dependencies.layout);
  if (
    snapshot.text !== prepared.configText ||
    JSON.stringify(snapshot.identity) !== JSON.stringify(prepared.targetConfigIdentity)
  ) {
    throw preparationError();
  }
  validateStoredConfig(snapshot.text, current);
}

const storedProfileIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertSafeProfileDirectory(stats: BigIntStats): void {
  if (!isSafeProfileDirectory(stats)) {
    throw new Error("Profile directory is unsafe.");
  }
}

function isSafeProfileDirectory(stats: BigIntStats): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink() && stats.ino !== 0n;
}

function assertSafeProfileConfig(stats: BigIntStats): void {
  if (!isSafeProfileConfig(stats)) {
    throw new Error("Profile configuration is unsafe.");
  }
}

function isSafeProfileConfig(stats: BigIntStats): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n && stats.ino !== 0n;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino !== 0n && left.ino === right.ino;
}

function isDirectChild(parent: string, child: string): boolean {
  return sameResolvedPath(dirname(child), parent);
}

function isPathInsideOrEqual(directory: string, candidate: string): boolean {
  const path = relative(resolve(directory), resolve(candidate));
  return !path.startsWith("..") && !isAbsolute(path);
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function validateStoredConfig(configText: string, profile: ProfileRecord) {
  try {
    return validateProfileConfig(configText, profile.kind);
  } catch {
    throw preparationError();
  }
}

async function reconcileActiveStoredProfile(
  dependencies: StoredProfileSwitchDependencies,
  markReconciliationRequired: () => void,
  signal?: AbortSignal,
): Promise<ProfileRecord> {
  try {
    throwIfProgressCancelled(signal);
    const activeConfig = await readActiveConfig(dependencies.layout);
    const profiles = await dependencies.profiles.list();
    if (!Array.isArray(profiles)) {
      throw preparationError();
    }
    const matches: ProfileRecord[] = [];
    for (const profile of profiles) {
      throwIfProgressCancelled(signal);
      const configText = await readStoredConfig(profile, dependencies.layout);
      validateStoredConfig(configText, profile);
      if (configText === activeConfig) {
        matches.push(profile);
      }
    }
    if (matches.length !== 1) {
      throw preparationError();
    }

    const [matchedProfile] = matches;
    const snapshot = await dependencies.activeProfiles.snapshot();
    if (
      snapshot.state === "missing" ||
      snapshot.record.profileId !== matchedProfile.id
    ) {
      await dependencies.activeProfiles.set(matchedProfile.id);
    }
    return matchedProfile;
  } catch {
    markReconciliationRequired();
    throw preparationError();
  }
}

async function readActiveConfig(layout: CodexLayout): Promise<string> {
  try {
    return await readFile(layout.configPath, "utf8");
  } catch {
    throw preparationError();
  }
}

async function readCustomKey(
  profile: ProfileRecord,
  secrets: ProfileSecretReader,
): Promise<string | undefined> {
  if (profile.kind === "official") {
    return undefined;
  }
  if (!profile.apiKeySecretId) {
    throw preparationError();
  }
  let apiKey: string | undefined;
  try {
    apiKey = await secrets.get(profile.apiKeySecretId);
  } catch {
    throw preparationError();
  }
  if (!apiKey?.trim()) {
    throw preparationError();
  }
  return apiKey;
}

function authTarget(layout: CodexLayout, previous: ProfileRecord): AuthJournalTarget {
  if (previous.kind === "official") {
    return { kind: "auth", path: layout.authPath, previousMode: "official" };
  }
  return {
    kind: "auth",
    path: layout.authPath,
    previousMode: "custom",
    customProfileId: previous.id,
  };
}

async function restoreActiveAuthMode(
  target: AuthJournalTarget,
  dependencies: StoredProfileSwitchDependencies,
  prepared: PreparedStoredProfileSwitch | undefined,
): Promise<void> {
  if (target.previousMode === "official") {
    await removeActiveCustomAuth(dependencies.layout);
    return;
  }
  if (
    prepared?.previous.kind === "custom" &&
    prepared.previous.id === target.customProfileId &&
    prepared.previousApiKey
  ) {
    await writeActiveCustomAuth(dependencies.layout, prepared.previousApiKey);
    return;
  }
  const profile = await requireProfile(dependencies.profiles, target.customProfileId);
  if (profile.kind !== "custom") {
    throw preparationError();
  }
  await writeActiveCustomAuth(
    dependencies.layout,
    await readCustomKey(profile, dependencies.secrets) as string,
  );
}

function requirePrepared(
  prepared: PreparedStoredProfileSwitch | undefined,
): PreparedStoredProfileSwitch {
  if (!prepared) {
    throw preparationError();
  }
  return prepared;
}

function preparationError(): Error {
  return new Error("The provider switch operation could not be prepared.");
}

function abortError(): Error {
  const error = new Error("The provider switch was cancelled.");
  error.name = "AbortError";
  return error;
}
