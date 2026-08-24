import sqlite3 from "sqlite3";
import type { CodexLayout } from "./types";

const supportedSchemaVersion = 5;
const busyTimeoutMs = 250;

export type SqliteErrorCode =
  | "unknown-schema"
  | "missing-table"
  | "missing-column"
  | "invalid-column-type"
  | "invalid-provider"
  | "unreadable"
  | "locked"
  | "operation-failed";

export class SqliteError extends Error {
  constructor(
    readonly code: SqliteErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SqliteError";
  }
}

export interface SqliteProviderCount {
  provider: string | null;
  count: number;
}

export interface SqliteInspection {
  schemaVersion: 5;
  recognizedProviderColumn: "model_provider";
  rowCount: number;
  currentProviderCounts: SqliteProviderCount[];
}

export type SqliteUpdateStatus = "updated" | "locked" | "cancelled";

export interface SqliteUpdateResult {
  status: SqliteUpdateStatus;
  changedRowCount: number;
  encryptedContentCount: number;
  warnings: string[];
}

interface TableInfoRow {
  name: string;
  type: string;
}

interface SupportedSchema {
  hasEncryptedContent: boolean;
}

interface CountRow {
  count: number;
}

interface ProviderRow {
  provider: string | null;
  count: number;
}

interface RunDetails {
  changes: number;
  lastID: number;
}

class CancellationRequested extends Error {
  constructor() {
    super("SQLite provider metadata update was cancelled.");
    this.name = "AbortError";
  }
}

export async function inspectStateDatabase(
  layout: CodexLayout,
): Promise<SqliteInspection> {
  let database: sqlite3.Database | undefined;
  let result: SqliteInspection | undefined;
  let primaryError: unknown;
  let closeError: unknown;

  try {
    database = await openDatabase(layout.sqlitePath, sqlite3.OPEN_READONLY);
    database.configure("busyTimeout", busyTimeoutMs);
    database.serialize();
    result = await inspectOpenDatabase(database);
  } catch (error: unknown) {
    primaryError =
      error instanceof SqliteError
        ? error
        : new SqliteError(
            database && isBusyError(error) ? "locked" : "unreadable",
            "The Codex state database could not be inspected.",
            { cause: error },
          );
  } finally {
    if (database) {
      try {
        await closeDatabase(database);
      } catch (error: unknown) {
        closeError = error;
      }
    }
  }

  return finishOperation(result, primaryError, closeError);
}

export async function updateProviderMetadata(
  layout: CodexLayout,
  targetProvider: string,
  signal?: AbortSignal,
): Promise<SqliteUpdateResult> {
  assertTargetProvider(targetProvider);
  if (signal?.aborted) {
    return cancelledResult();
  }

  let database: sqlite3.Database | undefined;
  let result: SqliteUpdateResult | undefined;
  let primaryError: unknown;
  let closeError: unknown;

  try {
    database = await openDatabase(layout.sqlitePath, sqlite3.OPEN_READWRITE);
    database.configure("busyTimeout", busyTimeoutMs);
    database.serialize();
    result = await updateOpenDatabase(database, targetProvider, signal);
  } catch (error: unknown) {
    if (database && (isBusyError(error) || (error instanceof SqliteError && error.code === "locked"))) {
      result = lockedResult();
    } else {
      primaryError =
        error instanceof SqliteError
          ? error
          : new SqliteError(
              database ? "operation-failed" : "unreadable",
              database
                ? "The Codex state database update failed."
                : "The Codex state database could not be opened.",
              { cause: error },
            );
    }
  } finally {
    if (database) {
      try {
        await closeDatabase(database);
      } catch (error: unknown) {
        closeError = error;
      }
    }
  }

  return finishOperation(result, primaryError, closeError);
}

