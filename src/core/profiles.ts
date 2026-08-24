import {
  chmod as nativeChmod,
  mkdir as nativeMkdir,
  readFile as nativeReadFile,
  rename as nativeRename,
  unlink as nativeUnlink,
  writeFile as nativeWriteFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { parse as parseToml } from "@iarna/toml";
import type { CodexLayout, ProfileKind, ProfileRecord } from "./types";

const profilesDirectoryName = "profiles";
const indexFileName = "index.json";
const linuxPrivateFileMode = 0o600;
const profileSecretNamespace = "codex-provider-switcher.profile";
const credentialKeyNames = new Set([
  "apikey",
  "accesskey",
  "privatekey",
  "secretkey",
  "authorization",
  "authorizationheader",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "secret",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "passwd",
]);

export interface ProfileFileSystem {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface CreateProfileInput {
  name: string;
  kind: ProfileKind;
  configText: string;
  providerId?: string;
  apiKeySecretId?: string;
}

export interface ProfileStoreOptions {
  fileSystem?: ProfileFileSystem;
  now?: () => string;
  platform?: NodeJS.Platform;
}

export type ProfileStoreErrorCode =
  | "invalid-config"
  | "index-read-failed"
  | "index-invalid"
  | "persistence-failed"
  | "rollback-failed";

export class ProfileStoreError extends Error {
  constructor(
    readonly code: ProfileStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProfileStoreError";
  }
}

export class ProfileStore {
  private static readonly createLocksByCodexHome = new Map<string, Promise<void>>();
  private readonly fileSystem: ProfileFileSystem;
  private readonly indexPath: string;
  private readonly now: () => string;
  private readonly platform: NodeJS.Platform;
  private readonly profilesDir: string;

  constructor(
    private readonly layout: CodexLayout,
    options: ProfileStoreOptions = {},
  ) {
    this.fileSystem = options.fileSystem ?? nativeProfileFileSystem;
    this.now = options.now ?? (() => new Date().toISOString());
    this.platform = options.platform ?? process.platform;
    this.profilesDir = join(layout.switcherDir, profilesDirectoryName);
    this.indexPath = join(this.profilesDir, indexFileName);
  }

  async create(input: CreateProfileInput): Promise<ProfileRecord> {
    assertNoCredentialAssignments(input.configText);
    return this.withCreateLock(async () => {
      const profiles = await this.readProfiles();
      const id = nextProfileId(input.name, profiles);
      const timestamp = this.now();
      const profile: ProfileRecord = {
        id,
        name: input.name,
        kind: input.kind,
        configFile: join(this.profilesDir, id, "config.toml"),
        providerId: input.providerId,
        apiKeySecretId:
          input.kind === "custom" ? profileApiKeySecretId(id) : undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await this.writeAtomically(profile.configFile, input.configText);
      try {
        await this.writeAtomically(
          this.indexPath,
          `${JSON.stringify(
            { profiles: [...profiles, toPublicProfileRecord(profile)] },
            undefined,
            2,
          )}\n`,
        );
      } catch (error: unknown) {
        await this.rollbackConfig(profile.configFile);
        if (
          error instanceof ProfileStoreError &&
          error.code === "rollback-failed"
        ) {
          throw error;
        }
        throw new ProfileStoreError(
          "persistence-failed",
          "Could not save the profile index.",
          { cause: error },
        );
      }
      return profile;
    });
  }

  async get(id: string): Promise<ProfileRecord | undefined> {
    return (await this.list()).find((profile) => profile.id === id);
  }

  async list(): Promise<ProfileRecord[]> {
    const profiles = await this.readProfiles();
    return profiles.map(withDerivedSecretId);
  }

  private async readProfiles(): Promise<ProfileRecord[]> {
    let contents: string;
    try {
      contents = await this.fileSystem.readFile(this.indexPath);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw new ProfileStoreError(
        "index-read-failed",
        "Could not read the profile index.",
        { cause: error },
      );
    }

    try {
      const parsed = JSON.parse(contents) as { profiles?: unknown };
      if (!Array.isArray(parsed.profiles)) {
        throw new Error("missing profiles");
      }
      return parsed.profiles.map(parsePublicProfileRecord);
    } catch {
      throw new ProfileStoreError("index-invalid", "The profile index is not valid.");
    }
  }

  private async writeAtomically(path: string, contents: string): Promise<void> {
    const temporaryPath = join(
      dirname(path),
      `.${basename(path)}.tmp-${randomUUID()}`,
    );
    try {
      await this.fileSystem.mkdir(dirname(path));
      await this.fileSystem.writeFile(temporaryPath, contents);
      if (this.platform === "linux") {
        await this.fileSystem.chmod(temporaryPath, linuxPrivateFileMode);
      }
      await this.fileSystem.rename(temporaryPath, path);
    } catch (error: unknown) {
      await this.removeTemporaryFile(temporaryPath);
      throw new ProfileStoreError(
        "persistence-failed",
        "Could not write profile data.",
        { cause: error },
      );
    }
  }

  private async rollbackConfig(configPath: string): Promise<void> {
    try {
      await this.fileSystem.unlink(configPath);
    } catch (error: unknown) {
      throw new ProfileStoreError(
        "rollback-failed",
        "Could not recover the profile config after index persistence failed.",
        { cause: error },
      );
    }
  }

  private async removeTemporaryFile(path: string): Promise<void> {
    try {
      await this.fileSystem.unlink(path);
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw new ProfileStoreError(
          "rollback-failed",
          "Could not clean up temporary profile data.",
          { cause: error },
        );
      }
    }
  }

  private async withCreateLock<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previousLock = ProfileStore.createLocksByCodexHome.get(
      this.layout.codexHome,
    );
    let releaseLock!: () => void;
    const lock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const currentLock = previousLock
      ? previousLock.then(() => lock)
      : lock;
    ProfileStore.createLocksByCodexHome.set(this.layout.codexHome, currentLock);

    if (previousLock) {
      await previousLock;
    }
    try {
      return await operation();
    } finally {
      releaseLock();
      if (
        ProfileStore.createLocksByCodexHome.get(this.layout.codexHome) ===
        currentLock
      ) {
        ProfileStore.createLocksByCodexHome.delete(this.layout.codexHome);
      }
    }
  }
}

export function profileApiKeySecretId(profileId: string): string {
  return `${profileSecretNamespace}.${profileId}.api-key`;
}

export function normalizeProfileId(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "profile";
}

export function toPublicProfileRecord(
  profile: ProfileRecord,
): Omit<ProfileRecord, "apiKeySecretId"> {
  const { apiKeySecretId: _apiKeySecretId, ...publicProfile } = profile;
  return publicProfile;
}

function withDerivedSecretId(profile: ProfileRecord): ProfileRecord {
  return profile.kind === "custom"
    ? { ...profile, apiKeySecretId: profileApiKeySecretId(profile.id) }
    : profile;
}

function assertNoCredentialAssignments(configText: string): void {
  let parsedConfig: Record<string, unknown>;
  try {
    parsedConfig = parseToml(configText);
  } catch {
    throw new ProfileStoreError(
      "invalid-config",
      "Profile configuration must be valid TOML and must not include credentials.",
    );
  }

  if (containsCredentialKey(parsedConfig)) {
    throw new ProfileStoreError(
      "invalid-config",
      "Profile configuration must not include credentials.",
    );
  }
}

function containsCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsCredentialKey);
  }
  if (!value || typeof value !== "object" || value instanceof Date) {
    return false;
  }

  return Object.entries(value).some(
    ([key, nestedValue]) =>
      isCredentialKey(key) || containsCredentialKey(nestedValue),
  );
}

