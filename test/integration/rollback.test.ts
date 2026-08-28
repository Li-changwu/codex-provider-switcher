import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";
import {
  applyRolloutChanges,
  collectRolloutChanges,
  createRolloutInversePatches,
  reverseRolloutInversePatch,
} from "../../src/core/rollouts";
import { updateProviderMetadata } from "../../src/core/sqlite";
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
  type AuthJournalTarget,
} from "../../src/core/transaction";
import type { CodexLayout } from "../../src/core/types";

const customApiKey = "rollback-test-api-key-must-never-be-journaled";
const transcriptBody = "private-transcript-body-must-never-be-journaled";

test("rolls back a preflight failure before any backup or mutation", async () => {
  await withFixture(async (fixture) => {
    const before = await takeSnapshot(fixture);
    let backupCalls = 0;

    const result = await switchProfile(
      { targetProfileId: "custom" },
      dependencies(fixture, {
        preflight: async () => {
          throw new Error("injected preflight failure");
        },
        backup: async () => {
          backupCalls += 1;
          return byteBackupTargets(fixture.layout);
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "rolledBack");
    assert.equal(backupCalls, 0);
    await assertSnapshotRestored(fixture, before);
    await assertNoSensitiveTransactionData(fixture.layout, result.operationId);
  });
});

test("restores the full snapshot when the first real rollout rename fails", async () => {
  await withFixture(async (fixture) => {
    const before = await takeSnapshot(fixture);
    const changes = await collectRolloutChanges(fixture.layout, "custom");
    assert.equal(changes.length, 2);
    let failureInjectedAfterFirstRename = false;

    const result = await switchProfile(
      { targetProfileId: "custom" },
      dependencies(fixture, {
        mutationPlan: {
          rollouts: createRolloutMutations(fixture.layout, changes, async (index) => {
            if (index === 0) {
              const change = changes[index];
              assert.ok(change);
              const originalBytes = before.rollouts.get(change.path);
              assert.ok(originalBytes);
              assert.notDeepEqual(await readFile(change.path), originalBytes);
              const secondChange = changes[1];
              assert.ok(secondChange);
              assert.deepEqual(
                await readFile(secondChange.path),
                before.rollouts.get(secondChange.path),
              );
              failureInjectedAfterFirstRename = true;
              throw new Error("injected failure after first rollout rename");
            }
          }),
          sqlite: [],
          commit: [],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "rolledBack");
    assert.equal(failureInjectedAfterFirstRename, true);
    await assertSnapshotRestored(fixture, before);
    await assertBoundedTransactionBackups(
      fixture.layout,
      result.operationId,
      before.rollouts,
    );
    await assertNoSensitiveTransactionData(fixture.layout, result.operationId);
  });
});

test("keeps a bounded byte backup for every rollout selected by a failed switch", async () => {
  await withFixture(async (fixture) => {
    const before = await takeSnapshot(fixture);
    const changes = await collectRolloutChanges(fixture.layout, "custom");
    const result = await switchProfile(
      { targetProfileId: "custom" },
      dependencies(fixture, {
        mutationPlan: {
          rollouts: createRolloutMutations(fixture.layout, changes, async () => {
            throw new Error("force rollback after rollout publication");
          }),
          sqlite: [],
          commit: [],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "rolledBack");
    const manifest = JSON.parse(
      await readFile(
        join(
          fixture.layout.switcherDir,
          "transactions",
          result.operationId,
          "backup",
          "manifest.json",
        ),
        "utf8",
      ),
    ) as {
      entries: Array<{ kind: string; path: string; backupPath?: string }>;
    };
    const rolloutEntries = manifest.entries.filter((entry) => entry.kind === "rollout");
    assert.equal(rolloutEntries.length, changes.length);
    for (const entry of rolloutEntries) {
      assert.ok(entry.backupPath);
      assert.deepEqual(
        await readFile(entry.backupPath),
        before.rollouts.get(entry.path),
      );
    }
    await assertNoSensitiveTransactionData(fixture.layout, result.operationId);
  });
});

test("restores rollback snapshots after a real SQLite metadata update fails", async () => {
  await withFixture(async (fixture) => {
    const before = await takeSnapshot(fixture);
    const changes = await collectRolloutChanges(fixture.layout, "custom");
    let sqliteUpdated = false;
    const sqliteMutation: PreparedSwitchMutation = {
      name: "update SQLite provider metadata",
      target: { kind: "sqlite", path: fixture.layout.sqlitePath },
      apply: async () => {
        const update = await updateProviderMetadata(fixture.layout, "custom");
        assert.equal(update.status, "updated");
        sqliteUpdated = true;
      },
      rollback: async () => writeFile(fixture.layout.sqlitePath, before.sqlite),
    };

    const result = await switchProfile(
      { targetProfileId: "custom" },
      dependencies(fixture, {
        mutationPlan: {
          rollouts: createRolloutMutations(fixture.layout, changes),
          sqlite: [sqliteMutation],
          commit: [],
        },
        verify: async () => {
          assert.equal(sqliteUpdated, true);
          throw new Error("injected failure after SQLite update");
        },
      }),
    );

    assert.equal(sqliteUpdated, true);
    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "rolledBack");
    await assertSnapshotRestored(fixture, before);
    await assertBoundedTransactionBackups(
      fixture.layout,
      result.operationId,
      before.rollouts,
    );
    await assertNoSensitiveTransactionData(fixture.layout, result.operationId);
  });
});

test("restores commit mutations when failure occurs before the durable commit", async () => {
  await withFixture(async (fixture) => {
    const before = await takeSnapshot(fixture);
    const changes = await collectRolloutChanges(fixture.layout, "custom");
    const sqliteMutation: PreparedSwitchMutation = {
      name: "update SQLite provider metadata",
      target: { kind: "sqlite", path: fixture.layout.sqlitePath },
      apply: async () => {
        const update = await updateProviderMetadata(fixture.layout, "custom");
        assert.equal(update.status, "updated");
      },
      rollback: async () => writeFile(fixture.layout.sqlitePath, before.sqlite),
    };
    const configMutation: PreparedSwitchMutation = {
      name: "write target config",
      target: { kind: "config", path: fixture.layout.configPath },
      apply: async () => {
        await writeFile(fixture.layout.configPath, 'model_provider = "custom"\n');
      },
      rollback: async () => writeFile(fixture.layout.configPath, before.config),
    };
    const authMutation: PreparedSwitchMutation = {
      name: "activate custom auth",
      target: { kind: "auth", path: fixture.layout.authPath, previousMode: "official" },
      apply: async () => activateCustomAuth(fixture),
      rollback: async () => restoreOfficialAuth(fixture),
    };
    const failingCommitMutation: PreparedSwitchMutation = {
      name: "fail before durable commit",
      target: { kind: "config", path: fixture.layout.configPath },
      apply: async () => {
        throw new Error("injected failure before durable commit");
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "custom" },
      dependencies(fixture, {
        mutationPlan: {
          rollouts: createRolloutMutations(fixture.layout, changes),
          sqlite: [sqliteMutation],
          commit: [configMutation, authMutation, failingCommitMutation],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "rolledBack");
    assert.equal(
      (await readTransactionJournal(
        join(fixture.layout.switcherDir, "transactions", result.operationId, "journal.jsonl"),
      )).some((entry) => entry.state === "committed"),
      false,
    );
    await assertSnapshotRestored(fixture, before);
    await assertBoundedTransactionBackups(
      fixture.layout,
      result.operationId,
      before.rollouts,
    );
    await assertNoSensitiveTransactionData(fixture.layout, result.operationId);
  });
});

test("reports cancellation only after the applied rollout is restored", async () => {
  await withFixture(async (fixture) => {
    const before = await takeSnapshot(fixture);
    const changes = await collectRolloutChanges(fixture.layout, "custom");
    const controller = new AbortController();
    const [change] = changes;
    assert.ok(change);
    const [inversePatch] = createRolloutInversePatches([change]);
    assert.ok(inversePatch);
    const rolloutMutation: PreparedSwitchMutation = {
      name: "rename rollout before cancellation",
      target: { kind: "rollout", path: change.path, inversePatch },
      apply: async () => {
        await applyRolloutChanges([change]);
        controller.abort();
      },
      rollback: async () => undefined,
    };

    const result = await switchProfile(
      { targetProfileId: "custom", signal: controller.signal },
      dependencies(fixture, {
        mutationPlan: {
          rollouts: [rolloutMutation],
          sqlite: [],
          commit: [],
        },
      }),
    );

    assert.equal(result.status, "cancelled");
    assert.equal(result.journalState, "rolledBack");
    await assertSnapshotRestored(fixture, before);
    await assertBoundedTransactionBackups(
      fixture.layout,
      result.operationId,
      selectedRolloutBackups(before, [change.path]),
    );
    await assertNoSensitiveTransactionData(fixture.layout, result.operationId);
  });
});

test("recovers an interrupted applying transaction with its live lock still present", async () => {
  await withFixture(async (fixture) => {
    const before = await takeSnapshot(fixture);
    const [change] = await collectRolloutChanges(fixture.layout, "custom");
    assert.ok(change);
    const [inversePatch] = createRolloutInversePatches([change]);
    assert.ok(inversePatch);
    const operationId = "interrupted-rollback-integration";
    const transaction = await beginTransaction(fixture.layout, { operationId });

    const configTarget = { kind: "config" as const, path: fixture.layout.configPath };
    const authTarget = {
      kind: "auth" as const,
      path: fixture.layout.authPath,
      previousMode: "official" as const,
    };
    const rolloutTarget = { kind: "rollout" as const, path: change.path, inversePatch };
    const sqliteTarget = { kind: "sqlite" as const, path: fixture.layout.sqlitePath };

    await transaction.backupTargets(byteBackupTargets(fixture.layout, [change.path]));
    await transaction.markApplying();
    await transaction.prepareTarget(configTarget);
    await writeFile(fixture.layout.configPath, 'model_provider = "custom"\n');
    await transaction.markTargetApplied(configTarget);
    await transaction.prepareTarget(authTarget);
    await activateCustomAuth(fixture);
    await transaction.markTargetApplied(authTarget);
    await transaction.prepareTarget(rolloutTarget);
    await applyRolloutChanges([change]);
    await transaction.markTargetApplied(rolloutTarget);
    await transaction.prepareTarget(sqliteTarget);
    const update = await updateProviderMetadata(fixture.layout, "custom");
    assert.equal(update.status, "updated");
    await transaction.markTargetApplied(sqliteTarget);
    assert.equal(await fileExists(operationLockPath(fixture.layout)), true);
    assert.equal(
      (await readTransactionJournal(transaction.journalPath)).at(-1)?.state,
      "applying",
    );

    const recovery = await recoverPendingSwitches(fixture.layout, {
      isProcessAlive: () => false,
      restoreAuthMode: fixture.restoreAuthMode,
    });

    assert.equal(recovery.recoveredOperationIds.includes(operationId), true);
    assert.equal(recovery.recoveryRequiredOperationIds.includes(operationId), false);
    await assertSnapshotRestored(fixture, before);
    assert.equal(await fileExists(operationLockPath(fixture.layout)), false);
    assert.equal(
      (await readTransactionJournal(transaction.journalPath)).at(-1)?.state,
      "rolledBack",
    );
    await assertBoundedTransactionBackups(
      fixture.layout,
      operationId,
      selectedRolloutBackups(before, [change.path]),
    );
    await assertNoSensitiveTransactionData(fixture.layout, operationId);
    try {
      await transaction.release();
    } catch (error: unknown) {
      assert.ok(error instanceof TransactionError);
      assert.equal(error.code, "lock-unverifiable");
    }
  });
});

test("keeps a durable commit when acknowledgement fails", async () => {
  await withFixture(async (fixture) => {
    const before = await takeSnapshot(fixture);
    let acknowledgementRanAfterCommit = false;
    const configMutation: PreparedSwitchMutation = {
      name: "write target config",
      target: { kind: "config", path: fixture.layout.configPath },
      apply: async () => {
        await writeFile(fixture.layout.configPath, 'model_provider = "custom"\n');
      },
      rollback: async () => writeFile(fixture.layout.configPath, before.config),
    };
    const authMutation: PreparedSwitchMutation = {
      name: "activate custom auth",
      target: { kind: "auth", path: fixture.layout.authPath, previousMode: "official" },
      apply: async () => activateCustomAuth(fixture),
      rollback: async () => restoreOfficialAuth(fixture),
    };

    const result = await switchProfile(
      { targetProfileId: "custom" },
      dependencies(fixture, {
        mutationPlan: {
          rollouts: [],
          sqlite: [],
          commit: [configMutation, authMutation],
        },
        acknowledge: async ({ transaction }) => {
          assert.equal(
            (await readTransactionJournal(transaction.journalPath)).at(-1)?.state,
            "committed",
          );
          acknowledgementRanAfterCommit = true;
          throw new Error("injected acknowledgement failure after durable commit");
        },
      }),
    );

    assert.equal(result.status, "committed");
    assert.equal(result.journalState, "committed");
    assert.equal(result.acknowledgementFailed, true);
    assert.equal(acknowledgementRanAfterCommit, true);
    const committed = await takeSnapshot(fixture);
    assert.notDeepEqual(committed.config, before.config);
    assert.equal(committed.authMode, "custom");
    assert.equal(committed.authPathExists, true);
    await assertBoundedTransactionBackups(fixture.layout, result.operationId, new Map());

    const recovery = await recoverPendingSwitches(fixture.layout, {
      isProcessAlive: () => false,
      restoreAuthMode: fixture.restoreAuthMode,
    });

    assert.equal(recovery.recoveredOperationIds.includes(result.operationId), false);
    assert.equal(recovery.recoveryRequiredOperationIds.includes(result.operationId), false);
    assert.equal(recovery.skippedCommittedOperationIds.includes(result.operationId), true);
    assert.deepEqual(await takeSnapshot(fixture), committed);
    assert.equal(
      (await readTransactionJournal(
        join(fixture.layout.switcherDir, "transactions", result.operationId, "journal.jsonl"),
      )).at(-1)?.state,
      "committed",
    );
    await assertNoSensitiveTransactionData(fixture.layout, result.operationId);
  });
});

test("does not reverse auth or rollout when a selected SQLite backup is tampered", async () => {
  await withFixture(async (fixture) => {
    const [change] = await collectRolloutChanges(fixture.layout, "custom");
    assert.ok(change);
    const [inversePatch] = createRolloutInversePatches([change]);
    assert.ok(inversePatch);
    const operationId = "tampered-sqlite-before-mutation";
    const transaction = await beginTransaction(fixture.layout, { operationId });
    const authTarget = {
      kind: "auth" as const,
      path: fixture.layout.authPath,
      previousMode: "official" as const,
    };
    const rolloutTarget = { kind: "rollout" as const, path: change.path, inversePatch };
    const sqliteTarget = { kind: "sqlite" as const, path: fixture.layout.sqlitePath };

    try {
      const manifest = await transaction.backupTargets([
        { kind: "sqlite", path: fixture.layout.sqlitePath },
        { kind: "rollout", path: change.path },
      ]);
      await transaction.markApplying();
      await transaction.prepareTarget(authTarget);
      await activateCustomAuth(fixture);
      await transaction.markTargetApplied(authTarget);
      await transaction.prepareTarget(rolloutTarget);
      await applyRolloutChanges([change]);
      await transaction.markTargetApplied(rolloutTarget);
      await transaction.prepareTarget(sqliteTarget);
      const update = await updateProviderMetadata(fixture.layout, "custom");
      assert.equal(update.status, "updated");
      await transaction.markTargetApplied(sqliteTarget);
      await writeFile(manifest.entries[0].backupPath!, "tampered SQLite backup", "utf8");
    } finally {
      await transaction.release();
    }

    const changedRollout = await readFile(change.path);
    const recovery = await recoverPendingSwitches(fixture.layout, {
      isProcessAlive: () => false,
      restoreAuthMode: fixture.restoreAuthMode,
    });

    assert.equal(recovery.recoveredOperationIds.includes(operationId), false);
    assert.equal(recovery.recoveryRequiredOperationIds.includes(operationId), true);
    assert.equal(fixture.authMode, "custom");
    assert.equal(await fileExists(fixture.layout.authPath), true);
    assert.deepEqual(await readFile(change.path), changedRollout);
    assert.equal(
      (await readTransactionJournal(transaction.journalPath)).at(-1)?.state,
      "recoveryRequired",
    );
  });
});

interface Fixture {
  readonly root: string;
  readonly layout: CodexLayout;
  readonly rolloutPaths: readonly string[];
  authMode: "official" | "custom";
  restoreAuthMode(target: AuthJournalTarget): Promise<void>;
}

interface Snapshot {
  readonly config: Buffer;
  readonly rollouts: ReadonlyMap<string, Buffer>;
  readonly rolloutHashes: ReadonlyMap<string, string>;
  readonly sqlite: Buffer;
  readonly authMode: "official" | "custom";
  readonly authPathExists: boolean;
}

function dependencies(
  fixture: Fixture,
  overrides: Partial<SwitchDependencies> = {},
): SwitchDependencies {
  return {
    layout: fixture.layout,
    preflight: async () => undefined,
    backup: async () => byteBackupTargets(fixture.layout),
    scan: async () => undefined,
    mutationPlan: {
      noOp: true,
      rollouts: [],
      sqlite: [],
      commit: [],
    },
    verify: async () => undefined,
    restoreAuthMode: fixture.restoreAuthMode,
    ...overrides,
  };
}

function byteBackupTargets(layout: CodexLayout, rolloutPaths: readonly string[] = []) {
  return [
    { kind: "config" as const, path: layout.configPath },
    { kind: "sqlite" as const, path: layout.sqlitePath },
    ...rolloutPaths.map((path) => ({ kind: "rollout" as const, path })),
  ];
}

async function withFixture(callback: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "rollback-integration-"));
  const layout = createLayout(root);
  const rolloutPaths = [
    join(layout.sessionsDir, "session-one.jsonl"),
    join(layout.sessionsDir, "session-two.jsonl"),
  ];
  const fixture: Fixture = {
    root,
    layout,
    rolloutPaths,
    authMode: "official",
    async restoreAuthMode(target) {
      fixture.authMode = target.previousMode;
      if (target.previousMode === "official") {
        await rm(layout.authPath, { force: true });
      }
    },
  };

  await mkdir(layout.sessionsDir, { recursive: true });
  await mkdir(layout.archivedSessionsDir, { recursive: true });
  await writeFile(layout.configPath, Buffer.from('model_provider = "openai"\n'));
  await writeFile(rolloutPaths[0], rolloutContents("session-one"));
  await writeFile(rolloutPaths[1], rolloutContents("session-two"));
  await createStateDatabase(layout.sqlitePath);

  try {
    await callback(fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createLayout(codexHome: string): CodexLayout {
  return {
    codexHome,
    configPath: join(codexHome, "config.toml"),
    authPath: join(codexHome, "auth.json"),
    sessionsDir: join(codexHome, "sessions"),
    archivedSessionsDir: join(codexHome, "archived_sessions"),
    sqlitePath: join(codexHome, "state_5.sqlite"),
    switcherDir: join(codexHome, "provider-switcher"),
  };
}

function rolloutContents(sessionId: string): string {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: sessionId, model_provider: "openai" },
    }),
    JSON.stringify({ type: "response_item", payload: { text: transcriptBody } }),
    "",
  ].join("\n");
}

async function takeSnapshot(fixture: Fixture): Promise<Snapshot> {
  const rollouts = new Map(
    await Promise.all(
      fixture.rolloutPaths.map(async (path) => [path, await readFile(path)] as const),
    ),
  );
  return {
    config: await readFile(fixture.layout.configPath),
    rollouts,
    rolloutHashes: new Map(
      [...rollouts].map(([path, bytes]) => [path, sha256(bytes)] as const),
    ),
    sqlite: await readFile(fixture.layout.sqlitePath),
    authMode: fixture.authMode,
    authPathExists: await fileExists(fixture.layout.authPath),
  };
}

async function assertSnapshotRestored(fixture: Fixture, before: Snapshot): Promise<void> {
  assert.deepEqual(await readFile(fixture.layout.configPath), before.config);
  for (const [path, contents] of before.rollouts) {
    const current = await readFile(path);
    assert.deepEqual(current, contents, path);
    assert.equal(sha256(current), before.rolloutHashes.get(path), `${path} SHA-256`);
  }
  assert.deepEqual(await readFile(fixture.layout.sqlitePath), before.sqlite);
  assert.equal(fixture.authMode, before.authMode);
  assert.equal(await fileExists(fixture.layout.authPath), before.authPathExists);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertNoSensitiveTransactionData(
  layout: CodexLayout,
  operationId: string,
): Promise<void> {
  const directory = join(layout.switcherDir, "transactions", operationId);
  const metadataPaths = [join(directory, "journal.jsonl")];
  const manifestPath = join(directory, "backup", "manifest.json");
  if (await fileExists(manifestPath)) {
    metadataPaths.push(manifestPath);
  }
  const contents = Buffer.concat(await Promise.all(metadataPaths.map((path) => readFile(path))));
  assert.equal(contents.includes(Buffer.from(transcriptBody)), false);
  assert.equal(contents.includes(Buffer.from(customApiKey)), false);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function createRolloutMutations(
  layout: CodexLayout,
  changes: Awaited<ReturnType<typeof collectRolloutChanges>>,
  afterApply?: (index: number) => void | Promise<void>,
): PreparedSwitchMutation[] {
  return changes.map((change, index) => {
    const [inversePatch] = createRolloutInversePatches([change]);
    if (!inversePatch) {
      throw new Error("Expected one rollout inverse patch.");
    }
    return {
      name: `update rollout ${index + 1}`,
      target: { kind: "rollout", path: change.path, inversePatch },
      apply: async () => {
        await applyRolloutChanges([change]);
        await afterApply?.(index);
      },
      rollback: async () => reverseRolloutInversePatch(inversePatch, layout),
    };
  });
}

async function activateCustomAuth(fixture: Fixture): Promise<void> {
  fixture.authMode = "custom";
  await writeFile(
    fixture.layout.authPath,
    JSON.stringify({ OPENAI_API_KEY: customApiKey }),
    "utf8",
  );
}

async function restoreOfficialAuth(fixture: Fixture): Promise<void> {
  fixture.authMode = "official";
  await rm(fixture.layout.authPath, { force: true });
}

function selectedRolloutBackups(
  snapshot: Snapshot,
  paths: readonly string[],
): ReadonlyMap<string, Buffer> {
  return new Map(paths.map((path) => {
    const bytes = snapshot.rollouts.get(path);
    assert.ok(bytes, `Missing rollout snapshot for ${path}`);
    return [path, bytes] as const;
  }));
}

async function assertBoundedTransactionBackups(
  layout: CodexLayout,
  operationId: string,
  expectedRollouts: ReadonlyMap<string, Buffer>,
): Promise<void> {
  const backupDirectory = join(
    layout.switcherDir,
    "transactions",
    operationId,
    "backup",
  );
  const names = await readdir(backupDirectory);
  const manifest = JSON.parse(
    await readFile(join(backupDirectory, "manifest.json"), "utf8"),
  ) as { entries: Array<{ kind: string; path: string; backupPath?: string }> };
  assert.equal(names.some((name) => /auth/i.test(name)), false);
  assert.equal(names.includes("manifest.json"), true);
  assert.equal(names.some((name) => /config\.toml/i.test(name)), true);
  assert.equal(names.some((name) => /state_5\.sqlite/i.test(name)), true);
  assert.equal(manifest.entries.filter((entry) => entry.kind === "config").length, 1);
  assert.equal(manifest.entries.filter((entry) => entry.kind === "sqlite").length, 1);

  const rolloutEntries = manifest.entries.filter((entry) => entry.kind === "rollout");
  assert.equal(rolloutEntries.length, expectedRollouts.size);
  let rolloutBackupBytes = 0;
  for (const [path, expectedBytes] of expectedRollouts) {
    const entry = rolloutEntries.find((candidate) => candidate.path === path);
    assert.ok(entry?.backupPath, `Missing rollout backup for ${path}`);
    const backupBytes = await readFile(entry.backupPath);
    rolloutBackupBytes += backupBytes.length;
    assert.deepEqual(backupBytes, expectedBytes, `Rollout backup differs for ${path}`);
  }
  assert.equal(
    rolloutBackupBytes,
    [...expectedRollouts.values()].reduce((total, bytes) => total + bytes.length, 0),
  );
}

function createStateDatabase(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(path, (openError) => {
      if (openError) {
        reject(openError);
        return;
      }
      database.serialize(() => {
        database.exec(
          "PRAGMA user_version = 5; CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, title TEXT, encrypted_content TEXT); INSERT INTO threads VALUES ('thread-1', 'openai', 'Keep', NULL);",
          (error) => {
            database.close((closeError) => {
              if (error) {
                reject(error);
              } else if (closeError) {
                reject(closeError);
              } else {
                resolve();
              }
            });
          },
        );
      });
    });
  });
}
