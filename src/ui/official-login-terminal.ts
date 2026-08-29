import type {
  OfficialLoginExecutor,
  OfficialLoginResult,
} from "../core/official-login";
import type { CodexLayout } from "../core/types";

const defaultShellIntegrationTimeoutMs = 30_000;
const defaultCancellationTimeoutMs = 2_000;

export interface OfficialLoginDisposable {
  dispose(): void;
}

export type OfficialLoginEvent<Event> = (
  listener: (event: Event) => void,
) => OfficialLoginDisposable;

export interface OfficialLoginShellExecution {}

export interface OfficialLoginShellIntegration {
  executeCommand(
    executable: string,
    args: string[],
  ): OfficialLoginShellExecution;
}

export interface OfficialLoginTerminal {
  readonly shellIntegration: OfficialLoginShellIntegration | undefined;
  show(preserveFocus?: boolean): void;
  sendText(text: string, shouldExecute?: boolean): void;
  dispose(): void;
}

export interface OfficialLoginTerminalOptions {
  readonly name: string;
  readonly cwd: string;
  readonly env: { readonly CODEX_HOME: string };
}

export interface OfficialLoginShellIntegrationChangeEvent {
  readonly terminal: OfficialLoginTerminal;
  readonly shellIntegration: OfficialLoginShellIntegration;
}

export interface OfficialLoginShellExecutionEndEvent {
  readonly execution: OfficialLoginShellExecution;
  readonly exitCode: number | undefined;
}

export interface OfficialLoginTerminalApi {
  createTerminal(options: OfficialLoginTerminalOptions): OfficialLoginTerminal;
  onDidChangeTerminalShellIntegration: OfficialLoginEvent<OfficialLoginShellIntegrationChangeEvent>;
  onDidEndTerminalShellExecution: OfficialLoginEvent<OfficialLoginShellExecutionEndEvent>;
}

export interface OfficialLoginTerminalTimingOptions {
  readonly shellIntegrationTimeoutMs?: number;
  readonly cancellationTimeoutMs?: number;
}

interface CommandResult {
  readonly exitCode: number | undefined;
  readonly cancelled: boolean;
}

export function createVscodeOfficialLoginExecutor(
  api: OfficialLoginTerminalApi,
  options: OfficialLoginTerminalTimingOptions = {},
): OfficialLoginExecutor {
  const shellIntegrationTimeoutMs = options.shellIntegrationTimeoutMs
    ?? defaultShellIntegrationTimeoutMs;
  const cancellationTimeoutMs = options.cancellationTimeoutMs
    ?? defaultCancellationTimeoutMs;

  return {
    run: async (layout, signal) => {
      if (signal?.aborted) {
        return cancelledResult();
      }

      const terminal = api.createTerminal({
        name: "Codex: Official Login",
        cwd: layout.codexHome,
        env: { CODEX_HOME: layout.codexHome },
      });
      terminal.show(true);

      const shellIntegration = await waitForShellIntegration(
        api,
        terminal,
        signal,
        shellIntegrationTimeoutMs,
      );
      if (shellIntegration.cancelled) {
        return cancelledResult();
      }

      const login = await executeCommand(
        api,
        terminal,
        shellIntegration.value,
        ["login"],
        signal,
        cancellationTimeoutMs,
      );
      if (login.cancelled) {
        return cancelledResult();
      }
      if (login.exitCode !== 0) {
        return {
          loginExitCode: login.exitCode,
          statusExitCode: undefined,
        };
      }

      const status = await executeCommand(
        api,
        terminal,
        shellIntegration.value,
        ["login", "status"],
        signal,
        cancellationTimeoutMs,
      );
      if (status.cancelled) {
        return cancelledResult();
      }
      return {
        loginExitCode: login.exitCode,
        statusExitCode: status.exitCode,
      };
    },
  };
}

function cancelledResult(): OfficialLoginResult {
  return {
    loginExitCode: undefined,
    statusExitCode: undefined,
    cancelled: true,
  };
}

async function waitForShellIntegration(
  api: OfficialLoginTerminalApi,
  terminal: OfficialLoginTerminal,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<
  | { readonly value: OfficialLoginShellIntegration; readonly cancelled: false }
  | { readonly cancelled: true }
> {
  if (terminal.shellIntegration) {
    return { value: terminal.shellIntegration, cancelled: false };
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const integrationSubscription = api.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal !== terminal || settled) {
        return;
      }
      settle(() => resolve({ value: event.shellIntegration, cancelled: false }));
    });
    const abort = (): void => {
      if (settled) {
        return;
      }
      terminal.dispose();
      settle(() => resolve({ cancelled: true }));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    timer = setTimeout(() => {
      terminal.dispose();
      settle(() => reject(new Error(
        "Official Codex login requires terminal shell integration.",
      )));
    }, timeoutMs);

    function settle(action: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      integrationSubscription.dispose();
      signal?.removeEventListener("abort", abort);
      action();
    }
  });
}

async function executeCommand(
  api: OfficialLoginTerminalApi,
  terminal: OfficialLoginTerminal,
  shellIntegration: OfficialLoginShellIntegration,
  args: string[],
  signal: AbortSignal | undefined,
  cancellationTimeoutMs: number,
): Promise<CommandResult> {
  if (signal?.aborted) {
    terminal.dispose();
    return { exitCode: undefined, cancelled: true };
  }

  return await new Promise((resolve, reject) => {
    let execution: OfficialLoginShellExecution | undefined;
    let settled = false;
    let abortRequested = false;
    let commandInvocationStarted = false;
    let terminalDisposed = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const endSubscription = api.onDidEndTerminalShellExecution((event) => {
      if (event.execution !== execution || settled) {
        return;
      }
      settle({
        exitCode: event.exitCode,
        cancelled: signal?.aborted === true,
      });
    });
    const abort = (): void => {
      if (settled || abortRequested) {
        return;
      }
      abortRequested = true;
      if (!commandInvocationStarted) {
        disposeTerminal();
        settle({ exitCode: undefined, cancelled: true });
        return;
      }
      terminal.sendText("\u0003", false);
      abortTimer = setTimeout(() => {
        disposeTerminal();
        settle({ exitCode: undefined, cancelled: true });
      }, cancellationTimeoutMs);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (settled || signal?.aborted) {
        abort();
        return;
      }
      commandInvocationStarted = true;
      execution = shellIntegration.executeCommand("codex", args);
    } catch (error) {
      disposeTerminal();
      settleError(error);
    }

    function settle(result: CommandResult): void {
      if (settled) {
        return;
      }
      settled = true;
      if (abortTimer) {
        clearTimeout(abortTimer);
      }
      endSubscription.dispose();
      signal?.removeEventListener("abort", abort);
      if (result.cancelled) {
        disposeTerminal();
      }
      resolve(result);
    }

    function settleError(error: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      if (abortTimer !== undefined) {
        clearTimeout(abortTimer);
      }
      endSubscription.dispose();
      signal?.removeEventListener("abort", abort);
      reject(error);
    }

    function disposeTerminal(): void {
      if (terminalDisposed) {
        return;
      }
      terminalDisposed = true;
      terminal.dispose();
    }
  });
}
