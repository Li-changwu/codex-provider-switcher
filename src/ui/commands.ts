import type * as vscode from "vscode";
import { validateProfileConfig } from "../core/config";
import {
  continueSession as continueStoredSession,
  type ContinueSessionRequest,
  type ContinueSessionResult,
  type InteractiveCodexTerminal,
  type TerminalInvocation,
} from "../core/continuation";
import {
  profileApiKeySecretId,
  type CreateProfileInput,
  type UpdateProfileInput,
} from "../core/profiles";
import {
  switchStoredProfile as switchStoredProfileByDefault,
  type StoredProfileSwitchDependencies,
  type StoredProfileSwitchResult,
} from "../core/profile-switch-orchestrator";
import type { OfficialLoginExecutor } from "../core/official-login";
import type { ActiveProfileState, ProfileLookup } from "../core/profile-switch-orchestrator";
import type { ProfileSecretReader } from "../core/profile-switch-orchestrator";
import type { SwitchRequest } from "../core/switch-service";
import {
  recoverPendingSwitches as recoverPendingSwitchesByDefault,
  type RecoveryDependencies,
  type RecoveryResult,
} from "../core/transaction";
import type { CodexLayout, ProfileKind, ProfileRecord } from "../core/types";
import type { ProgressEvent } from "./progress";

const createProfileCommandId = "codexProvider.createProfile";
const editProfileCommandId = "codexProvider.editProfile";
const switchProfileCommandId = "codexProvider.switchProfile";
const syncSessionsCommandId = "codexProvider.syncSessions";
const continueSessionCommandId = "codexProvider.continueSession";
const restoreBackupCommandId = "codexProvider.restoreBackup";

export const profileCommandIds = [
  createProfileCommandId,
  editProfileCommandId,
  switchProfileCommandId,
  syncSessionsCommandId,
  continueSessionCommandId,
  restoreBackupCommandId,
] as const;

export interface CommandInputOptions {
  readonly prompt: string;
  readonly value?: string;
  readonly password?: boolean;
}

export interface CommandQuickPickItem {
  readonly label: string;
  readonly description?: string;
  readonly value: string;
}

export interface CommandProgressReporter {
  report(update: { message: string; increment?: number }): void;
}

