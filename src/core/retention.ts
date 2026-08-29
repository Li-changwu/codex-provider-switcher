import type { BigIntStats } from "node:fs";
import { lstat, readdir, readFile, realpath, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  hasComparableFileIdentity,
  hydrateWindowsFileIdentity,
  sameStableFileIdentity,
  type FileIdentity,
  type HydrateWindowsFileIdentityOptions,
} from "./file-identity";
import {
  createWindowsFileOperations,
} from "./windows-file-operations";
import type { BranchMapping } from "./continuation";
import type { CodexLayout } from "./types";

const defaultMaximumActiveBranches = 3;
const defaultMaximumCompletedBackups = 10;
const transactionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const continuationTemporaryPattern = /^context-[A-Za-z0-9_-]+\.txt$/;

interface TrustedRetentionDirectory {
  readonly childName: "transactions" | "continuation-temp";
  readonly path: string;
  readonly realPath: string;
  readonly identity: FileIdentity;
}

interface ManagedRetentionEntry {
  readonly name: string;
  readonly identity: FileIdentity;
}

export interface BranchRetentionStore {
  listActive(sourceSessionId: string, targetProfileId: string): Promise<BranchMapping[]>;
  markArchived(branchSessionId: string): Promise<void>;
}

export interface BranchRetentionOptions {
  readonly sourceSessionId: string;
  readonly targetProfileId: string;
  readonly maximumActiveBranches?: number;
  readonly archive: (branchSessionId: string) => Promise<void>;
  readonly unarchive: (branchSessionId: string) => Promise<void>;
}

export interface BackupRetentionOptions {
  readonly maximumCompletedBackups?: number;
  readonly fileIdentityOptions?: HydrateWindowsFileIdentityOptions;
}

export interface CleanupTemporaryContextsOptions {
  readonly fileIdentityOptions?: HydrateWindowsFileIdentityOptions;
}

export class RetentionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetentionError";
  }
}

export async function retainMappedBranches(
  store: BranchRetentionStore,
  options: BranchRetentionOptions,
): Promise<{ archivedBranchSessionIds: string[] }> {
  const maximum = positiveInteger(options.maximumActiveBranches, defaultMaximumActiveBranches);
  const active = await store.listActive(options.sourceSessionId, options.targetProfileId);
  const overflow = selectMappedBranchesForArchival(active, maximum);
  const archivedBranchSessionIds: string[] = [];
  for (const mapping of overflow) {
    await options.archive(mapping.branchSessionId);
    try {
      await store.markArchived(mapping.branchSessionId);
    } catch (error: unknown) {
      try {
        await options.unarchive(mapping.branchSessionId);
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          "Native branch archival and mapping rollback both failed.",
        );
      }
      throw error;
    }
    archivedBranchSessionIds.push(mapping.branchSessionId);
  }
  return { archivedBranchSessionIds };
}

export function selectMappedBranchesForArchival(
  active: readonly BranchMapping[],
  maximumActiveBranches: number = defaultMaximumActiveBranches,
): BranchMapping[] {
  const maximum = positiveInteger(maximumActiveBranches, defaultMaximumActiveBranches);
  return [...active]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(maximum);
}

export async function retainCompletedTransactionBackups(
  layout: CodexLayout,
  options: BackupRetentionOptions = {},
): Promise<{ removedOperationIds: string[] }> {
  const maximum = positiveInteger(options.maximumCompletedBackups, defaultMaximumCompletedBackups);
  const root = await resolveTrustedRetentionDirectory(
    layout,
    "transactions",
    options.fileIdentityOptions,
  );
  if (!root) {
    return { removedOperationIds: [] };
  }
  let entries;
  try {
    entries = await readdir(root.path, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return { removedOperationIds: [] };
    }
    throw error;
  }
  const completed: Array<{ operationId: string; timestamp: string; entry: ManagedRetentionEntry }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !transactionIdPattern.test(entry.name)) {
      continue;
    }
    const candidate = await inspectManagedEntry(root, entry.name, "directory", options.fileIdentityOptions);
    if (!candidate) {
      continue;
    }
    const state = await readTerminalJournalState(candidate.path, entry.name);
    if (state) {
      completed.push({ operationId: entry.name, timestamp: state.timestamp, entry: candidate.entry });
    }
  }
  const overflow = completed
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(maximum);
  const removedOperationIds: string[] = [];
  for (const entry of overflow) {
    const candidate = await revalidateManagedEntry(
      layout,
      root,
      entry.entry,
      "directory",
      options.fileIdentityOptions,
    );
    if (!candidate) {
      continue;
    }
    if (isWindowsZeroInode(candidate.entry.identity, options.fileIdentityOptions)) {
      await removeZeroInodeDirectory(candidate, options.fileIdentityOptions);
    } else {
      await rm(candidate.path, { recursive: true, force: false });
    }
    removedOperationIds.push(entry.operationId);
  }
  return { removedOperationIds };
}

