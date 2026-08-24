import type * as vscode from "vscode";

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
