import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";
import {
  inspectStateDatabase,
  SqliteError,
  updateProviderMetadata,
} from "../../src/core/sqlite";
import type { CodexLayout } from "../../src/core/types";

test("inspects and updates only threads.model_provider", async () => {
  await withDatabase(async (layout, database) => {
    await seedSupportedDatabase(database, [
      ["one", "openai", "Keep one", "opaque-one"],
      ["two", "custom", "Keep two", null],
      ["three", null, "Keep three", "opaque-three"],
    ]);

    assert.deepEqual(await inspectStateDatabase(layout), {
      schemaVersion: 5,
      recognizedProviderColumn: "model_provider",
      rowCount: 3,
      currentProviderCounts: [
        { provider: null, count: 1 },
        { provider: "custom", count: 1 },
        { provider: "openai", count: 1 },
      ],
    });

    const result = await updateProviderMetadata(layout, "switched");
    assert.deepEqual(result, {
      status: "updated",
      changedRowCount: 3,
      encryptedContentCount: 2,
      warnings: [
        "2 thread(s) contain encrypted_content; message bodies were not modified.",
      ],
    });

    assert.deepEqual(await readThreads(database), [
      { id: "one", provider: "switched", title: "Keep one", encrypted: "opaque-one" },
      { id: "three", provider: "switched", title: "Keep three", encrypted: "opaque-three" },
      { id: "two", provider: "switched", title: "Keep two", encrypted: null },
    ]);
  });
});

test("fails closed for an unknown schema without writing", async () => {
  await withDatabase(async (layout, database) => {
    await createDatabase(
      database,
      4,
      "CREATE TABLE threads (id TEXT, model_provider TEXT, title TEXT, encrypted_content TEXT)",
    );
    await run(
      database,
      "INSERT INTO threads (id, model_provider) VALUES (?, ?)",
      "one",
      "openai",
    );
    const before = await readFile(layout.sqlitePath);

    await assert.rejects(
      () => updateProviderMetadata(layout, "switched"),
      (error: unknown) => error instanceof SqliteError && error.code === "unknown-schema",
    );

    assert.deepEqual(await readThreads(database), [
      { id: "one", provider: "openai", title: null, encrypted: null },
    ]);
    assert.deepEqual(await readFile(layout.sqlitePath), before);
  });
});

test("rolls back provider changes when the transaction fails", async () => {
  await withDatabase(async (layout, database) => {
    await seedSupportedDatabase(database, [["one", "openai", "Keep title", "opaque"]]);
    await run(
      database,
      `CREATE TRIGGER fail_provider_update
       BEFORE UPDATE OF model_provider ON threads
       BEGIN SELECT RAISE(ABORT, 'injected update failure'); END`,
    );
    const before = await readFile(layout.sqlitePath);

    await assert.rejects(
      () => updateProviderMetadata(layout, "switched"),
      (error: unknown) => error instanceof SqliteError && error.code === "operation-failed",
    );

    assert.deepEqual(await readThreads(database), [
      { id: "one", provider: "openai", title: "Keep title", encrypted: "opaque" },
    ]);
    assert.deepEqual(await readFile(layout.sqlitePath), before);
  });
});

test("returns a bounded locked result when another writer owns the database", async () => {
  await withDatabase(async (layout, database) => {
    await seedSupportedDatabase(database, [["one", "openai", "Keep", null]]);
    await run(database, "BEGIN EXCLUSIVE");

    const startedAt = Date.now();
    const result = await updateProviderMetadata(layout, "switched");
    const elapsed = Date.now() - startedAt;

    assert.equal(result.status, "locked");
    assert.equal(result.changedRowCount, 0);
    assert.ok(elapsed < 1500, `lock handling took ${elapsed}ms`);
    await run(database, "ROLLBACK");
  });
});

test("rolls back when cancellation is observed before commit", async () => {
  await withDatabase(async (layout, database) => {
    await seedSupportedDatabase(database, [["one", "openai", "Keep", "opaque"]]);
    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads >= 6;
      },
    } as AbortSignal;

    const result = await updateProviderMetadata(layout, "switched", signal);

    assert.equal(result.status, "cancelled");
    assert.equal(result.changedRowCount, 0);
    assert.deepEqual(await readThreads(database), [
      { id: "one", provider: "openai", title: "Keep", encrypted: "opaque" },
    ]);
  });
});

