import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  applyRolloutChanges,
  collectRolloutChanges,
  createRolloutInversePatches,
} from "../../src/core/rollouts";
import {
  switchProfile,
  type PreparedSwitchMutation,
  type SwitchDependencies,
} from "../../src/core/switch-service";
import {
  beginTransaction,
  operationLockPath,
  readTransactionJournal,
  recoverPendingSwitches,
  TransactionError,
} from "../../src/core/transaction";
import type { CodexLayout } from "../../src/core/types";

test("prepares a planned mutation before its apply writes visible state", async () => {
  await withLayout(async (layout) => {
    let context: { transaction: { journalPath: string } } | undefined;
    let applied = false;
    let journalStates: string[] = [];
    const mutation: PreparedSwitchMutation = {
      name: "config",
      target: { kind: "config", path: layout.configPath },
      apply: async () => {
        journalStates = (await readTransactionJournal(context!.transaction.journalPath))
          .flatMap((entry) => entry.pendingTargets ?? [])
          .map((target) => target.kind);
        applied = true;
        await writeFile(layout.configPath, "changed", "utf8");
      },
      rollback: async () => writeFile(layout.configPath, "before", "utf8"),
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        preflight: async (stageContext) => {
          context = stageContext;
        },
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [mutation],
        },
      }),
    );

    assert.equal(result.status, "committed");
    assert.equal(applied, true);
    assert.deepEqual(journalStates, ["config"]);
    assert.equal(await readFile(layout.configPath, "utf8"), "changed");
  });
});

test("starts generic switches with a durable strict source-version journal", async () => {
  await withLayout(async (layout) => {
    let journalPath: string | undefined;

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        preflight: async (context) => {
          journalPath = context.transaction.journalPath;
        },
      }),
    );

    assert.equal(result.status, "committed");
    assert.equal(journalPath === undefined, false);
    assert.equal(
      (await readTransactionJournal(journalPath!))[0]?.sourceVersionProtocol,
      true,
    );
  });
});

test("materializes a missing config when its durable backup selection records nonexistence", async () => {
  await withLayout(async (layout) => {
    await rm(layout.configPath);
    const mutation: PreparedSwitchMutation = {
      name: "materialize config",
      target: { kind: "config", path: layout.configPath },
      apply: async () => writeFile(layout.configPath, "new config", "utf8"),
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        backup: async () => [{ kind: "config", path: layout.configPath }],
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [mutation],
        },
      }),
    );

    assert.equal(result.status, "committed");
    assert.equal(await readFile(layout.configPath, "utf8"), "new config");
  });
});

