import {
  chmod as nativeChmod,
  mkdir as nativeMkdir,
  open as nativeOpen,
  readFile as nativeReadFile,
  rename as nativeRename,
  unlink as nativeUnlink,
  writeFile as nativeWriteFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { parse as parseToml } from "@iarna/toml";
import type { CodexLayout, ProfileKind, ProfileRecord } from "./types";

const profilesDirectoryName = "profiles";
const indexFileName = "index.json";
const linuxPrivateFileMode = 0o600;
const profileSecretNamespace = "codex-provider-switcher.profile";
const profileLockFileName = ".create.lock";
const profileLockRecoveryFileName = ".create.lock.recovery";
const profileLockRecoveryClaimFileName = ".create.lock.recovery.claim";
const defaultLockRetryMs = 25;
const defaultLockTimeoutMs = 1_000;
const defaultStaleLockMs = 5 * 60_000;
const credentialKeyNames = new Set([
  "apikey",
  "accesskey",
  "access",
  "privatekey",
  "private",
  "secretkey",
  "secret",
  "secrets",
  "auth",
  "authentication",
  "authorization",
  "authorizationheader",
  "header",
  "headers",
  "httpheaders",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "tokens",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "passwd",
]);
const topLevelScalarConfigKeys = new Set([
  "modelprovider",
  "model",
  "modelreasoningeffort",
  "modelverbosity",
  "approvalpolicy",
  "sandboxmode",
]);
const topLevelNumericConfigKeys = new Set(["projectdocmaxbytes"]);
const providerStringConfigKeys = new Set(["name", "baseurl", "wireapi"]);
const providerNumericConfigKeys = new Set([
  "requestmaxretries",
  "streammaxretries",
  "streamidletimeoutms",
]);
const providerBooleanConfigKeys = new Set([
  "requiresopenaiauth",
  "supportswebsockets",
]);

export interface ProfileFileSystem {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface CreateProfileInput {
  name: string;
  kind: ProfileKind;
  configText: string;
  providerId?: string;
  apiKeySecretId?: string;
}

export interface ProfileStoreOptions {
  fileSystem?: ProfileFileSystem;
  now?: () => string;
  platform?: NodeJS.Platform;
  lockOptions?: ProfileLockOptions;
}

export interface ProfileLockOptions {
  clock?: () => number;
  fileSystem?: ProfileLockFileSystem;
  isProcessAlive?: (pid: number) => boolean | undefined;
  lockRetryMs?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export interface ProfileLockFileHandle {
  writeFile(contents: string, encoding: BufferEncoding): Promise<void>;
  close(): Promise<void>;
}

export interface ProfileLockFileSystem {
  mkdir(path: string): Promise<void>;
  open(
    path: string,
    flags: "wx",
    mode: number,
  ): Promise<ProfileLockFileHandle>;
  readFile(path: string): Promise<string>;
  unlinkStaleLock(path: string, expectedContents: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export type ProfileStoreErrorCode =
  | "invalid-config"
  | "index-read-failed"
  | "index-invalid"
  | "persistence-failed"
  | "rollback-failed";

export class ProfileStoreError extends Error {
  constructor(
    readonly code: ProfileStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProfileStoreError";
  }
}

export class ProfileStore {
  private readonly fileSystem: ProfileFileSystem;
  private readonly indexPath: string;
  private readonly now: () => string;
  private readonly platform: NodeJS.Platform;
  private readonly profilesDir: string;
  private readonly lockOptions: ProfileLockOptions;

  constructor(
    private readonly layout: CodexLayout,
    options: ProfileStoreOptions = {},
  ) {
    this.fileSystem = options.fileSystem ?? nativeProfileFileSystem;
    this.now = options.now ?? (() => new Date().toISOString());
    this.platform = options.platform ?? process.platform;
    this.lockOptions = options.lockOptions ?? {};
    this.profilesDir = join(layout.switcherDir, profilesDirectoryName);
    this.indexPath = join(this.profilesDir, indexFileName);
  }

  async create(input: CreateProfileInput): Promise<ProfileRecord> {
    assertNoCredentialAssignments(input.configText);
    return this.withCreateLock(async () => {
      const profiles = await this.readProfiles();
      const id = nextProfileId(input.name, profiles);
      const timestamp = this.now();
      const profile: ProfileRecord = {
        id,
        name: input.name,
        kind: input.kind,
        configFile: join(this.profilesDir, id, "config.toml"),
        providerId: input.providerId,
        apiKeySecretId:
          input.kind === "custom" ? profileApiKeySecretId(id) : undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await this.writeAtomically(profile.configFile, input.configText);
      try {
        await this.writeAtomically(
          this.indexPath,
          `${JSON.stringify(
            { profiles: [...profiles, toPublicProfileRecord(profile)] },
            undefined,
            2,
          )}\n`,
        );
      } catch (error: unknown) {
        await this.rollbackConfig(profile.configFile);
        if (
          error instanceof ProfileStoreError &&
          error.code === "rollback-failed"
        ) {
          throw error;
        }
        throw new ProfileStoreError(
          "persistence-failed",
          "Could not save the profile index.",
          { cause: error },
        );
      }
      return profile;
    });
  }

  async get(id: string): Promise<ProfileRecord | undefined> {
    return (await this.list()).find((profile) => profile.id === id);
  }

  async list(): Promise<ProfileRecord[]> {
    const profiles = await this.readProfiles();
    return profiles.map(withDerivedSecretId);
  }

  private async readProfiles(): Promise<ProfileRecord[]> {
    let contents: string;
    try {
      contents = await this.fileSystem.readFile(this.indexPath);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw new ProfileStoreError(
        "index-read-failed",
        "Could not read the profile index.",
        { cause: error },
      );
    }

    try {
      const parsed = JSON.parse(contents) as { profiles?: unknown };
      if (!Array.isArray(parsed.profiles)) {
        throw new Error("missing profiles");
      }
      return parsed.profiles.map(parsePublicProfileRecord);
    } catch {
      throw new ProfileStoreError("index-invalid", "The profile index is not valid.");
    }
  }

  private async writeAtomically(path: string, contents: string): Promise<void> {
    const temporaryPath = join(
      dirname(path),
      `.${basename(path)}.tmp-${randomUUID()}`,
    );
    try {
      await this.fileSystem.mkdir(dirname(path));
      await this.fileSystem.writeFile(temporaryPath, contents);
      if (this.platform === "linux") {
        await this.fileSystem.chmod(temporaryPath, linuxPrivateFileMode);
      }
      await this.fileSystem.rename(temporaryPath, path);
    } catch (error: unknown) {
      await this.removeTemporaryFile(temporaryPath);
      throw new ProfileStoreError(
        "persistence-failed",
        "Could not write profile data.",
        { cause: error },
      );
    }
  }

  private async rollbackConfig(configPath: string): Promise<void> {
    try {
      await this.fileSystem.unlink(configPath);
    } catch (error: unknown) {
      throw new ProfileStoreError(
        "rollback-failed",
        "Could not recover the profile config after index persistence failed.",
        { cause: error },
      );
    }
  }

  private async removeTemporaryFile(path: string): Promise<void> {
    try {
      await this.fileSystem.unlink(path);
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw new ProfileStoreError(
          "rollback-failed",
          "Could not clean up temporary profile data.",
          { cause: error },
        );
      }
    }
  }

  private async withCreateLock<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const releaseLock = await acquireProfileFileLock(
      this.profilesDir,
      this.lockOptions,
    );
    try {
      return await operation();
    } finally {
      await releaseLock();
    }
  }
}

interface ProfileLockRecord {
  pid: number;
  createdAt: number;
}

type ProfileLockRelease = () => Promise<void>;

interface ProfileLockLease {
  contents: string;
  release: ProfileLockRelease;
}

async function acquireProfileFileLock(
  profilesDir: string,
  options: ProfileLockOptions,
): Promise<ProfileLockRelease> {
  const lockPath = join(profilesDir, profileLockFileName);
  const fileSystem = options.fileSystem ?? nativeProfileLockFileSystem;
  const clock = options.clock ?? Date.now;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const retryMs = Math.max(1, options.lockRetryMs ?? defaultLockRetryMs);
  const timeoutMs = Math.max(0, options.lockTimeoutMs ?? defaultLockTimeoutMs);
  const staleLockMs = Math.max(0, options.staleLockMs ?? defaultStaleLockMs);
  const attempts = Math.max(1, Math.floor(timeoutMs / retryMs) + 1);

  try {
    await fileSystem.mkdir(profilesDir);
  } catch (error: unknown) {
    throw new ProfileStoreError(
      "persistence-failed",
      "Could not prepare the profile lock directory.",
      { cause: error },
    );
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const acquired = await tryAcquireProfileFileLock(
      fileSystem,
      lockPath,
      clock(),
    );
    if (acquired) {
      return acquired;
    }

    await recoverStaleProfileFileLock(
      fileSystem,
      lockPath,
      clock,
      staleLockMs,
      isProcessAlive,
    );
    if (attempt + 1 < attempts) {
      await delay(retryMs);
    }
  }

  throw new ProfileStoreError(
    "persistence-failed",
    "Could not acquire the profile lock.",
  );
}

async function tryAcquireProfileFileLock(
  fileSystem: ProfileLockFileSystem,
  lockPath: string,
  createdAt: number,
): Promise<ProfileLockRelease | undefined> {
  const lease = await tryAcquireProfileLockLease(
    fileSystem,
    lockPath,
    createdAt,
  );
  return lease?.release;
}

async function tryAcquireProfileLockLease(
  fileSystem: ProfileLockFileSystem,
  lockPath: string,
  createdAt: number,
): Promise<ProfileLockLease | undefined> {
  let handle: ProfileLockFileHandle;
  try {
    handle = await fileSystem.open(lockPath, "wx", linuxPrivateFileMode);
  } catch (error: unknown) {
    if (isExistingFileError(error)) {
      return undefined;
    }
    throw new ProfileStoreError(
      "persistence-failed",
      "Could not create the profile lock.",
      { cause: error },
    );
  }

  const contents = JSON.stringify({ pid: process.pid, createdAt });
  let writeError: unknown;
  try {
    await handle.writeFile(contents, "utf8");
  } catch (error: unknown) {
    writeError = error;
  }
  try {
    await handle.close();
  } catch (error: unknown) {
    writeError ??= error;
  }
  if (writeError !== undefined) {
    try {
      await fileSystem.unlink(lockPath);
    } catch (cleanupError: unknown) {
      throw new ProfileStoreError(
        "rollback-failed",
        "Could not remove an incomplete profile lock.",
        { cause: cleanupError },
      );
    }
    throw new ProfileStoreError(
      "persistence-failed",
      "Could not write the profile lock.",
      { cause: writeError },
    );
  }

  return {
    contents,
    release: createProfileLockRelease(fileSystem, lockPath, contents),
  };
}

function createProfileLockRelease(
  fileSystem: ProfileLockFileSystem,
  lockPath: string,
  contents: string,
): ProfileLockRelease {
  return async () => {
    try {
      if ((await fileSystem.readFile(lockPath)) !== contents) {
        throw new Error("Profile lock ownership changed.");
      }
      await fileSystem.unlink(lockPath);
    } catch (error: unknown) {
      throw new ProfileStoreError(
        "persistence-failed",
        "Could not release the profile lock.",
        { cause: error },
      );
    }
  };
}

async function recoverStaleProfileFileLock(
  fileSystem: ProfileLockFileSystem,
  lockPath: string,
  clock: () => number,
  staleLockMs: number,
  isProcessAlive: (pid: number) => boolean | undefined,
): Promise<void> {
  const recoveryLockPath = join(dirname(lockPath), profileLockRecoveryFileName);
  const releaseRecoveryGuard = await acquireRecoveryGuard(
    fileSystem,
    recoveryLockPath,
    clock(),
    clock,
    staleLockMs,
    isProcessAlive,
  );
  if (!releaseRecoveryGuard) {
    return;
  }

  try {
    await recoverStaleProfileFileLockWhileGuarded(
      fileSystem,
      lockPath,
      clock,
      staleLockMs,
      isProcessAlive,
    );
  } finally {
    await releaseRecoveryGuard();
  }
}

async function acquireRecoveryGuard(
  fileSystem: ProfileLockFileSystem,
  recoveryLockPath: string,
  createdAt: number,
  clock: () => number,
  staleLockMs: number,
  isProcessAlive: (pid: number) => boolean | undefined,
): Promise<ProfileLockRelease | undefined> {
  const recoveryClaimPath = join(
    dirname(recoveryLockPath),
    profileLockRecoveryClaimFileName,
  );
  const acquired = await tryAcquireProfileFileLock(
    fileSystem,
    recoveryLockPath,
    createdAt,
  );
  if (acquired) {
    try {
      const claimStatus = await recoverOrphanedRecoveryClaim(
        fileSystem,
        recoveryClaimPath,
        clock,
        staleLockMs,
        isProcessAlive,
      );
      if (claimStatus === "live") {
        await acquired();
        return undefined;
      }
    } catch (error: unknown) {
      try {
        await acquired();
      } catch (releaseError: unknown) {
        throw releaseError;
      }
      throw error;
    }
    return acquired;
  }

  const claimedContents = await recoverStaleRecoveryGuard(
    fileSystem,
    recoveryLockPath,
    recoveryClaimPath,
    clock,
    staleLockMs,
    isProcessAlive,
  );
  return claimedContents;
}

type RecoveryClaimStatus = "missing" | "stale" | "live";

async function recoverOrphanedRecoveryClaim(
  fileSystem: ProfileLockFileSystem,
  recoveryClaimPath: string,
  clock: () => number,
  staleLockMs: number,
  isProcessAlive: (pid: number) => boolean | undefined,
): Promise<RecoveryClaimStatus> {
  let contents: string;
  try {
    contents = await fileSystem.readFile(recoveryClaimPath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return "missing";
    }
    throw new ProfileStoreError(
      "persistence-failed",
      "Could not inspect the profile recovery claim.",
      { cause: error },
    );
  }

  const record = parseProfileLockRecord(contents);
  if (
    !record ||
    clock() - record.createdAt < staleLockMs ||
    isProcessAlive(record.pid) !== false
  ) {
    return "live";
  }

  try {
    await fileSystem.unlinkStaleLock(recoveryClaimPath, contents);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return "missing";
    }
    throw new ProfileStoreError(
      "persistence-failed",
      "Could not reclaim the stale profile recovery claim.",
      { cause: error },
    );
  }

  return "stale";
}

async function recoverStaleRecoveryGuard(
  fileSystem: ProfileLockFileSystem,
  recoveryLockPath: string,
  recoveryClaimPath: string,
  clock: () => number,
  staleLockMs: number,
  isProcessAlive: (pid: number) => boolean | undefined,
): Promise<ProfileLockRelease | undefined> {
  let contents: string;
  try {
    contents = await fileSystem.readFile(recoveryLockPath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw new ProfileStoreError(
      "persistence-failed",
      "Could not inspect the profile recovery guard.",
      { cause: error },
    );
  }

  const record = parseProfileLockRecord(contents);
  if (
    !record ||
    clock() - record.createdAt < staleLockMs ||
    isProcessAlive(record.pid) !== false
  ) {
    return undefined;
  }

  const releaseClaim = await acquireRecoveryClaim(
    fileSystem,
    recoveryClaimPath,
    clock,
    staleLockMs,
    isProcessAlive,
  );
  if (!releaseClaim) {
    return undefined;
  }

  let currentContents: string;
  try {
    currentContents = await fileSystem.readFile(recoveryLockPath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      await releaseClaim();
      return undefined;
    }
    try {
      await releaseClaim();
    } catch (cleanupError: unknown) {
      throw new ProfileStoreError(
        "persistence-failed",
        "Could not release the profile recovery claim after inspection failed.",
        { cause: cleanupError },
      );
    }
    throw new ProfileStoreError(
      "persistence-failed",
      "Could not inspect the profile recovery guard after claiming it.",
      { cause: error },
    );
  }

  if (currentContents !== contents) {
    await releaseClaim();
    return undefined;
  }

  try {
    await fileSystem.unlinkStaleLock(recoveryLockPath, contents);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return releaseClaim;
    }
    try {
      await releaseClaim();
    } catch (cleanupError: unknown) {
      throw new ProfileStoreError(
        "persistence-failed",
        "Could not release the profile recovery claim after a failed handoff.",
        { cause: cleanupError },
      );
    }
    throw new ProfileStoreError(
      "persistence-failed",
      "Could not complete the stale profile recovery claim.",
      { cause: error },
    );
  }

  return releaseClaim;
}

async function acquireRecoveryClaim(
  fileSystem: ProfileLockFileSystem,
  recoveryClaimPath: string,
  clock: () => number,
  staleLockMs: number,
  isProcessAlive: (pid: number) => boolean | undefined,
): Promise<ProfileLockRelease | undefined> {
  let contents: string;
  try {
    contents = await fileSystem.readFile(recoveryClaimPath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return tryAcquireRecoveryClaim(fileSystem, recoveryClaimPath, clock);
    }
    throw new ProfileStoreError(
      "persistence-failed",
      "Could not inspect the profile recovery claim.",
      { cause: error },
    );
  }

  const record = parseProfileLockRecord(contents);
  if (
    !record ||
    clock() - record.createdAt < staleLockMs ||
    isProcessAlive(record.pid) !== false
  ) {
    return undefined;
  }

  try {
    await fileSystem.unlinkStaleLock(recoveryClaimPath, contents);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw new ProfileStoreError(
      "persistence-failed",
      "Could not reclaim the stale profile recovery claim.",
      { cause: error },
    );
  }

  return tryAcquireRecoveryClaim(fileSystem, recoveryClaimPath, clock);
}

async function tryAcquireRecoveryClaim(
  fileSystem: ProfileLockFileSystem,
  recoveryClaimPath: string,
  clock: () => number,
): Promise<ProfileLockRelease | undefined> {
  const lease = await tryAcquireProfileLockLease(
    fileSystem,
    recoveryClaimPath,
    clock(),
  );
  if (!lease) {
    return undefined;
  }

  let claimContents: string;
  try {
    claimContents = await fileSystem.readFile(recoveryClaimPath);
  } catch (error: unknown) {
    const verificationError = new ProfileStoreError(
      "persistence-failed",
      "Could not verify the profile recovery claim.",
      { cause: error },
    );
    try {
      await lease.release();
    } catch (cleanupError: unknown) {
      throw new ProfileStoreError(
        "rollback-failed",
        "Could not release the profile recovery claim after verification failed.",
        {
          cause: new AggregateError(
            [verificationError, cleanupError],
            "Could not verify and release the profile recovery claim.",
          ),
        },
      );
    }
    throw verificationError;
  }
  if (claimContents !== lease.contents) {
    await lease.release();
    return undefined;
  }

  return lease.release;
}

async function recoverStaleProfileFileLockWhileGuarded(
  fileSystem: ProfileLockFileSystem,
  lockPath: string,
  clock: () => number,
  staleLockMs: number,
  isProcessAlive: (pid: number) => boolean | undefined,
): Promise<void> {
  let contents: string;
  try {
    contents = await fileSystem.readFile(lockPath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }
    throw new ProfileStoreError(
      "persistence-failed",
      "Could not inspect the profile lock.",
      { cause: error },
    );
  }

  const record = parseProfileLockRecord(contents);
  if (
    !record ||
    clock() - record.createdAt < staleLockMs ||
    isProcessAlive(record.pid) !== false
  ) {
    return;
  }

  try {
    await fileSystem.unlinkStaleLock(lockPath, contents);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }
    throw new ProfileStoreError(
      "persistence-failed",
      "Could not recover the stale profile lock.",
      { cause: error },
    );
  }
}

function parseProfileLockRecord(contents: string): ProfileLockRecord | undefined {
  try {
    const parsed = JSON.parse(contents) as Record<string, unknown>;
    if (
      Number.isSafeInteger(parsed.pid) &&
      (parsed.pid as number) > 0 &&
      typeof parsed.createdAt === "number" &&
      Number.isFinite(parsed.createdAt)
    ) {
      return {
        pid: parsed.pid as number,
        createdAt: parsed.createdAt,
      };
    }
  } catch {
    // An unverifiable lock remains in place until manually resolved.
  }
  return undefined;
}

function defaultIsProcessAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isProcessNotFoundError(error) ? false : undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function profileApiKeySecretId(profileId: string): string {
  return `${profileSecretNamespace}.${profileId}.api-key`;
}

export function normalizeProfileId(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "profile";
}

export function toPublicProfileRecord(
  profile: ProfileRecord,
): Omit<ProfileRecord, "apiKeySecretId"> {
  const { apiKeySecretId: _apiKeySecretId, ...publicProfile } = profile;
  return publicProfile;
}

function withDerivedSecretId(profile: ProfileRecord): ProfileRecord {
  return profile.kind === "custom"
    ? { ...profile, apiKeySecretId: profileApiKeySecretId(profile.id) }
    : profile;
}

function assertNoCredentialAssignments(configText: string): void {
  let parsedConfig: Record<string, unknown>;
  try {
    parsedConfig = parseToml(configText);
  } catch {
    throw new ProfileStoreError(
      "invalid-config",
      "Profile configuration must be valid TOML and must not include credentials.",
    );
  }

  if (containsCredentialKey(parsedConfig)) {
    throw new ProfileStoreError(
      "invalid-config",
      "Profile configuration must not include credentials.",
    );
  }

  assertSupportedProfileConfig(parsedConfig);
}

function containsCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsCredentialKey);
  }
  if (!value || typeof value !== "object" || value instanceof Date) {
    return false;
  }

  return Object.entries(value).some(
    ([key, nestedValue]) =>
      isCredentialKey(key) || containsCredentialKey(nestedValue),
  );
}

