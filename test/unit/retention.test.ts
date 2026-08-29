import assert from "node:assert/strict";
import { lstatSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupTemporaryContexts,
  RetentionError,
  retainCompletedTransactionBackups,
  retainMappedBranches,
  type BranchRetentionStore,
} from "../../src/core/retention";
import type { CodexLayout } from "../../src/core/types";
import type {
  WindowsFileIdentity,
  WindowsFileOperations,
} from "../../src/core/windows-file-operations";

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

test("cleans zero-inode Windows retention entries with native compare-delete", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeStats(async () => {
    await withLayout(async (layout) => {
      const transactions = join(layout.switcherDir, "transactions");
      const operationId = "00000000-0000-4000-8000-000000000000";
      const operation = join(transactions, operationId);
      await mkdir(join(operation, "backup"), { recursive: true });
      await writeFile(join(operation, "backup", "marker"), "expired");
      await writeFile(join(operation, "journal.jsonl"), `${JSON.stringify({
        version: 1,
        operationId,
        state: "committed",
        timestamp: "2026-08-24T00:00:00.000Z",
      })}\n`);
      const newerOperationId = "00000000-0000-4000-8000-000000000001";
      const newerOperation = join(transactions, newerOperationId);
      await mkdir(newerOperation);
      await writeFile(join(newerOperation, "journal.jsonl"), `${JSON.stringify({
        version: 1,
        operationId: newerOperationId,
        state: "committed",
        timestamp: "2026-08-24T01:00:00.000Z",
      })}\n`);
      const temporaryDirectory = join(layout.switcherDir, "continuation-temp");
      const contextPath = join(temporaryDirectory, "context-old.txt");
      await mkdir(temporaryDirectory);
      await writeFile(contextPath, "expired context");
      const windowsFileOperations = fakeWindowsFileOperations();
      const fileIdentityOptions = { platform: "win32" as const, windowsFileOperations };

      const backups = await retainCompletedTransactionBackups(layout, {
        maximumCompletedBackups: 1,
        fileIdentityOptions,
      });
      const contexts = await cleanupTemporaryContexts(layout, { fileIdentityOptions });

      assert.deepEqual(backups.removedOperationIds, [operationId]);
      assert.deepEqual(contexts, { removedCount: 1 });
      assert.ok(windowsFileOperations.deleteRequests.some(({ path }) => path === contextPath));
      assert.ok(windowsFileOperations.deleteRequests.some(({ path }) => path.endsWith("backup\\marker")));
      await assert.rejects(() => readFile(contextPath, "utf8"), { code: "ENOENT" });
      await assert.rejects(() => readFile(join(operation, "backup", "marker"), "utf8"), { code: "ENOENT" });
    });
  });
});

test("preserves a zero-inode Windows context after same-content replacement", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeStats(async () => {
    await withLayout(async (layout) => {
      const temporaryDirectory = join(layout.switcherDir, "continuation-temp");
      const contextPath = join(temporaryDirectory, "context-replaced.txt");
      await mkdir(temporaryDirectory);
      await writeFile(contextPath, "same contents");
      const windowsFileOperations = fakeWindowsFileOperations({
        replaceBeforeDelete: (path) => path === contextPath,
        replacementContents: "same contents",
      });

      await assert.rejects(
        () => cleanupTemporaryContexts(layout, {
          fileIdentityOptions: { platform: "win32", windowsFileOperations },
        }),
        (error: unknown) => error instanceof RetentionError,
      );
      assert.equal(await readFile(contextPath, "utf8"), "same contents");
      assert.equal(windowsFileOperations.deleteRequests.length, 1);
    });
  });
});

test("preserves a zero-inode Windows context when native deletion is unavailable", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeStats(async () => {
    await withLayout(async (layout) => {
      const temporaryDirectory = join(layout.switcherDir, "continuation-temp");
      const contextPath = join(temporaryDirectory, "context-unavailable.txt");
      await mkdir(temporaryDirectory);
      await writeFile(contextPath, "retain me");
      const windowsFileOperations = fakeWindowsFileOperations({
        deleteError: new Error("native unavailable"),
      });

      await assert.rejects(
        () => cleanupTemporaryContexts(layout, {
          fileIdentityOptions: { platform: "win32", windowsFileOperations },
        }),
        (error: unknown) => error instanceof RetentionError,
      );
      assert.equal(await readFile(contextPath, "utf8"), "retain me");
    });
  });
});

