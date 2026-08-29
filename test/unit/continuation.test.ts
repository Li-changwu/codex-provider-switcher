import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { access, copyFile, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import {
  clearCodexCapabilityCacheForTests,
  ContinuationError,
  continueSession,
  listBranchMappings,
  type InteractiveCodexTerminal,
  type TerminalInvocation,
} from "../../src/core/continuation";
import type { CodexLayout } from "../../src/core/types";
import type {
  WindowsFileIdentity,
  WindowsFileOperations,
} from "../../src/core/windows-file-operations";

const nodeRequire = createRequire(import.meta.url);

test("opens an existing zero-inode state database and lists its fork mapping", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeStats(async () => {
    await withLayout(async (layout) => {
      clearCodexCapabilityCacheForTests();
      const fileIdentityOptions = zeroInodeIdentityOptions();
      await continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: hash("initial zero-inode state"),
        terminal: new FakeTerminal([{ branchSessionId: "branch-1" }]),
        commandRunner: successfulHelp,
        fileIdentityOptions,
      });

      const result = await continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: hash("existing zero-inode state"),
        terminal: new FakeTerminal([{ branchSessionId: "branch-2" }]),
        commandRunner: successfulHelp,
        fileIdentityOptions,
      });

      assert.equal(result.branchSessionId, "branch-2");
      assert.deepEqual(
        (await listBranchMappings(layout, fileIdentityOptions)).map((mapping) => mapping.branchSessionId),
        ["branch-2", "branch-1"],
      );
    });
  });
});

test("rejects a zero-inode state database replaced between trust checks", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeStats(async () => {
    await withLayout(async (layout) => {
      clearCodexCapabilityCacheForTests();
      const windowsFileOperations = new DeterministicWindowsFileOperations();
      const fileIdentityOptions = zeroInodeIdentityOptions(windowsFileOperations);
      await continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: hash("initial zero-inode state"),
        terminal: new FakeTerminal([{ branchSessionId: "branch-1" }]),
        commandRunner: successfulHelp,
        fileIdentityOptions,
      });
      windowsFileOperations.replaceStateAfterNextTrustCheck(layout);

      await assert.rejects(
        () => continueSession({
          layout,
          sessionId: "source-1",
          mode: "fork",
          targetProfileId: "custom",
          sourceEventHash: hash("replaced zero-inode state"),
          terminal: new FakeTerminal([{ branchSessionId: "branch-2" }]),
          commandRunner: successfulHelp,
          fileIdentityOptions,
        }),
        /continuation mapping store/i,
      );
    });
  });
});

test("creates a missing zero-inode state database and lists its fork mapping", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeStats(async () => {
    await withLayout(async (layout) => {
      clearCodexCapabilityCacheForTests();
      const fileIdentityOptions = zeroInodeIdentityOptions();
      await continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: hash("missing zero-inode state"),
        terminal: new FakeTerminal([{ branchSessionId: "branch-1" }]),
        commandRunner: successfulHelp,
        fileIdentityOptions,
      });

      assert.equal((await lstat(join(layout.switcherDir, "state.sqlite"), { bigint: true })).ino, 0n);
      assert.deepEqual(
        (await listBranchMappings(layout, fileIdentityOptions)).map((mapping) => mapping.branchSessionId),
        ["branch-1"],
      );
    });
  });
});

test("launches native resume with an argument array after one capability check", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const terminal = new FakeTerminal();
    let helpCalls = 0;

    const first = await continueSession({
      layout,
      sessionId: "source-1",
      mode: "resume",
      targetProfileId: "custom",
      terminal,
      commandRunner: async (command, args) => {
        assert.equal(command, "codex");
        assert.deepEqual(args, ["--help"]);
        helpCalls += 1;
        return { exitCode: 0, stdout: "Usage: codex\n  resume\n  fork\n", stderr: "" };
      },
    });
    const second = await continueSession({
      layout,
      sessionId: "source-2",
      mode: "resume",
      targetProfileId: "custom",
      terminal,
      commandRunner: async () => {
        throw new Error("capability probe must be cached");
      },
    });

    assert.equal(first.status, "resumed");
    assert.equal(second.status, "resumed");
    assert.equal(helpCalls, 1);
    assert.deepEqual(terminal.invocations, [
      { command: "codex", args: ["resume", "source-1"], title: "Codex: Resume source-1", shell: false },
      { command: "codex", args: ["resume", "source-2"], title: "Codex: Resume source-2", shell: false },
    ]);
  });
});

