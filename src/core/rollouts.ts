import { createHash, randomUUID } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import {
  lstat,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { CodexLayout } from "./types";

const rolloutChangeProvenance = new WeakSet<object>();
const rolloutChangeSnapshots = new WeakMap<object, RolloutChangeSnapshot>();
const rolloutChangeMutationAttempts = new WeakSet<object>();
const trustedSessionIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
type ProvenancedRolloutChange = RolloutChange;

/** Maximum encoded bytes in one JSONL record, excluding its LF or CRLF separator. */
export const MAX_JSONL_RECORD_BYTES = 8 * 1024 * 1024;

export interface RolloutReplacement {
  line: number;
  start: number;
  end: number;
  value: string;
  originalValue: string;
}

export interface RolloutChange {
  path: string;
  sessionId: string;
  beforeProvider: string | null;
  afterProvider: string;
  encryptedContent: boolean;
  contentHash: string;
  postHash: string;
  replacements: readonly RolloutReplacement[];
}

export interface ContinuationSourceAnchor {
  readonly sessionId: string;
  readonly sourceEventHash: string;
}

export interface RolloutInverseReplacement {
  line: number;
  start: number;
  end: number;
  expectedValue: string;
  value: string;
}

export interface RolloutInversePatch {
  version: 1;
  path: string;
  sessionId: string;
  preHash: string;
  postHash: string;
  replacements: readonly RolloutInverseReplacement[];
}

export interface RolloutScanResult {
  changes: RolloutChange[];
  encryptedContentCount: number;
  warnings: string[];
}

export interface RolloutScanProgress {
  completed: number;
  total: number;
}

export interface RolloutScanOptions {
  signal?: AbortSignal;
  onProgress?: (progress: RolloutScanProgress) => void;
}

export interface ApplyResult {
  applied: number;
  encryptedContentCount: number;
  warnings: string[];
}

export interface RolloutApplyOptions {
  beforeReadOpen?: (change: RolloutChange) => void | Promise<void>;
  beforeRename?: (change: RolloutChange, temporaryPath: string) => void | Promise<void>;
  io?: RolloutIo;
}

export interface RolloutIo {
  write?: (
    handle: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
  ) => Promise<number>;
  closeHandle?: (handle: FileHandle) => Promise<void>;
  syncDirectory?: (directoryPath: string) => Promise<void>;
}

export type RolloutValidationErrorCode =
  | "unsupported-layout"
  | "malformed-jsonl"
  | "jsonl-record-too-large"
  | "invalid-utf8"
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
  options?: RolloutScanOptions,
): Promise<RolloutChange[]> {
  return (await scanRollouts(layout, targetProvider, options)).changes;
}

