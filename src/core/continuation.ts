import { spawn } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import sqlite3 from "sqlite3";
import {
  cleanupTemporaryContexts,
  retainCompletedTransactionBackups,
  selectMappedBranchesForArchival,
} from "./retention";
import {
  hasComparableFileIdentity,
  hydrateWindowsFileIdentity,
  sameStableFileIdentity,
  type FileIdentity,
  type HydrateWindowsFileIdentityOptions,
} from "./file-identity";
import type { CodexLayout } from "./types";
import type { ContinuationSourceAnchor } from "./rollouts";

const stateDatabaseName = "state.sqlite";
const stateSchemaVersion = 1;
const maximumCapturedCommandOutputBytes = 64 * 1024;
const maximumReadableFallbackBytes = 128 * 1024;
const defaultCapabilityProbeTimeoutMs = 10_000;
const continuationDatabaseBusyTimeoutMs = 10_000;
const sessionIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const profileIdentifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sha256Pattern = /^[a-f0-9]{64}$/i;

const capabilityCache = new Map<string, Promise<CodexCapabilities>>();
const forkLocks = new Map<string, Promise<void>>();

export type ContinuationMode = "resume" | "fork";
export type BranchMappingStatus = "active" | "archived";

export interface BranchMapping {
  readonly sourceSessionId: string;
  readonly targetProfileId: string;
  readonly branchSessionId: string;
  readonly sourceEventHash: string;
  readonly status: BranchMappingStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CodexCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CodexCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<CodexCommandResult>;

export type StateStoreStatementRunner = (
  database: sqlite3.Database,
  sql: string,
  params?: readonly unknown[],
) => Promise<void>;

export type ContinuationSourceAnchorCatalog = (
  layout: CodexLayout,
) => Promise<readonly ContinuationSourceAnchor[]>;

export interface TerminalInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly title: string;
  readonly shell: false;
}

export interface InteractiveCodexTerminal {
  /** True only when a successful fork resolves with a validated new session ID. */
  readonly reportsForkOutcome?: boolean;
  launch(invocation: TerminalInvocation): Promise<{
    readonly exitCode?: number;
    readonly stderr?: string;
    readonly branchSessionId?: string;
  }>;
}

export interface ContinueSessionRequest {
  readonly layout: CodexLayout;
  readonly sessionId: string;
  readonly mode: ContinuationMode;
  readonly targetProfileId: string;
  readonly sourceEventHash?: string;
  /** Revalidates the selected metadata-only anchor immediately before a native fork. */
  readonly sourceAnchorCatalog?: ContinuationSourceAnchorCatalog;
  readonly readableFallbackPrompt?: string;
  readonly confirmReadableContent?: () => Promise<boolean>;
  readonly terminal: InteractiveCodexTerminal;
  readonly commandRunner?: CodexCommandRunner;
  /** Bounds the default `codex --help` probe. Tests may lower this value. */
  readonly capabilityProbeTimeoutMs?: number;
  /** Allows the extension host to supply its SQLite execution boundary. */
  readonly stateStoreStatementRunner?: StateStoreStatementRunner;
  readonly fileIdentityOptions?: HydrateWindowsFileIdentityOptions;
  readonly codexCommand?: string;
  readonly codexCommandPrefixArgs?: readonly string[];
  readonly archiveBranch?: (branchSessionId: string) => Promise<void>;
  readonly unarchiveBranch?: (branchSessionId: string) => Promise<void>;
  readonly now?: () => string;
}

export type ContinueSessionStatus =
  | "resumed"
  | "forked"
  | "forkLaunched"
  | "reusedBranch"
  | "readableContentFallback";

export interface ContinueSessionResult {
  readonly status: ContinueSessionStatus;
  readonly sourceSessionId: string;
  readonly branchSessionId?: string;
  readonly confirmationRequired?: boolean;
  readonly confirmationGranted?: boolean;
  readonly fallbackLaunched?: boolean;
  readonly retentionWarning?: boolean;
}

interface CodexCapabilities {
  readonly resume: boolean;
  readonly fork: boolean;
  readonly archive: boolean;
  readonly unarchive: boolean;
}

