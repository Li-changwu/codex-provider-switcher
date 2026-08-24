import {
  chmod as nativeChmod,
  mkdir as nativeMkdir,
  rename as nativeRename,
  unlink as nativeUnlink,
  writeFile as nativeWriteFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  isPlainRecord,
  parseAndValidateProfileConfig,
  ProfileConfigPolicyError,
} from "./config-policy";
import type {
  CodexLayout,
  ProfileKind,
  ValidatedConfig,
} from "./types";

const linuxPrivateFileMode = 0o600;

export type ConfigValidationErrorCode =
  | "malformed-toml"
  | "unknown-profile-kind"
  | "missing-field"
  | "unsupported-wire-api"
  | "empty-api-key"
  | "credential-field"
  | "unsupported-field";

export class ConfigValidationError extends Error {
  constructor(
    readonly code: ConfigValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export { ConfigValidationError as ValidationError };

export class ConfigPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigPersistenceError";
  }
}

export function validateProfileConfig(
  input: string,
  kind: ProfileKind,
): ValidatedConfig {
  assertKnownProfileKind(kind);

  const parsed = parseProfileConfig(input);

  if (kind === "official") {
    return {
      kind,
      text: input,
      providerId: optionalProviderId(parsed.model_provider),
    };
  }

  const providerId = requiredString(
    parsed.model_provider,
    "model_provider",
  );
  const providers = parsed.model_providers;
  if (!isPlainRecord(providers) || !isPlainRecord(providers[providerId])) {
    throw new ConfigValidationError(
      "missing-field",
      "Profile configuration requires the selected model_providers table.",
    );
  }

  const provider = providers[providerId];
  requiredString(provider.base_url, "base_url");
  if (provider.wire_api === undefined) {
    throw new ConfigValidationError(
      "missing-field",
      "Profile configuration requires wire_api.",
    );
  }
  if (provider.wire_api !== "responses") {
    throw new ConfigValidationError(
      "unsupported-wire-api",
      'Profile configuration requires wire_api = "responses".',
    );
  }

  return { kind, text: input, providerId };
}

export function serializeActiveAuth(apiKey: string): string {
  assertApiKey(apiKey);
  return JSON.stringify({ OPENAI_API_KEY: apiKey });
}

export async function writeActiveConfig(
  layout: CodexLayout,
  text: string,
): Promise<void> {
  parseProfileConfig(text);
  await writeAtomically(layout.configPath, text);
}

export async function writeActiveCustomAuth(
  layout: CodexLayout,
  apiKey: string,
): Promise<void> {
  const serializedAuth = serializeActiveAuth(apiKey);
  await writeAtomically(layout.authPath, serializedAuth);
}

export async function removeActiveCustomAuth(layout: CodexLayout): Promise<void> {
  try {
    await nativeUnlink(layout.authPath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }
    throw new ConfigPersistenceError(
      "Could not remove the active custom authentication file.",
      { cause: error },
    );
  }
}

function assertKnownProfileKind(kind: ProfileKind): void {
  if (kind !== "official" && kind !== "custom") {
    throw new ConfigValidationError(
      "unknown-profile-kind",
      "Profile configuration has an unknown profile kind.",
    );
  }
}

function parseProfileConfig(input: string): Record<string, unknown> {
  try {
    return parseAndValidateProfileConfig(input);
  } catch (error: unknown) {
    if (error instanceof ProfileConfigPolicyError) {
      throw new ConfigValidationError(error.code, error.message);
    }
    throw error;
  }
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigValidationError(
      "missing-field",
      `Profile configuration requires ${fieldName}.`,
    );
  }
  return value;
}

function optionalProviderId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function assertApiKey(apiKey: string): void {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new ConfigValidationError(
      "empty-api-key",
      "An API key is required to create active custom authentication.",
    );
  }
}

async function writeAtomically(path: string, text: string): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${randomUUID()}`,
  );
  let renamed = false;
  try {
    await nativeMkdir(dirname(path), { recursive: true });
    await nativeWriteFile(temporaryPath, text, "utf8");
    if (process.platform === "linux") {
      await nativeChmod(temporaryPath, linuxPrivateFileMode);
    }
    await nativeRename(temporaryPath, path);
    renamed = true;
  } catch (error: unknown) {
    let cleanupError: unknown;
    if (!renamed) {
      try {
        await removeTemporaryFile(temporaryPath);
      } catch (error: unknown) {
        cleanupError = error;
      }
    }
    if (cleanupError !== undefined) {
      throw new ConfigPersistenceError(
        "Could not write active Codex configuration.",
        {
          cause: new AggregateError(
            [error, cleanupError],
            "Active Codex configuration write and cleanup both failed.",
          ),
        },
      );
    }
    throw new ConfigPersistenceError(
      "Could not write active Codex configuration.",
      { cause: error },
    );
  }
}

async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await nativeUnlink(path);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