export async function scanRollouts(
  layout: CodexLayout,
  targetProvider: string,
  options: RolloutScanOptions = {},
): Promise<RolloutScanResult> {
  assertProvider(targetProvider);
  throwIfAborted(options.signal);
  const changes: RolloutChange[] = [];
  const sessionIds = new Set<string>();
  let encryptedContentCount = 0;
  const candidates = await findRolloutFiles(layout);

  throwIfAborted(options.signal);

  for (let index = 0; index < candidates.length; index += 1) {
    throwIfAborted(options.signal);
    const candidate = candidates[index];
    const { path } = candidate;
    const observed = await scanRolloutFile(path, targetProvider, candidate.identity);
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
    options.onProgress?.({ completed: index + 1, total: candidates.length });
    throwIfAborted(options.signal);
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

export async function listContinuationSourceAnchors(
  layout: CodexLayout,
): Promise<ContinuationSourceAnchor[]> {
  try {
    const candidates = await findRolloutFiles(layout);
    const sessionIds = new Set<string>();
    const anchors: ContinuationSourceAnchor[] = [];

    for (const candidate of candidates) {
      const anchor = await scanContinuationSourceAnchor(candidate.path, candidate.identity);
      if (sessionIds.has(anchor.sessionId)) {
        throw new RolloutValidationError(
          "unsupported-layout",
          `Session ${anchor.sessionId} appears in more than one rollout: ${candidate.path}`,
        );
      }
      sessionIds.add(anchor.sessionId);
      anchors.push(anchor);
    }

    return anchors.sort((left, right) =>
      left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0,
    );
  } catch (error: unknown) {
    const code = error instanceof RolloutValidationError ? error.code : "unsupported-layout";
    throw new RolloutValidationError(
      code,
      "Continuation source anchors could not be resolved.",
    );
  }
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

export function createRolloutInversePatches(
  changes: readonly RolloutChange[],
): RolloutInversePatch[] {
  validateChangeList(changes);
  return changes.map((change) => {
    const offsets = new Map<number, number>();
    const replacements = [...change.replacements]
      .sort((left, right) => left.line - right.line || left.start - right.start)
      .map((replacement) => {
        const offset = offsets.get(replacement.line) ?? 0;
        const start = replacement.start + offset;
        const end = start + replacement.value.length;
        offsets.set(replacement.line, offset + replacement.value.length - (replacement.end - replacement.start));
        return {
          line: replacement.line,
          start,
          end,
          expectedValue: replacement.value,
          value: replacement.originalValue,
        };
      });
    return {
      version: 1,
      path: change.path,
      sessionId: change.sessionId,
      preHash: change.contentHash,
      postHash: change.postHash,
      replacements,
    };
  });
}

export type RolloutInversePatchValidation = "already-reversed" | "ready";

export async function validateRolloutInversePatch(
  patch: RolloutInversePatch,
  layout: CodexLayout,
  signal?: AbortSignal,
): Promise<RolloutInversePatchValidation> {
  validateInversePatch(patch);
  throwIfAborted(signal);
  const policy = await inspectRolloutPathPolicy(layout);
  const identity = await inspectRolloutFile(patch.path, policy, "unsupported-layout");
  const currentHash = await hashRolloutFile(patch.path, identity);
  if (currentHash === patch.preHash) {
    return "already-reversed";
  }
  if (currentHash !== patch.postHash) {
    throw new RolloutValidationError(
      "change-mismatch",
      `Rollout changed after mutation; refusing to reverse: ${patch.path}`,
    );
  }
  await validateInversePatchTarget(patch, identity);
  return "ready";
}

export async function reverseRolloutInversePatch(
  patch: RolloutInversePatch,
  layout: CodexLayout,
  signal?: AbortSignal,
): Promise<void> {
  const validation = await validateRolloutInversePatch(patch, layout, signal);
  if (validation === "already-reversed") {
    return;
  }
  const policy = await inspectRolloutPathPolicy(layout);
  const identity = await inspectRolloutFile(patch.path, policy, "unsupported-layout");
  await rewriteRolloutFile(
    patch.path,
    patch.postHash,
    patch.preHash,
    patch.replacements,
    signal,
    undefined,
    identity,
  );
}

async function hashRolloutFile(
  path: string,
  identity: RolloutFileIdentity,
): Promise<string> {
  return withVerifiedRolloutHandle(
    path,
    identity,
    "change-mismatch",
    async (sourceHandle) => {
      const hash = createHash("sha256");
      const input = sourceHandle.createReadStream({ autoClose: false });
      try {
        for await (const chunk of input as AsyncIterable<Buffer>) {
          hash.update(chunk);
        }
      } finally {
        input.destroy();
      }
      return hash.digest("hex");
    },
  );
}

interface ObservedRollout {
  sessionId: string;
  encryptedContent: boolean;
  change?: ProvenancedRolloutChange;
}

async function scanContinuationSourceAnchor(
  path: string,
  identity: RolloutFileIdentity,
): Promise<ContinuationSourceAnchor> {
  const hash = createHash("sha256");
  let lineNumber = 0;
  let sessionId: string | undefined;
  let sessionMetaSeen = false;

  await withVerifiedRolloutHandle(
    path,
    identity,
    "unsupported-layout",
    async (sourceHandle) => {
      for await (const entry of readJsonlLines(sourceHandle, path, (chunk) => hash.update(chunk))) {
        const record = parseJsonLine(path, lineNumber, entry.line);
        if (record.type === "session_meta") {
          if (sessionMetaSeen) {
            throw new RolloutValidationError(
              "unsupported-layout",
              `Rollout contains duplicate session_meta records: ${path}`,
            );
          }
          sessionMetaSeen = true;

          const properties = scanRootProperties(path, lineNumber, entry.line);
          assertUniqueRootKeys(path, lineNumber, properties);
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
          if (
            typeof payload.id !== "string" ||
            !trustedSessionIdentifierPattern.test(payload.id)
          ) {
            throw new RolloutValidationError(
              "missing-session-id",
              `Rollout session_meta has no valid payload.id: ${path}`,
            );
          }
          sessionId = payload.id;
        }
        lineNumber += 1;
      }
    },
  );

  if (sessionId === undefined) {
    throw new RolloutValidationError(
      "missing-session-id",
      `Rollout does not contain a session_meta event: ${path}`,
    );
  }

  return { sessionId, sourceEventHash: hash.digest("hex").toLowerCase() };
}

interface RolloutChangeSnapshot {
  path: string;
  sessionId: string;
  beforeProvider: string | null;
  afterProvider: string;
  encryptedContent: boolean;
  contentHash: string;
  postHash: string;
  identity: RolloutFileIdentity;
  replacementsRef: readonly RolloutReplacement[];
  replacements: readonly RolloutReplacement[];
}

interface RolloutRootIdentity {
  path: string;
  realPath: string;
  dev: bigint;
  ino: bigint;
}

interface RolloutPathPolicy {
  codexHomePath: string;
  codexHomeRealPath: string;
  roots: readonly RolloutRootIdentity[];
}

interface RolloutFileIdentity {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  mode?: number;
  realPath: string;
  policy: RolloutPathPolicy;
}

interface RolloutCandidate {
  path: string;
  identity: RolloutFileIdentity;
}

interface JsonlLine {
  bytes: Buffer;
  line: string;
  separator: Buffer;
}

interface RootProperty {
  name: string;
  valueStart: number;
  valueEnd: number;
}

async function findRolloutFiles(layout: CodexLayout): Promise<RolloutCandidate[]> {
  const policy = await inspectRolloutPathPolicy(layout);
  const paths = [
    ...(await listJsonlFiles(layout.sessionsDir)),
    ...(await listJsonlFiles(layout.archivedSessionsDir)),
  ];
  return Promise.all(
    paths.map(async (path) => ({
      path,
      identity: await inspectRolloutFile(path, policy, "unsupported-layout"),
    })),
  );
}

async function inspectRolloutPathPolicy(layout: CodexLayout): Promise<RolloutPathPolicy> {
  const codexHomePath = resolve(layout.codexHome);
  let codexHomeRealPath: string;
  try {
    codexHomeRealPath = await realpath(codexHomePath);
  } catch (error: unknown) {
    throw new RolloutValidationError(
      "unsupported-layout",
      "Codex Home could not be inspected.",
      { cause: error },
    );
  }
  const roots: RolloutRootIdentity[] = [];
  for (const root of [layout.sessionsDir, layout.archivedSessionsDir]) {
    try {
      const rootPath = resolve(root);
      if (!isPathInside(codexHomePath, rootPath)) {
        throw new RolloutValidationError(
          "unsupported-layout",
          "Codex rollout directories must remain inside Codex Home.",
        );
      }
      const before = await lstat(rootPath, { bigint: true });
      if (before.isSymbolicLink()) {
        throw new RolloutValidationError(
          "unsupported-layout",
          "Codex rollout directories must not be symbolic links.",
        );
      }
      if (!before.isDirectory()) {
        throw new RolloutValidationError(
          "unsupported-layout",
          "Codex rollout paths must be directories.",
        );
      }
      const rootRealPath = await realpath(rootPath);
      if (!isPathInside(codexHomeRealPath, rootRealPath)) {
        throw new RolloutValidationError(
          "unsupported-layout",
          "Codex rollout directories must remain inside Codex Home.",
        );
      }
      const after = await lstat(rootPath, { bigint: true });
      if (
        after.isSymbolicLink() ||
        !after.isDirectory() ||
        before.dev !== after.dev ||
        before.ino !== after.ino
      ) {
        throw new RolloutValidationError(
          "unsupported-layout",
          "Codex rollout directories changed while being inspected.",
        );
      }
      roots.push({ path: rootPath, realPath: rootRealPath, dev: after.dev, ino: after.ino });
    } catch (error: unknown) {
      if (error instanceof RolloutValidationError) {
        throw error;
      }
      throw new RolloutValidationError(
        "unsupported-layout",
        "Codex rollout directories could not be inspected.",
        { cause: error },
      );
    }
  }

  return { codexHomePath, codexHomeRealPath, roots };
}

function isPathInside(directory: string, candidate: string): boolean {
  const relativePath = relative(resolve(directory), resolve(candidate));
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
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
    } else if (entry.name.toLowerCase().endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

async function inspectRolloutFile(
  path: string,
  policy: RolloutPathPolicy,
  code: "unsupported-layout" | "change-mismatch",
): Promise<RolloutFileIdentity> {
  try {
    await assertRolloutPathPolicy(policy, code);
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
      throw new RolloutValidationError(
        code,
        `Rollout must be a regular, unlinked file: ${path}`,
      );
    }
    const fileRealPath = await realpath(path);
    if (!policy.roots.some((root) => isPathInside(root.realPath, fileRealPath))) {
      throw new RolloutValidationError(
        code,
        `Rollout must remain inside a Codex rollout directory: ${path}`,
      );
    }
    const after = await lstat(path, { bigint: true });
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.nlink !== 1n ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.nlink !== after.nlink ||
      permissionMode(before.mode) !== permissionMode(after.mode)
    ) {
      throw new RolloutValidationError(code, `Rollout changed while being inspected: ${path}`);
    }
    return {
      dev: after.dev,
      ino: after.ino,
      nlink: after.nlink,
      mode: permissionMode(after.mode),
      realPath: fileRealPath,
      policy,
    };
  } catch (error: unknown) {
    if (error instanceof RolloutValidationError) {
      throw error;
    }
    throw new RolloutValidationError(code, `Rollout path could not be inspected: ${path}`, {
      cause: error,
    });
  }
}

async function assertRolloutPathPolicy(
  policy: RolloutPathPolicy,
  code: "unsupported-layout" | "change-mismatch",
): Promise<void> {
  const codexHomeRealPath = await realpath(policy.codexHomePath);
  if (codexHomeRealPath !== policy.codexHomeRealPath) {
    throw new RolloutValidationError(code, "Codex Home changed after rollout preflight.");
  }
  for (const expected of policy.roots) {
    const stat = await lstat(expected.path, { bigint: true });
    const rootRealPath = await realpath(expected.path);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      rootRealPath !== expected.realPath ||
      !isPathInside(codexHomeRealPath, rootRealPath)
    ) {
      throw new RolloutValidationError(code, "Codex rollout directories changed after preflight.");
    }
  }
}

async function assertRolloutIdentity(
  path: string,
  expected: RolloutFileIdentity,
  code: "unsupported-layout" | "change-mismatch",
): Promise<void> {
  const current = await inspectRolloutFile(path, expected.policy, code);
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.nlink !== expected.nlink ||
    current.mode !== expected.mode ||
    current.realPath !== expected.realPath
  ) {
    throw new RolloutValidationError(code, `Rollout identity changed after preflight: ${path}`);
  }
}