test("does not apply a config mutation when no durable byte backup was selected", async () => {
  await withLayout(async (layout) => {
    let applied = false;
    const mutation: PreparedSwitchMutation = {
      name: "config without backup",
      target: { kind: "config", path: layout.configPath },
      apply: async () => {
        applied = true;
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        backup: async () => [],
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [mutation],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(applied, false);
  });
});

test("does not apply a config mutation when only an unrelated SQLite byte backup was selected", async () => {
  await withLayout(async (layout) => {
    let applied = false;
    const mutation: PreparedSwitchMutation = {
      name: "config without matching backup",
      target: { kind: "config", path: layout.configPath },
      apply: async () => {
        applied = true;
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        backup: async () => [{ kind: "sqlite", path: layout.sqlitePath }],
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [mutation],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(applied, false);
  });
});

test("requires recovery when an auth mutation throws after changing auth mode before evidence is recorded", async () => {
  await withLayout(async (layout) => {
    let authMode = "official";
    const mutation: PreparedSwitchMutation = {
      name: "auth",
      target: { kind: "auth", path: layout.authPath, previousMode: "official" },
      apply: async () => {
        authMode = "custom";
        await writeFile(layout.authPath, '{"mode":"custom"}\n', "utf8");
        throw new Error("injected auth failure");
      },
      rollback: async () => {
        authMode = "official";
      },
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        restoreAuthMode: async (target) => {
          authMode = target.previousMode;
        },
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [mutation],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "recoveryRequired");
    assert.equal(authMode, "custom");
    assert.equal(await readFile(layout.authPath, "utf8"), '{"mode":"custom"}\n');
  });
});

test("records auth application before login and refreshes evidence when auth apply fails", async () => {
  await withLayout(async (layout) => {
    let authMode = "official";
    let journalPath: string | undefined;
    const mutation: PreparedSwitchMutation = {
      name: "auth with pre-apply evidence",
      target: { kind: "auth", path: layout.authPath, previousMode: "official" },
      markTargetAppliedBeforeApply: true,
      apply: async () => {
        authMode = "custom";
        await rm(layout.authPath);
        throw new Error("injected auth failure");
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        preflight: async (context) => {
          journalPath = context.transaction.journalPath;
        },
        restoreAuthMode: async (target) => {
          authMode = target.previousMode;
        },
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [mutation],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "rolledBack");
    assert.equal(authMode, "official");
    assert.ok(journalPath);
    const journal = await readTransactionJournal(journalPath);
    assert.ok(journal.some((entry) => entry.appliedTargets?.some((target) => target.kind === "auth")));
  });
});

test("rejects pre-apply target marking for non-auth mutation plans", async () => {
  await withLayout(async (layout) => {
    let preflightCalls = 0;
    let applyCalls = 0;
    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        preflight: async () => {
          preflightCalls += 1;
        },
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [{
            name: "invalid pre-apply config",
            target: { kind: "config", path: layout.configPath },
            markTargetAppliedBeforeApply: true,
            apply: async () => {
              applyCalls += 1;
            },
            rollback: async () => undefined,
          }],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.operationId, "unstarted");
    assert.equal(preflightCalls, 0);
    assert.equal(applyCalls, 0);
  });
});

test("uses the durable transaction rollback when callbacks leave config and SQLite changed", async () => {
  await withLayout(async (layout) => {
    const configMutation: PreparedSwitchMutation = {
      name: "change config",
      target: { kind: "config", path: layout.configPath },
      apply: async () => writeFile(layout.configPath, "changed config", "utf8"),
      rollback: async () => undefined,
    };
    const sqliteMutation: PreparedSwitchMutation = {
      name: "change SQLite",
      target: { kind: "sqlite", path: layout.sqlitePath },
      apply: async () => writeFile(layout.sqlitePath, "changed sqlite", "utf8"),
      rollback: async () => undefined,
    };
    const failingMutation: PreparedSwitchMutation = {
      name: "fail before commit",
      target: { kind: "config", path: layout.configPath },
      apply: async () => {
        throw new Error("injected failure");
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        backup: async () => [
          { kind: "config", path: layout.configPath },
          { kind: "sqlite", path: layout.sqlitePath },
        ],
        mutationPlan: {
          rollouts: [],
          sqlite: [sqliteMutation],
          commit: [configMutation, failingMutation],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "rolledBack");
    assert.equal(await readFile(layout.configPath, "utf8"), "before");
    assert.equal(await readFile(layout.sqlitePath, "utf8"), "before sqlite");
  });
});

test("does not invoke mutation rollback callbacks after durable rollback begins", async () => {
  await withLayout(async (layout) => {
    let rollbackCallbackCalled = false;
    const configMutation: PreparedSwitchMutation = {
      name: "change config",
      target: { kind: "config", path: layout.configPath },
      apply: async () => writeFile(layout.configPath, "changed config", "utf8"),
      rollback: async () => {
        rollbackCallbackCalled = true;
        await writeFile(layout.configPath, "callback overwrite", "utf8");
      },
    };
    const failingMutation: PreparedSwitchMutation = {
      name: "fail before commit",
      target: { kind: "config", path: layout.configPath },
      apply: async () => {
        throw new Error("injected failure");
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [configMutation, failingMutation],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "rolledBack");
    assert.equal(rollbackCallbackCalled, false);
    assert.equal(await readFile(layout.configPath, "utf8"), "before");
  });
});

test("fails closed before mutation when config changes after backup and preserves the external bytes", async () => {
  await withLayout(async (layout) => {
    let configMutationApplied = false;
    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        scan: async () => {
          await writeFile(layout.configPath, "native change after backup", "utf8");
        },
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [{
            name: "materialize config",
            target: { kind: "config", path: layout.configPath },
            apply: async () => {
              configMutationApplied = true;
              await writeFile(layout.configPath, "extension config", "utf8");
            },
            rollback: async () => undefined,
          }],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "recoveryRequired");
    assert.equal(configMutationApplied, false);
    assert.equal(await readFile(layout.configPath, "utf8"), "native change after backup");
  });
});

test("marks recovery required instead of restoring stale config after an external change follows application", async () => {
  await withLayout(async (layout) => {
    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [
            {
              name: "materialize config",
              target: { kind: "config", path: layout.configPath },
              apply: async () => writeFile(layout.configPath, "extension config", "utf8"),
              rollback: async () => undefined,
            },
            {
              name: "external native write and failure",
              target: { kind: "config", path: layout.configPath },
              apply: async () => {
                await writeFile(layout.configPath, "native change after apply", "utf8");
                throw new Error("injected failure after external write");
              },
              rollback: async () => undefined,
            },
          ],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "recoveryRequired");
    assert.equal(await readFile(layout.configPath, "utf8"), "native change after apply");
  });
});

test("marks recovery required when a byte mutation changes config and throws before applied state is recorded", async () => {
  await withLayout(async (layout) => {
    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [{
            name: "partially materialize config",
            target: { kind: "config", path: layout.configPath },
            apply: async () => {
              await writeFile(layout.configPath, "unknown write before failure", "utf8");
              throw new Error("injected failure after config write");
            },
            rollback: async () => undefined,
          }],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "recoveryRequired");
    assert.equal(await readFile(layout.configPath, "utf8"), "unknown write before failure");
  });
});

test("passes a fail-closed publish-boundary assertion to mutation apply", async () => {
  await withLayout(async (layout) => {
    let receivedBoundaryAssertion = false;
    const mutation: PreparedSwitchMutation = {
      name: "materialize config at publish boundary",
      target: { kind: "config", path: layout.configPath },
      apply: async (context) => {
        receivedBoundaryAssertion = typeof context?.assertTargetUnchanged === "function";
        assert.equal(receivedBoundaryAssertion, true);
        await writeFile(layout.configPath, "native bytes at publish boundary", "utf8");
        await context.assertTargetUnchanged();
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [mutation],
        },
      }),
    );

    assert.equal(receivedBoundaryAssertion, true);
    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "recoveryRequired");
    assert.equal(await readFile(layout.configPath, "utf8"), "native bytes at publish boundary");
  });
});

test("records a published rollout before rethrowing its apply failure", async () => {
  await withLayout(async (layout) => {
    const rolloutPath = join(layout.sessionsDir, "one.jsonl");
    await writeFile(
      rolloutPath,
      '{"type":"session_meta","payload":{"id":"one","model_provider":"openai"}}\n',
      "utf8",
    );
    const rolloutBefore = await readFile(rolloutPath, "utf8");
    const [change] = await collectRolloutChanges(layout, "custom");
    assert.ok(change);
    const [inversePatch] = createRolloutInversePatches([change]);
    assert.ok(inversePatch);
    const mutation: PreparedSwitchMutation = {
      name: "publish rollout then fail",
      target: { kind: "rollout", path: change.path, inversePatch },
      apply: async () => {
        await applyRolloutChanges([change]);
        throw new Error("injected failure after rollout publication");
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        mutationPlan: {
          rollouts: [mutation],
          sqlite: [],
          commit: [],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "rolledBack");
    assert.equal(await readFile(rolloutPath, "utf8"), rolloutBefore);
    assert.equal(
      (await readTransactionJournal(
        join(layout.switcherDir, "transactions", result.operationId, "journal.jsonl"),
      )).some((entry) => entry.appliedTargets?.some((target) => target.kind === "rollout")),
      true,
    );
  });
});

test("does not record rollout evidence when inverse validation is already reversed", async () => {
  await withLayout(async (layout) => {
    await writeFile(
      join(layout.sessionsDir, "one.jsonl"),
      '{"type":"session_meta","payload":{"id":"one","model_provider":"openai"}}\n',
      "utf8",
    );
    const [change] = await collectRolloutChanges(layout, "custom");
    assert.ok(change);
    const [inversePatch] = createRolloutInversePatches([change]);
    assert.ok(inversePatch);
    const mutation: PreparedSwitchMutation = {
      name: "fail without publishing rollout",
      target: { kind: "rollout", path: change.path, inversePatch },
      apply: async () => {
        throw new Error("injected rollout failure before publication");
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        mutationPlan: {
          rollouts: [mutation],
          sqlite: [],
          commit: [],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "rolledBack");
    assert.equal(
      (await readTransactionJournal(
        join(layout.switcherDir, "transactions", result.operationId, "journal.jsonl"),
      )).some((entry) => entry.appliedTargets?.some((target) => target.kind === "rollout")),
      false,
    );
  });
});

test("does not record rollout evidence when inverse validation fails", async () => {
  await withLayout(async (layout) => {
    await writeFile(
      join(layout.sessionsDir, "one.jsonl"),
      '{"type":"session_meta","payload":{"id":"one","model_provider":"openai"}}\n',
      "utf8",
    );
    const [change] = await collectRolloutChanges(layout, "custom");
    assert.ok(change);
    const [inversePatch] = createRolloutInversePatches([change]);
    assert.ok(inversePatch);
    const mutation: PreparedSwitchMutation = {
      name: "corrupt rollout then fail",
      target: { kind: "rollout", path: change.path, inversePatch },
      apply: async () => {
        await writeFile(change.path, "not a rollout\n", "utf8");
        throw new Error("injected rollout failure after unknown write");
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        mutationPlan: {
          rollouts: [mutation],
          sqlite: [],
          commit: [],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "recoveryRequired");
    assert.equal(
      (await readTransactionJournal(
        join(layout.switcherDir, "transactions", result.operationId, "journal.jsonl"),
      )).some((entry) => entry.appliedTargets?.some((target) => target.kind === "rollout")),
      false,
    );
  });
});

test("does not invoke a failing mutation rollback callback after durable data changed", async () => {
  await withLayout(async (layout) => {
    let recoveryRequiredPublications = 0;
    const configMutation: PreparedSwitchMutation = {
      name: "change config",
      target: { kind: "config", path: layout.configPath },
      apply: async () => writeFile(layout.configPath, "changed config", "utf8"),
      rollback: async () => {
        throw new Error("injected callback rollback failure");
      },
    };
    const failingMutation: PreparedSwitchMutation = {
      name: "fail before commit",
      target: { kind: "config", path: layout.configPath },
      apply: async () => {
        throw new Error("injected failure");
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        transactionIo: {
          async renameJournal(source: string, destination: string) {
            const records = (await readFile(source, "utf8")).trim().split("\n");
            if (JSON.parse(records.at(-1)!).state === "recoveryRequired") {
              recoveryRequiredPublications += 1;
            }
            await rename(source, destination);
          },
        },
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [configMutation, failingMutation],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "rolledBack");
    assert.equal(recoveryRequiredPublications, 0);
    assert.equal(await readFile(layout.configPath, "utf8"), "before");
    const transactions = await readdir(join(layout.switcherDir, "transactions"), {
      withFileTypes: true,
    });
    const operation = transactions.find((entry) => entry.isDirectory());
    assert.ok(operation);
    const journal = await readTransactionJournal(
      join(layout.switcherDir, "transactions", operation.name, "journal.jsonl"),
    );
    assert.equal(journal.at(-1)?.state, "rolledBack");
  });
});

test("retries recoveryRequired journalling after rollback fails", async () => {
  await withLayout(async (layout) => {
    let authMode = "official";
    let recoveryRequiredPublications = 0;
    const mutation: PreparedSwitchMutation = {
      name: "remove auth then fail",
      target: { kind: "auth", path: layout.authPath, previousMode: "official" },
      markTargetAppliedBeforeApply: true,
      apply: async () => {
        authMode = "custom";
        await rm(layout.authPath);
        throw new Error("injected mutation failure");
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        restoreAuthMode: async () => {
          throw new Error("restore failed");
        },
        transactionIo: {
          async renameJournal(source: string, destination: string) {
            const records = (await readFile(source, "utf8")).trim().split("\n");
            const state = JSON.parse(records.at(-1)!).state;
            if (state === "recoveryRequired") {
              recoveryRequiredPublications += 1;
              if (recoveryRequiredPublications === 1) {
                throw new Error("injected recovery marker publication failure");
              }
            }
            await rename(source, destination);
          },
        },
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [mutation],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "recoveryRequired");
    assert.equal(recoveryRequiredPublications, 2);
    const journal = await readTransactionJournal(join(
      layout.switcherDir,
      "transactions",
      result.operationId,
      "journal.jsonl",
    ));
    assert.equal(journal.at(-1)?.state, "recoveryRequired");
    assert.equal(authMode, "custom");
    await assert.rejects(() => access(layout.authPath), { code: "ENOENT" });
  });
});

test("keeps recovery marker failure diagnostics bounded", async () => {
  await withLayout(async (layout) => {
    const sentinel = "journal-secret-detail";
    let authMode = "official";
    let recoveryRequiredPublications = 0;
    const mutation: PreparedSwitchMutation = {
      name: "remove auth then fail",
      target: { kind: "auth", path: layout.authPath, previousMode: "official" },
      markTargetAppliedBeforeApply: true,
      apply: async () => {
        authMode = "custom";
        await rm(layout.authPath);
        throw new Error("injected mutation failure");
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        restoreAuthMode: async () => {
          throw new Error("restore failed");
        },
        transactionIo: {
          async renameJournal(source: string, destination: string) {
            const records = (await readFile(source, "utf8")).trim().split("\n");
            if (JSON.parse(records.at(-1)!).state === "recoveryRequired") {
              recoveryRequiredPublications += 1;
              throw new Error(sentinel);
            }
            await rename(source, destination);
          },
        },
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [mutation],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "recoveryRequired");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
    assert.equal(authMode, "custom");
    await assert.rejects(() => access(layout.authPath), { code: "ENOENT" });

    const followup = await beginTransaction(layout, { operationId: "after-marker-retry" });
    await followup.release();
    assert.equal(recoveryRequiredPublications, 2);
  });
});

test("reports primary and rollback failures with bounded generic diagnostics", async () => {
  await withLayout(async (layout) => {
    const secret = "sk-switch-service-test-secret";
    const configMutation: PreparedSwitchMutation = {
      name: "change config",
      target: { kind: "config", path: layout.configPath },
      apply: async () => writeFile(layout.configPath, "changed config", "utf8"),
      rollback: async () => {
        throw new AggregateError([
          new Error("rollback failure"),
          new Error(`OPENAI_API_KEY=${secret}`),
        ], "rollback failure");
      },
    };
    const failingMutation: PreparedSwitchMutation = {
      name: "fail before commit",
      target: { kind: "config", path: layout.configPath },
      apply: async () => {
        throw new AggregateError([
          new Error("primary failure"),
          new Error(`transcript=private transcript ${secret}`),
        ], "primary failure");
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [configMutation, failingMutation],
        },
      }),
    );

    const diagnostics = JSON.stringify({
      failureMessage: result.failureMessage,
      errorSummary: result.errorSummary,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.failureMessage, "The provider switch operation failed.");
    assert.equal(result.errorSummary?.errorCode, "switch-operation-failed");
    assert.doesNotMatch(diagnostics, /primary failure/);
    assert.doesNotMatch(diagnostics, /rollback failure/);
    assert.doesNotMatch(diagnostics, new RegExp(secret));
    assert.doesNotMatch(diagnostics, /private transcript/);
  });
});

test("does not expose a high-entropy API key without sensitive keywords", async () => {
  await withLayout(async (layout) => {
    const apiKey = "abcDEFghiJKL1234567890";

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        preflight: async () => {
          throw new Error(apiKey);
        },
      }),
    );

    const publicResult = JSON.stringify(result);
    assert.equal(result.status, "failed");
    assert.doesNotMatch(publicResult, new RegExp(apiKey));
    assert.equal(result.errorSummary?.errorCode, "switch-operation-failed");
  });
});

test("rejects an auth plan without a durable auth restorer before it can apply", async () => {
  await withLayout(async (layout) => {
    let applied = false;
    const authMutation: PreparedSwitchMutation = {
      name: "activate auth",
      target: { kind: "auth", path: layout.authPath, previousMode: "official" },
      apply: async () => {
        applied = true;
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [authMutation],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(applied, false);
  });
});

test("rejects missing, malformed, and unmarked empty mutation plans before preflight", async () => {
  const invalidPlans: unknown[] = [
    undefined,
    null,
    { rollouts: [], sqlite: [], commit: [] },
    { rollouts: [], sqlite: [], commit: "not-an-array" },
  ];

  for (const mutationPlan of invalidPlans) {
    await withLayout(async (layout) => {
      let preflightCalls = 0;
      const result = await switchProfile(
        { targetProfileId: "target" },
        dependencies(layout, {
          preflight: async () => {
            preflightCalls += 1;
          },
          mutationPlan,
        }),
      );

      assert.equal(result.status, "failed");
      assert.equal(result.operationId, "unstarted");
      assert.equal(result.journalState, undefined);
      assert.equal(preflightCalls, 0);
    });
  }
});

test("rejects malformed mutation items before preflight, recovery, or journalling", async () => {
  const malformedItems: unknown[] = [
    { target: { kind: "config", path: "config.toml" }, apply: async () => undefined, rollback: async () => undefined },
    { name: 42, target: { kind: "config", path: "config.toml" }, apply: async () => undefined, rollback: async () => undefined },
    { name: "missing target", apply: async () => undefined, rollback: async () => undefined },
    { name: "missing apply", target: { kind: "config", path: "config.toml" }, rollback: async () => undefined },
    { name: "missing rollback", target: { kind: "config", path: "config.toml" }, apply: async () => undefined },
    { name: "invalid target", target: { kind: "config", path: "not-config.toml" }, apply: async () => undefined, rollback: async () => undefined },
  ];

  for (const item of malformedItems) {
    await withLayout(async (layout) => {
      let preflightCalls = 0;
      const result = await switchProfile(
        { targetProfileId: "target" },
        dependencies(layout, {
          preflight: async () => {
            preflightCalls += 1;
          },
          mutationPlan: {
            rollouts: [item],
            sqlite: [],
            commit: [],
          },
        }),
      );

      assert.equal(result.status, "failed");
      assert.equal(result.operationId, "unstarted");
      assert.equal(result.journalState, undefined);
      assert.equal(preflightCalls, 0);
      let journalCount = 0;
      try {
        const entries = await readdir(join(layout.switcherDir, "transactions"), { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) {
            continue;
          }
          try {
            await access(join(layout.switcherDir, "transactions", entry.name, "journal.jsonl"));
            journalCount += 1;
          } catch {
            // Ignore the operation lock and any incomplete transaction directory.
          }
        }
      } catch {
        // No recovery or transaction directory is also a valid preflight result.
      }
      assert.equal(journalCount, 0);
    });
  }
});

test("rejects invalid auth metadata before preflight, mutation, or journalling", async () => {
  const invalidTargets: ReadonlyArray<Record<string, unknown>> = [
    { kind: "auth", previousMode: "official", customProfileId: "must-not-exist" },
    { kind: "auth", previousMode: "custom", customProfileId: "not normalized" },
    { kind: "auth", previousMode: "custom" },
  ];

  for (const target of invalidTargets) {
    await withLayout(async (layout) => {
      let preflightCalls = 0;
      let applyCalls = 0;
      const result = await switchProfile(
        { targetProfileId: "target" },
        dependencies(layout, {
          preflight: async () => {
            preflightCalls += 1;
          },
          restoreAuthMode: async () => undefined,
          mutationPlan: {
            rollouts: [],
            sqlite: [],
            commit: [{
              name: "invalid auth metadata",
              target: { ...target, path: layout.authPath },
              apply: async () => {
                applyCalls += 1;
              },
              rollback: async () => undefined,
            }],
          },
        }),
      );

      assert.equal(result.status, "failed");
      assert.equal(result.operationId, "unstarted");
      assert.equal(preflightCalls, 0);
      assert.equal(applyCalls, 0);
      await assert.rejects(
        () => access(join(layout.switcherDir, "transactions")),
        { code: "ENOENT" },
      );
    });
  }
});

test("rejects mutation targets assigned to the wrong switch stage", async () => {
  const cases = [
    { stage: "rollouts", kind: "config" },
    { stage: "rollouts", kind: "sqlite" },
    { stage: "rollouts", kind: "auth" },
    { stage: "sqlite", kind: "config" },
    { stage: "sqlite", kind: "rollout" },
    { stage: "sqlite", kind: "auth" },
    { stage: "commit", kind: "rollout" },
    { stage: "commit", kind: "sqlite" },
  ] as const;

  for (const testCase of cases) {
    await withLayout(async (layout) => {
      const rolloutPath = join(layout.sessionsDir, "mis-staged.jsonl");
      await writeFile(
        rolloutPath,
        '{"type":"session_meta","payload":{"id":"mis-staged","model_provider":"openai"}}\n',
        "utf8",
      );
      const [rolloutChange] = await collectRolloutChanges(layout, "custom");
      assert.ok(rolloutChange);
      const [inversePatch] = createRolloutInversePatches([rolloutChange]);
      assert.ok(inversePatch);
      const targets = {
        config: { kind: "config", path: layout.configPath },
        sqlite: { kind: "sqlite", path: layout.sqlitePath },
        auth: { kind: "auth", path: layout.authPath, previousMode: "official" },
        rollout: { kind: "rollout", path: rolloutPath, inversePatch },
      } as const;
      let preflightCalls = 0;
      let applyCalls = 0;
      const mutation = {
        name: `mis-staged ${testCase.kind}`,
        target: targets[testCase.kind],
        apply: async () => {
          applyCalls += 1;
        },
        rollback: async () => undefined,
      };
      const mutationPlan = {
        rollouts: testCase.stage === "rollouts" ? [mutation] : [],
        sqlite: testCase.stage === "sqlite" ? [mutation] : [],
        commit: testCase.stage === "commit" ? [mutation] : [],
      };

      const result = await switchProfile(
        { targetProfileId: "target" },
        dependencies(layout, {
          preflight: async () => {
            preflightCalls += 1;
          },
          restoreAuthMode: async () => undefined,
          mutationPlan,
        }),
      );

      assert.equal(result.status, "failed", `${testCase.kind} in ${testCase.stage}`);
      assert.equal(result.operationId, "unstarted", `${testCase.kind} in ${testCase.stage}`);
      assert.equal(preflightCalls, 0, `${testCase.kind} in ${testCase.stage}`);
      assert.equal(applyCalls, 0, `${testCase.kind} in ${testCase.stage}`);
    });
  }
});

test("applies config and auth commit mutations only after verify", async () => {
  await withLayout(async (layout) => {
    const apiKey = "commit-stage-api-key";
    let verified = false;
    const appliedAfterVerify: boolean[] = [];
    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        verify: async () => {
          verified = true;
        },
        restoreAuthMode: async () => undefined,
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [
            {
              name: "commit config",
              target: { kind: "config", path: layout.configPath },
              apply: async () => {
                appliedAfterVerify.push(verified);
                await writeFile(layout.configPath, "committed config", "utf8");
              },
              rollback: async () => writeFile(layout.configPath, "before", "utf8"),
            },
            {
              name: "commit auth",
              target: { kind: "auth", path: layout.authPath, previousMode: "official" },
              apply: async () => {
                appliedAfterVerify.push(verified);
                await writeFile(layout.authPath, JSON.stringify({ OPENAI_API_KEY: apiKey }), "utf8");
              },
              rollback: async () => rm(layout.authPath, { force: true }),
            },
          ],
        },
      }),
    );

    assert.equal(result.status, "committed");
    assert.deepEqual(appliedAfterVerify, [true, true]);
    const journalPath = join(
      layout.switcherDir,
      "transactions",
      result.operationId,
      "journal.jsonl",
    );
    const journal = await readFile(journalPath, "utf8");
    const authTargets = (await readTransactionJournal(journalPath))
      .flatMap((entry) => [...(entry.pendingTargets ?? []), ...(entry.appliedTargets ?? [])])
      .filter((target) => target.kind === "auth");
    assert.equal(authTargets.every((target) => target.path === layout.authPath), true);
    assert.equal(authTargets.length, 2);
    assert.doesNotMatch(journal, new RegExp(apiKey));
  });
});

test("rejects an uppercase custom profile ID at mutation-plan validation", async () => {
  await assertInvalidCustomProfileIdRejectedByMutationPlan("Research-Proxy");
});

test("rejects an underscored custom profile ID at mutation-plan validation", async () => {
  await assertInvalidCustomProfileIdRejectedByMutationPlan("research_proxy");
});

test("rejects a dotted custom profile ID at mutation-plan validation", async () => {
  await assertInvalidCustomProfileIdRejectedByMutationPlan("research.proxy");
});

test("reports an ordinary preflight failure with its rolled-back transaction", async () => {
  await withLayout(async (layout) => {
    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        preflight: async () => {
          throw new Error("ordinary preflight failure");
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.notEqual(result.operationId, "unstarted");
    assert.equal(result.journalState, "rolledBack");
    assert.equal(result.errorSummary?.errorCode, "switch-operation-failed");
    assert.doesNotMatch(JSON.stringify(result), /recoveryRequired/);
  });
});

test("reports an already aborted switch as cancelled without invoking preflight", async () => {
  await withLayout(async (layout) => {
    const controller = new AbortController();
    controller.abort();
    let preflightCalls = 0;

    const result = await switchProfile(
      { targetProfileId: "target", signal: controller.signal },
      dependencies(layout, {
        preflight: async () => {
          preflightCalls += 1;
        },
      }),
    );

    assert.equal(result.status, "cancelled");
    assert.equal(result.journalState, undefined);
    assert.equal(preflightCalls, 0);
    await assert.rejects(
      () => access(join(layout.switcherDir, "transactions")),
      { code: "ENOENT" },
    );
  });
});

test("provides a live indeterminate scan progress reporter", async () => {
  await withLayout(async (layout) => {
    let receivedReporter = false;
    const events: Array<{ stage: string; indeterminate: boolean }> = [];

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        scan: async (_context, reportProgress: unknown) => {
          receivedReporter = typeof reportProgress === "function";
          if (typeof reportProgress === "function") {
            reportProgress({ completed: 4 });
          }
        },
        onProgress: (event) => events.push(event),
      }),
    );

    assert.equal(result.status, "committed");
    assert.equal(receivedReporter, true);
    assert.equal(events.some((event) => event.stage === "scan" && event.indeterminate), true);
  });
});

test("stops a live scan reporter immediately after cancellation and rolls back before returning", async () => {
  await withLayout(async (layout) => {
    const controller = new AbortController();
    let reporterThrew = false;

    const result = await switchProfile(
      { targetProfileId: "target", signal: controller.signal },
      dependencies(layout, {
        scan: async (_context, reportProgress) => {
          reportProgress({ completed: 1, total: 2 });
          controller.abort();
          assert.throws(
            () => reportProgress({ completed: 2, total: 2 }),
            (error: unknown) => error instanceof Error && error.name === "AbortError",
          );
          reporterThrew = true;
        },
      }),
    );

    assert.equal(reporterThrew, true);
    assert.equal(result.status, "cancelled");
    assert.equal(result.journalState, "rolledBack");
    const journal = await readTransactionJournal(join(
      layout.switcherDir,
      "transactions",
      result.operationId,
      "journal.jsonl",
    ));
    assert.equal(journal.at(-1)?.state, "rolledBack");
  });
});

test("reports failed when cancellation cannot reach a rolledBack terminal state", async () => {
  await withLayout(async (layout) => {
    const controller = new AbortController();
    const mutation: PreparedSwitchMutation = {
      name: "cancel with failed durable rollback",
      target: { kind: "config", path: layout.configPath },
      apply: async () => {
        await writeFile(layout.configPath, "changed before cancellation", "utf8");
        controller.abort();
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "target", signal: controller.signal },
      dependencies(layout, {
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [mutation],
        },
        transactionIo: {
          beforeRestoreTemporaryCreate: async () => {
            throw new Error("injected durable rollback failure after cancellation");
          },
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "recoveryRequired");
    assert.equal(await readFile(layout.configPath, "utf8"), "changed before cancellation");
  });
});

test("recovers a pending applying transaction before the new switch starts", async () => {
  await withLayout(async (layout) => {
    const staleOperationId = "stale-before-switch";
    const stale = await beginTransaction(layout, { operationId: staleOperationId });
    await stale.backupTargets([{ kind: "config", path: layout.configPath }]);
    await stale.markApplying([{ kind: "config", path: layout.configPath }]);
    await writeFile(layout.configPath, "stale changed config", "utf8");
    await stale.release();

    let preflightSawRecovery = false;
    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        preflight: async () => {
          const journal = await readTransactionJournal(stale.journalPath);
          preflightSawRecovery = journal.at(-1)?.state === "rolledBack" &&
            await readFile(layout.configPath, "utf8") === "before";
        },
      }),
    );

    assert.equal(result.status, "committed");
    assert.equal(preflightSawRecovery, true);
  });
});

test("uses one operation lock lifecycle for recovery and the new switch", async () => {
  await withLayout(async (layout) => {
    const lockEvents: string[] = [];

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        transactionIo: {
          async writeLock(handle, contents) {
            lockEvents.push("acquire");
            await handle.writeFile(contents, "utf8");
          },
          async releaseLock(path) {
            lockEvents.push("release");
            await rm(path);
          },
        },
      }),
    );

    assert.equal(result.status, "committed");
    assert.deepEqual(lockEvents, ["acquire", "release"]);
  });
});

