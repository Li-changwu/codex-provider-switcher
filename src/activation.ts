import type * as vscode from "vscode";
import { UnsupportedHostError } from "./core/codex-home";
import { UnsupportedSecretStorageError } from "./core/secrets";
import type {
  StartupExtensionContext,
  StartupHostInputs,
  StartupProfilePrerequisites,
} from "./core/startup";

export const commandIds = [
  "codexProvider.createProfile",
  "codexProvider.switchProfile",
  "codexProvider.syncSessions",
  "codexProvider.continueSession",
  "codexProvider.restoreBackup",
] as const;

export type ExtensionHostApi = Pick<
  typeof vscode,
  "commands" | "window" | "StatusBarAlignment"
>;

export interface ExtensionActivationContext extends StartupExtensionContext {
  subscriptions: Array<{ dispose(): unknown }>;
}

export type StartupPrerequisiteFactory = (
  context: StartupExtensionContext,
  host: StartupHostInputs,
) => StartupProfilePrerequisites;

let startupProfilePrerequisites: StartupProfilePrerequisites | undefined;

export function activateExtensionWithStartupPrerequisites(
  context: ExtensionActivationContext,
  host: StartupHostInputs,
  api: ExtensionHostApi,
  createPrerequisites: StartupPrerequisiteFactory,
): void {
  startupProfilePrerequisites = undefined;
  try {
    startupProfilePrerequisites = createPrerequisites(context, host);
  } catch (error: unknown) {
    if (!isExpectedStartupPrerequisiteError(error)) {
      throw error;
    }
  }
  registerExtensionLifecycle(context, api);
}

export function getStartupProfilePrerequisites():
  | StartupProfilePrerequisites
  | undefined {
  return startupProfilePrerequisites;
}

export function registerExtensionLifecycle(
  context: Pick<vscode.ExtensionContext, "subscriptions">,
  api: ExtensionHostApi,
): void {
  const initialSubscriptionCount = context.subscriptions.length;
  try {
    for (const commandId of commandIds) {
      context.subscriptions.push(api.commands.registerCommand(commandId, () => undefined));
    }
    const statusBarItem = api.window.createStatusBarItem(
      api.StatusBarAlignment.Left,
      100,
    );
    context.subscriptions.push(statusBarItem);
    statusBarItem.text = "$(account) Codex";
    statusBarItem.command = "codexProvider.switchProfile";
    statusBarItem.tooltip = "Codex Provider Switcher";
    statusBarItem.show();
  } catch (error) {
    const createdDisposables = context.subscriptions.splice(initialSubscriptionCount);
    for (const disposable of createdDisposables) {
      try {
        disposable.dispose();
      } catch {
        // Preserve the activation failure while disposing every created value.
      }
    }
    throw error;
  }
}

function isExpectedStartupPrerequisiteError(error: unknown): boolean {
  return (
    error instanceof UnsupportedHostError ||
    error instanceof UnsupportedSecretStorageError
  );
}
