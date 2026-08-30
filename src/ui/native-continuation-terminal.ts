import type { InteractiveCodexTerminal, TerminalInvocation } from "../core/continuation";
import type { CodexLayout } from "../core/types";
import {
  forkNativeCodexThread as defaultForkNativeCodexThread,
  type ForkNativeCodexThreadInput,
} from "./app-server-fork";

const terminalArgumentPattern = /^[A-Za-z0-9._/-]+$/;
const sessionIdentifierPattern = /^[A-Za-z0-9._-]+$/;

export interface NativeContinuationTerminal {
  show(preserveFocus?: boolean): void;
  sendText(text: string, shouldExecute?: boolean): void;
}

export interface NativeContinuationTerminalOptions {
  readonly name: string;
  readonly cwd: string;
  readonly env: { readonly CODEX_HOME: string };
}

export interface NativeContinuationTerminalApi {
  createTerminal(options: NativeContinuationTerminalOptions): NativeContinuationTerminal;
}

export type NativeForkClient = (
  input: Pick<ForkNativeCodexThreadInput, "sourceSessionId" | "codexHome">,
) => Promise<string>;

export interface NativeContinuationTerminalDependencies {
  readonly forkNativeCodexThread?: NativeForkClient;
}

export function createNativeContinuationTerminal(
  api: NativeContinuationTerminalApi,
  layout: CodexLayout,
  dependencies: NativeContinuationTerminalDependencies = {},
): InteractiveCodexTerminal {
  const forkNativeCodexThread = dependencies.forkNativeCodexThread ?? defaultForkNativeCodexThread;

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
      terminal.show(true);
      terminal.sendText([invocation.command, ...invocation.args].join(" "), true);
      return { exitCode: 0 };
    },
  };
}

function assertSafeInvocation(invocation: TerminalInvocation): void {
  if (
    invocation.shell !== false ||
    invocation.title.trim().length === 0 ||
    !terminalArgumentPattern.test(invocation.command) ||
    invocation.args.length === 0 ||
    invocation.args.some((argument) => !terminalArgumentPattern.test(argument))
  ) {
    throw new Error("The requested terminal invocation is unsafe.");
  }
  if (
    invocation.args[0] === "fork" &&
    (invocation.args.length !== 2 || !sessionIdentifierPattern.test(invocation.args[1]))
  ) {
    throw new Error("The requested native fork invocation is invalid.");
  }
}

function forkSourceSessionId(invocation: TerminalInvocation): string | undefined {
  return invocation.args[0] === "fork" ? invocation.args[1] : undefined;
}
