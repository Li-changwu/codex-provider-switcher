import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { BigIntStats, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  validateRolloutInversePatch,
  type RolloutInversePatch,
} from "./rollouts";
import type { CodexLayout } from "./types";
import {
  createWindowsFileOperations,
  type WindowsFileIdentity,
} from "./windows-file-operations";
import {
  hydrateWindowsFileIdentity,
  type HydrateWindowsFileIdentityOptions,
} from "./file-identity";

export type TransactionState =
  | "prepared"
  | "applying"
  | "committed"
  | "rolledBack"
  | "recoveryRequired";

export type BackupKind = "config" | "rollout" | "sqlite";

export interface BackupTarget {
  kind: BackupKind;
  path: string;
}

export interface BackupManifestEntry {
  kind: BackupKind;
  path: string;
  backupPath?: string;
  existed: boolean;
  sha256?: string;
  mode?: number;
  sourceVersion: ByteTargetVersion;
}

export interface BackupManifest {
  version: 1;
  operationId: string;
  entries: BackupManifestEntry[];
}

export interface JournalTarget {
  kind: "config" | "sqlite";
  path: string;
}

export interface RolloutJournalTarget {
  kind: "rollout";
  path: string;
  inversePatch: RolloutInversePatch;
}

export type AuthMode = "official" | "custom";

type AuthModeRestorer = (target: AuthJournalTarget) => void | Promise<void>;

export type AuthJournalTarget =
  | {
      kind: "auth";
      path: string;
      previousMode: "official";
      customProfileId?: never;
    }
  | {
      kind: "auth";
      path: string;
      previousMode: "custom";
      customProfileId: string;
    };

export type JournalMutationTarget =
  | JournalTarget
  | RolloutJournalTarget
  | AuthJournalTarget;

export interface JournalEntry {
  version: 1;
  operationId: string;
  state: TransactionState;
  timestamp: string;
  sourceVersionProtocol?: true;
  pendingTargets?: JournalMutationTarget[];
  appliedTargets?: JournalMutationTarget[];
  appliedTargetVersions?: AppliedByteTargetVersion[];
}

interface ByteTargetVersion {
  existed: boolean;
  sha256?: string;
  mode?: number;
  device?: string;
  inode?: string;
  links?: string;
  volumeSerial?: string;
  fileId?: string;
  size?: string;
  modifiedAtNs?: string;
  changedAtNs?: string;
}

interface ByteBackedTarget {
  kind: BackupKind;
  path: string;
}

type ByteBackedJournalTarget = JournalTarget | RolloutJournalTarget;
type VersionedJournalTarget = ByteBackedJournalTarget | AuthJournalTarget;

interface AppliedByteTargetVersion {
  target: VersionedJournalTarget;
  version: ByteTargetVersion;
}

export interface TransactionOptions {
  operationId?: string;
  now?: () => string;
  isProcessAlive?: (pid: number) => boolean | undefined;
  io?: TransactionIo;
  requireSourceVersionProtocol?: boolean;
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions;
}

export interface TransactionIo {
  write?: (
    handle: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
  ) => Promise<number>;
  syncJournal?: (handle: FileHandle) => Promise<void>;
  closeJournal?: (handle: FileHandle) => Promise<void>;
  renameJournal?: (source: string, destination: string) => Promise<void>;
  removeJournalTemporary?: (path: string) => Promise<void>;
  writeLock?: (handle: FileHandle, contents: string) => Promise<void>;
  syncHandle?: (handle: FileHandle) => Promise<void>;
  closeHandle?: (handle: FileHandle) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
  releaseLock?: (path: string) => Promise<void>;
  afterLockOwnershipVerified?: (
    path: string,
    phase: "release" | "stale-reclaim",
  ) => void | Promise<void>;
  afterBackupSourceLstat?: (path: string) => void | Promise<void>;
  afterBackupSourceRead?: (path: string) => void | Promise<void>;
  removeTransactionDirectory?: (path: string) => Promise<void>;
  syncFileHandle?: (handle: FileHandle) => Promise<void>;
  closeFileHandle?: (handle: FileHandle) => Promise<void>;
  hashChunkSize?: number;
  readHashChunk?: (chunk: Buffer) => void | Promise<void>;
  closeHashHandle?: (handle: FileHandle) => Promise<void>;
  writeTemporary?: (path: string, contents: string) => Promise<void>;
  afterBackupValidation?: (path: string) => void | Promise<void>;
  afterManifestPathValidated?: (path: string) => void | Promise<void>;
  afterJournalPathValidated?: (path: string) => void | Promise<void>;
  beforeRestoreTemporaryCreate?: (destination: string) => void | Promise<void>;
  copyTemporary?: (source: FileHandle, destination: FileHandle) => Promise<void>;
  removeTemporary?: (path: string) => Promise<void>;
  syncDirectory?: (path: string) => Promise<void>;
}

export interface RecoveryDependencies extends TransactionOptions {
  restoreAuthMode?: AuthModeRestorer;
}

export interface RecoveryDiagnostic {
  readonly operationId: string;
  readonly recoveryRequiredJournalWritten: boolean;
}

export interface RecoveryResult {
  recoveredOperationIds: string[];
  skippedCommittedOperationIds: string[];
  recoveryRequiredOperationIds: string[];
  recoveryDiagnostics: RecoveryDiagnostic[];
}

export interface RecoverAndBeginTransactionResult {
  readonly recovery: RecoveryResult;
  readonly transaction?: TransactionHandle;
}

export interface TransactionHandle {
  readonly operationId: string;
  readonly directory: string;
  readonly journalPath: string;
  readonly backupDirectory: string;
  backupTargets(targets: readonly BackupTarget[]): Promise<BackupManifest>;
  markApplying(targets?: readonly (JournalMutationTarget | string)[]): Promise<void>;
  prepareTarget(target: JournalMutationTarget): Promise<void>;
  assertTargetUnchanged(target: JournalMutationTarget): Promise<void>;
  markTargetApplied(target: JournalMutationTarget): Promise<void>;
  markCommitted(): Promise<void>;
  markRolledBack(): Promise<void>;
  markRecoveryRequired(): Promise<void>;
  validateRollback(restoreAuthMode?: AuthModeRestorer): Promise<void>;
  rollback(restoreAuthMode?: AuthModeRestorer): Promise<void>;
  release(): Promise<void>;
}

export type TransactionErrorCode =
  | "lock-held"
  | "lock-unverifiable"
  | "invalid-operation-id"
  | "invalid-backup-target"
  | "journal-invalid"
  | "rollback-failed";

export class TransactionError extends Error {
  constructor(
    readonly code: TransactionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TransactionError";
  }
}

export class CommittedJournalDurabilityError extends TransactionError {
  readonly journalState = "committed" as const;

  constructor() {
    super(
      "journal-invalid",
      "The committed transaction journal has a bounded durability warning.",
    );
    this.name = "CommittedJournalDurabilityError";
  }
}

type RuntimeTransactionState = TransactionState | "commitVisibilityUncertain";
type JournalSnapshotClassification = "expected" | "different" | "unverifiable";

class JournalDirectorySyncError extends TransactionError {
  constructor(
    readonly publishedState: TransactionState,
    readonly classification: JournalSnapshotClassification,
    cause: unknown,
  ) {
    super(
      "journal-invalid",
      "The transaction journal parent directory could not be synchronized.",
      { cause },
    );
  }
}

const transactionsDirectoryName = "transactions";
const journalFileName = "journal.jsonl";
const manifestFileName = "manifest.json";
const operationLockFileName = ".lock";
const operationLockHandoffPattern = /^\.lock\.handoff-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumLockBytes = 4 * 1024;
const backupCopyChunkSize = 64 * 1024;
const transactionStates: readonly TransactionState[] = [
  "prepared",
  "applying",
  "committed",
  "rolledBack",
  "recoveryRequired",
];

function compensationIsForbidden(state: RuntimeTransactionState): boolean {
  return (
    state === "committed" ||
    state === "recoveryRequired" ||
    state === "commitVisibilityUncertain"
  );
}

interface TrustedTransactionDirectory {
  readonly path: string;
  readonly realPath: string;
  readonly stats: BigIntStats;
}

export function operationLockPath(layout: CodexLayout): string {
  return join(layout.switcherDir, transactionsDirectoryName, operationLockFileName);
}

async function ensureTrustedTransactionRoot(
  layout: CodexLayout,
  io?: TransactionIo,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<TrustedTransactionDirectory> {
  try {
    const codexHomePath = resolve(layout.codexHome);
    const switcherPath = resolve(layout.switcherDir);
    const expectedSwitcherPath = join(codexHomePath, "provider-switcher");
    if (switcherPath !== expectedSwitcherPath) {
      throw new TransactionError(
        "journal-invalid",
        "The transaction root is not located under Codex Home.",
      );
    }
    const codexHome = await inspectTrustedTransactionDirectory(codexHomePath, undefined, fileIdentityOptions);
    await ensureTransactionDirectory(switcherPath, io);
    const switcher = await inspectTrustedTransactionDirectory(
      switcherPath,
      codexHome.realPath,
      fileIdentityOptions,
    );
    const rootPath = join(switcherPath, transactionsDirectoryName);
    await ensureTransactionDirectory(rootPath, io);
    return inspectTrustedTransactionDirectory(rootPath, switcher.realPath, fileIdentityOptions);
  } catch (error: unknown) {
    if (error instanceof TransactionError) {
      throw error;
    }
    throw new TransactionError(
      "journal-invalid",
      "The transaction root could not be safely inspected.",
      { cause: error },
    );
  }
}

async function ensureTransactionDirectory(
  path: string,
  io?: TransactionIo,
): Promise<void> {
  const stats = await lstatIfPresent(path);
  if (!stats) {
    await mkdir(path);
  }
  await syncPublishedParentDirectory(path, io);
}

async function inspectTrustedTransactionDirectory(
  path: string,
  expectedParentRealPath?: string,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<TrustedTransactionDirectory> {
  const before = await lstatWithTransactionIdentity(path, fileIdentityOptions);
  if (!isTrustedTransactionDirectoryStats(before)) {
    throw new TransactionError("journal-invalid", "The transaction directory is not a real directory.");
  }
  const pathReal = await realpath(path);
  if (expectedParentRealPath && !isPathInsideOrEqual(expectedParentRealPath, pathReal)) {
    throw new TransactionError("journal-invalid", "The transaction directory escapes its trusted root.");
  }
  const after = await lstatWithTransactionIdentity(path, fileIdentityOptions);
  if (
    !isTrustedTransactionDirectoryStats(after) ||
    !hasSameStableFileIdentity(before, after, fileIdentityOptions?.platform)
  ) {
    throw new TransactionError("journal-invalid", "The transaction directory changed while being inspected.");
  }
  return { path, realPath: pathReal, stats: after };
}

async function assertTrustedTransactionDirectory(
  expected: TrustedTransactionDirectory,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  const current = await inspectTrustedTransactionDirectory(
    expected.path,
    undefined,
    fileIdentityOptions,
  );
  if (
    current.realPath !== expected.realPath ||
    !hasSameStableFileIdentity(expected.stats, current.stats, fileIdentityOptions?.platform)
  ) {
    throw new TransactionError("journal-invalid", "The transaction directory changed after inspection.");
  }
}

function isTrustedTransactionDirectoryStats(stats: Stats | BigIntStats): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink();
}

export interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly nlink: number | bigint;
  readonly windowsFileIdentity?: WindowsFileIdentity;
}

export function hasSameStableFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    left.nlink === right.nlink &&
    hasSameComparableFileIdentity(left, right, platform)
  );
}