test("preserves a zero-inode Windows transaction after same-content file replacement", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeStats(async () => {
    await withLayout(async (layout) => {
      const operationId = "00000000-0000-4000-8000-000000000000";
      const operation = join(layout.switcherDir, "transactions", operationId);
      const markerPath = join(operation, "backup", "marker");
      await mkdir(join(operation, "backup"), { recursive: true });
      await writeFile(markerPath, "same contents");
      await writeFile(join(operation, "journal.jsonl"), `${JSON.stringify({
        version: 1,
        operationId,
        state: "committed",
        timestamp: "2026-08-24T00:00:00.000Z",
      })}\n`);
      const newerOperationId = "00000000-0000-4000-8000-000000000001";
      const newerOperation = join(layout.switcherDir, "transactions", newerOperationId);
      await mkdir(newerOperation);
      await writeFile(join(newerOperation, "journal.jsonl"), `${JSON.stringify({
        version: 1,
        operationId: newerOperationId,
        state: "committed",
        timestamp: "2026-08-24T01:00:00.000Z",
      })}\n`);
      const windowsFileOperations = fakeWindowsFileOperations({
        replaceBeforeDelete: (path) => path === markerPath,
        replacementContents: "same contents",
      });

      await assert.rejects(
        () => retainCompletedTransactionBackups(layout, {
          maximumCompletedBackups: 1,
          fileIdentityOptions: { platform: "win32", windowsFileOperations },
        }),
        (error: unknown) => error instanceof RetentionError,
      );
      assert.equal(await readFile(markerPath, "utf8"), "same contents");
      assert.equal(await readFile(join(operation, "journal.jsonl"), "utf8").then((value) => value.length > 0), true);
    });
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

interface FakeWindowsFileOperationsOptions {
  readonly replaceBeforeDelete?: (path: string) => boolean;
  readonly replacementContents?: string;
  readonly deleteError?: Error;
}

interface FakeWindowsFileOperations extends WindowsFileOperations {
  readonly deleteRequests: Array<{ path: string; expected: WindowsFileIdentity }>;
}

function fakeWindowsFileOperations(
  options: FakeWindowsFileOperationsOptions = {},
): FakeWindowsFileOperations {
  const deleteRequests: Array<{ path: string; expected: WindowsFileIdentity }> = [];
  const captureFileIdentity = (path: string): WindowsFileIdentity => {
    const stats = lstatSync(path, { bigint: true });
    if (stats.nlink !== 1n) {
      throw new Error("native identity is unavailable");
    }
    return {
      volumeSerial: "0000000000000001",
      fileId: `${stats.dev.toString(16).padStart(16, "0").slice(-16)}${stats.ino
        .toString(16)
        .padStart(16, "0")
        .slice(-16)}`,
      linkCount: stats.nlink,
    };
  };
  const sameIdentity = (left: WindowsFileIdentity, right: WindowsFileIdentity): boolean => (
    left.volumeSerial === right.volumeSerial &&
    left.fileId === right.fileId &&
    left.linkCount === right.linkCount
  );
  const operations: FakeWindowsFileOperations = {
    deleteRequests,
    captureFileIdentity,
    deleteFileIfMatches(path, expected) {
      deleteRequests.push({ path, expected });
      if (options.replaceBeforeDelete?.(path)) {
        const replacementPath = `${path}.replacement`;
        writeFileSync(replacementPath, options.replacementContents ?? "", "utf8");
        renameSync(replacementPath, path);
      }
      if (options.deleteError) {
        throw options.deleteError;
      }
      if (!sameIdentity(captureFileIdentity(path), expected)) {
        return "identity-mismatch";
      }
      if (lstatSync(path).isDirectory()) {
        rmdirSync(path);
      } else {
        unlinkSync(path);
      }
      return "deleted";
    },
    holdFileIfMatches() {
      throw new Error("unused");
    },
  };
  return operations;
}

async function withZeroInodeStats(callback: () => Promise<void>): Promise<void> {
  const nodeRequire = createRequire(import.meta.url);
  const mutableFs = nodeRequire("node:fs/promises") as { lstat: typeof lstat };
  const originalLstat = mutableFs.lstat;
  mutableFs.lstat = (async (...args: Parameters<typeof lstat>) => {
    const stats = await originalLstat(...args);
    return withZeroInode(stats);
  }) as typeof lstat;
  syncBuiltinESMExports();
  try {
    await callback();
  } finally {
    mutableFs.lstat = originalLstat;
    syncBuiltinESMExports();
  }
}

function withZeroInode<T extends Awaited<ReturnType<typeof lstat>>>(stats: T): T {
  const copy = Object.create(
    Object.getPrototypeOf(stats),
    Object.getOwnPropertyDescriptors(stats),
  ) as T;
  Object.defineProperty(copy, "ino", {
    configurable: true,
    enumerable: true,
    value: 0n,
    writable: false,
  });
  return copy;
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