test("refuses a concurrent begin while the atomic switch operation is active", async () => {
  await withLayout(async (layout) => {
    let enterPreflight!: () => void;
    let finishPreflight!: () => void;
    const preflightEntered = new Promise<void>((resolve) => {
      enterPreflight = resolve;
    });
    const preflightBarrier = new Promise<void>((resolve) => {
      finishPreflight = resolve;
    });
    const switching = switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        preflight: async () => {
          enterPreflight();
          await preflightBarrier;
        },
      }),
    );

    await preflightEntered;
    await assert.rejects(
      () => beginTransaction(layout, { operationId: "concurrent-begin" }),
      (error: unknown) => error instanceof TransactionError && error.code === "lock-held",
    );
    finishPreflight();

    assert.equal((await switching).status, "committed");
  });
});

test("keeps the operation lock through acknowledgement so later switches cannot overwrite active state out of order", async () => {
  await withLayout(async (layout) => {
    let releaseAcknowledgement!: () => void;
    let acknowledgeAEntered!: () => void;
    const acknowledgementAEntered = new Promise<void>((resolve) => {
      acknowledgeAEntered = resolve;
    });
    const acknowledgementABarrier = new Promise<void>((resolve) => {
      releaseAcknowledgement = resolve;
    });
    let activeProfile = "before";
    const switchA = switchProfile(
      { targetProfileId: "profile-a" },
      dependencies(layout, {
        acknowledge: async () => {
          acknowledgeAEntered();
          await acknowledgementABarrier;
          activeProfile = "profile-a";
        },
      }),
    );

    await acknowledgementAEntered;
    const blockedB = await switchProfile(
      { targetProfileId: "profile-b" },
      dependencies(layout, {
        acknowledge: async () => {
          activeProfile = "profile-b";
        },
      }),
    );
    assert.equal(blockedB.status, "failed");
    assert.equal(blockedB.operationId, "unstarted");
    assert.equal(activeProfile, "before");

    releaseAcknowledgement();
    assert.equal((await switchA).status, "committed");
    const completedB = await switchProfile(
      { targetProfileId: "profile-b" },
      dependencies(layout, {
        acknowledge: async () => {
          activeProfile = "profile-b";
        },
      }),
    );
    assert.equal(completedB.status, "committed");
    assert.equal(activeProfile, "profile-b");
  });
});

