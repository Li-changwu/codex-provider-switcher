import {
  assertValidJournalMutationTarget,
  CommittedJournalDurabilityError,
  recoverAndBeginTransaction,
  type AuthJournalTarget,
  type BackupManifest,
  type BackupTarget,
  type JournalMutationTarget,
  TransactionError,
  type TransactionHandle,
  type TransactionIo,
  type TransactionState,
} from "./transaction";
import { validateRolloutInversePatch } from "./rollouts";
import {
  mapProgressUpdates,
  throwIfProgressCancelled,
  type ProgressEvent,
  type ProgressStage,
  type ProgressUpdate,
} from "../ui/progress";
import { resolve } from "node:path";
import type { CodexLayout } from "./types";

export interface SwitchRequest {
  targetProfileId: string;
  expectedConfigHash?: string;
  signal?: AbortSignal;
}

export interface MutationApplyContext {
  assertTargetUnchanged(): Promise<void>;
}

export interface PreparedSwitchMutation {
  readonly name: string;
  readonly target: JournalMutationTarget;
  readonly markTargetAppliedBeforeApply?: boolean;
  readonly apply: (context: MutationApplyContext) => Promise<void>;
  // Retained while existing mutation-plan builders migrate. Durable recovery
  // is exclusively driven by the journal and never invokes this callback.
  readonly rollback: () => Promise<void>;
}

export interface SwitchStageContext {
  readonly request: SwitchRequest;
  readonly layout: CodexLayout;
  readonly operationId: string;
  readonly signal?: AbortSignal;
  readonly transaction: TransactionHandle;
  registerBackupTargets(targets: readonly BackupTarget[]): void;
}

type InternalSwitchStageContext = SwitchStageContext & {
  backupTargets: BackupTarget[];
};

export interface SwitchMutationPlan {
  readonly rollouts: readonly PreparedSwitchMutation[];
  readonly sqlite: readonly PreparedSwitchMutation[];
  readonly commit: readonly PreparedSwitchMutation[];
  readonly noOp?: boolean;
}

export type ScanProgressUpdate = Omit<ProgressUpdate, "stage"> | ProgressUpdate;

export type ScanProgressReporter = (
  updateOrCompleted: ScanProgressUpdate | number,
  total?: number,
) => void;

export interface SwitchDependencies {
  layout: CodexLayout;
  preflight(context: SwitchStageContext): Promise<void>;
  backup(context: SwitchStageContext): Promise<readonly BackupTarget[] | void>;
  scan(context: SwitchStageContext, reportProgress: ScanProgressReporter): Promise<void>;
  mutationPlan?: SwitchMutationPlan;
  createMutationPlan?(context: SwitchStageContext): Promise<SwitchMutationPlan>;
  verify(context: SwitchStageContext): Promise<void>;
  acknowledge?(context: SwitchStageContext): Promise<void>;
  onProgress?(event: ProgressEvent): void;
  now?: () => string;
  isProcessAlive?: (pid: number) => boolean | undefined;
  restoreAuthMode?(target: AuthJournalTarget): void | Promise<void>;
  transactionIo?: TransactionIo;
}

export type SwitchStatus = "committed" | "cancelled" | "failed";

export interface SwitchErrorSummary {
  readonly errorCode?: string;
  readonly message: string;
  readonly causes?: readonly SwitchErrorSummary[];
}

export interface SwitchResult {
  status: SwitchStatus;
  operationId: string;
  journalState?: TransactionState;
  failureStage?: ProgressStage;
  failureMessage?: string;
  errorSummary?: SwitchErrorSummary;
  acknowledgementFailed?: boolean;
  commitDurabilityWarning?: boolean;
  lockReleaseFailed?: boolean;
}

