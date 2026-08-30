import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  forkNativeCodexThread,
  type AppServerChild,
  type AppServerSpawn,
  type AppServerSpawnOptions,
  type ForkNativeCodexThreadInput,
} from "../../src/ui/app-server-fork";

test("sends only the native fork protocol in order and returns the response thread id", async () => {
  const harness = createHarness();
  const resultPromise = forkNativeCodexThread({
    command: "test-codex",
    sourceSessionId: "source_session-9",
    codexHome: "C:/test/.codex",
    spawn: harness.spawn,
    timeoutMs: 1_000,
  });

  await waitFor(() => harness.messages().length === 1);
  assert.deepEqual(harness.calls, [{
    command: "test-codex",
    args: ["app-server", "--listen", "stdio://"],
    options: {
      cwd: "C:/test/.codex",
      env: { ...process.env, CODEX_HOME: "C:/test/.codex" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  }]);

  const [initialize] = harness.messages();
  const clientInfo = (initialize.params as { clientInfo: { name: string; version: string } }).clientInfo;
  assert.deepEqual(initialize, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      clientInfo: {
        name: "codex-provider-switcher",
        version: clientInfo.version,
      },
      capabilities: null,
    },
  });
  assert.match(clientInfo.version, /\S/);

  harness.writeStdout("{\"jsonrpc\":\"2.0\",\"method\":\"server/ready\",\"params\":{}}\n{\"jsonrpc\":\"2.0\",\"id\":");
  assert.equal(harness.messages().length, 1);
  harness.writeStdout("1,\"result\":{\"ignored\":true}}\n");

  await waitFor(() => harness.messages().length === 3);
  assert.deepEqual(harness.messages().map((message) => message.method), [
    "initialize",
    "initialized",
    "thread/fork",
  ]);
  assert.deepEqual(harness.messages()[1], {
    jsonrpc: "2.0",
    method: "initialized",
    params: {},
  });
  assert.deepEqual(harness.messages()[2], {
    jsonrpc: "2.0",
    id: 2,
    method: "thread/fork",
    params: {
      threadId: "source_session-9",
      excludeTurns: true,
    },
  });

  harness.writeStdout("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"thread\":{\"id\":\"trusted");
  harness.writeStdout("-branch_1\",\"preview\":\"untrusted\"},\"preview\":\"untrusted\",\"turns\":[{\"id\":\"not-the-answer\"}],\"title\":\"untrusted\",\"path\":\"untrusted\"}}\n");

  assert.equal(await resultPromise, "trusted-branch_1");
  assert.equal(harness.child.killCalls.length, 1);
  assert.ok(harness.messages().every((message) => ![
    "thread/read",
    "thread/items/list",
    "thread/turns/list",
  ].includes(message.method)));
});

test("fails closed for a missing or malformed fork thread identifier", async () => {
  for (const id of [undefined, "../untrusted"]) {
    const harness = createHarness();
    const { resultPromise } = await startThroughForkRequest(harness);

    harness.writeStdout(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { thread: id === undefined ? {} : { id } },
    })}\n`);

    await assertFailsClosed(resultPromise, harness.child);
  }
});

test("fails closed for a JSON-RPC error without exposing its message", async () => {
  const harness = createHarness();
  const { resultPromise } = await startThroughForkRequest(harness);

  harness.writeStdout(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32000, message: "sensitive server diagnostic" },
  })}\n`);

  await assertFailsClosed(resultPromise, harness.child);
});

test("fails closed for invalid JSONL", async () => {
  const harness = createHarness();
  const resultPromise = startFork(harness);

  await waitFor(() => harness.messages().length === 1);
  harness.writeStdout("{not-json}\n");

  await assertFailsClosed(resultPromise, harness.child);
});

test("fails closed when stdout exceeds its bounded buffer", async () => {
  const harness = createHarness();
  const resultPromise = startFork(harness, { maxStdoutBytes: 32 });

  await waitFor(() => harness.messages().length === 1);
  harness.writeStdout("x".repeat(33));

  await assertFailsClosed(resultPromise, harness.child);
});

test("fails closed when the child errors or exits early", async () => {
  const errorHarness = createHarness();
  const errorResult = startFork(errorHarness);
  await waitFor(() => errorHarness.messages().length === 1);
  errorHarness.child.emit("error", new Error("sensitive child error"));
  await assertFailsClosed(errorResult, errorHarness.child);

  const closeHarness = createHarness();
  const closeResult = startFork(closeHarness);
  await waitFor(() => closeHarness.messages().length === 1);
  closeHarness.child.emit("close", 1, null);
  await assertFailsClosed(closeResult, closeHarness.child);
});

test("fails closed when stdout closes before a fork response", async () => {
  const harness = createHarness();
  const resultPromise = startFork(harness);

  await waitFor(() => harness.messages().length === 1);
  harness.child.stdout.end();

  await assertFailsClosed(resultPromise, harness.child);
});

test("fails closed on timeout", async () => {
  const harness = createHarness();
  const resultPromise = startFork(harness, { timeoutMs: 5 });

  await assertFailsClosed(resultPromise, harness.child);
});

interface SpawnCall {
  command: string;
  args: string[];
  options: AppServerSpawnOptions;
}

function createHarness() {
  const child = new FakeChild();
  const calls: SpawnCall[] = [];
  const spawn: AppServerSpawn = (command, args, options) => {
    calls.push({
      command,
      args: [...args],
      options: {
        cwd: options.cwd,
        env: { ...options.env },
        shell: options.shell,
        stdio: [...options.stdio] as ["pipe", "pipe", "pipe"],
      },
    });
    return child;
  };

  return {
    child,
    calls,
    spawn,
    messages(): Array<{ method: string; params: unknown; [key: string]: unknown }> {
      return child.written
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; params: unknown; [key: string]: unknown });
    },
    writeStdout(value: string) {
      child.stdout.write(value);
    },
  };
}

function startFork(
  harness: ReturnType<typeof createHarness>,
  overrides: Partial<ForkNativeCodexThreadInput> = {},
): Promise<string> {
  return forkNativeCodexThread({
    command: "test-codex",
    sourceSessionId: "source_session-9",
    codexHome: "C:/test/.codex",
    spawn: harness.spawn,
    timeoutMs: 1_000,
    ...overrides,
  });
}

async function startThroughForkRequest(
  harness: ReturnType<typeof createHarness>,
): Promise<{ resultPromise: Promise<string> }> {
  const resultPromise = startFork(harness);
  await waitFor(() => harness.messages().length === 1);
  harness.writeStdout("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n");
  await waitFor(() => harness.messages().length === 3);
  return { resultPromise };
}

async function assertFailsClosed(resultPromise: Promise<string>, child: FakeChild): Promise<void> {
  await assert.rejects(resultPromise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Unable to obtain native Codex fork.");
    return true;
  });
  assert.equal(child.killCalls.length, 1);
}

class FakeChild extends EventEmitter implements AppServerChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killCalls: Array<NodeJS.Signals | number | undefined> = [];
  written = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.written += chunk.toString("utf8");
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal);
    return true;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for the fake child process");
}