test("recoveryRequired stops before preflight and releases the operation lock", async () => {
  await withLayout(async (layout) => {
    const blockedOperationId = "operator-recovery-required";
    const blocked = await beginTransaction(layout, { operationId: blockedOperationId });
    await blocked.markRecoveryRequired();
    await blocked.release();
    let preflightCalls = 0;
    const lockEvents: string[] = [];

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        preflight: async () => {
          preflightCalls += 1;
        },
        transactionIo: {
          async writeLock(handle, contents) {
            lockEvents.push("acquire");
            await handle.writeFile(contents, "utf8");
          },
          async releaseLock(path) {
            lockEvents.push("release");
            await rm(path);
          },
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.operationId, "unstarted");
    assert.equal(result.journalState, "recoveryRequired");
    assert.equal(preflightCalls, 0);
    assert.deepEqual(lockEvents, ["acquire", "release"]);
    const operatorRecovery = await recoverPendingSwitches(layout);
    assert.deepEqual(operatorRecovery.recoveryRequiredOperationIds, [blockedOperationId]);
  });
});

test("reports a committed lock release failure without compensating committed state", async () => {
  await withLayout(async (layout) => {
    let rollbackCalls = 0;
    const mutation: PreparedSwitchMutation = {
      name: "commit config",
      target: { kind: "config", path: layout.configPath },
      apply: async () => writeFile(layout.configPath, "committed state", "utf8"),
      rollback: async () => {
        rollbackCalls += 1;
        await writeFile(layout.configPath, "before", "utf8");
      },
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        verify: async () => {
          const lockPath = operationLockPath(layout);
          await rm(lockPath);
          await writeFile(lockPath, JSON.stringify({
            pid: process.pid,
            operationId: "different-owner",
            createdAt: 0,
          }), "utf8");
        },
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [mutation],
        },
      }),
    );

    assert.equal(result.status, "committed");
    assert.equal(result.journalState, "committed");
    assert.equal(result.lockReleaseFailed, true);
    assert.equal(rollbackCalls, 0);
    assert.equal(await readFile(layout.configPath, "utf8"), "committed state");
    const journal = await readTransactionJournal(join(
      layout.switcherDir,
      "transactions",
      result.operationId,
      "journal.jsonl",
    ));
    assert.equal(journal.at(-1)?.state, "committed");
  });
});