interface CodexInvocationSpec {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

export async function continueSession(
  request: ContinueSessionRequest,
): Promise<ContinueSessionResult> {
  assertContinuationRequest(request);
  const invocation = resolveCodexInvocation(request);
  const runner = request.commandRunner ?? ((command: string, args: readonly string[]) => defaultCommandRunner(
    command,
    args,
    request.capabilityProbeTimeoutMs ?? defaultCapabilityProbeTimeoutMs,
  ));
  const supported = await getCodexCapabilities(invocation, runner);
  if (!supported.resume || (request.mode === "fork" && !supported.fork)) {
    return launchReadableContentFallback(request, invocation);
  }

  if (request.mode === "resume") {
    await launchOrThrow(request.terminal, {
      command: invocation.command,
      args: [...invocation.prefixArgs, "resume", request.sessionId],
      title: `Codex: Resume ${request.sessionId}`,
      shell: false,
    });
    return completeSuccessfulLaunch(request, {
      status: "resumed",
      sourceSessionId: request.sessionId,
    });
  }

  if (request.terminal.reportsForkOutcome !== true) {
    throw new ContinuationError(
      "active-branch-limit",
      "A trustworthy fork outcome is required before starting a native Codex fork.",
    );
  }

  const store = new SqliteBranchMappingStore(
    request.layout,
    request.fileIdentityOptions,
    request.now,
    request.stateStoreStatementRunner,
  );
  return withForkLock(request, async () => store.withExclusiveFork((exclusiveStore, commitCompensation) => (
    continueFork(request, invocation, supported, exclusiveStore, commitCompensation)
  )));
}

async function continueFork(
  request: ContinueSessionRequest,
  invocation: CodexInvocationSpec,
  supported: CodexCapabilities,
  store: BranchMappingStore,
  commitCompensation: ForkCommitCompensation,
): Promise<ContinueSessionResult> {
  const sourceEventHash = request.sourceEventHash!;
  const existing = await store.findReusable(
    request.sessionId,
    request.targetProfileId,
    sourceEventHash,
  );
  if (existing) {
    const reactivation = existing.status === "archived"
      ? await reactivateArchivedBranch(store, existing, request, invocation, supported)
      : undefined;
    try {
      await launchOrThrow(request.terminal, {
        command: invocation.command,
        args: [...invocation.prefixArgs, "resume", existing.branchSessionId],
        title: `Codex: Resume ${existing.branchSessionId}`,
        shell: false,
      });
    } catch (error: unknown) {
      if (reactivation) {
        await reactivation.rollback(error);
      }
      throw error;
    }
    if (reactivation) {
      commitCompensation.rollback = (commitError) => reactivation.rollback(commitError);
    }
    return completeSuccessfulLaunch(request, {
      status: "reusedBranch",
      sourceSessionId: request.sessionId,
      branchSessionId: existing.branchSessionId,
    });
  }

  const reservation = await reserveForkCapacity(store, request, invocation, supported);
  let forkResult: Awaited<ReturnType<InteractiveCodexTerminal["launch"]>>;
  try {
    await assertCurrentSourceAnchor(request);
    forkResult = await request.terminal.launch({
      command: invocation.command,
      args: [...invocation.prefixArgs, "fork", request.sessionId],
      title: `Codex: Fork ${request.sessionId}`,
      shell: false,
    });
  } catch (error: unknown) {
    await rollbackReservationAfterError(reservation, error);
    throw error;
  }
  if (forkResult.exitCode !== undefined && forkResult.exitCode !== 0) {
    await reservation.rollback();
    if (isEncryptedContentFailure(forkResult.stderr)) {
      return launchReadableContentFallback(request, invocation);
    }
    throw new ContinuationError(
      "native-command-failed",
      "The native Codex fork command did not start successfully.",
    );
  }
  if (!forkResult.branchSessionId) {
    const error = new ContinuationError(
      "native-command-failed",
      "The trusted Codex fork terminal did not report a trusted session ID.",
    );
    await rollbackReservationAfterError(reservation, error);
    throw error;
  }
  try {
    assertSessionIdentifier(forkResult.branchSessionId, "branch session ID");
  } catch (error: unknown) {
    await reservation.rollback();
    throw error;
  }
  const mapping: BranchMapping = {
    sourceSessionId: request.sessionId,
    targetProfileId: request.targetProfileId,
    branchSessionId: forkResult.branchSessionId,
    sourceEventHash,
    status: "active",
    createdAt: now(request),
    updatedAt: now(request),
  };
  try {
    await reservation.commit(mapping);
  } catch (error: unknown) {
    await rollbackForkAfterCommitFailure(reservation, mapping.branchSessionId, error);
    throw error;
  }
  commitCompensation.rollback = (commitError) => rollbackForkAfterCommitFailure(
    reservation,
    mapping.branchSessionId,
    commitError,
  );
  return completeSuccessfulLaunch(request, {
    status: "forked",
    sourceSessionId: request.sessionId,
    branchSessionId: forkResult.branchSessionId,
  });
}

async function assertCurrentSourceAnchor(request: ContinueSessionRequest): Promise<void> {
  if (!request.sourceAnchorCatalog) {
    return;
  }

  try {
    const anchors = await request.sourceAnchorCatalog(request.layout);
    const current = anchors.find((anchor) => anchor.sessionId === request.sessionId);
    if (current?.sourceEventHash === request.sourceEventHash) {
      return;
    }
  } catch {
    // Normalize catalog failures to the same redacted public error as stale anchors.
  }

  throw new ContinuationError(
    "invalid-event-hash",
    "The selected Codex session changed before the native fork could start.",
  );
}

async function launchReadableContentFallback(
  request: ContinueSessionRequest,
  invocation: CodexInvocationSpec,
): Promise<ContinueSessionResult> {
  const prompt = request.readableFallbackPrompt;
  if (!prompt) {
    return {
      status: "readableContentFallback",
      sourceSessionId: request.sessionId,
      confirmationRequired: true,
    };
  }
  if (Buffer.byteLength(prompt, "utf8") > maximumReadableFallbackBytes) {
    throw new ContinuationError(
      "fallback-too-large",
      "The readable continuation context is too large to launch safely.",
    );
  }
  if (!request.confirmReadableContent) {
    return {
      status: "readableContentFallback",
      sourceSessionId: request.sessionId,
      confirmationRequired: true,
    };
  }
  const confirmationGranted = await request.confirmReadableContent();
  if (!confirmationGranted) {
    return {
      status: "readableContentFallback",
      sourceSessionId: request.sessionId,
      confirmationRequired: true,
      confirmationGranted: false,
      fallbackLaunched: false,
    };
  }
  await launchOrThrow(request.terminal, {
    command: invocation.command,
    args: [...invocation.prefixArgs, prompt],
    title: "Codex: Continue readable context",
    shell: false,
  });
  return completeSuccessfulLaunch(request, {
    status: "readableContentFallback",
    sourceSessionId: request.sessionId,
    confirmationRequired: true,
    confirmationGranted: true,
    fallbackLaunched: true,
  });
}

async function completeSuccessfulLaunch(
  request: ContinueSessionRequest,
  result: ContinueSessionResult,
): Promise<ContinueSessionResult> {
  const cleanup = await Promise.allSettled([
    retainCompletedTransactionBackups(request.layout, {
      fileIdentityOptions: request.fileIdentityOptions,
    }),
    cleanupTemporaryContexts(request.layout, {
      fileIdentityOptions: request.fileIdentityOptions,
    }),
  ]);
  return cleanup.some((entry) => entry.status === "rejected")
    ? { ...result, retentionWarning: true }
    : result;
}

interface ForkCapacityReservation {
  rollback(): Promise<void>;
  rollbackFork(branchSessionId: string): Promise<void>;
  commit(mapping: BranchMapping): Promise<void>;
}

interface ArchivedBranchReactivation {
  rollback(primaryError: unknown): Promise<void>;
}

interface ForkCommitCompensation {
  rollback?: (commitError: unknown) => Promise<void>;
}

interface BranchMappingStore {
  findReusable(
    sourceSessionId: string,
    targetProfileId: string,
    sourceEventHash: string,
  ): Promise<BranchMapping | undefined>;
  listActive(sourceSessionId: string, targetProfileId: string): Promise<BranchMapping[]>;
  save(mapping: BranchMapping): Promise<void>;
  archiveAndSave(archivedBranchSessionIds: readonly string[], mapping: BranchMapping): Promise<void>;
  archiveAndActivate(archivedBranchSessionIds: readonly string[], branchSessionId: string): Promise<void>;
}

interface NativeBranchArchiveOperations {
  readonly archive: (branchSessionId: string) => Promise<void>;
  readonly unarchive: (branchSessionId: string) => Promise<void>;
}

async function reactivateArchivedBranch(
  store: BranchMappingStore,
  existing: BranchMapping,
  request: ContinueSessionRequest,
  invocation: CodexInvocationSpec,
  supported: CodexCapabilities,
): Promise<ArchivedBranchReactivation> {
  const operations = resolveNativeBranchArchiveOperations(request, invocation, supported);
  if (!operations) {
    throw new ContinuationError(
      "active-branch-limit",
      "The archived branch cannot be restored because native archive recovery is unavailable.",
    );
  }
  const active = await store.listActive(existing.sourceSessionId, existing.targetProfileId);
  const mappingsToArchive = selectMappedBranchesForArchival(active, 2);
  const archivedBranchSessionIds: string[] = [];
  try {
    for (const mapping of mappingsToArchive) {
      await operations.archive(mapping.branchSessionId);
      archivedBranchSessionIds.push(mapping.branchSessionId);
    }
    await operations.unarchive(existing.branchSessionId);
  } catch (error: unknown) {
    await restoreArchivedBranchesAfterFailure(error, archivedBranchSessionIds, operations.unarchive);
  }
  const rollback = async (primaryError: unknown): Promise<void> => {
    try {
      await operations.archive(existing.branchSessionId);
      await restoreArchivedBranches(archivedBranchSessionIds, operations.unarchive);
    } catch (rollbackError: unknown) {
      throw new AggregateError(
        [primaryError, rollbackError],
        "Archived branch reactivation and native rollback both failed.",
      );
    }
  };
  try {
    await store.archiveAndActivate(archivedBranchSessionIds, existing.branchSessionId);
  } catch (error: unknown) {
    await rollback(error);
    throw error;
  }
  return { rollback };
}

async function reserveForkCapacity(
  store: BranchMappingStore,
  request: ContinueSessionRequest,
  invocation: CodexInvocationSpec,
  supported: CodexCapabilities,
): Promise<ForkCapacityReservation> {
  const active = await store.listActive(request.sessionId, request.targetProfileId);
  if (active.length < 3) {
    const archive = resolveNativeBranchArchive(request, invocation, supported);
    return {
      rollback: async () => undefined,
      rollbackFork: async (branchSessionId) => {
        if (!archive) {
          throw new ContinuationError(
            "active-branch-limit",
            "The newly created native branch could not be archived safely.",
          );
        }
        try {
          await archive(branchSessionId);
        } catch (error: unknown) {
          throw new ContinuationError(
            "active-branch-limit",
            "The newly created native branch could not be archived safely.",
            { cause: error },
          );
        }
      },
      commit: async (mapping) => store.save(mapping),
    };
  }
  if (request.terminal.reportsForkOutcome !== true) {
    throw new ContinuationError(
      "active-branch-limit",
      "The active branch limit requires a terminal that can report a trustworthy fork outcome.",
    );
  }
  const operations = resolveNativeBranchArchiveOperations(request, invocation, supported);
  if (!operations) {
    throw new ContinuationError(
      "active-branch-limit",
      "The active branch limit cannot be preserved because native archive recovery is unavailable.",
    );
  }
  const archived = selectMappedBranchesForArchival(active, 2);
  const archivedIds: string[] = [];
  try {
    for (const mapping of archived) {
      await operations.archive(mapping.branchSessionId);
      archivedIds.push(mapping.branchSessionId);
    }
  } catch (error: unknown) {
    await restoreArchivedBranchesAfterFailure(error, archivedIds, operations.unarchive);
  }
  return {
    rollback: async () => restoreArchivedBranches(archivedIds, operations.unarchive),
    rollbackFork: async (branchSessionId) => {
      try {
        await operations.archive(branchSessionId);
      } catch (error: unknown) {
        throw new ContinuationError(
          "active-branch-limit",
          "The newly created native branch could not be archived safely.",
          { cause: error },
        );
      }
      await restoreArchivedBranches(archivedIds, operations.unarchive);
    },
    commit: async (mapping) => store.archiveAndSave(archivedIds, mapping),
  };
}

function resolveNativeBranchArchiveOperations(
  request: ContinueSessionRequest,
  invocation: CodexInvocationSpec,
  supported: CodexCapabilities,
): NativeBranchArchiveOperations | undefined {
  const archive = resolveNativeBranchArchive(request, invocation, supported);
  const unarchive = request.unarchiveBranch ?? (supported.unarchive
    ? async (branchSessionId: string) => launchOrThrow(request.terminal, {
        command: invocation.command,
        args: [...invocation.prefixArgs, "unarchive", branchSessionId],
        title: `Codex: Unarchive ${branchSessionId}`,
        shell: false,
      })
    : undefined);
  return archive && unarchive ? { archive, unarchive } : undefined;
}

function resolveNativeBranchArchive(
  request: ContinueSessionRequest,
  invocation: CodexInvocationSpec,
  supported: CodexCapabilities,
): ((branchSessionId: string) => Promise<void>) | undefined {
  return request.archiveBranch ?? (supported.archive
    ? async (branchSessionId: string) => launchOrThrow(request.terminal, {
        command: invocation.command,
        args: [...invocation.prefixArgs, "archive", branchSessionId],
        title: `Codex: Archive ${branchSessionId}`,
        shell: false,
      })
    : undefined);
}

async function rollbackReservationAfterError(
  reservation: ForkCapacityReservation,
  primaryError: unknown,
): Promise<void> {
  try {
    await reservation.rollback();
  } catch (rollbackError: unknown) {
    throw new AggregateError(
      [primaryError, rollbackError],
      "Native fork launch and capacity reservation rollback both failed.",
    );
  }
}

async function rollbackForkAfterCommitFailure(
  reservation: ForkCapacityReservation,
  branchSessionId: string,
  primaryError: unknown,
): Promise<void> {
  try {
    await reservation.rollbackFork(branchSessionId);
  } catch (rollbackError: unknown) {
    throw new AggregateError(
      [primaryError, rollbackError],
      "Continuation mapping commit and native branch rollback both failed.",
    );
  }
}

async function restoreArchivedBranches(
  branchSessionIds: readonly string[],
  unarchive: (branchSessionId: string) => Promise<void>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const branchSessionId of [...branchSessionIds].reverse()) {
    try {
      await unarchive(branchSessionId);
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new ContinuationError(
      "active-branch-limit",
      "The archived native branches could not be restored safely.",
      { cause: errors.length === 1 ? errors[0] : new AggregateError(errors) },
    );
  }
}

async function restoreArchivedBranchesAfterFailure(
  primaryError: unknown,
  branchSessionIds: readonly string[],
  unarchive: (branchSessionId: string) => Promise<void>,
): Promise<never> {
  try {
    await restoreArchivedBranches(branchSessionIds, unarchive);
  } catch (restorationError: unknown) {
    throw new AggregateError(
      [primaryError, restorationError],
      "Native branch operation and restoration both failed.",
    );
  }
  throw primaryError;
}

async function withForkLock<Result>(
  request: Pick<ContinueSessionRequest, "layout" | "sessionId" | "targetProfileId">,
  operation: () => Promise<Result>,
): Promise<Result> {
  const key = `${await canonicalForkLockPath(request.layout.codexHome)}\u0000${request.sessionId}\u0000${request.targetProfileId}`;
  const previous = forkLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const released = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  const queued = previous.catch(() => undefined).then(() => released);
  forkLocks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (forkLocks.get(key) === queued) {
      forkLocks.delete(key);
    }
  }
}

