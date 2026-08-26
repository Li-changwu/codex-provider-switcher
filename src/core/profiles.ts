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
import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
const versionHashChunkSize = 64 * 1024;
const publicProfileRecordKeys = new Set([
  "id",
  "name",
  "kind",
  "configFile",
  "providerId",
  "createdAt",
  "updatedAt",
]);

interface ProfileConfigVersion {
  sha256: string;
  mode: bigint;
  device: bigint;
  inode: bigint;
  links: bigint;
  size: bigint;
  modifiedAtNs: bigint;
  changedAtNs: bigint;
}

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

export interface UpdateProfileInput {
  name: string;
  kind: ProfileKind;
  configText: string;
  providerId?: string;
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
    return this.withProfileLock(async () => {
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

      await this.ensureTrustedProfileConfig(profile.id, false);
      await this.writeAtomically(profile.configFile, input.configText);
      const writtenConfigVersion = await this.captureConfigVersion(
        profile.configFile,
      );
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
        await this.rollbackConfig(profile.configFile, writtenConfigVersion);
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
      let previousConfig: string;
      try {
        await this.ensureTrustedProfileConfig(current.id, true);
        previousConfig = await this.fileSystem.readFile(current.configFile);
      } catch (error: unknown) {
        throw new ProfileStoreError(
          "persistence-failed",
          "Could not read the existing Profile configuration.",
          { cause: error },
        );
      }

      const updated: ProfileRecord = {
        ...current,
        name: input.name,
        providerId: input.providerId,
        updatedAt: this.now(),
      };
      await this.writeAtomically(updated.configFile, input.configText);
      const writtenConfigVersion = await this.captureConfigVersion(
        updated.configFile,
      );
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
        );
      } catch (error: unknown) {
        try {
          await this.restoreConfig(
            current.configFile,
            previousConfig,
            writtenConfigVersion,
          );
        } catch {
          throw profileRollbackError(
            "Could not restore the Profile configuration after the index update failed.",
          );
        }
        if (
          error instanceof ProfileStoreError &&
          error.code === "rollback-failed"
        ) {
          throw error;
        }
        throw new ProfileStoreError(
          "persistence-failed",
          "Could not update the profile index.",
          { cause: error },
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
      await this.ensureTrustedMetadataFile(this.indexPath);
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
      return parsed.profiles.map((profile) =>
        parsePublicProfileRecord(profile, this.profilesDir),
      );
    } catch {
      throw new ProfileStoreError("index-invalid", "The profile index is not valid.");
    }
  }

