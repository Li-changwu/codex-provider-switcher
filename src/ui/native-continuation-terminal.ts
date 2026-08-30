import type { InteractiveCodexTerminal, TerminalInvocation } from "../core/continuation";
import type { CodexLayout } from "../core/types";
import {
  forkNativeCodexThread as defaultForkNativeCodexThread,
  type ForkNativeCodexThreadInput,
} from "./app-server-fork";

const terminalArgumentPattern = /^[A-Za-z0-9._/-]+$/;
const defaultShellIntegrationTimeoutMs = 30_000;
const defaultShellCommandTimeoutMs = 30_000;
const maximumShellTimeoutMs = 60_000;
const sessionIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const nativeCodexCommand = "codex";
const terminalOperations = new Set(["resume", "archive", "unarchive"]);

export interface NativeContinuationTerminal {
  readonly shellIntegration: NativeContinuationShellIntegration | undefined;
  show(preserveFocus?: boolean): void;
  sendText(text: string, shouldExecute?: boolean): void;
  dispose(): void;
}

export interface NativeContinuationDisposable {
  dispose(): void;
}

export type NativeContinuationEvent<Event> = (
  listener: (event: Event) => void,
) => NativeContinuationDisposable;

export interface NativeContinuationShellExecution {}

export interface NativeContinuationShellIntegration {
  executeCommand(executable: string, args: string[]): NativeContinuationShellExecution;
}

export interface NativeContinuationTerminalOptions {
  readonly name: string;
  readonly cwd: string;
  readonly env: { readonly CODEX_HOME: string };
}

export interface NativeContinuationTerminalApi {
  createTerminal(options: NativeContinuationTerminalOptions): NativeContinuationTerminal;
  onDidChangeTerminalShellIntegration: NativeContinuationEvent<NativeContinuationShellIntegrationChangeEvent>;
  onDidEndTerminalShellExecution: NativeContinuationEvent<NativeContinuationShellExecutionEndEvent>;
}

export interface NativeContinuationShellIntegrationChangeEvent {
  readonly terminal: NativeContinuationTerminal;
  readonly shellIntegration: NativeContinuationShellIntegration;
}

export interface NativeContinuationShellExecutionEndEvent {
  readonly execution: NativeContinuationShellExecution;
  readonly exitCode: number | undefined;
}

export type NativeForkClient = (
  input: Pick<ForkNativeCodexThreadInput, "sourceSessionId" | "codexHome">,
) => Promise<string>;

export interface NativeContinuationTerminalDependencies {
  readonly forkNativeCodexThread?: NativeForkClient;
  readonly shellIntegrationTimeoutMs?: number;
  readonly shellCommandTimeoutMs?: number;
}

export function createNativeContinuationTerminal(
  api: NativeContinuationTerminalApi,
  layout: CodexLayout,
  dependencies: NativeContinuationTerminalDependencies = {},
): InteractiveCodexTerminal {
  const forkNativeCodexThread = dependencies.forkNativeCodexThread ?? defaultForkNativeCodexThread;
  const shellIntegrationTimeoutMs = validatedTimeout(
    dependencies.shellIntegrationTimeoutMs,
    defaultShellIntegrationTimeoutMs,
    "Shell Integration",
  );
  const shellCommandTimeoutMs = validatedTimeout(
    dependencies.shellCommandTimeoutMs,
    defaultShellCommandTimeoutMs,
    "Shell command",
  );

  return {
    reportsForkOutcome: true,
    launch: async (invocation) => {
      assertSafeInvocation(invocation);
      const sourceSessionId = forkSourceSessionId(invocation);
      if (sourceSessionId) {
        const branchSessionId = await forkNativeCodexThread({
          sourceSessionId,
          codexHome: layout.codexHome,
        });
        return { exitCode: 0, branchSessionId };
      }

      const terminal = api.createTerminal({
        name: invocation.title,
        cwd: layout.codexHome,
        env: { CODEX_HOME: layout.codexHome },
      });
      if (invocation.args[0] === "resume") {
        try {
          terminal.show(true);
          terminal.sendText([invocation.command, ...invocation.args].join(" "), true);
          return {};
        } catch (error: unknown) {
          terminal.dispose();
          throw error;
        }
      }
      const archiveAction: "archive" | "unarchive" = invocation.args[0] === "archive"
        ? "archive"
        : "unarchive";
      try {
        terminal.show(true);
        const shellIntegration = await waitForShellIntegration(
          api,
          terminal,
          shellIntegrationTimeoutMs,
        );
        const result = await executeTerminalCommand(
          api,
          shellIntegration,
          [archiveAction, invocation.args[1]],
          shellCommandTimeoutMs,
        );
        return result;
      } catch (error: unknown) {
        throw error;
      } finally {
        terminal.dispose();
      }
    },
  };
}

