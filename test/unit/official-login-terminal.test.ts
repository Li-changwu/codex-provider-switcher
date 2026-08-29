import assert from "node:assert/strict";
import test from "node:test";
import {
  createVscodeOfficialLoginExecutor,
  type OfficialLoginTerminalApi,
} from "../../src/ui/official-login-terminal";
import type { CodexLayout } from "../../src/core/types";

const layout: CodexLayout = {
  codexHome: "C:/codex",
  configPath: "C:/codex/config.toml",
  authPath: "C:/codex/auth.json",
  sessionsDir: "C:/codex/sessions",
  archivedSessionsDir: "C:/codex/archived_sessions",
  sqlitePath: "C:/codex/state_5.sqlite",
  switcherDir: "C:/codex/provider-switcher",
};

test("runs native login then status with the active Codex Home", async () => {
  const harness = createHarness({ exitCodes: [0, 0] });
  const executor = createVscodeOfficialLoginExecutor(harness.api);

  const result = await executor.run(layout);

  assert.deepEqual(harness.commands, [
    ["codex", ["login"]],
    ["codex", ["login", "status"]],
  ]);
  assert.deepEqual(harness.terminalOptions, {
    name: "Codex: Official Login",
    cwd: layout.codexHome,
    env: { CODEX_HOME: layout.codexHome },
  });
  assert.equal(harness.showCalls, 1);
  assert.deepEqual(result, { loginExitCode: 0, statusExitCode: 0 });
  assert.equal(harness.disposeCalls, 0);
  assert.equal(harness.shellIntegrationListenerCount, 0);
  assert.equal(harness.endListenerCount, 0);
});

test("fails closed when Shell Integration does not activate", async () => {
  const harness = createHarness({ shellIntegration: false });
  const executor = createVscodeOfficialLoginExecutor(harness.api, {
    shellIntegrationTimeoutMs: 5,
  });

  await assert.rejects(
    executor.run(layout),
    /shell integration/i,
  );
  assert.deepEqual(harness.commands, []);
  assert.equal(harness.disposeCalls, 1);
  assert.equal(harness.shellIntegrationListenerCount, 0);
});

test("does not lose Shell Integration readiness during listener registration", async () => {
  const controller = new AbortController();
  const harness = createHarness({
    shellIntegration: false,
    activateShellIntegrationDuringFirstCheck: true,
  });
  const executor = createVscodeOfficialLoginExecutor(harness.api, {
    shellIntegrationTimeoutMs: 20,
  });

  const result = await executor.run(layout, controller.signal);

  assert.deepEqual(result, { loginExitCode: 0, statusExitCode: 0 });
  assert.deepEqual(harness.commands, [
    ["codex", ["login"]],
    ["codex", ["login", "status"]],
  ]);
  assert.equal(harness.disposeCalls, 0);
  assert.equal(harness.shellIntegrationListenerCount, 0);
});

test("returns cancellation when abort races with Shell Integration listener registration", async () => {
  const controller = new AbortController();
  const harness = createHarness({ shellIntegration: false });
  const executor = createVscodeOfficialLoginExecutor(harness.api, {
    shellIntegrationTimeoutMs: 1_000,
  });

  const result = await executor.run(
    layout,
    abortAfterListenerRegistration(controller),
  );

  assert.deepEqual(result, {
    loginExitCode: undefined,
    statusExitCode: undefined,
    cancelled: true,
  });
  assert.equal(harness.disposeCalls, 1);
  assert.equal(harness.shellIntegrationListenerCount, 0);
  harness.fireShellIntegration();
  assert.deepEqual(harness.commands, []);
});

test("returns cancellation immediately when signal is aborted after listener registration", async () => {
  const controller = new AbortController();
  const harness = createHarness({ shellIntegration: false });
  const executor = createVscodeOfficialLoginExecutor(harness.api, {
    shellIntegrationTimeoutMs: 200,
  });

  const result = await executor.run(
    layout,
    abortAfterListenerRegistrationWithoutEvent(controller),
  );

  assert.deepEqual(result, {
    loginExitCode: undefined,
    statusExitCode: undefined,
    cancelled: true,
  });
  assert.equal(harness.disposeCalls, 1);
  assert.equal(harness.shellIntegrationListenerCount, 0);
});

test("returns an unknown exit code instead of treating it as success", async () => {
  const harness = createHarness({ exitCodes: [undefined, 0] });
  const executor = createVscodeOfficialLoginExecutor(harness.api);

  const result = await executor.run(layout);

  assert.deepEqual(result, {
    loginExitCode: undefined,
    statusExitCode: undefined,
  });
  assert.deepEqual(harness.commands, [["codex", ["login"]]]);
  assert.equal(harness.disposeCalls, 1);
});

