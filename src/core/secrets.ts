import { posix, win32 } from "node:path";
import type {
  ResolvedExtensionHostStorageLocation,
} from "./types";

export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export class UnsupportedSecretStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSecretStorageError";
  }
}

export class SecretStorageError extends Error {
  constructor(operation: "read" | "write" | "delete") {
    super(`SecretStorage ${operation} failed.`);
    this.name = "SecretStorageError";
  }
}

export class SecretStore {
  constructor(
    private readonly secrets: SecretStorageLike,
    storageLocation: ResolvedExtensionHostStorageLocation,
  ) {
    if (!isVerifiedExtensionHostStorage(storageLocation)) {
      throw new UnsupportedSecretStorageError(
        "SecretStorage must use a verified Extension Host storage target.",
      );
    }
  }

  async set(profileSecretId: string, value: string): Promise<void> {
    assertProfileSecretId(profileSecretId, "write");
    try {
      await this.secrets.store(profileSecretId, value);
    } catch {
      throw new SecretStorageError("write");
    }
  }

  async get(profileSecretId: string): Promise<string | undefined> {
    assertProfileSecretId(profileSecretId, "read");
    try {
      return await this.secrets.get(profileSecretId);
    } catch {
      throw new SecretStorageError("read");
    }
  }

  async delete(profileSecretId: string): Promise<void> {
    assertProfileSecretId(profileSecretId, "delete");
    try {
      await this.secrets.delete(profileSecretId);
    } catch {
      throw new SecretStorageError("delete");
    }
  }
}

function isVerifiedExtensionHostStorage(
  storageLocation: ResolvedExtensionHostStorageLocation,
): boolean {
  const uri = storageLocation.uri;
  if (!uri) {
    return false;
  }
  if (storageLocation.remoteName) {
    return (
      storageLocation.platform === "linux" &&
      uri.scheme === "vscode-remote" &&
      storageLocation.remoteName === "ssh-remote" &&
      isSshRemoteAuthority(uri.authority) &&
      isNativeLinuxPath(uri.fsPath)
    );
  }
  return (
    uri.scheme === "file" &&
    !uri.authority &&
    isNativeLocalPath(uri.fsPath, storageLocation.platform)
  );
}

function isSshRemoteAuthority(authority: string | undefined): boolean {
  return (
    typeof authority === "string" &&
    authority.startsWith("ssh-remote+") &&
    authority.length > "ssh-remote+".length
  );
}

function isNativeLocalPath(path: string, platform: NodeJS.Platform): boolean {
  if (platform === "linux") {
    return isNativeLinuxPath(path);
  }
  return (
    platform === "win32" &&
    win32.isAbsolute(path) &&
    !/^\\\\|^\/\//.test(path) &&
    !/^\\\\wsl(?:\.localhost)?\\/i.test(path)
  );
}

function isNativeLinuxPath(path: string): boolean {
  return (
    posix.isAbsolute(path) &&
    !/^\/\//.test(path) &&
    !/^\/mnt\/[a-z](?:\/|$)/i.test(path) &&
    !/^\/run\/desktop\/mnt\/host\/[a-z](?:\/|$)/i.test(path)
  );
}

function assertProfileSecretId(
  profileSecretId: string,
  operation: "read" | "write" | "delete",
): void {
  if (!profileSecretId.trim()) {
    throw new SecretStorageError(operation);
  }
}
