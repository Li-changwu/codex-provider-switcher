import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import {
  ConfigPersistenceError,
  writeActiveConfig,
} from "../../src/core/config";
import type { CodexLayout } from "../../src/core/types";

test("durably publishes the active config before returning", async () => {
  await withTemporaryLayout(async (layout) => {
    const events: string[] = [];

    await writeActiveConfig(
      layout,
      'model_provider = "openai"\n',
      {
        async syncFile(path: string) {
          assert.notEqual(path, layout.configPath);
          assert.equal(await readFile(path, "utf8"), 'model_provider = "openai"\n');
          events.push("file");
        },
        async syncDirectory(path: string) {
          assert.equal(path, dirname(layout.configPath));
          assert.equal(
            await readFile(layout.configPath, "utf8"),
            'model_provider = "openai"\n',
          );
          events.push("parent");
        },
      },
    );

    assert.deepEqual(events, ["file", "parent"]);
  });
});

test("redacts active config durability failure details", async () => {
  await withTemporaryLayout(async (layout) => {
    const secret = "sk-active-config-sync-secret";
    const syncError = new Error(`configuration sync failed for ${secret}`);

    await assert.rejects(
      () =>
        writeActiveConfig(layout, 'model_provider = "openai"\n', {
          async syncFile() {
            throw syncError;
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigPersistenceError);
        assert.equal(error.message, "Could not write active Codex configuration.");
        assert.doesNotMatch(collectErrorText(error), new RegExp(secret));
        assert.notEqual(error.cause, syncError);
        return true;
      },
    );
  });
});

async function withTemporaryLayout(
  operation: (layout: CodexLayout) => Promise<void>,
): Promise<void> {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-config-durability-test-"));
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

function collectErrorText(error: unknown): string {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const text: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (!(current instanceof Error)) {
      text.push(String(current));
      continue;
    }
    text.push(current.name, current.message, current.stack ?? "");
    if (current.cause !== undefined) {
      pending.push(current.cause);
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
  }
  return text.join("\n");
}
