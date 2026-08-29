import {
  chmod,
  lstat as nativeLstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
import type { CodexLayout } from "./types";

const activeProfileFileName = "active-profile.json";
const privateFileMode = 0o600;
const storedProfileIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ActiveProfileRecord {
  version: 1;
  profileId: string;
  updatedAt: string;
}

export type ActiveProfileSnapshot =
  | { state: "missing" }
  | { state: "present"; record: ActiveProfileRecord };

export type ActiveProfileStoreErrorCode =
  | "invalid-layout"
  | "invalid-profile-id"
  | "state-invalid"
  | "unsafe-state"
  | "persistence-failed";

export class ActiveProfileStoreError extends Error {
  constructor(
    readonly code: ActiveProfileStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ActiveProfileStoreError";
  }
}

export interface ActiveProfileStoreOptions {
  now?: () => string;
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions;
}

type FileIdentityStats = BigIntStats & FileIdentity;

interface TrustedDirectory {
  logicalPath: string;
  realPath: string;
  stats: FileIdentityStats;
}

interface TrustedSwitcherDirectory {
  home: TrustedDirectory;
  switcher: TrustedDirectory;
}

interface InspectedActiveProfileSnapshot {
  snapshot: ActiveProfileSnapshot;
  directory?: TrustedSwitcherDirectory;
  fileStats?: FileIdentityStats;
}

export class ActiveProfileStore {
  readonly path: string;
  private readonly codexHome: string;
  private readonly switcherDir: string;
  private readonly now: () => string;
  private readonly fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined;

  constructor(
    layout: CodexLayout,
    options: ActiveProfileStoreOptions = {},
  ) {
    assertActiveProfileLocation(layout);
    this.codexHome = resolve(layout.codexHome);
    this.switcherDir = resolve(layout.switcherDir);
    this.path = join(this.switcherDir, activeProfileFileName);
    this.now = options.now ?? (() => new Date().toISOString());
    this.fileIdentityOptions = options.fileIdentityOptions;
  }

  async get(): Promise<ActiveProfileRecord | undefined> {
    const snapshot = await this.snapshot();
    return snapshot.state === "present" ? snapshot.record : undefined;
  }

  async snapshot(): Promise<ActiveProfileSnapshot> {
    return (await this.readSnapshot()).snapshot;
  }

  async set(profileId: string): Promise<ActiveProfileSnapshot> {
    assertStoredProfileId(profileId);
    const previous = await this.readSnapshot();
    await this.writeRecord({
      version: 1,
      profileId,
      updatedAt: this.now(),
    });
    return previous.snapshot;
  }

  async clear(): Promise<ActiveProfileSnapshot> {
    const previous = await this.readSnapshot();
    if (previous.snapshot.state === "missing") {
      return previous.snapshot;
    }
    try {
      await this.verifyTrustedSwitcherDirectory(previous.directory!);
      const current = await this.lstat(this.path);
      if (
        !isSafeActiveProfileFile(current) ||
        !sameFileIdentity(current, previous.fileStats!)
      ) {
        throw unsafeStateError();
      }
      await deleteTrustedActiveProfileFile(
        this.path,
        current,
        this.fileIdentityOptions,
        () => unlink(this.path),
      );
      await this.verifyTrustedSwitcherDirectory(previous.directory!);
      await syncTrustedParentDirectory(previous.directory!, this.fileIdentityOptions);
      await this.verifyTrustedSwitcherDirectory(previous.directory!);
    } catch (error: unknown) {
      if (error instanceof ActiveProfileStoreError) {
        throw error;
      }
      throw new ActiveProfileStoreError(
        "persistence-failed",
        "Could not clear active Profile state.",
        { cause: error },
      );
    }
    return previous.snapshot;
  }

  async restore(snapshot: ActiveProfileSnapshot): Promise<void> {
    assertSnapshot(snapshot);
    if (snapshot.state === "missing") {
      await this.clear();
      return;
    }
    await this.writeRecord(snapshot.record);
  }

  private async writeRecord(record: ActiveProfileRecord): Promise<void> {
    assertActiveProfileRecord(record);
    let directory: TrustedSwitcherDirectory | undefined;
    let temporaryPath: string | undefined;
    let temporaryStats: FileIdentityStats | undefined;
    let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;
    let primaryError: unknown;
    try {
      directory = await this.getTrustedSwitcherDirectory(true);
      await this.assertSafeExistingStateFile();
      temporaryPath = join(
        dirname(this.path),
        `.${basename(this.path)}.tmp-${randomUUID()}`,
      );
      temporaryHandle = await open(temporaryPath, "wx", privateFileMode);
      temporaryStats = await this.stat(temporaryHandle, temporaryPath);
      if (!isSafeActiveProfileFile(temporaryStats)) {
        throw unsafeStateError();
      }
      await temporaryHandle.writeFile(`${JSON.stringify(record, undefined, 2)}\n`, "utf8");
      if (process.platform === "linux") {
        await chmod(temporaryPath, privateFileMode);
      }
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;
      temporaryStats = await this.lstat(temporaryPath);
      if (!isSafeActiveProfileFile(temporaryStats)) {
        throw unsafeStateError();
      }
      await this.verifyTrustedSwitcherDirectory(directory);
      await this.assertSafeExistingStateFile();
      await rename(temporaryPath, this.path);
      renamed = true;
      await this.verifyTrustedSwitcherDirectory(directory);
      const written = await this.lstat(this.path);
      if (!isSafeActiveProfileFile(written) || !sameFileIdentity(written, temporaryStats)) {
        throw unsafeStateError();
      }
      await syncTrustedParentDirectory(directory, this.fileIdentityOptions);
      await this.verifyTrustedSwitcherDirectory(directory);
    } catch (error: unknown) {
      primaryError = error;
    }

    if (temporaryHandle) {
      try {
        await temporaryHandle.close();
      } catch (error: unknown) {
        primaryError = primaryError === undefined
          ? error
          : new AggregateError([primaryError, error], "Active Profile temporary close failed.");
      }
    }

    if (primaryError !== undefined && !renamed && temporaryPath && temporaryStats && directory) {
      try {
        await this.removeTemporaryFile(temporaryPath, temporaryStats, directory);
      } catch (error: unknown) {
        primaryError = error instanceof ActiveProfileStoreError
          ? error
          : new AggregateError([primaryError, error], "Active Profile temporary cleanup failed.");
      }
    }

    if (primaryError !== undefined) {
      if (primaryError instanceof ActiveProfileStoreError) {
        throw primaryError;
      }
      throw new ActiveProfileStoreError(
        "persistence-failed",
        "Could not persist active Profile state.",
        { cause: primaryError },
      );
    }
  }

  private async readSnapshot(): Promise<InspectedActiveProfileSnapshot> {
    const directory = await this.getTrustedSwitcherDirectory(false);
    if (!directory) {
      return { snapshot: { state: "missing" } };
    }
    let pathStats: FileIdentityStats;
    try {
      pathStats = await this.lstat(this.path);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return { snapshot: { state: "missing" } };
      }
      throw new ActiveProfileStoreError(
        "persistence-failed",
        "Could not read active Profile state.",
        { cause: error },
      );
    }
    if (!isSafeActiveProfileFile(pathStats)) {
      throw unsafeStateError();
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let contents: string | undefined;
    let primaryError: unknown;
    try {
      handle = await open(this.path, "r");
      const opened = await this.stat(handle, this.path);
      if (!isSafeActiveProfileFile(opened) || !sameFileIdentity(pathStats, opened)) {
        throw unsafeStateError();
      }
      contents = await handle.readFile({ encoding: "utf8" });
      const afterRead = await this.stat(handle, this.path);
      const pathAfterRead = await this.lstat(this.path);
      if (
        !isSafeActiveProfileFile(afterRead) ||
        !isSafeActiveProfileFile(pathAfterRead) ||
        !sameFileIdentity(opened, afterRead) ||
        !sameFileIdentity(opened, pathAfterRead)
      ) {
        throw unsafeStateError();
      }
      await this.verifyTrustedSwitcherDirectory(directory);
    } catch (error: unknown) {
      primaryError = error;
    }
    if (handle) {
      try {
        await handle.close();
      } catch (error: unknown) {
        primaryError = primaryError === undefined
          ? error
          : new AggregateError([primaryError, error], "Active Profile read close failed.");
      }
    }
    if (primaryError !== undefined) {
      if (primaryError instanceof ActiveProfileStoreError) {
        throw primaryError;
      }
      throw unsafeStateError(primaryError);
    }
    return {
      snapshot: { state: "present", record: parseActiveProfileRecord(contents!) },
      directory,
      fileStats: pathStats,
    };
  }

  private async getTrustedSwitcherDirectory(createIfMissing: true): Promise<TrustedSwitcherDirectory>;
  private async getTrustedSwitcherDirectory(
    createIfMissing: false,
  ): Promise<TrustedSwitcherDirectory | undefined>;
  private async getTrustedSwitcherDirectory(
    createIfMissing: boolean,
  ): Promise<TrustedSwitcherDirectory | undefined> {
    try {
      const home = await inspectTrustedDirectory(this.codexHome, this.fileIdentityOptions);
      let switcherExists = true;
      try {
        await this.lstat(this.switcherDir);
      } catch (error: unknown) {
        if (!isMissingFileError(error)) {
          throw error;
        }
        switcherExists = false;
      }
      if (!switcherExists) {
        if (!createIfMissing) {
          return undefined;
        }
        await mkdir(this.switcherDir);
      }
      const switcher = await inspectTrustedDirectory(this.switcherDir, this.fileIdentityOptions);
      if (!isDirectChild(home.realPath, switcher.realPath)) {
        throw unsafeStateError();
      }
      const directory = { home, switcher };
      await this.verifyTrustedSwitcherDirectory(directory);
      return directory;
    } catch (error: unknown) {
      if (error instanceof ActiveProfileStoreError) {
        throw error;
      }
      throw new ActiveProfileStoreError(
        "persistence-failed",
        "Could not access active Profile state.",
        { cause: error },
      );
    }
  }

  private async verifyTrustedSwitcherDirectory(expected: TrustedSwitcherDirectory): Promise<void> {
    const home = await inspectTrustedDirectory(this.codexHome, this.fileIdentityOptions);
    const switcher = await inspectTrustedDirectory(this.switcherDir, this.fileIdentityOptions);
    if (
      !sameFileIdentity(home.stats, expected.home.stats) ||
      !sameFileIdentity(switcher.stats, expected.switcher.stats) ||
      !sameResolvedPath(home.realPath, expected.home.realPath) ||
      !sameResolvedPath(switcher.realPath, expected.switcher.realPath) ||
      !isDirectChild(home.realPath, switcher.realPath)
    ) {
      throw unsafeStateError();
    }
  }

  private async assertSafeExistingStateFile(): Promise<FileIdentityStats | undefined> {
    try {
      const stats = await this.lstat(this.path);
      if (!isSafeActiveProfileFile(stats)) {
        throw unsafeStateError();
      }
      return stats;
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      if (error instanceof ActiveProfileStoreError) {
        throw error;
      }
      throw new ActiveProfileStoreError(
        "persistence-failed",
        "Could not access active Profile state.",
        { cause: error },
      );
    }
  }

  private async removeTemporaryFile(
    path: string,
    expectedStats: FileIdentityStats,
    directory: TrustedSwitcherDirectory,
  ): Promise<void> {
    await this.verifyTrustedSwitcherDirectory(directory);
    const stats = await this.lstat(path);
    if (!isSafeActiveProfileFile(stats) || !sameFileIdentity(stats, expectedStats)) {
      throw unsafeStateError();
    }
    await deleteTrustedActiveProfileFile(
      path,
      stats,
      this.fileIdentityOptions,
      () => unlink(path),
    );
  }

  private async lstat(path: string): Promise<FileIdentityStats> {
    return lstatWithFileIdentity(path, this.fileIdentityOptions);
  }

  private async stat(
    handle: Awaited<ReturnType<typeof open>>,
    logicalPath: string,
  ): Promise<FileIdentityStats> {
    return statWithFileIdentity(handle, logicalPath, this.fileIdentityOptions);
  }
}

function assertActiveProfileLocation(layout: CodexLayout): void {
  const home = resolve(layout.codexHome);
  const switcher = resolve(layout.switcherDir);
  if (
    !isAbsolute(home) ||
    !isAbsolute(switcher) ||
    switcher !== join(home, "provider-switcher")
  ) {
    throw new ActiveProfileStoreError(
      "invalid-layout",
      "Active Profile state must be stored inside Codex Home.",
    );
  }
}

async function lstatWithFileIdentity(
  path: string,
  options: HydrateWindowsFileIdentityOptions | undefined,
): Promise<FileIdentityStats> {
  const stats = await nativeLstat(path, { bigint: true });
  return hydrateFileIdentity(path, stats, options);
}

async function statWithFileIdentity(
  handle: Awaited<ReturnType<typeof open>>,
  logicalPath: string,
  options: HydrateWindowsFileIdentityOptions | undefined,
): Promise<FileIdentityStats> {
  const stats = await handle.stat({ bigint: true });
  return hydrateFileIdentity(logicalPath, stats, options);
}

async function hydrateFileIdentity(
  logicalPath: string,
  stats: BigIntStats,
  options: HydrateWindowsFileIdentityOptions | undefined,
): Promise<FileIdentityStats> {
  const identity = await hydrateWindowsFileIdentity(logicalPath, stats, options);
  if (identity.windowsFileIdentity === undefined) {
    return stats as FileIdentityStats;
  }

  Object.defineProperty(stats, "windowsFileIdentity", {
    configurable: false,
    enumerable: true,
    value: identity.windowsFileIdentity,
    writable: false,
  });
  return stats as FileIdentityStats;
}

async function inspectTrustedDirectory(
  path: string,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<TrustedDirectory> {
  try {
    const before = await lstatWithFileIdentity(path, fileIdentityOptions);
    if (!isSafeDirectory(before)) {
      throw unsafeStateError();
    }
    const realPath = await realpath(path);
    const after = await lstatWithFileIdentity(path, fileIdentityOptions);
    const realPathStats = await lstatWithFileIdentity(realPath, fileIdentityOptions);
    if (
      !isSafeDirectory(after) ||
      !sameFileIdentity(after, realPathStats) ||
      !sameFileIdentity(before, after) ||
      !isSafeDirectory(realPathStats)
    ) {
      throw unsafeStateError();
    }
    return { logicalPath: path, realPath, stats: after };
  } catch (error: unknown) {
    if (error instanceof ActiveProfileStoreError) {
      throw error;
    }
    throw unsafeStateError(error);
  }
}

function isSafeDirectory(stats: FileIdentityStats): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink() && hasComparableFileIdentity(stats);
}

function isSafeActiveProfileFile(stats: FileIdentityStats): boolean {
  return stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.nlink === 1n &&
    hasComparableFileIdentity(stats);
}

function sameFileIdentity(left: FileIdentityStats, right: FileIdentityStats): boolean {
  return sameStableFileIdentity(left, right);
}

async function deleteTrustedActiveProfileFile(
  path: string,
  expected: FileIdentityStats,
  options: HydrateWindowsFileIdentityOptions | undefined,
  unlinkForCaller: () => Promise<void>,
): Promise<void> {
  if (
    (options?.platform ?? process.platform) === "win32" &&
    expected.ino === 0n
  ) {
    const identity = requireActiveWindowsFileIdentity(expected);
    const operations = options?.windowsFileOperations ?? createWindowsFileOperations();
    let result: "deleted" | "identity-mismatch";
    try {
      result = operations.deleteFileIfMatches(path, identity);
    } catch (error: unknown) {
      throw new ActiveProfileStoreError(
        "persistence-failed",
        "Could not clear active Profile state.",
        { cause: error },
      );
    }
    if (result !== "deleted") {
      throw unsafeStateError();
    }
    return;
  }
  await unlinkForCaller();
}

function requireActiveWindowsFileIdentity(
  stats: FileIdentityStats,
): WindowsFileIdentity {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(stats, "windowsFileIdentity");
    const identity = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (
      !identity ||
      typeof identity !== "object" ||
      typeof (identity as WindowsFileIdentity).volumeSerial !== "string" ||
      typeof (identity as WindowsFileIdentity).fileId !== "string" ||
      (identity as WindowsFileIdentity).linkCount !== 1n ||
      stats.nlink !== 1n ||
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
    throw unsafeStateError();
  }
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isDirectChild(parent: string, child: string): boolean {
  return sameResolvedPath(dirname(child), parent);
}

function unsafeStateError(cause?: unknown): ActiveProfileStoreError {
  return new ActiveProfileStoreError(
    "unsafe-state",
    "Active Profile state is unavailable.",
    cause === undefined ? undefined : { cause },
  );
}

function parseActiveProfileRecord(contents: string): ActiveProfileRecord {
  try {
    const value = JSON.parse(contents) as unknown;
    assertActiveProfileRecord(value);
    return value;
  } catch (error: unknown) {
    if (error instanceof ActiveProfileStoreError) {
      throw error;
    }
    throw new ActiveProfileStoreError(
      "state-invalid",
      "Active Profile state is invalid.",
      { cause: error },
    );
  }
}

function assertSnapshot(value: unknown): asserts value is ActiveProfileSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ActiveProfileStoreError("state-invalid", "Active Profile state is invalid.");
  }
  if ((value as { state?: unknown }).state === "missing") {
    if (Reflect.ownKeys(value).length === 1) {
      return;
    }
  } else if ((value as { state?: unknown }).state === "present") {
    const snapshot = value as { state: "present"; record?: unknown };
    if (Reflect.ownKeys(value).length === 2 && snapshot.record !== undefined) {
      assertActiveProfileRecord(snapshot.record);
      return;
    }
  }
  throw new ActiveProfileStoreError("state-invalid", "Active Profile state is invalid.");
}

