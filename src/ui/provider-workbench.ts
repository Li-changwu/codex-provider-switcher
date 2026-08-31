import { validateProfileConfig } from "../core/config";
import { assertContinuationEligible } from "../core/continuation";
import {
  createProfileAuthPreview,
  profileApiKeySecretId,
  type CreateProfileInput,
  type UpdateProfileInput,
} from "../core/profiles";
import type { ContinuationSourceAnchor } from "../core/rollouts";
import type { ProfileKind, ProfileRecord } from "../core/types";

export interface WorkbenchProfileStore {
  list(): Promise<readonly ProfileRecord[]>;
  get(id: string): Promise<ProfileRecord | undefined>;
  readConfig(id: string): Promise<string | undefined>;
  create(input: CreateProfileInput): Promise<ProfileRecord>;
  update(id: string, input: UpdateProfileInput): Promise<ProfileRecord | undefined>;
  delete(id: string): Promise<boolean>;
}

export interface WorkbenchSecretStore {
  get(id: string): Promise<string | undefined>;
  set(id: string, value: string): Promise<void>;
  delete?(id: string): Promise<void>;
}

export interface WorkbenchSwitchResult {
  readonly status: "committed" | "cancelled" | "failed";
  readonly synchronizedChanges?: number;
  readonly journalState?: string;
}

export interface WorkbenchContinuationRequest {
  readonly mode: "resume" | "fork";
  readonly profileId: string;
  readonly sessionId: string;
  readonly sourceEventHash?: string;
}

export interface WorkbenchContinuationResult {
  readonly status: "resumed" | "forked" | "forkLaunched" | "reusedBranch" | "readableContentFallback";
  readonly sourceSessionId: string;
  readonly branchSessionId?: string;
}

export interface ProviderWorkbenchDependencies {
  readonly profiles: WorkbenchProfileStore;
  readonly secrets: WorkbenchSecretStore;
  readonly activeProfileId: () => Promise<string | undefined>;
  readonly switchProfile: (profileId: string, onProgress?: (event: unknown) => void) => Promise<WorkbenchSwitchResult>;
  readonly listSessionAnchors: () => Promise<readonly ContinuationSourceAnchor[]>;
  readonly continueSession: (request: WorkbenchContinuationRequest) => Promise<WorkbenchContinuationResult>;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly onStateChanged?: () => void | Promise<void>;
  readonly onProgress?: (event: unknown) => void;
}

type WorkbenchMessage =
  | { readonly type: "loadProfile"; readonly profileId: string }
  | { readonly type: "listSessions"; readonly profileId: string }
  | { readonly type: "syncSessions"; readonly profileId: string }
  | { readonly type: "continueSession"; readonly profileId: string; readonly sessionId: string }
  | { readonly type: "switchProfile"; readonly profileId: string }
  | { readonly type: "deleteProfile"; readonly profileId: string }
  | {
    readonly type: "createProfile";
    readonly name: string;
    readonly kind: ProfileKind;
    readonly configText?: string;
    readonly apiKey?: string;
  }
  | {
    readonly type: "saveProfile";
    readonly profileId: string;
    readonly name: string;
    readonly configText: string;
    readonly apiKey?: string;
  };

export class ProviderWorkbenchController {
  private eligibility: { providerId: string; sessionIds: Set<string> } | undefined;
  private anchors = new Map<string, ContinuationSourceAnchor>();

  constructor(private readonly dependencies: ProviderWorkbenchDependencies) {}

  async handleMessage(raw: unknown): Promise<any> {
    const message = parseMessage(raw);
    switch (message.type) {
      case "loadProfile":
        return this.loadProfile(message.profileId);
      case "listSessions":
        return this.listSessions(message.profileId);
      case "syncSessions":
        return this.syncSessions(message.profileId);
      case "continueSession":
        return this.continueSession(message.profileId, message.sessionId);
      case "switchProfile":
        return this.switchProfile(message.profileId);
      case "deleteProfile":
        return this.deleteProfile(message.profileId);
      case "createProfile":
        return this.createProfile(message);
      case "saveProfile":
        return this.saveProfile(message);
    }
  }

  clearEligibility(): void {
    this.eligibility = undefined;
    this.anchors.clear();
  }

