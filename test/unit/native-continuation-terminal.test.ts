import assert from "node:assert/strict";
import test from "node:test";
import {
  createNativeContinuationTerminal,
  type NativeContinuationTerminalApi,
} from "../../src/ui/native-continuation-terminal";
import type { TerminalInvocation } from "../../src/core/continuation";
import type { CodexLayout } from "../../src/core/types";

test("resume creates one visible terminal scoped to the active Codex Home", async () => {
  const harness = createHarness();
  const adapter = createNativeContinuationTerminal(harness.api, layout(), {
    forkNativeCodexThread: harness.fork,
  });

  const result = await adapter.launch(invocation("resume", "source-1"));

  assert.deepEqual(result, {});
  assert.deepEqual(harness.options, [{
    name: "Codex: Resume source-1",
    cwd: "/home/ada/.codex",
    env: { CODEX_HOME: "/home/ada/.codex" },
  }]);
  assert.equal(harness.showCalls, 1);
  assert.deepEqual(harness.sent, [{ text: "codex resume source-1", shouldExecute: true }]);
  assert.deepEqual(harness.commands, []);
  assert.equal(harness.shellIntegrationListenerCount, 0);
  assert.equal(harness.endListenerCount, 0);
  assert.deepEqual(harness.forkCalls, []);
});

test("archive waits for its matching Shell Integration execution end before reporting success", async () => {
  const harness = createHarness({ deferCommandEnd: true });
  const adapter = createNativeContinuationTerminal(harness.api, layout(), {
    forkNativeCodexThread: harness.fork,
    shellIntegrationTimeoutMs: 20,
  });

  const resultPromise = adapter.launch(invocation("archive", "source-1"));
  assert.equal(await isSettled(resultPromise), false);
  await harness.commandStarted;
  assert.deepEqual(harness.commands, [["codex", ["archive", "source-1"]]]);
  assert.deepEqual(harness.sent, []);
  assert.deepEqual(harness.options, [{
    name: "Codex: Archive source-1",
    cwd: "/home/ada/.codex",
    env: { CODEX_HOME: "/home/ada/.codex" },
  }]);
  assert.equal(harness.showCalls, 1);
  harness.finishLatestCommand(0);

  assert.deepEqual(await resultPromise, { exitCode: 0 });
  assert.equal(harness.shellIntegrationListenerCount, 0);
  assert.equal(harness.endListenerCount, 0);
});

test("fails closed when an archive Shell Integration execution never ends", async () => {
  const harness = createHarness({ deferCommandEnd: true });
  const adapter = createNativeContinuationTerminal(harness.api, layout(), {
    forkNativeCodexThread: harness.fork,
    shellCommandTimeoutMs: 5,
  });

  const resultPromise = adapter.launch(invocation("archive", "source-1"));
  await harness.commandStarted;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const harnessDeadline = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error("test harness deadline")), 20);
  });
  try {
    await assert.rejects(
      Promise.race([resultPromise, harnessDeadline]),
      /native Codex terminal command timed out/i,
    );
  } finally {
    if (deadline !== undefined) {
      clearTimeout(deadline);
    }
  }
  assert.equal(harness.disposeCalls, 1);
  assert.equal(harness.shellIntegrationListenerCount, 0);
  assert.equal(harness.endListenerCount, 0);
});

test("unarchive returns the exit code from its matching Shell Integration execution", async () => {
  const harness = createHarness({ exitCodes: [23] });
  const adapter = createNativeContinuationTerminal(harness.api, layout(), {
    forkNativeCodexThread: harness.fork,
  });

  const result = await adapter.launch(invocation("unarchive", "source-1"));

  assert.deepEqual(result, { exitCode: 23 });
  assert.deepEqual(harness.commands, [["codex", ["unarchive", "source-1"]]]);
  assert.deepEqual(harness.sent, []);
  assert.equal(harness.endListenerCount, 0);
});

