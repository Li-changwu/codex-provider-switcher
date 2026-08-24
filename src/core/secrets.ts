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
    if (!isVerifiedRemoteSshStorage(storageLocation)) {
      throw new UnsupportedSecretStorageError(
        "SecretStorage must be a verified remote Extension Host storage target.",
      );
    }
  }

  async set(profileSecretId: string, value: string): Promise<void> {
    assertProfileSecretId(profileSecretId);
    try {
      await this.secrets.store(profileSecretId, value);
    } catch {
      throw new SecretStorageError("write");
    }
  }

  async get(profileSecretId: string): Promise<string | undefined> {
    assertProfileSecretId(profileSecretId);
    try {
      return await this.secrets.get(profileSecretId);
    } catch {
      throw new SecretStorageError("read");
    }
  }

  async delete(profileSecretId: string): Promise<void> {
    assertProfileSecretId(profileSecretId);
    try {
      await this.secrets.delete(profileSecretId);
    } catch {
      throw new SecretStorageError("delete");
    }
  }
}

function isVerifiedRemoteSshStorage(
  storageLocation: ResolvedExtensionHostStorageLocation,
): boolean {
  const uri = storageLocation.uri;
  return Boolean(
    storageLocation.verified &&
      storageLocation.isRemote &&
      uri?.scheme === "vscode-remote" &&
      uri.authority?.startsWith("ssh-remote+") &&
      uri.fsPath.startsWith("/") &&
      !/^\/mnt\/[a-z](?:\/|$)/i.test(uri.fsPath),
  );
}

function assertProfileSecretId(profileSecretId: string): void {
  if (!profileSecretId.trim()) {
    throw new SecretStorageError("write");
  }
}
