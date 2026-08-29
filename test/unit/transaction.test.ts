import assert from "node:assert/strict";
import { execFile as nativeExecFile } from "node:child_process";
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  beginTransaction,
  hasSameStableFileIdentity,
  readTransactionJournal,
  recoverAndBeginTransaction,
  recoverPendingSwitches,
  operationLockPath,
  TransactionError,
  type BackupTarget,
  type FileIdentity,
} from "../../src/core/transaction";
import {
  applyRolloutChanges,
  collectRolloutChanges,
  createRolloutInversePatches,
} from "../../src/core/rollouts";
import type { CodexLayout } from "../../src/core/types";
import {
  createWindowsFileOperations,
  type WindowsFileIdentity,
} from "../../src/core/windows-file-operations";

const execFile = promisify(nativeExecFile);

test("requires comparable exact filesystem identity for trusted directories", () => {
  const matching: FileIdentity = { dev: 1n, ino: 2n, nlink: 1n };

  assert.equal(
    hasSameStableFileIdentity(matching, { dev: 1n, ino: 2n, nlink: 1n }),
    true,
  );
  assert.equal(
    hasSameStableFileIdentity(matching, { dev: 2n, ino: 2n, nlink: 1n }),
    false,
  );
  assert.equal(
    hasSameStableFileIdentity(matching, { dev: 1n, ino: 2n, nlink: 2n }),
    false,
  );
  assert.equal(
    hasSameStableFileIdentity(matching, { dev: 1n, ino: 3n, nlink: 1n }),
    false,
  );
  assert.equal(
    hasSameStableFileIdentity(
      { dev: 1n, ino: 0n, nlink: 1n },
      { dev: 1n, ino: 0n, nlink: 1n },
    ),
    false,
  );
  assert.equal(
    hasSameStableFileIdentity(
      { dev: Number.MAX_SAFE_INTEGER + 1, ino: 2, nlink: 1 },
      { dev: Number.MAX_SAFE_INTEGER + 1, ino: 2, nlink: 1 },
    ),
    false,
  );
});

test("compares canonical native identities for zero-inode transaction files", () => {
  const nativeIdentity: WindowsFileIdentity = {
    volumeSerial: "0000000000000001",
    fileId: "0123456789abcdef0123456789abcdef",
    linkCount: 1n,
  };
  const matching: FileIdentity = {
    dev: 0n,
    ino: 0n,
    nlink: 1n,
    windowsFileIdentity: nativeIdentity,
  };

  assert.equal(
    hasSameStableFileIdentity(matching, {
      dev: 0n,
      ino: 0n,
      nlink: 1n,
      windowsFileIdentity: nativeIdentity,
    }, "win32"),
    true,
  );
  assert.equal(
    hasSameStableFileIdentity(matching, {
      dev: 0n,
      ino: 0n,
      nlink: 1n,
      windowsFileIdentity: {
        ...nativeIdentity,
        fileId: "fedcba9876543210fedcba9876543210",
      },
    }, "win32"),
    false,
  );
  assert.equal(
    hasSameStableFileIdentity(matching, { dev: 0n, ino: 0n, nlink: 1n }, "win32"),
    false,
  );
});

test("runs a transaction with native identities on Windows zero-inode filesystems", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows native file identities require Windows");
    return;
  }

  await withLayout(async (layout) => {
    const stats = await lstat(layout.codexHome, { bigint: true });
    if (stats.ino !== 0n) {
      t.skip("This Windows Node runtime exposes nonzero inode values");
      return;
    }

    const transaction = await beginTransaction(layout, {
      operationId: "windows-zero-inode",
      fileIdentityOptions: {
        platform: "win32",
        windowsFileOperations: createWindowsFileOperations(),
      },
    });
    try {
      const target = { kind: "config" as const, path: layout.configPath };
      await transaction.backupTargets([target]);
      await transaction.markApplying([target]);
      await transaction.prepareTarget(target);
      await writeFile(layout.configPath, "model_provider = 'after'\n", "utf8");
      await transaction.markTargetApplied(target);
      await transaction.rollback();
      assert.equal(
        await readFile(layout.configPath, "utf8"),
        "model_provider = 'before'\n",
      );
    } finally {
      await transaction.release();
    }
  });
});

test("accepts Windows 8.3 aliases for transaction paths", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows path aliases are not available on this platform.");
    return;
  }

  await withLayout(async (layout) => {
    const shortHome = await windowsShortPath(layout.codexHome);
    if (shortHome === undefined || shortHome === layout.codexHome) {
      t.skip("Windows short-path aliases are unavailable on this runner.");
      return;
    }

    const aliasedLayout: CodexLayout = {
      codexHome: shortHome,
      configPath: join(shortHome, "config.toml"),
      authPath: join(shortHome, "auth.json"),
      sessionsDir: join(shortHome, "sessions"),
      archivedSessionsDir: join(shortHome, "archived_sessions"),
      sqlitePath: join(shortHome, "state_5.sqlite"),
      switcherDir: join(shortHome, "provider-switcher"),
    };
    const transaction = await beginTransaction(aliasedLayout, {
      operationId: "windows-short-path-alias",
    });
    try {
      const target = { kind: "config" as const, path: aliasedLayout.configPath };
      await transaction.backupTargets([target]);
      await transaction.markApplying([target]);
      await transaction.prepareTarget(target);
      await writeFile(aliasedLayout.configPath, "model_provider = 'after'\n", "utf8");
      await transaction.markTargetApplied(target);
      await transaction.rollback();
      assert.equal(
        await readFile(aliasedLayout.configPath, "utf8"),
        "model_provider = 'before'\n",
      );
    } finally {
      await transaction.release();
    }
  });
});

test("backs up config, sqlite, and managed rollout files without backing up auth", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "backup-only" });
    try {
      const targets: BackupTarget[] = [
        { kind: "config", path: layout.configPath },
        { kind: "sqlite", path: layout.sqlitePath },
      ];
      const manifest = await transaction.backupTargets(targets);

      assert.deepEqual(
        manifest.entries.map((entry) => entry.kind),
        ["config", "sqlite"],
      );
      assert.equal(
        manifest.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256 ?? "")),
        true,
      );
      assert.doesNotMatch(JSON.stringify(manifest), /auth|secret|message|transcript/i);
      const extended = await transaction.backupTargets([
        { kind: "rollout", path: join(layout.sessionsDir, "one.jsonl") },
      ]);
      assert.deepEqual(
        extended.entries.map((entry) => entry.kind),
        ["config", "sqlite", "rollout"],
      );
      assert.rejects(
        () => transaction.backupTargets([{ kind: "config", path: layout.authPath }]),
        /backup target is not allowed/i,
      );
    } finally {
      await transaction.markRolledBack();
      await transaction.release();
    }
  });
});

test("records original permission bits for existing byte backups", async () => {
  await withLayout(async (layout) => {
    const targets: BackupTarget[] = [
      { kind: "config", path: layout.configPath },
      { kind: "sqlite", path: layout.sqlitePath },
    ];
    const expectedModes = await Promise.all(
      targets.map(async (target) => (await lstat(target.path)).mode & 0o777),
    );
    const transaction = await beginTransaction(layout, { operationId: "backup-modes" });

    try {
      const manifest = await transaction.backupTargets(targets);
      assert.deepEqual(
        manifest.entries.map((entry) => entry.mode),
        expectedModes,
      );
      await transaction.markRolledBack();
    } finally {
      await transaction.release();
    }
  });
});

test("appends complete durable journal records for each terminal state", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "journal-states" });
    await transaction.markApplying([layout.configPath]);
    await transaction.markCommitted();
    await transaction.release();

    const journalPath = join(
      layout.switcherDir,
      "transactions",
      "journal-states",
      "journal.jsonl",
    );
    const lines = (await readFile(journalPath, "utf8")).trim().split("\n");
    assert.deepEqual(
      lines.map((line) => JSON.parse(line).state),
      ["prepared", "applying", "committed"],
    );
    assert.ok(lines.every((line) => line.endsWith("}")));
  });
});

test("syncs each parent directory after publishing a journal, manifest, or restore", async (t) => {
  await t.test("journal", async () => {
    await withLayout(async (layout) => {
      let observeCommit = false;
      let committedRenameFinished = false;
      const syncedDirectories: string[] = [];
      const transaction = await beginTransaction(layout, {
        operationId: "journal-parent-sync",
        io: {
          async renameJournal(source, destination) {
            await rename(source, destination);
            if (observeCommit) {
              assert.equal(
                (await readTransactionJournal(destination)).at(-1)?.state,
                "committed",
              );
              committedRenameFinished = true;
            }
          },
          async syncDirectory(path) {
            if (observeCommit) {
              assert.equal(committedRenameFinished, true);
              syncedDirectories.push(path);
            }
          },
        },
      });

      try {
        await transaction.markApplying();
        observeCommit = true;
        await transaction.markCommitted();
        assert.deepEqual(syncedDirectories, [dirname(transaction.journalPath)]);
      } finally {
        await transaction.release();
      }
    });
  });

  await t.test("manifest", async () => {
    await withLayout(async (layout) => {
      let observeManifest = false;
      const syncedDirectories: string[] = [];
      const transaction = await beginTransaction(layout, {
        operationId: "manifest-parent-sync",
        io: {
          async syncDirectory(path) {
            if (observeManifest) {
              assert.equal(
                await access(join(transaction.backupDirectory, "manifest.json")).then(
                  () => true,
                  () => false,
                ),
                true,
              );
              syncedDirectories.push(path);
            }
          },
        },
      });

      try {
        observeManifest = true;
        await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
        observeManifest = false;
        assert.deepEqual(syncedDirectories, [transaction.backupDirectory]);
        await transaction.markRolledBack();
      } finally {
        await transaction.release();
      }
    });
  });

  await t.test("restore", async () => {
    await withLayout(async (layout) => {
      const original = await readFile(layout.configPath);
      let observeRestore = false;
      const syncedDirectories: string[] = [];
      const transaction = await beginTransaction(layout, {
        operationId: "restore-parent-sync",
        io: {
          async syncDirectory(path) {
            if (observeRestore && path === dirname(layout.configPath)) {
              assert.deepEqual(await readFile(layout.configPath), original);
              syncedDirectories.push(path);
            }
          },
        },
      });

      try {
        await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
        await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
        await writeFile(layout.configPath, "changed config", "utf8");
        observeRestore = true;
        await transaction.rollback();
        observeRestore = false;
        assert.deepEqual(syncedDirectories, [dirname(layout.configPath)]);
      } finally {
        await transaction.release();
      }
    });
  });
});

test("syncs each parent after creating the operation and backup directories", async () => {
  await withLayout(async (layout) => {
    const operationId = "directory-creation-sync";
    const transactionsDirectory = join(layout.switcherDir, "transactions");
    const operationDirectory = join(transactionsDirectory, operationId);
    const syncedDirectories: string[] = [];
    const transaction = await beginTransaction(layout, {
      operationId,
      io: {
        async syncDirectory(path) {
          syncedDirectories.push(path);
        },
      },
    });

    try {
      assert.deepEqual(syncedDirectories, [
        layout.codexHome,
        layout.switcherDir,
        transactionsDirectory,
        operationDirectory,
        operationDirectory,
      ]);
    } finally {
      await transaction.markRolledBack();
      await transaction.release();
    }
  });
});

test("syncs both newly created transaction hierarchy parents exactly once", async () => {
  await withLayout(async (layout) => {
    await rm(layout.switcherDir, { recursive: true });
    const operationId = "new-transaction-hierarchy";
    const transactionsDirectory = join(layout.switcherDir, "transactions");
    const operationDirectory = join(transactionsDirectory, operationId);
    const syncedDirectories: string[] = [];
    const transaction = await beginTransaction(layout, {
      operationId,
      io: {
        async syncDirectory(path) {
          syncedDirectories.push(path);
        },
      },
    });

    try {
      assert.deepEqual(syncedDirectories, [
        layout.codexHome,
        layout.switcherDir,
        transactionsDirectory,
        operationDirectory,
        operationDirectory,
      ]);
    } finally {
      await transaction.markRolledBack();
      await transaction.release();
    }
  });
});

test("fails closed before prepared when a transaction hierarchy sync fails", async (t) => {
  for (const phase of ["switcher", "transactions"] as const) {
    await t.test(phase, async () => {
      await withLayout(async (layout) => {
        if (phase === "switcher") {
          await rm(layout.switcherDir, { recursive: true });
        }
        const operationId = `${phase}-hierarchy-sync-failure`;
        const transactionsDirectory = join(layout.switcherDir, "transactions");
        const operationDirectory = join(transactionsDirectory, operationId);
        const failingParent = phase === "switcher"
          ? layout.codexHome
          : layout.switcherDir;
        const syncError = new Error(`injected ${phase} hierarchy sync failure`);
        const syncedDirectories: string[] = [];

        const result = await beginTransaction(layout, {
          operationId,
          io: {
            async syncDirectory(path) {
              syncedDirectories.push(path);
              if (path === failingParent) {
                throw syncError;
              }
            },
          },
        }).then(
          (handle) => ({ handle }),
          (error: unknown) => ({ error }),
        );

        try {
          assert.ok("error" in result);
          assert.equal(result.error instanceof Error ? result.error.cause : undefined, syncError);
          assert.deepEqual(
            syncedDirectories,
            phase === "switcher" ? [failingParent] : [layout.codexHome, failingParent],
          );
          await assert.rejects(() => access(operationDirectory), { code: "ENOENT" });
          await assert.rejects(() => access(operationLockPath(layout)), { code: "ENOENT" });
        } finally {
          if ("handle" in result) {
            await result.handle.markRolledBack();
            await result.handle.release();
          }
        }
      });
    });
  }
});

test("resyncs a transaction hierarchy parent before retrying after its creation sync fails", async (t) => {
  for (const phase of ["switcher", "transactions"] as const) {
    await t.test(phase, async () => {
      await withLayout(async (layout) => {
        if (phase === "switcher") {
          await rm(layout.switcherDir, { recursive: true });
        }
        const operationId = `retry-${phase}-parent-sync`;
        const failedParent = phase === "switcher"
          ? layout.codexHome
          : layout.switcherDir;
        let failParentSync = true;
        const retrySyncedDirectories: string[] = [];
        const io = {
          async syncDirectory(path: string) {
            if (failParentSync && path === failedParent) {
              throw new Error(`injected ${phase} parent sync failure`);
            }
            if (!failParentSync) {
              retrySyncedDirectories.push(path);
            }
          },
        };

        await assert.rejects(
          () => beginTransaction(layout, { operationId, io }),
          /could not prepare|transaction root/i,
        );

        failParentSync = false;
        const transaction = await beginTransaction(layout, { operationId, io });
        try {
          assert.equal(retrySyncedDirectories.includes(failedParent), true);
          assert.equal(
            (await readTransactionJournal(transaction.journalPath)).at(-1)?.state,
            "prepared",
          );
        } finally {
          await transaction.markRolledBack();
          await transaction.release();
        }
      });
    });
  }
});

