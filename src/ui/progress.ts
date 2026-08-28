export const progressStages = [
  "preflight",
  "backup",
  "scan",
  "rollouts",
  "sqlite",
  "verify",
  "commit",
] as const;

export type ProgressStage = (typeof progressStages)[number];

export interface ProgressUpdate {
  stage: ProgressStage;
  completed: number;
  total?: number;
}

export interface ProgressEvent {
  stage: ProgressStage;
  index: number;
  completed: number;
  total?: number;
  percentage?: number;
  indeterminate: boolean;
}

export class ProgressCancelledError extends Error {
  constructor() {
    super("The operation was cancelled.");
    this.name = "AbortError";
  }
}

export function mapProgressUpdates(
  updates: readonly ProgressUpdate[],
  signal?: AbortSignal,
): ProgressEvent[] {
  let previousPercentage = 0;
  let previousIndex = -1;
  const events: ProgressEvent[] = [];
  for (const update of updates) {
    throwIfProgressCancelled(signal);
    const index = progressStages.indexOf(update.stage);
    if (index < 0 || index < previousIndex) {
      throw new Error("Progress stages must be emitted in order.");
    }
    previousIndex = index;
    const total = validTotal(update.total);
    if (total === undefined) {
      events.push({
        stage: update.stage,
        index,
        completed: update.completed,
        total: update.total,
        indeterminate: true,
      });
      continue;
    }
    const fraction = clamp(update.completed / total, 0, 1);
    const rawPercentage = ((index + fraction) / progressStages.length) * 100;
    const percentage = Math.max(previousPercentage, rawPercentage);
    previousPercentage = percentage;
    events.push({
      stage: update.stage,
      index,
      completed: update.completed,
      total,
      percentage,
      indeterminate: false,
    });
  }
  return events;
}

export function throwIfProgressCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ProgressCancelledError();
  }
}

function validTotal(total: number | undefined): number | undefined {
  return total !== undefined && Number.isFinite(total) && total > 0 ? total : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