async function inspectOpenDatabase(
  database: sqlite3.Database,
): Promise<SqliteInspection> {
  const schema = await readSupportedSchema(database);
  const rowCount = await readCount(database, "SELECT COUNT(*) AS count FROM threads");
  const currentProviderCounts = await allRows<ProviderRow>(
    database,
    `SELECT model_provider AS provider, COUNT(*) AS count
       FROM threads
      GROUP BY model_provider
      ORDER BY model_provider IS NOT NULL, model_provider`,
  );

  return {
    schemaVersion: supportedSchemaVersion,
    recognizedProviderColumn: "model_provider",
    rowCount,
    currentProviderCounts,
  };
}

async function updateOpenDatabase(
  database: sqlite3.Database,
  targetProvider: string,
  signal?: AbortSignal,
): Promise<SqliteUpdateResult> {
  throwIfCancelled(signal);
  const schema = await readSupportedSchema(database);
  throwIfCancelled(signal);

  try {
    await runStatement(database, "BEGIN IMMEDIATE");
  } catch (error: unknown) {
    if (isBusyError(error)) {
      try {
        await runStatement(database, "ROLLBACK");
      } catch (rollbackFailure: unknown) {
        throw operationError(
          "The SQLite metadata transaction could not acquire its lock or clean up.",
          new AggregateError(
            [error, rollbackFailure],
            "SQLite lock acquisition and cleanup failed.",
          ),
        );
      }
      return lockedResult();
    }
    throw operationError("Could not begin the SQLite metadata transaction.", error);
  }

  let transactionActive = true;
  try {
    throwIfCancelled(signal);
    const encryptedContentCount = schema.hasEncryptedContent
      ? await readCount(
          database,
          "SELECT COUNT(*) AS count FROM threads WHERE encrypted_content IS NOT NULL",
        )
      : 0;
    throwIfCancelled(signal);

    const update = await runStatement(
      database,
      "UPDATE threads SET model_provider = ? WHERE model_provider IS NULL OR model_provider <> ?",
      targetProvider,
      targetProvider,
    );
    throwIfCancelled(signal);

    await runStatement(database, "COMMIT");
    transactionActive = false;
    return updatedResult(update.changes, encryptedContentCount);
  } catch (error: unknown) {
    let rollbackError: unknown;
    if (transactionActive) {
      try {
        await runStatement(database, "ROLLBACK");
      } catch (rollbackFailure: unknown) {
        rollbackError = rollbackFailure;
      } finally {
        transactionActive = false;
      }
    }

    if (rollbackError !== undefined) {
      throw operationError(
        "The SQLite metadata transaction failed and could not be rolled back.",
        new AggregateError([error, rollbackError], "SQLite transaction and rollback failed."),
      );
    }
    if (error instanceof CancellationRequested) {
      return cancelledResult();
    }
    if (isBusyError(error)) {
      return lockedResult();
    }
    throw operationError("The SQLite metadata transaction failed.", error);
  }
}

async function readSupportedSchema(
  database: sqlite3.Database,
): Promise<SupportedSchema> {
  const versionRow = await getRow<{ user_version: number }>(
    database,
    "PRAGMA user_version",
  );
  if (versionRow?.user_version !== supportedSchemaVersion) {
    throw new SqliteError(
      "unknown-schema",
      `Unsupported Codex state database schema version: ${String(versionRow?.user_version)}.`,
    );
  }

  const table = await getRow<{ type: string }>(
    database,
    "SELECT type FROM sqlite_master WHERE name = 'threads' AND type = 'table'",
  );
  if (!table) {
    throw new SqliteError(
      "missing-table",
      "The supported Codex state database must contain a threads table.",
    );
  }

  const columns = await allRows<TableInfoRow>(
    database,
    "PRAGMA table_info(threads)",
  );
  const idColumn = columns.find((column) => column.name === "id");
  const providerColumn = columns.find((column) => column.name === "model_provider");
  if (!idColumn || !providerColumn) {
    throw new SqliteError(
      "missing-column",
      "The supported threads table must contain id and model_provider columns.",
    );
  }
  if (!isTextColumn(idColumn) || !isTextColumn(providerColumn)) {
    throw new SqliteError(
      "invalid-column-type",
      "The supported threads id and model_provider columns must be declared TEXT.",
    );
  }

  return {
    hasEncryptedContent: columns.some((column) => column.name === "encrypted_content"),
  };
}