function isCredentialKey(key: string): boolean {
  const normalizedKey = normalizeConfigKey(key);
  if (normalizedKey === "requiresopenaiauth") {
    return false;
  }
  return [...credentialKeyNames].some((credentialKeyName) =>
    normalizedKey.endsWith(credentialKeyName),
  );
}

function assertSupportedProfileConfig(config: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(config)) {
    const normalizedKey = normalizeConfigKey(key);
    if (normalizedKey === "modelproviders") {
      assertProviderConfigs(value);
      continue;
    }
    if (topLevelScalarConfigKeys.has(normalizedKey) && typeof value === "string") {
      continue;
    }
    if (topLevelNumericConfigKeys.has(normalizedKey) && typeof value === "number") {
      continue;
    }
    throwInvalidProfileConfig();
  }
}

function assertProviderConfigs(value: unknown): void {
  if (!isConfigRecord(value)) {
    throwInvalidProfileConfig();
  }
  for (const providerConfig of Object.values(value)) {
    assertProviderConfig(providerConfig);
  }
}

function assertProviderConfig(value: unknown): void {
  if (!isConfigRecord(value)) {
    throwInvalidProfileConfig();
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    const normalizedKey = normalizeConfigKey(key);
    if (
      providerStringConfigKeys.has(normalizedKey) &&
      typeof fieldValue === "string"
    ) {
      continue;
    }
    if (
      providerNumericConfigKeys.has(normalizedKey) &&
      typeof fieldValue === "number"
    ) {
      continue;
    }
    if (
      providerBooleanConfigKeys.has(normalizedKey) &&
      typeof fieldValue === "boolean"
    ) {
      continue;
    }
    if (normalizedKey === "queryparams") {
      assertScalarConfigMap(fieldValue);
      continue;
    }
    throwInvalidProfileConfig();
  }
}

