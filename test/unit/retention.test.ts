import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupTemporaryContexts,
  retainCompletedTransactionBackups,
  retainMappedBranches,
  type BranchRetentionStore,
} from "../../src/core/retention";
import type { CodexLayout } from "../../src/core/types";

test("archives overflow active branches without deleting them", async () => {
  const store = new MemoryBranchStore([
    mapping("branch-4", "2026-08-24T04:00:00.000Z"),
    mapping("branch-3", "2026-08-24T03:00:00.000Z"),
    mapping("branch-2", "2026-08-24T02:00:00.000Z"),
    mapping("branch-1", "2026-08-24T01:00:00.000Z"),
  ]);
  const archived: string[] = [];

  const result = await retainMappedBranches(store, {
    sourceSessionId: "source-1",
    targetProfileId: "custom",
    archive: async (branchSessionId) => {
      archived.push(branchSessionId);
    },
    unarchive: async () => undefined,
  });

  assert.deepEqual(result, { archivedBranchSessionIds: ["branch-1"] });
  assert.deepEqual(archived, ["branch-1"]);
  assert.equal(store.records.find((record) => record.branchSessionId === "branch-1")?.status, "archived");
});

test("unarchives a branch when its mapping cannot be marked archived", async () => {
  const store = new MemoryBranchStore([
    mapping("branch-1", "2026-08-24T01:00:00.000Z"),
    mapping("branch-2", "2026-08-24T02:00:00.000Z"),
    mapping("branch-3", "2026-08-24T03:00:00.000Z"),
    mapping("branch-4", "2026-08-24T04:00:00.000Z"),
  ]);
  const archived: string[] = [];
  const unarchived: string[] = [];
  store.failMarkArchived = true;

  await assert.rejects(
    () => retainMappedBranches(store, {
      sourceSessionId: "source-1",
      targetProfileId: "custom",
      archive: async (branchSessionId) => archived.push(branchSessionId),
      unarchive: async (branchSessionId) => unarchived.push(branchSessionId),
    }),
    /mapping/i,
  );
  assert.deepEqual(archived, ["branch-1"]);
  assert.deepEqual(unarchived, ["branch-1"]);
  assert.equal(store.records.find((record) => record.branchSessionId === "branch-1")?.status, "active");
});

