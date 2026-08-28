import type * as vscode from "vscode";
import { ActiveProfileStore } from "./core/active-profile";
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
import {
  createProfileCommandHandlers,
  createVscodeProfileCommandUi,
  type ProfileCommandHandlers,
} from "./ui/commands";
import type { ActiveProfileState, ProfileLookup } from "./core/profile-switch-orchestrator";

export const commandIds = [
  "codexProvider.createProfile",
  "codexProvider.editProfile",
  "codexProvider.switchProfile",
  "codexProvider.syncSessions",
  "codexProvider.continueSession",
  "codexProvider.restoreBackup",
] as const;

export const commandAvailabilityContextKey = "codexProvider.commandsAvailable";

export type ExtensionHostApi = Pick<
  typeof vscode,
  "commands" | "window" | "StatusBarAlignment" | "ProgressLocation"
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

type CommandId = typeof commandIds[number];
type ExtensionCommandHandlers = Partial<Record<CommandId, () => Promise<void>>>;

export interface ExtensionLifecycleOptions {
  readonly createCommandHandlers?: (
    refreshStatus: () => Promise<void>,
  ) => ExtensionCommandHandlers;
  readonly getStatusText?: () => Promise<string>;
}

export interface ExtensionLifecycleRegistration {
  refreshStatus(): Promise<void>;
  dispose(): void;
}

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
  await api.commands.executeCommand("setContext", commandAvailabilityContextKey, false);
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
  if (!startupProfilePrerequisites) {
    registerExtensionLifecycle(context, api);
    return;
  }

  const prerequisites = startupProfilePrerequisites;
  const activeProfiles = new ActiveProfileStore(prerequisites.layout);
  const lifecycle = registerExtensionLifecycle(context, api, {
    getStatusText: createActiveProfileStatusText(
      activeProfiles,
      prerequisites.profiles,
    ),
    createCommandHandlers: (refresh) => toExtensionCommandHandlers(
      createProfileCommandHandlers({
        layout: prerequisites.layout,
        profiles: prerequisites.profiles,
        secrets: prerequisites.secrets,
        activeProfiles,
        ui: createVscodeProfileCommandUi(api),
        restoreAuthMode: createStartupAuthModeRestorer(prerequisites),
        refreshStatus: refresh,
      }),
    ),
  });
  await lifecycle.refreshStatus();
  try {
    await api.commands.executeCommand("setContext", commandAvailabilityContextKey, true);
  } catch (error) {
    lifecycle.dispose();
    try {
      await api.commands.executeCommand("setContext", commandAvailabilityContextKey, false);
    } catch {
      // Preserve the failed availability publication as the activation error.
    }
    throw error;
  }
}

export function getStartupProfilePrerequisites():
  | StartupProfilePrerequisites
  | undefined {
  return startupProfilePrerequisites;
}

export function registerExtensionLifecycle(
  context: Pick<vscode.ExtensionContext, "subscriptions">,
  api: ExtensionHostApi,
  options: ExtensionLifecycleOptions = {},
): ExtensionLifecycleRegistration {
  const initialSubscriptionCount = context.subscriptions.length;
  let statusBarItem: vscode.StatusBarItem | undefined;
  const dispose = (): void => {
    if (statusBarItem) {
      statusBarItem.command = undefined;
      statusBarItem.tooltip = "Codex Provider Switcher is unavailable.";
    }
    const createdDisposables = context.subscriptions.splice(initialSubscriptionCount);
    for (const disposable of createdDisposables) {
      try {
        disposable.dispose();
      } catch {
        // Preserve the primary activation failure while disposing every created value.
      }
    }
  };
  try {
    const refreshStatus = async (): Promise<void> => {
      let text = "$(account) Codex";
      try {
        text = await options.getStatusText?.() ?? text;
      } catch {
        // Profile state is advisory and must not expose storage errors.
      }
      if (statusBarItem) {
        statusBarItem.text = text;
      }
    };
    const handlers = options.createCommandHandlers?.(refreshStatus);
    const hasSwitchHandler = handlers?.["codexProvider.switchProfile"] !== undefined;
    for (const commandId of commandIds) {
      const handler = handlers?.[commandId];
      if (handler) {
        context.subscriptions.push(api.commands.registerCommand(commandId, handler));
      }
    }
    statusBarItem = api.window.createStatusBarItem(
      api.StatusBarAlignment.Left,
      100,
    );
    context.subscriptions.push(statusBarItem);
    statusBarItem.text = "$(account) Codex";
    statusBarItem.command = hasSwitchHandler ? "codexProvider.switchProfile" : undefined;
    statusBarItem.tooltip = hasSwitchHandler
      ? "Codex Provider Switcher"
      : "Codex Provider Switcher is unavailable.";
    statusBarItem.show();
    return { refreshStatus, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

function toExtensionCommandHandlers(
  handlers: ProfileCommandHandlers,
): ExtensionCommandHandlers {
  return {
    "codexProvider.createProfile": handlers.createProfile,
    "codexProvider.editProfile": handlers.editProfile,
    "codexProvider.switchProfile": handlers.switchProfile,
    "codexProvider.syncSessions": handlers.syncSessions,
    "codexProvider.continueSession": handlers.continueSession,
    "codexProvider.restoreBackup": handlers.restoreBackup,
  };
}

function createActiveProfileStatusText(
  activeProfiles: ActiveProfileState,
  profiles: ProfileLookup,
): () => Promise<string> {
  return async () => {
    const snapshot = await activeProfiles.snapshot();
    if (snapshot.state !== "present") {
      return "$(account) Codex";
    }
    const profile = await profiles.get(snapshot.record.profileId);
    return profile ? `$(account) Codex: ${profile.name}` : "$(account) Codex";
  };
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