async function canonicalForkLockPath(codexHome: string): Promise<string> {
  const path = resolve(codexHome);
  let canonical = path;
  try {
    canonical = await realpath(path);
  } catch {
    // The mapping store will create and validate Codex Home before it writes state.
  }
  return process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
}

async function launchOrThrow(
  terminal: InteractiveCodexTerminal,
  invocation: TerminalInvocation,
): Promise<void> {
  const result = await terminal.launch(invocation);
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    throw new ContinuationError(
      "native-command-failed",
      "The native Codex session command did not start successfully.",
    );
  }
}

function resolveCodexInvocation(request: ContinueSessionRequest): CodexInvocationSpec {
  const command = request.codexCommand?.trim() || "codex";
  if (command.length === 0) {
    throw new ContinuationError("invalid-command", "A Codex CLI command is required.");
  }
  return { command, prefixArgs: request.codexCommandPrefixArgs ?? [] };
}

async function getCodexCapabilities(
  invocation: CodexInvocationSpec,
  runner: CodexCommandRunner,
): Promise<CodexCapabilities> {
  const key = `${invocation.command}\u0000${invocation.prefixArgs.join("\u0000")}`;
  let capabilities = capabilityCache.get(key);
  if (!capabilities) {
    capabilities = runner(invocation.command, [...invocation.prefixArgs, "--help"])
      .then((result) => {
        if (result.exitCode !== 0) {
          throw new ContinuationError(
            "capability-check-failed",
            "Codex CLI capabilities could not be checked.",
          );
        }
        return {
          resume: /(^|\s)resume(?:\s|$)/m.test(result.stdout),
          fork: /(^|\s)fork(?:\s|$)/m.test(result.stdout),
          archive: /(^|\s)archive(?:\s|$)/m.test(result.stdout),
          unarchive: /(^|\s)unarchive(?:\s|$)/m.test(result.stdout),
        };
      })
      .catch((error: unknown) => {
        capabilityCache.delete(key);
        if (error instanceof ContinuationError) {
          throw error;
        }
        throw new ContinuationError(
          "capability-check-failed",
          "Codex CLI capabilities could not be checked.",
        );
      });
    capabilityCache.set(key, capabilities);
  }
  return capabilities;
}

