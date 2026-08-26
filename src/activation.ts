import type * as vscode from "vscode";
import { UnsupportedHostError } from "./core/codex-home";
import {
  removeActiveCustomAuth,
  writeActiveCustomAuth,
} from "./core/config";
import { profileApiKeySecretId } from "./core/profiles";
import { UnsupportedSecretStorageError } from "./core/secrets";
import type {
  StartupExtensionContext,
  StartupHostInputs,
  StartupProfilePrerequisites,
} from "./core/startup";
import type {
  RecoveryDependencies,
  RecoveryResult,
} from "./core/transaction";

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

export type StartupRecovery = (
  layout: StartupProfilePrerequisites["layout"],
  dependencies: RecoveryDependencies,
) => Promise<Pick<RecoveryResult, "recoveryRequiredOperationIds">>;

const startupRecoveryWarning =
  "Codex Provider Switcher could not safely complete startup recovery. Provider switching commands are disabled.";

let startupProfilePrerequisites: StartupProfilePrerequisites | undefined;

export async function activateExtensionWithStartupPrerequisites(
  context: ExtensionActivationContext,
  host: StartupHostInputs,
  api: ExtensionHostApi,
  createPrerequisites: StartupPrerequisiteFactory,
  recover: StartupRecovery,
): Promise<void> {
  startupProfilePrerequisites = undefined;
  try {
    startupProfilePrerequisites = createPrerequisites(context, host);
  } catch (error: unknown) {
    if (!isExpectedStartupPrerequisiteError(error)) {
      throw error;
    }
  }
  if (startupProfilePrerequisites) {
    try {
      const recovery = await recover(startupProfilePrerequisites.layout, {
        restoreAuthMode: createStartupAuthModeRestorer(
          startupProfilePrerequisites,
        ),
      });
      if (recovery.recoveryRequiredOperationIds.length > 0) {
        await api.window.showWarningMessage(startupRecoveryWarning);
        return;
      }
    } catch {
      await api.window.showWarningMessage(startupRecoveryWarning);
      return;
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

function createStartupAuthModeRestorer(
  prerequisites: StartupProfilePrerequisites,
): NonNullable<RecoveryDependencies["restoreAuthMode"]> {
  return async (target) => {
    if (target.previousMode === "official") {
      await removeActiveCustomAuth(prerequisites.layout);
      return;
    }

    if (!target.customProfileId) {
      throw new Error("The previous custom authentication is unavailable.");
    }
    const profile = await prerequisites.profiles.get(target.customProfileId);
    if (!profile || profile.kind !== "custom") {
      throw new Error("The previous custom authentication is unavailable.");
    }
    const secretId =
      profile.apiKeySecretId ?? profileApiKeySecretId(profile.id);
    const apiKey = await prerequisites.secrets.get(secretId);
    if (apiKey === undefined) {
      throw new Error("The previous custom authentication is unavailable.");
    }
    await writeActiveCustomAuth(prerequisites.layout, apiKey);
  };
}
