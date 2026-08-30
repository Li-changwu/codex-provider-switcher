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

  assert.deepEqual(result, { exitCode: 0 });
  assert.deepEqual(harness.options, [{
    name: "Codex: Resume source-1",
    cwd: "/home/ada/.codex",
    env: { CODEX_HOME: "/home/ada/.codex" },
  }]);
  assert.equal(harness.showCalls, 1);
  assert.deepEqual(harness.sent, [{ text: "codex resume source-1", shouldExecute: true }]);
  assert.deepEqual(harness.forkCalls, []);
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

function invocation(operation: "resume" | "fork", sessionId: string): TerminalInvocation {
  return {
    command: "codex",
    args: [operation, sessionId],
    title: `Codex: ${operation === "resume" ? "Resume" : "Fork"} ${sessionId}`,
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

function createHarness(options: { branchSessionId?: string; forkError?: Error } = {}) {
  const terminalOptions: Array<{
    name: string;
    cwd: string;
    env: { CODEX_HOME: string };
  }> = [];
  const sent: Array<{ text: string; shouldExecute: boolean | undefined }> = [];
  const forkCalls: Array<{ sourceSessionId: string; codexHome: string }> = [];
  let showCalls = 0;
  const api: NativeContinuationTerminalApi = {
    createTerminal(terminal) {
      terminalOptions.push(terminal);
      return {
        show() {
          showCalls += 1;
        },
        sendText(text, shouldExecute) {
          sent.push({ text, shouldExecute });
        },
      };
    },
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
  };
}