function isPathInsideOrEqual(directory: string, path: string): boolean {
  const relativePath = relative(resolve(directory), resolve(path));
  return !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export async function beginTransaction(
  layout: CodexLayout,
  options: TransactionOptions = {},
): Promise<TransactionHandle> {
  const operationId = options.operationId ?? randomUUID();
  assertOperationId(operationId);
  const root = await ensureTrustedTransactionRoot(layout, options.io, options.fileIdentityOptions);
  const lock = await acquireOperationLock(root, operationId, options);
  return beginTransactionWithLock(layout, root, lock, operationId, options);
}

async function beginTransactionWithLock(
  layout: CodexLayout,
  root: TrustedTransactionDirectory,
  lock: OperationLock,
  operationId: string,
  options: TransactionOptions,
): Promise<TransactionHandle> {
  const directory = join(root.path, operationId);
  const journalPath = join(directory, journalFileName);
  const backupDirectory = join(directory, "backup");
  const now = options.now ?? (() => new Date().toISOString());
  let preparedPersisted = false;
  let directoryCreated = false;
  let operationDirectory: TrustedTransactionDirectory;

  try {
    if (await lstatIfPresent(directory)) {
      throw new TransactionError("journal-invalid", "The transaction operation directory already exists.");
    }
    await mkdir(directory);
    directoryCreated = true;
    await syncPublishedParentDirectory(directory, options.io);
    await mkdir(backupDirectory);
    await syncPublishedParentDirectory(backupDirectory, options.io);
    operationDirectory = await inspectTrustedTransactionDirectory(
      directory,
      root.realPath,
      options.fileIdentityOptions,
    );
    await appendJournal(journalPath, {
      version: 1,
      operationId,
      state: "prepared",
      timestamp: now(),
      ...(options.requireSourceVersionProtocol ? { sourceVersionProtocol: true as const } : {}),
    }, operationDirectory, options.io, options.fileIdentityOptions);
    preparedPersisted = true;
  } catch (error: unknown) {
    const errors: unknown[] = [error];
    if (!preparedPersisted && directoryCreated) {
      try {
        await (options.io?.removeTransactionDirectory ?? removeTransactionDirectory)(directory);
        await syncPublishedParentDirectory(directory, options.io);
      } catch (cleanupError: unknown) {
        errors.push(cleanupError);
      }
    }
    try {
      await lock.release();
    } catch (releaseError: unknown) {
      errors.push(releaseError);
    }
    throw new TransactionError(
      "journal-invalid",
      "Could not prepare the transaction journal.",
      {
        cause: errors.length === 1
          ? errors[0]
          : new AggregateError(errors, "Transaction preparation and cleanup both failed."),
      },
    );
  }

  let released = false;
  let state: RuntimeTransactionState = "prepared";
  const pendingTargets: JournalMutationTarget[] = [];
  const appliedTargets: JournalMutationTarget[] = [];
  const appliedTargetVersions: AppliedByteTargetVersion[] = [];
  let backupManifest: BackupManifest | undefined;
  const setState = async (
    nextState: TransactionState,
    targetUpdate?: {
      pending?: readonly JournalMutationTarget[];
      applied?: readonly JournalMutationTarget[];
      appliedVersions?: readonly AppliedByteTargetVersion[];
    },
  ): Promise<void> => {
    try {
      await appendJournal(journalPath, {
        version: 1,
        operationId,
        state: nextState,
        timestamp: now(),
        ...(targetUpdate?.pending ? { pendingTargets: [...targetUpdate.pending] } : {}),
        ...(targetUpdate?.applied ? { appliedTargets: [...targetUpdate.applied] } : {}),
        ...(targetUpdate?.appliedVersions
          ? { appliedTargetVersions: [...targetUpdate.appliedVersions] }
          : {}),
      }, operationDirectory, options.io, options.fileIdentityOptions);
      state = nextState;
    } catch (error: unknown) {
      const directorySyncError = findJournalDirectorySyncError(error);
      if (nextState === "committed" && directorySyncError) {
        if (directorySyncError.classification === "expected") {
          state = "committed";
          throw new CommittedJournalDurabilityError();
        }
        state = "commitVisibilityUncertain";
      }
      throw error;
    }
  };

  const handle: TransactionHandle = {
    operationId,
    directory,
    journalPath,
    backupDirectory,
    async backupTargets(targets) {
      if (state !== "prepared") {
        throw new TransactionError(
          "journal-invalid",
          "Backups can only be created before transaction application.",
        );
      }
        const manifest = await createBackupManifest(
          layout,
          operationId,
          backupDirectory,
          targets,
          options.io,
          backupManifest?.entries,
          options.fileIdentityOptions,
      );
      await writeJsonAtomically(
        join(backupDirectory, manifestFileName),
        manifest,
        options.io,
      );
      backupManifest = manifest;
      return manifest;
    },
    async markApplying(targets = []) {
      if (state !== "prepared") {
        throw new TransactionError(
          "journal-invalid",
          "A transaction can only enter applying from prepared.",
        );
      }
      const normalized = normalizeJournalTargets(layout, targets);
      await setState("applying", normalized.length === 0 ? undefined : { pending: normalized });
      pendingTargets.push(...normalized);
    },
    async prepareTarget(target) {
      if (state !== "applying") {
        throw new TransactionError(
          "journal-invalid",
          "Mutation targets can only be prepared while applying.",
        );
      }
      const normalized = normalizeJournalTarget(layout, target);
      await setState("applying", { pending: [normalized] });
      pendingTargets.push(normalized);
      try {
        await assertPreparedByteTargetVersion(
          layout,
          normalized,
          backupManifest,
          appliedTargetVersions,
          options.io,
          options.fileIdentityOptions,
        );
      } catch (error: unknown) {
        await setState("recoveryRequired");
        throw error;
      }
    },
    async assertTargetUnchanged(target) {
      if (state !== "applying") {
        throw new TransactionError(
          "journal-invalid",
          "Mutation targets can only be checked while applying.",
        );
      }
      const normalized = normalizeJournalTarget(layout, target);
      await assertPreparedByteTargetVersion(
        layout,
        normalized,
        backupManifest,
        appliedTargetVersions,
        options.io,
        options.fileIdentityOptions,
      );
    },
    async markTargetApplied(target) {
      if (state !== "applying") {
        throw new TransactionError(
          "journal-invalid",
          "Mutation targets can only be marked applied while applying.",
        );
      }
      const normalized = normalizeJournalTarget(layout, target);
      if (!pendingTargets.some((candidate) => journalTargetsMatch(candidate, normalized))) {
        throw new TransactionError(
          "journal-invalid",
          "A mutation target must be prepared before it is applied.",
        );
      }
      const version = await captureAppliedByteTargetVersion(
        layout,
        normalized,
        options.io,
        options.fileIdentityOptions,
      );
      if (version) {
        // Keep the evidence for this process even if publishing the journal record fails.
        // A later crash still recovers conservatively because the failed record is not durable.
        appliedTargetVersions.push(version);
      }
      await setState("applying", {
        applied: [normalized],
        ...(version ? { appliedVersions: [version] } : {}),
      });
      appliedTargets.push(normalized);
    },
    async markCommitted() {
      if (state !== "applying") {
        throw new TransactionError(
          "journal-invalid",
          "A transaction can only commit after application starts.",
        );
      }
      await setState("committed");
    },
    async markRolledBack() {
      if (state === "rolledBack") {
        return;
      }
      if (state !== "prepared") {
        throw new TransactionError(
          "journal-invalid",
          "A transaction can only be marked rolled back before application starts.",
        );
      }
      await setState("rolledBack");
    },
    async markRecoveryRequired() {
      if (state === "committed" || state === "commitVisibilityUncertain") {
        throw new TransactionError(
          "journal-invalid",
          "A committed transaction cannot require compensation.",
        );
      }
      if (state === "recoveryRequired") {
        return;
      }
      await setState("recoveryRequired");
    },
    async rollback(restoreAuthMode) {
      if (compensationIsForbidden(state)) {
        throw new TransactionError(
          "journal-invalid",
          "A committed or recovery-bound transaction cannot be compensated.",
        );
      }
      if (state === "rolledBack") {
        return;
      }
      try {
        await restoreTransactionTargets(
          layout,
          join(backupDirectory, manifestFileName),
          pendingTargets,
          restoreAuthMode,
          options.io,
          appliedTargetVersions,
          options.requireSourceVersionProtocol === true,
          options.fileIdentityOptions,
        );
        await setState("rolledBack");
      } catch (error: unknown) {
        try {
          await setState("recoveryRequired");
        } catch {
          // The original rollback error is the useful bounded result.
        }
        throw new TransactionError(
          "rollback-failed",
          "The transaction could not be fully rolled back.",
          { cause: new Error("Rollback failure details are redacted.") },
        );
      }
    },
    async validateRollback(restoreAuthMode) {
      if (state === "committed" || state === "commitVisibilityUncertain") {
        throw new TransactionError(
          "journal-invalid",
          "A committed transaction cannot be rolled back.",
        );
      }
      if (state === "rolledBack" || state === "recoveryRequired") {
        return;
      }
      const backupTargets = await validateTransactionTargets(
        layout,
        join(backupDirectory, manifestFileName),
        pendingTargets,
        restoreAuthMode,
        options.io,
        appliedTargetVersions,
        options.requireSourceVersionProtocol === true,
        options.fileIdentityOptions,
      );
      await closeValidatedBackupTargets(backupTargets);
    },
    async release() {
      if (released) {
        return;
      }
      await lock.release();
      released = true;
    },
  };

  return handle;
}

export async function recoverPendingSwitches(
  layout: CodexLayout,
  dependencies: RecoveryDependencies = {},
): Promise<RecoveryResult> {
  const root = await ensureTrustedTransactionRoot(
    layout,
    dependencies.io,
    dependencies.fileIdentityOptions,
  );
  const lock = await acquireOperationLock(root, "recovery", dependencies);
  try {
    return await recoverPendingSwitchesWithLock(layout, root, dependencies);
  } finally {
    await lock.release();
  }
}

export async function recoverAndBeginTransaction(
  layout: CodexLayout,
  dependencies: RecoveryDependencies = {},
): Promise<RecoverAndBeginTransactionResult> {
  const operationId = dependencies.operationId ?? randomUUID();
  assertOperationId(operationId);
  const root = await ensureTrustedTransactionRoot(
    layout,
    dependencies.io,
    dependencies.fileIdentityOptions,
  );
  const lock = await acquireOperationLock(root, operationId, dependencies);
  let lockTransferred = false;
  try {
    const recovery = await recoverPendingSwitchesWithLock(layout, root, dependencies);
    if (recovery.recoveryRequiredOperationIds.length > 0) {
      return { recovery };
    }
    lockTransferred = true;
    const transaction = await beginTransactionWithLock(
      layout,
      root,
      lock,
      operationId,
      dependencies,
    );
    return { recovery, transaction };
  } finally {
    if (!lockTransferred) {
      await lock.release();
    }
  }
}

async function recoverPendingSwitchesWithLock(
  layout: CodexLayout,
  root: TrustedTransactionDirectory,
  dependencies: RecoveryDependencies,
): Promise<RecoveryResult> {
  const recoveredOperationIds: string[] = [];
  const skippedCommittedOperationIds: string[] = [];
  const recoveryRequiredOperationIds: string[] = [];
  const recoveryDiagnostics: RecoveryDiagnostic[] = [];
  const internalRecoveryDiagnostics = new Map<string, AggregateError>();
  let entries;
  try {
    entries = await readdir(root.path, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return {
        recoveredOperationIds,
        skippedCommittedOperationIds,
        recoveryRequiredOperationIds,
        recoveryDiagnostics,
      };
    }
    throw error;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === operationLockFileName) {
      continue;
    }
    if (!entry.isDirectory()) {
      throw new TransactionError("journal-invalid", "A transaction operation entry is not a directory.");
    }
    const operationId = entry.name;
    const operationDirectory = await inspectTrustedTransactionDirectory(
      join(root.path, operationId),
      root.realPath,
      dependencies.fileIdentityOptions,
    );
    const directory = operationDirectory.path;
    const journalPath = join(directory, journalFileName);
    const journal = await readJournal(
      journalPath,
      dependencies.io,
      dependencies.fileIdentityOptions,
    );
    const last = journal.at(-1);
    if (!last) {
      throw new TransactionError("journal-invalid", "The transaction journal is invalid.");
    }
    const enforceSourceVersionProtocol = journal[0]?.sourceVersionProtocol === true;
    const pendingTargets = normalizeJournalRecoveryTargets(layout, journal);
    const appliedTargetVersions = normalizeJournalRecoveryTargetVersions(layout, journal);
    if (last.state === "committed") {
      skippedCommittedOperationIds.push(operationId);
      continue;
    }
    if (last.state !== "prepared" && last.state !== "applying") {
      if (last.state === "recoveryRequired") {
        recoveryRequiredOperationIds.push(operationId);
      }
      continue;
    }

    try {
      if (last.state === "applying") {
        await restoreBackupManifest(
          layout,
          join(directory, "backup", manifestFileName),
          pendingTargets,
          dependencies.restoreAuthMode,
          dependencies.io,
          appliedTargetVersions,
          enforceSourceVersionProtocol,
          dependencies.fileIdentityOptions,
        );
      }
      await appendJournal(journalPath, {
        version: 1,
        operationId,
        state: "rolledBack",
        timestamp: (dependencies.now ?? (() => new Date().toISOString()))(),
      }, operationDirectory, dependencies.io, dependencies.fileIdentityOptions);
      recoveredOperationIds.push(operationId);
    } catch (recoveryError: unknown) {
      let recoveryRequiredJournalWritten = true;
      let journalAppendError: unknown;
      try {
        await appendJournal(journalPath, {
          version: 1,
          operationId,
          state: "recoveryRequired",
          timestamp: (dependencies.now ?? (() => new Date().toISOString()))(),
        }, operationDirectory, dependencies.io, dependencies.fileIdentityOptions);
      } catch (error: unknown) {
        recoveryRequiredJournalWritten = false;
        journalAppendError = error;
      }
      internalRecoveryDiagnostics.set(operationId, new AggregateError(
        journalAppendError === undefined
          ? [recoveryError]
          : [recoveryError, journalAppendError],
        "Internal recovery diagnostic.",
      ));
      recoveryRequiredOperationIds.push(operationId);
      recoveryDiagnostics.push({ operationId, recoveryRequiredJournalWritten });
    }
  }
  return {
    recoveredOperationIds,
    skippedCommittedOperationIds,
    recoveryRequiredOperationIds,
    recoveryDiagnostics,
  };
}

interface OperationLock {
  release(): Promise<void>;
}

export async function readTransactionJournal(
  journalPath: string,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<JournalEntry[]> {
  return readJournal(journalPath, undefined, fileIdentityOptions);
}

async function acquireOperationLock(
  root: TrustedTransactionDirectory,
  operationId: string,
  options: TransactionOptions,
): Promise<OperationLock> {
  await assertTrustedTransactionDirectory(root, options.fileIdentityOptions);
  const path = join(root.path, operationLockFileName);
  const contents = JSON.stringify({
    pid: process.pid,
    operationId,
    createdAt: Date.now(),
  });
  while (true) {
    await removeOrphanedLockHandoffs(root, path, options);
    try {
      const handle = await open(path, "wx", 0o600);
      let setupFailed = false;
      let setupError: unknown;
      try {
        await (options.io?.writeLock ?? defaultWriteLock)(handle, contents);
        await (options.io?.syncHandle ?? defaultSyncHandle)(handle);
      } catch (error: unknown) {
        setupFailed = true;
        setupError = error;
      }
      try {
        await (options.io?.closeHandle ?? defaultCloseHandle)(handle);
      } catch (error: unknown) {
        setupError = setupFailed
          ? new AggregateError(
              [setupError, error],
              "Lock setup and handle close both failed.",
            )
          : error;
        setupFailed = true;
      }
      if (setupFailed) {
        try {
          await removeIncompleteLock(path, options);
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [setupError, cleanupError],
            "Lock setup failed and the incomplete lock could not be removed.",
          );
        }
        throw setupError;
      }
      const verifiedLock = await openVerifiedLock(
        path,
        contents,
        options.fileIdentityOptions,
      );
      let released = false;
      let releaseFailure: unknown;
      return {
        async release() {
          if (released) {
            return;
          }
          if (releaseFailure !== undefined) {
            throw releaseFailure;
          }
          try {
            await removeVerifiedLock(path, verifiedLock, "release", options);
            released = true;
          } catch (error: unknown) {
            if (isMissingFileError(error)) {
              await closeLockHandle(verifiedLock.handle);
              released = true;
              return;
            }
            releaseFailure = error;
            throw error;
          }
        },
      };
    } catch (error: unknown) {
      if (!isExistsError(error)) {
        throw error;
      }
      const existing = await readVerifiedLock(path, options.fileIdentityOptions);
      if (!existing) {
        continue;
      }
      const record = parseLockRecord(existing.contents);
      if (!record) {
        await closeLockHandle(existing.handle);
        throw new TransactionError(
          "lock-unverifiable",
          "An existing Codex Home operation lock could not be verified.",
        );
      }
      const alive = (options.isProcessAlive ?? defaultIsProcessAlive)(record.pid);
      if (alive !== false) {
        await closeLockHandle(existing.handle);
        throw new TransactionError(
          "lock-held",
          "Another Codex Home operation lock is already active.",
        );
      }
      try {
        await removeVerifiedLock(path, existing, "stale-reclaim", options);
      } catch (unlinkError: unknown) {
        if (!isMissingFileError(unlinkError)) {
          if (unlinkError instanceof TransactionError) {
            throw unlinkError;
          }
          throw new TransactionError(
            "lock-held",
            "A stale Codex Home operation lock could not be reclaimed.",
            { cause: unlinkError },
          );
        }
      }
    }
  }
}

