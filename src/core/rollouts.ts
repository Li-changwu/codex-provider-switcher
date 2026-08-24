import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import {
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CodexLayout } from "./types";

const rolloutChangeProvenance = new WeakSet<object>();
type ProvenancedRolloutChange = RolloutChange;

export interface RolloutReplacement {
  line: number;
  start: number;
  end: number;
  value: string;
}

export interface RolloutChange {
  path: string;
  sessionId: string;
  beforeProvider: string | null;
  afterProvider: string;
  encryptedContent: boolean;
  contentHash: string;
  replacements: readonly RolloutReplacement[];
}

export interface RolloutScanResult {
  changes: RolloutChange[];
  encryptedContentCount: number;
  warnings: string[];
}

export interface ApplyResult {
  applied: number;
  encryptedContentCount: number;
  warnings: string[];
}

export interface RolloutApplyOptions {
  beforeRename?: (change: RolloutChange, temporaryPath: string) => void | Promise<void>;
}

export type RolloutValidationErrorCode =
  | "unsupported-layout"
  | "malformed-jsonl"
  | "missing-session-id"
  | "unsupported-provider-metadata"
  | "change-mismatch";

export class RolloutValidationError extends Error {
  constructor(
    readonly code: RolloutValidationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RolloutValidationError";
  }
}

export class RolloutPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RolloutPersistenceError";
  }
}

export class RolloutCancelledError extends Error {
  readonly code = "cancelled";

  constructor() {
    super("Rollout synchronization was cancelled.");
    this.name = "AbortError";
  }
}

export async function collectRolloutChanges(
  layout: CodexLayout,
  targetProvider: string,
): Promise<RolloutChange[]> {
  return (await scanRollouts(layout, targetProvider)).changes;
}

export async function scanRollouts(
  layout: CodexLayout,
  targetProvider: string,
): Promise<RolloutScanResult> {
  assertProvider(targetProvider);
  const changes: RolloutChange[] = [];
  const sessionIds = new Set<string>();
  let encryptedContentCount = 0;

  for (const path of await findRolloutFiles(layout)) {
    const observed = await scanRolloutFile(path, targetProvider);
    if (sessionIds.has(observed.sessionId)) {
      throw new RolloutValidationError(
        "unsupported-layout",
        `Session ${observed.sessionId} appears in more than one rollout: ${path}`,
      );
    }
    sessionIds.add(observed.sessionId);
    if (observed.encryptedContent) {
      encryptedContentCount += 1;
    }
    if (observed.change) {
      changes.push(observed.change);
    }
  }

  return {
    changes,
    encryptedContentCount,
    warnings:
      encryptedContentCount === 0
        ? []
        : [
            `${encryptedContentCount} rollout file(s) contain encrypted_content; message bodies were not modified.`,
          ],
  };
}

export async function applyRolloutChanges(
  changes: readonly RolloutChange[],
  signal?: AbortSignal,
  options: RolloutApplyOptions = {},
): Promise<ApplyResult> {
  validateChangeList(changes);
  let applied = 0;
  let encryptedContentCount = 0;

  for (const change of changes) {
    if (change.encryptedContent) {
      encryptedContentCount += 1;
    }
    await rewriteRollout(change, signal, options);
    applied += 1;
  }

  return {
    applied,
    encryptedContentCount,
    warnings:
      encryptedContentCount === 0
        ? []
        : [
            `${encryptedContentCount} rollout file(s) contain encrypted_content; message bodies were not modified.`,
          ],
  };
}

interface ObservedRollout {
  sessionId: string;
  encryptedContent: boolean;
  change?: ProvenancedRolloutChange;
}

interface JsonlLine {
  line: string;
  separator: "\n" | "\r\n" | "";
}

interface RootProperty {
  name: string;
  valueStart: number;
  valueEnd: number;
}

