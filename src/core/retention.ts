import { lstat, readdir, readFile, realpath, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  readonly device: bigint;
  readonly inode: bigint;
}

interface ManagedRetentionEntry {
  readonly name: string;
  readonly device: bigint;
  readonly inode: bigint;
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
  const root = await resolveTrustedRetentionDirectory(layout, "transactions");
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
    const candidate = await inspectManagedEntry(root, entry.name, "directory");
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
    const path = await revalidateManagedEntry(layout, root, entry.entry, "directory");
    if (!path) {
      continue;
    }
    await rm(path, { recursive: true, force: false });
    removedOperationIds.push(entry.operationId);
  }
  return { removedOperationIds };
}

export async function cleanupTemporaryContexts(
  layout: CodexLayout,
): Promise<{ removedCount: number }> {
  const directory = await resolveTrustedRetentionDirectory(layout, "continuation-temp");
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
    const candidate = await inspectManagedEntry(directory, entry.name, "file");
    if (!candidate) {
      continue;
    }
    const path = await revalidateManagedEntry(layout, directory, candidate.entry, "file");
    if (!path) {
      continue;
    }
    await unlink(path);
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
): Promise<TrustedRetentionDirectory | undefined> {
  const codexHome = resolve(layout.codexHome);
  const switcher = resolve(layout.switcherDir);
  if (switcher !== join(codexHome, "provider-switcher")) {
    throw new RetentionError("The retention directory is not located under Codex Home.");
  }
  let switcherStats;
  try {
    switcherStats = await lstat(switcher, { bigint: true });
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
  if (!isPathInsideOrEqual(codexHomeRealPath, switcherRealPath)) {
    throw new RetentionError("The retention directory escapes Codex Home.");
  }

  const childPath = join(switcher, childName);
  let childStats;
  try {
    childStats = await lstat(childPath, { bigint: true });
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
  if (relative(switcherRealPath, dirname(childRealPath)) !== "") {
    throw new RetentionError("The retention child directory is not directly under its trusted root.");
  }
  const switcherAfter = await lstat(switcher, { bigint: true });
  const after = await lstat(childPath, { bigint: true });
  if (
    switcherAfter.isSymbolicLink() ||
    !switcherAfter.isDirectory() ||
    switcherAfter.dev !== switcherStats.dev ||
    switcherAfter.ino !== switcherStats.ino ||
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    after.dev !== childStats.dev ||
    after.ino !== childStats.ino ||
    (await realpath(switcher)) !== switcherRealPath ||
    (await realpath(codexHome)) !== codexHomeRealPath
  ) {
    throw new RetentionError("The retention child directory changed while it was being validated.");
  }
  return {
    childName,
    path: childPath,
    realPath: childRealPath,
    device: after.dev,
    inode: after.ino,
  };
}

async function inspectManagedEntry(
  directory: TrustedRetentionDirectory,
  name: string,
  expectedKind: "directory" | "file",
): Promise<{ path: string; entry: ManagedRetentionEntry } | undefined> {
  const path = join(directory.path, name);
  let stats;
  try {
    stats = await lstat(path, { bigint: true });
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
  if (
    stats.isSymbolicLink() ||
    (expectedKind === "directory" ? !stats.isDirectory() : !stats.isFile()) ||
    (expectedKind === "file" && stats.nlink !== 1n)
  ) {
    return undefined;
  }
  const realPath = await realpath(path);
  if (relative(directory.realPath, dirname(realPath)) !== "") {
    return undefined;
  }
  return { path, entry: { name, device: stats.dev, inode: stats.ino } };
}

async function revalidateManagedEntry(
  layout: CodexLayout,
  expectedDirectory: TrustedRetentionDirectory,
  entry: ManagedRetentionEntry,
  expectedKind: "directory" | "file",
): Promise<string | undefined> {
  const directory = await resolveTrustedRetentionDirectory(layout, expectedDirectory.childName);
  if (!directory) {
    return undefined;
  }
  if (
    directory.realPath !== expectedDirectory.realPath ||
    directory.device !== expectedDirectory.device ||
    directory.inode !== expectedDirectory.inode
  ) {
    throw new RetentionError("The retention directory changed after it was scanned.");
  }
  const candidate = await inspectManagedEntry(directory, entry.name, expectedKind);
  if (!candidate) {
    return undefined;
  }
  if (
    candidate.entry.device !== entry.device ||
    candidate.entry.inode !== entry.inode
  ) {
    throw new RetentionError("The retention entry changed after it was scanned.");
  }
  return candidate.path;
}

function isPathInsideOrEqual(directory: string, candidate: string): boolean {
  const path = relative(resolve(directory), resolve(candidate));
  return !path.startsWith("..") && !isAbsolute(path);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