async function withVerifiedRolloutHandle<T>(
  path: string,
  expected: RolloutFileIdentity,
  code: "unsupported-layout" | "change-mismatch",
  operation: (handle: FileHandle) => Promise<T>,
  beforeOpen?: () => void | Promise<void>,
  closeHandle: (handle: FileHandle) => Promise<void> = defaultCloseHandle,
): Promise<T> {
  await assertRolloutIdentity(path, expected, code);
  await beforeOpen?.();
  let handle: FileHandle | undefined;
  let result: T | undefined;
  let primaryError: unknown;
  let operationFailed = false;
  try {
    handle = await open(path, "r");
    await assertOpenRolloutHandleIdentity(handle, path, expected, code);
    result = await operation(handle);
    await assertRolloutIdentity(path, expected, code);
  } catch (error: unknown) {
    operationFailed = true;
    primaryError = error;
  }

  let closeError: unknown;
  if (handle) {
    try {
      await closeHandle(handle);
    } catch (error: unknown) {
      closeError = error;
    }
  }

  if (operationFailed && closeError !== undefined) {
    const cause = new AggregateError(
      [primaryError, closeError],
      "Rollout operation and handle close both failed.",
    );
    if (primaryError instanceof RolloutValidationError) {
      throw new RolloutValidationError(primaryError.code, primaryError.message, { cause });
    }
    throw new RolloutValidationError(
      code,
      `Rollout could not be safely opened: ${path}`,
      { cause },
    );
  }
  if (operationFailed) {
    if (primaryError instanceof RolloutValidationError) {
      throw primaryError;
    }
    throw new RolloutValidationError(code, `Rollout could not be safely opened: ${path}`, {
      cause: primaryError,
    });
  }
  if (closeError !== undefined) {
    throw new RolloutValidationError(code, `Rollout handle could not be safely closed: ${path}`, {
      cause: closeError,
    });
  }
  return result as T;
}