async function findRolloutFiles(layout: CodexLayout): Promise<string[]> {
  for (const root of [layout.sessionsDir, layout.archivedSessionsDir]) {
    let rootStat;
    try {
      rootStat = await stat(root);
    } catch (error: unknown) {
      throw new RolloutValidationError(
        "unsupported-layout",
        "Codex rollout directories could not be inspected.",
        { cause: error },
      );
    }
    if (!rootStat.isDirectory()) {
      throw new RolloutValidationError(
        "unsupported-layout",
        "Codex rollout paths must be directories.",
      );
    }
  }

  return [
    ...(await listJsonlFiles(layout.sessionsDir)),
    ...(await listJsonlFiles(layout.archivedSessionsDir)),
  ];
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const entries = (await readdir(root, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(path)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

async function scanRolloutFile(
  path: string,
  targetProvider: string,
): Promise<ObservedRollout> {
  const hash = createHash("sha256");
  let lineNumber = 0;
  let sessionId: string | undefined;
  const sessionIds = new Set<string>();
  let beforeProvider: string | null | undefined;
  let providerSeen = false;
  let encryptedContent = false;
  const replacements: RolloutReplacement[] = [];

  for await (const entry of readJsonlLines(path, (chunk) => hash.update(chunk, "utf8"))) {
    const record = parseJsonLine(path, lineNumber, entry.line);
    const properties = scanRootProperties(path, lineNumber, entry.line);
    assertUniqueRootKeys(path, lineNumber, properties);
    if (properties.some((property) => property.name === "session_id" || property.name === "provider")) {
      throw new RolloutValidationError(
        "unsupported-layout",
        `Rollout uses unsupported root session/provider metadata: ${path}`,
      );
    }
    if (containsNestedProvider(record)) {
      throw new RolloutValidationError(
        "unsupported-layout",
        `Rollout contains provider metadata outside the root object: ${path}`,
      );
    }

    if (record.type === "session_meta") {
      const payloadProperty = properties.find((property) => property.name === "payload");
      const payload = record.payload;
      if (!payloadProperty || !isRecord(payload)) {
        throw new RolloutValidationError(
          "unsupported-layout",
          `Rollout session_meta has no object payload: ${path}`,
        );
      }

      const payloadProperties = scanObjectProperties(
        path,
        lineNumber,
        entry.line,
        payloadProperty.valueStart,
      );
      assertUniqueRootKeys(path, lineNumber, payloadProperties);
      const id = payload.id;
      if (typeof id !== "string" || id.length === 0) {
        throw new RolloutValidationError(
          "missing-session-id",
          `Rollout session_meta has no valid payload.id: ${path}`,
        );
      }
      sessionId ??= id;
      sessionIds.add(id);
      if (sessionIds.size > 1) {
        throw new RolloutValidationError(
          "unsupported-layout",
          `Rollout contains more than one session ID: ${path}`,
        );
      }

      const providerProperty = payloadProperties.find(
        (property) => property.name === "model_provider",
      );
      if (providerProperty) {
        const value = payload.model_provider;
        if (value !== null && typeof value !== "string") {
          throw new RolloutValidationError(
            "unsupported-provider-metadata",
            `Rollout model_provider is not a string or null: ${path}`,
          );
        }
        if (!providerSeen) {
          beforeProvider = value;
          providerSeen = true;
        }
        if (value !== targetProvider) {
          replacements.push({
            line: lineNumber,
            start: providerProperty.valueStart,
            end: providerProperty.valueEnd,
            value: JSON.stringify(targetProvider),
          });
        }
      }
    }

    encryptedContent ||= hasEncryptedContent(record);
    lineNumber += 1;
  }

  if (sessionId === undefined) {
    throw new RolloutValidationError(
      "missing-session-id",
      `Rollout does not contain a session_meta event: ${path}`,
    );
  }

  const contentHash = hash.digest("hex");
  return {
    sessionId,
    encryptedContent,
    change:
      replacements.length === 0
        ? undefined
        : brandChange({
            path,
            sessionId,
            beforeProvider: beforeProvider ?? null,
            afterProvider: targetProvider,
            encryptedContent,
            contentHash,
            replacements,
          }),
  };
}

function brandChange(change: RolloutChange): ProvenancedRolloutChange {
  const branded = {
    ...change,
    replacements: Object.freeze([...change.replacements]),
  } as ProvenancedRolloutChange;
  rolloutChangeProvenance.add(branded);
  return Object.freeze(branded);
}

function isProvenancedChange(value: unknown): value is ProvenancedRolloutChange {
  return isRecord(value) && rolloutChangeProvenance.has(value);
}

function validateChangeList(changes: readonly RolloutChange[]): void {
  const seenPaths = new Set<string>();
  for (const candidate of changes) {
    if (!isProvenancedChange(candidate)) {
      throw new RolloutValidationError(
        "change-mismatch",
        "Rollout change was not produced by the current scan.",
      );
    }
    const change = candidate;
    if (seenPaths.has(change.path)) {
      throw new RolloutValidationError(
        "change-mismatch",
        `Rollout change list contains a duplicate path: ${change.path}`,
      );
    }
    seenPaths.add(change.path);
    assertProvider(change.afterProvider);
    if (!/^[a-f0-9]{64}$/.test(change.contentHash)) {
      throw new RolloutValidationError(
        "change-mismatch",
        `Rollout change has no valid preflight hash: ${change.path}`,
      );
    }
    if (!Array.isArray(change.replacements) || change.replacements.length === 0) {
      throw new RolloutValidationError(
        "change-mismatch",
        `Rollout change has no provider replacement: ${change.path}`,
      );
    }
  }
}

async function rewriteRollout(
  change: RolloutChange,
  signal: AbortSignal | undefined,
  options: RolloutApplyOptions,
): Promise<void> {
  throwIfAborted(signal);
  const temporaryPath = join(
    dirname(change.path),
    `.${basename(change.path)}.tmp-${randomUUID()}`,
  );
  let renamed = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    throwIfAborted(signal);
    handle = await open(temporaryPath, "w");
    const hash = createHash("sha256");
    const replacements = [...change.replacements].sort((left, right) => left.line - right.line);
    let replacementIndex = 0;
    let lineNumber = 0;

    for await (const entry of readJsonlLines(change.path, (chunk) => hash.update(chunk, "utf8"))) {
      let output = entry.line;
      while (replacementIndex < replacements.length && replacements[replacementIndex].line === lineNumber) {
        const replacement = replacements[replacementIndex];
        if (
          replacement.start < 0 ||
          replacement.end < replacement.start ||
          replacement.end > output.length
        ) {
          throw new RolloutValidationError(
            "change-mismatch",
            `Rollout replacement range is invalid: ${change.path}`,
          );
        }
        output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
        replacementIndex += 1;
      }
      throwIfAborted(signal);
      await handle.write(`${output}${entry.separator}`, undefined, "utf8");
      lineNumber += 1;
    }

    if (replacementIndex !== replacements.length || hash.digest("hex") !== change.contentHash) {
      throw new RolloutValidationError(
        "change-mismatch",
        `Rollout changed after scanning; refusing to rewrite: ${change.path}`,
      );
    }
    await handle.close();
    handle = undefined;
    await options.beforeRename?.(change, temporaryPath);
    throwIfAborted(signal);
    await rename(temporaryPath, change.path);
    renamed = true;
  } catch (error: unknown) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original write or validation error.
      }
    }
    let cleanupError: unknown;
    if (!renamed) {
      try {
        await removeTemporaryFile(temporaryPath);
      } catch (error: unknown) {
        cleanupError = error;
      }
    }
    if (cleanupError !== undefined) {
      throw new RolloutPersistenceError(
        `Could not rewrite rollout file: ${change.path}`,
        {
          cause: new AggregateError(
            [error, cleanupError],
            "Rollout write and temporary cleanup both failed.",
          ),
        },
      );
    }
    throw error;
  }
}