test("reuses an active fork only while the source event hash is unchanged", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const terminal = new FakeTerminal([
      { branchSessionId: "branch-1" },
      {},
      { branchSessionId: "branch-2" },
    ]);
    const request = {
      layout,
      sessionId: "source-1",
      mode: "fork" as const,
      targetProfileId: "custom",
      sourceEventHash: hash("source revision one"),
      terminal,
      commandRunner: successfulHelp,
    };

    const created = await continueSession(request);
    const reused = await continueSession(request);
    const changed = await continueSession({
      ...request,
      sourceEventHash: hash("source revision three"),
    });

    assert.deepEqual(
      [created.status, reused.status, changed.status],
      ["forked", "reusedBranch", "forked"],
    );
    assert.deepEqual(terminal.invocations, [
      { command: "codex", args: ["fork", "source-1"], title: "Codex: Fork source-1", shell: false },
      { command: "codex", args: ["resume", "branch-1"], title: "Codex: Resume branch-1", shell: false },
      { command: "codex", args: ["fork", "source-1"], title: "Codex: Fork source-1", shell: false },
    ]);
    assert.deepEqual(
      (await listBranchMappings(layout)).map((mapping) => ({
        branchSessionId: mapping.branchSessionId,
        sourceEventHash: mapping.sourceEventHash,
        status: mapping.status,
      })),
      [
        { branchSessionId: "branch-2", sourceEventHash: hash("source revision three"), status: "active" },
        { branchSessionId: "branch-1", sourceEventHash: hash("source revision one"), status: "active" },
      ],
    );
    const state = await readFile(join(layout.switcherDir, "state.sqlite"));
    assert.doesNotMatch(state.toString("utf8"), /source revision|readable context/i);
  });
});

test("reactivates an archived fork when its source hash becomes current again", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    await createActiveMappings(layout, 3);
    await continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: `a${"4".repeat(63)}`,
      now: () => "2026-08-24T04:00:00.000Z",
      terminal: new FakeTerminal([{}, { branchSessionId: "branch-4" }]),
      commandRunner: archiveCapableHelp,
    });

    const terminal = new FakeTerminal([{}, {}, {}]);
    const result = await continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: `a${"1".repeat(63)}`,
      terminal,
      commandRunner: archiveCapableHelp,
    });

    assert.equal(result.status, "reusedBranch");
    assert.equal(result.branchSessionId, "branch-1");
    assert.deepEqual(
      terminal.invocations.map((invocation) => invocation.args[0]),
      ["archive", "unarchive", "resume"],
    );
    assert.deepEqual(
      (await listBranchMappings(layout)).map((mapping) => ({
        branchSessionId: mapping.branchSessionId,
        status: mapping.status,
      })).sort((left, right) => left.branchSessionId.localeCompare(right.branchSessionId)),
      [
        { branchSessionId: "branch-1", status: "active" },
        { branchSessionId: "branch-2", status: "archived" },
        { branchSessionId: "branch-3", status: "active" },
        { branchSessionId: "branch-4", status: "active" },
      ],
    );
  });
});

test("preserves reactivation and restoration failures together", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    await createActiveMappings(layout, 3);
    await continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: `a${"4".repeat(63)}`,
      terminal: new FakeTerminal([{}, { branchSessionId: "branch-4" }]),
      commandRunner: archiveCapableHelp,
    });

    await assert.rejects(
      () => continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: `a${"1".repeat(63)}`,
        terminal: new FakeTerminal(),
        commandRunner: archiveCapableHelp,
        archiveBranch: async () => undefined,
        unarchiveBranch: async (branchSessionId) => {
          throw new Error(`unarchive ${branchSessionId} failed`);
        },
      }),
      (error: unknown) => (
        error instanceof AggregateError &&
        flattenErrorText(error).includes("branch-1") &&
        flattenErrorText(error).includes("branch-2")
      ),
    );
  });
});

test("requires confirmation before launching readable-content fallback after encrypted fork failure", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const terminal = new FakeTerminal([
      { exitCode: 1, stderr: "encrypted_content cannot be decrypted" },
      {},
    ]);
    let confirmations = 0;

    const result = await continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: hash("source revision"),
      readableFallbackPrompt: "Continue from the readable summary.",
      terminal,
      commandRunner: successfulHelp,
      confirmReadableContent: async () => {
        confirmations += 1;
        return true;
      },
    });

    assert.equal(result.status, "readableContentFallback");
    assert.equal(result.confirmationGranted, true);
    assert.equal(result.fallbackLaunched, true);
    assert.equal(confirmations, 1);
    assert.deepEqual(terminal.invocations, [
      { command: "codex", args: ["fork", "source-1"], title: "Codex: Fork source-1", shell: false },
      {
        command: "codex",
        args: ["Continue from the readable summary."],
        title: "Codex: Continue readable context",
        shell: false,
      },
    ]);
  });
});

test("offers confirmed readable-content fallback when the native fork command is unavailable", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const terminal = new FakeTerminal([{}]);

    const result = await continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: hash("source revision"),
      readableFallbackPrompt: "Continue from the readable summary.",
      terminal,
      commandRunner: async () => ({
        exitCode: 0,
        stdout: "Usage: codex\n  resume\n",
        stderr: "",
      }),
      confirmReadableContent: async () => true,
    });

    assert.deepEqual(result, {
      status: "readableContentFallback",
      sourceSessionId: "source-1",
      confirmationRequired: true,
      confirmationGranted: true,
      fallbackLaunched: true,
    });
    assert.deepEqual(terminal.invocations, [{
      command: "codex",
      args: ["Continue from the readable summary."],
      title: "Codex: Continue readable context",
      shell: false,
    }]);
    assert.deepEqual(await listBranchMappings(layout), []);
  });
});