test("reports a visible commit directory-sync failure as a bounded committed warning", async () => {
  await withLayout(async (layout) => {
    let context: {
      transaction: { journalPath: string; operationId: string };
    } | undefined;
    let rollbackCalls = 0;
    const secret = "secret commit sync diagnostic";
    const mutation: PreparedSwitchMutation = {
      name: "commit config",
      target: { kind: "config", path: layout.configPath },
      apply: async () => writeFile(layout.configPath, "committed state", "utf8"),
      rollback: async () => {
        rollbackCalls += 1;
        await writeFile(layout.configPath, "before", "utf8");
      },
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        preflight: async (stageContext) => {
          context = stageContext;
        },
        transactionIo: {
          async syncDirectory(path: string) {
            if (!context) {
              return;
            }
            const transaction = context.transaction;
            if (
              path !== join(layout.switcherDir, "transactions", transaction.operationId)
            ) {
              return;
            }
            const journal = await readTransactionJournal(transaction.journalPath);
            if (journal.at(-1)?.state === "committed") {
              throw new Error(secret);
            }
          },
        },
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [mutation],
        },
      }),
    );

    assert.equal(result.status, "committed");
    assert.equal(result.journalState, "committed");
    assert.equal(result.commitDurabilityWarning, true);
    assert.equal(rollbackCalls, 0);
    assert.equal(await readFile(layout.configPath, "utf8"), "committed state");
    assert.equal(
      (await readTransactionJournal(context!.transaction.journalPath)).at(-1)?.state,
      "committed",
    );
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(result), /recoveryRequired/);
  });
});

