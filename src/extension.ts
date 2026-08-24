import * as vscode from "vscode";

const commandIds = [
  "codexProvider.createProfile",
  "codexProvider.switchProfile",
  "codexProvider.syncSessions",
  "codexProvider.continueSession",
  "codexProvider.restoreBackup",
] as const;

export function activate(context: vscode.ExtensionContext): void {
  const registrations = commandIds.map((commandId) =>
    vscode.commands.registerCommand(commandId, () => undefined),
  );

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarItem.text = "$(account) Codex";
  statusBarItem.command = "codexProvider.switchProfile";
  statusBarItem.tooltip = "Codex Provider Switcher";
  statusBarItem.show();

  context.subscriptions.push(statusBarItem, ...registrations);
}