  private async loadProfile(profileId: string) {
    const profile = await requireProfile(this.dependencies.profiles, profileId);
    const configText = await this.dependencies.profiles.readConfig(profileId);
    const secretConfigured = profile.kind === "custom" && profile.apiKeySecretId !== undefined
      ? (await this.dependencies.secrets.get(profile.apiKeySecretId)) !== undefined
      : false;
    return {
      type: "profileSnapshot" as const,
      profile,
      active: (await this.dependencies.activeProfileId()) === profile.id,
      configText: configText ?? "",
      auth: createProfileAuthPreview(profile.kind, secretConfigured),
    };
  }

  private async listSessions(profileId: string) {
    await requireProfile(this.dependencies.profiles, profileId);
    const anchors = await this.dependencies.listSessionAnchors();
    return {
      type: "sessionSnapshot" as const,
      sessions: anchors.map((anchor) => ({
        sessionId: anchor.sessionId,
        canContinue: this.eligibility?.providerId === profileId && this.eligibility.sessionIds.has(anchor.sessionId),
        disabledReason: this.eligibility?.providerId === profileId && this.eligibility.sessionIds.has(anchor.sessionId)
          ? undefined
          : "Synchronize session metadata for this Provider first.",
      })),
    };
  }

  private async syncSessions(profileId: string) {
    const profile = await requireProfile(this.dependencies.profiles, profileId);
    if ((await this.dependencies.activeProfileId()) !== profileId) {
      throw new Error("Activate this Provider before synchronizing sessions.");
    }
    this.clearEligibility();
    const result = await this.dependencies.switchProfile(profileId, this.dependencies.onProgress);
    if (result.status !== "committed" || result.journalState === "recoveryRequired") {
      return { type: "operationFailed" as const, message: "Session metadata synchronization did not complete safely." };
    }
    const anchors = await this.dependencies.listSessionAnchors();
    this.anchors = new Map(anchors.map((anchor) => [anchor.sessionId, anchor]));
    this.eligibility = { providerId: profileId, sessionIds: new Set(this.anchors.keys()) };
    return {
      type: "operationCompleted" as const,
      operation: "syncSessions" as const,
      synchronizedChanges: result.synchronizedChanges ?? 0,
      message: (result.synchronizedChanges ?? 0) === 0
        ? "No session metadata needs synchronization."
        : `Synchronized ${result.synchronizedChanges} session metadata file(s).`,
      providerName: profile.name,
    };
  }

  private async continueSession(profileId: string, sessionId: string) {
    assertContinuationEligible(this.eligibility, profileId, sessionId);
    const anchor = this.anchors.get(sessionId);
    if (!anchor) {
      throw new Error("The synchronized session is no longer available.");
    }
    const resumed = await this.dependencies.continueSession({ mode: "resume", profileId, sessionId });
    if (resumed.status !== "readableContentFallback") {
      return { type: "continuationCompleted" as const, mode: "resume" as const, ...resumed };
    }
    const profile = await requireProfile(this.dependencies.profiles, profileId);
    const confirmed = await this.dependencies.confirm(
      `This session cannot continue in place. Create a new branch from its synchronized history using ${profile.name}?`,
    );
    if (!confirmed) {
      return { type: "operationCancelled" as const, operation: "continueSession" as const };
    }
    const forked = await this.dependencies.continueSession({
      mode: "fork",
      profileId,
      sessionId,
      sourceEventHash: anchor.sourceEventHash,
    });
    return { type: "continuationCompleted" as const, mode: "fork" as const, ...forked };
  }

  private async switchProfile(profileId: string) {
    await requireProfile(this.dependencies.profiles, profileId);
    this.clearEligibility();
    const result = await this.dependencies.switchProfile(profileId, this.dependencies.onProgress);
    await this.dependencies.onStateChanged?.();
    return result.status === "committed"
      ? { type: "operationCompleted" as const, operation: "switchProfile" as const }
      : { type: "operationFailed" as const, message: "Provider switch did not complete safely." };
  }

