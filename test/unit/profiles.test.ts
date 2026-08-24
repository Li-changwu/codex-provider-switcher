import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { CodexLayout } from "../../src/core/types";
import {
  ProfileStore,
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
      apiKeySecretId: "profile.research-proxy.secret",
    });
    const second = await store.create({
      name: "Research Proxy!",
      kind: "custom",
      configText: 'model_provider = "research"\n',
      providerId: "research",
    });

    assert.equal(first.id, "research-proxy");
    assert.equal(second.id, "research-proxy-2");
    assert.equal(first.configFile, join(layout.switcherDir, "profiles", first.id, "config.toml"));
    assert.deepEqual(
      (await store.list()).map((profile) => profile.id),
      ["research-proxy", "research-proxy-2"],
    );
    assert.deepEqual(await store.get(first.id), first);
  });
});

test("writes raw TOML separately and redacts secret identifiers from the index", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout, {
      now: () => "2026-08-24T00:00:00.000Z",
    });
    const profile = await store.create({
      name: "Official",
      kind: "official",
      configText: 'model_provider = "openai"\n',
      apiKeySecretId: "profile.official.secret",
    });

    const indexPath = join(layout.switcherDir, "profiles", "index.json");
    const indexText = await readFile(indexPath, "utf8");
    const persistedProfile = JSON.parse(indexText) as {
      profiles: Array<Record<string, unknown>>;
    };

    assert.equal(await readFile(profile.configFile, "utf8"), 'model_provider = "openai"\n');
    assert.equal(profile.apiKeySecretId, "profile.official.secret");
    assert.equal(persistedProfile.profiles[0].apiKeySecretId, undefined);
    assert.doesNotMatch(indexText, /profile\.official\.secret/);
    assert.equal((await new ProfileStore(layout).get(profile.id))?.apiKeySecretId, undefined);
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

test("stores secret values only through verified remote SecretStorage", async () => {
  const secrets = new FakeSecretStorage();
  const store = new SecretStore(secrets, verifiedRemoteStorage());
  const secretId = "profile.research-proxy.secret";
  const fixtureSecretValue = "fixture-secret-value";

  await store.set(secretId, fixtureSecretValue);
  assert.equal(await store.get(secretId), fixtureSecretValue);
  await store.delete(secretId);
  assert.equal(await store.get(secretId), undefined);

  assert.throws(
    () => new SecretStore(secrets, { ...verifiedRemoteStorage(), verified: false }),
    UnsupportedSecretStorageError,
  );
  assert.throws(
    () => new SecretStore(secrets, { ...verifiedRemoteStorage(), isRemote: false }),
    UnsupportedSecretStorageError,
  );
  assert.throws(
    () =>
      new SecretStore(secrets, {
        uri: {
          scheme: "file",
          fsPath: "C:\\Users\\Ada\\AppData\\Roaming\\Code\\User\\globalStorage",
        },
        isRemote: true,
        verified: true,
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
    isRemote: true,
    verified: true,
  };
}