test("returns a nonzero archive execution exit code instead of reporting success", async () => {
  const harness = createHarness({ exitCodes: [7] });
  const adapter = createNativeContinuationTerminal(harness.api, layout(), {
    forkNativeCodexThread: harness.fork,
  });

  const result = await adapter.launch(invocation("archive", "source-1"));

  assert.deepEqual(result, { exitCode: 7 });
  assert.deepEqual(harness.commands, [["codex", ["archive", "source-1"]]]);
});

test("fails closed and removes listeners when Shell Integration is unavailable", async () => {
  const harness = createHarness({ shellIntegration: false });
  const adapter = createNativeContinuationTerminal(harness.api, layout(), {
    forkNativeCodexThread: harness.fork,
    shellIntegrationTimeoutMs: 5,
  });

  await assert.rejects(adapter.launch(invocation("archive", "source-1")), /shell integration/i);

  assert.deepEqual(harness.commands, []);
  assert.equal(harness.disposeCalls, 1);
  assert.equal(harness.shellIntegrationListenerCount, 0);
  assert.equal(harness.endListenerCount, 0);
});

test("disposes the archive terminal when its matching execution has no exit code", async () => {
  const harness = createHarness({ deferCommandEnd: true });
  const adapter = createNativeContinuationTerminal(harness.api, layout(), {
    forkNativeCodexThread: harness.fork,
  });

  const resultPromise = adapter.launch(invocation("archive", "source-1"));
  await harness.commandStarted;
  harness.finishLatestCommand(undefined);

  await assert.rejects(resultPromise, /did not report an exit code/i);
  assert.equal(harness.disposeCalls, 1);
  assert.equal(harness.shellIntegrationListenerCount, 0);
  assert.equal(harness.endListenerCount, 0);
});

test("disposes the unarchive terminal when Shell Integration execution throws", async () => {
  const failure = new Error("execution failed");
  const harness = createHarness({ commandError: failure });
  const adapter = createNativeContinuationTerminal(harness.api, layout(), {
    forkNativeCodexThread: harness.fork,
  });

  await assert.rejects(adapter.launch(invocation("unarchive", "source-1")), failure);
  assert.equal(harness.disposeCalls, 1);
  assert.equal(harness.shellIntegrationListenerCount, 0);
  assert.equal(harness.endListenerCount, 0);
});

test("fork delegates to the native fork client without creating a terminal", async () => {
  const harness = createHarness({ branchSessionId: "branch-2" });
  const adapter = createNativeContinuationTerminal(harness.api, layout(), {
    forkNativeCodexThread: harness.fork,
  });

  const result = await adapter.launch(invocation("fork", "source-1"));

  assert.deepEqual(result, { exitCode: 0, branchSessionId: "branch-2" });
  assert.deepEqual(harness.options, []);
  assert.equal(harness.showCalls, 0);
  assert.deepEqual(harness.sent, []);
  assert.deepEqual(harness.forkCalls, [{
    sourceSessionId: "source-1",
    codexHome: "/home/ada/.codex",
  }]);
});

test("rejects malformed or unsafe fork invocations without side effects", async () => {
  for (const malformed of [
    { ...invocation("fork", "source-1"), shell: true },
    { ...invocation("fork", "source-1"), command: "codex;rm" },
    { ...invocation("fork", "source-1"), args: ["fork", "../source"] },
    { ...invocation("fork", "source-1"), args: ["fork", "source-1", "extra"] },
  ] as const) {
    const harness = createHarness();
    const adapter = createNativeContinuationTerminal(harness.api, layout(), {
      forkNativeCodexThread: harness.fork,
    });

    await assert.rejects(adapter.launch(malformed as TerminalInvocation));
    assert.deepEqual(harness.options, []);
    assert.deepEqual(harness.forkCalls, []);
  }
});