export async function switchProfile(
  request: SwitchRequest,
  dependencies: SwitchDependencies,
): Promise<SwitchResult> {
  const signal = request.signal;
  if (signal?.aborted) {
    return {
      status: "cancelled",
      operationId: "unstarted",
      failureStage: "preflight",
    };
  }

  let transaction: TransactionHandle | undefined;
  let context: InternalSwitchStageContext | undefined;
  let mutationPlan: SwitchMutationPlan | undefined;
  let currentStage: ProgressStage = "preflight";
  let committed = false;
  let commitDurabilityWarning = false;
  const progress = createProgressEmitter(dependencies.onProgress, signal);

  try {
    throwIfProgressCancelled(signal);
    mutationPlan = prepareStaticMutationPlan(dependencies);
    const started = await recoverAndBeginTransaction(dependencies.layout, {
      now: dependencies.now,
      isProcessAlive: dependencies.isProcessAlive,
      restoreAuthMode: dependencies.restoreAuthMode,
      io: dependencies.transactionIo,
      requireSourceVersionProtocol: true,
    });
    if (
      started.recovery.recoveryRequiredOperationIds.length > 0 ||
      !started.transaction
    ) {
      return {
        status: "failed",
        operationId: "unstarted",
        journalState: "recoveryRequired",
        failureStage: currentStage,
      };
    }
    transaction = started.transaction;
    context = createContext(request, dependencies.layout, transaction, signal);

    await runStage("preflight", dependencies.preflight, context, progress);
    currentStage = "backup";
    const targets = await dependencies.backup(context);
    if (targets) {
      context.registerBackupTargets(targets);
    }
    if (mutationPlan) {
      context.registerBackupTargets(rolloutBackupTargets(mutationPlan));
    }
    const registeredTargets = collectBackupTargets(context);
    let backupManifest = await transaction.backupTargets(registeredTargets);
    if (mutationPlan) {
      assertDurableByteBackups(mutationPlan, backupManifest);
    }
    progress.emit([{ stage: "backup", completed: 1, total: 1 }]);

    currentStage = "scan";
    await runScanStage(dependencies.scan, context, progress);
    if (!mutationPlan) {
      mutationPlan = validateMutationPlan(
        await dependencies.createMutationPlan!(context),
        dependencies.layout,
      );
      assertAuthPlanCanBeRestored(mutationPlan, dependencies.restoreAuthMode);
      context.registerBackupTargets(rolloutBackupTargets(mutationPlan));
      backupManifest = await transaction.backupTargets(collectBackupTargets(context));
      assertDurableByteBackups(mutationPlan, backupManifest);
    }
    await transaction.markApplying();
    currentStage = "rollouts";
    await runPlannedMutations(
      "rollouts",
      mutationPlan.rollouts,
      context,
      progress,
    );
    currentStage = "sqlite";
    await runPlannedMutations(
      "sqlite",
      mutationPlan.sqlite,
      context,
      progress,
    );

    throwIfProgressCancelled(signal);
    currentStage = "verify";
    await runStage("verify", dependencies.verify, context, progress);
    currentStage = "commit";
    await runPlannedMutations(
      "commit",
      mutationPlan.commit,
      context,
      progress,
    );
    throwIfProgressCancelled(signal);
    try {
      await transaction.markCommitted();
    } catch (error: unknown) {
      if (!(error instanceof CommittedJournalDurabilityError)) {
        throw error;
      }
      commitDurabilityWarning = true;
    }
    committed = true;
    let acknowledgementFailed = false;
    if (dependencies.acknowledge) {
      try {
        await dependencies.acknowledge(context);
      } catch {
        acknowledgementFailed = true;
      }
    }
    let lockReleaseFailed = false;
    let lockReleaseError: unknown;
    try {
      // The acknowledgement owns local post-commit state such as the active
      // Profile marker, so it remains serialized with the committed switch.
      await transaction.release();
    } catch (error: unknown) {
      // The journal is already durable; a lock-release failure cannot undo the commit.
      lockReleaseFailed = true;
      lockReleaseError = error;
    }
    return {
      status: "committed",
      operationId: transaction.operationId,
      journalState: "committed",
      ...createFailureDiagnostics(lockReleaseError),
      ...(acknowledgementFailed ? { acknowledgementFailed: true } : {}),
      ...(commitDurabilityWarning ? { commitDurabilityWarning: true } : {}),
      ...(lockReleaseFailed ? { lockReleaseFailed: true } : {}),
    };
  } catch (error: unknown) {
    if (committed && transaction) {
      return {
        status: "committed",
        operationId: transaction.operationId,
        journalState: "committed",
      };
    }
    if (!transaction || !context) {
      return {
        status: "failed",
        operationId: "unstarted",
        failureStage: currentStage,
        ...createFailureDiagnostics(error),
      };
    }
    const cancellationRequested = signal?.aborted === true;
    const rollback = await rollbackAfterFailure(
      transaction,
      dependencies,
    );
    let rollbackState = rollback.state;
    try {
      await transaction.release();
    } catch {
      try {
        await transaction.markRecoveryRequired();
      } catch {
        // The result still signals that the transaction requires operator recovery.
      }
      rollbackState = "recoveryRequired";
    }
    const cancelled = cancellationRequested && rollbackState === "rolledBack";
    return {
      status: cancelled ? "cancelled" : "failed",
      operationId: transaction.operationId,
      journalState: rollbackState,
      failureStage: currentStage,
      ...createFailureDiagnostics(error),
    };
  }
}