async function defaultCommandRunner(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CodexCommandResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const fail = (error: ContinuationError) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    };
    const complete = (result: CodexCommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(result);
    };
    try {
      child = spawn(command, args, { shell: false, windowsHide: true });
    } catch {
      fail(new ContinuationError("capability-check-failed", "Codex CLI capabilities could not be checked."));
      return;
    }
    timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // A process that already exited is handled by the same bounded failure path.
      }
      fail(new ContinuationError("capability-check-failed", "Codex CLI capabilities could not be checked."));
    }, timeoutMs);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const append = (target: Buffer[], value: Buffer) => {
      if (outputBytes >= maximumCapturedCommandOutputBytes) {
        return;
      }
      const remaining = maximumCapturedCommandOutputBytes - outputBytes;
      const chunk = value.subarray(0, remaining);
      outputBytes += chunk.length;
      target.push(chunk);
    };
    child.stdout?.on("data", (value: Buffer) => append(stdout, value));
    child.stderr?.on("data", (value: Buffer) => append(stderr, value));
    child.once("error", () => {
      fail(new ContinuationError("capability-check-failed", "Codex CLI capabilities could not be checked."));
    });
    child.once("close", (code) => {
      complete({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: redactCommandOutput(Buffer.concat(stderr).toString("utf8")),
      });
    });
  });
}