test("archives the oldest native branch when a source and Profile exceed the active branch limit", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const terminal = new FakeTerminal([
      { branchSessionId: "branch-1" },
      { branchSessionId: "branch-2" },
      { branchSessionId: "branch-3" },
      {},
      { branchSessionId: "branch-4" },
    ]);
    let tick = 0;
    const nextTime = () => `2026-08-24T00:00:0${String(tick += 1)}.000Z`;

    for (const sourceEventHash of ["1", "2", "3", "4"].map((suffix) => `a${suffix.repeat(63)}`)) {
      const result = await continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash,
        terminal,
        commandRunner: async () => ({
          exitCode: 0,
          stdout: "Commands: resume fork archive unarchive",
          stderr: "",
        }),
        now: nextTime,
      });
      assert.equal(result.status, "forked");
    }

    assert.deepEqual(terminal.invocations.slice(-2), [{
      command: "codex",
      args: ["archive", "branch-1"],
      title: "Codex: Archive branch-1",
      shell: false,
    }, {
      command: "codex",
      args: ["fork", "source-1"],
      title: "Codex: Fork source-1",
      shell: false,
    }]);
    assert.equal(
      (await listBranchMappings(layout)).find((mapping) => mapping.branchSessionId === "branch-1")?.status,
      "archived",
    );
  });
});

test("does not launch a fourth fork when native archive is unavailable", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const terminal = new FakeTerminal([
      { branchSessionId: "branch-1" },
      { branchSessionId: "branch-2" },
      { branchSessionId: "branch-3" },
    ]);
    const request = {
      layout,
      sessionId: "source-1",
      mode: "fork" as const,
      targetProfileId: "custom",
      terminal,
      commandRunner: async () => ({
        exitCode: 0,
        stdout: "Commands: resume fork",
        stderr: "",
      }),
    };

    for (const suffix of ["1", "2", "3"]) {
      await continueSession({ ...request, sourceEventHash: `a${suffix.repeat(63)}` });
    }

    await assert.rejects(
      () => continueSession({ ...request, sourceEventHash: `a${"4".repeat(63)}` }),
      /active branch limit/i,
    );
    assert.equal(terminal.invocations.filter((entry) => entry.args[0] === "fork").length, 3);
  });
});

test("does not launch a fourth fork when native archive fails", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const terminal = new FakeTerminal([
      { branchSessionId: "branch-1" },
      { branchSessionId: "branch-2" },
      { branchSessionId: "branch-3" },
      { exitCode: 1 },
    ]);
    const request = {
      layout,
      sessionId: "source-1",
      mode: "fork" as const,
      targetProfileId: "custom",
      terminal,
      commandRunner: async () => ({
        exitCode: 0,
        stdout: "Commands: resume fork archive unarchive",
        stderr: "",
      }),
    };

    for (const suffix of ["1", "2", "3"]) {
      await continueSession({ ...request, sourceEventHash: `a${suffix.repeat(63)}` });
    }

    await assert.rejects(() => continueSession({
      ...request,
      sourceEventHash: `a${"4".repeat(63)}`,
    }));
    assert.deepEqual(terminal.invocations.at(-1)?.args, ["archive", "branch-1"]);
    assert.equal(terminal.invocations.filter((entry) => entry.args[0] === "fork").length, 3);
  });
});

test("does not archive mappings when an over-capacity fork falls back from encrypted content", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const terminal = new FakeTerminal([
      { branchSessionId: "branch-1" },
      { branchSessionId: "branch-2" },
      { branchSessionId: "branch-3" },
      {},
      { exitCode: 1, stderr: "encrypted_content cannot be decrypted" },
      {},
      {},
    ]);

    for (const suffix of ["1", "2", "3"]) {
      await continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: `a${suffix.repeat(63)}`,
        terminal,
        commandRunner: archiveCapableHelp,
      });
    }

    const result = await continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: `a${"4".repeat(63)}`,
      readableFallbackPrompt: "Continue from readable context.",
      confirmReadableContent: async () => true,
      terminal,
      commandRunner: archiveCapableHelp,
    });

    assert.equal(result.status, "readableContentFallback");
    assert.deepEqual(
      (await listBranchMappings(layout)).map((mapping) => ({
        branchSessionId: mapping.branchSessionId,
        status: mapping.status,
      })),
      [
        { branchSessionId: "branch-3", status: "active" },
        { branchSessionId: "branch-2", status: "active" },
        { branchSessionId: "branch-1", status: "active" },
      ],
    );
    assert.deepEqual(
      terminal.invocations.slice(-4).map((invocation) => invocation.args[0]),
      ["archive", "fork", "unarchive", "Continue from readable context."],
    );
  });
});

test("does not start an over-capacity fork from a terminal without a trustworthy outcome", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const setupTerminal = new FakeTerminal([
      { branchSessionId: "branch-1" },
      { branchSessionId: "branch-2" },
      { branchSessionId: "branch-3" },
    ]);
    for (const suffix of ["1", "2", "3"]) {
      await continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: `a${suffix.repeat(63)}`,
        terminal: setupTerminal,
        commandRunner: archiveCapableHelp,
      });
    }

    const rawTerminal = new RawTerminal();
    await assert.rejects(
      () => continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: `a${"4".repeat(63)}`,
        terminal: rawTerminal,
        commandRunner: archiveCapableHelp,
      }),
      /trustworthy fork outcome/i,
    );
    assert.deepEqual(rawTerminal.invocations, []);
    assert.ok((await listBranchMappings(layout)).every((mapping) => mapping.status === "active"));
  });
});

