import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { CodexLayout } from "../../src/core/types";
import {
  ProfileStore,
  ProfileStoreError,
  type ProfileFileSystem,
} from "../../src/core/profiles";
import {
  SecretStore,
  SecretStorageError,
  UnsupportedSecretStorageError,
  type SecretStorageLike,
} from "../../src/core/secrets";

test("creates normalized profile IDs and deterministic collision suffixes", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout, {
      now: () => "2026-08-24T00:00:00.000Z",
    });

    const first = await store.create({
      name: "Research Proxy!",
      kind: "custom",
      configText: 'model_provider = "research"\n',
      providerId: "research",
      apiKeySecretId: "supplied-but-not-persisted",
    });
    const second = await store.create({
      name: "Research Proxy!",
      kind: "custom",
      configText: 'model_provider = "research"\n',
      providerId: "research",
    });

    assert.equal(first.id, "research-proxy");
    assert.equal(second.id, "research-proxy-2");
    assert.equal(
      first.apiKeySecretId,
      "codex-provider-switcher.profile.research-proxy.api-key",
    );
    assert.equal(first.configFile, join(layout.switcherDir, "profiles", first.id, "config.toml"));
    assert.deepEqual(
      (await store.list()).map((profile) => profile.id),
      ["research-proxy", "research-proxy-2"],
    );
    assert.deepEqual(await store.get(first.id), first);
  });
});

test("derives custom secret IDs after restart without persisting them", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout, {
      now: () => "2026-08-24T00:00:00.000Z",
    });
    const profile = await store.create({
      name: "Research Proxy",
      kind: "custom",
      configText: 'model_provider = "research"\n',
      apiKeySecretId: "supplied-but-not-persisted",
    });

    const indexPath = join(layout.switcherDir, "profiles", "index.json");
    const indexText = await readFile(indexPath, "utf8");
    const persistedProfile = JSON.parse(indexText) as {
      profiles: Array<Record<string, unknown>>;
    };

    const expectedSecretId = "codex-provider-switcher.profile.research-proxy.api-key";
    assert.equal(await readFile(profile.configFile, "utf8"), 'model_provider = "research"\n');
    assert.equal(profile.apiKeySecretId, expectedSecretId);
    assert.equal(persistedProfile.profiles[0].apiKeySecretId, undefined);
    assert.doesNotMatch(indexText, /supplied-but-not-persisted/);
    assert.doesNotMatch(indexText, new RegExp(expectedSecretId));
    assert.equal((await new ProfileStore(layout).get(profile.id))?.apiKeySecretId, expectedSecretId);
  });
});

test("rejects credential assignments before writing profile files", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "credentialed-profile",
      "config.toml",
    );
    const indexPath = join(layout.switcherDir, "profiles", "index.json");

    await assert.rejects(
      () =>
        store.create({
          name: "Credentialed Profile",
          kind: "custom",
          configText: 'model_providers.research.api_key = "fixture-secret-value"\n',
        }),
      ProfileStoreError,
    );
    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
  });
});

test("rejects quoted TOML api_key assignments before writing profile files", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "quoted-credential",
      "config.toml",
    );
    const indexPath = join(layout.switcherDir, "profiles", "index.json");

    await assert.rejects(
      () =>
        store.create({
          name: "Quoted Credential",
          kind: "custom",
          configText: '"api_key" = "fixture-secret-value"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "invalid-config",
    );
    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
  });
});

test("rejects provider-prefixed TOML API key aliases before writing profile files", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "openai-alias",
      "config.toml",
    );
    const indexPath = join(layout.switcherDir, "profiles", "index.json");

    await assert.rejects(
      () =>
        store.create({
          name: "OpenAI Alias",
          kind: "custom",
          configText: '"OPENAI_API_KEY" = "fixture-secret-value"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "invalid-config",
    );
    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
  });
});

test("rejects nested TOML authorization assignments before writing profile files", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "authorization-header",
      "config.toml",
    );
    const indexPath = join(layout.switcherDir, "profiles", "index.json");

    await assert.rejects(
      () =>
        store.create({
          name: "Authorization Header",
          kind: "custom",
          configText: '[headers]\nauthorization = "fixture-secret-value"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "invalid-config",
    );
    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
  });
});

test("rejects malformed TOML before writing profile files", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "broken-toml",
      "config.toml",
    );
    const indexPath = join(layout.switcherDir, "profiles", "index.json");

    await assert.rejects(
      () =>
        store.create({
          name: "Broken TOML",
          kind: "official",
          configText: 'model_provider = ["openai"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "invalid-config",
    );
    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
  });
});