export async function listBranchMappings(
  layout: CodexLayout,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<BranchMapping[]> {
  const store = new SqliteBranchMappingStore(layout, fileIdentityOptions);
  return store.listAll();
}

export function clearCodexCapabilityCacheForTests(): void {
  capabilityCache.clear();
}

export class ContinuationError extends Error {
  constructor(
    readonly code:
      | "invalid-session"
      | "invalid-profile"
      | "invalid-event-hash"
      | "invalid-command"
      | "unsupported-cli"
      | "capability-check-failed"
      | "native-command-failed"
      | "active-branch-limit"
      | "fallback-too-large"
      | "state-store-failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ContinuationError";
  }
}

class ForkOperationFailure extends Error {
  constructor(readonly original: unknown) {
    super("The fork operation failed before its mapping transaction could commit.", { cause: original });
    this.name = "ForkOperationFailure";
  }
}

class SqliteBranchMappingStore {
  constructor(
    private readonly layout: CodexLayout,
    private readonly fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly statementRunner: StateStoreStatementRunner = runStatement,
  ) {}

  async withExclusiveFork<Result>(
    operation: (store: BranchMappingStore, commitCompensation: ForkCommitCompensation) => Promise<Result>,
  ): Promise<Result> {
    try {
      return await this.withDatabase(async (database) => {
        await this.statementRunner(database, "BEGIN IMMEDIATE");
        const commitCompensation: ForkCommitCompensation = {};
        let result: Result;
        try {
          result = await operation(
            new TransactionalBranchMappingStore(database, this.clock, this.statementRunner),
            commitCompensation,
          );
        } catch (error: unknown) {
          try {
            await this.statementRunner(database, "ROLLBACK");
          } catch (rollbackError: unknown) {
            throw new AggregateError(
              [error, rollbackError],
              "Continuation fork transaction and rollback both failed.",
            );
          }
          throw new ForkOperationFailure(error);
        }
        try {
          await this.statementRunner(database, "COMMIT");
        } catch (error: unknown) {
          let compensationError: unknown;
          if (commitCompensation.rollback) {
            try {
              await commitCompensation.rollback(error);
            } catch (caught: unknown) {
              compensationError = caught;
            }
          }
          let rollbackError: unknown;
          try {
            await this.statementRunner(database, "ROLLBACK");
          } catch (caught: unknown) {
            rollbackError = caught;
          }
          if (compensationError !== undefined || rollbackError !== undefined) {
            throw new AggregateError(
              [error, compensationError, rollbackError].filter((candidate) => candidate !== undefined),
              "Continuation mapping commit, native branch rollback, or database rollback failed.",
            );
          }
          throw error;
        }
        return result;
      });
    } catch (error: unknown) {
      if (
        error instanceof ContinuationError &&
        error.code === "state-store-failed" &&
        error.cause instanceof ForkOperationFailure
      ) {
        throw error.cause.original;
      }
      throw error;
    }
  }

  async findReusable(
    sourceSessionId: string,
    targetProfileId: string,
    sourceEventHash: string,
  ): Promise<BranchMapping | undefined> {
    const rows = await this.withDatabase((database) => allRows<BranchMapping>(
      database,
      `SELECT source_session_id AS sourceSessionId,
              target_profile_id AS targetProfileId,
              branch_session_id AS branchSessionId,
              source_event_hash AS sourceEventHash,
              status, created_at AS createdAt, updated_at AS updatedAt
         FROM branch_mappings
        WHERE source_session_id = ?
          AND target_profile_id = ?
          AND source_event_hash = ?
        ORDER BY updated_at DESC
        LIMIT 1`,
      [sourceSessionId, targetProfileId, sourceEventHash],
    ));
    return rows[0];
  }

  async save(mapping: BranchMapping): Promise<void> {
    await this.withDatabase((database) => saveBranchMapping(database, mapping));
  }

  async archiveAndSave(
    archivedBranchSessionIds: readonly string[],
    mapping: BranchMapping,
  ): Promise<void> {
    await this.withDatabase(async (database) => {
      await runStatement(database, "BEGIN IMMEDIATE");
      try {
        for (const branchSessionId of archivedBranchSessionIds) {
          await runStatement(
            database,
            "UPDATE branch_mappings SET status = 'archived', updated_at = ? WHERE branch_session_id = ?",
            [this.clock(), branchSessionId],
          );
        }
        await saveBranchMapping(database, mapping);
        await runStatement(database, "COMMIT");
      } catch (error: unknown) {
        try {
          await runStatement(database, "ROLLBACK");
        } catch (rollbackError: unknown) {
          throw new AggregateError(
            [error, rollbackError],
            "Continuation mapping commit and rollback both failed.",
          );
        }
        throw error;
      }
    });
  }

  async archiveAndActivate(
    archivedBranchSessionIds: readonly string[],
    branchSessionId: string,
  ): Promise<void> {
    await this.withDatabase(async (database) => {
      await runStatement(database, "BEGIN IMMEDIATE");
      try {
        for (const archivedBranchSessionId of archivedBranchSessionIds) {
          await runStatement(
            database,
            "UPDATE branch_mappings SET status = 'archived', updated_at = ? WHERE branch_session_id = ?",
            [this.clock(), archivedBranchSessionId],
          );
        }
        await runStatement(
          database,
          "UPDATE branch_mappings SET status = 'active', updated_at = ? WHERE branch_session_id = ?",
          [this.clock(), branchSessionId],
        );
        await runStatement(database, "COMMIT");
      } catch (error: unknown) {
        try {
          await runStatement(database, "ROLLBACK");
        } catch (rollbackError: unknown) {
          throw new AggregateError(
            [error, rollbackError],
            "Archived branch activation and rollback both failed.",
          );
        }
        throw error;
      }
    });
  }

  async listActive(sourceSessionId: string, targetProfileId: string): Promise<BranchMapping[]> {
    return this.withDatabase((database) => allRows<BranchMapping>(
      database,
      `SELECT source_session_id AS sourceSessionId,
              target_profile_id AS targetProfileId,
              branch_session_id AS branchSessionId,
              source_event_hash AS sourceEventHash,
              status, created_at AS createdAt, updated_at AS updatedAt
         FROM branch_mappings
        WHERE source_session_id = ? AND target_profile_id = ? AND status = 'active'
        ORDER BY updated_at DESC`,
      [sourceSessionId, targetProfileId],
    ));
  }

  async markArchived(branchSessionId: string): Promise<void> {
    await this.withDatabase(async (database) => {
      await runStatement(
        database,
        "UPDATE branch_mappings SET status = 'archived', updated_at = ? WHERE branch_session_id = ?",
        [this.clock(), branchSessionId],
      );
    });
  }

  async listAll(): Promise<BranchMapping[]> {
    return this.withDatabase((database) => allRows<BranchMapping>(
      database,
      `SELECT source_session_id AS sourceSessionId,
              target_profile_id AS targetProfileId,
              branch_session_id AS branchSessionId,
              source_event_hash AS sourceEventHash,
              status, created_at AS createdAt, updated_at AS updatedAt
         FROM branch_mappings
        ORDER BY updated_at DESC`,
    ));
  }

  private async withDatabase<Result>(
    operation: (database: sqlite3.Database) => Promise<Result>,
  ): Promise<Result> {
    let database: sqlite3.Database | undefined;
    let primaryError: unknown;
    let result: Result | undefined;
    try {
      const trustedStateStore = await assertTrustedStateStorePath(
        this.layout,
        this.fileIdentityOptions,
      );
      database = await openDatabase(trustedStateStore.path);
      await assertTrustedStateStorePath(
        this.layout,
        this.fileIdentityOptions,
        trustedStateStore.stateStats,
      );
      database.configure("busyTimeout", continuationDatabaseBusyTimeoutMs);
      database.serialize();
      await initializeStateDatabase(database, this.statementRunner);
      result = await operation(database);
    } catch (error: unknown) {
      primaryError = error;
    }
    let closeError: unknown;
    if (database) {
      try {
        await closeDatabase(database);
      } catch (error: unknown) {
        closeError = error;
      }
    }
    if (primaryError !== undefined || closeError !== undefined) {
      throw new ContinuationError(
        "state-store-failed",
        "The continuation mapping store could not be updated.",
        {
          cause: primaryError !== undefined && closeError !== undefined
            ? new AggregateError([primaryError, closeError], "State database operation and close both failed.")
            : primaryError ?? closeError,
        },
      );
    }
    return result!;
  }
}

class TransactionalBranchMappingStore implements BranchMappingStore {
  constructor(
    private readonly database: sqlite3.Database,
    private readonly clock: () => string,
    private readonly statementRunner: StateStoreStatementRunner = runStatement,
  ) {}

  async findReusable(
    sourceSessionId: string,
    targetProfileId: string,
    sourceEventHash: string,
  ): Promise<BranchMapping | undefined> {
    return this.withStateStoreErrors(async () => {
      const rows = await allRows<BranchMapping>(
        this.database,
        `SELECT source_session_id AS sourceSessionId,
              target_profile_id AS targetProfileId,
              branch_session_id AS branchSessionId,
              source_event_hash AS sourceEventHash,
              status, created_at AS createdAt, updated_at AS updatedAt
         FROM branch_mappings
        WHERE source_session_id = ?
          AND target_profile_id = ?
          AND source_event_hash = ?
        ORDER BY updated_at DESC
        LIMIT 1`,
        [sourceSessionId, targetProfileId, sourceEventHash],
      );
      return rows[0];
    });
  }

  async listActive(sourceSessionId: string, targetProfileId: string): Promise<BranchMapping[]> {
    return this.withStateStoreErrors(() => allRows<BranchMapping>(
      this.database,
      `SELECT source_session_id AS sourceSessionId,
              target_profile_id AS targetProfileId,
              branch_session_id AS branchSessionId,
              source_event_hash AS sourceEventHash,
              status, created_at AS createdAt, updated_at AS updatedAt
         FROM branch_mappings
        WHERE source_session_id = ? AND target_profile_id = ? AND status = 'active'
        ORDER BY updated_at DESC`,
      [sourceSessionId, targetProfileId],
    ));
  }

  async save(mapping: BranchMapping): Promise<void> {
    await this.withStateStoreErrors(() => saveBranchMapping(this.database, mapping, this.statementRunner));
  }

  async archiveAndSave(
    archivedBranchSessionIds: readonly string[],
    mapping: BranchMapping,
  ): Promise<void> {
    await this.withStateStoreErrors(async () => {
      for (const branchSessionId of archivedBranchSessionIds) {
        await this.statementRunner(
          this.database,
          "UPDATE branch_mappings SET status = 'archived', updated_at = ? WHERE branch_session_id = ?",
          [this.clock(), branchSessionId],
        );
      }
      await saveBranchMapping(this.database, mapping, this.statementRunner);
    });
  }

  async archiveAndActivate(
    archivedBranchSessionIds: readonly string[],
    branchSessionId: string,
  ): Promise<void> {
    await this.withStateStoreErrors(async () => {
      for (const archivedBranchSessionId of archivedBranchSessionIds) {
        await this.statementRunner(
          this.database,
          "UPDATE branch_mappings SET status = 'archived', updated_at = ? WHERE branch_session_id = ?",
          [this.clock(), archivedBranchSessionId],
        );
      }
      await this.statementRunner(
        this.database,
        "UPDATE branch_mappings SET status = 'active', updated_at = ? WHERE branch_session_id = ?",
        [this.clock(), branchSessionId],
      );
    });
  }

  private async withStateStoreErrors<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof ContinuationError) {
        throw error;
      }
      throw new ContinuationError(
        "state-store-failed",
        "The continuation mapping store could not be updated.",
        { cause: error },
      );
    }
  }
}