function prepareStaticMutationPlan(
  dependencies: SwitchDependencies,
): SwitchMutationPlan | undefined {
  const hasStaticPlan = dependencies.mutationPlan !== undefined;
  const hasFactory = dependencies.createMutationPlan !== undefined;
  if (hasStaticPlan === hasFactory || (hasFactory && typeof dependencies.createMutationPlan !== "function")) {
    throw new TypeError("Provide exactly one switch mutation plan.");
  }
  if (!hasStaticPlan) {
    return undefined;
  }
  const mutationPlan = validateMutationPlan(dependencies.mutationPlan, dependencies.layout);
  assertAuthPlanCanBeRestored(mutationPlan, dependencies.restoreAuthMode);
  return mutationPlan;
}

function createContext(
  request: SwitchRequest,
  layout: CodexLayout,
  transaction: TransactionHandle,
  signal: AbortSignal | undefined,
): InternalSwitchStageContext {
  const backupTargets: BackupTarget[] = [];
  return {
    request,
    layout,
    operationId: transaction.operationId,
    signal,
    transaction,
    backupTargets,
    registerBackupTargets(targets) {
      backupTargets.push(...targets);
    },
  };
}

function collectBackupTargets(context: InternalSwitchStageContext): BackupTarget[] {
  const byPath = new Map<string, BackupTarget>();
  for (const target of context.backupTargets) {
    byPath.set(`${target.kind}:${target.path}`, target);
  }
  return [...byPath.values()];
}

function assertDurableByteBackups(
  mutationPlan: SwitchMutationPlan,
  backupManifest: BackupManifest,
): void {
  for (const stage of mutationPlanStages) {
    for (const mutation of mutationPlan[stage]) {
      const target = mutation.target;
      if (
        target.kind !== "config" &&
        target.kind !== "sqlite" &&
        target.kind !== "rollout"
      ) {
        continue;
      }
      const path = resolve(target.path);
      const hasBackup = backupManifest.entries.some((entry) => (
        entry.kind === target.kind &&
        entry.path === path &&
        (
          (entry.existed === true &&
            typeof entry.backupPath === "string" &&
            entry.backupPath.length > 0 &&
            typeof entry.sha256 === "string" &&
            /^[a-f0-9]{64}$/i.test(entry.sha256)) ||
          (entry.existed === false &&
            entry.backupPath === undefined &&
            entry.sha256 === undefined)
        )
      ));
      if (!hasBackup) {
        throw new Error(
          `The ${target.kind} mutation target has no selected durable byte backup: ${path}`,
        );
      }
    }
  }
}

function rolloutBackupTargets(mutationPlan: SwitchMutationPlan): BackupTarget[] {
  return mutationPlan.rollouts.map((mutation) => ({
    kind: "rollout" as const,
    path: mutation.target.path,
  }));
}

async function runPlannedMutations(
  stage: ProgressStage,
  plannedMutations: readonly PreparedSwitchMutation[],
  context: SwitchStageContext,
  progress: ProgressEmitter,
): Promise<void> {
  throwIfProgressCancelled(context.signal);
  for (const mutation of plannedMutations) {
    assertCompensableMutation(mutation, context.layout);
    assertMutationAllowedInStage(stage, mutation);
    await context.transaction.prepareTarget(mutation.target);
    if (mutation.markTargetAppliedBeforeApply === true) {
      await context.transaction.markTargetApplied(mutation.target);
    }
    try {
      await mutation.apply({
        assertTargetUnchanged: () => context.transaction.assertTargetUnchanged(mutation.target),
      });
    } catch (error: unknown) {
      if (mutation.markTargetAppliedBeforeApply === true) {
        await refreshAppliedTargetEvidence(mutation.target, context.transaction);
      }
      await recordPublishedRolloutFailure(
        mutation.target,
        context.layout,
        context.signal,
        context.transaction,
      );
      throw error;
    }
    await context.transaction.markTargetApplied(mutation.target);
    throwIfProgressCancelled(context.signal);
  }
  progress.emit([{ stage, completed: 1, total: 1 }]);
}

async function refreshAppliedTargetEvidence(
  target: JournalMutationTarget,
  transaction: SwitchStageContext["transaction"],
): Promise<void> {
  try {
    await transaction.markTargetApplied(target);
  } catch {
    // Preserve the original mutation error; rollback will fail closed without fresh evidence.
  }
}