test("binds an injection-like provider as data", async () => {
  await withDatabase(async (layout, database) => {
    await seedSupportedDatabase(database, [["one", "openai", "Keep", null]]);
    const target = "custom'); DROP TABLE threads; --";

    const result = await updateProviderMetadata(layout, target);

    assert.equal(result.status, "updated");
    assert.deepEqual(await readThreads(database), [
      { id: "one", provider: target, title: "Keep", encrypted: null },
    ]);
  });
});

test("does not expose transcript content during inspection", async () => {
  await withDatabase(async (layout, database) => {
    await seedSupportedDatabase(database, [["one", "openai", "Private title", "private body"]]);

    const inspection = await inspectStateDatabase(layout);
    const serialized = JSON.stringify(inspection);

    assert.doesNotMatch(serialized, /Private title|private body|one/);
  });
});

test("rejects missing tables, missing columns, and non-TEXT provider columns", async () => {
  const cases = [
    {
      code: "missing-table",
      schema: "CREATE TABLE other (id TEXT, model_provider TEXT)",
    },
    {
      code: "missing-column",
      schema: "CREATE TABLE threads (id TEXT, title TEXT)",
    },
    {
      code: "invalid-column-type",
      schema: "CREATE TABLE threads (id TEXT, model_provider INTEGER)",
    },
  ] as const;

  for (const testCase of cases) {
    await withDatabase(async (layout, database) => {
      await createDatabase(database, 5, testCase.schema);
      await assert.rejects(
        () => inspectStateDatabase(layout),
        (error: unknown) => error instanceof SqliteError && error.code === testCase.code,
      );
    });
  }
});

test("reports unreadable databases as typed failures", async () => {
  const directory = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "codex-sqlite-"));
  const layout = createLayout(directory);
  try {
    await writeFile(layout.sqlitePath, "not sqlite");

    await assert.rejects(
      () => inspectStateDatabase(layout),
      (error: unknown) => error instanceof SqliteError && error.code === "unreadable",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function withDatabase(
  callback: (layout: CodexLayout, database: sqlite3.Database) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "codex-sqlite-"));
  const layout = createLayout(directory);
  const database = await open(layout.sqlitePath);
  try {
    await callback(layout, database);
  } finally {
    await close(database);
    await rm(directory, { recursive: true, force: true });
  }
}

function createLayout(codexHome: string): CodexLayout {
  return {
    codexHome,
    configPath: join(codexHome, "config.toml"),
    authPath: join(codexHome, "auth.json"),
    sessionsDir: join(codexHome, "sessions"),
    archivedSessionsDir: join(codexHome, "archived_sessions"),
    sqlitePath: join(codexHome, "state_5.sqlite"),
    switcherDir: join(codexHome, "provider-switcher"),
  };
}

async function seedSupportedDatabase(
  database: sqlite3.Database,
  rows: Array<[string, string | null, string, string | null]>,
): Promise<void> {
  await createDatabase(
    database,
    5,
    `CREATE TABLE threads (
       id TEXT PRIMARY KEY,
       model_provider TEXT,
       title TEXT,
       encrypted_content TEXT
     )`,
  );
  for (const row of rows) {
    await run(
      database,
      "INSERT INTO threads (id, model_provider, title, encrypted_content) VALUES (?, ?, ?, ?)",
      ...row,
    );
  }
}

async function createDatabase(
  database: sqlite3.Database,
  version: number,
  schema: string,
): Promise<void> {
  await run(database, `PRAGMA user_version = ${version}`);
  await run(database, schema);
}

async function readThreads(database: sqlite3.Database): Promise<
  Array<{ id: string; provider: string | null; title?: string | null; encrypted?: string | null }>
> {
  return all<{ id: string; provider: string | null; title?: string | null; encrypted?: string | null }>(
    database,
    "SELECT id, model_provider AS provider, title, encrypted_content AS encrypted FROM threads ORDER BY id",
  );
}

function open(path: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(path, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve(database);
      }
    });
  });
}

function close(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    database.close((error) => (error ? reject(error) : resolve()));
  });
}

function run(database: sqlite3.Database, sql: string, ...params: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, (error) => (error ? reject(error) : resolve()));
  });
}

function all<T>(database: sqlite3.Database, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all<T>(sql, (error, rows) => (error ? reject(error) : resolve(rows)));
  });
}