function saveBranchMapping(
  database: sqlite3.Database,
  mapping: BranchMapping,
  statementRunner: StateStoreStatementRunner = runStatement,
): Promise<void> {
  return statementRunner(
    database,
    `INSERT INTO branch_mappings (
       source_session_id, target_profile_id, branch_session_id,
       source_event_hash, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(branch_session_id) DO UPDATE SET
       source_session_id = excluded.source_session_id,
       target_profile_id = excluded.target_profile_id,
       source_event_hash = excluded.source_event_hash,
       status = excluded.status,
       updated_at = excluded.updated_at`,
    [
      mapping.sourceSessionId,
      mapping.targetProfileId,
      mapping.branchSessionId,
      mapping.sourceEventHash,
      mapping.status,
      mapping.createdAt,
      mapping.updatedAt,
    ],
  );
}

type StateStoreFileIdentityStats = BigIntStats & FileIdentity;

interface TrustedStateStorePath {
  readonly path: string;
  readonly stateStats?: StateStoreFileIdentityStats;
}

async function assertTrustedStateStorePath(
  layout: CodexLayout,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
  expectedStateStats?: StateStoreFileIdentityStats,
): Promise<TrustedStateStorePath> {
  const codexHomePath = resolve(layout.codexHome);
  const switcherPath = resolve(layout.switcherDir);
  const expectedSwitcherPath = join(codexHomePath, "provider-switcher");
  if (!pathsEqual(switcherPath, expectedSwitcherPath)) {
    throw stateStorePathError();
  }

  try {
    await mkdir(switcherPath, { recursive: true });
    const codexHomeRealPath = await realpath(codexHomePath);
    const platform = fileIdentityOptions?.platform ?? process.platform;
    const before = await lstatWithFileIdentity(switcherPath, fileIdentityOptions);
    if (!isSafeStateStoreDirectory(before, platform)) {
      throw stateStorePathError();
    }
    const switcherRealPath = await realpath(switcherPath);
    if (!pathsEqual(relative(codexHomeRealPath, switcherRealPath), "provider-switcher")) {
      throw stateStorePathError();
    }
    const after = await lstatWithFileIdentity(switcherPath, fileIdentityOptions);
    const switcherRealPathStats = await lstatWithFileIdentity(switcherRealPath, fileIdentityOptions);
    if (
      !isSafeStateStoreDirectory(after, platform) ||
      !isSafeStateStoreDirectory(switcherRealPathStats, platform) ||
      !sameStableFileIdentity(before, after, platform) ||
      !sameStableFileIdentity(after, switcherRealPathStats, platform) ||
      (await realpath(codexHomePath)) !== codexHomeRealPath ||
      !isPathInsideOrEqual(codexHomeRealPath, switcherRealPath)
    ) {
      throw stateStorePathError();
    }

    const statePath = join(switcherPath, stateDatabaseName);
    let stateStats: StateStoreFileIdentityStats;
    try {
      stateStats = await lstatWithFileIdentity(statePath, fileIdentityOptions);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        if (expectedStateStats !== undefined) {
          throw stateStorePathError();
        }
        return { path: statePath };
      }
      throw error;
    }
    const stateRealPath = await realpath(statePath);
    const stateRealPathStats = await lstatWithFileIdentity(stateRealPath, fileIdentityOptions);
    if (
      !isSafeStateStoreFile(stateStats, platform) ||
      !isSafeStateStoreFile(stateRealPathStats, platform) ||
      !sameStableFileIdentity(stateStats, stateRealPathStats, platform) ||
      (expectedStateStats !== undefined &&
        !sameStableFileIdentity(expectedStateStats, stateStats, platform)) ||
      relative(switcherRealPath, stateRealPath) !== stateDatabaseName
    ) {
      throw stateStorePathError();
    }
    return { path: statePath, stateStats };
  } catch (error: unknown) {
    if (error instanceof ContinuationError) {
      throw error;
    }
    throw stateStorePathError(error);
  }
}