test("does not launch an initial native fork without a trustworthy outcome", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const terminal = new RawTerminal();

    await assert.rejects(
      () => continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: hash("source revision"),
        terminal,
        commandRunner: successfulHelp,
      }),
      /trustworthy fork outcome/i,
    );
    assert.deepEqual(terminal.invocations, []);
  });
});

test("fails closed when a trusted terminal does not report a fork session ID", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const terminal = new FakeTerminal([{}]);

    await assert.rejects(
      () => continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: hash("source revision"),
        terminal,
        commandRunner: successfulHelp,
      }),
      /did not report a trusted session ID/i,
    );
    assert.deepEqual(terminal.invocations.map((invocation) => invocation.args[0]), ["fork"]);
    assert.deepEqual(await listBranchMappings(layout), []);
  });
});

test("restores an over-capacity reservation when a trusted terminal reports an invalid branch ID", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const terminal = new FakeTerminal([
      { branchSessionId: "branch-1" },
      { branchSessionId: "branch-2" },
      { branchSessionId: "branch-3" },
      {},
      { branchSessionId: "../invalid" },
      {},
    ]);
    for (const suffix of ["1", "2", "3"]) {
      await continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: `a${suffix.repeat(63)}`,
        terminal,
        commandRunner: archiveCapableHelp,
      });
    }

    await assert.rejects(
      () => continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: `a${"4".repeat(63)}`,
        terminal,
        commandRunner: archiveCapableHelp,
      }),
      /branch session ID is invalid/i,
    );
    assert.ok((await listBranchMappings(layout)).every((mapping) => mapping.status === "active"));
    assert.deepEqual(
      terminal.invocations.slice(-3).map((invocation) => invocation.args[0]),
      ["archive", "fork", "unarchive"],
    );
  });
});

test("restores an over-capacity reservation when the terminal fails to launch fork", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const setupTerminal = new FakeTerminal([
      { branchSessionId: "branch-1" },
      { branchSessionId: "branch-2" },
      { branchSessionId: "branch-3" },
    ]);
    for (const suffix of ["1", "2", "3"]) {
      await continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: `a${suffix.repeat(63)}`,
        terminal: setupTerminal,
        commandRunner: archiveCapableHelp,
      });
    }

    const terminal = new ThrowingForkTerminal();
    await assert.rejects(
      () => continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: `a${"4".repeat(63)}`,
        terminal,
        commandRunner: archiveCapableHelp,
      }),
      /fork terminal failed/i,
    );
    assert.deepEqual(
      terminal.invocations.map((invocation) => invocation.args[0]),
      ["archive", "fork", "unarchive"],
    );
    assert.ok((await listBranchMappings(layout)).every((mapping) => mapping.status === "active"));
  });
});

test("rolls back the native capacity reservation when mapping commit fails", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const setupTerminal = new FakeTerminal([
      { branchSessionId: "branch-1" },
      { branchSessionId: "branch-2" },
      { branchSessionId: "branch-3" },
    ]);
    for (const suffix of ["1", "2", "3"]) {
      await continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: `a${suffix.repeat(63)}`,
        terminal: setupTerminal,
        commandRunner: archiveCapableHelp,
      });
    }

    const terminal = new MappingCommitFailureTerminal(join(layout.switcherDir, "state.sqlite"));
    await assert.rejects(
      () => continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: `a${"4".repeat(63)}`,
        terminal,
        commandRunner: archiveCapableHelp,
      }),
      /continuation mapping store/i,
    );
    assert.deepEqual(
      terminal.invocations.map((invocation) => invocation.args[0]),
      ["archive", "fork", "archive", "unarchive"],
    );
  });
});

test("archives a newly created native branch when a below-capacity mapping write fails", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const terminal = new FakeTerminal([{ branchSessionId: "branch-1" }]);
    let failInsert = false;
    const statementRunner = async (
      database: import("sqlite3").Database,
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      if (sql.startsWith("INSERT INTO branch_mappings") && failInsert) {
        throw new Error("injected mapping write failure");
      }
      await runSql(database, sql, params);
    };
    failInsert = true;

    await assert.rejects(
      () => continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: hash("source revision"),
        terminal,
        commandRunner: archiveCapableHelp,
        stateStoreStatementRunner: statementRunner,
      }),
      /continuation mapping store/i,
    );
    assert.deepEqual(
      terminal.invocations.map((invocation) => invocation.args[0]),
      ["fork", "archive"],
    );
  });
});

test("rolls back native capacity when the final mapping transaction commit fails", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    await createActiveMappings(layout, 3);
    const events: string[] = [];
    const terminal = new FakeTerminal(
      [{}, { branchSessionId: "branch-4" }],
      (invocation) => events.push(`terminal:${invocation.args[0]}`),
    );
    let commits = 0;

    await assert.rejects(
      () => continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: `a${"4".repeat(63)}`,
        terminal,
        commandRunner: archiveCapableHelp,
        stateStoreStatementRunner: async (database, sql, params = []) => {
          events.push(`sql:${sql}`);
          if (sql === "COMMIT" && commits++ === 1) {
            throw new Error("injected final commit failure");
          }
          await runSql(database, sql, params);
        },
      }),
      /continuation mapping store/i,
    );
    assert.deepEqual(
      terminal.invocations.map((invocation) => invocation.args[0]),
      ["archive", "fork", "archive", "unarchive"],
    );
    assert.deepEqual(
      (await listBranchMappings(layout)).filter((mapping) => mapping.status === "active").map((mapping) => mapping.branchSessionId),
      ["branch-3", "branch-2", "branch-1"],
    );
    assert.ok(
      events.lastIndexOf("terminal:unarchive") < events.lastIndexOf("sql:ROLLBACK"),
      "native compensation must complete before releasing the SQLite fork transaction",
    );
  });
});