test("keeps a visibly committed journal committed when cleanup also fails", async () => {
  await withLayout(async (layout) => {
    let context: {
      transaction: { journalPath: string; operationId: string };
    } | undefined;
    const syncError = new Error("secret committed journal sync failure");
    const cleanupError = new Error("secret committed journal cleanup failure");
    let rollbackCalls = 0;
    const mutation: PreparedSwitchMutation = {
      name: "commit config",
      target: { kind: "config", path: layout.configPath },
      apply: async () => writeFile(layout.configPath, "committed state", "utf8"),
      rollback: async () => {
        rollbackCalls += 1;
        await writeFile(layout.configPath, "before", "utf8");
      },
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        preflight: async (stageContext) => {
          context = stageContext;
        },
        transactionIo: {
          async syncDirectory(path: string) {
            if (!context || path !== dirname(context.transaction.journalPath)) {
              return;
            }
            const journal = await readTransactionJournal(context.transaction.journalPath);
            if (journal.at(-1)?.state === "committed") {
              throw syncError;
            }
          },
          async removeJournalTemporary() {
            throw cleanupError;
          },
        },
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [mutation],
        },
      }),
    );

    assert.equal(result.status, "committed");
    assert.equal(result.journalState, "committed");
    assert.equal(result.commitDurabilityWarning, true);
    assert.equal(rollbackCalls, 0);
    assert.equal(await readFile(layout.configPath, "utf8"), "committed state");
    assert.equal(
      (await readTransactionJournal(context!.transaction.journalPath)).at(-1)?.state,
      "committed",
    );
    assert.doesNotMatch(JSON.stringify(result), /secret committed journal (sync|cleanup) failure/);
  });
});