  private async deleteProfile(profileId: string) {
    const profile = await requireProfile(this.dependencies.profiles, profileId);
    if ((await this.dependencies.activeProfileId()) === profileId) {
      throw new Error("Switch to another Provider before deleting the active Provider.");
    }
    if (!await this.dependencies.confirm(`Delete Provider ${profile.name}?`)) {
      return { type: "operationCancelled" as const, operation: "deleteProfile" as const };
    }
    const deleted = await this.dependencies.profiles.delete(profileId);
    if (deleted && profile.apiKeySecretId) {
      await this.dependencies.secrets.delete?.(profile.apiKeySecretId);
    }
    this.clearEligibility();
    await this.dependencies.onStateChanged?.();
    return { type: "operationCompleted" as const, operation: "deleteProfile" as const };
  }

  private async createProfile(message: Extract<WorkbenchMessage, { type: "createProfile" }>) {
    const name = requiredName(message.name);
    const configText = message.kind === "official"
      ? 'model_provider = "openai"\n'
      : message.configText ?? "";
    const validated = validateProfileConfig(configText, message.kind);
    if (message.kind === "custom" && !message.apiKey?.trim()) {
      throw new Error("An API key is required for a custom Provider.");
    }
    const profile = await this.dependencies.profiles.create({
      name,
      kind: message.kind,
      configText,
      providerId: validated.providerId,
    });
    if (message.kind === "custom") {
      await this.dependencies.secrets.set(
        profile.apiKeySecretId ?? profileApiKeySecretId(profile.id),
        message.apiKey!,
      );
    }
    await this.dependencies.onStateChanged?.();
    return { type: "operationCompleted" as const, operation: "createProfile" as const, profileId: profile.id };
  }

  private async saveProfile(message: Extract<WorkbenchMessage, { type: "saveProfile" }>) {
    const profile = await requireProfile(this.dependencies.profiles, message.profileId);
    const validated = validateProfileConfig(message.configText, profile.kind);
    const updated = await this.dependencies.profiles.update(profile.id, {
      name: requiredName(message.name),
      kind: profile.kind,
      configText: message.configText,
      providerId: validated.providerId,
    });
    if (!updated) {
      throw new Error("The Provider is no longer available.");
    }
    if (profile.kind === "custom" && message.apiKey?.trim()) {
      await this.dependencies.secrets.set(
        profile.apiKeySecretId ?? profileApiKeySecretId(profile.id),
        message.apiKey,
      );
    }
    this.clearEligibility();
    await this.dependencies.onStateChanged?.();
    return { type: "operationCompleted" as const, operation: "saveProfile" as const };
  }
}

function parseMessage(raw: unknown): WorkbenchMessage {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    throw new Error("Invalid Provider workbench message.");
  }
  const type = raw.type;
  if (["loadProfile", "listSessions", "syncSessions", "switchProfile", "deleteProfile"].includes(type)) {
    return { type, profileId: requiredId(raw.profileId) } as WorkbenchMessage;
  }
  if (type === "continueSession") {
    return { type, profileId: requiredId(raw.profileId), sessionId: requiredId(raw.sessionId) };
  }
  if (type === "createProfile") {
    if (raw.kind !== "official" && raw.kind !== "custom") {
      throw new Error("Invalid Provider kind in workbench message.");
    }
    return {
      type,
      name: requiredName(raw.name),
      kind: raw.kind,
      configText: optionalString(raw.configText),
      apiKey: optionalString(raw.apiKey),
    };
  }
  if (type === "saveProfile") {
    return {
      type,
      profileId: requiredId(raw.profileId),
      name: requiredName(raw.name),
      configText: requiredString(raw.configText, "configuration"),
      apiKey: optionalString(raw.apiKey),
    };
  }
  throw new Error("Unknown Provider workbench message.");
}

function requiredId(value: unknown): string {
  const id = requiredString(value, "identifier");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error("Invalid Provider workbench identifier.");
  }
  return id;
}

function requiredName(value: unknown): string {
  const name = requiredString(value, "name").trim();
  if (name.length > 80) {
    throw new Error("Provider name is too long.");
  }
  return name;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`A Provider ${label} is required.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Invalid Provider workbench message value.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requireProfile(store: WorkbenchProfileStore, id: string): Promise<ProfileRecord> {
  const profile = await store.get(id);
  if (!profile) {
    throw new Error("The selected Provider is no longer available.");
  }
  return profile;
}