test("initializes the mapping schema inside an exclusive transaction", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const statements: string[] = [];
    await continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: hash("source revision"),
      terminal: new FakeTerminal([{ branchSessionId: "branch-1" }]),
      commandRunner: successfulHelp,
      stateStoreStatementRunner: async (database, sql, params = []) => {
        statements.push(sql);
        await runSql(database, sql, params);
      },
    });
    assert.equal(statements[0], "BEGIN IMMEDIATE");
    assert.match(statements[1] ?? "", /^CREATE TABLE branch_mappings/);
  });
});

test("probes capabilities separately for distinct Codex command invocations", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const probes: Array<{ command: string; args: readonly string[] }> = [];
    const terminal = new FakeTerminal();
    const run = async (command: string, args: readonly string[]) => {
      probes.push({ command, args });
      return command === "codex-a"
        ? { exitCode: 0, stdout: "Commands: resume fork", stderr: "" }
        : { exitCode: 0, stdout: "Commands: resume", stderr: "" };
    };

    await continueSession({
      layout,
      sessionId: "source-1",
      mode: "resume",
      targetProfileId: "custom",
      terminal,
      commandRunner: run,
      codexCommand: "codex-a",
    });
    const result = await continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: "a".repeat(64),
      terminal,
      commandRunner: run,
      codexCommand: "codex-b",
    });

    assert.equal(result.status, "readableContentFallback");
    assert.deepEqual(probes, [
      { command: "codex-a", args: ["--help"] },
      { command: "codex-b", args: ["--help"] },
    ]);
  });
});

test("serializes concurrent forks for one source and Profile before capacity enforcement", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const setupTerminal = new FakeTerminal([
      { branchSessionId: "branch-1" },
      { branchSessionId: "branch-2" },
    ]);
    for (const suffix of ["1", "2"]) {
      await continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: `a${suffix.repeat(63)}`,
        terminal: setupTerminal,
        commandRunner: archiveCapableHelp,
      });
    }

    const terminal = new BlockingFirstForkTerminal();
    const first = continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: `a${"3".repeat(63)}`,
      terminal,
      commandRunner: archiveCapableHelp,
    });
    await terminal.firstForkStarted;
    const second = continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: `a${"4".repeat(63)}`,
      terminal,
      commandRunner: archiveCapableHelp,
    });

    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.equal(terminal.forkCalls, 1);
    terminal.releaseFirstFork();
    await Promise.all([first, second]);

    assert.equal(
      (await listBranchMappings(layout)).filter((mapping) => mapping.status === "active").length,
      3,
    );
  });
});

test("uses one fork lock for Windows Codex Home paths that differ only by case", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows path case normalization is not applicable on this platform");
    return;
  }
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const setupTerminal = new FakeTerminal([
      { branchSessionId: "branch-1" },
      { branchSessionId: "branch-2" },
    ]);
    for (const suffix of ["1", "2"]) {
      await continueSession({
        layout,
        sessionId: "source-1",
        mode: "fork",
        targetProfileId: "custom",
        sourceEventHash: `a${suffix.repeat(63)}`,
        terminal: setupTerminal,
        commandRunner: archiveCapableHelp,
      });
    }

    const casedLayout = {
      ...layout,
      codexHome: layout.codexHome.toUpperCase(),
      configPath: layout.configPath.toUpperCase(),
      authPath: layout.authPath.toUpperCase(),
      sessionsDir: layout.sessionsDir.toUpperCase(),
      archivedSessionsDir: layout.archivedSessionsDir.toUpperCase(),
      sqlitePath: layout.sqlitePath.toUpperCase(),
      switcherDir: layout.switcherDir.toUpperCase(),
    };
    const terminal = new BlockingFirstForkTerminal();
    const first = continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: `a${"3".repeat(63)}`,
      terminal,
      commandRunner: archiveCapableHelp,
    });
    await terminal.firstForkStarted;
    const second = continueSession({
      layout: casedLayout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: `a${"4".repeat(63)}`,
      terminal,
      commandRunner: archiveCapableHelp,
    });

    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.equal(terminal.forkCalls, 1);
    terminal.releaseFirstFork();
    await Promise.all([first, second]);
  });
});

test("runs managed retention cleanup after a successful resume", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const transactions = join(layout.switcherDir, "transactions");
    await mkdir(transactions);
    for (let index = 0; index < 11; index += 1) {
      const operationId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const operation = join(transactions, operationId);
      await mkdir(operation);
      await writeFile(join(operation, "journal.jsonl"), `${JSON.stringify({
        operationId,
        state: "committed",
        timestamp: `2026-08-24T00:00:${String(index).padStart(2, "0")}.000Z`,
      })}\n`);
    }
    const temporary = join(layout.switcherDir, "continuation-temp");
    const context = join(temporary, "context-old.txt");
    await mkdir(temporary);
    await writeFile(context, "managed readable context");

    const result = await continueSession({
      layout,
      sessionId: "source-1",
      mode: "resume",
      targetProfileId: "custom",
      terminal: new FakeTerminal(),
      commandRunner: successfulHelp,
    });

    assert.equal(result.status, "resumed");
    await assert.rejects(() => access(join(transactions, "00000000-0000-4000-8000-000000000000")));
    await assert.rejects(() => access(context));
  });
});