async function removeOrphanedLockHandoffs(
  root: TrustedTransactionDirectory,
  lockPath: string,
  options: TransactionOptions,
): Promise<void> {
  if (await lstatIfPresent(lockPath)) {
    return;
  }
  await assertTrustedTransactionDirectory(root, options.fileIdentityOptions);
  const entries = await readdir(root.path, { withFileTypes: true });
  for (const entry of entries) {
    if (!operationLockHandoffPattern.test(entry.name)) {
      continue;
    }
    if (await lstatIfPresent(lockPath)) {
      return;
    }

    const handoffPath = join(root.path, entry.name);
    const handoff = await openVerifiedLock(handoffPath, undefined, options.fileIdentityOptions);
    try {
      if (!parseCompleteLockRecord(handoff.contents)) {
        throw lockUnverifiable("A Codex Home operation lock handoff has invalid contents.");
      }
      await assertTrustedTransactionDirectory(root, options.fileIdentityOptions);
      await assertVerifiedLockOwnership(handoffPath, handoff, options.fileIdentityOptions);
      if (await lstatIfPresent(lockPath)) {
        return;
      }
      await assertTrustedTransactionDirectory(root, options.fileIdentityOptions);
      await assertVerifiedLockOwnership(handoffPath, handoff, options.fileIdentityOptions);
      await removeVerifiedLock(handoffPath, handoff, "stale-reclaim", options);
    } finally {
      await closeLockHandle(handoff.handle);
    }
  }
}

interface VerifiedLock {
  readonly handle: FileHandle;
  readonly stats: BigIntStats;
  readonly contents: string;
}

async function openVerifiedLock(
  path: string,
  expectedContents?: string,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<VerifiedLock> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstatWithTransactionIdentity(path, fileIdentityOptions);
    assertVerifiableLockStats(before, fileIdentityOptions?.platform);
    handle = await open(path, "r");
    const handleStats = await statWithTransactionIdentity(handle, path, fileIdentityOptions);
    assertVerifiableLockStats(handleStats, fileIdentityOptions?.platform);
    if (!hasSameVerifiableFileIdentity(before, handleStats, fileIdentityOptions?.platform)) {
      throw lockUnverifiable("The Codex Home operation lock changed while being opened.");
    }
    const contents = await readLockHandle(handle, handleStats);
    if (expectedContents !== undefined && contents !== expectedContents) {
      throw lockUnverifiable("The Codex Home operation lock ownership changed after creation.");
    }
    await assertLockPathIdentity(path, handleStats, fileIdentityOptions);
    return { handle, stats: handleStats, contents };
  } catch (error: unknown) {
    if (handle) {
      await closeLockHandle(handle);
    }
    if (error instanceof TransactionError || isMissingFileError(error)) {
      throw error;
    }
    throw lockUnverifiable("The Codex Home operation lock could not be safely opened.", error);
  }
}

async function readVerifiedLock(
  path: string,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<VerifiedLock | undefined> {
  try {
    return await openVerifiedLock(path, undefined, fileIdentityOptions);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function removeVerifiedLock(
  path: string,
  lock: VerifiedLock,
  phase: "release" | "stale-reclaim",
  options: TransactionOptions,
): Promise<void> {
  const tombstonePath = join(dirname(path), `${operationLockFileName}.handoff-${randomUUID()}`);
  let handedOff = false;
  try {
    await assertVerifiedLockOwnership(path, lock, options.fileIdentityOptions);
    await options.io?.afterLockOwnershipVerified?.(path, phase);
    await assertLockPathIdentity(path, lock.stats, options.fileIdentityOptions);

    // Node has no portable rename-if-same-inode primitive. Rename narrows the race to
    // an atomic handoff; identity is checked again before only the tombstone is removed.
    await rename(path, tombstonePath);
    handedOff = true;
    const tombstoneStats = await lstatWithTransactionIdentity(
      tombstonePath,
      options.fileIdentityOptions,
    );
    if (!hasSameVerifiableFileIdentity(
      lock.stats,
      tombstoneStats,
      options.fileIdentityOptions?.platform,
    )) {
      await restoreHandedOffLock(
        tombstonePath,
        path,
        lock.stats,
        options.fileIdentityOptions,
      );
      handedOff = false;
      throw lockUnverifiable("The Codex Home operation lock ownership changed during handoff.");
    }
    const deletion = await removeLockPathByIdentity(tombstonePath, tombstoneStats, options);
    if (deletion === "missing") {
      handedOff = false;
      return;
    }
    handedOff = false;
  } catch (error: unknown) {
    if (handedOff) {
      if (isMissingFileError(error) && !(await lstatIfPresent(tombstonePath))) {
        handedOff = false;
        return;
      }
      try {
        await restoreHandedOffLock(
          tombstonePath,
          path,
          lock.stats,
          options.fileIdentityOptions,
        );
      } catch (restoreError: unknown) {
        throw lockUnverifiable(
          "The Codex Home operation lock handoff could not be safely restored.",
          new AggregateError([error, restoreError], "Lock handoff and restoration both failed."),
        );
      }
    }
    throw error;
  } finally {
    await closeLockHandle(lock.handle);
  }
}

async function assertVerifiedLockOwnership(
  path: string,
  lock: VerifiedLock,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  const handleStats = await statWithTransactionIdentity(
    lock.handle,
    path,
    fileIdentityOptions,
  );
  assertVerifiableLockStats(handleStats, fileIdentityOptions?.platform);
  if (!hasSameVerifiableFileIdentity(lock.stats, handleStats, fileIdentityOptions?.platform)) {
    throw lockUnverifiable("The Codex Home operation lock handle ownership changed.");
  }
  if ((await readLockHandle(lock.handle, handleStats)) !== lock.contents) {
    throw lockUnverifiable("The Codex Home operation lock contents changed.");
  }
  await assertLockPathIdentity(path, handleStats, fileIdentityOptions);
}

async function assertLockPathIdentity(
  path: string,
  expected: BigIntStats,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  let current: BigIntStats;
  try {
    current = await lstatWithTransactionIdentity(path, fileIdentityOptions);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      throw error;
    }
    throw lockUnverifiable("The Codex Home operation lock path could not be inspected.", error);
  }
  assertVerifiableLockStats(current, fileIdentityOptions?.platform);
  if (!hasSameVerifiableFileIdentity(expected, current, fileIdentityOptions?.platform)) {
    throw lockUnverifiable("The Codex Home operation lock ownership changed.");
  }
}

function assertVerifiableLockStats(
  stats: BigIntStats,
  platform: NodeJS.Platform = process.platform,
): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1n ||
    !hasComparableFileIdentity(stats as FileIdentity, platform)
  ) {
    throw lockUnverifiable("The Codex Home operation lock is not safely identifiable.");
  }
}

function hasSameVerifiableFileIdentity(
  left: BigIntStats,
  right: BigIntStats,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    hasSameComparableFileIdentity(left, right, platform) &&
    left.nlink === right.nlink
  );
}

async function readLockHandle(handle: FileHandle, stats: BigIntStats): Promise<string> {
  if (stats.size < 1n || stats.size > BigInt(maximumLockBytes)) {
    throw lockUnverifiable("The Codex Home operation lock has an invalid size.");
  }
  const buffer = Buffer.alloc(Number(stats.size));
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead < 1) {
      throw lockUnverifiable("The Codex Home operation lock could not be read completely.");
    }
    offset += bytesRead;
  }
  return buffer.toString("utf8");
}

async function restoreHandedOffLock(
  source: string,
  destination: string,
  expectedStats: BigIntStats,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  // Hard-link publication is no-replace on Windows and POSIX. It cannot overwrite a
  // newer lock that appeared after handoff, so a conflict leaves that lock untouched.
  try {
    await link(source, destination);
  } catch (error: unknown) {
    if (isExistsError(error)) {
      return;
    }
    throw error;
  }

  const platform = fileIdentityOptions?.platform ?? process.platform;
  if (platform !== "win32" || expectedStats.ino !== 0n) {
    await unlink(source);
    return;
  }

  const expectedIdentity = snapshotTransactionWindowsIdentity(
    readOwnDataProperty(expectedStats, "windowsFileIdentity"),
  );
  if (!expectedIdentity) {
    throw lockUnverifiable(
      "The handed-off Codex Home operation lock has no verifiable Windows identity.",
    );
  }
  const operations = fileIdentityOptions?.windowsFileOperations ?? createWindowsFileOperations();
  if (typeof operations.deleteHardLinkIfMatches !== "function") {
    throw lockUnverifiable(
      "The handed-off Codex Home operation lock cannot be safely restored on Windows.",
    );
  }
  let result: "deleted" | "identity-mismatch";
  try {
    result = operations.deleteHardLinkIfMatches(source, expectedIdentity);
  } catch (error: unknown) {
    throw lockUnverifiable(
      "The handed-off Codex Home operation lock could not be safely removed.",
      error,
    );
  }
  if (result === "identity-mismatch") {
    throw lockUnverifiable(
      "The handed-off Codex Home operation lock changed before restoration.",
    );
  }
}

async function closeLockHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Ownership failures are already bounded; closing must not replace that result.
  }
}