function validatedTimeout(
  injectedTimeoutMs: number | undefined,
  defaultTimeoutMs: number,
  timeoutName: string,
): number {
  const timeoutMs = injectedTimeoutMs === undefined ? defaultTimeoutMs : injectedTimeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > maximumShellTimeoutMs
  ) {
    throw new Error(`${timeoutName} timeout must be a positive safe integer no greater than ${maximumShellTimeoutMs}ms.`);
  }
  return timeoutMs;
}

async function waitForShellIntegration(
  api: NativeContinuationTerminalApi,
  terminal: NativeContinuationTerminal,
  timeoutMs: number,
): Promise<NativeContinuationShellIntegration> {
  if (terminal.shellIntegration) {
    return terminal.shellIntegration;
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const integrationSubscription = api.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal !== terminal || settled) {
        return;
      }
      settle(() => resolve(event.shellIntegration));
    });
    const currentShellIntegration = terminal.shellIntegration;
    if (currentShellIntegration) {
      settle(() => resolve(currentShellIntegration));
      return;
    }
    timer = setTimeout(() => {
      settle(() => reject(new Error(
        "Native Codex archive commands require terminal shell integration.",
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
      action();
    }
  });
}

async function executeTerminalCommand(
  api: NativeContinuationTerminalApi,
  shellIntegration: NativeContinuationShellIntegration,
  args: ["archive" | "unarchive", string],
  timeoutMs: number,
): Promise<{ readonly exitCode: number }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let execution: NativeContinuationShellExecution | undefined;
    const earlyEndEvents: NativeContinuationShellExecutionEndEvent[] = [];
    const endSubscription = api.onDidEndTerminalShellExecution((event) => {
      if (settled) {
        return;
      }
      if (!execution) {
        earlyEndEvents.push(event);
        return;
      }
      if (event.execution === execution) {
        settle(event.exitCode);
      }
    });
    try {
      execution = shellIntegration.executeCommand(nativeCodexCommand, args);
      timer = setTimeout(() => {
        settleError(new Error("The native Codex terminal command timed out."));
      }, timeoutMs);
      for (const event of earlyEndEvents) {
        if (event.execution === execution) {
          settle(event.exitCode);
          break;
        }
      }
    } catch (error: unknown) {
      settleError(error);
    }

    function settle(exitCode: number | undefined): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      endSubscription.dispose();
      if (exitCode === undefined) {
        reject(new Error("The native Codex archive command did not report an exit code."));
        return;
      }
      resolve({ exitCode });
    }

    function settleError(error: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      endSubscription.dispose();
      reject(error);
    }
  });
}

function assertSafeInvocation(invocation: TerminalInvocation): void {
  if (
    invocation.shell !== false ||
    invocation.title.trim().length === 0 ||
    invocation.command !== nativeCodexCommand ||
    !terminalArgumentPattern.test(invocation.command) ||
    invocation.args.length !== 2 ||
    invocation.args.some((argument) => !terminalArgumentPattern.test(argument)) ||
    !sessionIdentifierPattern.test(invocation.args[1])
  ) {
    throw new Error("The requested terminal invocation is unsafe.");
  }
  if (invocation.args[0] === "fork" || terminalOperations.has(invocation.args[0])) {
    return;
  }
  throw new Error("The requested terminal invocation is unsafe.");
}

function forkSourceSessionId(invocation: TerminalInvocation): string | undefined {
  return invocation.args[0] === "fork" ? invocation.args[1] : undefined;
}