export interface CommandCancellation {
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface ProfileCommandUi {
  input(options: CommandInputOptions): Promise<string | undefined>;
  pick<Item extends CommandQuickPickItem>(
    items: readonly Item[],
    options: { placeHolder: string },
  ): Promise<Item | undefined>;
  confirm(message: string, confirmLabel: string): Promise<boolean>;
  info(message: string): Promise<unknown>;
  error(message: string): Promise<unknown>;
  withProgress(
    title: string,
    operation: (
      progress: CommandProgressReporter,
      cancellation: CommandCancellation,
    ) => Promise<void>,
  ): Promise<void>;
  createTerminal(title: string): InteractiveCodexTerminal;
}

export interface CommandProfileStore extends ProfileLookup {
  create(input: CreateProfileInput): Promise<ProfileRecord>;
  readConfig(id: string): Promise<string | undefined>;
  update(id: string, input: UpdateProfileInput): Promise<ProfileRecord | undefined>;
}

export interface CommandSecretStore extends ProfileSecretReader {
  set(secretId: string, value: string): Promise<void>;
}

export type StoredProfileSwitcher = (
  request: SwitchRequest,
  dependencies: StoredProfileSwitchDependencies,
) => Promise<StoredProfileSwitchResult>;

export type SessionContinuation = (
  request: ContinueSessionRequest,
) => Promise<ContinueSessionResult>;

export type BackupRecovery = (
  layout: CodexLayout,
  dependencies?: RecoveryDependencies,
) => Promise<RecoveryResult>;

export interface ProfileCommandDependencies {
  readonly layout: CodexLayout;
  readonly profiles: CommandProfileStore;
  readonly secrets: CommandSecretStore;
  readonly activeProfiles: ActiveProfileState;
  readonly ui: ProfileCommandUi;
  readonly officialLogin?: OfficialLoginExecutor;
  readonly switchStoredProfile?: StoredProfileSwitcher;
  readonly continueSession?: SessionContinuation;
  readonly recoverPendingSwitches?: BackupRecovery;
  readonly restoreAuthMode?: NonNullable<RecoveryDependencies["restoreAuthMode"]>;
  readonly refreshStatus?: () => Promise<void>;
}

export interface ProfileCommandHandlers {
  createProfile(): Promise<void>;
  editProfile(): Promise<void>;
  switchProfile(): Promise<void>;
  syncSessions(): Promise<void>;
  continueSession(): Promise<void>;
  restoreBackup(): Promise<void>;
}

export function createProfileCommandHandlers(
  dependencies: ProfileCommandDependencies,
): ProfileCommandHandlers {
  const mutex = new OperationMutex();
  const switchProfile = dependencies.switchStoredProfile ?? switchStoredProfileByDefault;
  const continueSession = dependencies.continueSession ?? continueStoredSession;
  const recoverPendingSwitches = dependencies.recoverPendingSwitches
    ?? recoverPendingSwitchesByDefault;

  return {
    createProfile: () => mutex.run(() => createProfile()),
    editProfile: () => mutex.run(() => editProfile()),
    switchProfile: () => mutex.run(() => selectAndSwitchProfile()),
    syncSessions: () => mutex.run(() => syncSessions()),
    continueSession: () => mutex.run(() => continueNativeSession()),
    restoreBackup: () => mutex.run(() => restoreBackup()),
  };

  async function createProfile(): Promise<void> {
    try {
      const name = await promptRequired("Profile name");
      if (!name) {
        return;
      }
      const kind = await selectProfileKind();
      if (!kind) {
        return;
      }
      const configText = await dependencies.ui.input({
        prompt: "Paste the non-secret Profile TOML",
      });
      if (configText === undefined) {
        return;
      }
      const apiKey = kind === "custom"
        ? await promptRequired("API key", true)
        : undefined;
      if (kind === "custom" && !apiKey) {
        return;
      }
      const config = validateProfileConfig(configText, kind);
      const profile = await dependencies.profiles.create({
        name,
        kind,
        configText,
        providerId: config.providerId,
      });
      if (kind === "custom") {
        try {
          await dependencies.secrets.set(
            profile.apiKeySecretId ?? profileApiKeySecretId(profile.id),
            apiKey!,
          );
        } catch {
          await dependencies.ui.error(
            "Profile was created, but its API key could not be saved. Edit the Profile to replace the key.",
          );
          return;
        }
      }
      await dependencies.ui.info("Profile created.");
    } catch {
      await dependencies.ui.error(
        "Could not create the Profile. Check its non-secret TOML and try again.",
      );
    } finally {
      await refreshStatus();
    }
  }

  async function editProfile(): Promise<void> {
    try {
      const profile = await selectProfile("Select a Profile to edit");
      if (!profile) {
        return;
      }
      const currentConfig = await dependencies.profiles.readConfig(profile.id);
      if (currentConfig === undefined) {
        await dependencies.ui.error("The selected Profile configuration is unavailable.");
        return;
      }
      const name = await promptRequired("Profile name", false, profile.name);
      if (!name) {
        return;
      }
      const configText = await dependencies.ui.input({
        prompt: "Update the non-secret Profile TOML",
        value: currentConfig,
      });
      if (configText === undefined) {
        return;
      }
      const replacementApiKey = profile.kind === "custom"
        ? await dependencies.ui.input({
          prompt: "Optional replacement API key (leave blank to keep the current key)",
          password: true,
        })
        : undefined;
      if (profile.kind === "custom" && replacementApiKey === undefined) {
        return;
      }
      const config = validateProfileConfig(configText, profile.kind);
      const updated = await dependencies.profiles.update(profile.id, {
        name,
        kind: profile.kind,
        configText,
        providerId: config.providerId,
      });
      if (!updated) {
        await dependencies.ui.error("The selected Profile is no longer available.");
        return;
      }
      if (profile.kind === "custom" && replacementApiKey?.trim()) {
        try {
          await dependencies.secrets.set(
            profile.apiKeySecretId ?? profileApiKeySecretId(profile.id),
            replacementApiKey,
          );
        } catch {
          await dependencies.ui.error(
            "Profile changes were saved, but the replacement API key could not be saved.",
          );
          return;
        }
      }
      await dependencies.ui.info("Profile updated.");
    } catch {
      await dependencies.ui.error(
        "Could not update the Profile. Check its non-secret TOML and try again.",
      );
    } finally {
      await refreshStatus();
    }
  }

  async function selectAndSwitchProfile(): Promise<void> {
    try {
      const profiles = await dependencies.profiles.list();
      if (profiles.length === 0) {
        await dependencies.ui.info("No Profiles are available to switch.");
        return;
      }
      const activeProfileId = await currentActiveProfileId();
      const target = await dependencies.ui.pick(
        profiles.map((profile) => ({
          label: profile.name,
          description: profile.id === activeProfileId
            ? "Active profile"
            : "Switch to this profile",
          value: profile.id,
        })),
        { placeHolder: "Select a target Codex Profile" },
      );
      if (!target) {
        return;
      }
      const selectedProfile = profiles.find((profile) => profile.id === target.value);
      if (!selectedProfile) {
        await dependencies.ui.error("The selected Profile is no longer available.");
        return;
      }
      if (!await dependencies.ui.confirm(
        `Switch Codex to Profile ${selectedProfile.name}?`,
        "Switch",
      )) {
        return;
      }
      const result = await switchWithProgress(selectedProfile.id, "Switching Codex Profile");
      await reportSwitchResult(result);
    } catch {
      await dependencies.ui.error("Could not switch the Codex Profile.");
    } finally {
      await refreshStatus();
    }
  }

  async function syncSessions(): Promise<void> {
    try {
      const activeProfileId = await currentActiveProfileId();
      if (!activeProfileId) {
        await dependencies.ui.info("Select a Profile before synchronizing sessions.");
        return;
      }
      const profile = await dependencies.profiles.get(activeProfileId);
      if (!profile) {
        await dependencies.ui.error("The active Profile is no longer available.");
        return;
      }
      const result = await switchWithProgress(profile.id, "Synchronizing Codex Sessions");
      await reportSwitchResult(result);
    } catch {
      await dependencies.ui.error("Could not synchronize Codex sessions.");
    } finally {
      await refreshStatus();
    }
  }

  async function continueNativeSession(): Promise<void> {
    try {
      const sessionId = await promptRequired("Session ID to resume");
      if (!sessionId) {
        return;
      }
      const activeProfileId = await currentActiveProfileId();
      if (!activeProfileId) {
        await dependencies.ui.info("Select a Profile before resuming a session.");
        return;
      }
      const result = await continueSession({
        layout: dependencies.layout,
        sessionId,
        mode: "resume",
        targetProfileId: activeProfileId,
        terminal: dependencies.ui.createTerminal(`Codex: Resume ${sessionId}`),
      });
      if (result.status === "readableContentFallback") {
        await dependencies.ui.info(
          "Native Codex resume is unavailable. No readable content was transferred; fallback is unavailable in this release.",
        );
        return;
      }
      await dependencies.ui.info("Codex resume started in a terminal.");
    } catch {
      await dependencies.ui.error("Could not start native Codex resume.");
    } finally {
      await refreshStatus();
    }
  }

  async function restoreBackup(): Promise<void> {
    try {
      const result = await recoverPendingSwitches(dependencies.layout, {
        restoreAuthMode: dependencies.restoreAuthMode,
      });
      if (result.recoveryRequiredOperationIds.length > 0) {
        await dependencies.ui.error("Some backups require manual recovery before switching Profiles.");
        return;
      }
      await dependencies.ui.info("Backup recovery completed.");
    } catch {
      await dependencies.ui.error("Could not restore the pending backup.");
    } finally {
      await refreshStatus();
    }
  }

  async function promptRequired(
    prompt: string,
    password = false,
    value?: string,
  ): Promise<string | undefined> {
    const input = await dependencies.ui.input({ prompt, password, value });
    const trimmed = input?.trim();
    if (input !== undefined && !trimmed) {
      await dependencies.ui.error("A value is required.");
    }
    return trimmed || undefined;
  }

  async function selectProfileKind(): Promise<ProfileKind | undefined> {
    const selected = await dependencies.ui.pick([
      {
        label: "Official Codex",
        description: "Use your normal codex login",
        value: "official",
      },
      {
        label: "Custom provider",
        description: "Store its API key in SecretStorage",
        value: "custom",
      },
    ], { placeHolder: "Select a Profile kind" });
    return selected?.value as ProfileKind | undefined;
  }

  async function selectProfile(placeHolder: string): Promise<ProfileRecord | undefined> {
    const profiles = await dependencies.profiles.list();
    if (profiles.length === 0) {
      await dependencies.ui.info("No Profiles are available.");
      return undefined;
    }
    const selected = await dependencies.ui.pick(
      profiles.map((profile) => ({
        label: profile.name,
        description: profile.kind === "official" ? "Official" : "Custom",
        value: profile.id,
      })),
      { placeHolder },
    );
    return selected
      ? profiles.find((profile) => profile.id === selected.value)
      : undefined;
  }

  async function currentActiveProfileId(): Promise<string | undefined> {
    const snapshot = await dependencies.activeProfiles.snapshot();
    return snapshot.state === "present" ? snapshot.record.profileId : undefined;
  }

  async function switchWithProgress(
    targetProfileId: string,
    title: string,
  ): Promise<StoredProfileSwitchResult> {
    let result: StoredProfileSwitchResult | undefined;
    await dependencies.ui.withProgress(title, async (progress, cancellation) => {
      const controller = new AbortController();
      let previousPercentage = 0;
      const cancellationSubscription = cancellation.onCancellationRequested(() => {
        controller.abort();
      });
      try {
        result = await switchProfile(
          { targetProfileId, signal: controller.signal },
          {
            layout: dependencies.layout,
            profiles: dependencies.profiles,
            secrets: dependencies.secrets,
            activeProfiles: dependencies.activeProfiles,
            officialLogin: dependencies.officialLogin,
            onProgress: (event) => {
              previousPercentage = reportProgress(event, progress, previousPercentage);
            },
          },
        );
      } finally {
        cancellationSubscription.dispose();
      }
    });
    if (!result) {
      throw new Error("The stored Profile switch did not produce a result.");
    }
    return result;
  }

  function reportProgress(
    event: ProgressEvent,
    progress: CommandProgressReporter,
    previousPercentage: number,
  ): number {
    const currentPercentage = event.percentage === undefined
      ? undefined
      : Math.max(previousPercentage, event.percentage);
    const increment = currentPercentage === undefined
      ? undefined
      : currentPercentage - previousPercentage;
    progress.report({
      message: `${progressStageLabel(event.stage)} (${event.total === undefined
        ? String(event.completed)
        : `${event.completed}/${event.total}`})`,
      ...(increment === undefined ? {} : { increment }),
    });
    return currentPercentage ?? previousPercentage;
  }

  async function reportSwitchResult(
    result: StoredProfileSwitchResult,
  ): Promise<void> {
    if (result.status === "cancelled") {
      await dependencies.ui.info("Profile switch cancelled after rollback completed.");
      return;
    }
    if (result.status === "failed") {
      await dependencies.ui.error("The Profile switch did not complete safely.");
      return;
    }
    await dependencies.ui.info("Profile switch completed.");
  }

  async function refreshStatus(): Promise<void> {
    try {
      await dependencies.refreshStatus?.();
    } catch {
      // The status indicator is advisory and must not expose operational errors.
    }
  }
}

export type VscodeCommandUiApi = Pick<typeof vscode, "window" | "ProgressLocation">;

export function createVscodeProfileCommandUi(
  api: VscodeCommandUiApi,
): ProfileCommandUi {
  return {
    input: async (options) => await api.window.showInputBox({
      prompt: options.prompt,
      value: options.value,
      password: options.password,
      ignoreFocusOut: true,
    }),
    pick: async (items, options) => await api.window.showQuickPick(items, {
      placeHolder: options.placeHolder,
      ignoreFocusOut: true,
    }),
    confirm: async (message, confirmLabel) => (
      await api.window.showWarningMessage(message, { modal: true }, confirmLabel)
    ) === confirmLabel,
    info: async (message) => await api.window.showInformationMessage(message),
    error: async (message) => await api.window.showErrorMessage(message),
    withProgress: async (title, operation) => await api.window.withProgress(
      {
        location: api.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      async (progress, cancellation) => operation(
        { report: (update) => progress.report(update) },
        {
          onCancellationRequested: (listener) => cancellation.onCancellationRequested(listener),
        },
      ),
    ),
    createTerminal: (title) => createVscodeTerminal(api, title),
  };
}

function createVscodeTerminal(
  api: VscodeCommandUiApi,
  title: string,
): InteractiveCodexTerminal {
  return {
    launch: async (invocation) => {
      const terminal = api.window.createTerminal({ name: title });
      terminal.show(true);
      terminal.sendText(formatTerminalInvocation(invocation), true);
      return {};
    },
  };
}

function formatTerminalInvocation(invocation: TerminalInvocation): string {
  if (
    invocation.shell !== false ||
    !terminalArgumentPattern.test(invocation.command) ||
    invocation.args.some((argument) => !terminalArgumentPattern.test(argument))
  ) {
    throw new Error("The requested terminal invocation is unsafe.");
  }
  return [invocation.command, ...invocation.args].join(" ");
}

function progressStageLabel(event: ProgressEvent["stage"]): string {
  const labels: Record<ProgressEvent["stage"], string> = {
    preflight: "Preflight",
    backup: "Backing up",
    scan: "Scanning sessions",
    rollouts: "Synchronizing sessions",
    sqlite: "Updating session metadata",
    verify: "Verifying",
    commit: "Applying Profile",
  };
  return labels[event];
}

class OperationMutex {
  private tail: Promise<void> = Promise.resolve();

  async run(operation: () => Promise<void>): Promise<void> {
    const previous = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await operation();
    } finally {
      release?.();
    }
  }
}

const terminalArgumentPattern = /^[A-Za-z0-9._/-]+$/;