test("rejects a non-Codex fork command without creating a terminal or calling the fork client", async () => {
  const harness = createHarness();
  const adapter = createNativeContinuationTerminal(harness.api, layout(), {
    forkNativeCodexThread: harness.fork,
  });
  const malformed = { ...invocation("fork", "source-1"), command: "other" };

  await assert.rejects(adapter.launch(malformed));

  assert.deepEqual(harness.options, []);
  assert.deepEqual(harness.forkCalls, []);
});

test("rejects a fork invocation with extra arguments without side effects", async () => {
  const harness = createHarness();
  const adapter = createNativeContinuationTerminal(harness.api, layout(), {
    forkNativeCodexThread: harness.fork,
  });
  const malformed = { ...invocation("fork", "source-1"), args: ["fork", "source-1", "extra"] };

  await assert.rejects(adapter.launch(malformed));

  assert.deepEqual(harness.options, []);
  assert.deepEqual(harness.forkCalls, []);
});

test("rejects token-safe non-Codex terminal commands without creating a terminal", async () => {
  const harness = createHarness();
  const adapter = createNativeContinuationTerminal(harness.api, layout(), {
    forkNativeCodexThread: harness.fork,
  });
  const malformed = { ...invocation("resume", "source-1"), command: "other" };

  await assert.rejects(adapter.launch(malformed));

  assert.deepEqual(harness.options, []);
  assert.deepEqual(harness.forkCalls, []);
});

test("rejects option-like session IDs for terminal and fork actions without side effects", async () => {
  for (const operation of ["resume", "fork"] as const) {
    const harness = createHarness();
    const adapter = createNativeContinuationTerminal(harness.api, layout(), {
      forkNativeCodexThread: harness.fork,
    });

    await assert.rejects(adapter.launch(invocation(operation, "--help")));
    assert.deepEqual(harness.options, []);
    assert.deepEqual(harness.commands, []);
    assert.deepEqual(harness.forkCalls, []);
  }
});

test("propagates a native fork-client failure without inventing a branch ID", async () => {
  const harness = createHarness({ forkError: new Error("client unavailable") });
  const adapter = createNativeContinuationTerminal(harness.api, layout(), {
    forkNativeCodexThread: harness.fork,
  });

  await assert.rejects(adapter.launch(invocation("fork", "source-1")), /client unavailable/);
  assert.deepEqual(harness.options, []);
  assert.deepEqual(harness.forkCalls, [{
    sourceSessionId: "source-1",
    codexHome: "/home/ada/.codex",
  }]);
});

test("reports a trustworthy fork outcome to the continuation core", () => {
  const harness = createHarness();

  assert.equal(createNativeContinuationTerminal(harness.api, layout()).reportsForkOutcome, true);
});

test("rejects invalid injected Shell Integration and command timeout bounds at construction", () => {
  const invalidTimeouts = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 60_001];

  for (const option of ["shellIntegrationTimeoutMs", "shellCommandTimeoutMs"] as const) {
    for (const value of invalidTimeouts) {
      const harness = createHarness();

      assert.throws(
        () => createNativeContinuationTerminal(harness.api, layout(), {
          forkNativeCodexThread: harness.fork,
          [option]: value,
        }),
        /timeout/i,
        `${option}=${value} must be rejected during adapter creation`,
      );
      assert.deepEqual(harness.options, []);
      assert.deepEqual(harness.forkCalls, []);
    }
  }
});

function invocation(operation: "resume" | "fork" | "archive" | "unarchive", sessionId: string): TerminalInvocation {
  return {
    command: "codex",
    args: [operation, sessionId],
    title: `Codex: ${operation[0].toUpperCase()}${operation.slice(1)} ${sessionId}`,
    shell: false,
  };
}

function layout(): CodexLayout {
  return {
    codexHome: "/home/ada/.codex",
    configPath: "/home/ada/.codex/config.toml",
    authPath: "/home/ada/.codex/auth.json",
    sessionsDir: "/home/ada/.codex/sessions",
    archivedSessionsDir: "/home/ada/.codex/archived_sessions",
    sqlitePath: "/home/ada/.codex/state_5.sqlite",
    switcherDir: "/home/ada/.codex/provider-switcher",
  };
}