test("does not compensate or report committed after a post-rename journal change", async () => {
  await withLayout(async (layout) => {
    let context: {
      transaction: { journalPath: string; operationId: string };
    } | undefined;
    let rollbackCalls = 0;
    let journalChanged = false;
    const syncError = new Error("injected parent sync failure after journal replacement");
    const mutation: PreparedSwitchMutation = {
      name: "commit config",
      target: { kind: "config", path: layout.configPath },
      apply: async () => writeFile(layout.configPath, "committed state", "utf8"),
      rollback: async () => {
        rollbackCalls += 1;
        await writeFile(layout.configPath, "before", "utf8");
      },
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        preflight: async (stageContext) => {
          context = stageContext;
        },
        transactionIo: {
          async renameJournal(source: string, destination: string) {
            const records = (await readFile(source, "utf8")).trim().split("\n");
            const state = JSON.parse(records.at(-1)!).state;
            await rename(source, destination);
            if (state === "committed") {
              await writeFile(destination, `${JSON.stringify({
                version: 1,
                operationId: context!.transaction.operationId,
                state: "prepared",
                timestamp: "2026-08-26T00:00:00.000Z",
              })}\n`, "utf8");
              journalChanged = true;
            }
          },
          async syncDirectory(path: string) {
            if (
              journalChanged &&
              path === join(layout.switcherDir, "transactions", context!.transaction.operationId)
            ) {
              throw syncError;
            }
          },
        },
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [mutation],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "recoveryRequired");
    assert.equal(result.commitDurabilityWarning, undefined);
    assert.equal(rollbackCalls, 0);
    assert.equal(await readFile(layout.configPath, "utf8"), "committed state");
    assert.equal(
      (await readTransactionJournal(context!.transaction.journalPath)).at(-1)?.state,
      "prepared",
    );
  });
});