test("reports an unsafe retention root as a warning without deleting external context", async (t) => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const external = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "continuation-external-"));
    const externalContext = join(external, "context-old.txt");
    await writeFile(externalContext, "external context must remain");
    try {
      try {
        await symlink(external, join(layout.switcherDir, "continuation-temp"), "dir");
      } catch (error: unknown) {
        if (isWindowsSymlinkPrivilegeError(error)) {
          t.skip("creating directory symlinks requires Windows developer mode or equivalent privilege");
          return;
        }
        throw error;
      }

      const result = await continueSession({
        layout,
        sessionId: "source-1",
        mode: "resume",
        targetProfileId: "custom",
        terminal: new FakeTerminal(),
        commandRunner: successfulHelp,
      });

      assert.equal(result.status, "resumed");
      assert.equal(result.retentionWarning, true);
      assert.equal(await readFile(externalContext, "utf8"), "external context must remain");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

test("rejects mapping databases redirected through links without changing their targets", async (t) => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const external = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "continuation-state-external-"));
    const externalState = join(external, "state.sqlite");
    await forkWithMapping(layout);
    const localState = join(layout.switcherDir, "state.sqlite");
    await copyFile(localState, externalState);
    const externalContents = await readFile(externalState);
    await rm(localState);

    try {
      const linkedState = join(layout.switcherDir, "state.sqlite");
      try {
        await symlink(externalState, linkedState, "file");
      } catch (error: unknown) {
        if (isWindowsSymlinkPrivilegeError(error)) {
          t.skip("creating file symlinks requires Windows developer mode or equivalent privilege");
          return;
        }
        throw error;
      }

      await assert.rejects(
        () => forkWithMapping(layout),
        /continuation mapping store/i,
      );
      assert.deepEqual(await readFile(externalState), externalContents);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

test("rejects a hard-linked mapping database without changing its external target", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const external = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "continuation-state-external-"));
    const externalState = join(external, "state.sqlite");
    await forkWithMapping(layout);
    const localState = join(layout.switcherDir, "state.sqlite");
    await copyFile(localState, externalState);
    const externalContents = await readFile(externalState);
    await rm(localState);
    await link(externalState, localState);

    try {
      await assert.rejects(
        () => forkWithMapping(layout),
        /continuation mapping store/i,
      );
      assert.deepEqual(await readFile(externalState), externalContents);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

test("rejects a symbolic provider-switcher directory without creating external state", async (t) => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const external = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "continuation-root-external-"));
    const marker = join(external, "marker.txt");
    await writeFile(marker, "external directory must remain unchanged", "utf8");
    await rm(layout.switcherDir, { recursive: true, force: false });

    try {
      try {
        await symlink(external, layout.switcherDir, "dir");
      } catch (error: unknown) {
        if (isWindowsSymlinkPrivilegeError(error)) {
          t.skip("creating directory symlinks requires Windows developer mode or equivalent privilege");
          return;
        }
        throw error;
      }

      await assert.rejects(
        () => forkWithMapping(layout),
        /continuation mapping store/i,
      );
      assert.equal(await readFile(marker, "utf8"), "external directory must remain unchanged");
      await assert.rejects(() => access(join(external, "state.sqlite")));
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

test("redacts command stderr when Codex capability discovery fails", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const secret = "sk-1234567890abcdefghijklmnop";
    await assert.rejects(
      () => continueSession({
        layout,
        sessionId: "source-1",
        mode: "resume",
        targetProfileId: "custom",
        terminal: new FakeTerminal(),
        commandRunner: async () => ({ exitCode: 1, stdout: "", stderr: `OPENAI_API_KEY=${secret}` }),
      }),
      (error: unknown) => {
        assert.doesNotMatch(String(error), new RegExp(secret));
        return /Codex CLI capabilities/i.test(String(error));
      },
    );
  });
});

test("bounds a hanging default CLI capability probe", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const fakeCliPath = join(layout.codexHome, "hanging-codex.cjs");
    await writeFile(fakeCliPath, [
      "const args = process.argv.slice(2);",
      "if (args.at(-1) === '--help') setTimeout(() => process.exit(0), 1000);",
    ].join("\n"), "utf8");

    await assert.rejects(
      () => rejectAfter(
        continueSession({
          layout,
          sessionId: "source-1",
          mode: "resume",
          targetProfileId: "custom",
          terminal: new FakeTerminal(),
          codexCommand: process.execPath,
          codexCommandPrefixArgs: [fakeCliPath],
          capabilityProbeTimeoutMs: 50,
        }),
        250,
      ),
      (error: unknown) => (
        error instanceof ContinuationError && error.code === "capability-check-failed"
      ),
    );
  });
});

