import { spawn as nodeSpawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const FAILURE_MESSAGE = "Unable to obtain native Codex fork.";
const TRUSTED_THREAD_ID = /^[A-Za-z0-9._-]+$/;

export interface AppServerChild {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string, listener: (...args: unknown[]) => void): this;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
}

export interface AppServerSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: ["pipe", "pipe", "pipe"];
}

export type AppServerSpawn = (
  command: string,
  args: string[],
  options: AppServerSpawnOptions,
) => AppServerChild;

export interface ForkNativeCodexThreadInput {
  readonly command?: string;
  readonly sourceSessionId: string;
  readonly codexHome: string;
  readonly spawn?: AppServerSpawn;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly clientVersion?: string;
}

export function forkNativeCodexThread(input: ForkNativeCodexThreadInput): Promise<string> {
  const command = input.command?.trim() || "codex";
  const clientVersion = input.clientVersion?.trim() || "0.1.0";
  const timeoutMs = boundedOption(input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxStdoutBytes = boundedOption(input.maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES, MAX_STDOUT_BYTES);
  const maxStderrBytes = boundedOption(input.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, MAX_STDERR_BYTES);
  if (
    !isTrustedId(input.sourceSessionId)
    || !isAbsoluteCodexHome(input.codexHome)
    || timeoutMs === undefined
    || maxStdoutBytes === undefined
    || maxStderrBytes === undefined
  ) {
    return Promise.reject(failure());
  }
  let child: AppServerChild;

  try {
    child = (input.spawn ?? spawnAppServer)(command, ["app-server", "--listen", "stdio://"], {
      cwd: input.codexHome,
      env: { ...process.env, CODEX_HOME: input.codexHome },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return Promise.reject(failure());
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let phase: 1 | 2 = 1;
    let stdoutBuffer = "";
    let totalStdoutBytes = 0;
    let totalStderrBytes = 0;
    const decoder = new StringDecoder("utf8");
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const onChildFailure = () => settle();
    const onChildClose = () => settle();
    const onStdioFailure = () => settle();
    const ignoreLateError = () => undefined;
    const onStderrData = (chunk: unknown) => {
      if (settled) {
        return;
      }
      const bytes = asBuffer(chunk);
      if (totalStderrBytes + bytes.length > maxStderrBytes) {
        settle();
        return;
      }
      totalStderrBytes += bytes.length;
    };
    const onStdoutData = (chunk: unknown) => {
      if (settled) {
        return;
      }

      const bytes = asBuffer(chunk);
      if (totalStdoutBytes + bytes.length > maxStdoutBytes) {
        settle();
        return;
      }
      totalStdoutBytes += bytes.length;
      stdoutBuffer += decoder.write(bytes);
      if (Buffer.byteLength(stdoutBuffer, "utf8") > maxStdoutBytes) {
        settle();
        return;
      }

      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) {
          return;
        }
        let line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }
        if (!line) {
          continue;
        }
        handleLine(line);
        if (settled) {
          return;
        }
      }
    };

    child.on("error", onChildFailure);
    child.on("close", onChildClose);
    child.stdin.on("error", onStdioFailure);
    child.stdout.on("data", onStdoutData);
    child.stdout.on("error", onStdioFailure);
    child.stderr.on("data", onStderrData);
    child.stderr.on("error", onStdioFailure);
    timeoutHandle = setTimeout(() => settle(), timeoutMs);

    try {
      writeRecord({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-provider-switcher",
            version: clientVersion,
          },
          capabilities: null,
        },
      });
    } catch {
      settle();
    }

    function handleLine(line: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        settle();
        return;
      }

      if (!isRecord(parsed)) {
        settle();
        return;
      }
      if (parsed.jsonrpc !== "2.0") {
        settle();
        return;
      }
      const hasMethod = Object.hasOwn(parsed, "method");
      const hasId = Object.hasOwn(parsed, "id");
      const hasResult = Object.hasOwn(parsed, "result");
      const hasError = Object.hasOwn(parsed, "error");
      if (hasMethod) {
        if (typeof parsed.method !== "string" || hasId || hasResult || hasError) {
          settle();
          return;
        }
        return;
      }
      if (!hasId || parsed.id !== phase || hasResult === hasError) {
        settle();
        return;
      }
      if (hasError) {
        settle();
        return;
      }

      if (phase === 1) {
        phase = 2;
        try {
          writeRecord({ jsonrpc: "2.0", method: "initialized", params: {} });
          writeRecord({
            jsonrpc: "2.0",
            id: 2,
            method: "thread/fork",
            params: {
              threadId: input.sourceSessionId,
              excludeTurns: true,
            },
          });
        } catch {
          settle();
        }
        return;
      }

      const threadId = trustedThreadId(parsed.result);
      if (!threadId) {
        settle();
        return;
      }
      settle(threadId);
    }

    function writeRecord(record: object): void {
      child.stdin.write(`${JSON.stringify(record)}\n`);
    }

    function settle(threadId?: string): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      child.removeListener("error", onChildFailure);
      child.removeListener("close", onChildClose);
      child.stdin.removeListener("error", onStdioFailure);
      child.stdout.removeListener("data", onStdoutData);
      child.stdout.removeListener("error", onStdioFailure);
      child.stderr.removeListener("data", onStderrData);
      child.stderr.removeListener("error", onStdioFailure);
      child.on("error", ignoreLateError);
      child.stdin.on("error", ignoreLateError);
      child.stdout.on("error", ignoreLateError);
      child.stderr.on("error", ignoreLateError);
      totalStderrBytes = 0;
      stdoutBuffer = "";
      totalStdoutBytes = 0;
      try {
        child.kill();
      } catch {
        // The child may already be gone; the result remains fail-closed.
      }
      if (threadId) {
        resolve(threadId);
      } else {
        reject(failure());
      }
    }
  });
}

function spawnAppServer(
  command: string,
  args: string[],
  options: AppServerSpawnOptions,
): AppServerChild {
  return nodeSpawn(command, args, options);
}

function boundedOption(value: number | undefined, fallback: number, maximum: number): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  return Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : undefined;
}

function isAbsoluteCodexHome(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && isAbsolute(value);
}

function isTrustedId(value: unknown): value is string {
  return typeof value === "string" && TRUSTED_THREAD_ID.test(value);
}

function asBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  return Buffer.from(typeof chunk === "string" ? chunk : "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trustedThreadId(result: unknown): string | undefined {
  if (!isRecord(result) || !isRecord(result.thread)) {
    return undefined;
  }
  const threadId = result.thread.id;
  return typeof threadId === "string" && TRUSTED_THREAD_ID.test(threadId)
    ? threadId
    : undefined;
}

function failure(): Error {
  return new Error(FAILURE_MESSAGE);
}
