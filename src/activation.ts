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
import { switchStoredProfile as switchStoredProfileByDefault } from "./core/profile-switch-orchestrator";
import { continueSession as continueStoredSession } from "./core/continuation";
import { listContinuationSourceAnchors } from "./core/rollouts";
import { createVscodeOfficialLoginExecutor } from "./ui/official-login-terminal";
import { createNativeContinuationTerminal } from "./ui/native-continuation-terminal";
import { ProviderTreeDataProvider } from "./ui/provider-tree";
import { ProviderWorkbenchController } from "./ui/provider-workbench";
import { ProviderWorkbenchPanel } from "./ui/provider-webview";

export const commandIds = [
  "codexProvider.openWorkbench",
  "codexProvider.addProvider",
  "codexProvider.refreshProviders",
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
  "commands" | "window" | "StatusBarAlignment" | "ProgressLocation" | "ViewColumn"
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
type ExtensionCommandHandlers = Partial<Record<CommandId, (...args: any[]) => Promise<void>>>;

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
  const officialLogin = createVscodeOfficialLoginExecutor({
    createTerminal: (options) => api.window.createTerminal(options),
    onDidChangeTerminalShellIntegration:
      api.window.onDidChangeTerminalShellIntegration,
    onDidEndTerminalShellExecution:
      api.window.onDidEndTerminalShellExecution,
  });
  const nativeContinuationTerminal = createNativeContinuationTerminal({
    createTerminal: (options) => api.window.createTerminal(options),
    onDidChangeTerminalShellIntegration:
      api.window.onDidChangeTerminalShellIntegration,
    onDidEndTerminalShellExecution:
      api.window.onDidEndTerminalShellExecution,
  }, prerequisites.layout);
  const tree = new ProviderTreeDataProvider({
    listProfiles: () => prerequisites.profiles.list(),
    activeProfileId: async () => {
      const snapshot = await activeProfiles.snapshot();
      return snapshot.state === "present" ? snapshot.record.profileId : undefined;
    },
  });
  let lifecycle: ExtensionLifecycleRegistration;
  let panel: ProviderWorkbenchPanel | undefined;
  const refreshProviderUi = async (): Promise<void> => {
    tree.refresh();
    panel?.refresh();
    await lifecycle?.refreshStatus();
  };
  const controller = new ProviderWorkbenchController({
    profiles: prerequisites.profiles,
    secrets: prerequisites.secrets,
    activeProfileId: async () => {
      const snapshot = await activeProfiles.snapshot();
      return snapshot.state === "present" ? snapshot.record.profileId : undefined;
    },
    switchProfile: async (profileId, onProgress) => switchStoredProfileByDefault(
      { targetProfileId: profileId },
      {
        layout: prerequisites.layout,
        profiles: prerequisites.profiles,
        secrets: prerequisites.secrets,
        activeProfiles,
        officialLogin,
        onProgress: (event) => onProgress?.(event),
      },
    ),
    listSessionAnchors: () => listContinuationSourceAnchors(prerequisites.layout),
    continueSession: async (request) => continueStoredSession({
      layout: prerequisites.layout,
      sessionId: request.sessionId,
      mode: request.mode,
      targetProfileId: request.profileId,
      sourceEventHash: request.sourceEventHash,
      sourceAnchorCatalog: listContinuationSourceAnchors,
      terminal: nativeContinuationTerminal,
    }),
    confirm: async (message) => (
      await api.window.showWarningMessage(message, { modal: true }, "Continue")
    ) === "Continue",
    onStateChanged: refreshProviderUi,
    onProgress: (event) => panel?.postProgress(event),
  });
  if (
    typeof api.window.createWebviewPanel === "function" &&
    api.ViewColumn !== undefined
  ) {
    panel = new ProviderWorkbenchPanel(
      api.window,
      api.ViewColumn.One,
      controller,
    );
  }
  lifecycle = registerExtensionLifecycle(context, api, {
    getStatusText: createActiveProfileStatusText(
      activeProfiles,
      prerequisites.profiles,
    ),
    createCommandHandlers: (refresh) => ({
      ...toExtensionCommandHandlers(createProfileCommandHandlers({
        layout: prerequisites.layout,
        profiles: prerequisites.profiles,
        secrets: prerequisites.secrets,
        activeProfiles,
        ui: createVscodeProfileCommandUi(api),
        officialLogin,
        nativeContinuationTerminal,
        restoreAuthMode: createStartupAuthModeRestorer(prerequisites),
        refreshStatus: refresh,
      })),
      "codexProvider.openWorkbench": async (profileId?: string) => {
        panel?.open(profileId);
      },
      "codexProvider.addProvider": async () => {
        panel?.openCreate();
      },
      "codexProvider.refreshProviders": async () => {
        await refreshProviderUi();
      },
    }),
  });
  try {
    if (typeof api.window.registerTreeDataProvider === "function") {
      context.subscriptions.push(
        api.window.registerTreeDataProvider("codexProvider.providers", tree),
      );
    }
    if (panel) {
      context.subscriptions.push(panel);
    }
  } catch (error) {
    panel?.dispose();
    lifecycle.dispose();
    throw error;
  }
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