function assertActiveProfileRecord(value: unknown): asserts value is ActiveProfileRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ActiveProfileStoreError("state-invalid", "Active Profile state is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).length !== 3 ||
    record.version !== 1 ||
    typeof record.profileId !== "string" ||
    typeof record.updatedAt !== "string" ||
    !isCanonicalIsoTimestamp(record.updatedAt)
  ) {
    throw new ActiveProfileStoreError("state-invalid", "Active Profile state is invalid.");
  }
  assertStoredProfileId(record.profileId, "state-invalid");
}

function assertStoredProfileId(
  profileId: string,
  code: "invalid-profile-id" | "state-invalid" = "invalid-profile-id",
): void {
  if (!storedProfileIdPattern.test(profileId)) {
    throw new ActiveProfileStoreError(
      code,
      code === "invalid-profile-id"
        ? "The active Profile identifier is invalid."
        : "Active Profile state is invalid.",
    );
  }
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

async function syncTrustedParentDirectory(
  directory: TrustedSwitcherDirectory,
  fileIdentityOptions: HydrateWindowsFileIdentityOptions | undefined,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let primaryError: unknown;
  try {
    handle = await open(directory.switcher.logicalPath, "r");
    const before = await statWithFileIdentity(
      handle,
      directory.switcher.logicalPath,
      fileIdentityOptions,
    );
    if (!isSafeDirectory(before) || !sameFileIdentity(before, directory.switcher.stats)) {
      throw unsafeStateError();
    }
    await handle.sync();
    const after = await statWithFileIdentity(
      handle,
      directory.switcher.logicalPath,
      fileIdentityOptions,
    );
    if (!isSafeDirectory(after) || !sameFileIdentity(after, directory.switcher.stats)) {
      throw unsafeStateError();
    }
  } catch (error: unknown) {
    primaryError = error;
  }
  if (handle) {
    try {
      await handle.close();
    } catch (error: unknown) {
      primaryError = primaryError === undefined
        ? error
        : new AggregateError([primaryError, error], "Active Profile directory sync close failed.");
    }
  }
  if (primaryError !== undefined) {
    if (primaryError instanceof ActiveProfileStoreError) {
      throw primaryError;
    }
    throw unsafeStateError(primaryError);
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