function lockUnverifiable(message: string, cause?: unknown): TransactionError {
  return new TransactionError(
    "lock-unverifiable",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function parseLockRecord(contents: string): { pid: number } | undefined {
  try {
    const value = JSON.parse(contents) as { pid?: unknown };
    return Number.isSafeInteger(value.pid) && (value.pid as number) > 0
      ? { pid: value.pid as number }
      : undefined;
  } catch {
    return undefined;
  }
}

function parseCompleteLockRecord(contents: string): boolean {
  try {
    const value: unknown = JSON.parse(contents);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return (
      keys.length === 3 &&
      keys[0] === "createdAt" &&
      keys[1] === "operationId" &&
      keys[2] === "pid" &&
      Number.isSafeInteger(record.pid) &&
      (record.pid as number) > 0 &&
      typeof record.operationId === "string" &&
      /^[a-zA-Z0-9._-]+$/.test(record.operationId) &&
      Number.isSafeInteger(record.createdAt) &&
      (record.createdAt as number) >= 0
    );
  } catch {
    return false;
  }
}

async function defaultWriteLock(handle: FileHandle, contents: string): Promise<void> {
  await handle.writeFile(contents, "utf8");
}

async function defaultSyncHandle(handle: FileHandle): Promise<void> {
  await handle.sync();
}

async function defaultCloseHandle(handle: FileHandle): Promise<void> {
  await handle.close();
}

async function removeTransactionDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

async function createBackupManifest(
  layout: CodexLayout,
  operationId: string,
  backupDirectory: string,
  targets: readonly BackupTarget[],
  io?: TransactionIo,
  existingEntries: readonly BackupManifestEntry[] = [],
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<BackupManifest> {
  const entries: BackupManifestEntry[] = [...existingEntries];
  const seen = new Set(entries.map((entry) => `${entry.kind}:${entry.path}`));
  for (const target of targets) {
    const path = resolve(target.path);
    assertAllowedBackupTarget(layout, target.kind, path);
    const key = `${target.kind}:${path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const sourceStats = await lstatBigIntIfPresent(path, fileIdentityOptions);
    if (!sourceStats) {
      entries.push({
        kind: target.kind,
        path,
        existed: false,
        sourceVersion: { existed: false },
      });
      continue;
    }
    await assertSafeByteBackupSource(layout, path, sourceStats, fileIdentityOptions);
    await io?.afterBackupSourceLstat?.(path);
    const index = entries.length.toString().padStart(4, "0");
    const backupPath = join(backupDirectory, `${index}-${basename(path)}`);
    const sourceVersion = await copyBackupSourceSafely(
      layout,
      path,
      sourceStats,
      backupPath,
      io,
      fileIdentityOptions,
    );
    await syncFile(backupPath, io);
    entries.push({
      kind: target.kind,
      path,
      backupPath,
      existed: true,
      sha256: await hashFile(backupPath, io),
      mode: Number(sourceStats.mode & 0o777n),
      sourceVersion,
    });
  }
  return { version: 1, operationId, entries };
}

async function assertPreparedByteTargetVersion(
  layout: CodexLayout,
  target: JournalMutationTarget,
  manifest: BackupManifest | undefined,
  appliedVersions: readonly AppliedByteTargetVersion[],
  io?: TransactionIo,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  if (target.kind === "auth") {
    return;
  }
  const entry = findBackupManifestEntry(manifest, target);
  const expected = latestAppliedTargetVersion(appliedVersions, target) ?? entry.sourceVersion;
  await assertByteTargetVersion(layout, target, expected, io, fileIdentityOptions);
}

async function captureAppliedByteTargetVersion(
  layout: CodexLayout,
  target: JournalMutationTarget,
  io?: TransactionIo,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<AppliedByteTargetVersion | undefined> {
  if (target.kind === "auth") {
    return {
      target,
      version: await captureAuthTargetVersion(layout, target, io, fileIdentityOptions),
    };
  }
  if (target.kind !== "config" && target.kind !== "sqlite" && target.kind !== "rollout") {
    return undefined;
  }
  return {
    target,
    version: await captureByteTargetVersion(layout, target, io, fileIdentityOptions),
  };
}

function findBackupManifestEntry(
  manifest: BackupManifest | undefined,
  target: ByteBackedTarget,
): BackupManifestEntry {
  const matches = manifest?.entries.filter((entry) => (
    entry.kind === target.kind && sameResolvedPath(entry.path, target.path)
  )) ?? [];
  const [entry] = matches;
  if (!entry || matches.length !== 1 || !isValidBackupManifestEntry(entry)) {
    throw new TransactionError("rollback-failed", "The transaction backup source cannot be verified.");
  }
  return entry;
}

function latestAppliedTargetVersion(
  versions: readonly AppliedByteTargetVersion[],
  target: VersionedJournalTarget,
): ByteTargetVersion | undefined {
  for (let index = versions.length - 1; index >= 0; index -= 1) {
    const candidate = versions[index];
    if (candidate.target.kind === target.kind && sameResolvedPath(candidate.target.path, target.path)) {
      return candidate.version;
    }
  }
  return undefined;
}

async function assertByteTargetVersion(
  layout: CodexLayout,
  target: ByteBackedTarget,
  expected: ByteTargetVersion,
  io?: TransactionIo,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  if (!isValidByteTargetVersion(expected)) {
    throw new TransactionError("rollback-failed", "The transaction byte target version is invalid.");
  }
  const actual = await captureByteTargetVersion(layout, target, io, fileIdentityOptions);
  if (!sameByteTargetVersion(expected, actual)) {
    throw new TransactionError(
      "rollback-failed",
      "The transaction byte target changed outside the switch operation.",
    );
  }
}

async function captureByteTargetVersion(
  layout: CodexLayout,
  target: ByteBackedTarget,
  io?: TransactionIo,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<ByteTargetVersion> {
  const path = resolve(target.path);
  assertAllowedBackupTarget(layout, target.kind, path);
  let handle: FileHandle | undefined;
  let primaryError: unknown;
  try {
    const pathStats = await lstatBigIntIfPresent(path, fileIdentityOptions);
    if (!pathStats) {
      return { existed: false };
    }
    await assertSafeByteBackupSource(layout, path, pathStats, fileIdentityOptions);
    handle = await open(path, "r");
    const openedStats = await statWithTransactionIdentity(handle, path, fileIdentityOptions);
    await assertOpenedBackupSource(layout, path, pathStats, openedStats, fileIdentityOptions);
    const sha256 = await hashOpenedFile(handle, io);
    const finalStats = await statWithTransactionIdentity(handle, path, fileIdentityOptions);
    await assertOpenedBackupSource(layout, path, openedStats, finalStats, fileIdentityOptions);
    const pathAfter = await lstatWithTransactionIdentity(path, fileIdentityOptions);
    if (!sameStableByteSourceStats(finalStats, pathAfter, fileIdentityOptions?.platform)) {
      throw new Error("The byte target changed while being versioned.");
    }
    const version = byteTargetVersion(finalStats, sha256);
    await handle.close();
    handle = undefined;
    return version;
  } catch (error: unknown) {
    primaryError = error;
  }
  if (handle) {
    try {
      await handle.close();
    } catch (closeError: unknown) {
      primaryError = new AggregateError(
        [primaryError, closeError],
        "Byte target versioning and handle close both failed.",
      );
    }
  }
  throw new TransactionError(
    "rollback-failed",
    "The transaction byte target could not be safely verified.",
    { cause: primaryError },
  );
}

async function captureAuthTargetVersion(
  layout: CodexLayout,
  target: AuthJournalTarget,
  io?: TransactionIo,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<ByteTargetVersion> {
  const path = resolve(target.path);
  if (path !== resolve(layout.authPath)) {
    throw new TransactionError("rollback-failed", "The auth target is not allowed.");
  }

  let handle: FileHandle | undefined;
  let primaryError: unknown;
  try {
    const pathStats = await lstatBigIntIfPresent(path, fileIdentityOptions);
    if (!pathStats) {
      return { existed: false };
    }
    assertSafeAuthVersionSource(pathStats, fileIdentityOptions?.platform);
    handle = await open(path, "r");
    const openedStats = await statWithTransactionIdentity(handle, path, fileIdentityOptions);
    assertSafeAuthVersionSource(openedStats, fileIdentityOptions?.platform);
    if (!sameStableByteSourceStats(pathStats, openedStats, fileIdentityOptions?.platform)) {
      throw new Error("The auth target changed before opening.");
    }
    const sha256 = await hashOpenedFile(handle, io);
    const finalStats = await statWithTransactionIdentity(handle, path, fileIdentityOptions);
    assertSafeAuthVersionSource(finalStats, fileIdentityOptions?.platform);
    const pathAfter = await lstatWithTransactionIdentity(path, fileIdentityOptions);
    if (
      !sameStableByteSourceStats(openedStats, finalStats, fileIdentityOptions?.platform) ||
      !sameStableByteSourceStats(finalStats, pathAfter, fileIdentityOptions?.platform)
    ) {
      throw new Error("The auth target changed while being versioned.");
    }
    const version = byteTargetVersion(finalStats, sha256);
    await handle.close();
    handle = undefined;
    return version;
  } catch (error: unknown) {
    primaryError = error;
  }
  if (handle) {
    try {
      await handle.close();
    } catch (closeError: unknown) {
      primaryError = new AggregateError(
        [primaryError, closeError],
        "Auth target versioning and handle close both failed.",
      );
    }
  }
  throw new TransactionError(
    "rollback-failed",
    "The auth target could not be safely verified.",
    { cause: primaryError },
  );
}

function assertSafeAuthVersionSource(
  stats: BigIntStats,
  platform: NodeJS.Platform = process.platform,
): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1n ||
    !hasComparableFileIdentity(stats as FileIdentity, platform)
  ) {
    throw new Error("The auth target is not a safe regular file.");
  }
}

function byteTargetVersion(stats: BigIntStats, sha256: string): ByteTargetVersion {
  const nativeIdentity = snapshotTransactionWindowsIdentity(
    readOwnDataProperty(stats, "windowsFileIdentity"),
  );
  const version: ByteTargetVersion = {
    existed: true,
    sha256,
    mode: Number(stats.mode & 0o777n),
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    links: stats.nlink.toString(),
    size: stats.size.toString(),
    modifiedAtNs: stats.mtimeNs.toString(),
    changedAtNs: stats.ctimeNs.toString(),
  };
  if (nativeIdentity) {
    version.volumeSerial = nativeIdentity.volumeSerial;
    version.fileId = nativeIdentity.fileId;
  }
  return version;
}

function sameByteTargetVersion(
  left: ByteTargetVersion,
  right: ByteTargetVersion,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStableByteSourceStats(
  left: BigIntStats,
  right: BigIntStats,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    hasSameBigIntFileIdentity(left, right, platform) &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function restoreBackupManifest(
  layout: CodexLayout,
  manifestPath: string,
  targets: readonly JournalMutationTarget[],
  restoreAuthMode?: AuthModeRestorer,
  io?: TransactionIo,
  appliedTargetVersions: readonly AppliedByteTargetVersion[] = [],
  enforceSourceVersionProtocol = false,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  await restoreTransactionTargets(
    layout,
    manifestPath,
    targets,
    restoreAuthMode,
    io,
    appliedTargetVersions,
    enforceSourceVersionProtocol,
    fileIdentityOptions,
  );
}

async function restoreTransactionTargets(
  layout: CodexLayout,
  manifestPath: string,
  targets: readonly JournalMutationTarget[],
  restoreAuthMode?: AuthModeRestorer,
  io?: TransactionIo,
  appliedTargetVersions: readonly AppliedByteTargetVersion[] = [],
  enforceSourceVersionProtocol = false,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  const backupTargets = await validateTransactionTargets(
    layout,
    manifestPath,
    targets,
    restoreAuthMode,
    io,
    appliedTargetVersions,
    enforceSourceVersionProtocol,
    fileIdentityOptions,
  );
  try {
    for (const target of [...targets].reverse()) {
      if (target.kind === "auth") {
        await restoreAuthMode!(target);
      }
    }
    for (const target of [...backupTargets].reverse()) {
      if (!target.shouldRestore) {
        continue;
      }
      if (!target.entry.existed) {
        await removeRestoreTargetIfPresent(
          layout,
          target.path,
          target.entry.kind,
          target.expectedVersion,
          io,
          fileIdentityOptions,
        );
        continue;
      }
      await restoreFileAtomically(
        layout,
        target,
        target.path,
        target.expectedVersion,
        io,
        fileIdentityOptions,
      );
    }
  } catch (error: unknown) {
    return await rethrowAfterValidatedBackupClose(backupTargets, error);
  }
  await closeValidatedBackupTargets(backupTargets);
}

async function validateTransactionTargets(
  layout: CodexLayout,
  manifestPath: string,
  targets: readonly JournalMutationTarget[],
  restoreAuthMode?: AuthModeRestorer,
  io?: TransactionIo,
  appliedTargetVersions: readonly AppliedByteTargetVersion[] = [],
  enforceSourceVersionProtocol = false,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<ValidatedByteRestoreTarget[]> {
  const backupTargets = await validateByteRestoreTargets(
    layout,
    manifestPath,
    targets,
    io,
    appliedTargetVersions,
    enforceSourceVersionProtocol,
    fileIdentityOptions,
  );
  try {
    for (const target of targets) {
      if (target.kind === "rollout") {
        await validateRolloutInversePatch(target.inversePatch, layout);
      }
    }
    for (const target of targets) {
      if (target.kind !== "auth") {
        continue;
      }
      const expectedVersion = latestAppliedTargetVersion(appliedTargetVersions, target);
      if (enforceSourceVersionProtocol && !expectedVersion) {
        throw new TransactionError(
          "rollback-failed",
          "The strict transaction journal lacks auth mutation evidence.",
        );
      }
      if (expectedVersion) {
        await assertAuthTargetVersion(
          layout,
          target,
          expectedVersion,
          io,
          fileIdentityOptions,
        );
      }
    }
    if (targets.some((target) => target.kind === "auth") && !restoreAuthMode) {
      throw new TransactionError(
        "rollback-failed",
        "Auth recovery requires an injected auth mode restorer.",
      );
    }
    return backupTargets;
  } catch (error: unknown) {
    return await rethrowAfterValidatedBackupClose(backupTargets, error);
  }
}

async function assertAuthTargetVersion(
  layout: CodexLayout,
  target: AuthJournalTarget,
  expected: ByteTargetVersion,
  io?: TransactionIo,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  if (!isValidByteTargetVersion(expected)) {
    throw new TransactionError("rollback-failed", "The auth target version is invalid.");
  }
  const actual = await captureAuthTargetVersion(layout, target, io, fileIdentityOptions);
  if (!sameByteTargetVersion(expected, actual)) {
    throw new TransactionError(
      "rollback-failed",
      "The auth target changed outside the switch operation.",
    );
  }
}

interface ValidatedByteRestoreTarget {
  readonly path: string;
  readonly entry: BackupManifestEntry;
  readonly expectedVersion?: ByteTargetVersion;
  readonly shouldRestore: boolean;
  readonly backupPath?: string;
  readonly backupHandle?: FileHandle;
  readonly backupStats?: BigIntStats;
}

async function validateByteRestoreTargets(
  layout: CodexLayout,
  manifestPath: string,
  targets: readonly JournalMutationTarget[],
  io?: TransactionIo,
  appliedTargetVersions: readonly AppliedByteTargetVersion[] = [],
  enforceSourceVersionProtocol = false,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<ValidatedByteRestoreTarget[]> {
  const selectedTargets = targets.filter(
    (target): target is ByteBackedJournalTarget => (
      target.kind === "config" || target.kind === "sqlite" || target.kind === "rollout"
    ),
  );
  if (selectedTargets.length === 0) {
    return [];
  }

  const manifest = await readBackupManifest(manifestPath, io, fileIdentityOptions);
  const backupDirectory = dirname(manifestPath);
  const validatedTargets: ValidatedByteRestoreTarget[] = [];
  const seen = new Set<string>();
  try {
    for (const target of selectedTargets) {
      const path = resolve(target.path);
      const key = `${target.kind}:${path}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      assertAllowedBackupTarget(layout, target.kind, path);
      const matches = manifest.entries.filter((entry) => (
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        entry.kind === target.kind &&
        typeof entry.path === "string" &&
        resolve(entry.path) === path
      ));
      const [entry] = matches;
      if (!entry || matches.length !== 1 || !isValidBackupManifestEntry(entry)) {
        throw new TransactionError("rollback-failed", "The backup manifest is incomplete.");
      }
      assertAllowedBackupTarget(layout, entry.kind, resolve(entry.path));
      const appliedVersion = latestAppliedTargetVersion(
        appliedTargetVersions,
        target,
      );
      const expectedVersion = appliedVersion ?? (
        enforceSourceVersionProtocol ? entry.sourceVersion : undefined
      );
      if (expectedVersion) {
        await assertByteTargetVersion(layout, target, expectedVersion, io, fileIdentityOptions);
      }
      if (!entry.existed) {
        validatedTargets.push({
          path,
          entry,
          expectedVersion,
          shouldRestore: true,
        });
        continue;
      }

      const backupPath = resolve(entry.backupPath!);
      if (!isInsideDirectory(backupDirectory, backupPath)) {
        throw new TransactionError("rollback-failed", "The backup manifest escapes its transaction directory.");
      }
      const verifiedBackup = await openVerifiedRestoreBackup(
        backupPath,
        entry.sha256!,
        io,
        fileIdentityOptions,
      );
      validatedTargets.push({
        path,
        entry,
        expectedVersion,
        shouldRestore: true,
        backupPath,
        backupHandle: verifiedBackup.handle,
        backupStats: verifiedBackup.stats,
      });
      await io?.afterBackupValidation?.(backupPath);
    }
    return validatedTargets;
  } catch (error: unknown) {
    return await rethrowAfterValidatedBackupClose(validatedTargets, error);
  }
}

async function readBackupManifest(
  manifestPath: string,
  io?: TransactionIo,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<BackupManifest> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      (await readVerifiedMetadataFile(
        manifestPath,
        "rollback-failed",
        "The backup manifest is not a regular file.",
        io?.afterManifestPathValidated,
        fileIdentityOptions,
      )).toString("utf8"),
    ) as unknown;
  } catch (error: unknown) {
    if (error instanceof TransactionError) {
      throw error;
    }
    if (isMissingFileError(error)) {
      throw new TransactionError("rollback-failed", "The backup manifest is missing.", { cause: error });
    }
    throw new TransactionError("rollback-failed", "The backup manifest is invalid.", { cause: error });
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    !hasOnlyKeys(manifest as Record<string, unknown>, ["version", "operationId", "entries"]) ||
    (manifest as BackupManifest).version !== 1 ||
    (manifest as BackupManifest).operationId !== basename(dirname(dirname(manifestPath))) ||
    !Array.isArray((manifest as BackupManifest).entries) ||
    !(manifest as BackupManifest).entries.every((entry) => isValidBackupManifestEntry(entry))
  ) {
    throw new TransactionError("rollback-failed", "The backup manifest is invalid.");
  }
  return manifest as BackupManifest;
}