test("serializes fork capacity across separate extension hosts", { timeout: 15_000 }, async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    await continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: `a${"1".repeat(63)}`,
      terminal: new FakeTerminal([{ branchSessionId: "branch-1" }]),
      commandRunner: archiveCapableHelp,
    });
    await continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: `a${"2".repeat(63)}`,
      terminal: new FakeTerminal([{ branchSessionId: "branch-2" }]),
      commandRunner: archiveCapableHelp,
    });

    const synchronizationDirectory = join(layout.codexHome, "continuation-worker-sync");
    await mkdir(synchronizationDirectory);
    const workerPath = join(process.cwd(), "test", "fixtures", "continuation-worker.ts");
    const workers = ["one", "two"].map((workerId) => spawn(
      process.execPath,
      ["--import", "tsx", workerPath],
      {
        shell: false,
        env: {
          ...process.env,
          CONTINUATION_WORKER_ID: workerId,
          CONTINUATION_WORKER_LAYOUT: JSON.stringify(layout),
          CONTINUATION_WORKER_SYNC_DIRECTORY: synchronizationDirectory,
        },
      },
    ));
    const workerExits = Promise.all(workers.map(waitForWorker));
    const releasePath = join(synchronizationDirectory, "release");
    try {
      await waitForPaths([
        join(synchronizationDirectory, "started-one"),
        join(synchronizationDirectory, "started-two"),
      ]);
      await writeFile(join(synchronizationDirectory, "start"), "go", "utf8");
      await waitForAnyPath([
        join(synchronizationDirectory, "ready-one"),
        join(synchronizationDirectory, "ready-two"),
      ]);
      await delay(400);

      const readyCount = (await Promise.all([
        access(join(synchronizationDirectory, "ready-one")).then(() => true, () => false),
        access(join(synchronizationDirectory, "ready-two")).then(() => true, () => false),
      ])).filter(Boolean).length;
      assert.equal(readyCount, 1, "only one host may enter native fork before its mapping commits");

      await writeFile(releasePath, "release", "utf8");
      assert.deepEqual(await workerExits, [0, 0]);
      const active = (await listBranchMappings(layout)).filter((mapping) => (
        mapping.sourceSessionId === "source-1" &&
        mapping.targetProfileId === "custom" &&
        mapping.status === "active"
      ));
      assert.equal(active.length, 3);
    } finally {
      await writeFile(releasePath, "release", "utf8");
      await workerExits;
    }
  });
});

class FakeTerminal implements InteractiveCodexTerminal {
  readonly invocations: TerminalInvocation[] = [];
  readonly reportsForkOutcome = true;

  constructor(
    private readonly results: Array<{ exitCode?: number; stderr?: string; branchSessionId?: string }> = [],
    private readonly onLaunch?: (invocation: TerminalInvocation) => void,
  ) {}

  async launch(invocation: TerminalInvocation) {
    this.invocations.push(invocation);
    this.onLaunch?.(invocation);
    return this.results.shift() ?? {};
  }
}

class RawTerminal implements InteractiveCodexTerminal {
  readonly invocations: TerminalInvocation[] = [];

  async launch(invocation: TerminalInvocation) {
    this.invocations.push(invocation);
    return {};
  }
}

class ThrowingForkTerminal implements InteractiveCodexTerminal {
  readonly reportsForkOutcome = true;
  readonly invocations: TerminalInvocation[] = [];

  async launch(invocation: TerminalInvocation) {
    this.invocations.push(invocation);
    if (invocation.args[0] === "fork") {
      throw new Error("fork terminal failed");
    }
    return {};
  }
}

class MappingCommitFailureTerminal implements InteractiveCodexTerminal {
  readonly reportsForkOutcome = true;
  readonly invocations: TerminalInvocation[] = [];

  constructor(private readonly stateDatabasePath: string) {}

  async launch(invocation: TerminalInvocation) {
    this.invocations.push(invocation);
    if (invocation.args[0] === "fork") {
      await writeFile(this.stateDatabasePath, "not a SQLite database", "utf8");
      return { branchSessionId: "branch-4" };
    }
    return {};
  }
}

class BlockingFirstForkTerminal implements InteractiveCodexTerminal {
  readonly invocations: TerminalInvocation[] = [];
  readonly reportsForkOutcome = true;
  forkCalls = 0;
  private resolveFirstForkStarted!: () => void;
  private resolveFirstFork!: () => void;
  readonly firstForkStarted = new Promise<void>((resolve) => {
    this.resolveFirstForkStarted = resolve;
  });
  private readonly firstForkReleased = new Promise<void>((resolve) => {
    this.resolveFirstFork = resolve;
  });

  releaseFirstFork(): void {
    this.resolveFirstFork();
  }

  async launch(invocation: TerminalInvocation) {
    this.invocations.push(invocation);
    if (!invocation.args.includes("fork")) {
      return {};
    }
    this.forkCalls += 1;
    if (this.forkCalls === 1) {
      this.resolveFirstForkStarted();
      await this.firstForkReleased;
      return { branchSessionId: "branch-3" };
    }
    return { branchSessionId: "branch-4" };
  }
}

async function successfulHelp(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return { exitCode: 0, stdout: "Usage: codex\n  resume\n  fork\n", stderr: "" };
}

function rejectAfter<Result>(promise: Promise<Result>, milliseconds: number): Promise<Result> {
  return Promise.race([
    promise,
    new Promise<Result>((_resolve, reject) => {
      setTimeout(() => reject(new Error("Codex CLI capabilities could not be checked before the test timeout.")), milliseconds);
    }),
  ]);
}