test("keeps only the newest completed transaction backups and removes expired temporary contexts", async () => {
  await withLayout(async (layout) => {
    const transactions = join(layout.switcherDir, "transactions");
    await mkdir(transactions);
    for (let index = 0; index < 3; index += 1) {
      const operation = join(transactions, `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
      await mkdir(join(operation, "backup"), { recursive: true });
      await writeFile(join(operation, "backup", "marker"), String(index));
      await writeFile(join(operation, "journal.jsonl"), `${JSON.stringify({
        version: 1,
        operationId: operation.split(/[/\\]/).at(-1),
        state: "committed",
        timestamp: `2026-08-24T0${index}:00:00.000Z`,
      })}\n`);
    }
    const temporaryDirectory = join(layout.switcherDir, "continuation-temp");
    await mkdir(temporaryDirectory);
    await writeFile(join(temporaryDirectory, "context-old.txt"), "readable temporary context");
    await writeFile(join(temporaryDirectory, "keep.txt"), "not a managed temporary file");

    const backups = await retainCompletedTransactionBackups(layout, { maximumCompletedBackups: 2 });
    const contexts = await cleanupTemporaryContexts(layout);

    assert.deepEqual(backups.removedOperationIds, ["00000000-0000-4000-8000-000000000000"]);
    assert.equal(contexts.removedCount, 1);
  });
});

test("refuses retention roots redirected through symbolic links", async (t) => {
  await withLayout(async (layout) => {
    const externalDirectory = await mkdtemp(join(layout.codexHome, "external-retention-"));
    const externalTransaction = join(externalDirectory, "00000000-0000-4000-8000-000000000000");
    const externalTemporary = join(externalDirectory, "context-old.txt");
    await mkdir(externalTransaction);
    await writeFile(externalTemporary, "external temporary must remain");
    const transactionsPath = join(layout.switcherDir, "transactions");
    const temporaryPath = join(layout.switcherDir, "continuation-temp");
    try {
      await symlink(externalDirectory, transactionsPath, "dir");
      await symlink(externalDirectory, temporaryPath, "dir");
    } catch (error: unknown) {
      if (isWindowsSymlinkPrivilegeError(error)) {
        t.skip("creating directory symlinks requires Windows developer mode or equivalent privilege");
        return;
      }
      throw error;
    }

    await assert.rejects(() => retainCompletedTransactionBackups(layout));
    await assert.rejects(() => cleanupTemporaryContexts(layout));
    assert.equal(await readFile(externalTemporary, "utf8"), "external temporary must remain");
  });
});

test("refuses to delete temporary context after its verified directory is replaced", async (t) => {
  await withLayout(async (layout) => {
    const temporaryDirectory = join(layout.switcherDir, "continuation-temp");
    const external = await mkdtemp(join(layout.codexHome, "external-retention-replacement-"));
    const externalMarker = join(external, "context-external.txt");
    await mkdir(temporaryDirectory);
    await writeFile(join(temporaryDirectory, "context-original.txt"), "managed context", "utf8");
    await writeFile(externalMarker, "external context must remain", "utf8");

    try {
      const probe = join(layout.switcherDir, "retention-symlink-probe");
      try {
        await symlink(external, probe, "dir");
        await rm(probe, { recursive: true, force: false });
      } catch (error: unknown) {
        if (!isWindowsSymlinkPrivilegeError(error)) {
          throw error;
        }
        t.skip("creating directory symlinks requires Windows developer mode or equivalent privilege");
        return;
      }
      const replacement = await replaceTemporaryDirectoryDuringRead(temporaryDirectory, external);
      const replacementModule = await import(`../../src/core/retention.ts?replacement=${Date.now()}`);
      const result = await replacementModule.cleanupTemporaryContexts(layout);
      assert.equal(replacement.wasApplied(), true);
      assert.deepEqual(result, { removedCount: 0 });
      assert.equal(await readFile(externalMarker, "utf8"), "external context must remain");
    } finally {
      restoreReaddirHook();
      await rm(external, { recursive: true, force: true });
    }
  });
});

class MemoryBranchStore implements BranchRetentionStore {
  failMarkArchived = false;
  constructor(readonly records: Array<{
    sourceSessionId: string;
    targetProfileId: string;
    branchSessionId: string;
    sourceEventHash: string;
    status: "active" | "archived";
    createdAt: string;
    updatedAt: string;
  }>) {}

  async listActive(sourceSessionId: string, targetProfileId: string) {
    return this.records.filter((record) => (
      record.sourceSessionId === sourceSessionId &&
      record.targetProfileId === targetProfileId &&
      record.status === "active"
    ));
  }

  async markArchived(branchSessionId: string) {
    if (this.failMarkArchived) {
      throw new Error("mapping persistence failed");
    }
    const record = this.records.find((candidate) => candidate.branchSessionId === branchSessionId);
    assert.ok(record);
    record.status = "archived";
  }
}

function mapping(branchSessionId: string, updatedAt: string) {
  return {
    sourceSessionId: "source-1",
    targetProfileId: "custom",
    branchSessionId,
    sourceEventHash: "a".repeat(64),
    status: "active" as const,
    createdAt: updatedAt,
    updatedAt,
  };
}

async function withLayout(callback: (layout: CodexLayout) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "retention-test-"));
  const layout: CodexLayout = {
    codexHome: root,
    configPath: join(root, "config.toml"),
    authPath: join(root, "auth.json"),
    sessionsDir: join(root, "sessions"),
    archivedSessionsDir: join(root, "archived_sessions"),
    sqlitePath: join(root, "state_5.sqlite"),
    switcherDir: join(root, "provider-switcher"),
  };
  await mkdir(layout.switcherDir);
  try {
    await callback(layout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function isWindowsSymlinkPrivilegeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES");
}

let originalReaddir: typeof readdir | undefined;

async function replaceTemporaryDirectoryDuringRead(
  temporaryDirectory: string,
  external: string,
): Promise<{ wasApplied(): boolean }> {
  const require = createRequire(import.meta.url);
  const mutableFs = require("node:fs/promises") as { readdir: typeof readdir };
  originalReaddir = mutableFs.readdir;
  let replaced = false;
  mutableFs.readdir = (async (...args: Parameters<typeof readdir>) => {
    if (!replaced && String(args[0]) === temporaryDirectory) {
      replaced = true;
      await rm(temporaryDirectory, { recursive: true, force: false });
      try {
        await symlink(external, temporaryDirectory, "dir");
      } catch (error: unknown) {
        if (isWindowsSymlinkPrivilegeError(error)) {
          throw new Error("symlink-privilege-unavailable", { cause: error });
        }
        throw error;
      }
    }
    return originalReaddir!(...args);
  }) as typeof readdir;
  syncBuiltinESMExports();
  return { wasApplied: () => replaced };
}

function restoreReaddirHook(): void {
  if (!originalReaddir) {
    return;
  }
  const require = createRequire(import.meta.url);
  const mutableFs = require("node:fs/promises") as { readdir: typeof readdir };
  mutableFs.readdir = originalReaddir;
  originalReaddir = undefined;
  syncBuiltinESMExports();
}