function isCredentialKey(key: string): boolean {
  const normalizedKey = normalizeConfigKey(key);
  return [...credentialKeyNames].some((credentialKeyName) =>
    normalizedKey.endsWith(credentialKeyName),
  );
}

function normalizeConfigKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function nextProfileId(name: string, profiles: readonly ProfileRecord[]): string {
  const baseId = normalizeProfileId(name);
  const usedIds = new Set(profiles.map((profile) => profile.id));
  if (!usedIds.has(baseId)) {
    return baseId;
  }
  let suffix = 2;
  while (usedIds.has(`${baseId}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}-${suffix}`;
}

function parsePublicProfileRecord(value: unknown): ProfileRecord {
  if (!value || typeof value !== "object") {
    throw new Error("invalid profile");
  }
  const profile = value as Record<string, unknown>;
  if (
    typeof profile.id !== "string" ||
    typeof profile.name !== "string" ||
    (profile.kind !== "official" && profile.kind !== "custom") ||
    typeof profile.configFile !== "string" ||
    typeof profile.createdAt !== "string" ||
    typeof profile.updatedAt !== "string" ||
    (profile.providerId !== undefined && typeof profile.providerId !== "string")
  ) {
    throw new Error("invalid profile");
  }
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    configFile: profile.configFile,
    providerId: profile.providerId,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

const nativeProfileFileSystem: ProfileFileSystem = {
  async mkdir(path) {
    await nativeMkdir(path, { recursive: true });
  },
  readFile: (path) => nativeReadFile(path, "utf8"),
  async writeFile(path, contents) {
    await nativeWriteFile(path, contents, "utf8");
  },
  rename: nativeRename,
  chmod: nativeChmod,
  unlink: nativeUnlink,
};