test("fails closed before prepared when a directory creation sync fails", async (t) => {
  for (const phase of ["operation", "backup"] as const) {
    await t.test(phase, async () => {
      await withLayout(async (layout) => {
        const operationId = `${phase}-directory-sync-failure`;
        const transactionsDirectory = join(layout.switcherDir, "transactions");
        const operationDirectory = join(transactionsDirectory, operationId);
        const journalPath = join(operationDirectory, "journal.jsonl");
        const syncError = new Error(`injected ${phase} directory sync failure`);
        const syncedDirectories: string[] = [];
        let preparedVisibleDuringCleanup: boolean | undefined;

        const result = await beginTransaction(layout, {
          operationId,
          io: {
            async syncDirectory(path) {
              syncedDirectories.push(path);
              const failingDirectory = phase === "operation"
                ? transactionsDirectory
                : operationDirectory;
              if (path === failingDirectory) {
                throw syncError;
              }
            },
            async removeTransactionDirectory(path) {
              preparedVisibleDuringCleanup = await access(journalPath).then(
                () => true,
                () => false,
              );
              await rm(path, { recursive: true, force: true });
            },
          },
        }).then(
          (handle) => ({ handle }),
          (error: unknown) => ({ error }),
        );

        try {
          assert.ok("error" in result);
          const cause = result.error instanceof Error ? result.error.cause : undefined;
          if (phase === "operation") {
            assert.equal(cause instanceof AggregateError, true);
            assert.equal(
              cause instanceof AggregateError && cause.errors.every((error) => error === syncError),
              true,
            );
          } else {
            assert.equal(cause, syncError);
          }
          assert.deepEqual(
            syncedDirectories,
            phase === "operation"
              ? [layout.codexHome, layout.switcherDir, transactionsDirectory, transactionsDirectory]
              : [
                layout.codexHome,
                layout.switcherDir,
                transactionsDirectory,
                operationDirectory,
                transactionsDirectory,
              ],
          );
          assert.equal(preparedVisibleDuringCleanup, false);
          await assert.rejects(() => access(operationDirectory), { code: "ENOENT" });
          await assert.rejects(() => access(operationLockPath(layout)), { code: "ENOENT" });
        } finally {
          if ("handle" in result) {
            await result.handle.markRolledBack();
            await result.handle.release();
          }
        }
      });
    });
  }
});

test("does not compensate a visible commit when its parent directory sync fails", async () => {
  await withLayout(async (layout) => {
    const syncError = new Error("secret injected committed journal parent sync failure");
    let failCommittedSync = false;
    const committedConfig = "model_provider = 'committed'\n";
    const transaction = await beginTransaction(layout, {
      operationId: "committed-parent-sync-failure",
      io: {
        async syncDirectory(path) {
          if (failCommittedSync && path === dirname(transaction.journalPath)) {
            throw syncError;
          }
        },
      },
    });

    try {
      await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
      await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
      await writeFile(layout.configPath, committedConfig, "utf8");
      failCommittedSync = true;

      await assert.rejects(
        () => transaction.markCommitted(),
        (error: unknown) => (
          error instanceof Error &&
          error.name === "CommittedJournalDurabilityError" &&
          !collectErrorDetails(error).includes(syncError.message)
        ),
      );
      assert.equal(
        (await readTransactionJournal(transaction.journalPath)).at(-1)?.state,
        "committed",
      );
      await assert.rejects(() => transaction.validateRollback(), /committed|compensat/i);
      await assert.rejects(() => transaction.rollback(), /committed|compensat/i);
      assert.equal(await readFile(layout.configPath, "utf8"), committedConfig);
    } finally {
      await transaction.release();
    }
  });
});

test("syncs an absent byte target deletion before publishing rolledBack", async (t) => {
  for (const targetState of ["materialized", "already-missing"] as const) {
    await t.test(targetState, async () => {
      await withLayout(async (layout) => {
        await rm(layout.configPath);
        let observeRollback = false;
        const events: string[] = [];
        const transaction = await beginTransaction(layout, {
          operationId: `absent-config-${targetState}`,
          io: {
            async syncDirectory(path) {
              if (observeRollback && path === dirname(layout.configPath)) {
                await assert.rejects(() => access(layout.configPath), { code: "ENOENT" });
                events.push("config-parent-synced");
              }
            },
            async renameJournal(source, destination) {
              if (observeRollback) {
                const records = (await readFile(source, "utf8")).trim().split("\n");
                if (JSON.parse(records.at(-1)!).state === "rolledBack") {
                  events.push("rolledBack-published");
                }
              }
              await rename(source, destination);
            },
          },
        });

        try {
          await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
          await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
          if (targetState === "materialized") {
            await writeFile(layout.configPath, "new config", "utf8");
          }
          observeRollback = true;
          await transaction.rollback();
          observeRollback = false;

          assert.deepEqual(events, ["config-parent-synced", "rolledBack-published"]);
        } finally {
          await transaction.release();
        }
      });
    });
  }
});

test("does not publish rolledBack when absent-target directory sync fails", async (t) => {
  for (const mode of ["rollback", "recovery"] as const) {
    await t.test(mode, async () => {
      await withLayout(async (layout) => {
        await rm(layout.configPath);
        const operationId = `absent-config-sync-failure-${mode}`;
        const syncError = new Error("injected absent-target parent sync failure");
        let failTargetSync = false;
        const io = {
          async syncDirectory(path: string) {
            if (failTargetSync && path === dirname(layout.configPath)) {
              const targetWasRemoved = await access(layout.configPath).then(
                () => false,
                (error: NodeJS.ErrnoException) => {
                  if (error.code === "ENOENT") {
                    return true;
                  }
                  throw error;
                },
              );
              if (targetWasRemoved) {
                throw syncError;
              }
            }
          },
        };
        const transaction = await beginTransaction(layout, {
          operationId,
          ...(mode === "rollback" ? { io } : {}),
        });
        await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
        await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
        await writeFile(layout.configPath, "new config", "utf8");
        failTargetSync = true;

        if (mode === "rollback") {
          try {
            await assert.rejects(() => transaction.rollback(), /could not be fully rolled back/i);
          } finally {
            await transaction.release();
          }
        } else {
          await transaction.release();
          const result = await recoverPendingSwitches(layout, {
            isProcessAlive: () => false,
            io,
          });
          assert.deepEqual(result.recoveredOperationIds, []);
          assert.deepEqual(result.recoveryRequiredOperationIds, [operationId]);
        }

        const journal = await readTransactionJournal(transaction.journalPath);
        assert.equal(journal.some((entry) => entry.state === "rolledBack"), false);
        assert.equal(journal.at(-1)?.state, "recoveryRequired");
      });
    });
  }
});

test("rejects direct rolledBack publication from applying with an absent byte target", async () => {
  await withLayout(async (layout) => {
    await rm(layout.configPath);
    const transaction = await beginTransaction(layout, {
      operationId: "reject-direct-absent-target-rollback",
    });

    try {
      await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
      await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
      await writeFile(layout.configPath, "materialized config", "utf8");

      await assert.rejects(() => transaction.markRolledBack(), /rolled back|application/i);
      assert.equal(
        (await readTransactionJournal(transaction.journalPath)).at(-1)?.state,
        "applying",
      );
      assert.equal(await readFile(layout.configPath, "utf8"), "materialized config");

      await transaction.rollback();
      await assert.rejects(() => access(layout.configPath), { code: "ENOENT" });
    } finally {
      await transaction.release();
    }
  });
});

test("retries finite journal short writes until every record is complete", async () => {
  await withLayout(async (layout) => {
    let writeCalls = 0;
    const transaction = await beginTransaction(layout, {
      operationId: "journal-short-write",
      io: {
        async write(
          handle: FileHandle,
          buffer: Buffer,
          offset: number,
          length: number,
        ): Promise<number> {
          writeCalls += 1;
          const result = await handle.write(
            buffer,
            offset,
            Math.min(length, 7),
            null,
          );
          return result.bytesWritten;
        },
      },
    });

    await transaction.markApplying();
    await transaction.markCommitted();
    await transaction.release();

    assert.ok(writeCalls > 3);
    assert.deepEqual(
      (await readTransactionJournal(transaction.journalPath)).map((entry) => entry.state),
      ["prepared", "applying", "committed"],
    );
  });
});

test("rejects a zero-byte journal write without advancing transaction state", async () => {
  await withLayout(async (layout) => {
    let returnZero = false;
    const transaction = await beginTransaction(layout, {
      operationId: "journal-zero-write",
      io: {
        async write(
          handle: FileHandle,
          buffer: Buffer,
          offset: number,
          length: number,
        ): Promise<number> {
          if (returnZero) {
            return 0;
          }
          return (await handle.write(buffer, offset, length, null)).bytesWritten;
        },
      },
    });

    returnZero = true;
    await assert.rejects(() => transaction.markApplying(), /zero bytes/i);
    returnZero = false;
    await transaction.markApplying();
    await transaction.markCommitted();
    await transaction.release();

    assert.deepEqual(
      (await readTransactionJournal(transaction.journalPath)).map((entry) => entry.state),
      ["prepared", "applying", "committed"],
    );
  });
});

test("removes partial journal records after a zero-byte or thrown write", async (t) => {
  const failures = [
    {
      name: "zero-byte write",
      error: new Error("Journal write returned zero bytes or an invalid byte count."),
      fail: async (): Promise<number> => 0,
    },
    {
      name: "thrown write",
      error: new Error("injected journal write failure"),
      fail: async (): Promise<number> => {
        throw new Error("injected journal write failure");
      },
    },
  ] as const;

  for (const failure of failures) {
    await t.test(failure.name, async () => {
      await withLayout(async (layout) => {
        let failing = false;
        let wrotePartialRecord = false;
        const transaction = await beginTransaction(layout, {
          operationId: `journal-partial-${failure.name.replace(/[^a-z]+/g, "-")}`,
          io: {
            async write(
              handle: FileHandle,
              buffer: Buffer,
              offset: number,
              length: number,
            ): Promise<number> {
              if (failing && !wrotePartialRecord) {
                wrotePartialRecord = true;
                return (await handle.write(buffer, offset, Math.min(length, 7), null)).bytesWritten;
              }
              if (failing) {
                return failure.fail();
              }
              return (await handle.write(buffer, offset, length, null)).bytesWritten;
            },
          },
        });
        const before = await readFile(transaction.journalPath, "utf8");

        try {
          failing = true;
          await assert.rejects(() => transaction.markApplying(), (error: unknown) => (
            error instanceof Error && error.message === failure.error.message
          ));
          assert.equal(await readFile(transaction.journalPath, "utf8"), before);

          failing = false;
          await transaction.markApplying();
          await transaction.markCommitted();
          assert.deepEqual(
            (await readTransactionJournal(transaction.journalPath)).map((entry) => entry.state),
            ["prepared", "applying", "committed"],
          );
        } finally {
          await transaction.release();
        }
      });
    });
  }
});

test("reports both a journal write error and its temporary cleanup error", async () => {
  await withLayout(async (layout) => {
    const writeError = new Error("injected journal write failure");
    const cleanupError = new Error("injected journal temporary cleanup failure");
    let failing = false;
    let wrotePartialRecord = false;
    const transaction = await beginTransaction(layout, {
      operationId: "journal-truncate-cleanup-failure",
      io: {
        async write(
          handle: FileHandle,
          buffer: Buffer,
          offset: number,
          length: number,
        ): Promise<number> {
          if (failing && !wrotePartialRecord) {
            wrotePartialRecord = true;
            return (await handle.write(buffer, offset, Math.min(length, 7), null)).bytesWritten;
          }
          if (failing) {
            throw writeError;
          }
          return (await handle.write(buffer, offset, length, null)).bytesWritten;
        },
        removeJournalTemporary: async () => {
          throw cleanupError;
        },
      },
    });

    try {
      failing = true;
      await assert.rejects(
        () => transaction.markApplying(),
        (error: unknown) => (
          error instanceof AggregateError &&
          error.errors.includes(writeError) &&
          error.errors.includes(cleanupError)
        ),
      );
    } finally {
      await transaction.release();
    }
  });
});

test("removes complete journal records after sync or close fails", async (t) => {
  const failures = ["sync", "close"] as const;

  for (const phase of failures) {
    await t.test(phase, async () => {
      await withLayout(async (layout) => {
        const failure = new Error(`injected journal ${phase} failure`);
        let failing = false;
        const transaction = await beginTransaction(layout, {
          operationId: `journal-${phase}-failure`,
          io: {
            syncJournal: async (handle: FileHandle) => {
              if (phase === "sync" && failing) {
                throw failure;
              }
              await handle.sync();
            },
            closeJournal: async (handle: FileHandle) => {
              await handle.close();
              if (phase === "close" && failing) {
                throw failure;
              }
            },
          },
        });
        const before = await readFile(transaction.journalPath, "utf8");

        try {
          failing = true;
          await assert.rejects(() => transaction.markApplying(), (error: unknown) => error === failure);
          assert.equal(await readFile(transaction.journalPath, "utf8"), before);

          failing = false;
          await transaction.markApplying();
          await transaction.markCommitted();
          assert.deepEqual(
            (await readTransactionJournal(transaction.journalPath)).map((entry) => entry.state),
            ["prepared", "applying", "committed"],
          );
        } finally {
          await transaction.release();
        }
      });
    });
  }
});

test("keeps the previous journal snapshot when journal rename fails", async () => {
  await withLayout(async (layout) => {
    const renameError = new Error("injected journal rename failure");
    let failing = false;
    const transaction = await beginTransaction(layout, {
      operationId: "journal-rename-failure",
      io: {
        renameJournal: async (source: string, destination: string) => {
          if (failing) {
            throw renameError;
          }
          await rename(source, destination);
        },
      },
    });
    const before = await readFile(transaction.journalPath, "utf8");

    try {
      failing = true;
      await assert.rejects(() => transaction.markApplying(), (error: unknown) => error === renameError);
      assert.equal(await readFile(transaction.journalPath, "utf8"), before);

      failing = false;
      await transaction.markApplying();
      await transaction.markCommitted();
      assert.deepEqual(
        (await readTransactionJournal(transaction.journalPath)).map((entry) => entry.state),
        ["prepared", "applying", "committed"],
      );
    } finally {
      await transaction.release();
    }
  });
});

test("refuses to append to an invalid journal snapshot", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "invalid-journal-snapshot" });
    const invalid = "{\"version\":1";
    await writeFile(transaction.journalPath, invalid, "utf8");

    try {
      await assert.rejects(() => transaction.markApplying(), /journal is invalid/i);
      assert.equal(await readFile(transaction.journalPath, "utf8"), invalid);
    } finally {
      await transaction.release();
    }
  });
});

