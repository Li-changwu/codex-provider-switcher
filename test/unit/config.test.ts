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
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  ConfigPersistenceError,
  removeActiveCustomAuth,
  serializeActiveAuth,
  validateProfileConfig,
  writeActiveConfig,
  writeActiveCustomAuth,
} from "../../src/core/config";
import { ProfileStore, ProfileStoreError } from "../../src/core/profiles";
import type { CodexLayout } from "../../src/core/types";

const validCustomConfig =
  '# preserve this comment\nmodel_provider = "research"\nmodel = "gpt-5"\n\n[model_providers.research]\nbase_url = "https://nowcoding.ai/v1"\nwire_api = "responses"\n';

test("validates custom TOML and returns its provider id without rewriting the input", () => {
  const validated = validateProfileConfig(validCustomConfig, "custom");

  assert.equal(validated.providerId, "research");
  assert.equal(validated.text, validCustomConfig);
});

test("accepts credential-looking provider IDs and saves their raw custom profiles", async () => {
  for (const providerId of ["token-proxy", "secret-proxy", "access-gateway"]) {
    await withTemporaryLayout(async (layout) => {
      const configText = [
        `model_provider = "${providerId}"`,
        `[model_providers."${providerId}"]`,
        'base_url = "https://proxy.invalid/v1"',
        'wire_api = "responses"',
        "",
      ].join("\n");

      const validated = validateProfileConfig(configText, "custom");
      assert.equal(validated.providerId, providerId);

      const profile = await new ProfileStore(layout).create({
        name: providerId,
        kind: "custom",
        configText,
      });
      assert.equal(await readFile(profile.configFile, "utf8"), configText);
    });
  }
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
        'model_provider = "sk-secret-value"\n[model_providers.other]\nbase_url = "https://example.test"\nwire_api = "responses"\n',
        "custom",
      ),
    (error: unknown) => {
      assert.match(String(error), /selected model_providers table/i);
      assert.doesNotMatch(String(error), /sk-secret-value/);
      return true;
    },
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

test("rejects credentials in official and custom TOML without exposing their values", () => {
  const invalidConfigs: Array<[string, string, "official" | "custom"]> = [
    ["official API key", 'api_key = "LEAK"', "official"],
    ["official OAuth token", '[oauth]\naccess_token = "LEAK"', "official"],
    [
      "custom provider-prefixed API key",
      `${validCustomConfig}openai_api_key = "LEAK"\n`,
      "custom",
    ],
    [
      "nested authorization header",
      `${validCustomConfig}[model_providers.research.headers]\nauthorization = "LEAK"\n`,
      "custom",
    ],
    [
      "private and access key aliases",
      `${validCustomConfig}private_key = "LEAK"\naccess_key = "LEAK"\n`,
      "custom",
    ],
    [
      "embedded API key alias in query params",
      `${validCustomConfig}query_params = { api_key_value = "LEAK" }\n`,
      "custom",
    ],
  ];

  for (const [description, input, kind] of invalidConfigs) {
    assert.throws(
      () => validateProfileConfig(input, kind),
      (error: unknown) => {
        assert.doesNotMatch(String(error), /LEAK/);
        assert.match(String(error), /credentials|auth|secret|invalid|supported/i);
        return true;
      },
      description,
    );
  }
});

test("rejects unknown top-level and provider fields", () => {
  assert.throws(
    () => validateProfileConfig("garbage = true\n", "official"),
    /supported/i,
  );
  assert.throws(
    () =>
      validateProfileConfig(
        `${validCustomConfig}timeout = 30\n`,
        "custom",
      ),
    /supported/i,
  );
});

test("accepts documented non-sensitive provider fields", () => {
  const documentedConfig = `${validCustomConfig}name = "Research"\nrequest_max_retries = 2\nstream_max_retries = 3\nstream_idle_timeout_ms = 5000\nrequires_openai_auth = true\nsupports_websockets = false\nquery_params = { region = "test", attempt = 1, api_version = "v1" }\n`;

  assert.doesNotThrow(() => validateProfileConfig(documentedConfig, "custom"));
});

test("rejects unknown or secret-shaped query parameters", () => {
  for (const queryParams of [
    '{ provider_hint = "sk-secret-value" }',
    '{ region = "sk-secret-value" }',
  ]) {
    assert.throws(
      () =>
        validateProfileConfig(
          `${validCustomConfig}query_params = ${queryParams}\n`,
          "custom",
        ),
      (error: unknown) => {
        assert.doesNotMatch(String(error), /sk-secret-value/);
        return true;
      },
    );
  }
});

test("rejects TOML datetimes where a table or scalar map is required", () => {
  assert.throws(() =>
    validateProfileConfig(
      `${validCustomConfig}query_params = 2026-08-25T00:00:00Z\n`,
      "custom",
    ),
  );
  assert.throws(() =>
    validateProfileConfig(
      'model_providers = 2026-08-25T00:00:00Z\n',
      "official",
    ),
  );
});

test("uses the same safe policy for profile creation and active config writes", async () => {
  await withTemporaryLayout(async (layout) => {
    const unsafeConfig = `${validCustomConfig}query_params = { provider_hint = "sk-secret-value" }\n`;
    const store = new ProfileStore(layout);

    await assert.rejects(
      () =>
        store.create({
          name: "Unsafe Query Parameter",
          kind: "custom",
          configText: unsafeConfig,
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "invalid-config",
    );
    await assert.rejects(() => writeActiveConfig(layout, unsafeConfig));
    assert.deepEqual(await readdir(layout.codexHome), []);
  });
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

test("rejects malformed active config before creating a file", async () => {
  await withTemporaryLayout(async (layout) => {
    await assert.rejects(
      () => writeActiveConfig(layout, 'model_provider = "research"\n['),
      /valid TOML/i,
    );

    assert.deepEqual(await readdir(layout.codexHome), []);
  });
});

test("keeps the existing active config when validation fails", async () => {
  await withTemporaryLayout(async (layout) => {
    const originalConfig = 'model_provider = "openai"\n';
    await writeFile(layout.configPath, originalConfig, "utf8");

    await assert.rejects(() => writeActiveConfig(layout, 'api_key_value = "LEAK"\n'));

    assert.equal(await readFile(layout.configPath, "utf8"), originalConfig);
  });
});

test("rejects credential-bearing active config before writing and does not expose the key", async () => {
  await withTemporaryLayout(async (layout) => {
    await assert.rejects(
      () => writeActiveConfig(layout, 'api_key = "LEAK"\n'),
      (error: unknown) => {
        assert.doesNotMatch(String(error), /LEAK/);
        return true;
      },
    );

    assert.deepEqual(await readdir(layout.codexHome), []);
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

test("durably publishes and removes active custom auth before returning", async () => {
  await withTemporaryLayout(async (layout) => {
    const events: string[] = [];
    await writeActiveCustomAuth(layout, "synthetic-secret", {
      async syncFile(path: string) {
        assert.notEqual(path, layout.authPath);
        assert.equal(await readFile(path, "utf8"), '{"OPENAI_API_KEY":"synthetic-secret"}');
        events.push("file");
      },
      async syncDirectory(path: string) {
        assert.equal(path, dirname(layout.authPath));
        assert.equal(await readFile(layout.authPath, "utf8"), '{"OPENAI_API_KEY":"synthetic-secret"}');
        events.push("write-parent");
      },
    } as never);
    assert.deepEqual(events, ["file", "write-parent"]);

    await removeActiveCustomAuth(layout, {
      async syncDirectory(path: string) {
        assert.equal(path, dirname(layout.authPath));
        await assert.rejects(() => readFile(layout.authPath, "utf8"), { code: "ENOENT" });
        events.push("remove-parent");
      },
    } as never);
    assert.deepEqual(events, ["file", "write-parent", "remove-parent"]);
  });
});

test("fails closed and redacts active auth durability sync failures", async (t) => {
  await t.test("write parent", async () => {
    await withTemporaryLayout(async (layout) => {
      const credential = "sk-synthetic-write-credential";
      const transcript = "synthetic write transcript with request and response bodies";
      const syncError = new AggregateError(
        [
          new Error(`write failed while handling ${credential}`),
          new Error(`captured transcript: ${transcript}`),
        ],
        "synthetic auth write parent sync failure",
      );
      await assert.rejects(
        () => writeActiveCustomAuth(layout, credential, {
          async syncDirectory() {
            throw syncError;
          },
        } as never),
        (error: unknown) => assertSecureAuthPersistenceError(
          error,
          syncError,
          "Could not write active Codex configuration.",
          [credential, transcript],
        ),
      );
    });
  });

  await t.test("remove parent ENOENT", async () => {
    await withTemporaryLayout(async (layout) => {
      const credential = "sk-synthetic-remove-credential";
      const transcript = "synthetic remove transcript with request and response bodies";
      await writeActiveCustomAuth(layout, credential);
      const syncError = Object.assign(
        new Error(`remove failed for ${credential}; transcript: ${transcript}`),
        { code: "ENOENT" },
      );
      await assert.rejects(
        () => removeActiveCustomAuth(layout, {
          async syncDirectory() {
            throw syncError;
          },
        } as never),
        (error: unknown) => assertSecureAuthPersistenceError(
          error,
          syncError,
          "Could not remove the active custom authentication file.",
          [credential, transcript],
        ),
      );
      await assert.rejects(() => readFile(layout.authPath, "utf8"), { code: "ENOENT" });
    });
  });
});

test("keeps active auth unchanged and redacts temporary auth-file sync failures", async () => {
  await withTemporaryLayout(async (layout) => {
    const originalAuth = '{"OPENAI_API_KEY":"existing-active-value"}';
    const credential = "sk-synthetic-temporary-sync-credential";
    const transcript = "synthetic temporary sync transcript marker";
    const syncError = new AggregateError(
      [
        new Error(`temporary sync failed for ${credential}`),
        new Error(`captured transcript: ${transcript}`),
      ],
      "synthetic temporary auth-file sync failure",
    );
    await writeFile(layout.authPath, originalAuth, "utf8");

    await assert.rejects(
      () => writeActiveCustomAuth(layout, credential, {
        async syncFile(path: string) {
          assert.notEqual(path, layout.authPath);
          throw syncError;
        },
      }),
      (error: unknown) => assertSecureAuthPersistenceError(
        error,
        syncError,
        "Could not write active Codex configuration.",
        [credential, transcript],
      ),
    );

    assert.equal(await readFile(layout.authPath, "utf8"), originalAuth);
    assert.deepEqual(await readdir(layout.codexHome), ["auth.json"]);
  });
});

test("cleans a failed temporary config write without changing the active file", async () => {
  await withTemporaryLayout(async (layout) => {
    await mkdir(layout.configPath, { recursive: true });

    await assert.rejects(() => writeActiveConfig(layout, validCustomConfig));

    assert.deepEqual(await readdir(layout.codexHome), ["config.toml"]);
  });
});

function assertSecureAuthPersistenceError(
  error: unknown,
  rawError: Error,
  expectedMessage: string,
  sensitiveValues: readonly string[],
): true {
  assert.ok(error instanceof ConfigPersistenceError);
  assert.equal(error.message, expectedMessage);

  const reachable = collectReachableErrorDetails(error);
  for (const sensitiveValue of sensitiveValues) {
    assert.equal(reachable.text.includes(sensitiveValue), false);
  }
  assert.ok(reachable.count <= 2);
  assert.notEqual(error.cause, rawError);
  assert.ok(error.cause instanceof Error);
  assert.equal(
    error.cause.message,
    "Authentication persistence failure details are redacted.",
  );
  assert.equal(error.cause.cause, undefined);
  return true;
}

function collectReachableErrorDetails(error: unknown): {
  count: number;
  text: string;
} {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const details: string[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (!(current instanceof Error)) {
      details.push(String(current));
      continue;
    }

    details.push([current.name, current.message, current.stack ?? ""].join("\n"));
    if (current.cause !== undefined) {
      pending.push(current.cause);
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
  }

  return { count: seen.size, text: details.join("\n") };
}

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