  private async writeAtomically(
    path: string,
    contents: string,
    expectedVersion?: ProfileConfigVersion,
  ): Promise<void> {
    await this.ensureTrustedProfileWriteTarget(path);
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
      await this.ensureTrustedProfileWriteTarget(path);
      if (expectedVersion) {
        await this.assertConfigVersion(path, expectedVersion);
      }
      await this.fileSystem.rename(temporaryPath, path);
    } catch (error: unknown) {
      let cleanupError: unknown;
      try {
        await this.removeTemporaryFile(temporaryPath);
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

  private async rollbackConfig(
    configPath: string,
    expectedVersion: ProfileConfigVersion,
  ): Promise<void> {
    try {
      const actualVersion = await this.captureConfigVersion(configPath);
      if (!sameProfileConfigVersion(expectedVersion, actualVersion)) {
        throw new Error("Profile config changed outside the save operation.");
      }
      await this.fileSystem.unlink(configPath);
    } catch {
      throw profileRollbackError(
        "Could not recover the profile config after index persistence failed.",
      );
    }
  }

  private async restoreConfig(
    configPath: string,
    contents: string,
    expectedVersion: ProfileConfigVersion,
  ): Promise<void> {
    await this.writeAtomically(configPath, contents, expectedVersion);
  }

  private async assertConfigVersion(
    configPath: string,
    expectedVersion: ProfileConfigVersion,
  ): Promise<void> {
    const actualVersion = await this.captureConfigVersion(configPath);
    if (!sameProfileConfigVersion(expectedVersion, actualVersion)) {
      throw new ProfileStoreError(
        "rollback-failed",
        "The Profile configuration changed outside the save operation.",
      );
    }
  }

  private async captureConfigVersion(
    configPath: string,
  ): Promise<ProfileConfigVersion> {
    let handle: FileHandle | undefined;
    let version: ProfileConfigVersion | undefined;
    let primaryError: unknown;
    try {
      await this.ensureTrustedProfileWriteTarget(configPath);
      const pathBefore = await lstatBigIntIfPresent(configPath);
      if (!pathBefore || !isSafeProfileFile(pathBefore)) {
        throw new Error("Profile config is not a safe regular file.");
      }

      handle = await nativeOpen(configPath, "r");
      const openedStats = await handle.stat({ bigint: true });
      if (!sameStableProfileFileStats(pathBefore, openedStats)) {
        throw new Error("Profile config changed while being opened.");
      }
      const sha256 = await hashOpenedProfileConfig(handle);
      const finalStats = await handle.stat({ bigint: true });
      const pathAfter = await nativeLstat(configPath, { bigint: true });
      if (
        !sameStableProfileFileStats(openedStats, finalStats) ||
        !sameStableProfileFileStats(finalStats, pathAfter)
      ) {
        throw new Error("Profile config changed while being versioned.");
      }
      version = profileConfigVersion(finalStats, sha256);
    } catch (error: unknown) {
      primaryError = error;
    }

    if (handle) {
      try {
        await handle.close();
      } catch (closeError: unknown) {
        primaryError ??= closeError;
      }
    }
    if (primaryError !== undefined || !version) {
      throw profilePersistenceError();
    }
    return version;
  }

  private async removeTemporaryFile(path: string): Promise<void> {
    try {
      await this.fileSystem.unlink(path);
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  private async withProfileLock<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    await this.ensureTrustedProfileRoot(true);
    const releaseLock = await acquireProfileFileLock(
      this.profilesDir,
      this.lockOptions,
    );
    try {
      await this.ensureTrustedProfileRoot(true);
      return await operation();
    } finally {
      await releaseLock();
    }
  }

  private async ensureTrustedProfileRoot(create: boolean): Promise<void> {
    const codexHome = resolve(this.layout.codexHome);
    const switcher = resolve(this.layout.switcherDir);
    const expectedSwitcher = join(codexHome, "provider-switcher");
    if (!sameResolvedPath(switcher, expectedSwitcher)) {
      throw profilePersistenceError();
    }
    const home = await inspectTrustedProfileDirectory(codexHome);
    const switcherDirectory = await ensureTrustedProfileDirectory(
      switcher,
      home,
      create,
    );
    await ensureTrustedProfileDirectory(this.profilesDir, switcherDirectory, create);
  }

  private async ensureTrustedProfileConfig(id: string, requireExisting: boolean): Promise<void> {
    if (!storedProfileIdPattern.test(id)) {
      throw profilePersistenceError();
    }
    await this.ensureTrustedProfileRoot(true);
    const profileDirectory = join(this.profilesDir, id);
    const profilesRoot = await inspectTrustedProfileDirectory(this.profilesDir);
    await ensureTrustedProfileDirectory(profileDirectory, profilesRoot, !requireExisting);
    const configPath = join(profileDirectory, "config.toml");
    const stats = await lstatBigIntIfPresent(configPath);
    if (!stats) {
      if (requireExisting) {
        throw profilePersistenceError();
      }
      return;
    }
    if (!isSafeProfileFile(stats) || !sameResolvedPath(await nativeRealpath(configPath), configPath)) {
      throw profilePersistenceError();
    }
  }

  private async ensureTrustedMetadataFile(path: string): Promise<void> {
    const stats = await lstatBigIntIfPresent(path);
    if (
      stats &&
      (!isSafeProfileFile(stats) || !sameResolvedPath(await nativeRealpath(path), path))
    ) {
      throw profilePersistenceError();
    }
  }

  private async ensureTrustedProfileWriteTarget(path: string): Promise<void> {
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
    await this.ensureTrustedProfileConfig(segments[0], false);
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
  expectedParent: BigIntStats,
  create: boolean,
): Promise<BigIntStats> {
  let stats = await lstatBigIntIfPresent(path);
  if (!stats && create) {
    await nativeMkdir(path);
    stats = await lstatBigIntIfPresent(path);
  }
  if (!stats || !isSafeProfileDirectory(stats)) {
    throw profilePersistenceError();
  }
  const parentPath = dirname(path);
  const parent = await nativeLstat(parentPath, { bigint: true });
  if (
    !isSafeProfileDirectory(parent) ||
    !sameProfileFileIdentity(parent, expectedParent) ||
    !sameResolvedPath(await nativeRealpath(path), path)
  ) {
    throw profilePersistenceError();
  }
  const after = await nativeLstat(path, { bigint: true });
  if (!isSafeProfileDirectory(after) || !sameProfileFileIdentity(stats, after)) {
    throw profilePersistenceError();
  }
  return after;
}

async function inspectTrustedProfileDirectory(path: string): Promise<BigIntStats> {
  const before = await nativeLstat(path, { bigint: true });
  if (!isSafeProfileDirectory(before) || !sameResolvedPath(await nativeRealpath(path), path)) {
    throw profilePersistenceError();
  }
  const after = await nativeLstat(path, { bigint: true });
  if (!isSafeProfileDirectory(after) || !sameProfileFileIdentity(before, after)) {
    throw profilePersistenceError();
  }
  return after;
}

function isSafeProfileDirectory(stats: BigIntStats): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink() && stats.ino !== 0n;
}

function isSafeProfileFile(stats: BigIntStats): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n && stats.ino !== 0n;
}

function sameProfileFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino !== 0n && left.ino === right.ino;
}

function sameStableProfileFileStats(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    isSafeProfileFile(left) &&
    isSafeProfileFile(right) &&
    sameProfileFileIdentity(left, right) &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function profileConfigVersion(
  stats: BigIntStats,
  sha256: string,
): ProfileConfigVersion {
  return {
    sha256,
    mode: stats.mode,
    device: stats.dev,
    inode: stats.ino,
    links: stats.nlink,
    size: stats.size,
    modifiedAtNs: stats.mtimeNs,
    changedAtNs: stats.ctimeNs,
  };
}

function sameProfileConfigVersion(
  left: ProfileConfigVersion,
  right: ProfileConfigVersion,
): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.mode === right.mode &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.links === right.links &&
    left.size === right.size &&
    left.modifiedAtNs === right.modifiedAtNs &&
    left.changedAtNs === right.changedAtNs
  );
}

async function hashOpenedProfileConfig(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(versionHashChunkSize);
  let offset = 0;
  while (true) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
    if (bytesRead === 0) {
      return hash.digest("hex");
    }
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function lstatBigIntIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await nativeLstat(path, { bigint: true });
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
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