function isValidBackupManifestEntry(value: unknown): value is BackupManifestEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(entry, ["kind", "path", "backupPath", "existed", "sha256", "mode", "sourceVersion"]) ||
    (entry.kind !== "config" && entry.kind !== "sqlite" && entry.kind !== "rollout") ||
    typeof entry.path !== "string" ||
    !isAbsolute(entry.path) ||
    typeof entry.existed !== "boolean" ||
    !isValidByteTargetVersion(entry.sourceVersion)
  ) {
    return false;
  }
  if (!entry.existed) {
    return (
      entry.backupPath === undefined &&
      entry.sha256 === undefined &&
      entry.mode === undefined &&
      entry.sourceVersion.existed === false
    );
  }
  return (
    typeof entry.backupPath === "string" &&
    isSha256(entry.sha256) &&
    isValidPermissionMode(entry.mode) &&
    entry.sourceVersion.existed === true
  );
}

function isValidPermissionMode(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0o777;
}

interface TrustedRestoreParent {
  readonly logicalPath: string;
  readonly operationalPath: string;
  readonly stats: BigIntStats;
  readonly realPath: string;
  readonly handle?: FileHandle;
}

async function restoreFileAtomically(
  layout: CodexLayout,
  source: ValidatedByteRestoreTarget,
  destination: string,
  expectedVersion: ByteTargetVersion | undefined,
  io?: TransactionIo,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  if (!source.backupPath || !source.backupHandle || !source.backupStats) {
    throw new TransactionError("rollback-failed", "The backup manifest is incomplete.");
  }
  const mode = source.entry.mode;
  if (!isValidPermissionMode(mode)) {
    throw new TransactionError("rollback-failed", "The backup manifest is incomplete.");
  }
  let parent: TrustedRestoreParent | undefined;
  let temporary: string | undefined;
  let temporaryHandle: FileHandle | undefined;
  let primaryError: unknown;
  try {
    parent = await openTrustedRestoreParent(
      layout,
      destination,
      source.entry.kind,
      fileIdentityOptions,
    );
    await io?.beforeRestoreTemporaryCreate?.(destination);
    await assertTrustedRestoreParent(parent, fileIdentityOptions);
    temporary = join(
      parent.operationalPath,
      `.${basename(destination)}.restore-${randomUUID()}`,
    );
    temporaryHandle = await open(temporary, "wx", mode);
    await (io?.copyTemporary ?? copyOpenedFile)(source.backupHandle, temporaryHandle);
    await assertVerifiedRestoreBackup(
      source.backupPath,
      source.backupHandle,
      source.backupStats,
      undefined,
      fileIdentityOptions,
    );
    await temporaryHandle.chmod(mode);
    const handleToSync = temporaryHandle;
    temporaryHandle = undefined;
    await syncAndCloseRestoreTemporary(handleToSync, io);
    await assertVerifiedRestoreBackup(
      source.backupPath,
      source.backupHandle,
      source.backupStats,
      undefined,
      fileIdentityOptions,
    );
    await assertTrustedRestoreParent(parent, fileIdentityOptions);
    if (expectedVersion) {
      await assertByteTargetVersion(
        layout,
        { kind: source.entry.kind, path: destination } as ByteBackedJournalTarget,
        expectedVersion,
        io,
        fileIdentityOptions,
      );
    }
    await rename(temporary, join(parent.operationalPath, basename(destination)));
    await assertTrustedRestoreParent(parent, fileIdentityOptions);
    await syncTrustedRestoreParent(parent, io);
  } catch (error: unknown) {
    primaryError = error;
  }
  if (temporaryHandle) {
    const handleToClose = temporaryHandle;
    temporaryHandle = undefined;
    try {
      await closeRestoreTemporary(handleToClose, io);
    } catch (closeError: unknown) {
      primaryError = primaryError === undefined
        ? closeError
        : new AggregateError(
            [primaryError, closeError],
            "Restore copy and temporary handle close both failed.",
      );
    }
  }
  if (primaryError !== undefined && temporary !== undefined) {
    try {
      await (io?.removeTemporary ?? unlink)(temporary);
    } catch (cleanupError: unknown) {
      if (!isMissingFileError(cleanupError)) {
        primaryError = new AggregateError(
          [primaryError, cleanupError],
          "Restore operation and temporary cleanup both failed.",
        );
      }
    }
  }
  if (parent?.handle) {
    try {
      await parent.handle.close();
    } catch (closeError: unknown) {
      primaryError = primaryError === undefined
        ? closeError
        : new AggregateError(
            [primaryError, closeError],
            "Restore operation and parent directory close both failed.",
          );
    }
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
}

async function removeRestoreTargetIfPresent(
  layout: CodexLayout,
  destination: string,
  kind: BackupKind,
  expectedVersion: ByteTargetVersion | undefined,
  io?: TransactionIo,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  const parent = await openTrustedRestoreParent(layout, destination, kind, fileIdentityOptions);
  let primaryError: unknown;
  try {
    await assertTrustedRestoreParent(parent, fileIdentityOptions);
    if (expectedVersion) {
      await assertByteTargetVersion(
        layout,
        { kind, path: destination },
        expectedVersion,
        io,
        fileIdentityOptions,
      );
    }
        await removeRestoreTargetFile(
          join(parent.operationalPath, basename(destination)),
          fileIdentityOptions,
        );
    await assertTrustedRestoreParent(parent, fileIdentityOptions);
    await syncTrustedRestoreParent(parent, io);
  } catch (error: unknown) {
    primaryError = error;
  }
  if (parent.handle) {
    try {
      await parent.handle.close();
    } catch (closeError: unknown) {
      primaryError = primaryError === undefined
        ? closeError
        : new AggregateError(
            [primaryError, closeError],
            "Restore deletion and parent directory close both failed.",
          );
    }
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
}

async function openTrustedRestoreParent(
  layout: CodexLayout,
  destination: string,
  kind: BackupKind,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<TrustedRestoreParent> {
  const resolvedDestination = resolve(destination);
  assertAllowedBackupTarget(layout, kind, resolvedDestination);
  const logicalPath = dirname(resolvedDestination);
  const inspected = await inspectTrustedRestoreParent(logicalPath, fileIdentityOptions);
  if ((fileIdentityOptions?.platform ?? process.platform) !== "linux") {
    return {
      logicalPath,
      operationalPath: logicalPath,
      ...inspected,
    };
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(
      logicalPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const handleStats = await statWithTransactionIdentity(handle, logicalPath, fileIdentityOptions);
    if (
      !isSafeRestoreParentStats(handleStats, fileIdentityOptions?.platform) ||
      !hasSameBigIntFileIdentity(inspected.stats, handleStats, fileIdentityOptions?.platform)
    ) {
      throw new TransactionError("rollback-failed", "The restore target parent changed after validation.");
    }
    return {
      logicalPath,
      operationalPath: `/proc/self/fd/${String(handle.fd)}`,
      ...inspected,
      handle,
    };
  } catch (error: unknown) {
    await closeFileHandleQuietly(handle);
    if (error instanceof TransactionError) {
      throw error;
    }
    throw new TransactionError("rollback-failed", "The restore target parent is not safe.", {
      cause: error,
    });
  }
}

async function assertTrustedRestoreParent(
  parent: TrustedRestoreParent,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  const current = await inspectTrustedRestoreParent(parent.logicalPath, fileIdentityOptions);
  if (
    !hasSameBigIntFileIdentity(parent.stats, current.stats, fileIdentityOptions?.platform) ||
    !sameResolvedPath(parent.realPath, current.realPath)
  ) {
    throw new TransactionError("rollback-failed", "The restore target parent changed after validation.");
  }
  if (parent.handle) {
    const handleStats = await statWithTransactionIdentity(
      parent.handle,
      parent.logicalPath,
      fileIdentityOptions,
    );
    if (
      !isSafeRestoreParentStats(handleStats, fileIdentityOptions?.platform) ||
      !hasSameBigIntFileIdentity(parent.stats, handleStats, fileIdentityOptions?.platform)
    ) {
      throw new TransactionError("rollback-failed", "The restore target parent changed after validation.");
    }
  }
}

async function inspectTrustedRestoreParent(
  logicalPath: string,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<Pick<TrustedRestoreParent, "stats" | "realPath">> {
  const before = await lstatWithTransactionIdentity(logicalPath, fileIdentityOptions);
  if (!isSafeRestoreParentStats(before, fileIdentityOptions?.platform)) {
    throw new TransactionError("rollback-failed", "The restore target parent is not a real directory.");
  }
  const realPath = await realpath(logicalPath);
  const after = await lstatWithTransactionIdentity(logicalPath, fileIdentityOptions);
  if (
    !isSafeRestoreParentStats(after, fileIdentityOptions?.platform) ||
    !hasSameBigIntFileIdentity(before, after, fileIdentityOptions?.platform) ||
    !sameResolvedPath(realPath, logicalPath)
  ) {
    throw new TransactionError("rollback-failed", "The restore target parent is indirect or changed.");
  }
  return { stats: after, realPath };
}

function isSafeRestoreParentStats(
  stats: BigIntStats,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink() &&
    hasComparableFileIdentity(stats as FileIdentity, platform);
}

async function syncTrustedRestoreParent(
  parent: TrustedRestoreParent,
  io?: TransactionIo,
): Promise<void> {
  if (io?.syncDirectory) {
    await io.syncDirectory(parent.logicalPath);
    return;
  }
  if (parent.handle) {
    await parent.handle.sync();
    return;
  }
  await syncPublishedParentDirectory(join(parent.logicalPath, ".restore-parent"), io);
}

async function openVerifiedRestoreBackup(
  path: string,
  expectedHash: string,
  io?: TransactionIo,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<{ handle: FileHandle; stats: BigIntStats }> {
  let handle: FileHandle | undefined;
  try {
    const pathStats = await lstatWithTransactionIdentity(path, fileIdentityOptions);
    assertSafeRestoreBackupStats(pathStats, fileIdentityOptions?.platform);
    handle = await open(path, "r");
    const openedStats = await statWithTransactionIdentity(handle, path, fileIdentityOptions);
    await assertVerifiedRestoreBackup(
      path,
      handle,
      pathStats,
      openedStats,
      fileIdentityOptions,
    );
    if ((await hashOpenedFile(handle, io)) !== expectedHash) {
      throw new TransactionError(
        "rollback-failed",
        "The backup manifest hash does not match its backup data.",
      );
    }
    const verifiedStats = await statWithTransactionIdentity(handle, path, fileIdentityOptions);
    await assertVerifiedRestoreBackup(
      path,
      handle,
      openedStats,
      verifiedStats,
      fileIdentityOptions,
    );
    return { handle, stats: verifiedStats };
  } catch (error: unknown) {
    await closeFileHandleQuietly(handle);
    if (error instanceof TransactionError) {
      throw error;
    }
    throw new TransactionError(
      "rollback-failed",
      "The backup manifest contains an unsafe backup file.",
      { cause: error },
    );
  }
}

async function assertVerifiedRestoreBackup(
  path: string,
  handle: FileHandle,
  expectedStats: BigIntStats,
  actualStats?: BigIntStats,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  const handleStats = actualStats ?? await statWithTransactionIdentity(
    handle,
    path,
    fileIdentityOptions,
  );
  if (
    !isSafeRestoreBackupStats(handleStats, fileIdentityOptions?.platform) ||
    !hasSameBigIntFileIdentity(expectedStats, handleStats, fileIdentityOptions?.platform) ||
    expectedStats.nlink !== handleStats.nlink ||
    expectedStats.size !== handleStats.size ||
    expectedStats.mtimeNs !== handleStats.mtimeNs ||
    expectedStats.ctimeNs !== handleStats.ctimeNs
  ) {
    throw new TransactionError(
      "rollback-failed",
      "The backup manifest backup file changed after validation.",
    );
  }
  const pathStats = await lstatWithTransactionIdentity(path, fileIdentityOptions);
  if (
    !isSafeRestoreBackupStats(pathStats, fileIdentityOptions?.platform) ||
    !hasSameBigIntFileIdentity(handleStats, pathStats, fileIdentityOptions?.platform) ||
    handleStats.nlink !== pathStats.nlink ||
    handleStats.size !== pathStats.size ||
    handleStats.mtimeNs !== pathStats.mtimeNs ||
    handleStats.ctimeNs !== pathStats.ctimeNs
  ) {
    throw new TransactionError(
      "rollback-failed",
      "The backup manifest backup path changed after validation.",
    );
  }
  if (!sameResolvedPath(await realpath(path), path)) {
    throw new TransactionError(
      "rollback-failed",
      "The backup manifest backup path is indirect.",
    );
  }
}

function assertSafeRestoreBackupStats(
  stats: BigIntStats,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!isSafeRestoreBackupStats(stats, platform)) {
    throw new TransactionError(
      "rollback-failed",
      "The backup manifest contains a non-regular backup file.",
    );
  }
}

function isSafeRestoreBackupStats(
  stats: BigIntStats,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n &&
    hasComparableFileIdentity(stats as FileIdentity, platform);
}

async function copyOpenedFile(source: FileHandle, destination: FileHandle): Promise<void> {
  const chunk = Buffer.alloc(backupCopyChunkSize);
  let offset = 0;
  while (true) {
    const { bytesRead } = await source.read(chunk, 0, chunk.length, offset);
    if (bytesRead === 0) {
      return;
    }
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(
        chunk,
        written,
        bytesRead - written,
        offset + written,
      );
      if (result.bytesWritten < 1) {
        throw new Error("Restore write returned zero bytes.");
      }
      written += result.bytesWritten;
    }
    offset += bytesRead;
  }
}

async function syncAndCloseRestoreTemporary(
  handle: FileHandle,
  io?: TransactionIo,
): Promise<void> {
  let failed = false;
  let primaryError: unknown;
  try {
    await (io?.syncFileHandle ?? defaultSyncHandle)(handle);
  } catch (error: unknown) {
    failed = true;
    primaryError = error;
  }
  try {
    await (io?.closeFileHandle ?? defaultCloseHandle)(handle);
  } catch (closeError: unknown) {
    primaryError = failed
      ? new AggregateError(
          [primaryError, closeError],
          "Restore temporary sync and handle close both failed.",
        )
      : closeError;
    failed = true;
  }
  if (failed) {
    throw primaryError;
  }
}

async function closeRestoreTemporary(handle: FileHandle, io?: TransactionIo): Promise<void> {
  await (io?.closeFileHandle ?? defaultCloseHandle)(handle);
}

async function closeValidatedBackupTargets(
  targets: readonly ValidatedByteRestoreTarget[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const target of targets) {
    if (!target.backupHandle) {
      continue;
    }
    try {
      await target.backupHandle.close();
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Validated backup handle close failures.");
  }
}

async function rethrowAfterValidatedBackupClose(
  targets: readonly ValidatedByteRestoreTarget[],
  primaryError: unknown,
): Promise<never> {
  try {
    await closeValidatedBackupTargets(targets);
  } catch (closeError: unknown) {
    throw new AggregateError(
      [primaryError, closeError],
      "Backup validation and handle close both failed.",
    );
  }
  throw primaryError;
}

function assertAllowedBackupTarget(
  layout: CodexLayout,
  kind: BackupKind,
  path: string,
): void {
  const configPath = resolve(layout.configPath);
  const sqlitePath = resolve(layout.sqlitePath);
  if (kind === "config" && path === configPath) {
    return;
  }
  if (kind === "sqlite" && path === sqlitePath) {
    return;
  }
  if (kind === "rollout" && isInsideRolloutDirectory(layout, path)) {
    return;
  }
  throw new TransactionError(
    "invalid-backup-target",
    "The backup target is not allowed outside managed configuration, state database, or rollout files.",
  );
}

function isInsideRolloutDirectory(layout: CodexLayout, path: string): boolean {
  if (!path.toLowerCase().endsWith(".jsonl")) {
    return false;
  }
  return [layout.sessionsDir, layout.archivedSessionsDir].some((root) => {
    const relativePath = relative(resolve(root), path);
    return relativePath !== "" && !relativePath.startsWith("..") && !relativePath.includes("..\\") && !relativePath.includes("../");
  });
}

function isInsideDirectory(directory: string, path: string): boolean {
  const relativePath = relative(resolve(directory), resolve(path));
  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !relativePath.includes("..\\") &&
    !relativePath.includes("../")
  );
}

function normalizeJournalTargets(
  layout: CodexLayout,
  targets: readonly (JournalMutationTarget | string)[],
): JournalMutationTarget[] {
  return targets.map((target) => normalizeJournalTarget(layout, target));
}

function normalizeJournalTarget(
  layout: CodexLayout,
  target: JournalMutationTarget | string,
): JournalMutationTarget {
    if (typeof target === "string") {
      const path = resolve(target);
      const kind: "config" | "sqlite" | "rollout" =
        path === resolve(layout.configPath)
          ? "config"
          : path === resolve(layout.sqlitePath)
            ? "sqlite"
            : "rollout";
      if (kind === "rollout") {
        throw new TransactionError(
          "invalid-backup-target",
          "Rollout mutations require a metadata-only inverse patch.",
        );
      }
      assertAllowedBackupTarget(layout, kind, path);
      return { kind, path };
    }
    if (target.kind === "auth") {
      return normalizeAuthJournalTarget(layout, target);
    }
    const path = resolve(target.path);
    if (target.kind === "rollout") {
      const sessionId = normalizeRolloutSessionId(target.inversePatch, path);
      const inversePatch = {
        ...target.inversePatch,
        path,
        sessionId,
      };
      if (
        !isInsideRolloutDirectory(layout, path) ||
        resolve(target.inversePatch.path) !== path ||
        !isValidInversePatchMetadata(inversePatch)
      ) {
        throw new TransactionError("journal-invalid", "The rollout inverse patch is invalid.");
      }
      return { kind: "rollout", path, inversePatch };
    }
    assertAllowedBackupTarget(layout, target.kind, path);
    return { kind: target.kind, path };
}

export function assertValidJournalMutationTarget(
  layout: CodexLayout,
  target: unknown,
): asserts target is JournalMutationTarget {
  if (!isValidJournalTarget(target)) {
    throw new TransactionError("journal-invalid", "The mutation target is invalid.");
  }
  try {
    normalizeJournalTarget(layout, target);
  } catch (error: unknown) {
    if (error instanceof TransactionError) {
      throw error;
    }
    throw new TransactionError("journal-invalid", "The mutation target is invalid.", { cause: error });
  }
}

function normalizeAuthJournalTarget(layout: CodexLayout, value: unknown): AuthJournalTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TransactionError("journal-invalid", "The auth journal target is invalid.");
  }
  const target = value as Record<string, unknown>;
  const canonical = hasOnlyKeys(target, ["kind", "path", "previousMode", "customProfileId"]);
  const path = target.path;
  const previousMode = canonical ? target.previousMode : undefined;
  const customProfileId = canonical ? target.customProfileId : undefined;
  if (
    target.kind !== "auth" ||
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path !== resolve(layout.authPath)
  ) {
    throw new TransactionError("journal-invalid", "The auth journal target is invalid.");
  }
  if (previousMode === "custom") {
    if (!isStoredProfileId(customProfileId)) {
      throw new TransactionError("journal-invalid", "The auth journal target is invalid.");
    }
    return { kind: "auth", path, previousMode, customProfileId };
  }
  if (previousMode !== "official" || customProfileId !== undefined) {
    throw new TransactionError("journal-invalid", "The auth journal target is invalid.");
  }
  return { kind: "auth", path, previousMode };
}

function normalizeRolloutSessionId(value: unknown, path: string): string {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, "sessionId")) {
    throw new TransactionError("journal-invalid", "The rollout inverse patch is invalid.");
  }
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  if (!isNormalizedSessionId(sessionId)) {
    throw new TransactionError("journal-invalid", "The rollout inverse patch is invalid.");
  }
  return sessionId;
}