test("rejects a hard-linked journal temporary before replacing the snapshot", async () => {
  await withLayout(async (layout) => {
    const externalTemporaryPath = join(layout.codexHome, "external-journal-temporary");
    const externalBytes = Buffer.from("external journal temporary bytes");
    await writeFile(externalTemporaryPath, externalBytes);
    let attack = false;
    let transactionDirectory = "";
    const transaction = await beginTransaction(layout, {
      operationId: "hardlinked-journal-temporary",
      io: {
        closeJournal: async (handle: FileHandle) => {
          await handle.close();
          if (!attack) {
            return;
          }
          const temporaryName = (await readdir(transactionDirectory)).find((entry) => (
            entry.startsWith(".journal.jsonl.journal-")
          ));
          assert.ok(temporaryName);
          const temporaryPath = join(transactionDirectory, temporaryName);
          await rm(temporaryPath);
          await link(externalTemporaryPath, temporaryPath);
        },
      },
    });
    transactionDirectory = transaction.directory;
    const beforeJournal = await readFile(transaction.journalPath);

    try {
      attack = true;
      await assert.rejects(
        () => transaction.markApplying(),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "journal-invalid",
      );
      assert.deepEqual(await readFile(externalTemporaryPath), externalBytes);
      assert.deepEqual(await readFile(transaction.journalPath), beforeJournal);
      assert.equal(
        (await readdir(transaction.directory)).some((entry) => entry.startsWith(".journal.jsonl.journal-")),
        false,
      );
    } finally {
      attack = false;
      await transaction.release();
    }
  });
});

test("rejects a symlinked journal temporary before replacing the snapshot", async (t) => {
  await withLayout(async (layout) => {
    const externalTemporaryPath = join(layout.codexHome, "external-journal-temporary");
    const externalBytes = Buffer.from("external journal temporary bytes");
    await writeFile(externalTemporaryPath, externalBytes);
    let attack = false;
    let transactionDirectory = "";
    const transaction = await beginTransaction(layout, {
      operationId: "symlinked-journal-temporary",
      io: {
        closeJournal: async (handle: FileHandle) => {
          await handle.close();
          if (!attack) {
            return;
          }
          const temporaryName = (await readdir(transactionDirectory)).find((entry) => (
            entry.startsWith(".journal.jsonl.journal-")
          ));
          assert.ok(temporaryName);
          const temporaryPath = join(transactionDirectory, temporaryName);
          await rm(temporaryPath);
          try {
            await symlink(externalTemporaryPath, temporaryPath, "file");
          } catch (error: unknown) {
            if (isWindowsSymlinkPrivilegeError(error)) {
              t.skip("creating file symlinks requires Windows developer mode or equivalent privilege");
              return;
            }
            throw error;
          }
        },
      },
    });
    transactionDirectory = transaction.directory;
    const beforeJournal = await readFile(transaction.journalPath);

    try {
      attack = true;
      await assert.rejects(
        () => transaction.markApplying(),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "journal-invalid",
      );
      assert.deepEqual(await readFile(externalTemporaryPath), externalBytes);
      assert.deepEqual(await readFile(transaction.journalPath), beforeJournal);
      assert.equal(
        (await readdir(transaction.directory)).some((entry) => entry.startsWith(".journal.jsonl.journal-")),
        false,
      );
    } finally {
      attack = false;
      await transaction.release();
    }
  });
});

test("rejects a journal directory symlink swap before replacing the snapshot", async (t) => {
  await withLayout(async (layout) => {
    const externalDirectory = join(layout.codexHome, "external-journal-directory");
    const movedDirectory = join(layout.codexHome, "moved-journal-directory");
    const externalJournalPath = join(externalDirectory, "journal.jsonl");
    const externalJournalBytes = Buffer.from("external journal bytes");
    const externalTemporaryBytes = Buffer.from("external temporary bytes");
    const symlinkProbe = join(layout.switcherDir, "directory-symlink-probe");
    await mkdir(externalDirectory);
    await writeFile(externalJournalPath, externalJournalBytes);
    try {
      await symlink(externalDirectory, symlinkProbe, "dir");
      await rm(symlinkProbe);
    } catch (error: unknown) {
      if (isWindowsSymlinkPrivilegeError(error)) {
        t.skip("creating directory symlinks requires Windows developer mode or equivalent privilege");
        return;
      }
      throw error;
    }

    let attack = false;
    let transactionDirectory = "";
    const transaction = await beginTransaction(layout, {
      operationId: "journal-directory-swap",
      io: {
        closeJournal: async (handle: FileHandle) => {
          await handle.close();
          if (!attack) {
            return;
          }
          const temporaryName = (await readdir(transactionDirectory)).find((entry) => (
            entry.startsWith(".journal.jsonl.journal-")
          ));
          assert.ok(temporaryName);
          await rename(transactionDirectory, movedDirectory);
          await writeFile(join(externalDirectory, temporaryName), externalTemporaryBytes);
          await symlink(externalDirectory, transactionDirectory, "dir");
        },
      },
    });
    transactionDirectory = transaction.directory;

    try {
      attack = true;
      await assert.rejects(
        () => transaction.markApplying(),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "journal-invalid",
      );
      assert.deepEqual(await readFile(externalJournalPath), externalJournalBytes);
      const externalTemporary = (await readdir(externalDirectory)).find((entry) => (
        entry.startsWith(".journal.jsonl.journal-")
      ));
      assert.ok(externalTemporary);
      assert.deepEqual(await readFile(join(externalDirectory, externalTemporary)), externalTemporaryBytes);
    } finally {
      attack = false;
      await transaction.release();
    }
  });
});

test("removes the operation directory when the first prepared journal write fails", async () => {
  await withLayout(async (layout) => {
    const operationId = "prepared-write-failure";
    const directory = join(layout.switcherDir, "transactions", operationId);
    const writeError = new Error("injected prepared journal write failure");

    await assert.rejects(
      () => beginTransaction(layout, {
        operationId,
        io: {
          write: async () => {
            throw writeError;
          },
        },
      }),
      (error: unknown) => error instanceof Error && error.cause === writeError,
    );
    await assert.rejects(() => access(directory), { code: "ENOENT" });
  });
});

test("syncs the transactions parent after removing a failed prepared operation", async () => {
  await withLayout(async (layout) => {
    const operationId = "prepared-removal-parent-sync";
    const transactionsDirectory = join(layout.switcherDir, "transactions");
    const operationDirectory = join(transactionsDirectory, operationId);
    const journalPath = join(operationDirectory, "journal.jsonl");
    const writeError = new Error("injected prepared journal write failure");
    const cleanupSyncError = new Error("injected prepared removal parent sync failure");
    const events: string[] = [];
    let operationRemoved = false;
    let parentSyncBeforeRelease = false;

    const error = await beginTransaction(layout, {
      operationId,
      io: {
        async write() {
          throw writeError;
        },
        async removeTransactionDirectory(path: string) {
          assert.equal(path, operationDirectory);
          await rm(path, { recursive: true, force: true });
          operationRemoved = true;
          events.push("operation-removed");
        },
        async syncDirectory(path: string) {
          if (operationRemoved && path === transactionsDirectory) {
            await assert.rejects(() => access(operationDirectory), { code: "ENOENT" });
            events.push("transactions-parent-synced");
            throw cleanupSyncError;
          }
        },
        async afterLockOwnershipVerified(_path, phase) {
          if (phase === "release") {
            parentSyncBeforeRelease = events.includes("transactions-parent-synced");
            events.push("lock-release");
          }
        },
      },
    }).then(
      () => assert.fail("beginTransaction unexpectedly succeeded"),
      (failure: unknown) => failure,
    );

    assert.equal(
      error instanceof Error && error.cause instanceof AggregateError &&
        error.cause.errors.includes(writeError) &&
        error.cause.errors.includes(cleanupSyncError),
      true,
    );
    assert.equal(parentSyncBeforeRelease, true);
    assert.deepEqual(events, ["operation-removed", "transactions-parent-synced", "lock-release"]);
    await assert.rejects(() => access(operationDirectory), { code: "ENOENT" });
    await assert.rejects(() => access(journalPath), { code: "ENOENT" });
  });
});

test("reports prepared journal, directory cleanup, and lock release failures", async () => {
  await withLayout(async (layout) => {
    const writeError = new Error("injected prepared journal write failure");
    const directoryError = new Error("injected transaction directory cleanup failure");
    const lockError = new Error("injected lock release failure");

    await assert.rejects(
      () => beginTransaction(layout, {
        operationId: "prepared-cleanup-errors",
        io: {
          write: async () => {
            throw writeError;
          },
          removeTransactionDirectory: async () => {
            throw directoryError;
          },
          releaseLock: async () => {
            throw lockError;
          },
        },
      }),
      (error: unknown) => {
        const cause = error instanceof Error ? error.cause : undefined;
        return (
          cause instanceof AggregateError &&
          cause.errors.includes(writeError) &&
          cause.errors.includes(directoryError) &&
          cause.errors.includes(lockError)
        );
      },
    );
  });
});

test("refuses a tampered config backup and records recoveryRequired", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "tampered-backup" });
    const manifest = await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
    await writeFile(manifest.entries[0].backupPath!, "tampered backup", "utf8");
    await transaction.markApplying([layout.configPath]);
    await writeFile(layout.configPath, "changed config", "utf8");

    await assert.rejects(() => transaction.rollback(), /could not be fully rolled back/i);
    assert.equal(await readFile(layout.configPath, "utf8"), "changed config");
    const journal = await readFile(transaction.journalPath, "utf8");
    assert.equal(JSON.parse(journal.trim().split("\n").at(-1)!).state, "recoveryRequired");
    await transaction.release();
  });
});

test("refuses a config backup path outside its transaction directory", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "external-backup" });
    await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
    const externalBackupPath = join(layout.codexHome, "external-config-backup");
    await writeFile(externalBackupPath, await readFile(layout.configPath));
    const manifestPath = join(transaction.backupDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.entries[0].backupPath = externalBackupPath;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    await transaction.markApplying([layout.configPath]);
    await writeFile(layout.configPath, "changed config", "utf8");

    await assert.rejects(() => transaction.rollback(), /could not be fully rolled back/i);
    assert.equal(await readFile(layout.configPath, "utf8"), "changed config");
    await transaction.release();
  });
});

test("fails closed when an existing backup manifest omits original permissions", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "missing-backup-mode" });
    await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
    const manifestPath = join(transaction.backupDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.entries[0].mode;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
    await writeFile(layout.configPath, "changed config", "utf8");

    try {
      await assert.rejects(() => transaction.rollback(), /could not be fully rolled back/i);
      assert.equal(await readFile(layout.configPath, "utf8"), "changed config");
      assert.equal(
        (await readTransactionJournal(transaction.journalPath)).at(-1)?.state,
        "recoveryRequired",
      );
    } finally {
      await transaction.release();
    }
  });
});

test("fails closed when a backup manifest contains unknown schema fields", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "unknown-manifest-field" });
    await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
    const manifestPath = join(transaction.backupDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.unexpected = true;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
    await writeFile(layout.configPath, "changed config", "utf8");

    try {
      await assert.rejects(() => transaction.rollback(), /could not be fully rolled back/i);
      assert.equal(await readFile(layout.configPath, "utf8"), "changed config");
      assert.equal(
        (await readTransactionJournal(transaction.journalPath)).at(-1)?.state,
        "recoveryRequired",
      );
    } finally {
      await transaction.release();
    }
  });
});

test(
  "restores the exact original permission bits on Linux",
  { skip: process.platform !== "linux" },
  async () => {
    await withLayout(async (layout) => {
      const originalMode = 0o640;
      const originalContents = await readFile(layout.configPath);
      await chmod(layout.configPath, originalMode);
      const transaction = await beginTransaction(layout, { operationId: "restore-backup-mode" });
      await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
      await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
      await writeFile(layout.configPath, "changed config", "utf8");
      await chmod(layout.configPath, 0o666);

      try {
        await transaction.rollback();
        assert.deepEqual(await readFile(layout.configPath), originalContents);
        assert.equal((await lstat(layout.configPath)).mode & 0o777, originalMode);
      } finally {
        await transaction.release();
      }
    });
  },
);

test("rejects a symbolic config source instead of backing up auth content", async (t) => {
  await withLayout(async (layout) => {
    await rm(layout.configPath);
    try {
      await symlink(layout.authPath, layout.configPath, "file");
    } catch (error: unknown) {
      if (isWindowsSymlinkPrivilegeError(error)) {
        t.skip("creating file symlinks requires Windows developer mode or equivalent privilege");
        return;
      }
      throw error;
    }

    const transaction = await beginTransaction(layout, { operationId: "symlink-source" });
    try {
      await assert.rejects(
        () => transaction.backupTargets([{ kind: "config", path: layout.configPath }]),
        /backup target/i,
      );
      await assert.rejects(() => access(join(transaction.backupDirectory, "0000-config.toml")));
    } finally {
      await transaction.markRolledBack();
      await transaction.release();
    }
  });
});

test("rejects a config hard link to auth when filesystem metadata identifies the alias", async () => {
  await withLayout(async (layout) => {
    await rm(layout.configPath);
    await link(layout.authPath, layout.configPath);
    const transaction = await beginTransaction(layout, { operationId: "hardlink-auth-source" });
    try {
      await assert.rejects(
        () => transaction.backupTargets([{ kind: "config", path: layout.configPath }]),
        /backup target/i,
      );
    } finally {
      await transaction.markRolledBack();
      await transaction.release();
    }
  });
});

test("fails closed when the config path becomes an auth alias after source lstat", async () => {
  await withLayout(async (layout) => {
    const displacedConfigPath = join(layout.codexHome, "config-before-backup-race.toml");
    const secret = "sk-backup-race-must-not-be-read";
    await writeFile(layout.authPath, JSON.stringify({ OPENAI_API_KEY: secret }), "utf8");
    let hookCalls = 0;
    const transaction = await beginTransaction(layout, {
      operationId: "backup-source-replacement",
      io: {
        async afterBackupSourceLstat(sourcePath) {
          assert.equal(sourcePath, layout.configPath);
          hookCalls += 1;
          await rename(layout.configPath, displacedConfigPath);
          try {
            await symlink(layout.authPath, layout.configPath, "file");
          } catch (error: unknown) {
            if (!isWindowsSymlinkPrivilegeError(error)) {
              throw error;
            }
            await link(layout.authPath, layout.configPath);
          }
        },
      },
    });
    let failure: unknown;
    try {
      await assert.rejects(
        () => transaction.backupTargets([{ kind: "config", path: layout.configPath }]),
        (error: unknown) => {
          failure = error;
          return (
            error instanceof Error &&
            "code" in error &&
            error.code === "invalid-backup-target"
          );
        },
      );
      assert.equal(hookCalls, 1);
      const backupFiles = await readdir(transaction.backupDirectory);
      const backupBytes = Buffer.concat(await Promise.all(
        backupFiles.map((name) => readFile(join(transaction.backupDirectory, name))),
      ));
      assert.equal(backupBytes.includes(Buffer.from(secret)), false);
      assert.doesNotMatch(String(failure), new RegExp(secret));
    } finally {
      await transaction.markRolledBack();
      await transaction.release();
    }
  });
});

