import {
  chmod as nativeChmod,
  mkdir as nativeMkdir,
  open as nativeOpen,
  rename as nativeRename,
  unlink as nativeUnlink,
  writeFile as nativeWriteFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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

export interface ConfigIo {
  syncFile?(path: string): Promise<void>;
  syncDirectory?(path: string): Promise<void>;
  beforePublish?(path: string): Promise<void>;
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
  io: ConfigIo = {},
): Promise<void> {
  parseProfileConfig(text);
  try {
    await writeAtomically(layout.configPath, text, io);
  } catch {
    throw activeConfigPersistenceError();
  }
}

export async function writeActiveCustomAuth(
  layout: CodexLayout,
  apiKey: string,
  io: ConfigIo = {},
): Promise<void> {
  const serializedAuth = serializeActiveAuth(apiKey);
  try {
    await writeAtomically(layout.authPath, serializedAuth, io);
  } catch {
    throw activeAuthPersistenceError(
      "Could not write active Codex configuration.",
    );
  }
}

export async function removeActiveCustomAuth(
  layout: CodexLayout,
  io: ConfigIo = {},
): Promise<void> {
  try {
    await nativeUnlink(layout.authPath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }
    throw activeAuthPersistenceError(
      "Could not remove the active custom authentication file.",
    );
  }

  try {
    await syncParentDirectory(layout.authPath, io);
  } catch {
    throw activeAuthPersistenceError(
      "Could not remove the active custom authentication file.",
    );
  }
}

function activeAuthPersistenceError(message: string): ConfigPersistenceError {
  return new ConfigPersistenceError(message, {
    cause: new Error("Authentication persistence failure details are redacted."),
  });
}

function activeConfigPersistenceError(): ConfigPersistenceError {
  return new ConfigPersistenceError("Could not write active Codex configuration.", {
    cause: new Error("Active configuration persistence failure details are redacted."),
  });
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

async function writeAtomically(
  path: string,
  text: string,
  io?: ConfigIo,
): Promise<void> {
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
    if (io) {
      await (io.syncFile ?? syncFile)(temporaryPath);
    }
    await io?.beforePublish?.(path);
    await nativeRename(temporaryPath, path);
    renamed = true;
    if (io) {
      await syncParentDirectory(path, io);
    }
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

async function syncFile(path: string): Promise<void> {
  const handle = await nativeOpen(path, "r+");
  await syncAndClose(handle, "Authentication file sync and close both failed.");
}

async function syncParentDirectory(path: string, io: ConfigIo): Promise<void> {
  const directory = dirname(path);
  if (io.syncDirectory) {
    await io.syncDirectory(directory);
    return;
  }
  if (process.platform === "win32") {
    return;
  }
  const handle = await nativeOpen(directory, "r");
  await syncAndClose(handle, "Authentication directory sync and close both failed.");
}

async function syncAndClose(
  handle: FileHandle,
  aggregateMessage: string,
): Promise<void> {
  let primaryError: unknown;
  try {
    await handle.sync();
  } catch (error: unknown) {
    primaryError = error;
  }
  try {
    await handle.close();
  } catch (closeError: unknown) {
    primaryError = primaryError === undefined
      ? closeError
      : new AggregateError([primaryError, closeError], aggregateMessage);
  }
  if (primaryError !== undefined) {
    throw primaryError;
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