function journalTargetsMatch(
  left: JournalMutationTarget,
  right: JournalMutationTarget,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isValidInversePatchMetadata(value: unknown): value is RolloutInversePatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const patch = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(patch, ["version", "path", "sessionId", "preHash", "postHash", "replacements"]) ||
    patch.version !== 1 ||
    typeof patch.path !== "string" ||
    !Object.hasOwn(patch, "sessionId") ||
    !isNormalizedSessionId(patch.sessionId) ||
    !isSha256(patch.preHash) ||
    !isSha256(patch.postHash) ||
    !Array.isArray(patch.replacements) ||
    patch.replacements.length === 0
  ) {
    return false;
  }
  return patch.replacements.every((replacement) => isValidInverseReplacement(replacement));
}

function isValidInverseReplacement(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const replacement = value as Record<string, unknown>;
  return (
    hasOnlyKeys(replacement, ["line", "start", "end", "expectedValue", "value"]) &&
    Number.isSafeInteger(replacement.line) &&
    (replacement.line as number) >= 0 &&
    Number.isSafeInteger(replacement.start) &&
    (replacement.start as number) >= 0 &&
    Number.isSafeInteger(replacement.end) &&
    (replacement.end as number) > (replacement.start as number) &&
    isProviderMetadataToken(replacement.expectedValue) &&
    isProviderMetadataToken(replacement.value)
  );
}

function isProviderMetadataToken(value: unknown): boolean {
  if (value === "null") {
    return true;
  }
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(parsed);
  } catch {
    return false;
  }
}

function isNormalizedOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._-]+$/.test(value);
}

function isStoredProfileId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isNormalizedSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._-]+$/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