async function defaultCloseHandle(handle: FileHandle): Promise<void> {
  await handle.close();
}

async function assertOpenRolloutHandleIdentity(
  handle: FileHandle,
  path: string,
  expected: RolloutFileIdentity,
  code: "unsupported-layout" | "change-mismatch",
): Promise<void> {
  const current = await handle.stat({ bigint: true });
  if (
    !current.isFile() ||
    current.nlink !== 1n ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.nlink !== expected.nlink ||
    permissionMode(current.mode) !== expected.mode
  ) {
    throw new RolloutValidationError(code, `Rollout opened as a different file: ${path}`);
  }
}

function permissionMode(mode: bigint): number | undefined {
  return process.platform === "win32" ? undefined : Number(mode & 0o7777n);
}

async function scanRolloutFile(
  path: string,
  targetProvider: string,
  identity: RolloutFileIdentity,
): Promise<ObservedRollout> {
  const hash = createHash("sha256");
  let lineNumber = 0;
  let sessionId: string | undefined;
  const sessionIds = new Set<string>();
  let beforeProvider: string | null | undefined;
  let providerSeen = false;
  let sessionMetaSeen = false;
  let encryptedContent = false;
  const replacements: RolloutReplacement[] = [];
  const postHash = createHash("sha256");

  await withVerifiedRolloutHandle(
    path,
    identity,
    "unsupported-layout",
    async (sourceHandle) => {
  for await (const entry of readJsonlLines(sourceHandle, path, (chunk) => hash.update(chunk))) {
    const record = parseJsonLine(path, lineNumber, entry.line);
    const properties = scanRootProperties(path, lineNumber, entry.line);
    assertUniqueRootKeys(path, lineNumber, properties);
    if (properties.some((property) => property.name === "session_id" || property.name === "provider")) {
      throw new RolloutValidationError(
        "unsupported-layout",
        `Rollout uses unsupported root session/provider metadata: ${path}`,
      );
    }
    const allowedModelProviderContainer =
      record.type === "session_meta" && isRecord(record.payload)
        ? record.payload
        : undefined;
    if (containsDisallowedModelProvider(record, allowedModelProviderContainer)) {
      throw new RolloutValidationError(
        "unsupported-layout",
        `Rollout contains model_provider outside session_meta.payload: ${path}`,
      );
    }
    if (containsNestedProvider(record)) {
      throw new RolloutValidationError(
        "unsupported-layout",
        `Rollout contains provider metadata outside the root object: ${path}`,
      );
    }

    if (record.type === "session_meta") {
      if (sessionMetaSeen) {
        throw new RolloutValidationError(
          "unsupported-layout",
          `Rollout contains duplicate session_meta records: ${path}`,
        );
      }
      sessionMetaSeen = true;
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
        if (value !== null && !isProviderIdentifier(value)) {
          throw new RolloutValidationError(
            "unsupported-provider-metadata",
            `Rollout model_provider is not a valid provider identifier or null: ${path}`,
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
            originalValue: entry.line.slice(providerProperty.valueStart, providerProperty.valueEnd),
          });
        }
      }
    }

    encryptedContent ||= hasEncryptedContent(record);
    const lineReplacements = replacements.filter((replacement) => replacement.line === lineNumber);
    postHash.update(applyLineReplacements(entry, lineReplacements));
    postHash.update(entry.separator);
    lineNumber += 1;
  }
    },
  );

  if (sessionId === undefined) {
    throw new RolloutValidationError(
      "missing-session-id",
      `Rollout does not contain a session_meta event: ${path}`,
    );
  }

  const contentHash = hash.digest("hex");
  const outputHash = postHash.digest("hex");
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
            postHash: outputHash,
            replacements,
          }, identity),
  };
}

