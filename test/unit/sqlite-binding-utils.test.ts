import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import * as sqliteBindingUtils from "../../scripts/sqlite-binding-utils.mjs";

const { runSqliteRequire } = sqliteBindingUtils;
const runNodeModuleRequire = sqliteBindingUtils.runNodeModuleRequire as
  | ((
      cwd: string,
      moduleName: string,
      options?: {
        spawnProcess: (
          command: string,
          args: string[],
          options: { env: NodeJS.ProcessEnv },
        ) => ReturnType<typeof pendingChild>;
      },
    ) => Promise<ChildLoadResult>)
  | undefined;

type ChildLoadResult = {
  exitCode: number;
  output: string;
  timedOut?: boolean;
};

test("uses a scrubbed environment for the native SQLite child process", async () => {
  let receivedEnvironment: NodeJS.ProcessEnv | undefined;
  const child = completedChild();

  await runSqliteRequire(process.cwd(), {
    sourceEnv: {
      PATH: "safe-path",
      SystemRoot: "C:\\Windows",
      NODE_OPTIONS: "--require injected.js",
      NODE_PATH: "injected-modules",
      NODE_COMPILE_CACHE: "injected-cache",
      NODE_V8_COVERAGE: "injected-coverage",
      NODE_REPL_EXTERNAL_MODULE: "injected-repl",
    },
    spawnProcess: (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      receivedEnvironment = options.env;
      return child;
    },
  });

  assert.ok(receivedEnvironment);
  assert.equal(receivedEnvironment.NODE_OPTIONS, undefined);
  assert.equal(receivedEnvironment.NODE_PATH, undefined);
  assert.equal(receivedEnvironment.NODE_COMPILE_CACHE, undefined);
  assert.equal(receivedEnvironment.NODE_V8_COVERAGE, undefined);
  assert.equal(receivedEnvironment.NODE_REPL_EXTERNAL_MODULE, undefined);
  assert.equal(receivedEnvironment.PATH, "safe-path");
});

test("kills and reports a native SQLite load that exceeds the timeout", async () => {
  const killSignals: Array<string | undefined> = [];
  let childClosed = false;
  const child = pendingChild((signal) => {
    killSignals.push(signal);
    if (signal === "SIGTERM") {
      queueMicrotask(() => {
        childClosed = true;
        child.emit("close", 1);
      });
    }
  });

  const result = (await runSqliteRequire(process.cwd(), {
    timeoutMs: 5,
    forceKillAfterMs: 5,
    spawnProcess: () => child,
  })) as ChildLoadResult;

  assert.equal(result.timedOut, true);
  assert.equal(childClosed, true);
  assert.deepEqual(killSignals, ["SIGTERM"]);
  assert.match(result.output, /timed out after 5ms/);
});

test("terminates and rejects a native module load with excessive combined output", async () => {
  const killSignals: Array<string | undefined> = [];
  const child = pendingChild((signal) => {
    killSignals.push(signal);
  });
  const load = runSqliteRequire(process.cwd(), {
    timeoutMs: 5,
    forceKillAfterMs: 5,
    maxOutputBytes: 4,
    spawnProcess: () => child,
  });

  child.stdout.write("abc");
  child.stderr.write("de");

  await assert.rejects(
    load,
    /Native module load output exceeded the maximum of 4 bytes/,
  );
  assert.deepEqual(killSignals, ["SIGTERM", "SIGKILL"]);
});

test("loads a requested runtime module in the clean child process", async () => {
  assert.equal(typeof runNodeModuleRequire, "function");
  let receivedArgs: string[] | undefined;
  const child = completedChild();

  await runNodeModuleRequire!(process.cwd(), "@iarna/toml", {
    spawnProcess: (_command, args) => {
      receivedArgs = args;
      return child;
    },
  });

  assert.deepEqual(receivedArgs, [
    "--no-warnings",
    "-e",
    'require("@iarna/toml");',
  ]);
});

function completedChild() {
  const child = pendingChild();
  queueMicrotask(() => child.emit("close", 0));
  return child;
}

function pendingChild(onKill?: (signal?: string) => void) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: string) => boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    onKill?.(signal);
    return true;
  };
  return child;
}
