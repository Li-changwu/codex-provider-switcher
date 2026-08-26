import assert from "node:assert/strict";
import test from "node:test";
import {
  mapProgressUpdates,
  progressStages,
  ProgressCancelledError,
  type ProgressUpdate,
} from "../../src/ui/progress";

test("maps stages in order and never decreases known percentages", () => {
  const updates: ProgressUpdate[] = progressStages.map((stage, index) => ({
    stage,
    completed: index + 1,
    total: progressStages.length,
  }));

  const events = mapProgressUpdates(updates);

  assert.deepEqual(
    events.map((event) => event.stage),
    progressStages,
  );
  const percentages = events.flatMap((event) =>
    event.percentage === undefined ? [] : [event.percentage],
  );
  assert.deepEqual(
    percentages,
    [...percentages].sort((left, right) => left - right),
  );
});

test("marks an unknown scan total as indeterminate", () => {
  const [event] = mapProgressUpdates([
    { stage: "scan", completed: 4 },
  ]);

  assert.equal(event.indeterminate, true);
  assert.equal(event.percentage, undefined);
});

test("propagates cancellation before producing later progress events", () => {
  const controller = new AbortController();
  controller.abort();

  assert.throws(
    () => mapProgressUpdates([{ stage: "preflight", completed: 1, total: 1 }], controller.signal),
    (error: unknown) => error instanceof ProgressCancelledError,
  );
});
