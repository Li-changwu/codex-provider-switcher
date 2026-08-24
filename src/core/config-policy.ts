import { parse as parseToml } from "@iarna/toml";

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
const queryParameterKeys = new Set(["region", "attempt", "api_version"]);
const secretShapedValue = /^\s*sk-[A-Za-z0-9._~+-]+\s*$/i;

export type ProfileConfigPolicyErrorCode =
  | "malformed-toml"
  | "credential-field"
  | "unsupported-field";

export class ProfileConfigPolicyError extends Error {
  constructor(
    readonly code: ProfileConfigPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProfileConfigPolicyError";
  }
}

export function parseAndValidateProfileConfig(
  input: string,
): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(input) as Record<string, unknown>;
  } catch {
    throw new ProfileConfigPolicyError(
      "malformed-toml",
      "Profile configuration must be valid TOML.",
    );
  }

  if (containsCredentialKey(parsed)) {
    throw new ProfileConfigPolicyError(
      "credential-field",
      "Profile configuration must not include credentials.",
    );
  }
  assertSupportedProfileConfig(parsed);
  return parsed;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsCredentialKey);
  }
  if (!isPlainRecord(value)) {
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
    normalizedKey.includes(credentialKeyName),
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
  if (!isPlainRecord(value)) {
    throwInvalidProfileConfig();
  }
  for (const providerConfig of Object.values(value)) {
    assertProviderConfig(providerConfig);
  }
}

function assertProviderConfig(value: unknown): void {
  if (!isPlainRecord(value)) {
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
      assertQueryParams(fieldValue);
      continue;
    }
    throwInvalidProfileConfig();
  }
}

function assertQueryParams(value: unknown): void {
  if (!isPlainRecord(value)) {
    throwInvalidProfileConfig();
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!queryParameterKeys.has(key) || containsSecretShapedValue(fieldValue)) {
      throwInvalidProfileConfig();
    }
    if (!isConfigScalar(fieldValue) && !isConfigScalarArray(fieldValue)) {
      throwInvalidProfileConfig();
    }
  }
}

function containsSecretShapedValue(value: unknown): boolean {
  if (typeof value === "string") {
    return secretShapedValue.test(value);
  }
  return Array.isArray(value) && value.some(containsSecretShapedValue);
}

function isConfigScalarArray(value: unknown): value is Array<string | number | boolean> {
  return Array.isArray(value) && value.every(isConfigScalar);
}

function isConfigScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function throwInvalidProfileConfig(): never {
  throw new ProfileConfigPolicyError(
    "unsupported-field",
    "Profile configuration must use supported non-secret Codex/provider settings.",
  );
}

function normalizeConfigKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}