interface HarnessOptions {
  readonly branchSessionId?: string;
  readonly commandError?: Error;
  readonly deferCommandEnd?: boolean;
  readonly exitCodes?: readonly number[];
  readonly forkError?: Error;
  readonly shellIntegration?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const terminalOptions: Array<{
    name: string;
    cwd: string;
    env: { CODEX_HOME: string };
  }> = [];
  const sent: Array<{ text: string; shouldExecute: boolean | undefined }> = [];
  const forkCalls: Array<{ sourceSessionId: string; codexHome: string }> = [];
  const shellIntegrationEvent = new TestEvent<{ terminal: FakeTerminal; shellIntegration: FakeShell }>();
  const executionEndEvent = new TestEvent<{ execution: FakeExecution; exitCode: number | undefined }>();
  const commands: Array<[string, string[]]> = [];
  const exitCodes = [...(options.exitCodes ?? [0])];
  let executionId = 0;
  let latestExecution: FakeExecution | undefined;
  let commandStartedResolve!: () => void;
  const commandStarted = new Promise<void>((resolve) => {
    commandStartedResolve = resolve;
  });
  let showCalls = 0;
  const shell: FakeShell = {
    executeCommand(executable, args) {
      if (options.commandError) {
        throw options.commandError;
      }
      const execution = { id: ++executionId };
      latestExecution = execution;
      commands.push([executable, [...args]]);
      commandStartedResolve();
      if (!options.deferCommandEnd) {
        queueMicrotask(() => executionEndEvent.fire({ execution, exitCode: exitCodes.shift() }));
      }
      return execution;
    },
  };
  let disposeCalls = 0;
  const terminal: FakeTerminal = {
    shellIntegration: options.shellIntegration === false ? undefined : shell,
    show() {
      showCalls += 1;
    },
    sendText(text, shouldExecute) {
      sent.push({ text, shouldExecute });
    },
    dispose() {
      disposeCalls += 1;
    },
  };
  const api: NativeContinuationTerminalApi = {
    createTerminal(createdTerminalOptions) {
      terminalOptions.push(createdTerminalOptions);
      return terminal;
    },
    onDidChangeTerminalShellIntegration: (listener) => shellIntegrationEvent.subscribe(listener),
    onDidEndTerminalShellExecution: (listener) => executionEndEvent.subscribe(listener),
  };
  const fork = async (input: { sourceSessionId: string; codexHome: string }): Promise<string> => {
    forkCalls.push(input);
    if (options.forkError) {
      throw options.forkError;
    }
    return options.branchSessionId ?? "branch-1";
  };

  return {
    api,
    commandStarted,
    get commands() {
      return commands;
    },
    get disposeCalls() {
      return disposeCalls;
    },
    get endListenerCount() {
      return executionEndEvent.listenerCount;
    },
    finishLatestCommand(exitCode: number | undefined) {
      if (!latestExecution) {
        throw new Error("No Shell Integration command was started.");
      }
      executionEndEvent.fire({ execution: latestExecution, exitCode });
    },
    get forkCalls() {
      return forkCalls;
    },
    fork,
    get options() {
      return terminalOptions;
    },
    get sent() {
      return sent;
    },
    get showCalls() {
      return showCalls;
    },
    get shellIntegrationListenerCount() {
      return shellIntegrationEvent.listenerCount;
    },
  };
}

interface FakeExecution {
  readonly id: number;
}

interface FakeShell {
  executeCommand(executable: string, args: string[]): FakeExecution;
}

interface FakeTerminal {
  readonly shellIntegration: FakeShell | undefined;
  show(preserveFocus?: boolean): void;
  sendText(text: string, shouldExecute?: boolean): void;
  dispose(): void;
}

class TestEvent<Event> {
  private readonly listeners = new Set<(event: Event) => void>();

  get listenerCount() {
    return this.listeners.size;
  }

  subscribe(listener: (event: Event) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  fire(event: Event): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5)),
  ]);
}
