import {
  chmod as nativeChmod,
  mkdir as nativeMkdir,
  rename as nativeRename,
  unlink as nativeUnlink,
  writeFile as nativeWriteFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { parse as parseToml } from "@iarna/toml";
import type {
  CodexLayout,
  ProfileKind,
  ValidatedConfig,
} from "./types";

const linuxPrivateFileMode = 0o600;
const credentialKeyNames = new Set([
  "apikey",
  "accesskey",
  "access",
  "privatekey",
  "private",
  "secretkey",
  "secret",
  "secrets",
  "auth",
  "authentication",
  "authorization",
  "authorizationheader",
  "header",
  "headers",
  "httpheaders",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "tokens",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "passwd",
]);
const topLevelScalarConfigKeys = new Set([
  "modelprovider",
  "model",
  "modelreasoningeffort",
  "modelverbosity",
  "approvalpolicy",
  "sandboxmode",
]);
const topLevelNumericConfigKeys = new Set(["projectdocmaxbytes"]);
const providerStringConfigKeys = new Set(["name", "baseurl", "wireapi"]);
const providerNumericConfigKeys = new Set([
  "requestmaxretries",
  "streammaxretries",
  "streamidletimeoutms",
]);
const providerBooleanConfigKeys = new Set([
  "requiresopenaiauth",
  "supportswebsockets",
]);

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
  assertSafeProfileConfig(parsed);

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
  if (!isRecord(providers) || !isRecord(providers[providerId])) {
    throw new ConfigValidationError(
      "missing-field",
      `Profile configuration requires the selected model_providers.${providerId} table.`,
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
  assertSafeProfileConfig(parseProfileConfig(text));
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
    return parseToml(input) as Record<string, unknown>;
  } catch {
    throw new ConfigValidationError(
      "malformed-toml",
      "Profile configuration must be valid TOML.",
    );
  }
}

function assertSafeProfileConfig(config: Record<string, unknown>): void {
  if (containsCredentialKey(config)) {
    throw new ConfigValidationError(
      "credential-field",
      "Profile configuration must not include credentials.",
    );
  }
  assertSupportedProfileConfig(config);
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
  if (normalizedKey === "requiresopenaiauth") {
    return false;
  }
  return [...credentialKeyNames].some((credentialKeyName) =>
    normalizedKey.endsWith(credentialKeyName),
  );
}

function assertSupportedProfileConfig(config: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(config)) {
    const normalizedKey = normalizeConfigKey(key);
    if (normalizedKey === "modelproviders") {
      assertProviderConfigs(value);
      continue;
    }
    if (topLevelScalarConfigKeys.has(normalizedKey) && typeof value === "string") {
      continue;
    }
    if (topLevelNumericConfigKeys.has(normalizedKey) && typeof value === "number") {
      continue;
    }
    throwInvalidProfileConfig();
  }
}

function assertProviderConfigs(value: unknown): void {
  if (!isRecord(value)) {
    throwInvalidProfileConfig();
  }
  for (const providerConfig of Object.values(value)) {
    assertProviderConfig(providerConfig);
  }
}

function assertProviderConfig(value: unknown): void {
  if (!isRecord(value)) {
    throwInvalidProfileConfig();
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    const normalizedKey = normalizeConfigKey(key);
    if (
      providerStringConfigKeys.has(normalizedKey) &&
      typeof fieldValue === "string"
    ) {
      continue;
    }
    if (
      providerNumericConfigKeys.has(normalizedKey) &&
      typeof fieldValue === "number"
    ) {
      continue;
    }
    if (
      providerBooleanConfigKeys.has(normalizedKey) &&
      typeof fieldValue === "boolean"
    ) {
      continue;
    }
    if (normalizedKey === "queryparams") {
      assertScalarConfigMap(fieldValue);
      continue;
    }
    throwInvalidProfileConfig();
  }
}

function assertScalarConfigMap(value: unknown): void {
  if (!isRecord(value)) {
    throwInvalidProfileConfig();
  }
  for (const fieldValue of Object.values(value)) {
    if (
      !isConfigScalar(fieldValue) &&
      (!Array.isArray(fieldValue) || !fieldValue.every(isConfigScalar))
    ) {
      throwInvalidProfileConfig();
    }
  }
}

function isConfigScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function throwInvalidProfileConfig(): never {
  throw new ConfigValidationError(
    "unsupported-field",
    "Profile configuration must use supported non-secret Codex/provider settings.",
  );
}

function normalizeConfigKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
    if (!renamed) {
      await removeTemporaryFile(temporaryPath);
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
      throw new ConfigPersistenceError(
        "Could not clean up temporary active Codex configuration.",
        { cause: error },
      );
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