async function recordPublishedRolloutFailure(
  target: JournalMutationTarget,
  layout: CodexLayout,
  signal: AbortSignal | undefined,
  transaction: TransactionHandle,
): Promise<void> {
  if (target.kind !== "rollout") {
    return;
  }
  try {
    if (await validateRolloutInversePatch(target.inversePatch, layout, signal) !== "ready") {
      return;
    }
    try {
      await transaction.markTargetApplied(target);
    } catch {
      // Re-throw the original mutation error; a missing durable record remains fail-closed.
    }
  } catch {
    // An unverifiable rollout publication must not gain applied evidence.
  }
}

async function runStage(
  stage: ProgressStage,
  operation: (context: SwitchStageContext) => Promise<void>,
  context: SwitchStageContext,
  progress: ProgressEmitter,
): Promise<void> {
  throwIfProgressCancelled(context.signal);
  await operation(context);
  throwIfProgressCancelled(context.signal);
  progress.emit([{ stage, completed: 1, total: 1 }]);
}

async function runScanStage(
  operation: (
    context: SwitchStageContext,
    reportProgress: ScanProgressReporter,
  ) => Promise<void>,
  context: SwitchStageContext,
  progress: ProgressEmitter,
): Promise<void> {
  let reportCount = 0;
  const reportProgress: ScanProgressReporter = (updateOrCompleted, total) => {
    reportCount += 1;
    progress.emit([
      normalizeScanProgressUpdate(updateOrCompleted, total),
    ]);
  };
  throwIfProgressCancelled(context.signal);
  await operation(context, reportProgress);
  throwIfProgressCancelled(context.signal);
  if (reportCount === 0) {
    progress.emit([{ stage: "scan", completed: 1, total: 1 }]);
  }
}

async function rollbackAfterFailure(
  transaction: TransactionHandle,
  dependencies: Pick<SwitchDependencies, "restoreAuthMode">,
): Promise<RollbackResult> {
  const errors: unknown[] = [];
  try {
    await transaction.validateRollback(dependencies.restoreAuthMode);
  } catch (error: unknown) {
    errors.push(error);
  }

  let durableRollbackFailed = false;
  try {
    await transaction.rollback(dependencies.restoreAuthMode);
  } catch (error: unknown) {
    durableRollbackFailed = true;
    errors.push(error);
  }

  if (!durableRollbackFailed) {
    return { state: "rolledBack", errors };
  }

  if (durableRollbackFailed) {
    try {
      await transaction.markRecoveryRequired();
    } catch (error: unknown) {
      errors.push(error);
      // The result must remain bounded even if the journal cannot record it.
    }
  }
  return { state: "recoveryRequired", errors };
}

interface RollbackResult {
  readonly state: TransactionState;
  readonly errors: readonly unknown[];
}

const genericFailureCode = "switch-operation-failed";
const genericFailureMessage = "The provider switch operation failed.";
const safeTransactionErrorCodes = new Set([
  "lock-held",
  "lock-unverifiable",
  "invalid-operation-id",
  "invalid-backup-target",
  "journal-invalid",
  "rollback-failed",
]);

function createFailureDiagnostics(
  primaryError: unknown,
): Pick<SwitchResult, "failureMessage" | "errorSummary"> {
  if (primaryError === undefined) {
    return {};
  }
  return {
    failureMessage: genericFailureMessage,
    errorSummary: summarizeError(primaryError),
  };
}

function summarizeError(error: unknown): SwitchErrorSummary {
  return {
    errorCode: getErrorCode(error) ?? genericFailureCode,
    message: genericFailureMessage,
  };
}

function getErrorCode(error: unknown): string | undefined {
  if (!(error instanceof TransactionError)) {
    return undefined;
  }
  return safeTransactionErrorCodes.has(error.code) ? error.code : undefined;
}

function assertCompensableMutation(
  mutation: unknown,
  layout: CodexLayout,
): void {
  if (
    !mutation ||
    typeof mutation !== "object" ||
    Array.isArray(mutation) ||
    typeof (mutation as { name?: unknown }).name !== "string" ||
    !(mutation as { name: string }).name ||
    !Object.hasOwn(mutation, "target") ||
    !Object.hasOwn(mutation, "apply") ||
    !Object.hasOwn(mutation, "rollback") ||
    typeof (mutation as { apply?: unknown }).apply !== "function" ||
    typeof (mutation as { rollback?: unknown }).rollback !== "function"
  ) {
    throw new TypeError(
      "Every switch mutation must provide a target plus apply and rollback functions before it can run.",
    );
  }
  const target = (mutation as { target: JournalMutationTarget }).target;
  assertValidJournalMutationTarget(layout, target);
  const hasPreApplyMarker = Object.hasOwn(mutation, "markTargetAppliedBeforeApply");
  const marker = (mutation as { markTargetAppliedBeforeApply?: unknown })
    .markTargetAppliedBeforeApply;
  if (
    (hasPreApplyMarker && typeof marker !== "boolean") ||
    (hasPreApplyMarker && target.kind !== "auth")
  ) {
    throw new TypeError("Only auth mutations may use pre-apply target evidence.");
  }
}