test("discards backup bytes when the source path changes after handle-bound reading", async () => {
  await withLayout(async (layout) => {
    const displacedConfigPath = join(layout.codexHome, "config-after-backup-read.toml");
    const replacementBytes = "replacement after source read";
    let hookCalls = 0;
    const transaction = await beginTransaction(layout, {
      operationId: "backup-source-post-read-replacement",
      io: {
        async afterBackupSourceRead(sourcePath) {
          assert.equal(sourcePath, layout.configPath);
          hookCalls += 1;
          await rename(layout.configPath, displacedConfigPath);
          await writeFile(layout.configPath, replacementBytes, "utf8");
        },
      },
    });
    try {
      await assert.rejects(
        () => transaction.backupTargets([{ kind: "config", path: layout.configPath }]),
        (error: unknown) => (
          error instanceof Error &&
          "code" in error &&
          error.code === "invalid-backup-target"
        ),
      );
      assert.equal(hookCalls, 1);
      assert.equal(await readFile(layout.configPath, "utf8"), replacementBytes);
      assert.deepEqual(await readdir(transaction.backupDirectory), []);
    } finally {
      await transaction.markRolledBack();
      await transaction.release();
    }
  });
});

test("rejects a symbolic backup file during restoration", async (t) => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "symlink-backup" });
    const manifest = await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
    const [entry] = manifest.entries;
    assert.ok(entry?.backupPath);
    const replacement = join(transaction.directory, "replacement-config");
    await writeFile(replacement, await readFile(entry.backupPath));
    await rm(entry.backupPath);
    try {
      await symlink(replacement, entry.backupPath, "file");
    } catch (error: unknown) {
      if (isWindowsSymlinkPrivilegeError(error)) {
        t.skip("creating file symlinks requires Windows developer mode or equivalent privilege");
        return;
      }
      throw error;
    }
    await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
    await writeFile(layout.configPath, "changed config", "utf8");

    await assert.rejects(() => transaction.rollback(), /could not be fully rolled back/i);
    assert.equal(await readFile(layout.configPath, "utf8"), "changed config");
    await transaction.release();
  });
});

test("rejects a hard-linked backup file during restoration", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "hardlink-backup" });
    const manifest = await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
    const [entry] = manifest.entries;
    assert.ok(entry?.backupPath);
    await link(entry.backupPath, join(transaction.directory, "backup-alias"));
    await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
    await writeFile(layout.configPath, "changed config", "utf8");

    await assert.rejects(
      () => transaction.rollback(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "rollback-failed",
    );
    assert.equal(await readFile(layout.configPath, "utf8"), "changed config");
    const journal = await readFile(transaction.journalPath, "utf8");
    assert.equal(JSON.parse(journal.trim().split("\n").at(-1)!).state, "recoveryRequired");
    await transaction.release();
  });
});

test("fails closed when a validated backup is replaced before restore reads it", async (t) => {
  const targets = [
    { kind: "config" as const, path: (layout: CodexLayout) => layout.configPath },
    { kind: "sqlite" as const, path: (layout: CodexLayout) => layout.sqlitePath },
  ];
  const replacements = ["regular", "hardlink", "symlink"] as const;

  for (const target of targets) {
    for (const replacementKind of replacements) {
      await t.test(`${target.kind} backup replaced with ${replacementKind}`, async (subtest) => {
        await withLayout(async (layout) => {
          const targetPath = target.path(layout);
          const replacementBytes = Buffer.from(
            `replacement bytes that must never be restored for ${target.kind}-${replacementKind}`,
          );
          const externalReplacementPath = join(
            layout.codexHome,
            `external-${target.kind}-${replacementKind}-backup`,
          );
          if (replacementKind === "symlink") {
            await writeFile(externalReplacementPath, replacementBytes);
            const probePath = join(layout.codexHome, "backup-replacement-symlink-probe");
            try {
              await symlink(externalReplacementPath, probePath, "file");
              await rm(probePath);
            } catch (error: unknown) {
              if (isWindowsSymlinkPrivilegeError(error)) {
                subtest.skip("creating file symlinks requires Windows developer mode or equivalent privilege");
                return;
              }
              throw error;
            }
          }

          let expectedBackupPath = "";
          let hookCalls = 0;
          const changedTargetBytes = Buffer.from(
            `changed ${target.kind} bytes must remain after failed restore`,
          );
          const transaction = await beginTransaction(layout, {
            operationId: `post-validation-${target.kind}-${replacementKind}`,
            io: {
              async afterBackupValidation(backupPath: string) {
                assert.equal(backupPath, expectedBackupPath);
                hookCalls += 1;
                const displacedBackupPath = `${backupPath}.displaced`;
                await rename(backupPath, displacedBackupPath);
                if (replacementKind === "regular") {
                  await writeFile(backupPath, replacementBytes);
                  return;
                }
                await writeFile(externalReplacementPath, replacementBytes);
                if (replacementKind === "hardlink") {
                  await link(externalReplacementPath, backupPath);
                  return;
                }
                await symlink(externalReplacementPath, backupPath, "file");
              },
            } as never,
          });

          try {
            const manifest = await transaction.backupTargets([
              { kind: target.kind, path: targetPath },
            ]);
            expectedBackupPath = manifest.entries[0]?.backupPath ?? "";
            assert.ok(expectedBackupPath);
            await transaction.markApplying([{ kind: target.kind, path: targetPath }]);
            await writeFile(targetPath, changedTargetBytes);

            let failure: unknown;
            await assert.rejects(
              () => transaction.rollback(),
              (error: unknown) => {
                failure = error;
                return error instanceof Error && "code" in error && error.code === "rollback-failed";
              },
            );
            assert.equal(hookCalls, 1);
            assert.deepEqual(await readFile(targetPath), changedTargetBytes);
            assert.doesNotMatch(collectErrorDetails(failure), /replacement bytes that must never be restored/i);
            if (replacementKind !== "regular") {
              assert.deepEqual(await readFile(externalReplacementPath), replacementBytes);
            }
          } finally {
            await transaction.release();
          }
        });
      });
    }
  }
});

test("rejects a symbolic backup manifest during restoration", async (t) => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "symlink-manifest" });
    await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
    const manifestPath = join(transaction.backupDirectory, "manifest.json");
    const manifestTarget = join(transaction.directory, "manifest-target.json");
    await writeFile(manifestTarget, await readFile(manifestPath));
    await rm(manifestPath);
    try {
      await symlink(manifestTarget, manifestPath, "file");
    } catch (error: unknown) {
      if (isWindowsSymlinkPrivilegeError(error)) {
        t.skip("creating file symlinks requires Windows developer mode or equivalent privilege");
        return;
      }
      throw error;
    }
    await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
    await writeFile(layout.configPath, "changed config", "utf8");

    await assert.rejects(
      () => transaction.rollback(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "rollback-failed",
    );
    assert.equal(await readFile(layout.configPath, "utf8"), "changed config");
    const journal = await readFile(transaction.journalPath, "utf8");
    assert.equal(JSON.parse(journal.trim().split("\n").at(-1)!).state, "recoveryRequired");
    await transaction.release();
  });
});

test("rejects a backup directory redirected outside its operation", async (t) => {
  await withLayout(async (layout) => {
    const externalBackupDirectory = join(layout.codexHome, "external-backup");
    const displacedBackupDirectory = `${join(layout.switcherDir, "transactions", "backup-directory-race", "backup")}.displaced`;
    const transaction = await beginTransaction(layout, {
      operationId: "backup-directory-race",
    });

    try {
      await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
      await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
      await writeFile(layout.configPath, "changed config", "utf8");

      await mkdir(externalBackupDirectory);
      for (const name of await readdir(transaction.backupDirectory)) {
        await writeFile(
          join(externalBackupDirectory, name),
          await readFile(join(transaction.backupDirectory, name)),
        );
      }
      await rename(transaction.backupDirectory, displacedBackupDirectory);
      try {
        await symlink(externalBackupDirectory, transaction.backupDirectory, "dir");
      } catch (error: unknown) {
        if (isWindowsSymlinkPrivilegeError(error)) {
          t.skip("creating directory symlinks requires Windows developer mode or equivalent privilege");
          return;
        }
        throw error;
      }

      await assert.rejects(
        () => transaction.rollback(),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "rollback-failed",
      );
      assert.equal(await readFile(layout.configPath, "utf8"), "changed config");
    } finally {
      await transaction.release().catch(() => undefined);
      await rm(externalBackupDirectory, { recursive: true, force: true });
    }
  });
});

test("rejects a hard-linked backup manifest during restoration", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "hardlink-manifest" });
    await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
    const manifestPath = join(transaction.backupDirectory, "manifest.json");
    await link(manifestPath, join(transaction.directory, "manifest-alias.json"));
    await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
    await writeFile(layout.configPath, "changed config", "utf8");

    await assert.rejects(
      () => transaction.rollback(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "rollback-failed",
    );
    assert.equal(await readFile(layout.configPath, "utf8"), "changed config");
    assert.equal(
      (await readTransactionJournal(transaction.journalPath)).at(-1)?.state,
      "recoveryRequired",
    );
    await transaction.release();
  });
});

test("rejects a backup manifest replaced after validation before opening it", async (t) => {
  await withLayout(async (layout) => {
    const externalDirectory = await mkdtemp(join(dirname(layout.codexHome), "external-manifest-"));
    const externalManifestPath = join(externalDirectory, "manifest.json");
    const externalBytes = Buffer.from("external manifest must not be read");
    await writeFile(externalManifestPath, externalBytes);
    const transaction = await beginTransaction(layout, {
      operationId: "manifest-open-race",
      io: {
        async afterManifestPathValidated(manifestPath: string) {
          const displacedPath = `${manifestPath}.displaced`;
          await rename(manifestPath, displacedPath);
          await symlink(externalManifestPath, manifestPath, "file");
        },
      },
    });

    try {
      await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
      await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
      await writeFile(layout.configPath, "changed config", "utf8");

      try {
        await assert.rejects(
          () => transaction.rollback(),
          (error: unknown) => error instanceof Error && "code" in error && error.code === "rollback-failed",
        );
      } catch (error: unknown) {
        if (isWindowsSymlinkPrivilegeError(error)) {
          t.skip("creating file symlinks requires Windows developer mode or equivalent privilege");
          return;
        }
        throw error;
      }
      assert.equal(await readFile(layout.configPath, "utf8"), "changed config");
      assert.deepEqual(await readFile(externalManifestPath), externalBytes);
    } finally {
      await transaction.release().catch(() => undefined);
      await rm(externalDirectory, { recursive: true, force: true });
    }
  });
});

test("rejects a journal replaced after validation before opening it", async (t) => {
  await withLayout(async (layout) => {
    const externalDirectory = await mkdtemp(join(dirname(layout.codexHome), "external-journal-"));
    const externalJournalPath = join(externalDirectory, "journal.jsonl");
    const externalBytes = Buffer.from("external journal must not be read");
    await writeFile(externalJournalPath, externalBytes);
    const transaction = await beginTransaction(layout, { operationId: "journal-open-race" });
    await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
    await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
    await writeFile(layout.configPath, "changed config", "utf8");
    await transaction.release();

    try {
      try {
        await assert.rejects(
          () => recoverPendingSwitches(layout, {
            isProcessAlive: () => false,
            io: {
            async afterJournalPathValidated(journalPath: string) {
                const displacedPath = `${journalPath}.displaced`;
                await rename(journalPath, displacedPath);
              await symlink(externalJournalPath, journalPath, "file");
            },
          },
          }),
          (error: unknown) => error instanceof Error && "code" in error && error.code === "journal-invalid",
        );
      } catch (error: unknown) {
        if (isWindowsSymlinkPrivilegeError(error)) {
          t.skip("creating file symlinks requires Windows developer mode or equivalent privilege");
          return;
        }
        throw error;
      }
      assert.equal(await readFile(layout.configPath, "utf8"), "changed config");
      assert.deepEqual(await readFile(externalJournalPath), externalBytes);
    } finally {
      await rm(externalDirectory, { recursive: true, force: true });
    }
  });
});

test("rejects a restore parent replaced before temporary creation", async (t) => {
  await withLayout(async (layout) => {
    const restoreParent = join(layout.codexHome, "restore-parent");
    const displacedParent = `${restoreParent}.displaced`;
    const externalDirectory = await mkdtemp(join(dirname(layout.codexHome), "external-restore-parent-"));
    const externalConfigPath = join(externalDirectory, "config.toml");
    const externalBytes = Buffer.from("external config must not be overwritten");
    await mkdir(restoreParent);
    layout.configPath = join(restoreParent, "config.toml");
    await writeFile(layout.configPath, "original config", "utf8");
    await writeFile(externalConfigPath, externalBytes);

    const transaction = await beginTransaction(layout, {
      operationId: "restore-parent-race",
      io: {
        async beforeRestoreTemporaryCreate(destination: string) {
          assert.equal(destination, layout.configPath);
          await rename(restoreParent, displacedParent);
          await symlink(externalDirectory, restoreParent, "dir");
        },
      },
    });

    try {
      await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
      await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
      await writeFile(layout.configPath, "changed config", "utf8");

      try {
        await assert.rejects(
          () => transaction.rollback(),
          (error: unknown) => error instanceof Error && "code" in error && error.code === "rollback-failed",
        );
      } catch (error: unknown) {
        if (isWindowsSymlinkPrivilegeError(error)) {
          t.skip("creating directory symlinks requires Windows developer mode or equivalent privilege");
          return;
        }
        throw error;
      }
      assert.deepEqual(await readFile(externalConfigPath), externalBytes);
    } finally {
      await transaction.release().catch(() => undefined);
      await rm(externalDirectory, { recursive: true, force: true });
    }
  });
});

test("rejects a restore parent whose ancestor real path changes", async (t) => {
  await withLayout(async (layout) => {
    const restoreRoot = join(layout.codexHome, "restore-root");
    const restoreParent = join(restoreRoot, "nested");
    const displacedRoot = `${restoreRoot}.displaced`;
    layout.configPath = join(restoreParent, "config.toml");
    await mkdir(restoreParent, { recursive: true });
    await writeFile(layout.configPath, "original config", "utf8");

    const transaction = await beginTransaction(layout, {
      operationId: "restore-ancestor-race",
      io: {
        async beforeRestoreTemporaryCreate(destination: string) {
          assert.equal(destination, layout.configPath);
          await rename(restoreRoot, displacedRoot);
          await symlink(displacedRoot, restoreRoot, "dir");
        },
      },
    });

    try {
      await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
      await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
      await writeFile(layout.configPath, "changed config", "utf8");

      try {
        await assert.rejects(
          () => transaction.rollback(),
          (error: unknown) => error instanceof Error && "code" in error && error.code === "rollback-failed",
        );
      } catch (error: unknown) {
        if (isWindowsSymlinkPrivilegeError(error)) {
          t.skip("creating directory symlinks requires Windows developer mode or equivalent privilege");
          return;
        }
        throw error;
      }
    } finally {
      await transaction.release().catch(() => undefined);
      await rm(restoreRoot, { recursive: true, force: true });
      await rm(displacedRoot, { recursive: true, force: true });
    }
  });
});

