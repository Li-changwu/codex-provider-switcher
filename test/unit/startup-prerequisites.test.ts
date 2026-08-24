import assert from "node:assert/strict";
import test from "node:test";
import { createStartupProfilePrerequisites } from "../../src/core/startup";
import type { SecretStorageLike } from "../../src/core/secrets";

test("constructs a SecretStore from ExtensionContext secrets and global storage", async () => {
  const contextSecrets = new FakeSecretStorage();
  const prerequisites = createStartupProfilePrerequisites(
    {
      secrets: contextSecrets,
      globalStorageUri: {
        scheme: "file",
        fsPath: "C:\\Users\\Ada\\AppData\\Roaming\\Code\\User\\globalStorage",
      },
    },
    {
      env: { CODEX_HOME: "C:\\Users\\Ada\\.codex" },
      platform: "win32",
      homeDir: "C:\\Users\\Ada",
    },
  );

  assert.equal(prerequisites.layout.codexHome, "C:\\Users\\Ada\\.codex");
  assert.equal(typeof prerequisites.profiles.create, "function");
  await prerequisites.secrets.set("profile.research-proxy.api-key", "fixture-secret-value");
  assert.equal(
    await prerequisites.secrets.get("profile.research-proxy.api-key"),
    "fixture-secret-value",
  );
  assert.equal(contextSecrets.storeCalls, 1);
});

class FakeSecretStorage implements SecretStorageLike {
  private readonly values = new Map<string, string>();
  storeCalls = 0;

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.storeCalls += 1;
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}