async function appendJournal(
  path: string,
  entry: JournalEntry,
  operationDirectory: TrustedTransactionDirectory,
  io?: TransactionIo,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  await assertTrustedTransactionDirectory(operationDirectory, fileIdentityOptions);
  if (path !== join(operationDirectory.path, journalFileName)) {
    throw new TransactionError("journal-invalid", "The transaction journal is outside its operation directory.");
  }
  const existing = await readJournalSnapshot(path, io, fileIdentityOptions);
  const record = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
  const snapshot = Buffer.concat([existing, record]);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.journal-${randomUUID()}`,
  );
  try {
    await writeJournalSnapshot(temporary, snapshot, io);
    await assertTrustedTransactionDirectory(operationDirectory, fileIdentityOptions);
    await assertJournalTemporaryHasNoHardLinks(temporary);
    await (io?.renameJournal ?? rename)(temporary, path);
    try {
      await syncPublishedParentDirectory(path, io);
    } catch (error: unknown) {
      throw new JournalDirectorySyncError(
        entry.state,
          await classifyPublishedJournalSnapshot(
            path,
            snapshot,
            operationDirectory,
            fileIdentityOptions,
          ),
        error,
      );
    }
    await assertTrustedTransactionDirectory(operationDirectory, fileIdentityOptions);
  } catch (error: unknown) {
    await rethrowAfterJournalTemporaryCleanup(
      temporary,
      operationDirectory,
      error,
      io?.removeJournalTemporary,
      fileIdentityOptions,
    );
  }
}

async function classifyPublishedJournalSnapshot(
  path: string,
  expected: Buffer,
  operationDirectory: TrustedTransactionDirectory,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<JournalSnapshotClassification> {
  try {
    await assertTrustedTransactionDirectory(operationDirectory, fileIdentityOptions);
    const current = await readJournalFile(path, undefined, fileIdentityOptions);
    parseJournalEntries(current.toString("utf8"), path);
    await assertTrustedTransactionDirectory(operationDirectory, fileIdentityOptions);
    return current.equals(expected) ? "expected" : "different";
  } catch {
    return "unverifiable";
  }
}

async function rethrowAfterJournalTemporaryCleanup(
  path: string,
  operationDirectory: TrustedTransactionDirectory,
  primaryError: unknown,
  remove?: (path: string) => Promise<void>,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<never> {
  try {
    await assertTrustedTransactionDirectory(operationDirectory, fileIdentityOptions);
  } catch (cleanupSafetyError: unknown) {
    const reclassified = reclassifyJournalDirectorySyncError(
      primaryError,
      "unverifiable",
      cleanupSafetyError,
    );
    if (reclassified !== primaryError) {
      throw reclassified;
    }
    if (cleanupSafetyError instanceof TransactionError) {
      throw primaryError;
    }
    throw new AggregateError(
      [primaryError, cleanupSafetyError],
      "Journal temporary operation and cleanup safety check both failed.",
    );
  }
  return rethrowAfterTemporaryCleanup(path, primaryError, remove);
}

function findJournalDirectorySyncError(error: unknown): JournalDirectorySyncError | undefined {
  const visited = new Set<unknown>();
  const visit = (candidate: unknown): JournalDirectorySyncError | undefined => {
    if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) {
      return undefined;
    }
    if (visited.has(candidate)) {
      return undefined;
    }
    visited.add(candidate);
    if (candidate instanceof JournalDirectorySyncError) {
      return candidate;
    }
    if (candidate instanceof AggregateError) {
      for (const nested of candidate.errors) {
        const found = visit(nested);
        if (found) {
          return found;
        }
      }
    }
    if (candidate instanceof Error && "cause" in candidate) {
      return visit(candidate.cause);
    }
    return undefined;
  };
  return visit(error);
}

function reclassifyJournalDirectorySyncError(
  error: unknown,
  classification: JournalSnapshotClassification,
  secondaryError: unknown,
): unknown {
  const directorySyncError = findJournalDirectorySyncError(error);
  if (!directorySyncError) {
    return error;
  }
  return new JournalDirectorySyncError(
    directorySyncError.publishedState,
    classification,
    new AggregateError(
      [error, secondaryError],
      "Journal durability and cleanup safety both failed.",
    ),
  );
}

async function assertJournalTemporaryHasNoHardLinks(
  path: string,
): Promise<void> {
  const stats = await lstat(path);
  if (!isRegularNonLinkFile(stats) || hasMultipleHardLinks(stats)) {
    throw new TransactionError("journal-invalid", "The journal temporary is not a private regular file.");
  }
}

async function writeJournalSnapshot(
  path: string,
  contents: Buffer,
  io?: TransactionIo,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  let failed = false;
  let primaryError: unknown;
  try {
    await writeAll(handle, contents, io?.write);
    await (io?.syncJournal ?? defaultSyncHandle)(handle);
  } catch (error: unknown) {
    failed = true;
    primaryError = error;
  }
  try {
    await (io?.closeJournal ?? defaultCloseHandle)(handle);
  } catch (closeError: unknown) {
    primaryError = failed
      ? new AggregateError(
          [primaryError, closeError],
          "Journal snapshot write and handle close both failed.",
        )
      : closeError;
    failed = true;
  }
  if (failed) {
    throw primaryError;
  }
}

async function readJournalSnapshot(
  path: string,
  io?: TransactionIo,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<Buffer> {
  try {
    const contents = await readJournalFile(
      path,
      io?.afterJournalPathValidated,
      fileIdentityOptions,
    );
    if (contents.length > 0) {
      parseJournalEntries(contents.toString("utf8"), path);
    }
    return contents;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return Buffer.alloc(0);
    }
    if (error instanceof TransactionError) {
      throw error;
    }
    throw new TransactionError("journal-invalid", "The transaction journal is invalid.", {
      cause: error,
    });
  }
}

async function writeAll(
  handle: FileHandle,
  buffer: Buffer,
  write: NonNullable<TransactionIo["write"]> = async (
    target,
    contents,
    offset,
    length,
  ) => (await target.write(contents, offset, length, null)).bytesWritten,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const bytesWritten = await write(handle, buffer, offset, buffer.length - offset);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > buffer.length - offset) {
      throw new Error("Journal write returned zero bytes or an invalid byte count.");
    }
    offset += bytesWritten;
  }
}

async function readJournal(
  path: string,
  io?: TransactionIo,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<JournalEntry[]> {
  try {
    return parseJournalEntries(
      (
        await readJournalFile(
          path,
          io?.afterJournalPathValidated,
          fileIdentityOptions,
        )
      ).toString("utf8"),
      path,
    );
  } catch (error: unknown) {
    if (error instanceof TransactionError) {
      throw error;
    }
    throw new TransactionError("journal-invalid", "The transaction journal is invalid.", {
      cause: error,
    });
  }
}

async function readJournalFile(
  path: string,
  afterPathValidated?: (path: string) => void | Promise<void>,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<Buffer> {
  return readVerifiedMetadataFile(
    path,
    "journal-invalid",
    "The transaction journal is not a regular file.",
    afterPathValidated,
    fileIdentityOptions,
  );
}

async function readVerifiedMetadataFile(
  path: string,
  code: "journal-invalid" | "rollback-failed",
  unsafeMessage: string,
  afterPathValidated?: (path: string) => void | Promise<void>,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<Buffer> {
  let handle: FileHandle | undefined;
  let contents: Buffer | undefined;
  let primaryError: unknown;
  try {
    const pathStats = await lstatWithTransactionIdentity(path, fileIdentityOptions);
    if (!isSafeMetadataStats(pathStats, fileIdentityOptions?.platform)) {
      throw new TransactionError(code, unsafeMessage);
    }
    await afterPathValidated?.(path);
    handle = await open(path, "r");
    const openedStats = await statWithTransactionIdentity(handle, path, fileIdentityOptions);
    if (
      !isSafeMetadataStats(openedStats, fileIdentityOptions?.platform) ||
      !hasSameBigIntFileIdentity(pathStats, openedStats, fileIdentityOptions?.platform)
    ) {
      throw new TransactionError(code, unsafeMessage);
    }
    contents = await handle.readFile();
    const finalStats = await statWithTransactionIdentity(handle, path, fileIdentityOptions);
    if (
      !isSafeMetadataStats(finalStats, fileIdentityOptions?.platform) ||
      !hasSameBigIntFileIdentity(openedStats, finalStats, fileIdentityOptions?.platform)
    ) {
      throw new TransactionError(code, unsafeMessage);
    }
  } catch (error: unknown) {
    primaryError = error;
  }
  if (handle) {
    try {
      await handle.close();
    } catch (closeError: unknown) {
      primaryError = primaryError === undefined
        ? closeError
        : new AggregateError(
            [primaryError, closeError],
            "Metadata read and file handle close both failed.",
          );
    }
  }
  if (primaryError !== undefined) {
    if (isMissingFileError(primaryError) || primaryError instanceof TransactionError) {
      throw primaryError;
    }
    throw new TransactionError(code, unsafeMessage, { cause: primaryError });
  }
  return contents!;
}

function isSafeMetadataStats(
  stats: BigIntStats,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n &&
    hasComparableFileIdentity(stats as FileIdentity, platform);
}

function parseJournalEntries(contents: string, path: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const entry = JSON.parse(line) as unknown;
    if (!isValidJournalEntry(entry)) {
      throw new TransactionError("journal-invalid", "The transaction journal is invalid.");
    }
    entries.push(entry);
  }
  validateJournalProtocol(entries, basename(dirname(path)));
  return entries;
}

function isValidJournalEntry(value: unknown): value is JournalEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    hasOnlyKeys(entry, [
      "version",
      "operationId",
      "state",
      "timestamp",
      "sourceVersionProtocol",
      "pendingTargets",
      "appliedTargets",
      "appliedTargetVersions",
    ]) &&
    entry.version === 1 &&
    typeof entry.operationId === "string" &&
    isTransactionState(entry.state) &&
    typeof entry.timestamp === "string" &&
    (entry.sourceVersionProtocol === undefined || entry.sourceVersionProtocol === true) &&
    (entry.pendingTargets === undefined || isValidJournalTargetList(entry.pendingTargets)) &&
    (entry.appliedTargets === undefined || isValidJournalTargetList(entry.appliedTargets)) &&
    (entry.appliedTargetVersions === undefined ||
      isValidAppliedTargetVersionList(entry.appliedTargetVersions))
  );
}

function validateJournalProtocol(
  entries: readonly JournalEntry[],
  directoryOperationId: string,
): void {
  if (
    entries.length === 0 ||
    !isNormalizedOperationId(directoryOperationId) ||
    entries[0].state !== "prepared"
  ) {
    throw new TransactionError("journal-invalid", "The transaction journal is invalid.");
  }

  const pendingTargets: JournalMutationTarget[] = [];
  let applying = false;
  let terminalState: Extract<TransactionState, "committed" | "rolledBack" | "recoveryRequired"> | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.operationId !== directoryOperationId) {
      throw new TransactionError("journal-invalid", "The transaction journal is invalid.");
    }
    if (
      entry.sourceVersionProtocol !== undefined &&
      (index !== 0 || entry.state !== "prepared" || entry.sourceVersionProtocol !== true)
    ) {
      throw new TransactionError("journal-invalid", "The transaction journal is invalid.");
    }
    if (terminalState !== undefined) {
      if (terminalState !== "rolledBack" || entry.state !== "recoveryRequired") {
        throw new TransactionError("journal-invalid", "The transaction journal is invalid.");
      }
      terminalState = "recoveryRequired";
      continue;
    }
    if (entry.state === "prepared") {
      if (
        index !== 0 ||
        entry.pendingTargets !== undefined ||
        entry.appliedTargets !== undefined ||
        entry.appliedTargetVersions !== undefined
      ) {
        throw new TransactionError("journal-invalid", "The transaction journal is invalid.");
      }
      continue;
    }
    if (entry.state === "applying") {
      applying = true;
      for (const target of entry.appliedTargets ?? []) {
        if (!pendingTargets.some((candidate) => journalTargetsMatch(candidate, target))) {
          throw new TransactionError("journal-invalid", "The transaction journal is invalid.");
        }
      }
      for (const version of entry.appliedTargetVersions ?? []) {
        if (
          !entry.appliedTargets?.some((target) =>
          target.kind === "config" ||
          target.kind === "sqlite" ||
          target.kind === "rollout" ||
          target.kind === "auth"
              ? journalTargetsMatch(target, version.target)
              : false,
          )
        ) {
          throw new TransactionError("journal-invalid", "The transaction journal is invalid.");
        }
      }
      pendingTargets.push(...(entry.pendingTargets ?? []));
      continue;
    }
    if (
      entry.pendingTargets !== undefined ||
      entry.appliedTargets !== undefined ||
      entry.appliedTargetVersions !== undefined ||
      (entry.state === "committed" && !applying)
    ) {
      throw new TransactionError("journal-invalid", "The transaction journal is invalid.");
    }
    terminalState = entry.state;
  }
}

function normalizeJournalRecoveryTargets(
  layout: CodexLayout,
  journal: readonly JournalEntry[],
): JournalMutationTarget[] {
  const targets: JournalMutationTarget[] = [];
  try {
    for (const entry of journal) {
      for (const target of entry.pendingTargets ?? []) {
        const normalized = normalizeJournalTarget(layout, target);
        if (!targets.some((candidate) => journalTargetsMatch(candidate, normalized))) {
          targets.push(normalized);
        }
      }
      for (const target of entry.appliedTargets ?? []) {
        normalizeJournalTarget(layout, target);
      }
    }
  } catch (error: unknown) {
    throw new TransactionError("journal-invalid", "The transaction journal is invalid.", {
      cause: error,
    });
  }
  return targets;
}

function normalizeJournalRecoveryTargetVersions(
  layout: CodexLayout,
  journal: readonly JournalEntry[],
): AppliedByteTargetVersion[] {
  const versions: AppliedByteTargetVersion[] = [];
  try {
    for (const entry of journal) {
      for (const version of entry.appliedTargetVersions ?? []) {
        const target = normalizeJournalTarget(layout, version.target);
        if (
          target.kind !== "config" &&
          target.kind !== "sqlite" &&
          target.kind !== "rollout" &&
          target.kind !== "auth"
        ) {
          throw new Error("Applied target version is invalid.");
        }
        versions.push({ target, version: version.version });
      }
    }
  } catch (error: unknown) {
    throw new TransactionError("journal-invalid", "The transaction journal is invalid.", {
      cause: error,
    });
  }
  return versions;
}

function isValidJournalTargetList(value: unknown): value is JournalMutationTarget[] {
  return Array.isArray(value) && value.every((target) => isValidJournalTarget(target));
}

function isValidAppliedTargetVersionList(
  value: unknown,
): value is AppliedByteTargetVersion[] {
  return Array.isArray(value) && value.every(isValidAppliedTargetVersion);
}

function isValidAppliedTargetVersion(value: unknown): value is AppliedByteTargetVersion {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const version = value as Record<string, unknown>;
  return (
    hasOnlyKeys(version, ["target", "version"]) &&
    isValidJournalTarget(version.target) &&
    isValidByteTargetVersion(version.version)
  );
}

function isValidByteTargetVersion(value: unknown): value is ByteTargetVersion {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const version = value as Record<string, unknown>;
  if (!hasOnlyKeys(version, [
    "existed",
    "sha256",
    "mode",
    "device",
    "inode",
    "links",
    "volumeSerial",
    "fileId",
    "size",
    "modifiedAtNs",
    "changedAtNs",
  ]) || typeof version.existed !== "boolean") {
    return false;
  }
  if (!version.existed) {
    return (
      version.sha256 === undefined &&
      version.mode === undefined &&
      version.device === undefined &&
      version.inode === undefined &&
      version.links === undefined &&
      version.size === undefined &&
      version.modifiedAtNs === undefined &&
      version.changedAtNs === undefined &&
      version.volumeSerial === undefined &&
      version.fileId === undefined
    );
  }
  return (
    isSha256(version.sha256) &&
    isValidPermissionMode(version.mode) &&
    typeof version.device === "string" &&
    /^[0-9]+$/.test(version.device) &&
    typeof version.inode === "string" &&
    ((/^[1-9][0-9]*$/.test(version.inode) &&
      version.volumeSerial === undefined &&
      version.fileId === undefined) ||
      (version.inode === "0" &&
        version.links === "1" &&
        typeof version.volumeSerial === "string" &&
        /^[0-9a-f]{16}$/u.test(version.volumeSerial) &&
        typeof version.fileId === "string" &&
        /^[0-9a-f]{32}$/u.test(version.fileId))) &&
    typeof version.links === "string" &&
    /^[1-9][0-9]*$/.test(version.links) &&
    typeof version.size === "string" &&
    /^[0-9]+$/.test(version.size) &&
    typeof version.modifiedAtNs === "string" &&
    /^[0-9]+$/.test(version.modifiedAtNs) &&
    typeof version.changedAtNs === "string" &&
    /^[0-9]+$/.test(version.changedAtNs)
  );
}

function isValidJournalTarget(value: unknown): value is JournalMutationTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const target = value as Record<string, unknown>;
  if ((target.kind === "config" || target.kind === "sqlite") && hasOnlyKeys(target, ["kind", "path"])) {
    return typeof target.path === "string" && isAbsolute(target.path);
  }
  if (target.kind === "auth") {
    return (
      hasOnlyKeys(target, ["kind", "path", "previousMode", "customProfileId"]) &&
      typeof target.path === "string" &&
      isAbsolute(target.path) &&
      (
        (target.previousMode === "official" && target.customProfileId === undefined) ||
        (target.previousMode === "custom" && isStoredProfileId(target.customProfileId))
      )
    );
  }
  return (
    target.kind === "rollout" &&
    hasOnlyKeys(target, ["kind", "path", "inversePatch"]) &&
    typeof target.path === "string" &&
    isAbsolute(target.path) &&
    isValidInversePatchMetadata(target.inversePatch)
  );
}

function isTransactionState(value: unknown): value is TransactionState {
  return typeof value === "string" && transactionStates.includes(value as TransactionState);
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
  io?: TransactionIo,
): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const contents = `${JSON.stringify(value, undefined, 2)}\n`;
    if (io?.writeTemporary) {
      await io.writeTemporary(temporary, contents);
    } else {
      await writeFile(temporary, contents, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    await syncFile(temporary, io);
    await rename(temporary, path);
    await syncPublishedParentDirectory(path, io);
  } catch (error: unknown) {
    await rethrowAfterTemporaryCleanup(temporary, error, io?.removeTemporary);
  }
}

async function syncPublishedParentDirectory(
  path: string,
  io?: TransactionIo,
): Promise<void> {
  const directory = dirname(path);
  if (io?.syncDirectory) {
    await io.syncDirectory(directory);
    return;
  }
  if (process.platform === "win32") {
    return;
  }

  const handle = await open(directory, "r");
  let failed = false;
  let primaryError: unknown;
  try {
    await handle.sync();
  } catch (error: unknown) {
    failed = true;
    primaryError = error;
  }
  try {
    await handle.close();
  } catch (closeError: unknown) {
    primaryError = failed
      ? new AggregateError(
          [primaryError, closeError],
          "Directory sync and handle close both failed.",
        )
      : closeError;
    failed = true;
  }
  if (failed) {
    throw primaryError;
  }
}

async function rethrowAfterTemporaryCleanup(
  path: string,
  primaryError: unknown,
  remove: (path: string) => Promise<void> = unlink,
): Promise<never> {
  try {
    await remove(path);
  } catch (cleanupError: unknown) {
    if (!isMissingFileError(cleanupError)) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "Temporary file operation and cleanup both failed.",
      );
    }
  }
  throw primaryError;
}

async function syncFile(path: string, io?: TransactionIo): Promise<void> {
  const handle = await open(path, "r+");
  let failed = false;
  let primaryError: unknown;
  try {
    await (io?.syncFileHandle ?? defaultSyncHandle)(handle);
  } catch (error: unknown) {
    failed = true;
    primaryError = error;
  }
  try {
    await (io?.closeFileHandle ?? defaultCloseHandle)(handle);
  } catch (closeError: unknown) {
    primaryError = failed
      ? new AggregateError(
          [primaryError, closeError],
          "File sync and handle close both failed.",
        )
      : closeError;
    failed = true;
  }
  if (failed) {
    throw primaryError;
  }
}

async function hashFile(path: string, io?: TransactionIo): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  let failed = false;
  let primaryError: unknown;
  try {
    const input = handle.createReadStream({
      autoClose: false,
      ...(io?.hashChunkSize === undefined ? {} : { highWaterMark: io.hashChunkSize }),
    });
    try {
      for await (const chunk of input as AsyncIterable<Buffer>) {
        await io?.readHashChunk?.(chunk);
        hash.update(chunk);
      }
    } catch (error: unknown) {
      failed = true;
      primaryError = error;
    } finally {
      input.destroy();
    }
  } catch (error: unknown) {
    failed = true;
    primaryError = error;
  }
  try {
    await (io?.closeHashHandle ?? defaultCloseHandle)(handle);
  } catch (closeError: unknown) {
    primaryError = failed
      ? new AggregateError(
          [primaryError, closeError],
          "Hash read and handle close both failed.",
        )
      : closeError;
    failed = true;
  }
  if (failed) {
    throw primaryError;
  }
  return hash.digest("hex");
}

async function hashOpenedFile(handle: FileHandle, io?: TransactionIo): Promise<string> {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(io?.hashChunkSize ?? backupCopyChunkSize);
  let offset = 0;
  while (true) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
    if (bytesRead === 0) {
      return hash.digest("hex");
    }
    const contents = chunk.subarray(0, bytesRead);
    await io?.readHashChunk?.(contents);
    hash.update(contents);
    offset += bytesRead;
  }
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function lstatWithTransactionIdentity(
  path: string,
  options?: HydrateWindowsFileIdentityOptions,
): Promise<BigIntStats> {
  return hydrateTransactionFileIdentity(
    path,
    await lstat(path, { bigint: true }),
    options,
  );
}

async function statWithTransactionIdentity(
  handle: FileHandle,
  logicalPath: string,
  options?: HydrateWindowsFileIdentityOptions,
): Promise<BigIntStats> {
  return hydrateTransactionFileIdentity(
    logicalPath,
    await handle.stat({ bigint: true }),
    options,
  );
}

async function hydrateTransactionFileIdentity(
  logicalPath: string,
  stats: BigIntStats,
  options?: HydrateWindowsFileIdentityOptions,
): Promise<BigIntStats> {
  const identity = await hydrateWindowsFileIdentity(logicalPath, stats, options);
  if (identity.windowsFileIdentity === undefined) {
    return stats;
  }

  Object.defineProperty(stats, "windowsFileIdentity", {
    configurable: false,
    enumerable: true,
    value: identity.windowsFileIdentity,
    writable: false,
  });
  return stats;
}

async function lstatBigIntIfPresent(
  path: string,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<BigIntStats | undefined> {
  try {
    return await lstatWithTransactionIdentity(path, fileIdentityOptions);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function assertSafeByteBackupSource(
  layout: CodexLayout,
  path: string,
  sourceStats: BigIntStats,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  const authPath = resolve(layout.authPath);
  if (
    !isSafeOpenedBackupStats(sourceStats, fileIdentityOptions?.platform) ||
    sameResolvedPath(path, authPath)
  ) {
    throw new TransactionError(
      "invalid-backup-target",
      "The backup target must be a regular file distinct from auth.json.",
    );
  }
  const authStats = await lstatBigIntIfPresent(authPath, fileIdentityOptions);
  if (
    (authStats &&
      (!isSafeOpenedBackupStats(authStats, fileIdentityOptions?.platform) ||
        hasSameBigIntFileIdentity(sourceStats, authStats, fileIdentityOptions?.platform)))
  ) {
    throw new TransactionError(
      "invalid-backup-target",
      "The backup target must be a regular file distinct from auth.json.",
    );
  }
}

async function copyBackupSourceSafely(
  layout: CodexLayout,
  sourcePath: string,
  expectedSourceStats: BigIntStats,
  backupPath: string,
  io?: TransactionIo,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<ByteTargetVersion> {
  const temporaryPath = join(
    dirname(backupPath),
    `.${basename(backupPath)}.copy-${randomUUID()}`,
  );
  let sourceHandle: FileHandle | undefined;
  let backupHandle: FileHandle | undefined;
  try {
    sourceHandle = await open(sourcePath, "r");
    const openedStats = await statWithTransactionIdentity(sourceHandle, sourcePath, fileIdentityOptions);
    await assertOpenedBackupSource(
      layout,
      sourcePath,
      expectedSourceStats,
      openedStats,
      fileIdentityOptions,
    );

    backupHandle = await open(temporaryPath, "wx", 0o600);
    const sourceHash = createHash("sha256");
    const chunk = Buffer.alloc(backupCopyChunkSize);
    let sourceOffset = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(
        chunk,
        0,
        chunk.length,
        sourceOffset,
      );
      if (bytesRead === 0) {
        break;
      }
      sourceHash.update(chunk.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await backupHandle.write(
          chunk,
          written,
          bytesRead - written,
          sourceOffset + written,
        );
        if (result.bytesWritten < 1) {
          throw new Error("Backup write returned zero bytes.");
        }
        written += result.bytesWritten;
      }
      sourceOffset += bytesRead;
    }
    await io?.afterBackupSourceRead?.(sourcePath);

    const afterReadStats = await statWithTransactionIdentity(sourceHandle, sourcePath, fileIdentityOptions);
    if (
      !hasSameBigIntFileIdentity(openedStats, afterReadStats, fileIdentityOptions?.platform) ||
      openedStats.nlink !== afterReadStats.nlink ||
      openedStats.mode !== afterReadStats.mode ||
      openedStats.size !== afterReadStats.size ||
      openedStats.mtimeNs !== afterReadStats.mtimeNs ||
      openedStats.ctimeNs !== afterReadStats.ctimeNs
    ) {
      throw new Error("The backup source changed while being read.");
    }
    await assertOpenedBackupSource(
      layout,
      sourcePath,
      openedStats,
      afterReadStats,
      fileIdentityOptions,
    );
    await backupHandle.sync();
    await backupHandle.close();
    backupHandle = undefined;
    await sourceHandle.close();
    sourceHandle = undefined;
    await rename(temporaryPath, backupPath);
    return byteTargetVersion(afterReadStats, sourceHash.digest("hex"));
  } catch {
    await closeFileHandleQuietly(backupHandle);
    await closeFileHandleQuietly(sourceHandle);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new TransactionError(
      "invalid-backup-target",
      "The backup source could not be copied without following a changed path.",
    );
  }
}

async function assertOpenedBackupSource(
  layout: CodexLayout,
  sourcePath: string,
  expectedStats: BigIntStats,
  openedStats: BigIntStats,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  if (
    !isSafeOpenedBackupStats(openedStats, fileIdentityOptions?.platform) ||
    !hasSameBigIntFileIdentity(expectedStats, openedStats, fileIdentityOptions?.platform) ||
    expectedStats.mode !== openedStats.mode
  ) {
    throw new Error("The backup source identity changed.");
  }
  const pathStats = await lstatWithTransactionIdentity(sourcePath, fileIdentityOptions);
  if (
    !isSafeOpenedBackupStats(pathStats, fileIdentityOptions?.platform) ||
    !hasSameBigIntFileIdentity(openedStats, pathStats, fileIdentityOptions?.platform) ||
    openedStats.mode !== pathStats.mode
  ) {
    throw new Error("The backup source path changed.");
  }
  const sourceRealPath = await realpath(sourcePath);
  if (!sameResolvedPath(sourceRealPath, sourcePath)) {
    throw new Error("The backup source path is indirect.");
  }
  const authStats = await lstatBigIntIfPresent(resolve(layout.authPath), fileIdentityOptions);
  if (
    authStats &&
    (!isSafeOpenedBackupStats(authStats, fileIdentityOptions?.platform) ||
      hasSameBigIntFileIdentity(openedStats, authStats, fileIdentityOptions?.platform))
  ) {
    throw new Error("The backup source aliases auth data.");
  }
}

function isSafeOpenedBackupStats(
  stats: BigIntStats,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n &&
    hasComparableFileIdentity(stats as FileIdentity, platform);
}

function hasSameBigIntFileIdentity(
  left: BigIntStats,
  right: BigIntStats,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return hasSameComparableFileIdentity(left, right, platform);
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function closeFileHandleQuietly(handle: FileHandle | undefined): Promise<void> {
  if (!handle) {
    return;
  }
  try {
    await handle.close();
  } catch {
    // The public backup error remains fixed and contains no source bytes or credentials.
  }
}

function isRegularNonLinkFile(stats: Stats): boolean {
  return stats.isFile() && !stats.isSymbolicLink();
}

function hasSameComparableFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const leftSnapshot = snapshotComparableFileIdentity(left, platform);
  const rightSnapshot = snapshotComparableFileIdentity(right, platform);
  if (!leftSnapshot || !rightSnapshot) {
    return false;
  }
  if (leftSnapshot.ino !== 0n && rightSnapshot.ino !== 0n) {
    return leftSnapshot.dev === rightSnapshot.dev && leftSnapshot.ino === rightSnapshot.ino;
  }
  return leftSnapshot.ino === 0n &&
    rightSnapshot.ino === 0n &&
    leftSnapshot.windowsFileIdentity !== undefined &&
    rightSnapshot.windowsFileIdentity !== undefined &&
    leftSnapshot.windowsFileIdentity.volumeSerial === rightSnapshot.windowsFileIdentity.volumeSerial &&
    leftSnapshot.windowsFileIdentity.fileId === rightSnapshot.windowsFileIdentity.fileId &&
    leftSnapshot.windowsFileIdentity.linkCount === rightSnapshot.windowsFileIdentity.linkCount;
}

function hasComparableFileIdentity(
  stats: FileIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return snapshotComparableFileIdentity(stats, platform) !== undefined;
}

interface ComparableTransactionFileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly nlink: number | bigint;
  readonly windowsFileIdentity?: WindowsFileIdentity;
}

function snapshotComparableFileIdentity(
  stats: FileIdentity,
  platform: NodeJS.Platform = process.platform,
): ComparableTransactionFileIdentity | undefined {
  try {
    const dev = readOwnDataProperty(stats, "dev");
    const ino = readOwnDataProperty(stats, "ino");
    const nlink = readOwnDataProperty(stats, "nlink");
    if (!isSafeTransactionIdentityValue(dev) ||
      !isSafeTransactionIdentityValue(ino) ||
      !isSafeTransactionIdentityValue(nlink)) {
      return undefined;
    }
    if (ino !== 0n && ino !== 0) {
      return Object.freeze({ dev, ino, nlink });
    }
    if (platform !== "win32") {
      return undefined;
    }
    const native = snapshotTransactionWindowsIdentity(readOwnDataProperty(stats, "windowsFileIdentity"));
    if (!native || !sameTransactionIdentityValue(nlink, native.linkCount)) {
      return undefined;
    }
    return Object.freeze({ dev, ino, nlink, windowsFileIdentity: native });
  } catch {
    return undefined;
  }
}

function readOwnDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function isSafeTransactionIdentityValue(value: unknown): value is number | bigint {
  return typeof value === "bigint"
    ? value >= 0n
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sameTransactionIdentityValue(
  left: number | bigint,
  right: number | bigint,
): boolean {
  if (typeof left === typeof right) {
    return left === right;
  }
  return typeof left === "number" ? BigInt(left) === right : left === BigInt(right);
}

function snapshotTransactionWindowsIdentity(value: unknown): WindowsFileIdentity | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const volumeSerial = readOwnDataProperty(value, "volumeSerial");
  const fileId = readOwnDataProperty(value, "fileId");
  const linkCount = readOwnDataProperty(value, "linkCount");
  if (
    typeof volumeSerial !== "string" ||
    !/^[0-9a-f]{16}$/u.test(volumeSerial) ||
    typeof fileId !== "string" ||
    !/^[0-9a-f]{32}$/u.test(fileId) ||
    linkCount !== 1n
  ) {
    return undefined;
  }
  return Object.freeze({ volumeSerial, fileId, linkCount });
}

function hasMultipleHardLinks(stats: Stats): boolean {
  return typeof stats.nlink === "number" && stats.nlink > 1;
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

async function removeIncompleteLock(
  path: string,
  options: TransactionOptions,
): Promise<void> {
  const stats = await lstatBigIntIfPresent(path, options.fileIdentityOptions);
  if (!stats) {
    return;
  }
  const deletion = await removeLockPathByIdentity(path, stats, options);
  if (deletion === "missing") {
    return;
  }
}

async function removeLockPathByIdentity(
  path: string,
  expectedStats: BigIntStats,
  options: TransactionOptions,
): Promise<"deleted" | "missing"> {
  if (options.io?.releaseLock) {
    await options.io.releaseLock(path);
    return "deleted";
  }

  const fileIdentityOptions = options.fileIdentityOptions;
  const platform = fileIdentityOptions?.platform ?? process.platform;
  if (platform !== "win32" || expectedStats.ino !== 0n) {
    try {
      await (options.io?.unlink ?? unlink)(path);
      return "deleted";
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return "missing";
      }
      throw error;
    }
  }

  const expectedIdentity = snapshotTransactionWindowsIdentity(
    readOwnDataProperty(expectedStats, "windowsFileIdentity"),
  );
  if (!expectedIdentity) {
    throw lockUnverifiable("The Codex Home operation lock has no verifiable Windows identity.");
  }
  const operations = fileIdentityOptions?.windowsFileOperations ?? createWindowsFileOperations();
  let result: "deleted" | "identity-mismatch";
  try {
    result = operations.deleteFileIfMatches(path, expectedIdentity);
  } catch (error: unknown) {
    const current = await lstatBigIntIfPresent(path, fileIdentityOptions).catch(() => undefined);
    if (!current) {
      return "missing";
    }
    throw lockUnverifiable(
      "The Codex Home operation lock could not be safely removed.",
      error,
    );
  }
  if (result === "identity-mismatch") {
    throw lockUnverifiable("The Codex Home operation lock ownership changed before removal.");
  }
  return "deleted";
}

async function removeRestoreTargetFile(
  path: string,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<void> {
  const platform = fileIdentityOptions?.platform ?? process.platform;
  const stats = await lstatWithTransactionIdentity(path, fileIdentityOptions).catch(
    (error: unknown) => {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    },
  );
  if (!stats) {
    return;
  }

  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1n ||
    !hasComparableFileIdentity(stats as FileIdentity, platform)
  ) {
    throw new TransactionError(
      "rollback-failed",
      "The restore target is not a safely identifiable regular file.",
    );
  }

  if (platform !== "win32" || stats.ino !== 0n) {
    await unlink(path);
    return;
  }

  const nativeIdentity = snapshotTransactionWindowsIdentity(
    readOwnDataProperty(stats, "windowsFileIdentity"),
  );
  if (!nativeIdentity) {
    throw new TransactionError(
      "rollback-failed",
      "The restore target has no verifiable Windows file identity.",
    );
  }
  const operations = fileIdentityOptions?.windowsFileOperations ?? createWindowsFileOperations();
  let result: "deleted" | "identity-mismatch";
  try {
    result = operations.deleteFileIfMatches(path, nativeIdentity);
  } catch (error: unknown) {
    throw new TransactionError(
      "rollback-failed",
      "The restore target could not be safely deleted.",
      { cause: error },
    );
  }
  if (result === "identity-mismatch") {
    throw new TransactionError(
      "rollback-failed",
      "The restore target changed before it could be safely deleted.",
    );
  }
}

async function readLock(path: string): Promise<{ pid: number; raw: string } | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const value = JSON.parse(raw) as { pid?: unknown };
    return typeof value.pid === "number" ? { pid: value.pid, raw } : undefined;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    return undefined;
  }
}

function defaultIsProcessAlive(pid: number): boolean | undefined {
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    return undefined;
  }
}

function assertOperationId(operationId: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(operationId)) {
    throw new TransactionError(
      "invalid-operation-id",
      "The transaction operation ID is invalid.",
    );
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return isNodeErrorWithCode(error, "ENOENT");
}

function isExistsError(error: unknown): error is NodeJS.ErrnoException {
  return isNodeErrorWithCode(error, "EEXIST");
}

function isNodeErrorWithCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}