test("records the SHA256 of the saved backup bytes after the source path changes", async () => {
  await withLayout(async (layout) => {
    const original = Buffer.alloc(8 * 1024 * 1024, "a");
    await writeFile(layout.configPath, original);
    const transaction = await beginTransaction(layout, { operationId: "saved-backup-hash" });
    const backupPath = join(transaction.backupDirectory, "0000-config.toml");
    const replacementPath = join(layout.codexHome, "replacement-config.toml");
    const backup = transaction.backupTargets([{ kind: "config", path: layout.configPath }]);

    await waitForFile(backupPath);
    await writeFile(replacementPath, "source content after the backup copy", "utf8");
    await rename(replacementPath, layout.configPath);
    const manifest = await backup;
    const [entry] = manifest.entries;

    assert.ok(entry?.backupPath);
    assert.equal(entry.sha256, sha256(await readFile(entry.backupPath)));
    assert.notEqual(entry.sha256, sha256(await readFile(layout.configPath)));
    await transaction.markRolledBack();
    await transaction.release();
  });
});

test("hashes a real file correctly through small reader chunks", async () => {
  await withLayout(async (layout) => {
    const contents = Buffer.from(
      Array.from({ length: 4099 }, (_, index) => index % 251),
    );
    await writeFile(layout.sqlitePath, contents);
    const transaction = await beginTransaction(layout, {
      operationId: "chunked-backup-hash",
      io: { hashChunkSize: 7 },
    });

    try {
      const manifest = await transaction.backupTargets([{ kind: "sqlite", path: layout.sqlitePath }]);
      assert.equal(manifest.entries[0]?.sha256, sha256(contents));
      await transaction.markRolledBack();
    } finally {
      await transaction.release();
    }
  });
});

test("reports both syncFile and close errors", async () => {
  await withLayout(async (layout) => {
    const syncError = new Error("injected syncFile failure");
    const closeError = new Error("injected syncFile close failure");
    const transaction = await beginTransaction(layout, {
      operationId: "syncfile-close-failure",
      io: {
        syncFileHandle: async () => {
          throw syncError;
        },
        closeFileHandle: async (handle: FileHandle) => {
          await handle.close();
          throw closeError;
        },
      },
    });

    try {
      await assert.rejects(
        () => transaction.backupTargets([{ kind: "config", path: layout.configPath }]),
        (error: unknown) => (
          error instanceof AggregateError &&
          error.errors.includes(syncError) &&
          error.errors.includes(closeError)
        ),
      );
      await transaction.markRolledBack();
    } finally {
      await transaction.release();
    }
  });
});

test("reports both streaming hash read and close errors", async () => {
  await withLayout(async (layout) => {
    const readError = new Error("injected hash read failure");
    const closeError = new Error("injected hash close failure");
    const transaction = await beginTransaction(layout, {
      operationId: "hash-read-close-failure",
      io: {
        hashChunkSize: 7,
        readHashChunk: async () => {
          throw readError;
        },
        closeHashHandle: async (handle: FileHandle) => {
          await handle.close();
          throw closeError;
        },
      },
    });

    try {
      await assert.rejects(
        () => transaction.backupTargets([{ kind: "sqlite", path: layout.sqlitePath }]),
        (error: unknown) => (
          error instanceof AggregateError &&
          error.errors.includes(readError) &&
          error.errors.includes(closeError)
        ),
      );
      await transaction.markRolledBack();
    } finally {
      await transaction.release();
    }
  });
});

test("reports both temporary manifest write and cleanup errors", async () => {
  await withLayout(async (layout) => {
    const writeError = new Error("injected temporary manifest write failure");
    const cleanupError = new Error("injected temporary manifest cleanup failure");
    const transaction = await beginTransaction(layout, {
      operationId: "manifest-cleanup-failure",
      io: {
        writeTemporary: async () => {
          throw writeError;
        },
        removeTemporary: async () => {
          throw cleanupError;
        },
      },
    });

    try {
      await assert.rejects(
        () => transaction.backupTargets([{ kind: "config", path: layout.configPath }]),
        (error: unknown) => (
          error instanceof AggregateError &&
          error.errors.includes(writeError) &&
          error.errors.includes(cleanupError)
        ),
      );
      await transaction.markRolledBack();
    } finally {
      await transaction.release();
    }
  });
});

test("redacts temporary restore copy and cleanup errors", async () => {
  await withLayout(async (layout) => {
    const copyError = new Error("injected temporary restore copy failure");
    const cleanupError = new Error("injected temporary restore cleanup failure");
    const transaction = await beginTransaction(layout, {
      operationId: "restore-cleanup-failure",
      io: {
        copyTemporary: async () => {
          throw copyError;
        },
        removeTemporary: async () => {
          throw cleanupError;
        },
      },
    });
    await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
    await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
    await writeFile(layout.configPath, "changed config", "utf8");

    try {
      await assert.rejects(
        () => transaction.rollback(),
        (error: unknown) => {
          const details = collectErrorDetails(error);
          return (
            error instanceof Error &&
            "code" in error &&
            error.code === "rollback-failed" &&
            !details.includes(copyError.message) &&
            !details.includes(cleanupError.message)
          );
        },
      );
    } finally {
      await transaction.release();
    }
  });
});

test("removes a newly created lock when lock write, sync, or close fails", async (t) => {
  const failures = [
    {
      phase: "write",
      io: (error: Error) => ({
        writeLock: async () => {
          throw error;
        },
      }),
    },
    {
      phase: "sync",
      io: (error: Error) => ({
        syncHandle: async () => {
          throw error;
        },
      }),
    },
    {
      phase: "close",
      io: (error: Error) => ({
        closeHandle: async (handle: FileHandle) => {
          await handle.close();
          throw error;
        },
      }),
    },
  ] as const;

  for (const failure of failures) {
    await t.test(failure.phase, async () => {
      await withLayout(async (layout) => {
        const lockPath = operationLockPath(layout);
        const setupError = new Error(`injected lock ${failure.phase} failure`);

        await assert.rejects(
          () => beginTransaction(layout, {
            operationId: `lock-${failure.phase}-failure`,
            io: failure.io(setupError),
          }),
          (error: unknown) => error === setupError,
        );
        await assert.rejects(() => access(lockPath), { code: "ENOENT" });
      });
    });
  }
});

test("reports both lock setup and lock cleanup errors", async () => {
  await withLayout(async (layout) => {
    const setupError = new Error("injected lock setup failure");
    const cleanupError = new Error("injected lock cleanup failure");

    await assert.rejects(
      () => beginTransaction(layout, {
        operationId: "lock-cleanup-failure",
        io: {
          writeLock: async () => {
            throw setupError;
          },
          unlink: async () => {
            throw cleanupError;
          },
        },
      }),
      (error: unknown) => (
        error instanceof AggregateError &&
        error.errors.includes(setupError) &&
        error.errors.includes(cleanupError)
      ),
    );
  });
});

test("refuses a second operation while the lock owner is live", async () => {
  await withLayout(async (layout) => {
    const first = await beginTransaction(layout, {
      operationId: "first-live-lock",
      isProcessAlive: (pid) => pid === process.pid,
    });
    try {
      await assert.rejects(
        () => beginTransaction(layout, { operationId: "second-live-lock" }),
        (error: unknown) => error instanceof Error && /lock/i.test(error.message),
      );
    } finally {
      await first.markRolledBack();
      await first.release();
    }
  });
});

test("recovers and begins under one lock whose ownership transfers to the new handle", async () => {
  await withLayout(async (layout) => {
    const staleOperationId = "atomic-recover-stale";
    const stale = await beginTransaction(layout, { operationId: staleOperationId });
    await stale.backupTargets([{ kind: "config", path: layout.configPath }]);
    await stale.markApplying([{ kind: "config", path: layout.configPath }]);
    await writeFile(layout.configPath, "stale changed config", "utf8");
    await stale.release();
    const lockEvents: string[] = [];

    const result = await recoverAndBeginTransaction(layout, {
      operationId: "atomic-new-transaction",
      io: {
        async writeLock(handle, contents) {
          lockEvents.push("acquire");
          await handle.writeFile(contents, "utf8");
        },
        async releaseLock(path) {
          lockEvents.push("release");
          await rm(path);
        },
      },
    });

    assert.deepEqual(result.recovery.recoveredOperationIds, [staleOperationId]);
    assert.equal(await readFile(layout.configPath, "utf8"), "model_provider = 'before'\n");
    assert.ok(result.transaction);
    assert.deepEqual(lockEvents, ["acquire"]);
    await assert.rejects(
      () => beginTransaction(layout, { operationId: "atomic-concurrent-begin" }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "lock-held",
    );
    await result.transaction.markRolledBack();
    await result.transaction.release();
    assert.deepEqual(lockEvents, ["acquire", "release"]);
  });
});

test("releases the atomic lock when recovery fails before a handle is created", async () => {
  await withLayout(async (layout) => {
    const operationId = "atomic-invalid-recovery";
    const directory = join(layout.switcherDir, "transactions", operationId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "journal.jsonl"), "{}\n", "utf8");

    await assert.rejects(
      () => recoverAndBeginTransaction(layout, { operationId: "atomic-after-invalid" }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "journal-invalid",
    );
    await assert.rejects(
      () => recoverPendingSwitches(layout),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "journal-invalid",
    );
  });
});

test("recovers a stale lock only after confirming its owner is dead", async () => {
  await withLayout(async (layout) => {
    const lockPath = operationLockPath(layout);
    await mkdir(join(layout.switcherDir, "transactions"), { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: 999999, createdAt: 1 }), "utf8");

    const transaction = await beginTransaction(layout, {
      operationId: "stale-lock-recovered",
      isProcessAlive: () => false,
    });
    await transaction.markRolledBack();
    await transaction.release();
    await assert.rejects(() => readFile(lockPath, "utf8"), { code: "ENOENT" });
  });
});

test("removes an orphaned lock handoff before recovering an applying transaction", async () => {
  await withLayout(async (layout) => {
    const operationId = "recover-after-lock-handoff";
    const beforeConfig = await readFile(layout.configPath, "utf8");
    const transaction = await beginTransaction(layout, { operationId });
    await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
    await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
    await writeFile(layout.configPath, "changed config", "utf8");
    await transaction.release();

    const handoffPath = `${operationLockPath(layout)}.handoff-123e4567-e89b-42d3-a456-426614174000`;
    await writeFile(handoffPath, JSON.stringify({
      pid: process.pid,
      operationId,
      createdAt: Date.now(),
    }), "utf8");

    const result = await recoverPendingSwitches(layout, { isProcessAlive: () => true });

    assert.equal(result.recoveredOperationIds.includes(operationId), true);
    assert.equal(await readFile(layout.configPath, "utf8"), beforeConfig);
    await assert.rejects(() => access(handoffPath), { code: "ENOENT" });
  });
});

test("rejects a symlinked lock handoff without changing its external target", async (t) => {
  await withLayout(async (layout) => {
    const transactionsDirectory = join(layout.switcherDir, "transactions");
    const externalPath = join(layout.codexHome, "external-lock-handoff");
    const handoffPath = join(
      transactionsDirectory,
      ".lock.handoff-123e4567-e89b-42d3-a456-426614174000",
    );
    const externalBytes = Buffer.from(JSON.stringify({
      pid: process.pid,
      operationId: "external-lock-handoff",
      createdAt: Date.now(),
    }));
    await mkdir(transactionsDirectory, { recursive: true });
    await writeFile(externalPath, externalBytes);
    try {
      await symlink(externalPath, handoffPath, "file");
    } catch (error: unknown) {
      if (isWindowsSymlinkPrivilegeError(error)) {
        t.skip("creating file symlinks requires Windows developer mode or equivalent privilege");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => recoverPendingSwitches(layout),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "lock-unverifiable",
    );
    assert.deepEqual(await readFile(externalPath), externalBytes);
    assert.equal((await lstat(handoffPath)).isSymbolicLink(), true);
  });
});

test("rejects an unrecognized non-directory transaction entry", async () => {
  await withLayout(async (layout) => {
    const entryPath = join(
      layout.switcherDir,
      "transactions",
      ".lock.handoff-not-created-by-transaction-release",
    );
    await mkdir(dirname(entryPath), { recursive: true });
    await writeFile(entryPath, JSON.stringify({
      pid: process.pid,
      operationId: "unrecognized-handoff",
      createdAt: Date.now(),
    }), "utf8");

    await assert.rejects(
      () => recoverPendingSwitches(layout),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "journal-invalid",
    );
    assert.equal((await lstat(entryPath)).isFile(), true);
  });
});

test("fails closed when the existing lock owner cannot be checked", async () => {
  await withLayout(async (layout) => {
    const lockPath = operationLockPath(layout);
    const lockContents = JSON.stringify({ pid: 999999, createdAt: 1 });
    await mkdir(join(layout.switcherDir, "transactions"), { recursive: true });
    await writeFile(lockPath, lockContents, "utf8");

    await assert.rejects(
      () =>
        beginTransaction(layout, {
          operationId: "unknown-lock-owner",
          isProcessAlive: () => undefined,
        }),
      /operation lock/i,
    );
    assert.equal(await readFile(lockPath, "utf8"), lockContents);
  });
});

test("rejects a symlinked replacement lock on every release attempt", async (t) => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "symlink-release-lock" });
    await transaction.markRolledBack();
    const lockPath = operationLockPath(layout);
    const externalLockPath = join(layout.codexHome, "external-lock");
    const ownershipBytes = await readFile(lockPath);
    await writeFile(externalLockPath, ownershipBytes);
    await rm(lockPath);
    try {
      await symlink(externalLockPath, lockPath, "file");
    } catch (error: unknown) {
      if (isWindowsSymlinkPrivilegeError(error)) {
        t.skip("creating file symlinks requires Windows developer mode or equivalent privilege");
        return;
      }
      throw error;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        () => transaction.release(),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "lock-unverifiable",
      );
    }
    assert.deepEqual(await readFile(externalLockPath), ownershipBytes);
  });
});

