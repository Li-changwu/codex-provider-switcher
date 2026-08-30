import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import sqlite3 from "sqlite3";
import {
  clearCodexCapabilityCacheForTests,
  continueSession,
} from "../../src/core/continuation";
import type { CodexLayout } from "../../src/core/types";
import {
  forkNativeCodexThread,
  type AppServerChild,
} from "../../src/ui/app-server-fork";
import {
  createNativeContinuationTerminal,
  type NativeContinuationTerminalApi,
} from "../../src/ui/native-continuation-terminal";

test("persists the native app-server fork thread ID rather than an independent terminal candidate", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const appServer = new FakeAppServerChild("branch-from-app-server");
    const independentTerminalCandidateId = "branch-from-terminal";
    let terminalCreationCount = 0;
    const terminal = createNativeContinuationTerminal(fakeTerminalApi(() => {
      terminalCreationCount += 1;
      throw new Error(`Unexpected terminal candidate: ${independentTerminalCandidateId}`);
    }), layout, {
      forkNativeCodexThread: async ({ sourceSessionId, codexHome }) => forkNativeCodexThread({
        command: "codex",
        sourceSessionId,
        codexHome,
        spawn: () => appServer,
        timeoutMs: 1_000,
      }),
    });

    const result = await continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: "a".repeat(64),
      terminal,
      commandRunner: async (command, args) => {
        assert.equal(command, "codex");
        assert.deepEqual(args, ["--help"]);
        return { exitCode: 0, stdout: "Commands: resume fork\n", stderr: "" };
      },
    });

    assert.deepEqual(result, {
      status: "forked",
      sourceSessionId: "source-1",
      branchSessionId: "branch-from-app-server",
    });
    assert.notEqual(result.branchSessionId, independentTerminalCandidateId);
    assert.equal(terminalCreationCount, 0);
    assert.deepEqual(appServer.receivedMethods, ["initialize", "initialized", "thread/fork"]);
    assert.deepEqual(await readMappings(join(layout.switcherDir, "state.sqlite")), [{
      sourceSessionId: "source-1",
      targetProfileId: "custom",
      branchSessionId: "branch-from-app-server",
      sourceEventHash: "a".repeat(64),
      status: "active",
    }]);
  });
});

class FakeAppServerChild extends EventEmitter implements AppServerChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly receivedMethods: string[] = [];
  private input = "";

  constructor(private readonly branchId: string) {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.receive(chunk));
  }

  kill(): boolean {
    return true;
  }

  private receive(chunk: Buffer): void {
    this.input += chunk.toString("utf8");
    for (;;) {
      const newline = this.input.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.input.slice(0, newline);
      this.input = this.input.slice(newline + 1);
      const message = JSON.parse(line) as { id?: number; method: string };
      this.receivedMethods.push(message.method);
      if (message.id === 1 && message.method === "initialize") {
        this.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
      } else if (message.id === 2 && message.method === "thread/fork") {
        assert.deepEqual(message, {
          jsonrpc: "2.0",
          id: 2,
          method: "thread/fork",
          params: {
            threadId: "source-1",
            excludeTurns: true,
          },
        });
        this.stdout.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { thread: { id: this.branchId } },
        })}\n`);
        queueMicrotask(() => this.emit("close", 0, null));
      } else {
        assert.deepEqual(message, { jsonrpc: "2.0", method: "initialized", params: {} });
      }
    }
  }
}

function fakeTerminalApi(onUnexpectedCreate: () => never): NativeContinuationTerminalApi {
  return {
    createTerminal: onUnexpectedCreate,
    onDidChangeTerminalShellIntegration: () => ({ dispose: () => undefined }),
    onDidEndTerminalShellExecution: () => ({ dispose: () => undefined }),
  };
}

async function readMappings(databasePath: string): Promise<Array<{
  sourceSessionId: string;
  targetProfileId: string;
  branchSessionId: string;
  sourceEventHash: string;
  status: string;
}>> {
  const database = await new Promise<sqlite3.Database>((resolve, reject) => {
    const opened = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve(opened);
      }
    });
  });
  try {
    return await new Promise((resolve, reject) => {
      database.all<{
        sourceSessionId: string;
        targetProfileId: string;
        branchSessionId: string;
        sourceEventHash: string;
        status: string;
      }>(`SELECT source_session_id AS sourceSessionId,
                target_profile_id AS targetProfileId,
                branch_session_id AS branchSessionId,
                source_event_hash AS sourceEventHash,
                status
           FROM branch_mappings`, (error, rows) => (error ? reject(error) : resolve(rows)));
    });
  } finally {
    await new Promise<void>((resolve, reject) => database.close((error) => (error ? reject(error) : resolve())));
  }
}

async function withLayout(callback: (layout: CodexLayout) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "continuation-integration-"));
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