test("disposes the terminal when login exits non-zero", async () => {
  const harness = createHarness({ exitCodes: [1, 0] });
  const executor = createVscodeOfficialLoginExecutor(harness.api);

  const result = await executor.run(layout);

  assert.deepEqual(result, { loginExitCode: 1, statusExitCode: undefined });
  assert.equal(harness.disposeCalls, 1);
});

test("disposes the terminal when status exits non-zero", async () => {
  const harness = createHarness({ exitCodes: [0, 1] });
  const executor = createVscodeOfficialLoginExecutor(harness.api);

  const result = await executor.run(layout);

  assert.deepEqual(result, { loginExitCode: 0, statusExitCode: 1 });
  assert.equal(harness.disposeCalls, 1);
});

test("disposes the terminal when status exit code is unknown", async () => {
  const harness = createHarness({ exitCodes: [0, undefined] });
  const executor = createVscodeOfficialLoginExecutor(harness.api);

  const result = await executor.run(layout);

  assert.deepEqual(result, { loginExitCode: 0, statusExitCode: undefined });
  assert.equal(harness.disposeCalls, 1);
});

test("ignores an end event for another execution", async () => {
  const harness = createHarness({ exitCodes: [0, 0], emitWrongExecutionFirst: true });
  const executor = createVscodeOfficialLoginExecutor(harness.api);

  const result = await executor.run(layout);

  assert.deepEqual(result, { loginExitCode: 0, statusExitCode: 0 });
  assert.equal(harness.endEventCount, 4);
});

test("interrupts the active command and returns cancellation", async () => {
  const controller = new AbortController();
  const harness = createHarness({ pendingFirstCommand: true });
  const executor = createVscodeOfficialLoginExecutor(harness.api, {
    cancellationTimeoutMs: 50,
  });
  const resultPromise = executor.run(layout, controller.signal);

  await harness.firstCommandStarted;
  controller.abort();
  const result = await resultPromise;

  assert.deepEqual(result, {
    loginExitCode: undefined,
    statusExitCode: undefined,
    cancelled: true,
  });
  assert.deepEqual(harness.sentText, [{ text: "\u0003", shouldExecute: false }]);
  assert.deepEqual(harness.commands, [["codex", ["login"]]]);
  assert.equal(harness.disposeCalls, 1);
});

test("sends one interrupt when abort happens during executeCommand", async () => {
  const controller = new AbortController();
  const harness = createHarness({
    abortDuringFirstCommand: () => controller.abort(),
  });
  const executor = createVscodeOfficialLoginExecutor(harness.api);

  const result = await executor.run(layout, controller.signal);

  assert.deepEqual(result, {
    loginExitCode: undefined,
    statusExitCode: undefined,
    cancelled: true,
  });
  assert.deepEqual(harness.sentText, [{ text: "\u0003", shouldExecute: false }]);
});

test("does not start a command when abort happens before executeCommand is called", async () => {
  const controller = new AbortController();
  const harness = createHarness({
    abortDuringCommandListenerRegistration: () => controller.abort(),
  });
  const executor = createVscodeOfficialLoginExecutor(harness.api);

  const result = await executor.run(
    layout,
    abortDuringCommandListenerRegistration(controller),
  );

  assert.deepEqual(result, {
    loginExitCode: undefined,
    statusExitCode: undefined,
    cancelled: true,
  });
  assert.deepEqual(harness.commands, []);
  assert.deepEqual(harness.sentText, []);
  assert.equal(harness.endListenerCount, 0);
  assert.equal(harness.disposeCalls, 1);
});

test("cleans up command resources when executeCommand throws synchronously", async () => {
  const controller = new AbortController();
  const failure = new Error("executeCommand failed");
  const harness = createHarness({
    abortDuringFirstCommand: () => controller.abort(),
    throwOnFirstCommand: failure,
  });
  const executor = createVscodeOfficialLoginExecutor(harness.api, {
    cancellationTimeoutMs: 50,
  });

  await assert.rejects(
    executor.run(layout, controller.signal),
    (error: unknown) => error === failure,
  );

  assert.equal(harness.endListenerCount, 0);
  assert.equal(harness.disposeCalls, 1);
  assert.deepEqual(harness.sentText, [{ text: "\u0003", shouldExecute: false }]);
});

interface HarnessOptions {
  shellIntegration?: boolean;
  activateShellIntegrationDuringFirstCheck?: boolean;
  exitCodes?: Array<number | undefined>;
  emitWrongExecutionFirst?: boolean;
  pendingFirstCommand?: boolean;
  abortDuringFirstCommand?: () => void;
  abortDuringCommandListenerRegistration?: () => void;
  throwOnFirstCommand?: Error;
}