test("rejects a hard-linked replacement lock on every release attempt", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "hardlink-release-lock" });
    await transaction.markRolledBack();
    const lockPath = operationLockPath(layout);
    const externalLockPath = join(layout.codexHome, "external-hardlink-lock");
    const ownershipBytes = await readFile(lockPath);
    await writeFile(externalLockPath, ownershipBytes);
    await rm(lockPath);
    await link(externalLockPath, lockPath);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        () => transaction.release(),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "lock-unverifiable",
      );
    }
    assert.deepEqual(await readFile(externalLockPath), ownershipBytes);
    assert.deepEqual(await readFile(lockPath), ownershipBytes);
  });
});

test("rejects different lock ownership bytes on every release attempt", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "different-release-lock" });
    await transaction.markRolledBack();
    const lockPath = operationLockPath(layout);
    const replacementBytes = JSON.stringify({
      pid: process.pid,
      operationId: "different-owner",
      createdAt: 0,
    });
    await rm(lockPath);
    await writeFile(lockPath, replacementBytes, "utf8");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        () => transaction.release(),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "lock-unverifiable",
      );
    }
    assert.equal(await readFile(lockPath, "utf8"), replacementBytes);
  });
});

test("preserves a replacement lock swapped after release ownership verification", async () => {
  await withLayout(async (layout) => {
    const lockPath = operationLockPath(layout);
    const displacedLockPath = `${lockPath}.displaced`;
    const replacementBytes = JSON.stringify({
      pid: process.pid,
      operationId: "replacement-after-release-check",
      createdAt: 0,
    });
    let hookCalls = 0;
    const transaction = await beginTransaction(layout, {
      operationId: "release-ownership-race",
      io: {
        async afterLockOwnershipVerified(verifiedPath, phase) {
          assert.equal(verifiedPath, lockPath);
          assert.equal(phase, "release");
          hookCalls += 1;
          await rename(lockPath, displacedLockPath);
          await writeFile(lockPath, replacementBytes, "utf8");
        },
      },
    });
    await transaction.markRolledBack();

    await assert.rejects(
      () => transaction.release(),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "lock-unverifiable",
    );
    assert.equal(hookCalls, 1);
    assert.equal(await readFile(lockPath, "utf8"), replacementBytes);
  });
});

test("preserves a replacement lock swapped after stale ownership verification", async () => {
  await withLayout(async (layout) => {
    const lockPath = operationLockPath(layout);
    const displacedLockPath = `${lockPath}.displaced`;
    const staleBytes = JSON.stringify({ pid: 999999, createdAt: 1 });
    const replacementBytes = JSON.stringify({
      pid: process.pid,
      operationId: "replacement-after-stale-check",
      createdAt: 0,
    });
    await mkdir(join(layout.switcherDir, "transactions"), { recursive: true });
    await writeFile(lockPath, staleBytes, "utf8");

    await assert.rejects(
      () => beginTransaction(layout, {
        operationId: "stale-ownership-race",
        isProcessAlive: () => false,
        io: {
          async afterLockOwnershipVerified(verifiedPath, phase) {
            assert.equal(verifiedPath, lockPath);
            assert.equal(phase, "stale-reclaim");
            await rename(lockPath, displacedLockPath);
            await writeFile(lockPath, replacementBytes, "utf8");
          },
        },
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "lock-unverifiable",
    );
    assert.equal(await readFile(lockPath, "utf8"), replacementBytes);
  });
});

test("rejects a symlinked recovery journal without changing external bytes", async (t) => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "symlink-recovery-journal" });
    await transaction.release();
    const externalJournalPath = join(layout.codexHome, "external-journal.jsonl");
    const externalBytes = await readFile(transaction.journalPath);
    await writeFile(externalJournalPath, externalBytes);
    await rm(transaction.journalPath);
    try {
      await symlink(externalJournalPath, transaction.journalPath, "file");
    } catch (error: unknown) {
      if (isWindowsSymlinkPrivilegeError(error)) {
        t.skip("creating file symlinks requires Windows developer mode or equivalent privilege");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => recoverPendingSwitches(layout, { isProcessAlive: () => false }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "journal-invalid",
    );
    assert.deepEqual(await readFile(externalJournalPath), externalBytes);
  });
});

test("beginTransaction rejects a symlinked transaction root before writing outside it", async (t) => {
  await withLayout(async (layout) => {
    const transactionRoot = join(layout.switcherDir, "transactions");
    const externalRoot = join(layout.codexHome, "external-transactions");
    const externalSentinelPath = join(externalRoot, "sentinel");
    const externalBytes = Buffer.from("external transaction root must not be written");
    await mkdir(externalRoot);
    await writeFile(externalSentinelPath, externalBytes);
    try {
      await symlink(externalRoot, transactionRoot, "dir");
    } catch (error: unknown) {
      if (isWindowsSymlinkPrivilegeError(error)) {
        t.skip("creating directory symlinks requires Windows developer mode or equivalent privilege");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => beginTransaction(layout, { operationId: "symlinked-transaction-root" }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "journal-invalid",
    );
    assert.deepEqual(await readFile(externalSentinelPath), externalBytes);
    await assert.rejects(() => access(join(externalRoot, ".lock")), { code: "ENOENT" });
  });
});

test("recoverPendingSwitches rejects a symlinked transaction root without changing an external journal", async (t) => {
  await withLayout(async (layout) => {
    const transactionRoot = join(layout.switcherDir, "transactions");
    const externalRoot = join(layout.codexHome, "external-transactions");
    const operationId = "external-root-operation";
    const externalOperation = join(externalRoot, operationId);
    const externalJournalPath = join(externalOperation, "journal.jsonl");
    const externalBytes = Buffer.from(`${JSON.stringify({
      version: 1,
      operationId,
      state: "prepared",
      timestamp: "2026-08-26T00:00:00.000Z",
    })}\n`);
    await mkdir(externalOperation, { recursive: true });
    await writeFile(externalJournalPath, externalBytes);
    try {
      await symlink(externalRoot, transactionRoot, "dir");
    } catch (error: unknown) {
      if (isWindowsSymlinkPrivilegeError(error)) {
        t.skip("creating directory symlinks requires Windows developer mode or equivalent privilege");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => recoverPendingSwitches(layout, { isProcessAlive: () => false }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "journal-invalid",
    );
    assert.deepEqual(await readFile(externalJournalPath), externalBytes);
  });
});

test("beginTransaction rejects an operation directory symlink without removing it", async (t) => {
  await withLayout(async (layout) => {
    const operationId = "symlinked-operation-directory";
    const transactionRoot = join(layout.switcherDir, "transactions");
    const operationDirectory = join(transactionRoot, operationId);
    const externalDirectory = join(layout.codexHome, "external-operation");
    const externalSentinelPath = join(externalDirectory, "sentinel");
    const externalBytes = Buffer.from("external operation must not be touched");
    await mkdir(transactionRoot);
    await mkdir(externalDirectory);
    await writeFile(externalSentinelPath, externalBytes);
    try {
      await symlink(externalDirectory, operationDirectory, "dir");
    } catch (error: unknown) {
      if (isWindowsSymlinkPrivilegeError(error)) {
        t.skip("creating directory symlinks requires Windows developer mode or equivalent privilege");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => beginTransaction(layout, { operationId }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "journal-invalid",
    );
    assert.equal((await lstat(operationDirectory)).isSymbolicLink(), true);
    assert.deepEqual(await readFile(externalSentinelPath), externalBytes);
  });
});

test("recoverPendingSwitches rejects an operation directory symlink without reading its journal", async (t) => {
  await withLayout(async (layout) => {
    const operationId = "symlinked-recovery-operation";
    const transactionRoot = join(layout.switcherDir, "transactions");
    const operationDirectory = join(transactionRoot, operationId);
    const externalDirectory = join(layout.codexHome, "external-operation");
    const externalJournalPath = join(externalDirectory, "journal.jsonl");
    const externalBytes = Buffer.from(`${JSON.stringify({
      version: 1,
      operationId,
      state: "prepared",
      timestamp: "2026-08-26T00:00:00.000Z",
    })}\n`);
    await mkdir(transactionRoot);
    await mkdir(externalDirectory);
    await writeFile(externalJournalPath, externalBytes);
    try {
      await symlink(externalDirectory, operationDirectory, "dir");
    } catch (error: unknown) {
      if (isWindowsSymlinkPrivilegeError(error)) {
        t.skip("creating directory symlinks requires Windows developer mode or equivalent privilege");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => recoverPendingSwitches(layout, { isProcessAlive: () => false }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "journal-invalid",
    );
    assert.deepEqual(await readFile(externalJournalPath), externalBytes);
  });
});

test("rejects a journal containing a state outside the durable transaction protocol", async () => {
  await withLayout(async (layout) => {
    const directory = join(layout.switcherDir, "transactions", "invalid-state");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "journal.jsonl"),
      `${JSON.stringify({
        version: 1,
        operationId: "invalid-state",
        state: "partiallyCommitted",
        timestamp: "2026-08-26T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    await assert.rejects(
      () => recoverPendingSwitches(layout, { isProcessAlive: () => false }),
      /journal is invalid/i,
    );
  });
});

test("accepts source-version protocol only on the canonical prepared journal record", async () => {
  await withLayout(async (layout) => {
    const validOperationId = "source-version-protocol-valid";
    const validDirectory = join(layout.switcherDir, "transactions", validOperationId);
    await mkdir(validDirectory, { recursive: true });
    await writeFile(join(validDirectory, "journal.jsonl"), `${[
      {
        version: 1,
        operationId: validOperationId,
        state: "prepared",
        timestamp: "2026-08-26T00:00:00.000Z",
        sourceVersionProtocol: true,
      },
      {
        version: 1,
        operationId: validOperationId,
        state: "applying",
        timestamp: "2026-08-26T00:00:01.000Z",
      },
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

    const recovered = await recoverPendingSwitches(layout, {
      isProcessAlive: () => false,
      requireSourceVersionProtocol: false,
    });
    assert.deepEqual(recovered.recoveredOperationIds, [validOperationId]);

    for (const [operationId, invalidEntry] of [
      [
        "source-version-protocol-false",
        {
          version: 1,
          operationId: "source-version-protocol-false",
          state: "prepared",
          timestamp: "2026-08-26T00:00:00.000Z",
          sourceVersionProtocol: false,
        },
      ],
      [
        "source-version-protocol-late",
        {
          version: 1,
          operationId: "source-version-protocol-late",
          state: "applying",
          timestamp: "2026-08-26T00:00:01.000Z",
          sourceVersionProtocol: true,
        },
      ],
    ] as const) {
      const directory = join(layout.switcherDir, "transactions", operationId);
      await mkdir(directory, { recursive: true });
      const journal = invalidEntry.state === "applying"
        ? [
          {
            version: 1,
            operationId,
            state: "prepared",
            timestamp: "2026-08-26T00:00:00.000Z",
          },
          invalidEntry,
        ]
        : [invalidEntry];
      await writeFile(
        join(directory, "journal.jsonl"),
        `${journal.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8",
      );
      await assert.rejects(
        () => readTransactionJournal(join(directory, "journal.jsonl")),
        (error: unknown) => error instanceof TransactionError && error.code === "journal-invalid",
      );
    }
  });
});

test("rejects incomplete custom auth journal metadata before restoration", async () => {
  await withLayout(async (layout) => {
    const operationId = "incomplete-custom-auth";
    const directory = join(layout.switcherDir, "transactions", operationId);
    const journalPath = join(directory, "journal.jsonl");
    const contents = `${[
      {
        version: 1,
        operationId,
        state: "prepared",
        timestamp: "2026-08-26T00:00:00.000Z",
      },
      {
        version: 1,
        operationId,
        state: "applying",
        timestamp: "2026-08-26T00:00:01.000Z",
        pendingTargets: [{ kind: "auth", previousMode: "custom" }],
      },
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await mkdir(directory, { recursive: true });
    await writeFile(journalPath, contents, "utf8");
    let restoreCalls = 0;

    await assert.rejects(
      () => recoverPendingSwitches(layout, {
        isProcessAlive: () => false,
        restoreAuthMode: async () => {
          restoreCalls += 1;
        },
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "journal-invalid",
    );
    assert.equal(restoreCalls, 0);
    assert.equal(await readFile(journalPath, "utf8"), contents);
  });
});

test("rejects an uppercase custom profile ID in a persisted journal before restoration", async () => {
  await assertInvalidPersistedCustomProfileIdRejected("Research-Proxy");
});

test("rejects an underscored custom profile ID in a persisted journal before restoration", async () => {
  await assertInvalidPersistedCustomProfileIdRejected("research_proxy");
});

test("rejects a dotted custom profile ID in a persisted journal before restoration", async () => {
  await assertInvalidPersistedCustomProfileIdRejected("research.proxy");
});

test("fails closed for a committed then applying journal without restoring targets", async () => {
  await withLayout(async (layout) => {
    const operationId = "committed-then-applying";
    const directory = join(layout.switcherDir, "transactions", operationId);
    const journalPath = join(directory, "journal.jsonl");
    const changedConfig = "changed config must remain untouched";
    await mkdir(directory, { recursive: true });
    await writeFile(layout.configPath, changedConfig, "utf8");
    const journal = [
      { version: 1, operationId, state: "prepared", timestamp: "2026-08-26T00:00:00.000Z" },
      {
        version: 1,
        operationId,
        state: "applying",
        timestamp: "2026-08-26T00:00:01.000Z",
        pendingTargets: [{ kind: "config", path: layout.configPath }],
      },
      { version: 1, operationId, state: "committed", timestamp: "2026-08-26T00:00:02.000Z" },
      { version: 1, operationId, state: "applying", timestamp: "2026-08-26T00:00:03.000Z" },
    ];
    const contents = `${journal.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await writeFile(journalPath, contents, "utf8");

    await assert.rejects(
      () => recoverPendingSwitches(layout, { isProcessAlive: () => false }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "journal-invalid",
    );
    assert.equal(await readFile(layout.configPath, "utf8"), changedConfig);
    assert.equal(await readFile(journalPath, "utf8"), contents);
  });
});

test("fails closed when journal operation IDs do not match their transaction directory", async () => {
  await withLayout(async (layout) => {
    const operationId = "directory-operation-id";
    const directory = join(layout.switcherDir, "transactions", operationId);
    const journalPath = join(directory, "journal.jsonl");
    const contents = `${JSON.stringify({
      version: 1,
      operationId: "different-operation-id",
      state: "prepared",
      timestamp: "2026-08-26T00:00:00.000Z",
    })}\n`;
    await mkdir(directory, { recursive: true });
    await writeFile(journalPath, contents, "utf8");

    await assert.rejects(
      () => recoverPendingSwitches(layout, { isProcessAlive: () => false }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "journal-invalid",
    );
    assert.equal(await readFile(journalPath, "utf8"), contents);
  });
});

test("fails closed when an applied journal target was never pending", async () => {
  await withLayout(async (layout) => {
    const operationId = "applied-without-pending";
    const directory = join(layout.switcherDir, "transactions", operationId);
    const journalPath = join(directory, "journal.jsonl");
    const changedConfig = "changed config must remain untouched";
    await mkdir(directory, { recursive: true });
    await writeFile(layout.configPath, changedConfig, "utf8");
    const contents = `${[
      { version: 1, operationId, state: "prepared", timestamp: "2026-08-26T00:00:00.000Z" },
      {
        version: 1,
        operationId,
        state: "applying",
        timestamp: "2026-08-26T00:00:01.000Z",
        appliedTargets: [{ kind: "config", path: layout.configPath }],
      },
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await writeFile(journalPath, contents, "utf8");

    await assert.rejects(
      () => recoverPendingSwitches(layout, { isProcessAlive: () => false }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "journal-invalid",
    );
    assert.equal(await readFile(layout.configPath, "utf8"), changedConfig);
    assert.equal(await readFile(journalPath, "utf8"), contents);
  });
});

test("refuses a caller-crafted rollout patch with transcript content before journalling", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "crafted-rollout-patch" });
    const transcriptValue = JSON.stringify("Keep message from transcript");
    try {
      await assert.rejects(
        () =>
          transaction.markApplying([
            {
              kind: "rollout",
              path: join(layout.sessionsDir, "one.jsonl"),
              inversePatch: {
                version: 1,
                path: join(layout.sessionsDir, "one.jsonl"),
                preHash: "a".repeat(64),
                postHash: "b".repeat(64),
                replacements: [{
                  line: 0,
                  start: 0,
                  end: transcriptValue.length,
                  expectedValue: transcriptValue,
                  value: JSON.stringify("openai"),
                }],
              },
            },
          ]),
        /inverse patch/i,
      );
      const journal = await readFile(transaction.journalPath, "utf8");
      assert.equal(journal.trim().split("\n").length, 1);
      assert.doesNotMatch(journal, /Keep message from transcript/);
    } finally {
      await transaction.markRolledBack();
      await transaction.release();
    }
  });
});

test("refuses a caller-crafted rollout inverse patch without an explicit session ID", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "missing-rollout-session" });
    const path = join(layout.sessionsDir, "one.jsonl");
    try {
      await assert.rejects(
        () =>
          transaction.markApplying([
            {
              kind: "rollout",
              path,
              inversePatch: {
                version: 1,
                path,
                preHash: "a".repeat(64),
                postHash: "b".repeat(64),
                replacements: [{
                  line: 0,
                  start: 56,
                  end: 64,
                  expectedValue: JSON.stringify("openai"),
                  value: JSON.stringify("custom"),
                }],
              },
            } as never,
          ]),
        /inverse patch/i,
      );
      const journal = await readFile(transaction.journalPath, "utf8");
      assert.equal(journal.trim().split("\n").length, 1);
    } finally {
      await transaction.markRolledBack();
      await transaction.release();
    }
  });
});

test("refuses a rollout inverse patch with a colon in provider metadata", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "colon-rollout-provider" });
    const path = join(layout.sessionsDir, "one.jsonl");
    try {
      await assert.rejects(
        () =>
          transaction.markApplying([
            {
              kind: "rollout",
              path,
              inversePatch: {
                version: 1,
                path,
                sessionId: "one",
                preHash: "a".repeat(64),
                postHash: "b".repeat(64),
                replacements: [{
                  line: 0,
                  start: 56,
                  end: 72,
                  expectedValue: JSON.stringify("openai:proxy"),
                  value: JSON.stringify("custom"),
                }],
              },
            },
          ]),
        /inverse patch/i,
      );
      const journal = await readFile(transaction.journalPath, "utf8");
      assert.equal(journal.trim().split("\n").length, 1);
    } finally {
      await transaction.markRolledBack();
      await transaction.release();
    }
  });
});

test("validates every rollout inverse patch before restoring any rollout", async () => {
  await withLayout(async (layout) => {
    await rm(join(layout.sessionsDir, "one.jsonl"), { force: true });
    const firstPath = join(layout.sessionsDir, "first.jsonl");
    const secondPath = join(layout.sessionsDir, "second.jsonl");
    await writeFile(
      firstPath,
      '{"type":"session_meta","payload":{"id":"first","model_provider":"openai"}}\n',
      "utf8",
    );
    await writeFile(
      secondPath,
      '{"type":"session_meta","payload":{"id":"second","model_provider":"openai"}}\n',
      "utf8",
    );
    const changes = await collectRolloutChanges(layout, "custom");
    const patches = createRolloutInversePatches(changes);
    const firstPatch = patches.find((patch) => patch.path === firstPath);
    const secondPatch = patches.find((patch) => patch.path === secondPath);
    assert.ok(firstPatch);
    assert.ok(secondPatch);
    const transaction = await beginTransaction(layout, {
      operationId: "validate-all-rollouts",
    });
    await transaction.markApplying([
      { kind: "rollout", path: secondPath, inversePatch: secondPatch },
      { kind: "rollout", path: firstPath, inversePatch: firstPatch },
    ]);
    await applyRolloutChanges(changes);
    const changedFirst = await readFile(firstPath);
    await writeFile(secondPath, `${await readFile(secondPath)}tampered\n`, "utf8");

    try {
      await assert.rejects(
        () => transaction.rollback(),
        /could not be fully rolled back/i,
      );
      assert.deepEqual(await readFile(firstPath), changedFirst);
      assert.equal(
        (await readTransactionJournal(transaction.journalPath)).at(-1)?.state,
        "recoveryRequired",
      );
    } finally {
      await transaction.release();
    }
  });
});

test("requires an injected auth restorer and journals only safe prior auth metadata", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "auth-recovery" });
    const authTarget = {
      kind: "auth",
      path: layout.authPath,
      previousMode: "custom" as const,
      customProfileId: "research-proxy",
    };
    try {
      await transaction.markApplying([authTarget]);
      await transaction.markTargetApplied(authTarget);
      await writeFile(layout.authPath, '{"OPENAI_API_KEY":"super-secret-auth-value"}\n', "utf8");
    } finally {
      await transaction.release();
    }

    const result = await recoverPendingSwitches(layout, { isProcessAlive: () => false });
    assert.equal(result.recoveredOperationIds.includes("auth-recovery"), false);
    assert.equal(result.recoveryRequiredOperationIds.includes("auth-recovery"), true);
    assert.match(await readFile(layout.authPath, "utf8"), /super-secret-auth-value/);
    const journal = await readFile(
      join(layout.switcherDir, "transactions", "auth-recovery", "journal.jsonl"),
      "utf8",
    );
    assert.match(journal, /research-proxy/);
    assert.doesNotMatch(journal, /OPENAI_API_KEY|super-secret-auth-value/);
  });
});