test("does not trust an identical committed journal after its operation directory is replaced", async () => {
  await withLayout(async (layout) => {
    let context: {
      transaction: { journalPath: string; operationId: string };
    } | undefined;
    let operationDirectoryReplaced = false;
    let rollbackCalls = 0;
    const syncError = new Error("secret sync failure after operation directory replacement");
    const movedDirectory = join(layout.codexHome, "moved-committed-operation");
    const mutation: PreparedSwitchMutation = {
      name: "commit config",
      target: { kind: "config", path: layout.configPath },
      apply: async () => writeFile(layout.configPath, "committed state", "utf8"),
      rollback: async () => {
        rollbackCalls += 1;
        await writeFile(layout.configPath, "before", "utf8");
      },
    };

    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        preflight: async (stageContext) => {
          context = stageContext;
        },
        transactionIo: {
          async renameJournal(source: string, destination: string) {
            const records = (await readFile(source, "utf8")).trim().split("\n");
            const state = JSON.parse(records.at(-1)!).state;
            await rename(source, destination);
            if (state !== "committed") {
              return;
            }
            const identicalJournal = await readFile(destination);
            const operationDirectory = dirname(destination);
            await rename(operationDirectory, movedDirectory);
            await mkdir(operationDirectory);
            await writeFile(destination, identicalJournal);
            operationDirectoryReplaced = true;
          },
          async syncDirectory(path: string) {
            if (
              operationDirectoryReplaced &&
              context &&
              path === dirname(context.transaction.journalPath)
            ) {
              throw syncError;
            }
          },
        },
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [mutation],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "recoveryRequired");
    assert.equal(result.commitDurabilityWarning, undefined);
    assert.equal(rollbackCalls, 0);
    assert.equal(await readFile(layout.configPath, "utf8"), "committed state");
    assert.doesNotMatch(JSON.stringify(result), /secret sync failure after operation directory replacement/);
  });
});

function dependencies(
  layout: CodexLayout,
  overrides: Record<string, unknown> = {},
): SwitchDependencies {
  return {
    layout,
    preflight: async () => undefined,
    backup: async () => [{ kind: "config", path: layout.configPath }],
    scan: async () => undefined,
    mutationPlan: {
      noOp: true,
      rollouts: [],
      sqlite: [],
      commit: [],
    },
    verify: async () => undefined,
    ...overrides,
  } as unknown as SwitchDependencies;
}

async function assertInvalidCustomProfileIdRejectedByMutationPlan(
  customProfileId: string,
): Promise<void> {
  await withLayout(async (layout) => {
    let preflightCalls = 0;
    let applyCalls = 0;
    const result = await switchProfile(
      { targetProfileId: "target" },
      dependencies(layout, {
        preflight: async () => {
          preflightCalls += 1;
        },
        restoreAuthMode: async () => undefined,
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [{
            name: "invalid custom profile ID",
            target: {
              kind: "auth",
              path: layout.authPath,
              previousMode: "custom",
              customProfileId,
            },
            apply: async () => {
              applyCalls += 1;
            },
            rollback: async () => undefined,
          }],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.operationId, "unstarted");
    assert.equal(result.journalState, undefined);
    assert.equal(preflightCalls, 0);
    assert.equal(applyCalls, 0);
    await assert.rejects(
      () => access(join(layout.switcherDir, "transactions")),
      { code: "ENOENT" },
    );
  });
}

async function withLayout(callback: (layout: CodexLayout) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "switch-service-test-"));
  const layout: CodexLayout = {
    codexHome: root,
    configPath: join(root, "config.toml"),
    authPath: join(root, "auth.json"),
    sessionsDir: join(root, "sessions"),
    archivedSessionsDir: join(root, "archived_sessions"),
    sqlitePath: join(root, "state_5.sqlite"),
    switcherDir: join(root, "provider-switcher"),
  };
  await mkdir(layout.sessionsDir);
  await mkdir(layout.archivedSessionsDir);
  await writeFile(layout.configPath, "before", "utf8");
  await writeFile(layout.authPath, "{\"OPENAI_API_KEY\":\"not-backed-up\"}", "utf8");
  await writeFile(layout.sqlitePath, "before sqlite", "utf8");
  try {
    await callback(layout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