test("preserves valid non-secret TOML text without reserialization", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configText = [
      "# Retain comments and quoted keys exactly.",
      '"model-provider" = "research"',
      '[model_providers."research endpoint"]',
      'base_url = "https://proxy.invalid/v1"',
      "retry = { max_attempts = 3, enabled = true }",
      "",
    ].join("\n");

    const profile = await store.create({
      name: "Raw TOML",
      kind: "official",
      configText,
    });

    assert.equal(await readFile(profile.configFile, "utf8"), configText);
  });
});

test("uses same-directory atomic renames and requests Linux 0600 file modes", async () => {
  await withTemporaryLayout(async (layout) => {
    const fileSystem = new RecordingProfileFileSystem();
    const store = new ProfileStore(layout, {
      fileSystem,
      platform: "linux",
      now: () => "2026-08-24T00:00:00.000Z",
    });

    await store.create({
      name: "Atomic Profile",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });

    assert.ok(fileSystem.renames.length >= 2);
    assert.ok(
      fileSystem.renames.every(
        ({ from, to }) => dirname(from) === dirname(to) && basename(from).includes(".tmp-"),
      ),
    );
    assert.ok(fileSystem.chmods.length >= 2);
    assert.ok(fileSystem.chmods.every(({ mode }) => mode === 0o600));
  });
});