interface ProgressEmitter {
  emit(updates: readonly ProgressUpdate[]): void;
}

function createProgressEmitter(
  onProgress: ((event: ProgressEvent) => void) | undefined,
  signal?: AbortSignal,
): ProgressEmitter {
  const updates: ProgressUpdate[] = [];
  return {
    emit(nextUpdates) {
      if (nextUpdates.length === 0) {
        return;
      }
      const events = mapProgressUpdates([...updates, ...nextUpdates], signal);
      if (!onProgress) {
        return;
      }
      const start = updates.length;
      updates.push(...nextUpdates);
      for (const event of events.slice(start)) {
        onProgress(event);
      }
    },
  };
}

function normalizeScanProgressUpdate(
  updateOrCompleted: ScanProgressUpdate | number,
  total: number | undefined,
): ProgressUpdate {
  if (typeof updateOrCompleted === "number") {
    return {
      stage: "scan",
      completed: updateOrCompleted,
      ...(total === undefined ? {} : { total }),
    };
  }
  return {
    stage: "scan",
    completed: updateOrCompleted.completed,
    ...(updateOrCompleted.total === undefined ? {} : { total: updateOrCompleted.total }),
  };
}

const mutationPlanKeys = ["rollouts", "sqlite", "commit", "noOp"] as const;
const mutationPlanStages = ["rollouts", "sqlite", "commit"] as const;
const allowedMutationKinds = {
  rollouts: ["rollout"],
  sqlite: ["sqlite"],
  commit: ["config", "auth"],
} as const;

function validateMutationPlan(value: unknown, layout: CodexLayout): SwitchMutationPlan {
  if (!isPlainObject(value) || !hasOnlyMutationPlanKeys(value)) {
    throw new TypeError("The switch mutation plan is invalid.");
  }
  if (
    !mutationPlanStages.every((stage) => (
      Object.hasOwn(value, stage) && Array.isArray(value[stage])
    )) ||
    (Object.hasOwn(value, "noOp") && typeof value.noOp !== "boolean")
  ) {
    throw new TypeError("The switch mutation plan is invalid.");
  }

  const noOp = value.noOp === true ? true : value.noOp === false ? false : undefined;
  const mutationPlan: SwitchMutationPlan = {
    rollouts: value.rollouts as readonly PreparedSwitchMutation[],
    sqlite: value.sqlite as readonly PreparedSwitchMutation[],
    commit: value.commit as readonly PreparedSwitchMutation[],
    ...(noOp === undefined ? {} : { noOp }),
  };
  for (const stage of mutationPlanStages) {
    for (const mutation of mutationPlan[stage]) {
      assertCompensableMutation(mutation, layout);
      assertMutationAllowedInStage(stage, mutation);
    }
  }
  const hasMutations = mutationPlanStages.some(
    (stage) => mutationPlan[stage].length > 0,
  );
  if (hasMutations ? mutationPlan.noOp === true : mutationPlan.noOp !== true) {
    throw new TypeError("The switch mutation plan is invalid.");
  }
  return mutationPlan;
}

function assertMutationAllowedInStage(
  stage: ProgressStage,
  mutation: PreparedSwitchMutation,
): void {
  if (
    !(stage in allowedMutationKinds) ||
    !(allowedMutationKinds[stage as keyof typeof allowedMutationKinds] as readonly string[])
      .includes(mutation.target.kind)
  ) {
    throw new TypeError("The switch mutation target is assigned to the wrong stage.");
  }
}

function assertAuthPlanCanBeRestored(
  mutationPlan: SwitchMutationPlan,
  restoreAuthMode: SwitchDependencies["restoreAuthMode"],
): void {
  if (restoreAuthMode || !mutationPlanStages.some((stage) => (
    mutationPlan[stage].some(isAuthMutation)
  ))) {
    return;
  }
  throw new TypeError("An auth mutation requires an auth mode restorer.");
}

function isAuthMutation(mutation: unknown): boolean {
  if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) {
    return false;
  }
  const target = (mutation as { target?: unknown }).target;
  return (
    !!target &&
    typeof target === "object" &&
    !Array.isArray(target) &&
    (target as { kind?: unknown }).kind === "auth"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyMutationPlanKeys(value: Record<string, unknown>): boolean {
  return Reflect.ownKeys(value).every((key) => (
    typeof key === "string" && mutationPlanKeys.includes(key as typeof mutationPlanKeys[number])
  ));
}