export async function cleanupTemporaryContexts(
  layout: CodexLayout,
  options: CleanupTemporaryContextsOptions = {},
): Promise<{ removedCount: number }> {
  const directory = await resolveTrustedRetentionDirectory(
    layout,
    "continuation-temp",
    options.fileIdentityOptions,
  );
  if (!directory) {
    return { removedCount: 0 };
  }
  let entries;
  try {
    entries = await readdir(directory.path, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return { removedCount: 0 };
    }
    throw error;
  }
  let removedCount = 0;
  for (const entry of entries) {
    if (!continuationTemporaryPattern.test(entry.name)) {
      continue;
    }
    const candidate = await inspectManagedEntry(directory, entry.name, "file", options.fileIdentityOptions);
    if (!candidate) {
      continue;
    }
    const checked = await revalidateManagedEntry(
      layout,
      directory,
      candidate.entry,
      "file",
      options.fileIdentityOptions,
    );
    if (!checked) {
      continue;
    }
    await deleteManagedFile(checked.path, checked.entry.identity, options.fileIdentityOptions);
    removedCount += 1;
  }
  return { removedCount };
}

async function readTerminalJournalState(
  operationDirectory: string,
  operationId: string,
): Promise<{ timestamp: string } | undefined> {
  const journalPath = join(operationDirectory, "journal.jsonl");
  try {
    const stats = await lstat(journalPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink > 1) {
      return undefined;
    }
    const records = (await readFile(journalPath, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { operationId?: unknown; state?: unknown; timestamp?: unknown });
    const terminal = records.at(-1);
    if (
      !terminal ||
      terminal.operationId !== operationId ||
      (terminal.state !== "committed" && terminal.state !== "rolledBack") ||
      typeof terminal.timestamp !== "string"
    ) {
      return undefined;
    }
    return { timestamp: terminal.timestamp };
  } catch {
    return undefined;
  }
}

async function resolveTrustedRetentionDirectory(
  layout: CodexLayout,
  childName: "transactions" | "continuation-temp",
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<TrustedRetentionDirectory | undefined> {
  const codexHome = resolve(layout.codexHome);
  const switcher = resolve(layout.switcherDir);
  const platform = fileIdentityOptions?.platform ?? process.platform;
  if (!pathsEqual(switcher, join(codexHome, "provider-switcher"), platform)) {
    throw new RetentionError("The retention directory is not located under Codex Home.");
  }
  let switcherStats;
  try {
    switcherStats = await lstatWithFileIdentity(switcher, fileIdentityOptions);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw new RetentionError("The retention directory could not be inspected.", { cause: error });
  }
  if (!switcherStats.isDirectory() || switcherStats.isSymbolicLink()) {
    throw new RetentionError("The retention directory must be a real directory.");
  }
  const codexHomeRealPath = await realpath(codexHome);
  const switcherRealPath = await realpath(switcher);
  const switcherRealStats = await lstatWithFileIdentity(switcherRealPath, fileIdentityOptions);
  if (
    !isSafeDirectory(switcherStats, platform) ||
    !isSafeDirectory(switcherRealStats, platform) ||
    !sameStableFileIdentity(switcherStats, switcherRealStats, platform) ||
    !isPathInsideOrEqual(codexHomeRealPath, switcherRealPath)
  ) {
    throw new RetentionError("The retention directory escapes Codex Home.");
  }

  const childPath = join(switcher, childName);
  let childStats;
  try {
    childStats = await lstatWithFileIdentity(childPath, fileIdentityOptions);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw new RetentionError("The retention child directory could not be inspected.", { cause: error });
  }
  if (!childStats.isDirectory() || childStats.isSymbolicLink()) {
    throw new RetentionError("The retention child directory must be a real directory.");
  }
  const childRealPath = await realpath(childPath);
  if (!pathsEqual(relative(switcherRealPath, dirname(childRealPath)), "", platform)) {
    throw new RetentionError("The retention child directory is not directly under its trusted root.");
  }
  const childRealStats = await lstatWithFileIdentity(childRealPath, fileIdentityOptions);
  const switcherAfter = await lstatWithFileIdentity(switcher, fileIdentityOptions);
  const after = await lstatWithFileIdentity(childPath, fileIdentityOptions);
  if (
    !isSafeDirectory(switcherAfter, platform) ||
    !sameStableFileIdentity(switcherStats, switcherAfter, platform) ||
    !isSafeDirectory(after, platform) ||
    !isSafeDirectory(childRealStats, platform) ||
    !sameStableFileIdentity(childStats, after, platform) ||
    !sameStableFileIdentity(after, childRealStats, platform) ||
    !pathsEqual(await realpath(switcher), switcherRealPath, platform) ||
    !pathsEqual(await realpath(codexHome), codexHomeRealPath, platform)
  ) {
    throw new RetentionError("The retention child directory changed while it was being validated.");
  }
  return {
    childName,
    path: childPath,
    realPath: childRealPath,
    identity: snapshotFileIdentity(after),
  };
}

async function inspectManagedEntry(
  directory: Pick<TrustedRetentionDirectory, "path" | "realPath">,
  name: string,
  expectedKind: "directory" | "file",
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<{ path: string; realPath: string; entry: ManagedRetentionEntry } | undefined> {
  const path = join(directory.path, name);
  let stats;
  try {
    stats = await lstatWithFileIdentity(path, fileIdentityOptions);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
  const platform = fileIdentityOptions?.platform ?? process.platform;
  if (
    stats.isSymbolicLink() ||
    (expectedKind === "directory" ? !stats.isDirectory() : !stats.isFile()) ||
    (expectedKind === "file" && stats.nlink !== 1n) ||
    !isSafeManagedEntry(stats, expectedKind, platform)
  ) {
    return undefined;
  }
  const realPath = await realpath(path);
  const realStats = await lstatWithFileIdentity(realPath, fileIdentityOptions);
  if (!pathsEqual(relative(directory.realPath, dirname(realPath)), "", platform)) {
    return undefined;
  }
  if (
    !isSafeManagedEntry(realStats, expectedKind, platform) ||
    !sameStableFileIdentity(stats, realStats, platform)
  ) {
    return undefined;
  }
  return { path, realPath, entry: { name, identity: snapshotFileIdentity(stats) } };
}

async function revalidateManagedEntry(
  layout: CodexLayout,
  expectedDirectory: TrustedRetentionDirectory,
  entry: ManagedRetentionEntry,
  expectedKind: "directory" | "file",
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<{ path: string; realPath: string; entry: ManagedRetentionEntry } | undefined> {
  const directory = await resolveTrustedRetentionDirectory(
    layout,
    expectedDirectory.childName,
    fileIdentityOptions,
  );
  if (!directory) {
    return undefined;
  }
  if (
    !pathsEqual(
      directory.realPath,
      expectedDirectory.realPath,
      fileIdentityOptions?.platform ?? process.platform,
    ) ||
    !sameStableFileIdentity(directory.identity, expectedDirectory.identity, fileIdentityOptions?.platform ?? process.platform)
  ) {
    throw new RetentionError("The retention directory changed after it was scanned.");
  }
  const candidate = await inspectManagedEntry(directory, entry.name, expectedKind, fileIdentityOptions);
  if (!candidate) {
    return undefined;
  }
  if (
    !sameStableFileIdentity(
      candidate.entry.identity,
      entry.identity,
      fileIdentityOptions?.platform ?? process.platform,
    )
  ) {
    throw new RetentionError("The retention entry changed after it was scanned.");
  }
  return candidate;
}

type RetentionFileIdentityStats = BigIntStats & FileIdentity;

async function lstatWithFileIdentity(
  path: string,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<RetentionFileIdentityStats> {
  const stats = await lstat(path, { bigint: true });
  const identity = await hydrateWindowsFileIdentity(path, stats, fileIdentityOptions);
  if (identity.windowsFileIdentity !== undefined) {
    Object.defineProperty(stats, "windowsFileIdentity", {
      configurable: false,
      enumerable: true,
      value: identity.windowsFileIdentity,
      writable: false,
    });
  }
  return stats as RetentionFileIdentityStats;
}

function isSafeDirectory(
  stats: RetentionFileIdentityStats,
  platform: NodeJS.Platform,
): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink() && hasComparableFileIdentity(stats, platform);
}

function isSafeManagedEntry(
  stats: RetentionFileIdentityStats,
  expectedKind: "directory" | "file",
  platform: NodeJS.Platform,
): boolean {
  return (
    expectedKind === "directory"
      ? isSafeDirectory(stats, platform)
      : stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n && hasComparableFileIdentity(stats, platform)
  );
}

function snapshotFileIdentity(stats: RetentionFileIdentityStats): FileIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink,
    ...(stats.windowsFileIdentity === undefined
      ? {}
      : { windowsFileIdentity: stats.windowsFileIdentity }),
  });
}

function isWindowsZeroInode(
  identity: FileIdentity,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): boolean {
  const platform = fileIdentityOptions?.platform ?? process.platform;
  return platform === "win32" && (identity.ino === 0 || identity.ino === 0n);
}

async function deleteManagedFile(
  path: string,
  expected: FileIdentity,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  if (!isWindowsZeroInode(expected, fileIdentityOptions)) {
    await unlink(path);
    return;
  }
  const windowsIdentity = expected.windowsFileIdentity;
  if (!windowsIdentity) {
    throw new RetentionError("The Windows retention file has no comparable native identity.");
  }
  let result: "deleted" | "identity-mismatch";
  try {
    result = (fileIdentityOptions?.windowsFileOperations ?? createWindowsFileOperations())
      .deleteFileIfMatches(path, windowsIdentity);
  } catch (error: unknown) {
    throw new RetentionError("The Windows retention file could not be deleted safely.", { cause: error });
  }
  if (result !== "deleted") {
    throw new RetentionError("The Windows retention file changed before deletion.");
  }
}

async function removeZeroInodeDirectory(
  candidate: { path: string; realPath: string; entry: ManagedRetentionEntry },
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  const platform = fileIdentityOptions?.platform ?? process.platform;
  const directory = { path: candidate.path, realPath: candidate.realPath };
  const entries = await readdir(candidate.path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new RetentionError("The Windows retention directory contains an unsafe entry.");
    }
    const child = await inspectManagedEntry(
      directory,
      entry.name,
      entry.isDirectory() ? "directory" : "file",
      fileIdentityOptions,
    );
    if (!child) {
      throw new RetentionError("The Windows retention entry changed while it was being removed.");
    }
    if (entry.isDirectory()) {
      if (!isWindowsZeroInode(child.entry.identity, fileIdentityOptions)) {
        throw new RetentionError("The Windows retention directory identity is not safely comparable.");
      }
      await removeZeroInodeDirectory(child, fileIdentityOptions);
    } else {
      await deleteManagedFile(child.path, child.entry.identity, fileIdentityOptions);
    }
  }

  const finalStats = await lstatWithFileIdentity(candidate.path, fileIdentityOptions);
  const finalRealPath = await realpath(candidate.path);
  if (
    !isSafeDirectory(finalStats, platform) ||
    !sameStableFileIdentity(finalStats, candidate.entry.identity, platform) ||
    !pathsEqual(finalRealPath, candidate.realPath, platform) ||
    (await readdir(candidate.path)).length !== 0
  ) {
    throw new RetentionError("The Windows retention directory changed before deletion.");
  }
  const windowsIdentity = candidate.entry.identity.windowsFileIdentity;
  if (!windowsIdentity) {
    throw new RetentionError("The Windows retention directory has no comparable native identity.");
  }
  let result: "deleted" | "identity-mismatch";
  try {
    result = (fileIdentityOptions?.windowsFileOperations ?? createWindowsFileOperations())
      .deleteFileIfMatches(candidate.path, windowsIdentity);
  } catch (error: unknown) {
    throw new RetentionError("The Windows retention directory could not be deleted safely.", { cause: error });
  }
  if (result !== "deleted") {
    throw new RetentionError("The Windows retention directory changed before deletion.");
  }
}

function isPathInsideOrEqual(directory: string, candidate: string): boolean {
  const path = relative(resolve(directory), resolve(candidate));
  return !path.startsWith("..") && !isAbsolute(path);
}

function pathsEqual(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
