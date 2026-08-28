import {
  chmod as nativeChmod,
  lstat as nativeLstat,
  mkdir as nativeMkdir,
  open as nativeOpen,
  readFile as nativeReadFile,
  realpath as nativeRealpath,
  rename as nativeRename,
  unlink as nativeUnlink,
  writeFile as nativeWriteFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  hasComparableFileIdentity,
  hydrateWindowsFileIdentity,
  sameStableFileIdentity,
  type FileIdentity,
  type HydrateWindowsFileIdentityOptions,
} from "./file-identity";
import {
  createWindowsFileOperations,
  type WindowsFileIdentity,
} from "./windows-file-operations";
import {
  parseAndValidateProfileConfig,
  ProfileConfigPolicyError,
} from "./config-policy";
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
const storedProfileIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const publicProfileRecordKeys = new Set([
  "id",
  "name",
  "kind",
  "configFile",
  "providerId",
  "createdAt",
  "updatedAt",
]);

export interface ProfileFileSystem {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  openRead(path: string): Promise<ProfileReadFileHandle>;
  writeFile(path: string, contents: string): Promise<void>;
  writeFileExclusive(path: string, contents: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface ProfileReadFileHandle {
  stat(): Promise<BigIntStats>;
  readFile(): Promise<string>;
  close(): Promise<void>;
}

export interface CreateProfileInput {
  name: string;
  kind: ProfileKind;
  configText: string;
  providerId?: string;
  apiKeySecretId?: string;
}

export interface UpdateProfileInput {
  name: string;
  kind: ProfileKind;
  configText: string;
  providerId?: string;
}

export interface ProfileStoreOptions {
  fileSystem?: ProfileFileSystem;
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions;
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

interface ProfileDirectoryReservation {
  readonly id: string;
  readonly directory: ProfileFileIdentityStats;
}

interface TrustedProfileRoot {
  readonly home: ProfileFileIdentityStats;
  readonly switcher: ProfileFileIdentityStats;
  readonly profiles: ProfileFileIdentityStats;
}

interface TrustedProfileConfig {
  readonly root: TrustedProfileRoot;
  readonly directory: ProfileFileIdentityStats;
  readonly config: ProfileFileIdentityStats;
  readonly path: string;
}

type ProfileFileIdentityStats = BigIntStats & FileIdentity;

export class ProfileStore {
  private readonly fileSystem: ProfileFileSystem;
  private readonly indexPath: string;
  private readonly now: () => string;
  private readonly platform: NodeJS.Platform;
  private readonly profilesDir: string;
  private readonly lockOptions: ProfileLockOptions;
  private readonly fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined;

  constructor(
    private readonly layout: CodexLayout,
    options: ProfileStoreOptions = {},
  ) {
    this.fileSystem = options.fileSystem ?? nativeProfileFileSystem;
    this.now = options.now ?? (() => new Date().toISOString());
    this.platform = options.platform ?? process.platform;
    this.fileIdentityOptions = options.fileIdentityOptions;
    this.lockOptions = options.lockOptions ?? {};
    this.profilesDir = join(layout.switcherDir, profilesDirectoryName);
    this.indexPath = join(this.profilesDir, indexFileName);
  }

  async create(input: CreateProfileInput): Promise<ProfileRecord> {
    assertNoCredentialAssignments(input.configText);
    return this.withProfileLock(async () => {
      const profiles = await this.readProfiles();
      const reservation = await this.reserveAvailableProfileId(input.name, profiles);
      const timestamp = this.now();
      const profile: ProfileRecord = {
        id: reservation.id,
        name: input.name,
        kind: input.kind,
        configFile: join(this.profilesDir, reservation.id, "config.toml"),
        providerId: input.providerId,
        apiKeySecretId:
          input.kind === "custom" ? profileApiKeySecretId(reservation.id) : undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await this.ensureTrustedProfileConfig(profile.id, false, reservation.directory);
      const config = await this.writeNewConfigExclusively(
        profile.configFile,
        input.configText,
        reservation,
      );
      try {
        await this.writeAtomically(
          this.indexPath,
          `${JSON.stringify(
            { profiles: [...profiles, toPublicProfileRecord(profile)] },
            undefined,
            2,
          )}\n`,
          () => this.assertTrustedProfileConfigIdentity(
            profile.id,
            config,
            reservation.directory,
          ),
        );
      } catch {
        throw profileRollbackError(
          "The Profile configuration was retained because the index could not be saved.",
        );
      }
      return profile;
    });
  }

  async get(id: string): Promise<ProfileRecord | undefined> {
    return (await this.list()).find((profile) => profile.id === id);
  }

  /**
   * Returns a managed Profile's TOML only after revalidating its trusted path.
   * UI callers must not read Profile files independently.
   */
  async readConfig(id: string): Promise<string | undefined> {
    if (!(await this.get(id))) {
      return undefined;
    }
    return this.withProfileLock(async () => {
      const profile = await this.get(id);
      if (!profile) {
        return undefined;
      }
      try {
        const configText = await this.readTrustedProfileConfig(profile.id);
        assertNoCredentialAssignments(configText);
        return configText;
      } catch (error: unknown) {
        if (error instanceof ProfileStoreError) {
          throw error;
        }
        throw new ProfileStoreError(
          "persistence-failed",
          "Could not read the managed Profile configuration.",
          { cause: error },
        );
      }
    });
  }

  async update(
    id: string,
    input: UpdateProfileInput,
  ): Promise<ProfileRecord | undefined> {
    assertNoCredentialAssignments(input.configText);
    return this.withProfileLock(async () => {
      const profiles = await this.readProfiles();
      const index = profiles.findIndex((profile) => profile.id === id);
      if (index === -1) {
        return undefined;
      }

      const current = profiles[index];
      if (input.kind !== current.kind) {
        throw new ProfileStoreError(
          "invalid-config",
          "A Profile kind cannot be changed after creation.",
        );
      }
      try {
        await this.ensureTrustedProfileConfig(current.id, true);
      } catch (error: unknown) {
        throw new ProfileStoreError(
          "persistence-failed",
          "Could not access the existing Profile configuration.",
          { cause: error },
        );
      }

      const updated: ProfileRecord = {
        ...current,
        name: input.name,
        providerId: input.providerId,
        updatedAt: this.now(),
      };
      const config = await this.writeAtomically(updated.configFile, input.configText);
      try {
        const nextProfiles = [...profiles];
        nextProfiles[index] = updated;
        await this.writeAtomically(
          this.indexPath,
          `${JSON.stringify(
            { profiles: nextProfiles.map(toPublicProfileRecord) },
            undefined,
            2,
          )}\n`,
          () => this.assertTrustedProfileConfigIdentity(current.id, config),
        );
      } catch {
        throw profileRollbackError(
          "The Profile configuration was retained because the index update could not be saved.",
        );
      }
      return withDerivedSecretId(updated);
    });
  }

  async list(): Promise<ProfileRecord[]> {
    const profiles = await this.readProfiles();
    return profiles.map(withDerivedSecretId);
  }

  private async readProfiles(): Promise<ProfileRecord[]> {
    let contents: string;
    try {
      await this.ensureTrustedProfileRoot(false);
      const trustedContents = await this.readTrustedMetadataFile(this.indexPath);
      if (trustedContents === undefined) {
        return [];
      }
      contents = trustedContents;
    } catch (error: unknown) {
      throw new ProfileStoreError(
        "index-read-failed",
        "Could not read the profile index.",
        { cause: error },
      );
    }

    try {
      const parsed = JSON.parse(contents) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !hasOnlyProfileIndexKeys(parsed as Record<string, unknown>) ||
        !Array.isArray((parsed as { profiles?: unknown }).profiles)
      ) {
        throw new Error("missing profiles");
      }
      return (parsed as { profiles: unknown[] }).profiles.map((profile) =>
        parsePublicProfileRecord(profile, this.profilesDir),
      );
    } catch {
      throw new ProfileStoreError("index-invalid", "The profile index is not valid.");
    }
  }

  private async writeAtomically(
    path: string,
    contents: string,
    beforePublish?: () => Promise<void>,
  ): Promise<ProfileFileIdentityStats> {
    await this.ensureTrustedProfileWriteTarget(path);
    const temporaryPath = join(
      dirname(path),
      `.${basename(path)}.tmp-${randomUUID()}`,
    );
    let temporaryStats: ProfileFileIdentityStats | undefined;
    try {
      await this.fileSystem.mkdir(dirname(path));
      await this.fileSystem.writeFile(temporaryPath, contents);
      temporaryStats = await lstatBigIntWithFileIdentity(
        temporaryPath,
        this.fileIdentityOptions,
      );
      if (!isSafeProfileFile(temporaryStats)) {
        throw profilePersistenceError();
      }
      if (this.platform === "linux") {
        await this.fileSystem.chmod(temporaryPath, linuxPrivateFileMode);
      }
      await this.ensureTrustedProfileWriteTarget(path);
      const beforeRename = await lstatBigIntWithFileIdentity(
        temporaryPath,
        this.fileIdentityOptions,
      );
      if (
        !isSafeProfileFile(beforeRename) ||
        !sameProfileFileIdentity(temporaryStats, beforeRename)
      ) {
        throw profilePersistenceError();
      }
      await beforePublish?.();
      await this.fileSystem.rename(temporaryPath, path);
      const published = await lstatBigIntWithFileIdentity(path, this.fileIdentityOptions);
      if (!isSafeProfileFile(published) || !sameProfileFileIdentity(temporaryStats, published)) {
        throw profilePersistenceError();
      }
      return published;
    } catch (error: unknown) {
      let cleanupError: unknown;
      try {
        await this.removeTemporaryFile(temporaryPath, temporaryStats);
      } catch (error: unknown) {
        cleanupError = error;
      }
      if (cleanupError !== undefined) {
        throw new ProfileStoreError(
          "rollback-failed",
          "Could not clean up temporary profile data.",
          {
            cause: new AggregateError(
              [error, cleanupError],
              "Profile data write and cleanup both failed.",
            ),
          },
        );
      }
      if (error instanceof ProfileStoreError && error.code === "rollback-failed") {
        throw error;
      }
      throw new ProfileStoreError(
        "persistence-failed",
        "Could not write profile data.",
        { cause: error },
      );
    }
  }

  private async writeNewConfigExclusively(
    path: string,
    contents: string,
    reservation: ProfileDirectoryReservation,
  ): Promise<ProfileFileIdentityStats> {
    await this.ensureTrustedProfileWriteTarget(path, reservation.directory);
    try {
      await this.fileSystem.mkdir(dirname(path));
      await this.ensureTrustedProfileWriteTarget(path, reservation.directory);
      if (await lstatBigIntIfPresent(path, this.fileIdentityOptions)) {
        throw profilePersistenceError();
      }
      // The Profile is not indexed yet, so exclusive creation avoids overwriting
      // another writer while no visible saved Profile can observe a partial file.
      await this.fileSystem.writeFileExclusive(path, contents, linuxPrivateFileMode);
      const written = await lstatBigIntWithFileIdentity(path, this.fileIdentityOptions);
      if (!isSafeProfileFile(written)) {
        throw profilePersistenceError();
      }
      await this.assertReservedProfileDirectory(reservation);
      await this.ensureTrustedProfileWriteTarget(path, reservation.directory);
      const published = await lstatBigIntWithFileIdentity(path, this.fileIdentityOptions);
      if (!isSafeProfileFile(published) || !sameProfileFileIdentity(written, published)) {
        throw profilePersistenceError();
      }
      return published;
    } catch (error: unknown) {
      if (error instanceof ProfileStoreError && error.code === "rollback-failed") {
        throw error;
      }
      throw new ProfileStoreError(
        "persistence-failed",
        "Could not write profile data.",
        { cause: error },
      );
    }
  }

  private async removeTemporaryFile(
    path: string,
    expectedStats: ProfileFileIdentityStats | undefined,
  ): Promise<void> {
    if (!expectedStats) {
      return;
    }
    try {
      await deleteTrustedProfileFile(
        path,
        expectedStats,
        this.fileIdentityOptions,
        () => this.fileSystem.unlink(path),
      );
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  async withProfileLock<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    await this.ensureTrustedProfileRoot(true);
    const releaseLock = await acquireProfileFileLock(
      this.profilesDir,
      this.lockOptions,
      this.fileIdentityOptions,
    );
    try {
      await this.ensureTrustedProfileRoot(true);
      return await operation();
    } finally {
      await releaseLock();
    }
  }

  private async ensureTrustedProfileRoot(create: boolean): Promise<void> {
    await this.inspectTrustedProfileRoot(create);
  }

  private async inspectTrustedProfileRoot(create: boolean): Promise<TrustedProfileRoot> {
    const codexHome = resolve(this.layout.codexHome);
    const switcher = resolve(this.layout.switcherDir);
    const expectedSwitcher = join(codexHome, "provider-switcher");
    if (!sameResolvedPath(switcher, expectedSwitcher)) {
      throw profilePersistenceError();
    }
    const home = await inspectTrustedProfileDirectory(codexHome, this.fileIdentityOptions);
    const switcherDirectory = await ensureTrustedProfileDirectory(
      switcher,
      home,
      create,
      this.fileIdentityOptions,
    );
    const profiles = await ensureTrustedProfileDirectory(
      this.profilesDir,
      switcherDirectory,
      create,
      this.fileIdentityOptions,
    );
    return { home, switcher: switcherDirectory, profiles };
  }

  private async reserveAvailableProfileId(
    name: string,
    profiles: readonly ProfileRecord[],
  ): Promise<ProfileDirectoryReservation> {
    const baseId = normalizeProfileId(name);
    const indexedIds = new Set(profiles.map((profile) => profile.id));
    await this.ensureTrustedProfileRoot(true);
    const profilesRoot = await inspectTrustedProfileDirectory(
      this.profilesDir,
      this.fileIdentityOptions,
    );
    let suffix = 1;
    while (true) {
      const id = suffix === 1 ? baseId : `${baseId}-${suffix}`;
      suffix += 1;
      if (indexedIds.has(id)) {
        continue;
      }
      const directory = join(this.profilesDir, id);
      try {
        // mkdir is the atomic reservation: an existing unindexed directory is
        // retained recovery state and must never be reused by a new Profile.
        await nativeMkdir(directory);
      } catch (error: unknown) {
        if (isExistingFileError(error)) {
          continue;
        }
        throw profilePersistenceError();
      }
      const reservedDirectory = await ensureTrustedProfileDirectory(
        directory,
        profilesRoot,
        false,
        this.fileIdentityOptions,
      );
      return { id, directory: reservedDirectory };
    }
  }

  private async ensureTrustedProfileConfig(
    id: string,
    requireExisting: boolean,
    expectedDirectory?: ProfileFileIdentityStats,
  ): Promise<void> {
    await this.inspectTrustedProfileConfig(id, requireExisting, expectedDirectory);
  }

  private async inspectTrustedProfileConfig(
    id: string,
    requireExisting: boolean,
    expectedDirectory?: ProfileFileIdentityStats,
  ): Promise<TrustedProfileConfig | undefined> {
    if (!storedProfileIdPattern.test(id)) {
      throw profilePersistenceError();
    }
    const root = await this.inspectTrustedProfileRoot(true);
    const profileDirectory = join(this.profilesDir, id);
    const directory = await ensureTrustedProfileDirectory(
      profileDirectory,
      root.profiles,
      !requireExisting,
      this.fileIdentityOptions,
    );
    if (expectedDirectory && !sameProfileFileIdentity(directory, expectedDirectory)) {
      throw profilePersistenceError();
    }
    const configPath = join(profileDirectory, "config.toml");
    const stats = await lstatBigIntIfPresent(configPath, this.fileIdentityOptions);
    if (!stats) {
      if (requireExisting) {
        throw profilePersistenceError();
      }
      return undefined;
    }
    if (!isSafeProfileFile(stats) || !sameResolvedPath(await nativeRealpath(configPath), configPath)) {
      throw profilePersistenceError();
    }
    return { root, directory, config: stats, path: configPath };
  }

  private async readTrustedProfileConfig(id: string): Promise<string> {
    const before = await this.inspectTrustedProfileConfig(id, true);
    if (!before) {
      throw profilePersistenceError();
    }

    const handle = await this.fileSystem.openRead(before.path);
    try {
      const opened = await hydrateProfileFileIdentity(
        before.path,
        await handle.stat(),
        this.fileIdentityOptions,
      );
      if (!isSafeProfileFile(opened) || !sameProfileFileIdentity(before.config, opened)) {
        throw profilePersistenceError();
      }
      const contents = await handle.readFile();
      const afterRead = await hydrateProfileFileIdentity(
        before.path,
        await handle.stat(),
        this.fileIdentityOptions,
      );
      const after = await this.inspectTrustedProfileConfig(id, true);
      if (
        !after ||
        !isSafeProfileFile(afterRead) ||
        !sameProfileFileIdentity(before.config, afterRead) ||
        !sameProfileFileIdentity(before.root.home, after.root.home) ||
        !sameProfileFileIdentity(before.root.switcher, after.root.switcher) ||
        !sameProfileFileIdentity(before.root.profiles, after.root.profiles) ||
        !sameProfileFileIdentity(before.directory, after.directory) ||
        !sameProfileFileIdentity(before.config, after.config)
      ) {
        throw profilePersistenceError();
      }
      return contents;
    } finally {
      await handle.close();
    }
  }

  private async assertTrustedProfileConfigIdentity(
    id: string,
    expectedConfig: ProfileFileIdentityStats,
    expectedDirectory?: ProfileFileIdentityStats,
  ): Promise<void> {
    const current = await this.inspectTrustedProfileConfig(
      id,
      true,
      expectedDirectory,
    );
    if (!current || !sameProfileFileIdentity(expectedConfig, current.config)) {
      throw profilePersistenceError();
    }
  }

  private async ensureTrustedMetadataFile(path: string): Promise<void> {
    await this.inspectTrustedMetadataFile(path);
  }

  private async inspectTrustedMetadataFile(
    path: string,
  ): Promise<ProfileFileIdentityStats | undefined> {
    const stats = await lstatBigIntIfPresent(path, this.fileIdentityOptions);
    if (
      stats &&
      (!isSafeProfileFile(stats) || !sameResolvedPath(await nativeRealpath(path), path))
    ) {
      throw profilePersistenceError();
    }
    return stats;
  }

  private async readTrustedMetadataFile(path: string): Promise<string | undefined> {
    let before = await this.inspectTrustedMetadataFile(path);
    let handle: ProfileReadFileHandle;
    try {
      handle = await this.fileSystem.openRead(path);
    } catch (error: unknown) {
      if (before === undefined && isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
    try {
      const opened = await hydrateProfileFileIdentity(
        path,
        await handle.stat(),
        this.fileIdentityOptions,
      );
      if (!isSafeProfileFile(opened)) {
        throw profilePersistenceError();
      }
      if (before === undefined) {
        before = await this.inspectTrustedMetadataFile(path);
        if (!before || !sameProfileFileIdentity(before, opened)) {
          throw profilePersistenceError();
        }
      } else if (!sameProfileFileIdentity(before, opened)) {
        throw profilePersistenceError();
      }
      const contents = await handle.readFile();
      const afterRead = await hydrateProfileFileIdentity(
        path,
        await handle.stat(),
        this.fileIdentityOptions,
      );
      const after = await this.inspectTrustedMetadataFile(path);
      if (
        !after ||
        !isSafeProfileFile(afterRead) ||
        !sameProfileFileIdentity(before, afterRead) ||
        !sameProfileFileIdentity(before, after)
      ) {
        throw profilePersistenceError();
      }
      return contents;
    } finally {
      await handle.close();
    }
  }

  private async ensureTrustedProfileWriteTarget(
    path: string,
    expectedDirectory?: ProfileFileIdentityStats,
  ): Promise<void> {
    const resolvedPath = resolve(path);
    if (sameResolvedPath(resolvedPath, this.indexPath)) {
      await this.ensureTrustedProfileRoot(true);
      await this.ensureTrustedMetadataFile(this.indexPath);
      return;
    }

    const relativeConfigPath = relative(this.profilesDir, resolvedPath);
    const segments = relativeConfigPath.split(/[\\/]/u);
    if (
      isAbsolute(relativeConfigPath) ||
      segments.length !== 2 ||
      !storedProfileIdPattern.test(segments[0]) ||
      segments[1] !== "config.toml"
    ) {
      throw profilePersistenceError();
    }
    await this.ensureTrustedProfileConfig(segments[0], false, expectedDirectory);
  }

  private async assertReservedProfileDirectory(
    reservation: ProfileDirectoryReservation,
  ): Promise<void> {
    await this.ensureTrustedProfileRoot(true);
    const profilesRoot = await inspectTrustedProfileDirectory(
      this.profilesDir,
      this.fileIdentityOptions,
    );
    const directory = await ensureTrustedProfileDirectory(
      join(this.profilesDir, reservation.id),
      profilesRoot,
      false,
      this.fileIdentityOptions,
    );
    if (!sameProfileFileIdentity(directory, reservation.directory)) {
      throw profilePersistenceError();
    }
  }
}

function profilePersistenceError(): ProfileStoreError {
  return new ProfileStoreError(
    "persistence-failed",
    "Could not safely access managed Profile storage.",
  );
}

function profileRollbackError(message: string): ProfileStoreError {
  return new ProfileStoreError("rollback-failed", message, {
    cause: new Error("Profile rollback failure details are redacted."),
  });
}

async function ensureTrustedProfileDirectory(
  path: string,
  expectedParent: ProfileFileIdentityStats,
  create: boolean,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<ProfileFileIdentityStats> {
  let stats = await lstatBigIntIfPresent(path, fileIdentityOptions);
  if (!stats && create) {
    await nativeMkdir(path);
    stats = await lstatBigIntIfPresent(path, fileIdentityOptions);
  }
  if (!stats || !isSafeProfileDirectory(stats)) {
    throw profilePersistenceError();
  }
  const parentPath = dirname(path);
  const parent = await lstatBigIntWithFileIdentity(parentPath, fileIdentityOptions);
  if (
    !isSafeProfileDirectory(parent) ||
    !sameProfileFileIdentity(parent, expectedParent) ||
    !sameResolvedPath(await nativeRealpath(path), path)
  ) {
    throw profilePersistenceError();
  }
  const after = await lstatBigIntWithFileIdentity(path, fileIdentityOptions);
  if (!isSafeProfileDirectory(after) || !sameProfileFileIdentity(stats, after)) {
    throw profilePersistenceError();
  }
  return after;
}

async function inspectTrustedProfileDirectory(
  path: string,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<ProfileFileIdentityStats> {
  const before = await lstatBigIntWithFileIdentity(path, fileIdentityOptions);
  if (!isSafeProfileDirectory(before) || !sameResolvedPath(await nativeRealpath(path), path)) {
    throw profilePersistenceError();
  }
  const after = await lstatBigIntWithFileIdentity(path, fileIdentityOptions);
  if (!isSafeProfileDirectory(after) || !sameProfileFileIdentity(before, after)) {
    throw profilePersistenceError();
  }
  return after;
}

function isSafeProfileDirectory(stats: ProfileFileIdentityStats): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink() && hasComparableFileIdentity(stats);
}

function isSafeProfileFile(stats: ProfileFileIdentityStats): boolean {
  return stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.nlink === 1n &&
    hasComparableFileIdentity(stats);
}

function sameProfileFileIdentity(
  left: ProfileFileIdentityStats,
  right: ProfileFileIdentityStats,
): boolean {
  return sameStableFileIdentity(left, right);
}

async function deleteTrustedProfileFile(
  path: string,
  expected: ProfileFileIdentityStats,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
  unlinkForCaller: () => Promise<void>,
): Promise<void> {
  if (!isSafeProfileFile(expected)) {
    throw profilePersistenceError();
  }

  if (
    profileIdentityPlatform(fileIdentityOptions) === "win32" &&
    isZeroProfileInode(expected.ino)
  ) {
    const windowsFileOperations = resolveProfileWindowsFileOperations(fileIdentityOptions);
    const expectedWindowsIdentity = requireProfileWindowsFileIdentity(expected);
    let result: "deleted" | "identity-mismatch";
    try {
      result = windowsFileOperations.deleteFileIfMatches(path, expectedWindowsIdentity);
    } catch {
      let afterNativeFailure: ProfileFileIdentityStats | undefined;
      try {
        afterNativeFailure = await lstatBigIntIfPresent(path, fileIdentityOptions);
      } catch {
        throw profilePersistenceError();
      }
      if (afterNativeFailure === undefined) {
        throw missingProfileFileError();
      }
      throw profilePersistenceError();
    }
    if (result !== "deleted") {
      throw profilePersistenceError();
    }
    return;
  }

  const current = await lstatBigIntWithFileIdentity(path, fileIdentityOptions);
  if (!isSafeProfileFile(current) || !sameProfileFileIdentity(current, expected)) {
    throw profilePersistenceError();
  }
  await unlinkForCaller();
}

function profileIdentityPlatform(
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): NodeJS.Platform {
  return fileIdentityOptions?.platform ?? process.platform;
}

function isZeroProfileInode(value: number | bigint): boolean {
  return value === 0 || value === 0n;
}

function resolveProfileWindowsFileOperations(
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
) {
  return fileIdentityOptions?.windowsFileOperations ?? createWindowsFileOperations();
}

function requireProfileWindowsFileIdentity(
  expected: ProfileFileIdentityStats,
): WindowsFileIdentity {
  try {
    const identityDescriptor = Object.getOwnPropertyDescriptor(
      expected,
      "windowsFileIdentity",
    );
    const identity = identityDescriptor && "value" in identityDescriptor
      ? identityDescriptor.value
      : undefined;
    if (
      !identity ||
      typeof identity !== "object" ||
      typeof (identity as WindowsFileIdentity).volumeSerial !== "string" ||
      typeof (identity as WindowsFileIdentity).fileId !== "string" ||
      (identity as WindowsFileIdentity).linkCount !== 1n ||
      expected.nlink !== 1n ||
      !/^[0-9a-f]{16}$/u.test((identity as WindowsFileIdentity).volumeSerial) ||
      !/^[0-9a-f]{32}$/u.test((identity as WindowsFileIdentity).fileId)
    ) {
      throw new Error("invalid Windows file identity");
    }
    return Object.freeze({
      volumeSerial: (identity as WindowsFileIdentity).volumeSerial,
      fileId: (identity as WindowsFileIdentity).fileId,
      linkCount: (identity as WindowsFileIdentity).linkCount,
    });
  } catch {
    throw profilePersistenceError();
  }
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function lstatBigIntIfPresent(
  path: string,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<ProfileFileIdentityStats | undefined> {
  try {
    return await lstatBigIntWithFileIdentity(path, fileIdentityOptions);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function lstatBigIntWithFileIdentity(
  path: string,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<ProfileFileIdentityStats> {
  return hydrateProfileFileIdentity(
    path,
    await nativeLstat(path, { bigint: true }),
    fileIdentityOptions,
  );
}

async function hydrateProfileFileIdentity(
  path: string,
  stats: BigIntStats,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<ProfileFileIdentityStats> {
  const identity = await hydrateWindowsFileIdentity(path, stats, fileIdentityOptions);
  if (identity.windowsFileIdentity === undefined) {
    return stats as ProfileFileIdentityStats;
  }
  Object.defineProperty(stats, "windowsFileIdentity", {
    configurable: false,
    enumerable: true,
    value: identity.windowsFileIdentity,
    writable: false,
  });
  return stats as ProfileFileIdentityStats;
}

interface ProfileLockRecord {
  pid: number;
  createdAt: number;
}

type ProfileLockRelease = () => Promise<void>;

interface ProfileLockLease {
  contents: string;
  identity: ProfileFileIdentityStats;
  release: ProfileLockRelease;
}

interface ProfileLockSnapshot {
  contents: string;
  identity: ProfileFileIdentityStats;
  state: ProfileLockReadState;
}

type ProfileLockReadState = "stable" | "changed-to-different-owner" | "unstable";

async function acquireProfileFileLock(
  profilesDir: string,
  options: ProfileLockOptions,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
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
      fileIdentityOptions,
    );
    if (acquired) {
      return acquired.release;
    }

    await recoverStaleProfileFileLock(
      fileSystem,
      lockPath,
      clock,
      staleLockMs,
      isProcessAlive,
      fileIdentityOptions,
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
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<ProfileLockLease | undefined> {
  return tryAcquireProfileLockLease(
    fileSystem,
    lockPath,
    createdAt,
    fileIdentityOptions,
  );
}

async function tryAcquireProfileLockLease(
  fileSystem: ProfileLockFileSystem,
  lockPath: string,
  createdAt: number,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
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
  let identity: ProfileFileIdentityStats | undefined;
  let writeError: unknown;
  try {
    await handle.writeFile(contents, "utf8");
    identity = await inspectTrustedProfileLock(lockPath, fileIdentityOptions);
  } catch (error: unknown) {
    writeError = error;
  }
  try {
    await handle.close();
  } catch (error: unknown) {
    writeError ??= error;
  }
  if (writeError !== undefined) {
    if (identity !== undefined) {
      try {
        await removeTrustedProfileLock(
          fileSystem,
          lockPath,
          { contents, identity, state: "stable" },
          fileIdentityOptions,
        );
      } catch (cleanupError: unknown) {
        throw new ProfileStoreError(
          "rollback-failed",
          "Could not remove an incomplete profile lock.",
          { cause: cleanupError },
        );
      }
    }
    throw new ProfileStoreError(
      "persistence-failed",
      "Could not write the profile lock.",
      { cause: writeError },
    );
  }

  return {
    contents,
    identity: identity!,
    release: createProfileLockRelease(
      fileSystem,
      lockPath,
      { contents, identity: identity!, state: "stable" },
      fileIdentityOptions,
    ),
  };
}

function createProfileLockRelease(
  fileSystem: ProfileLockFileSystem,
  lockPath: string,
  snapshot: ProfileLockSnapshot,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): ProfileLockRelease {
  return async () => {
    try {
      await removeTrustedProfileLock(fileSystem, lockPath, snapshot, fileIdentityOptions);
    } catch (error: unknown) {
      throw new ProfileStoreError(
        "persistence-failed",
        "Could not release the profile lock.",
        { cause: error },
      );
    }
  };
}

async function inspectTrustedProfileLock(
  path: string,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<ProfileFileIdentityStats> {
  const stats = await lstatBigIntWithFileIdentity(path, fileIdentityOptions);
  if (!isSafeProfileFile(stats)) {
    throw profilePersistenceError();
  }
  return stats;
}

async function readTrustedProfileLock(
  fileSystem: ProfileLockFileSystem,
  path: string,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<ProfileLockSnapshot> {
  const before = await inspectTrustedProfileLock(path, fileIdentityOptions);
  const contents = await fileSystem.readFile(path);
  const after = await inspectTrustedProfileLock(path, fileIdentityOptions);
  if (sameProfileFileIdentity(before, after)) {
    return { contents, identity: after, state: "stable" };
  }

  const replacementBefore = await inspectTrustedProfileLock(path, fileIdentityOptions);
  const replacementContents = await fileSystem.readFile(path);
  const replacementAfter = await inspectTrustedProfileLock(path, fileIdentityOptions);
  if (
    sameProfileFileIdentity(replacementBefore, replacementAfter) &&
    replacementContents !== contents
  ) {
    return {
      contents: replacementContents,
      identity: replacementAfter,
      state: "changed-to-different-owner",
    };
  }
  return {
    contents,
    identity: after,
    state: "unstable",
  };
}

async function removeTrustedProfileLock(
  fileSystem: ProfileLockFileSystem,
  path: string,
  expected: ProfileLockSnapshot,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
  stale = false,
): Promise<void> {
  if (
    profileIdentityPlatform(fileIdentityOptions) === "win32" &&
    isZeroProfileInode(expected.identity.ino)
  ) {
    await deleteTrustedProfileFile(
      path,
      expected.identity,
      fileIdentityOptions,
      async () => {
        throw new Error("Windows native profile lock deletion used the portable callback.");
      },
    );
    return;
  }

  const current = await readTrustedProfileLock(fileSystem, path, fileIdentityOptions);
  if (
    current.state !== "stable" ||
    current.contents !== expected.contents ||
    !sameProfileFileIdentity(current.identity, expected.identity)
  ) {
    throw profilePersistenceError();
  }
  await deleteTrustedProfileFile(
    path,
    expected.identity,
    fileIdentityOptions,
    async () => {
      if (stale && (await fileSystem.readFile(path)) !== expected.contents) {
        throw profilePersistenceError();
      }
      await fileSystem.unlink(path);
    },
  );
}

async function recoverStaleProfileFileLock(
  fileSystem: ProfileLockFileSystem,
  lockPath: string,
  clock: () => number,
  staleLockMs: number,
  isProcessAlive: (pid: number) => boolean | undefined,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<void> {
  const recoveryLockPath = join(dirname(lockPath), profileLockRecoveryFileName);
  const releaseRecoveryGuard = await acquireRecoveryGuard(
    fileSystem,
    recoveryLockPath,
    clock(),
    clock,
    staleLockMs,
    isProcessAlive,
    fileIdentityOptions,
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
      fileIdentityOptions,
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
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<ProfileLockRelease | undefined> {
  const recoveryClaimPath = join(
    dirname(recoveryLockPath),
    profileLockRecoveryClaimFileName,
  );
  const acquired = await tryAcquireProfileFileLock(
    fileSystem,
    recoveryLockPath,
    createdAt,
    fileIdentityOptions,
  );
  if (acquired) {
    try {
      const claimStatus = await recoverOrphanedRecoveryClaim(
        fileSystem,
        recoveryClaimPath,
        clock,
        staleLockMs,
        isProcessAlive,
        fileIdentityOptions,
      );
      if (claimStatus === "live") {
        await acquired.release();
        return undefined;
      }
    } catch (error: unknown) {
      try {
        await acquired.release();
      } catch (releaseError: unknown) {
        throw releaseError;
      }
      throw error;
    }
    return acquired.release;
  }

  const claimedContents = await recoverStaleRecoveryGuard(
    fileSystem,
    recoveryLockPath,
    recoveryClaimPath,
    clock,
    staleLockMs,
    isProcessAlive,
    fileIdentityOptions,
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
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<RecoveryClaimStatus> {
  let snapshot: ProfileLockSnapshot;
  try {
    snapshot = await readTrustedProfileLock(
      fileSystem,
      recoveryClaimPath,
      fileIdentityOptions,
    );
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

  const record = parseProfileLockRecord(snapshot.contents);
  if (
    !record ||
    clock() - record.createdAt < staleLockMs ||
    isProcessAlive(record.pid) !== false
  ) {
    return "live";
  }
  if (snapshot.state !== "stable") {
    throw profilePersistenceError();
  }

  try {
    await removeTrustedProfileLock(
      fileSystem,
      recoveryClaimPath,
      snapshot,
      fileIdentityOptions,
      true,
    );
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
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<ProfileLockRelease | undefined> {
  let snapshot: ProfileLockSnapshot;
  try {
    snapshot = await readTrustedProfileLock(
      fileSystem,
      recoveryLockPath,
      fileIdentityOptions,
    );
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

  const record = parseProfileLockRecord(snapshot.contents);
  if (
    !record ||
    clock() - record.createdAt < staleLockMs ||
    isProcessAlive(record.pid) !== false
  ) {
    return undefined;
  }
  if (snapshot.state !== "stable") {
    throw profilePersistenceError();
  }

  const releaseClaim = await acquireRecoveryClaim(
    fileSystem,
    recoveryClaimPath,
    clock,
    staleLockMs,
    isProcessAlive,
    fileIdentityOptions,
  );
  if (!releaseClaim) {
    return undefined;
  }

  let current: ProfileLockSnapshot;
  try {
    current = await readTrustedProfileLock(
      fileSystem,
      recoveryLockPath,
      fileIdentityOptions,
    );
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

  if (current.contents !== snapshot.contents) {
    await releaseClaim();
    return undefined;
  }
  if (
    current.state !== "stable" ||
    !sameProfileFileIdentity(current.identity, snapshot.identity)
  ) {
    await releaseClaim();
    throw profilePersistenceError();
  }

  try {
    await removeTrustedProfileLock(
      fileSystem,
      recoveryLockPath,
      snapshot,
      fileIdentityOptions,
      true,
    );
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
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<ProfileLockRelease | undefined> {
  let snapshot: ProfileLockSnapshot;
  try {
    snapshot = await readTrustedProfileLock(
      fileSystem,
      recoveryClaimPath,
      fileIdentityOptions,
    );
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return tryAcquireRecoveryClaim(
        fileSystem,
        recoveryClaimPath,
        clock,
        fileIdentityOptions,
      );
    }
    throw new ProfileStoreError(
      "persistence-failed",
      "Could not inspect the profile recovery claim.",
      { cause: error },
    );
  }

  const record = parseProfileLockRecord(snapshot.contents);
  if (
    !record ||
    clock() - record.createdAt < staleLockMs ||
    isProcessAlive(record.pid) !== false
  ) {
    return undefined;
  }
  if (snapshot.state !== "stable") {
    throw profilePersistenceError();
  }

  try {
    await removeTrustedProfileLock(
      fileSystem,
      recoveryClaimPath,
      snapshot,
      fileIdentityOptions,
      true,
    );
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

  return tryAcquireRecoveryClaim(
    fileSystem,
    recoveryClaimPath,
    clock,
    fileIdentityOptions,
  );
}

async function tryAcquireRecoveryClaim(
  fileSystem: ProfileLockFileSystem,
  recoveryClaimPath: string,
  clock: () => number,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<ProfileLockRelease | undefined> {
  const lease = await tryAcquireProfileLockLease(
    fileSystem,
    recoveryClaimPath,
    clock(),
    fileIdentityOptions,
  );
  if (!lease) {
    return undefined;
  }

  let claim: ProfileLockSnapshot;
  try {
    claim = await readTrustedProfileLock(
      fileSystem,
      recoveryClaimPath,
      fileIdentityOptions,
    );
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
  if (
    claim.state !== "stable" ||
    claim.contents !== lease.contents ||
    !sameProfileFileIdentity(claim.identity, lease.identity)
  ) {
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
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<void> {
  let snapshot: ProfileLockSnapshot;
  try {
    snapshot = await readTrustedProfileLock(fileSystem, lockPath, fileIdentityOptions);
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

  const record = parseProfileLockRecord(snapshot.contents);
  if (
    !record ||
    clock() - record.createdAt < staleLockMs ||
    isProcessAlive(record.pid) !== false
  ) {
    return;
  }
  if (snapshot.state !== "stable") {
    throw profilePersistenceError();
  }

  try {
    await removeTrustedProfileLock(
      fileSystem,
      lockPath,
      snapshot,
      fileIdentityOptions,
      true,
    );
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
    : { ...profile, apiKeySecretId: undefined };
}

function assertNoCredentialAssignments(configText: string): void {
  try {
    parseAndValidateProfileConfig(configText);
  } catch (error: unknown) {
    if (error instanceof ProfileConfigPolicyError) {
      throw new ProfileStoreError(
        "invalid-config",
        error.code === "malformed-toml"
          ? "Profile configuration must be valid TOML and must not include credentials."
          : error.message,
      );
    }
    throw error;
  }
}

function parsePublicProfileRecord(
  value: unknown,
  profilesDir: string,
): ProfileRecord {
  if (!value || typeof value !== "object") {
    throw new Error("invalid profile");
  }
  const profile = value as Record<string, unknown>;
  if (
    !hasOnlyPublicProfileRecordKeys(profile) ||
    typeof profile.id !== "string" ||
    !storedProfileIdPattern.test(profile.id) ||
    typeof profile.name !== "string" ||
    (profile.kind !== "official" && profile.kind !== "custom") ||
    typeof profile.configFile !== "string" ||
    typeof profile.createdAt !== "string" ||
    typeof profile.updatedAt !== "string" ||
    (profile.providerId !== undefined && typeof profile.providerId !== "string") ||
    profile.configFile !== join(profilesDir, profile.id, "config.toml")
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

function hasOnlyPublicProfileRecordKeys(
  value: Record<string, unknown>,
): boolean {
  return Object.keys(value).every((key) => publicProfileRecordKeys.has(key));
}

function hasOnlyProfileIndexKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => key === "profiles");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function missingProfileFileError(): NodeJS.ErrnoException {
  const error = new Error("Managed Profile file is missing.") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
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
  async openRead(path) {
    const handle = await nativeOpen(path, "r");
    return {
      stat: () => handle.stat({ bigint: true }),
      readFile: () => handle.readFile({ encoding: "utf8" }),
      close: () => handle.close(),
    };
  },
  async writeFile(path, contents) {
    await nativeWriteFile(path, contents, "utf8");
  },
  async writeFileExclusive(path, contents, mode) {
    await nativeWriteFile(path, contents, { encoding: "utf8", flag: "wx", mode });
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
  unlink: nativeUnlink,
};