function createHarness(options: HarnessOptions = {}) {
  const shellEvent = new TestEvent<{ terminal: FakeTerminal; shellIntegration: FakeShell }>();
  const endEvent = new TestEvent<{ execution: FakeExecution; exitCode: number | undefined }>();
  const commands: Array<[string, string[]]> = [];
  const sentText: Array<{ text: string; shouldExecute: boolean | undefined }> = [];
  const exitCodes = [...(options.exitCodes ?? [0, 0])];
  let executionId = 0;
  let endEventCount = 0;
  let firstCommandResolve!: () => void;
  const firstCommandStarted = new Promise<void>((resolve) => {
    firstCommandResolve = resolve;
  });
  let cancellationEndEventPending = false;

  const shell: FakeShell = {
    executeCommand(executable, args) {
      const execution = { id: ++executionId };
      commands.push([executable, [...args]]);
      if (commands.length === 1) {
        firstCommandResolve();
        options.abortDuringFirstCommand?.();
        if (options.throwOnFirstCommand) {
          throw options.throwOnFirstCommand;
        }
      }
      if (cancellationEndEventPending && commands.length === 1) {
        cancellationEndEventPending = false;
        queueMicrotask(() => endEvent.fire({ execution, exitCode: undefined }));
        return execution;
      }
      if (options.pendingFirstCommand && commands.length === 1) {
        return execution;
      }
      queueMicrotask(() => {
        if (options.emitWrongExecutionFirst) {
          endEventCount += 1;
          endEvent.fire({ execution: { id: -execution.id }, exitCode: 99 });
        }
        endEventCount += 1;
        endEvent.fire({ execution, exitCode: exitCodes.shift() });
      });
      return execution;
    },
  };
  let activeShellIntegration = options.shellIntegration === undefined || options.shellIntegration
    ? shell
    : undefined;
  let shellIntegrationReads = 0;
  const terminal: FakeTerminal = {
    shellIntegration: activeShellIntegration,
    showCalls: 0,
    show() {
      this.showCalls += 1;
    },
    sendText(text, shouldExecute) {
      sentText.push({ text, shouldExecute });
      if (options.pendingFirstCommand) {
        cancellationEndEventPending = true;
      }
    },
    dispose() {
      disposeCalls += 1;
    },
  };
  Object.defineProperty(terminal, "shellIntegration", {
    get() {
      shellIntegrationReads += 1;
      if (options.activateShellIntegrationDuringFirstCheck && shellIntegrationReads === 1) {
        const integrationBeforeRead = activeShellIntegration;
        activeShellIntegration = shell;
        shellEvent.fire({ terminal, shellIntegration: shell });
        return integrationBeforeRead;
      }
      return activeShellIntegration;
    },
  });
  let disposeCalls = 0;
  let terminalOptions: unknown;
  const api: OfficialLoginTerminalApi = {
    createTerminal(options) {
      terminalOptions = options;
      return terminal;
    },
    onDidChangeTerminalShellIntegration: (listener) => shellEvent.subscribe(listener),
    onDidEndTerminalShellExecution: (listener) => endEvent.subscribe(listener),
  };

  return {
    api,
    commands,
    firstCommandStarted,
    sentText,
    fireShellIntegration() {
      shellEvent.fire({ terminal, shellIntegration: shell });
    },
    get disposeCalls() {
      return disposeCalls;
    },
    get endListenerCount() {
      return endEvent.listenerCount;
    },
    get endEventCount() {
      return endEventCount;
    },
    get shellIntegrationListenerCount() {
      return shellEvent.listenerCount;
    },
    get terminalOptions() {
      return terminalOptions;
    },
    get showCalls() {
      return terminal.showCalls;
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
  shellIntegration: FakeShell | undefined;
  showCalls: number;
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

function abortAfterListenerRegistration(controller: AbortController): AbortSignal {
  const signal = Object.create(controller.signal) as AbortSignal;
  Object.defineProperty(signal, "aborted", {
    get: () => controller.signal.aborted,
  });
  signal.addEventListener = (type, listener, options) => {
    controller.signal.addEventListener(type, listener, options);
    controller.abort();
  };
  signal.removeEventListener = (type, listener, options) => {
    controller.signal.removeEventListener(type, listener, options);
  };
  return signal;
}

function abortAfterListenerRegistrationWithoutEvent(controller: AbortController): AbortSignal {
  const signal = Object.create(controller.signal) as AbortSignal;
  let listenerRegistered = false;
  Object.defineProperty(signal, "aborted", {
    get: () => listenerRegistered || controller.signal.aborted,
  });
  signal.addEventListener = () => {
    listenerRegistered = true;
  };
  signal.removeEventListener = () => undefined;
  return signal;
}

function abortDuringCommandListenerRegistration(controller: AbortController): AbortSignal {
  const signal = Object.create(controller.signal) as AbortSignal;
  signal.addEventListener = (type, listener, options) => {
    controller.signal.addEventListener(type, listener, options);
    controller.abort();
  };
  signal.removeEventListener = (type, listener, options) => {
    controller.signal.removeEventListener(type, listener, options);
  };
  return signal;
}