function assertScalarConfigMap(value: unknown): void {
  if (!isConfigRecord(value)) {
    throwInvalidProfileConfig();
  }
  for (const fieldValue of Object.values(value)) {
    if (
      !isConfigScalar(fieldValue) &&
      (!Array.isArray(fieldValue) || !fieldValue.every(isConfigScalar))
    ) {
      throwInvalidProfileConfig();
    }
  }
}

function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isConfigScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function throwInvalidProfileConfig(): never {
  throw new ProfileStoreError(
    "invalid-config",
    "Profile configuration must use supported non-secret Codex/provider settings.",
  );
}

function normalizeConfigKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function nextProfileId(name: string, profiles: readonly ProfileRecord[]): string {
  const baseId = normalizeProfileId(name);
  const usedIds = new Set(profiles.map((profile) => profile.id));
  if (!usedIds.has(baseId)) {
    return baseId;
  }
  let suffix = 2;
  while (usedIds.has(`${baseId}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}-${suffix}`;
}

function parsePublicProfileRecord(value: unknown): ProfileRecord {
  if (!value || typeof value !== "object") {
    throw new Error("invalid profile");
  }
  const profile = value as Record<string, unknown>;
  if (
    typeof profile.id !== "string" ||
    typeof profile.name !== "string" ||
    (profile.kind !== "official" && profile.kind !== "custom") ||
    typeof profile.configFile !== "string" ||
    typeof profile.createdAt !== "string" ||
    typeof profile.updatedAt !== "string" ||
    (profile.providerId !== undefined && typeof profile.providerId !== "string")
  ) {
    throw new Error("invalid profile");
  }
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    configFile: profile.configFile,
    providerId: profile.providerId,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isExistingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isProcessNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ESRCH";
}

const nativeProfileFileSystem: ProfileFileSystem = {
  async mkdir(path) {
    await nativeMkdir(path, { recursive: true });
  },
  readFile: (path) => nativeReadFile(path, "utf8"),
  async writeFile(path, contents) {
    await nativeWriteFile(path, contents, "utf8");
  },
  rename: nativeRename,
  chmod: nativeChmod,
  unlink: nativeUnlink,
};

const nativeProfileLockFileSystem: ProfileLockFileSystem = {
  async mkdir(path) {
    await nativeMkdir(path, { recursive: true });
  },
  open: nativeOpen,
  readFile: (path) => nativeReadFile(path, "utf8"),
  async unlinkStaleLock(path, expectedContents) {
    if ((await nativeReadFile(path, "utf8")) !== expectedContents) {
      return;
    }
    await nativeUnlink(path);
  },
  unlink: nativeUnlink,
};