test("journals the exact absolute auth path without credential values", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "auth-target-path" });
    const credential = "credential-must-not-be-journaled";
    try {
      await transaction.markApplying([{
        kind: "auth",
        path: layout.authPath,
        previousMode: "official",
      }]);

      const journal = await readFile(transaction.journalPath, "utf8");
      assert.deepEqual(
        (await readTransactionJournal(transaction.journalPath)).at(-1)?.pendingTargets,
        [{ kind: "auth", path: layout.authPath, previousMode: "official" }],
      );
      assert.doesNotMatch(journal, new RegExp(credential));
    } finally {
      await transaction.release();
    }
  });
});

test("rejects auth targets without the exact configured auth path", async () => {
  const invalidTargets = [
    { kind: "auth", previousMode: "official" },
    { kind: "auth", path: "auth.json", previousMode: "official" },
    { kind: "auth", path: "placeholder", previousMode: "official" },
  ];
  for (const invalidTarget of invalidTargets) {
    await withLayout(async (layout) => {
      const target = invalidTarget.path === "placeholder"
        ? { ...invalidTarget, path: join(layout.codexHome, "other-auth.json") }
        : invalidTarget;
      const transaction = await beginTransaction(layout, {
        operationId: `invalid-auth-path-${invalidTargets.indexOf(invalidTarget)}`,
      });
      try {
        await assert.rejects(
          () => transaction.markApplying([target as never]),
          (error: unknown) =>
            error instanceof Error && "code" in error && error.code === "journal-invalid",
        );
      } finally {
        await transaction.release();
      }
    });
  }
});

test("redacts restoreAuthMode failure details from rollback errors", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "redacted-rollback-error" });
    const apiKey = "super-secret-api-key";
    const transcript = "private transcript body";
    await transaction.markApplying([
      {
        kind: "auth",
        path: layout.authPath,
        previousMode: "custom",
        customProfileId: "research-proxy",
      },
    ]);

    try {
      await assert.rejects(
        () => transaction.rollback(async () => {
          throw new AggregateError(
            [new Error(apiKey), new Error(transcript)],
            `restore failed with ${apiKey}: ${transcript}`,
          );
        }),
        (error: unknown) => {
          const details = collectErrorDetails(error);
          return (
            error instanceof Error &&
            "code" in error &&
            error.code === "rollback-failed" &&
            !details.includes(apiKey) &&
            !details.includes(transcript)
          );
        },
      );
      const journal = await readFile(transaction.journalPath, "utf8");
      assert.doesNotMatch(journal, /super-secret-api-key|private transcript body/);
    } finally {
      await transaction.release();
    }
  });
});

test("returns a bounded redacted diagnostic when recovery and recoveryRequired journalling fail", async () => {
  await withLayout(async (layout) => {
    const operationId = "redacted-recovery-error";
    const apiKey = "super-secret-api-key";
    const transcript = "private transcript body";
    const transaction = await beginTransaction(layout, { operationId });
    await transaction.markApplying([
      {
        kind: "auth",
        path: layout.authPath,
        previousMode: "custom",
        customProfileId: "research-proxy",
      },
    ]);
    await transaction.release();

    const result = await recoverPendingSwitches(layout, {
      isProcessAlive: () => false,
      async restoreAuthMode() {
        throw new Error(`restore ${apiKey}: ${transcript}`);
      },
      io: {
        async renameJournal(source, destination) {
          const records = (await readFile(source, "utf8")).trim().split("\n");
          if (
            destination === transaction.journalPath &&
            JSON.parse(records.at(-1)!).state === "recoveryRequired"
          ) {
            throw new Error(`journal ${apiKey}: ${transcript}`);
          }
          await rename(source, destination);
        },
      },
    });

    assert.deepEqual(result.recoveryRequiredOperationIds, [operationId]);
    assert.deepEqual(result.recoveryDiagnostics, [{
      operationId,
      recoveryRequiredJournalWritten: false,
    }]);
    assert.doesNotMatch(JSON.stringify(result), /super-secret-api-key|private transcript body/);
    const journal = await readFile(transaction.journalPath, "utf8");
    assert.doesNotMatch(journal, /super-secret-api-key|private transcript body/);
  });
});

test("recovers auth only through an injected restorer with normalized metadata", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "auth-restorer" });
    const authTarget = {
      kind: "auth",
      path: layout.authPath,
      previousMode: "custom" as const,
      customProfileId: "research-proxy",
    };
    try {
      await transaction.markApplying([authTarget]);
      await transaction.markTargetApplied(authTarget);
    } finally {
      await transaction.release();
    }

    let restoredTarget: unknown;
    const result = await recoverPendingSwitches(layout, {
      isProcessAlive: () => false,
      restoreAuthMode(target) {
        restoredTarget = target;
      },
    });

    assert.equal(result.recoveredOperationIds.includes("auth-restorer"), true);
    assert.deepEqual(restoredTarget, {
      kind: "auth",
      path: layout.authPath,
      previousMode: "custom",
      customProfileId: "research-proxy",
    });
  });
});

test("preserves a post-apply auth edit and requires recovery instead of restoring", async () => {
  await withLayout(async (layout) => {
    const operationId = "auth-external-after-apply";
    const transaction = await beginTransaction(layout, {
      operationId,
      requireSourceVersionProtocol: true,
    });
    const authTarget = {
      kind: "auth",
      path: layout.authPath,
      previousMode: "custom" as const,
      customProfileId: "research-proxy",
    };
    await transaction.markApplying([authTarget]);
    await rm(layout.authPath);
    await transaction.markTargetApplied(authTarget);
    const externalAuth = '{"native":"post-apply-user-edit"}\n';
    await writeFile(layout.authPath, externalAuth, "utf8");
    await transaction.release();

    let restoreCalls = 0;
    const result = await recoverPendingSwitches(layout, {
      isProcessAlive: () => false,
      restoreAuthMode: async () => {
        restoreCalls += 1;
      },
    });

    assert.equal(restoreCalls, 0);
    assert.deepEqual(result.recoveredOperationIds, []);
    assert.deepEqual(result.recoveryRequiredOperationIds, [operationId]);
    assert.equal(await readFile(layout.authPath, "utf8"), externalAuth);
    const journal = await readFile(transaction.journalPath, "utf8");
    assert.doesNotMatch(journal, /post-apply-user-edit|OPENAI_API_KEY/);
    assert.equal(
      (await readTransactionJournal(transaction.journalPath)).at(-1)?.state,
      "recoveryRequired",
    );
  });
});

test("preserves a post-apply auth edit during in-process rollback", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, {
      operationId: "auth-external-before-rollback",
      requireSourceVersionProtocol: true,
    });
    const authTarget = {
      kind: "auth",
      path: layout.authPath,
      previousMode: "custom" as const,
      customProfileId: "research-proxy",
    };
    await transaction.markApplying([authTarget]);
    await writeFile(layout.authPath, '{"OPENAI_API_KEY":"extension-materialization"}', "utf8");
    await transaction.markTargetApplied(authTarget);
    const externalAuth = '{"native":"post-apply-user-edit"}\n';
    await writeFile(layout.authPath, externalAuth, "utf8");

    let restoreCalls = 0;
    try {
      await assert.rejects(
        () => transaction.rollback(async () => {
          restoreCalls += 1;
        }),
        (error: unknown) =>
          error instanceof TransactionError && error.code === "rollback-failed",
      );
      assert.equal(restoreCalls, 0);
      assert.equal(await readFile(layout.authPath, "utf8"), externalAuth);
      const journal = await readFile(transaction.journalPath, "utf8");
      assert.doesNotMatch(journal, /extension-materialization|post-apply-user-edit/);
      assert.equal(
        (await readTransactionJournal(transaction.journalPath)).at(-1)?.state,
        "recoveryRequired",
      );
    } finally {
      await transaction.release();
    }
  });
});