async function waitForPaths(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    await waitForAnyPath([path]);
  }
}

async function waitForAnyPath(paths: readonly string[]): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const found = await Promise.all(paths.map((path) => access(path).then(() => true, () => false)));
    if (found.some(Boolean)) {
      return;
    }
    await delay(5);
  }
  throw new Error(`Timed out waiting for one of: ${paths.join(", ")}`);
}

function waitForWorker(worker: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) => resolve(code ?? 1));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function flattenErrorText(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const nested = error instanceof AggregateError
    ? error.errors.map((entry) => flattenErrorText(entry)).join("\n")
    : "";
  return `${error.message}\n${flattenErrorText(error.cause)}\n${nested}`;
}

function runSql(
  database: import("sqlite3").Database,
  sql: string,
  params: readonly unknown[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, (error) => (error ? reject(error) : resolve()));
  });
}

async function archiveCapableHelp(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return { exitCode: 0, stdout: "Usage: codex\n  resume\n  fork\n  archive\n  unarchive\n", stderr: "" };
}

async function forkWithMapping(layout: CodexLayout): Promise<void> {
  await continueSession({
    layout,
    sessionId: "source-1",
    mode: "fork",
    targetProfileId: "custom",
    sourceEventHash: hash("source revision"),
    terminal: new FakeTerminal([{ branchSessionId: "branch-1" }]),
    commandRunner: successfulHelp,
  });
}

async function createActiveMappings(layout: CodexLayout, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: `a${String(index).repeat(63)}`,
      terminal: new FakeTerminal([{ branchSessionId: `branch-${index}` }]),
      commandRunner: archiveCapableHelp,
      now: () => `2026-08-24T0${index}:00:00.000Z`,
    });
  }
}

function hash(value: string): string {
  return `a${value.length.toString(16).padStart(63, "0")}`;
}

function isWindowsSymlinkPrivilegeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES");
}

async function withLayout(callback: (layout: CodexLayout) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "continuation-test-"));
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
  try {
    await callback(layout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withZeroInodeStats(callback: () => Promise<void>): Promise<void> {
  const mutableFs = nodeRequire("node:fs/promises") as {
    lstat: typeof lstat;
  };
  const originalLstat = mutableFs.lstat;
  mutableFs.lstat = (async (...args: Parameters<typeof lstat>) => {
    const stats = await originalLstat(...args);
    return withZeroInodeStatsValue(stats);
  }) as typeof lstat;
  syncBuiltinESMExports();
  try {
    await callback();
  } catch (error: unknown) {
    console.error("zero-inode continuation diagnostic", describeErrorChain(error));
    throw error;
  } finally {
    mutableFs.lstat = originalLstat;
    syncBuiltinESMExports();
  }
}

function describeErrorChain(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const description: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    code: (error as NodeJS.ErrnoException).code,
  };
  if (error.cause !== undefined) {
    description.cause = describeErrorChain(error.cause);
  }
  if (error instanceof AggregateError) {
    description.errors = error.errors.map((entry) => describeErrorChain(entry));
  }
  return description;
}

function withZeroInodeStatsValue<T extends Awaited<ReturnType<typeof lstat>>>(stats: T): T {
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

function zeroInodeIdentityOptions(
  windowsFileOperations: WindowsFileOperations = new DeterministicWindowsFileOperations(),
) {
  return {
    platform: "win32" as const,
    windowsFileOperations,
  };
}

class DeterministicWindowsFileOperations implements WindowsFileOperations {
  private readonly identities = new Map<string, WindowsFileIdentity>();
  private readonly captureCounts = new Map<string, number>();
  private replacement?: { path: string; afterCaptureCount: number };

  captureFileIdentity(path: string): WindowsFileIdentity {
    const key = path.toLowerCase();
    const count = (this.captureCounts.get(key) ?? 0) + 1;
    this.captureCounts.set(key, count);
    const identity = this.identities.get(key) ?? this.createIdentity(this.identities.size + 1);
    this.identities.set(key, identity);
    if (this.replacement?.path.toLowerCase() === key && this.replacement.afterCaptureCount === count) {
      const replacementPath = `${path}.replacement`;
      writeFileSync(replacementPath, "replacement state", "utf8");
      renameSync(replacementPath, path);
      this.identities.set(key, this.createIdentity(this.identities.size + 1));
      this.replacement = undefined;
    }
    return identity;
  }

  deleteFileIfMatches(): "deleted" | "identity-mismatch" {
    throw new Error("deleteFileIfMatches is not used by continuation tests");
  }

  holdFileIfMatches(): { close: () => void } {
    throw new Error("holdFileIfMatches is not used by continuation tests");
  }

  replaceStateAfterNextTrustCheck(layout: CodexLayout): void {
    const path = join(layout.switcherDir, "state.sqlite");
    this.replacement = {
      path,
      afterCaptureCount: (this.captureCounts.get(path.toLowerCase()) ?? 0) + 2,
    };
  }

  private createIdentity(index: number): WindowsFileIdentity {
    return {
      volumeSerial: "0000000000000001",
      fileId: index.toString(16).padStart(32, "0"),
      linkCount: 1n,
    };
  }
}