function parseJsonLine(path: string, lineNumber: number, line: string): Record<string, unknown> {
  if (!line.trim()) {
    throw new RolloutValidationError(
      "malformed-jsonl",
      `Rollout contains an empty JSONL record at line ${lineNumber + 1}: ${path}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error: unknown) {
    throw new RolloutValidationError(
      "malformed-jsonl",
      `Rollout contains malformed JSON at line ${lineNumber + 1}: ${path}`,
      { cause: error },
    );
  }
  if (!isRecord(value)) {
    throw new RolloutValidationError(
      "unsupported-layout",
      `Rollout JSONL records must be objects at line ${lineNumber + 1}: ${path}`,
    );
  }
  return value;
}

function scanRootProperties(path: string, lineNumber: number, line: string): RootProperty[] {
  return scanObjectProperties(path, lineNumber, line, 0);
}

function scanObjectProperties(
  path: string,
  lineNumber: number,
  line: string,
  objectStart: number,
): RootProperty[] {
  const properties: RootProperty[] = [];
  let cursor = skipWhitespace(line, objectStart);
  if (line[cursor] !== "{") {
    throw new RolloutValidationError(
      "unsupported-layout",
      `Rollout JSONL records must be objects at line ${lineNumber + 1}: ${path}`,
    );
  }
  cursor = skipWhitespace(line, cursor + 1);
  if (line[cursor] === "}") {
    return properties;
  }

  while (cursor < line.length) {
    const keyStart = cursor;
    const keyEnd = scanJsonStringEnd(line, keyStart);
    const name = JSON.parse(line.slice(keyStart, keyEnd)) as string;
    cursor = skipWhitespace(line, keyEnd);
    if (line[cursor] !== ":") {
      throw new RolloutValidationError(
        "unsupported-layout",
        `Rollout object property is malformed at line ${lineNumber + 1}: ${path}`,
      );
    }
    const valueStart = skipWhitespace(line, cursor + 1);
    const valueEnd = skipJsonValue(line, valueStart);
    properties.push({ name, valueStart, valueEnd });
    cursor = skipWhitespace(line, valueEnd);
    if (line[cursor] === "}") {
      return properties;
    }
    if (line[cursor] !== ",") {
      throw new RolloutValidationError(
        "unsupported-layout",
        `Rollout object properties are malformed at line ${lineNumber + 1}: ${path}`,
      );
    }
    cursor = skipWhitespace(line, cursor + 1);
  }

  throw new RolloutValidationError(
    "unsupported-layout",
    `Rollout object is not closed at line ${lineNumber + 1}: ${path}`,
  );
}

function assertUniqueRootKeys(path: string, lineNumber: number, properties: RootProperty[]): void {
  const names = new Set<string>();
  for (const property of properties) {
    if (names.has(property.name)) {
      throw new RolloutValidationError(
        "unsupported-layout",
        `Rollout contains duplicate root property ${property.name} at line ${lineNumber + 1}: ${path}`,
      );
    }
    names.add(property.name);
  }
}

function skipJsonValue(line: string, start: number): number {
  const marker = line[start];
  if (marker === '"') {
    return scanJsonStringEnd(line, start);
  }
  if (marker === "{") {
    let cursor = skipWhitespace(line, start + 1);
    if (line[cursor] === "}") {
      return cursor + 1;
    }
    while (cursor < line.length) {
      cursor = scanJsonStringEnd(line, cursor);
      cursor = skipWhitespace(line, cursor);
      cursor += 1;
      cursor = skipWhitespace(line, cursor);
      cursor = skipJsonValue(line, cursor);
      cursor = skipWhitespace(line, cursor);
      if (line[cursor] === "}") {
        return cursor + 1;
      }
      cursor = skipWhitespace(line, cursor + 1);
    }
  }
  if (marker === "[") {
    let cursor = skipWhitespace(line, start + 1);
    if (line[cursor] === "]") {
      return cursor + 1;
    }
    while (cursor < line.length) {
      cursor = skipJsonValue(line, cursor);
      cursor = skipWhitespace(line, cursor);
      if (line[cursor] === "]") {
        return cursor + 1;
      }
      cursor = skipWhitespace(line, cursor + 1);
    }
  }
  let cursor = start;
  while (cursor < line.length && !/[\s,}\]]/.test(line[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function scanJsonStringEnd(line: string, start: number): number {
  if (line[start] !== '"') {
    throw new Error("Expected a JSON string.");
  }
  for (let cursor = start + 1; cursor < line.length; cursor += 1) {
    if (line[cursor] === "\\") {
      cursor += 1;
    } else if (line[cursor] === '"') {
      return cursor + 1;
    }
  }
  throw new Error("Unterminated JSON string.");
}

function skipWhitespace(line: string, start: number): number {
  let cursor = start;
  while (cursor < line.length && /\s/.test(line[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function containsNestedProvider(value: unknown, depth = 0): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsNestedProvider(item, depth));
  }
  if (!isRecord(value)) {
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (depth > 0 && key === "provider") {
      return true;
    }
    if (containsNestedProvider(child, depth + 1)) {
      return true;
    }
  }
  return false;
}

function hasEncryptedContent(value: Record<string, unknown>): boolean {
  if (typeof value.encrypted_content === "string") {
    return true;
  }
  return isRecord(value.data) && typeof value.data.encrypted_content === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertProvider(provider: string): void {
  if (typeof provider !== "string" || !provider.trim()) {
    throw new RolloutValidationError(
      "unsupported-provider-metadata",
      "A non-empty target provider is required.",
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RolloutCancelledError();
  }
}

async function* readJsonlLines(
  path: string,
  onChunk?: (chunk: string) => void,
): AsyncGenerator<JsonlLine> {
  const input = createReadStream(path, { encoding: "utf8" });
  let pending = "";
  try {
    for await (const chunk of input as AsyncIterable<string>) {
      onChunk?.(chunk);
      pending += chunk;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        const rawLine = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        if (rawLine.endsWith("\r")) {
          yield { line: rawLine.slice(0, -1), separator: "\r\n" };
        } else {
          yield { line: rawLine, separator: "\n" };
        }
        newlineIndex = pending.indexOf("\n");
      }
    }
    if (pending.length > 0) {
      yield { line: pending, separator: "" };
    }
  } finally {
    input.destroy();
  }
}

async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
