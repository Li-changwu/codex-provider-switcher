import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  removeActiveCustomAuth,
  serializeActiveAuth,
  validateProfileConfig,
  writeActiveConfig,
  writeActiveCustomAuth,
} from "../../src/core/config";
import type { CodexLayout } from "../../src/core/types";

const validCustomConfig =
  '# preserve this comment\nmodel_provider = "research"\nmodel = "gpt-5"\n\n[model_providers.research]\nbase_url = "https://nowcoding.ai/v1"\nwire_api = "responses"\n';

test("validates custom TOML and returns its provider id without rewriting the input", () => {
  const validated = validateProfileConfig(validCustomConfig, "custom");

  assert.equal(validated.providerId, "research");
  assert.equal(validated.text, validCustomConfig);
});

test("accepts an official TOML baseline without requiring custom provider fields", () => {
  const officialConfig = "# official baseline\napproval_policy = \"on-request\"\n";

  const validated = validateProfileConfig(officialConfig, "official");

  assert.equal(validated.text, officialConfig);
  assert.equal(validated.providerId, undefined);
});

test("rejects malformed TOML", () => {
  assert.throws(
    () => validateProfileConfig('model_provider = "research"\n[', "custom"),
    /valid TOML/i,
  );
});

test("rejects custom TOML when model_provider is missing", () => {
  assert.throws(
    () =>
      validateProfileConfig(
        '[model_providers.research]\nbase_url = "https://example.test"\nwire_api = "responses"\n',
        "custom",
      ),
    /model_provider/i,
  );
});

test("rejects custom TOML when the selected provider table is missing", () => {
  assert.throws(
    () =>
      validateProfileConfig(
        'model_provider = "research"\n[model_providers.other]\nbase_url = "https://example.test"\nwire_api = "responses"\n',
        "custom",
      ),
    /model_providers\.research/i,
  );
});

test("rejects custom TOML when base_url is missing", () => {
  assert.throws(
    () =>
      validateProfileConfig(
        'model_provider = "research"\n[model_providers.research]\nwire_api = "responses"\n',
        "custom",
      ),
    /base_url/i,
  );
});

test("rejects custom TOML with a missing or unsupported wire_api", () => {
  assert.throws(
    () =>
      validateProfileConfig(
        'model_provider = "research"\n[model_providers.research]\nbase_url = "https://example.test"\n',
        "custom",
      ),
    /wire_api/i,
  );
  assert.throws(
    () =>
      validateProfileConfig(
        'model_provider = "research"\n[model_providers.research]\nbase_url = "https://example.test"\nwire_api = "chat-completions"\n',
        "custom",
      ),
    /responses/i,
  );
});

test("rejects an unknown profile kind", () => {
  assert.throws(
    () => validateProfileConfig("", "managed" as never),
    /profile kind/i,
  );
});

test("serializes custom auth with only OPENAI_API_KEY", () => {
  assert.equal(
    serializeActiveAuth("secret-value"),
    '{"OPENAI_API_KEY":"secret-value"}',
  );
});

test("rejects empty or whitespace API keys before materializing auth", () => {
  assert.throws(() => serializeActiveAuth(""), /API key/i);
  assert.throws(() => serializeActiveAuth(" \t\r\n "), /API key/i);
});

test("writes the original config and custom auth through the active layout", async () => {
  await withTemporaryLayout(async (layout) => {
    await writeActiveConfig(layout, validCustomConfig);
    await writeActiveCustomAuth(layout, "secret-value");

    assert.equal(await readFile(layout.configPath, "utf8"), validCustomConfig);
    assert.equal(
      await readFile(layout.authPath, "utf8"),
      '{"OPENAI_API_KEY":"secret-value"}',
    );
    assert.deepEqual(Object.keys(JSON.parse(await readFile(layout.authPath, "utf8"))), [
      "OPENAI_API_KEY",
    ]);
    if (process.platform === "linux") {
      assert.equal((await stat(layout.configPath)).mode & 0o777, 0o600);
      assert.equal((await stat(layout.authPath)).mode & 0o777, 0o600);
    }
  });
});

test("does not create or replace auth.json when the API key is empty", async () => {
  await withTemporaryLayout(async (layout) => {
    await mkdir(layout.codexHome, { recursive: true });
    await writeFile(layout.authPath, '{"OPENAI_API_KEY":"old-value"}', "utf8");

    await assert.rejects(() => writeActiveCustomAuth(layout, " \n\t"), /API key/i);

    assert.equal(
      await readFile(layout.authPath, "utf8"),
      '{"OPENAI_API_KEY":"old-value"}',
    );
    assert.deepEqual(await readdir(layout.codexHome), ["auth.json"]);
  });
});

test("cleans up an active custom auth file and tolerates a missing one", async () => {
  await withTemporaryLayout(async (layout) => {
    await writeActiveCustomAuth(layout, "secret-value");
    await removeActiveCustomAuth(layout);
    await removeActiveCustomAuth(layout);

    await assert.rejects(() => readFile(layout.authPath, "utf8"), { code: "ENOENT" });
  });
});

test("cleans a failed temporary config write without changing the active file", async () => {
  await withTemporaryLayout(async (layout) => {
    await mkdir(layout.configPath, { recursive: true });

    await assert.rejects(() => writeActiveConfig(layout, validCustomConfig));

    assert.deepEqual(await readdir(layout.codexHome), ["config.toml"]);
  });
});

async function withTemporaryLayout(
  operation: (layout: CodexLayout) => Promise<void>,
): Promise<void> {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-config-test-"));
  const layout: CodexLayout = {
    codexHome,
    configPath: join(codexHome, "config.toml"),
    authPath: join(codexHome, "auth.json"),
    sessionsDir: join(codexHome, "sessions"),
    archivedSessionsDir: join(codexHome, "archived_sessions"),
    sqlitePath: join(codexHome, "state_5.sqlite"),
    switcherDir: join(codexHome, "provider-switcher"),
  };
  try {
    await operation(layout);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}
