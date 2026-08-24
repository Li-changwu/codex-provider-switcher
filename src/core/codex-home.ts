import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { CodexLayout, ExtensionHostStorageUri } from "./types";

export type UnsupportedHostCode =
  | "unsupported-platform"
  | "wsl"
  | "windows-unc"
  | "cross-host-path";

export class UnsupportedHostError extends Error {
  constructor(readonly code: UnsupportedHostCode, message: string) {
    super(message);
    this.name = "UnsupportedHostError";
  }
}

export interface ResolveCodexLayoutOptions {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homeDir: string;
  extensionStorageUri: ExtensionHostStorageUri;
  kernelReleaseProbe?: () => string | undefined;
}

export function resolveCodexLayout(
  options: ResolveCodexLayoutOptions,
): CodexLayout {
  assertSupportedPlatform(options.platform);
  assertNotWsl(
    options.env,
    resolveKernelRelease(options),
    options.homeDir,
    options.extensionStorageUri.fsPath,
  );

  const path = options.platform === "win32" ? win32 : posix;
  const configuredCodexHome = options.env.CODEX_HOME;
  const codexHome =
    configuredCodexHome?.trim().length
      ? configuredCodexHome
      : path.join(options.homeDir, ".codex");

  assertHostPath(options.platform, codexHome, "Codex Home");
  assertHostPath(
    options.platform,
    options.extensionStorageUri.fsPath,
    "Extension Host storage",
  );

  const normalizedCodexHome = path.normalize(codexHome);
  return {
    codexHome: normalizedCodexHome,
    configPath: path.join(normalizedCodexHome, "config.toml"),
    authPath: path.join(normalizedCodexHome, "auth.json"),
    sessionsDir: path.join(normalizedCodexHome, "sessions"),
    archivedSessionsDir: path.join(normalizedCodexHome, "archived_sessions"),
    sqlitePath: path.join(normalizedCodexHome, "state_5.sqlite"),
    switcherDir: path.join(normalizedCodexHome, "provider-switcher"),
  };
}

function assertSupportedPlatform(platform: NodeJS.Platform): asserts platform is "linux" | "win32" {
  if (platform !== "linux" && platform !== "win32") {
    throw new UnsupportedHostError(
      "unsupported-platform",
      `Codex Provider Switcher does not support ${platform} Extension Hosts.`,
    );
  }
}

function assertNotWsl(
  env: Readonly<Record<string, string | undefined>>,
  kernelRelease: string | undefined,
  ...paths: string[]
): void {
  if (
    isWslEnvironment(env) ||
    isWslKernelRelease(kernelRelease) ||
    paths.some(isWslPath)
  ) {
    throw new UnsupportedHostError(
      "wsl",
      "Codex Provider Switcher does not support WSL Extension Hosts.",
    );
  }
}

function resolveKernelRelease(
  options: ResolveCodexLayoutOptions,
): string | undefined {
  if (options.platform !== "linux") {
    return undefined;
  }
  return (options.kernelReleaseProbe ?? defaultLinuxKernelReleaseProbe)();
}

function defaultLinuxKernelReleaseProbe(): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    return readFileSync("/proc/sys/kernel/osrelease", "utf8");
  } catch {
    return undefined;
  }
}

function assertHostPath(
  platform: "linux" | "win32",
  candidate: string,
  label: string,
): void {
  if (isWslPath(candidate)) {
    throw new UnsupportedHostError(
      "wsl",
      `${label} must not use a WSL path.`,
    );
  }
  if (isWindowsUncPath(candidate)) {
    throw new UnsupportedHostError(
      platform === "win32" ? "windows-unc" : "cross-host-path",
      `${label} must not use a Windows UNC path.`,
    );
  }
  if (platform === "linux") {
    if (isWindowsDrivePath(candidate) || !posix.isAbsolute(candidate)) {
      throw new UnsupportedHostError(
        "cross-host-path",
        `${label} must be an absolute Linux path on a Linux Extension Host.`,
      );
    }
    return;
  }
  if (!win32.isAbsolute(candidate)) {
    throw new UnsupportedHostError(
      "cross-host-path",
      `${label} must be an absolute Windows path on a Windows Extension Host.`,
    );
  }
}

function isWslEnvironment(env: Readonly<Record<string, string | undefined>>): boolean {
  return ["WSL_DISTRO_NAME", "WSL_INTEROP", "WSLENV"].some((key) => {
    const value = env[key];
    return value !== undefined && value !== "";
  });
}

function isWslKernelRelease(kernelRelease: string | undefined): boolean {
  return Boolean(kernelRelease && /microsoft|wsl/i.test(kernelRelease));
}

function isWslPath(candidate: string): boolean {
  return (
    /^\/mnt\/[a-z](?:\/|$)/i.test(candidate) ||
    /^\/run\/desktop\/mnt\/host\/[a-z](?:\/|$)/i.test(candidate) ||
    /^\\\\wsl(?:\.localhost)?\\/i.test(candidate) ||
    /^\/\/wsl(?:\.localhost)?\//i.test(candidate)
  );
}

function isWindowsUncPath(candidate: string): boolean {
  return /^\\\\|^\/\//.test(candidate);
}

function isWindowsDrivePath(candidate: string): boolean {
  return /^[a-z]:[\\/]/i.test(candidate);
}