async function lstatWithFileIdentity(
  path: string,
  fileIdentityOptions?: HydrateWindowsFileIdentityOptions,
): Promise<StateStoreFileIdentityStats> {
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
  return stats as StateStoreFileIdentityStats;
}

function isSafeStateStoreDirectory(
  stats: StateStoreFileIdentityStats,
  platform: NodeJS.Platform,
): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink() && hasComparableFileIdentity(stats, platform);
}

function isSafeStateStoreFile(
  stats: StateStoreFileIdentityStats,
  platform: NodeJS.Platform,
): boolean {
  return stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.nlink === 1n &&
    hasComparableFileIdentity(stats, platform);
}

function isPathInsideOrEqual(directory: string, candidate: string): boolean {
  const path = relative(resolve(directory), resolve(candidate));
  return !path.startsWith("..") && !isAbsolute(path);
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function stateStorePathError(cause?: unknown): ContinuationError {
  return new ContinuationError(
    "state-store-failed",
    "The continuation mapping store could not be updated.",
    cause === undefined ? undefined : { cause },
  );
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function initializeStateDatabase(
  database: sqlite3.Database,
  statementRunner: StateStoreStatementRunner = runStatement,
): Promise<void> {
  await statementRunner(database, "BEGIN IMMEDIATE");
  try {
    const version = await getRow<{ user_version: number }>(database, "PRAGMA user_version");
    if (version?.user_version === 0) {
      const objects = await allRows<{ name: string }>(
        database,
        "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
      );
      if (objects.length !== 0) {
        throw new ContinuationError("state-store-failed", "The continuation mapping store has an unsupported schema.");
      }
      await statementRunner(database, `CREATE TABLE branch_mappings (
        source_session_id TEXT NOT NULL,
        target_profile_id TEXT NOT NULL,
        branch_session_id TEXT PRIMARY KEY NOT NULL,
        source_event_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      await statementRunner(
        database,
        "CREATE INDEX branch_mappings_source_target_active ON branch_mappings (source_session_id, target_profile_id, status, updated_at DESC)",
      );
      await statementRunner(database, `PRAGMA user_version = ${String(stateSchemaVersion)}`);
    } else {
      if (version?.user_version !== stateSchemaVersion) {
        throw new ContinuationError("state-store-failed", "The continuation mapping store has an unsupported schema.");
      }
      const columns = await allRows<{ name: string; type: string }>(database, "PRAGMA table_info(branch_mappings)");
      const expected = new Map([
        ["source_session_id", "TEXT"],
        ["target_profile_id", "TEXT"],
        ["branch_session_id", "TEXT"],
        ["source_event_hash", "TEXT"],
        ["status", "TEXT"],
        ["created_at", "TEXT"],
        ["updated_at", "TEXT"],
      ]);
      if (columns.length !== expected.size || columns.some((column) => expected.get(column.name) !== column.type)) {
        throw new ContinuationError("state-store-failed", "The continuation mapping store has an unsupported schema.");
      }
    }
    await statementRunner(database, "COMMIT");
    return;
  } catch (error: unknown) {
    try {
      await statementRunner(database, "ROLLBACK");
    } catch (rollbackError: unknown) {
      throw new AggregateError(
        [error, rollbackError],
        "Continuation state initialization and rollback both failed.",
      );
    }
    throw error;
  }
}

function assertContinuationRequest(request: ContinueSessionRequest): void {
  assertSessionIdentifier(request.sessionId, "session ID");
  if (!profileIdentifierPattern.test(request.targetProfileId)) {
    throw new ContinuationError("invalid-profile", "The target Profile ID is invalid.");
  }
  if (request.mode !== "resume" && request.mode !== "fork") {
    throw new ContinuationError("invalid-session", "The continuation mode is invalid.");
  }
  if (
    request.capabilityProbeTimeoutMs !== undefined &&
    (!Number.isSafeInteger(request.capabilityProbeTimeoutMs) || request.capabilityProbeTimeoutMs <= 0)
  ) {
    throw new ContinuationError("invalid-command", "The Codex capability probe timeout is invalid.");
  }
  if (request.mode === "fork" && !sha256Pattern.test(request.sourceEventHash ?? "")) {
    throw new ContinuationError("invalid-event-hash", "A source event hash is required to fork a session.");
  }
}

function assertSessionIdentifier(value: string, label: string): void {
  if (!sessionIdentifierPattern.test(value)) {
    throw new ContinuationError("invalid-session", `The ${label} is invalid.`);
  }
}

function now(request: ContinueSessionRequest): string {
  return (request.now ?? (() => new Date().toISOString()))();
}

function isEncryptedContentFailure(stderr: string | undefined): boolean {
  return /encrypted(?:_|\s+)content|decrypt(?:ion)?/i.test(stderr ?? "");
}

function redactCommandOutput(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(?:OPENAI_API_KEY|api[_-]?key|authorization)\s*[=:]\s*\S+/gi, "[REDACTED]");
}

function openDatabase(path: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    let database: sqlite3.Database;
    try {
      database = new sqlite3.Database(path, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve(database);
        }
      });
    } catch (error: unknown) {
      reject(error);
    }
  });
}

function closeDatabase(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    database.close((error) => (error ? reject(error) : resolve()));
  });
}

function runStatement(
  database: sqlite3.Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<void> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, (error) => (error ? reject(error) : resolve()));
  });
}

function getRow<T>(database: sqlite3.Database, sql: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    database.get<T>(sql, (error, row) => (error ? reject(error) : resolve(row)));
  });
}

function allRows<T>(
  database: sqlite3.Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all<T>(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
  });
}