function isTextColumn(column: TableInfoRow): boolean {
  return column.type.trim().toUpperCase() === "TEXT";
}

function updatedResult(
  changedRowCount: number,
  encryptedContentCount: number,
): SqliteUpdateResult {
  return {
    status: "updated",
    changedRowCount,
    encryptedContentCount,
    warnings:
      encryptedContentCount === 0
        ? []
        : [
            `${encryptedContentCount} thread(s) contain encrypted_content; message bodies were not modified.`,
          ],
  };
}

function lockedResult(): SqliteUpdateResult {
  return {
    status: "locked",
    changedRowCount: 0,
    encryptedContentCount: 0,
    warnings: ["The Codex state database is locked; no provider metadata was changed."],
  };
}

function cancelledResult(): SqliteUpdateResult {
  return {
    status: "cancelled",
    changedRowCount: 0,
    encryptedContentCount: 0,
    warnings: ["SQLite provider metadata update was cancelled; no provider metadata was changed."],
  };
}

function assertTargetProvider(targetProvider: string): void {
  if (typeof targetProvider !== "string" || targetProvider.trim().length === 0) {
    throw new SqliteError(
      "invalid-provider",
      "A non-empty target provider is required.",
    );
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CancellationRequested();
  }
}

function operationError(message: string, cause: unknown): SqliteError {
  return new SqliteError("operation-failed", message, { cause });
}

function isBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; errno?: unknown };
  return (
    candidate.code === "SQLITE_BUSY" ||
    candidate.code === "SQLITE_LOCKED" ||
    candidate.errno === sqlite3.BUSY ||
    candidate.errno === sqlite3.LOCKED
  );
}

function finishOperation<T>(
  result: T | undefined,
  primaryError: unknown,
  closeError: unknown,
): T {
  if (primaryError !== undefined && closeError !== undefined) {
    if (primaryError instanceof SqliteError) {
      throw new SqliteError(primaryError.code, primaryError.message, {
        cause: new AggregateError(
          [primaryError, closeError],
          "SQLite operation and database close both failed.",
        ),
      });
    }
    throw new SqliteError(
      "operation-failed",
      "SQLite operation and database close both failed.",
      { cause: new AggregateError([primaryError, closeError]) },
    );
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
  if (closeError !== undefined) {
    throw new SqliteError(
      "operation-failed",
      "The SQLite database could not be closed.",
      { cause: closeError },
    );
  }
  return result as T;
}

function openDatabase(path: string, mode: number): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    let database: sqlite3.Database;
    try {
      database = new sqlite3.Database(path, mode, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve(database);
        }
      });
    } catch (error: unknown) {
      reject(error);
    }
  });
}

function closeDatabase(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    database.close((error) => (error ? reject(error) : resolve()));
  });
}

function runStatement(
  database: sqlite3.Database,
  sql: string,
  ...params: unknown[]
): Promise<RunDetails> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function (error) {
      if (error) {
        reject(error);
      } else {
        resolve({ changes: this.changes, lastID: this.lastID });
      }
    });
  });
}

function getRow<T>(database: sqlite3.Database, sql: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    database.get<T>(sql, (error, row) => (error ? reject(error) : resolve(row)));
  });
}

function allRows<T>(database: sqlite3.Database, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all<T>(sql, (error, rows) => (error ? reject(error) : resolve(rows)));
  });
}

async function readCount(database: sqlite3.Database, sql: string): Promise<number> {
  const row = await getRow<CountRow>(database, sql);
  return row?.count ?? 0;
}