test("rolls back a visible config when index persistence fails", async () => {
  await withTemporaryLayout(async (layout) => {
    const fileSystem = new FailingIndexProfileFileSystem();
    const store = new ProfileStore(layout, { fileSystem });
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "rollback-profile",
      "config.toml",
    );

    await assert.rejects(
      () =>
        store.create({
          name: "Rollback Profile",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
      ProfileStoreError,
    );

    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    assert.ok(fileSystem.unlinked.includes(configPath));
  });
});

test("reports a config cleanup failure after index persistence fails", async () => {
  await withTemporaryLayout(async (layout) => {
    const fileSystem = new FailingIndexProfileFileSystem({ failConfigCleanup: true });
    const store = new ProfileStore(layout, { fileSystem });

    await assert.rejects(
      () =>
        store.create({
          name: "Cleanup Failure",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "rollback-failed",
    );
  });
});

test("reports a temporary cleanup failure after index persistence fails", async () => {
  await withTemporaryLayout(async (layout) => {
    const fileSystem = new FailingIndexProfileFileSystem({
      failTemporaryCleanup: true,
    });
    const store = new ProfileStore(layout, { fileSystem });

    await assert.rejects(
      () =>
        store.create({
          name: "Temporary Cleanup Failure",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "rollback-failed",
    );
  });
});

test("stores secret values through verified local or Remote SSH SecretStorage", async () => {
  const secrets = new FakeSecretStorage();
  const store = new SecretStore(secrets, verifiedRemoteStorage());
  const secretId = "profile.research-proxy.secret";
  const fixtureSecretValue = "fixture-secret-value";

  await store.set(secretId, fixtureSecretValue);
  assert.equal(await store.get(secretId), fixtureSecretValue);
  await store.delete(secretId);
  assert.equal(await store.get(secretId), undefined);

  const localStore = new SecretStore(secrets, verifiedLocalWindowsStorage());
  await localStore.set(secretId, fixtureSecretValue);
  assert.equal(await localStore.get(secretId), fixtureSecretValue);

  const localLinuxStore = new SecretStore(secrets, verifiedLocalLinuxStorage());
  await localLinuxStore.set(secretId, fixtureSecretValue);
  assert.equal(await localLinuxStore.get(secretId), fixtureSecretValue);

  assert.throws(
    () => new SecretStore(secrets, { platform: "win32" }),
    UnsupportedSecretStorageError,
  );
  assert.throws(
    () =>
      new SecretStore(secrets, {
        uri: {
          scheme: "file",
          fsPath: "C:\\Users\\Ada\\AppData\\Roaming\\Code\\User\\globalStorage",
        },
        platform: "linux",
        remoteAuthority: "ssh-remote+research-host",
      }),
    UnsupportedSecretStorageError,
  );
  assert.throws(
    () =>
      new SecretStore(secrets, {
        uri: {
          scheme: "vscode-remote",
          authority: "ssh-remote+research-host",
          fsPath: "/home/remote-user/.vscode-server/data/User/globalStorage",
        },
        platform: "win32",
        remoteAuthority: "ssh-remote+research-host",
      }),
    UnsupportedSecretStorageError,
  );
  assert.throws(
    () =>
      new SecretStore(secrets, {
        uri: {
          scheme: "file",
          fsPath: "//fileserver/profiles/ada/globalStorage",
        },
        platform: "linux",
      }),
    UnsupportedSecretStorageError,
  );
  assert.throws(
    () =>
      new SecretStore(secrets, {
        uri: {
          scheme: "vscode-remote",
          authority: "ssh-remote+other-host",
          fsPath: "/home/remote-user/.vscode-server/data/User/globalStorage",
        },
        platform: "linux",
        remoteAuthority: "ssh-remote+research-host",
      }),
    UnsupportedSecretStorageError,
  );
});

test("does not expose secret values in SecretStorage errors", async () => {
  const fixtureSecretValue = "fixture-secret-value";
  const store = new SecretStore(new FailingSecretStorage(), verifiedRemoteStorage());

  await assert.rejects(
    () => store.set("profile.research-proxy.secret", fixtureSecretValue),
    (error: unknown) => {
      assert.ok(error instanceof SecretStorageError);
      assert.doesNotMatch(error.message, /fixture-secret-value/);
      return true;
    },
  );
});

async function withTemporaryLayout(
  callback: (layout: CodexLayout) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-profiles-"));
  try {
    await callback({
      codexHome: directory,
      configPath: join(directory, "config.toml"),
      authPath: join(directory, "auth.json"),
      sessionsDir: join(directory, "sessions"),
      archivedSessionsDir: join(directory, "archived_sessions"),
      sqlitePath: join(directory, "state_5.sqlite"),
      switcherDir: join(directory, "provider-switcher"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

class RecordingProfileFileSystem implements ProfileFileSystem {
  readonly renames: Array<{ from: string; to: string }> = [];
  readonly chmods: Array<{ path: string; mode: number }> = [];
  readonly unlinked: string[] = [];

  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async readFile(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async writeFile(path: string, contents: string): Promise<void> {
    await writeFile(path, contents, "utf8");
  }

  async rename(from: string, to: string): Promise<void> {
    this.renames.push({ from, to });
    await rename(from, to);
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.chmods.push({ path, mode });
    await chmod(path, mode);
  }

  async unlink(path: string): Promise<void> {
    this.unlinked.push(path);
    await unlink(path);
  }
}

class FailingIndexProfileFileSystem extends RecordingProfileFileSystem {
  constructor(
    private readonly options: {
      failConfigCleanup?: boolean;
      failTemporaryCleanup?: boolean;
    } = {},
  ) {
    super();
  }

  override async rename(from: string, to: string): Promise<void> {
    if (to.endsWith("index.json")) {
      throw new Error("index persistence failed");
    }
    await super.rename(from, to);
  }

  override async unlink(path: string): Promise<void> {
    this.unlinked.push(path);
    if (this.options.failConfigCleanup && path.endsWith("config.toml")) {
      throw new Error("config cleanup failed");
    }
    if (this.options.failTemporaryCleanup && path.includes(".index.json.tmp-")) {
      throw new Error("temporary cleanup failed");
    }
    await unlink(path);
  }
}

class FakeSecretStorage implements SecretStorageLike {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class FailingSecretStorage implements SecretStorageLike {
  async get(): Promise<string | undefined> {
    return undefined;
  }

  async store(_key: string, value: string): Promise<void> {
    throw new Error(`storage rejected ${value}`);
  }

  async delete(): Promise<void> {
    return undefined;
  }
}

function verifiedRemoteStorage() {
  return {
    uri: {
      scheme: "vscode-remote",
      authority: "ssh-remote+research-host",
      fsPath: "/home/remote-user/.vscode-server/data/User/globalStorage",
    },
    platform: "linux" as const,
    remoteAuthority: "ssh-remote+research-host",
  };
}

function verifiedLocalWindowsStorage() {
  return {
    uri: {
      scheme: "file",
      fsPath: "C:\\Users\\Ada\\AppData\\Roaming\\Code\\User\\globalStorage",
    },
    platform: "win32" as const,
  };
}

function verifiedLocalLinuxStorage() {
  return {
    uri: {
      scheme: "file",
      fsPath: "/home/ada/.config/Code/User/globalStorage",
    },
    platform: "linux" as const,
  };
}