function brandChange(
  change: RolloutChange,
  identity: RolloutFileIdentity,
): ProvenancedRolloutChange {
  const snapshotReplacements = Object.freeze(
    change.replacements.map((replacement) => Object.freeze({ ...replacement })),
  );
  const exposedReplacements = Object.freeze(
    snapshotReplacements.map((replacement) => createFrozenReplacement(replacement)),
  );
  const branded = {
    ...change,
    replacements: exposedReplacements,
  } as ProvenancedRolloutChange;
  rolloutChangeProvenance.add(branded);
  rolloutChangeSnapshots.set(branded, {
    path: branded.path,
    sessionId: branded.sessionId,
    beforeProvider: branded.beforeProvider,
    afterProvider: branded.afterProvider,
    encryptedContent: branded.encryptedContent,
    contentHash: branded.contentHash,
    postHash: branded.postHash,
    identity,
    replacementsRef: exposedReplacements,
    replacements: snapshotReplacements,
  });
  return Object.freeze(branded);
}

function createFrozenReplacement(replacement: RolloutReplacement): RolloutReplacement {
  const target = Object.freeze({ ...replacement });
  let proxy: RolloutReplacement;
  proxy = new Proxy(target, {
    deleteProperty() {
      rolloutChangeMutationAttempts.add(proxy);
      throw new TypeError("Rollout replacements are immutable.");
    },
    set() {
      rolloutChangeMutationAttempts.add(proxy);
      throw new TypeError("Rollout replacements are immutable.");
    },
  });
  return proxy;
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
    assertChangeSnapshot(change);
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
    if (!/^[a-f0-9]{64}$/.test(change.postHash)) {
      throw new RolloutValidationError(
        "change-mismatch",
        `Rollout change has no valid post-mutation hash: ${change.path}`,
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

function validateInversePatch(patch: RolloutInversePatch): void {
  if (
    patch.version !== 1 ||
    typeof patch.path !== "string" ||
    !patch.path ||
    typeof patch.sessionId !== "string" ||
    !patch.sessionId ||
    !/^[a-f0-9]{64}$/.test(patch.preHash) ||
    !/^[a-f0-9]{64}$/.test(patch.postHash) ||
    !Array.isArray(patch.replacements) ||
    patch.replacements.length !== 1
  ) {
    throw new RolloutValidationError("change-mismatch", "Rollout inverse patch is invalid.");
  }
  for (const replacement of patch.replacements) {
    if (
      !Number.isSafeInteger(replacement.line) ||
      replacement.line < 0 ||
      !Number.isSafeInteger(replacement.start) ||
      replacement.start < 0 ||
      !Number.isSafeInteger(replacement.end) ||
      replacement.end < replacement.start ||
      !isProviderMetadataToken(replacement.expectedValue) ||
      !isProviderMetadataToken(replacement.value)
    ) {
      throw new RolloutValidationError("change-mismatch", "Rollout inverse patch is invalid.");
    }
  }
}

async function validateInversePatchTarget(
  patch: RolloutInversePatch,
  identity: RolloutFileIdentity,
): Promise<void> {
  const replacement = patch.replacements[0];
  let lineNumber = 0;

  try {
    const found = await withVerifiedRolloutHandle(
      patch.path,
      identity,
      "change-mismatch",
      async (sourceHandle) => {
    for await (const entry of readJsonlLines(sourceHandle, patch.path)) {
      if (lineNumber === replacement.line) {
        const record = parseJsonLine(patch.path, lineNumber, entry.line);
        const properties = scanRootProperties(patch.path, lineNumber, entry.line);
        assertUniqueRootKeys(patch.path, lineNumber, properties);
        if (record.type !== "session_meta" || !isRecord(record.payload)) {
          throw new RolloutValidationError(
            "change-mismatch",
            `Rollout inverse patch does not target session metadata: ${patch.path}`,
          );
        }

        const payloadProperty = properties.find((property) => property.name === "payload");
        if (!payloadProperty) {
          throw new RolloutValidationError(
            "change-mismatch",
            `Rollout inverse patch has no session metadata payload: ${patch.path}`,
          );
        }
        const payloadProperties = scanObjectProperties(
          patch.path,
          lineNumber,
          entry.line,
          payloadProperty.valueStart,
        );
        assertUniqueRootKeys(patch.path, lineNumber, payloadProperties);
        if (record.payload.id !== patch.sessionId) {
          throw new RolloutValidationError(
            "change-mismatch",
            `Rollout inverse patch session does not match: ${patch.path}`,
          );
        }

        const providerProperty = payloadProperties.find(
          (property) => property.name === "model_provider",
        );
        if (
          !providerProperty ||
          providerProperty.valueStart !== replacement.start ||
          providerProperty.valueEnd !== replacement.end ||
          entry.line.slice(replacement.start, replacement.end) !== replacement.expectedValue
        ) {
          throw new RolloutValidationError(
            "change-mismatch",
            `Rollout inverse patch does not target model provider metadata: ${patch.path}`,
          );
        }
        return true;
      }
      lineNumber += 1;
    }
        return false;
      },
    );
    if (found) {
      return;
    }
  } catch (error: unknown) {
    if (error instanceof RolloutValidationError && error.code === "change-mismatch") {
      throw error;
    }
    throw new RolloutValidationError(
      "change-mismatch",
      `Rollout inverse patch could not validate its target: ${patch.path}`,
      { cause: error },
    );
  }

  throw new RolloutValidationError(
    "change-mismatch",
    `Rollout inverse patch target line does not exist: ${patch.path}`,
  );
}

function isProviderMetadataToken(value: unknown): value is string {
  if (value === "null") {
    return true;
  }
  if (typeof value !== "string" || !value || /\s/.test(value)) {
    return false;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isProviderIdentifier(parsed);
  } catch {
    return false;
  }
}

function assertChangeSnapshot(change: ProvenancedRolloutChange): void {
  const snapshot = rolloutChangeSnapshots.get(change);
  if (
    !snapshot ||
    change.path !== snapshot.path ||
    change.sessionId !== snapshot.sessionId ||
    change.beforeProvider !== snapshot.beforeProvider ||
    change.afterProvider !== snapshot.afterProvider ||
    change.encryptedContent !== snapshot.encryptedContent ||
    change.contentHash !== snapshot.contentHash ||
    change.postHash !== snapshot.postHash ||
    change.replacements !== snapshot.replacementsRef ||
    change.replacements.length !== snapshot.replacements.length
  ) {
    throw new RolloutValidationError(
      "change-mismatch",
      `Rollout change was modified after scanning: ${change.path}`,
    );
  }
  for (let index = 0; index < snapshot.replacements.length; index += 1) {
    const current = change.replacements[index];
    const expected = snapshot.replacements[index];
    if (
      rolloutChangeMutationAttempts.has(current) ||
      current.line !== expected.line ||
      current.start !== expected.start ||
      current.end !== expected.end ||
      current.value !== expected.value ||
      current.originalValue !== expected.originalValue
    ) {
      throw new RolloutValidationError(
        "change-mismatch",
        `Rollout replacement was modified after scanning: ${change.path}`,
      );
    }
  }
}

async function rewriteRollout(
  change: RolloutChange,
  signal: AbortSignal | undefined,
  options: RolloutApplyOptions,
): Promise<void> {
  const snapshot = rolloutChangeSnapshots.get(change);
  if (!snapshot) {
    throw new RolloutValidationError(
      "change-mismatch",
      "Rollout change was not produced by the current scan.",
    );
  }
  await rewriteRolloutFile(
    change.path,
    change.contentHash,
    change.postHash,
    change.replacements.map((replacement) => ({
      ...replacement,
      expectedValue: replacement.originalValue,
    })),
    signal,
    (temporaryPath) => options.beforeRename?.(change, temporaryPath),
    snapshot.identity,
    () => options.beforeReadOpen?.(change),
    options.io,
  );
}

interface FileReplacement {
  line: number;
  start: number;
  end: number;
  expectedValue: string;
  value: string;
}

async function rewriteRolloutFile(
  path: string,
  expectedInputHash: string,
  expectedOutputHash: string,
  replacements: readonly FileReplacement[],
  signal: AbortSignal | undefined,
  beforeRename: ((temporaryPath: string) => void | Promise<void>) | undefined,
  expectedIdentity: RolloutFileIdentity,
  beforeReadOpen?: () => void | Promise<void>,
  io?: RolloutIo,
): Promise<void> {
  throwIfAborted(signal);
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${randomUUID()}`,
  );
  let renamed = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    throwIfAborted(signal);
    await assertRolloutIdentity(path, expectedIdentity, "change-mismatch");
    if (expectedIdentity.mode === undefined) {
      handle = await open(temporaryPath, "w");
    } else {
      handle = await open(temporaryPath, "w", expectedIdentity.mode);
      await handle.chmod(expectedIdentity.mode);
    }
    const temporaryHandle = handle;
    const inputHash = createHash("sha256");
    const outputHash = createHash("sha256");
    const orderedReplacements = [...replacements].sort((left, right) => left.line - right.line || left.start - right.start);
    let replacementIndex = 0;
    let lineNumber = 0;

    await withVerifiedRolloutHandle(
      path,
      expectedIdentity,
      "change-mismatch",
      async (sourceHandle) => {
    for await (const entry of readJsonlLines(sourceHandle, path, (chunk) => inputHash.update(chunk))) {
      const lineReplacements: FileReplacement[] = [];
      while (
        replacementIndex < orderedReplacements.length &&
        orderedReplacements[replacementIndex].line === lineNumber
      ) {
        const replacement = orderedReplacements[replacementIndex];
        if (
          replacement.start < 0 ||
          replacement.end < replacement.start ||
          replacement.end > entry.line.length
        ) {
          throw new RolloutValidationError(
            "change-mismatch",
            `Rollout replacement range is invalid: ${path}`,
          );
        }
        if (entry.line.slice(replacement.start, replacement.end) !== replacement.expectedValue) {
          throw new RolloutValidationError(
            "change-mismatch",
            `Rollout provider metadata changed after scanning: ${path}`,
          );
        }
        lineReplacements.push(replacement);
        replacementIndex += 1;
      }
      const output = applyLineReplacements(entry, lineReplacements);
      throwIfAborted(signal);
      const outputChunk = Buffer.concat([output, entry.separator]);
      await writeAll(
        temporaryHandle,
        outputChunk,
        io?.write ?? defaultWrite,
        path,
      );
      outputHash.update(outputChunk);
      lineNumber += 1;
    }
      },
      beforeReadOpen,
      io?.closeHandle,
    );

    if (
      replacementIndex !== orderedReplacements.length ||
      inputHash.digest("hex") !== expectedInputHash ||
      outputHash.digest("hex") !== expectedOutputHash
    ) {
      throw new RolloutValidationError(
        "change-mismatch",
        `Rollout changed after scanning; refusing to rewrite: ${path}`,
      );
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await beforeRename?.(temporaryPath);
    throwIfAborted(signal);
    await assertRolloutIdentity(path, expectedIdentity, "change-mismatch");
    await rename(temporaryPath, path);
    renamed = true;
    try {
      await (io?.syncDirectory ?? defaultSyncDirectory)(dirname(path));
    } catch (error: unknown) {
      throw new RolloutPersistenceError(
        `Could not durably replace rollout file: ${path}`,
        { cause: error },
      );
    }
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
        `Could not rewrite rollout file: ${path}`,
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

async function writeAll(
  handle: FileHandle,
  buffer: Buffer,
  write: NonNullable<RolloutIo["write"]>,
  path: string,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    const bytesWritten = await write(handle, buffer, offset, remaining);
    if (
      !Number.isSafeInteger(bytesWritten) ||
      bytesWritten <= 0 ||
      bytesWritten > remaining
    ) {
      throw new RolloutPersistenceError(
        bytesWritten === 0
          ? `Rollout write made no progress: ${path}`
          : `Rollout write returned an invalid byte count: ${path}`,
      );
    }
    offset += bytesWritten;
  }
}

async function defaultWrite(
  handle: FileHandle,
  buffer: Buffer,
  offset: number,
  length: number,
): Promise<number> {
  const { bytesWritten } = await handle.write(buffer, offset, length);
  return bytesWritten;
}

async function defaultSyncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  let handle: FileHandle | undefined;
  let syncError: unknown;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
  } catch (error: unknown) {
    syncError = error;
  }

  let closeError: unknown;
  if (handle) {
    try {
      await handle.close();
    } catch (error: unknown) {
      closeError = error;
    }
  }

  if (syncError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [syncError, closeError],
      `Rollout directory sync and handle close both failed: ${directoryPath}`,
    );
  }
  if (syncError !== undefined) {
    throw syncError;
  }
  if (closeError !== undefined) {
    throw closeError;
  }
}

function applyLineReplacements(
  entry: JsonlLine,
  replacements: readonly Pick<FileReplacement, "start" | "end" | "value">[],
): Buffer {
  if (replacements.length === 0) {
    return entry.bytes;
  }
  const pieces: Buffer[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    if (
      replacement.start < cursor ||
      replacement.end < replacement.start ||
      replacement.end > entry.line.length
    ) {
      throw new RolloutValidationError(
        "change-mismatch",
        "Rollout replacement coordinates overlap or are out of range.",
      );
    }
    pieces.push(
      Buffer.from(entry.line.slice(cursor, replacement.start), "utf8"),
      Buffer.from(replacement.value, "utf8"),
    );
    cursor = replacement.end;
  }
  pieces.push(Buffer.from(entry.line.slice(cursor), "utf8"));
  return Buffer.concat(pieces);
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

function containsDisallowedModelProvider(
  value: unknown,
  allowedContainer: Record<string, unknown> | undefined,
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsDisallowedModelProvider(item, allowedContainer));
  }
  if (!isRecord(value)) {
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "model_provider" && value !== allowedContainer) {
      return true;
    }
    if (containsDisallowedModelProvider(child, allowedContainer)) {
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
  if (!isProviderIdentifier(provider)) {
    throw new RolloutValidationError(
      "unsupported-provider-metadata",
      "A target provider identifier is required.",
    );
  }
}

function isProviderIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RolloutCancelledError();
  }
}

async function* readJsonlLines(
  handle: FileHandle,
  path: string,
  onChunk?: (chunk: Buffer) => void,
): AsyncGenerator<JsonlLine> {
  const input = handle.createReadStream({ autoClose: false });
  let pendingPieces: Buffer[] = [];
  let pendingBytes = 0;
  let lineNumber = 0;
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      const rawChunk = Buffer.from(chunk);
      onChunk?.(rawChunk);
      let offset = 0;
      while (offset < rawChunk.length) {
        const newlineIndex = rawChunk.indexOf(0x0a, offset);
        const segmentEnd = newlineIndex >= 0 ? newlineIndex : rawChunk.length;
        const segment = rawChunk.subarray(offset, segmentEnd);
        const nextPendingBytes = pendingBytes + segment.length;
        const trailingByte =
          segment.length > 0
            ? segment.at(-1)
            : pendingPieces.at(-1)?.at(-1);
        const separatorBytes = newlineIndex >= 0 && trailingByte === 0x0d ? 1 : 0;
        const recordBytes = nextPendingBytes - separatorBytes;
        const potentialSplitCarriageReturn =
          newlineIndex < 0 &&
          nextPendingBytes === MAX_JSONL_RECORD_BYTES + 1 &&
          trailingByte === 0x0d;
        if (
          recordBytes > MAX_JSONL_RECORD_BYTES &&
          !potentialSplitCarriageReturn
        ) {
          throwJsonlRecordTooLarge(path, lineNumber);
        }
        if (segment.length > 0) {
          pendingPieces.push(Buffer.from(segment));
          pendingBytes = nextPendingBytes;
        }
        if (newlineIndex < 0) {
          break;
        }

        const rawLine = materializeJsonlRecord(pendingPieces, pendingBytes);
        pendingPieces = [];
        pendingBytes = 0;
        const isCarriageReturn = rawLine.at(-1) === 0x0d;
        const bytes = isCarriageReturn ? rawLine.subarray(0, -1) : rawLine;
        yield {
          bytes,
          line: decodeJsonlLine(path, lineNumber, bytes),
          separator: Buffer.from(isCarriageReturn ? "\r\n" : "\n", "ascii"),
        };
        lineNumber += 1;
        offset = newlineIndex + 1;
      }
    }
    if (pendingBytes > 0) {
      if (pendingBytes > MAX_JSONL_RECORD_BYTES) {
        throwJsonlRecordTooLarge(path, lineNumber);
      }
      const bytes = materializeJsonlRecord(pendingPieces, pendingBytes);
      yield {
        bytes,
        line: decodeJsonlLine(path, lineNumber, bytes),
        separator: Buffer.alloc(0),
      };
    }
  } finally {
    input.destroy();
  }
}

function materializeJsonlRecord(pieces: readonly Buffer[], byteLength: number): Buffer {
  if (pieces.length === 1) {
    return pieces[0];
  }
  return Buffer.concat(pieces, byteLength);
}

function throwJsonlRecordTooLarge(path: string, lineNumber: number): never {
  throw new RolloutValidationError(
    "jsonl-record-too-large",
    `Rollout JSONL record exceeds ${MAX_JSONL_RECORD_BYTES} bytes at line ${lineNumber + 1}: ${path}`,
  );
}

function decodeJsonlLine(path: string, lineNumber: number, bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error: unknown) {
    throw new RolloutValidationError(
      "invalid-utf8",
      `Rollout contains invalid UTF-8 at line ${lineNumber + 1}: ${path}`,
      { cause: error },
    );
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