test("continues recovery when recoveryRequired journalling also fails", async () => {
  await withLayout(async (layout) => {
    const firstOperationId = "a-recovery-and-journal-fail";
    const secondOperationId = "b-recovery-continues";
    const first = await beginTransaction(layout, { operationId: firstOperationId });
    await first.markApplying([{ kind: "config", path: layout.configPath }]);
    await first.release();
    const second = await beginTransaction(layout, { operationId: secondOperationId });
    await second.release();
    const firstJournalPath = join(
      layout.switcherDir,
      "transactions",
      firstOperationId,
      "journal.jsonl",
    );
    const appendFailure = new Error("injected recoveryRequired journal failure");

    const result = await recoverPendingSwitches(layout, {
      isProcessAlive: () => false,
      io: {
        async renameJournal(source, destination) {
          const records = (await readFile(source, "utf8")).trim().split("\n");
          const state = JSON.parse(records.at(-1)!).state;
          if (destination === firstJournalPath && state === "recoveryRequired") {
            throw appendFailure;
          }
          await rename(source, destination);
        },
      },
    });

    assert.deepEqual(result.recoveryRequiredOperationIds, [firstOperationId]);
    assert.deepEqual(result.recoveredOperationIds, [secondOperationId]);
    assert.equal((await readTransactionJournal(firstJournalPath)).at(-1)?.state, "applying");
    assert.equal(
      (await readTransactionJournal(second.journalPath)).at(-1)?.state,
      "rolledBack",
    );
  });
});

test("restores an applying transaction from the rollout byte backup", async () => {
  await withLayout(async (layout) => {
    const beforeConfig = await readFile(layout.configPath, "utf8");
    const rolloutPath = join(layout.sessionsDir, "one.jsonl");
    const beforeRollout =
      '{"type":"session_meta","payload":{"id":"one","model_provider":"before"}}\n';
    await writeFile(rolloutPath, beforeRollout, "utf8");
    const beforeSqlite = await readFile(layout.sqlitePath);
    const rolloutChanges = await collectRolloutChanges(layout, "after");
    const [inversePatch] = createRolloutInversePatches(rolloutChanges);
    const transaction = await beginTransaction(layout, { operationId: "recover-applying" });
    await transaction.backupTargets([
      { kind: "config", path: layout.configPath },
      { kind: "sqlite", path: layout.sqlitePath },
      { kind: "rollout", path: rolloutPath },
    ]);
    await transaction.markApplying([
      { kind: "config", path: layout.configPath },
      { kind: "rollout", path: rolloutPath, inversePatch },
      { kind: "sqlite", path: layout.sqlitePath },
    ]);
    await writeFile(layout.configPath, "changed config", "utf8");
    await applyRolloutChanges(rolloutChanges);
    await writeFile(layout.sqlitePath, "changed sqlite", "utf8");
    await transaction.release();

    const result = await recoverPendingSwitches(layout, { isProcessAlive: () => false });

    assert.equal(result.recoveredOperationIds.includes("recover-applying"), true);
    assert.equal(await readFile(layout.configPath, "utf8"), beforeConfig);
    assert.equal(await readFile(rolloutPath, "utf8"), beforeRollout);
    assert.deepEqual(await readFile(layout.sqlitePath), beforeSqlite);
    const journal = await readFile(
      join(layout.switcherDir, "transactions", "recover-applying", "journal.jsonl"),
      "utf8",
    );
    assert.equal(JSON.parse(journal.trim().split("\n").at(-1)!).state, "rolledBack");
  });
});

test("strict recovery preserves an external post-apply write", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, {
      operationId: "external-after-apply",
      requireSourceVersionProtocol: true,
    });
    await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
    await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
    await writeFile(layout.configPath, "extension config", "utf8");
    await transaction.markTargetApplied({ kind: "config", path: layout.configPath });
    await writeFile(layout.configPath, "native change after apply", "utf8");
    await transaction.release();

    const result = await recoverPendingSwitches(layout, {
      isProcessAlive: () => false,
      requireSourceVersionProtocol: false,
    });

    assert.deepEqual(result.recoveredOperationIds, []);
    assert.deepEqual(result.recoveryRequiredOperationIds, ["external-after-apply"]);
    assert.equal(await readFile(layout.configPath, "utf8"), "native change after apply");
    assert.equal(
      (await readTransactionJournal(transaction.journalPath)).at(-1)?.state,
      "recoveryRequired",
    );
  });
});

test("retains an applied config version in memory when its journal append fails", async () => {
  await withLayout(async (layout) => {
    const originalConfig = await readFile(layout.configPath, "utf8");
    const appendFailure = new Error("injected applied-version journal failure");
    let failAppliedRecord = false;
    const transaction = await beginTransaction(layout, {
      operationId: "applied-version-in-memory",
      requireSourceVersionProtocol: true,
      io: {
        async renameJournal(source, destination) {
          const records = (await readFile(source, "utf8")).trim().split("\n");
          const entry = JSON.parse(records.at(-1)!) as {
            appliedTargetVersions?: unknown;
          };
          if (failAppliedRecord && entry.appliedTargetVersions !== undefined) {
            throw appendFailure;
          }
          await rename(source, destination);
        },
      },
    });
    await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
    await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
    await writeFile(layout.configPath, "extension config", "utf8");
    failAppliedRecord = true;

    try {
      await assert.rejects(
        () => transaction.markTargetApplied({ kind: "config", path: layout.configPath }),
        (error: unknown) => error === appendFailure,
      );
      assert.equal(
        (await readTransactionJournal(transaction.journalPath))
          .some((entry) => entry.appliedTargetVersions !== undefined),
        false,
      );

      failAppliedRecord = false;
      await transaction.rollback();
      assert.equal(await readFile(layout.configPath, "utf8"), originalConfig);
    } finally {
      await transaction.release();
    }
  });
});

test("derives strict recovery from the prepared journal instead of a caller toggle", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, {
      operationId: "strict-journal-overrides-caller",
      requireSourceVersionProtocol: true,
    });
    await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
    await transaction.markApplying();
    await transaction.prepareTarget({ kind: "config", path: layout.configPath });
    await writeFile(layout.configPath, "external bytes after a possible application", "utf8");
    await transaction.release();

    const result = await recoverPendingSwitches(layout, {
      isProcessAlive: () => false,
      requireSourceVersionProtocol: false,
    });

    assert.deepEqual(result.recoveredOperationIds, []);
    assert.deepEqual(result.recoveryRequiredOperationIds, [
      "strict-journal-overrides-caller",
    ]);
    assert.equal(
      await readFile(layout.configPath, "utf8"),
      "external bytes after a possible application",
    );
  });
});

test("does not compensate a committed transaction during recovery", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, { operationId: "committed-stays" });
    await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
    await transaction.markApplying([layout.configPath]);
    await transaction.markCommitted();
    await transaction.release();
    await writeFile(layout.configPath, "post-commit state", "utf8");

    const result = await recoverPendingSwitches(layout, { isProcessAlive: () => false });

    assert.equal(result.recoveredOperationIds.includes("committed-stays"), false);
    assert.equal(await readFile(layout.configPath, "utf8"), "post-commit state");
  });
});

test("restores only config data selected by the pending journal targets", async () => {
  await withLayout(async (layout) => {
    const beforeConfig = await readFile(layout.configPath, "utf8");
    const transaction = await beginTransaction(layout, { operationId: "targeted-backup-restore" });
    await transaction.backupTargets([
      { kind: "config", path: layout.configPath },
      { kind: "sqlite", path: layout.sqlitePath },
    ]);
    await transaction.markApplying([{ kind: "config", path: layout.configPath }]);
    await writeFile(layout.configPath, "changed config", "utf8");
    await writeFile(layout.sqlitePath, "changed sqlite", "utf8");
    await transaction.release();

    const result = await recoverPendingSwitches(layout, { isProcessAlive: () => false });

    assert.equal(result.recoveredOperationIds.includes("targeted-backup-restore"), true);
    assert.equal(await readFile(layout.configPath, "utf8"), beforeConfig);
    assert.equal(await readFile(layout.sqlitePath, "utf8"), "changed sqlite");
  });
});

test("creates a durable byte backup for an allowed rollout file", async () => {
  await withLayout(async (layout) => {
    const rolloutPath = join(layout.sessionsDir, "one.jsonl");
    const transaction = await beginTransaction(layout, {
      operationId: "rollout-byte-backup",
    });
    try {
      const manifest = await transaction.backupTargets([
        { kind: "rollout", path: rolloutPath },
      ]);
      const [entry] = manifest.entries;

      assert.equal(entry?.kind, "rollout");
      assert.equal(entry?.path, rolloutPath);
      assert.equal(entry?.existed, true);
      assert.equal(typeof entry?.backupPath, "string");
      assert.deepEqual(
        await readFile(entry?.backupPath ?? "", "utf8"),
        await readFile(rolloutPath, "utf8"),
      );
    } finally {
      await transaction.release();
    }
  });
});

test("does not append journal state when a publish-boundary version check fails", async () => {
  await withLayout(async (layout) => {
    const transaction = await beginTransaction(layout, {
      operationId: "boundary-version-check",
      requireSourceVersionProtocol: true,
    });
    const target = { kind: "config" as const, path: layout.configPath };
    try {
      await transaction.backupTargets([target]);
      await transaction.markApplying();
      await transaction.prepareTarget(target);
      const journalBeforeCheck = await readTransactionJournal(transaction.journalPath);
      await writeFile(layout.configPath, "native bytes at publish boundary", "utf8");

      await assert.rejects(
        () => transaction.assertTargetUnchanged(target),
        (error: unknown) =>
          error instanceof TransactionError && error.code === "rollback-failed",
      );

      assert.deepEqual(
        await readTransactionJournal(transaction.journalPath),
        journalBeforeCheck,
      );
      assert.equal(
        await readFile(layout.configPath, "utf8"),
        "native bytes at publish boundary",
      );
      await assert.rejects(
        () => transaction.rollback(),
        (error: unknown) =>
          error instanceof TransactionError && error.code === "rollback-failed",
      );
      assert.equal(
        (await readTransactionJournal(transaction.journalPath)).at(-1)?.state,
        "recoveryRequired",
      );
    } finally {
      await transaction.release();
    }
  });
});

test("accepts rollout applied-version evidence before preparing a following target", async () => {
  await withLayout(async (layout) => {
    const rolloutPath = join(layout.sessionsDir, "one.jsonl");
    await writeFile(
      rolloutPath,
      '{"type":"session_meta","payload":{"id":"one","model_provider":"before"}}\n',
      "utf8",
    );
    const rolloutBefore = await readFile(rolloutPath, "utf8");
    const [change] = await collectRolloutChanges(layout, "after");
    assert.ok(change);
    const [inversePatch] = createRolloutInversePatches([change]);
    assert.ok(inversePatch);
    const rolloutTarget = {
      kind: "rollout" as const,
      path: rolloutPath,
      inversePatch,
    };
    const configTarget = { kind: "config" as const, path: layout.configPath };
    const transaction = await beginTransaction(layout, {
      operationId: "rollout-version-before-next-target",
      requireSourceVersionProtocol: true,
    });
    try {
      await transaction.backupTargets([rolloutTarget, configTarget]);
      await transaction.markApplying();
      await transaction.prepareTarget(rolloutTarget);
      await applyRolloutChanges([change]);
      await transaction.markTargetApplied(rolloutTarget);

      await transaction.prepareTarget(configTarget);

      assert.equal(
        (await readTransactionJournal(transaction.journalPath))
          .some((entry) => entry.appliedTargetVersions?.some(
            (version) => version.target.kind === "rollout",
          )),
        true,
      );
      await transaction.rollback();
      assert.equal(await readFile(rolloutPath, "utf8"), rolloutBefore);
    } finally {
      await transaction.release();
    }
  });
});

test("recovers strict rollout applied-version evidence", async () => {
  await withLayout(async (layout) => {
    const rolloutPath = join(layout.sessionsDir, "one.jsonl");
    await writeFile(
      rolloutPath,
      '{"type":"session_meta","payload":{"id":"one","model_provider":"before"}}\n',
      "utf8",
    );
    const rolloutBefore = await readFile(rolloutPath, "utf8");
    const [change] = await collectRolloutChanges(layout, "after");
    assert.ok(change);
    const [inversePatch] = createRolloutInversePatches([change]);
    assert.ok(inversePatch);
    const target = {
      kind: "rollout" as const,
      path: rolloutPath,
      inversePatch,
    };
    const transaction = await beginTransaction(layout, {
      operationId: "recover-rollout-applied-version",
      requireSourceVersionProtocol: true,
    });
    await transaction.backupTargets([target]);
    await transaction.markApplying();
    await transaction.prepareTarget(target);
    await applyRolloutChanges([change]);
    await transaction.markTargetApplied(target);
    await transaction.release();

    const recovery = await recoverPendingSwitches(layout, {
      isProcessAlive: () => false,
    });

    assert.deepEqual(recovery.recoveredOperationIds, ["recover-rollout-applied-version"]);
    assert.equal(await readFile(rolloutPath, "utf8"), rolloutBefore);
  });
});

async function withLayout(callback: (layout: CodexLayout) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "transaction-test-"));
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
  await mkdir(layout.switcherDir);
  await writeFile(layout.configPath, "model_provider = 'before'\n", "utf8");
  await writeFile(layout.authPath, '{"OPENAI_API_KEY":"must-not-backup"}\n', "utf8");
  await writeFile(join(layout.sessionsDir, "one.jsonl"), '{"type":"session_meta"}\n', "utf8");
  await writeFile(layout.sqlitePath, Buffer.from("before sqlite"));
  try {
    await callback(layout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function windowsShortPath(path: string): Promise<string | undefined> {
  try {
    const result = await execFile(
      "cmd.exe",
      ["/d", "/c", `for %I in (${path}) do @echo %~sI`],
      { encoding: "utf8" },
    );
    const shortPath = result.stdout.trim();
    return shortPath.length === 0 ? undefined : shortPath;
  } catch {
    return undefined;
  }
}

async function assertInvalidPersistedCustomProfileIdRejected(
  customProfileId: string,
): Promise<void> {
  await withLayout(async (layout) => {
    const operationId = `invalid-profile-${customProfileId.replace(/[^a-z]+/gi, "-").toLowerCase()}`;
    const directory = join(layout.switcherDir, "transactions", operationId);
    const journalPath = join(directory, "journal.jsonl");
    const contents = `${[
      {
        version: 1,
        operationId,
        state: "prepared",
        timestamp: "2026-08-26T00:00:00.000Z",
      },
      {
        version: 1,
        operationId,
        state: "applying",
        timestamp: "2026-08-26T00:00:01.000Z",
        pendingTargets: [{ kind: "auth", previousMode: "custom", customProfileId }],
      },
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await mkdir(directory, { recursive: true });
    await writeFile(journalPath, contents, "utf8");
    let restoreCalls = 0;

    await assert.rejects(
      () => recoverPendingSwitches(layout, {
        isProcessAlive: () => false,
        restoreAuthMode: async () => {
          restoreCalls += 1;
        },
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "journal-invalid",
    );
    assert.equal(restoreCalls, 0);
    assert.equal(await readFile(journalPath, "utf8"), contents);
  });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function collectErrorDetails(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const nested = error instanceof AggregateError
    ? error.errors.map((entry) => collectErrorDetails(entry)).join("\n")
    : "";
  return [error.name, error.message, error.stack ?? "", collectErrorDetails(error.cause), nested].join("\n");
}

function isWindowsSymlinkPrivilegeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES");
}
