import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const SQLITE_LOAD_TIMEOUT_MS = 10_000;
export const MAX_NATIVE_MODULE_LOAD_OUTPUT_BYTES = 64 * 1024;
export const NATIVE_MODULE_FORCE_KILL_AFTER_MS = 1_000;

const POSIX_CHILD_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TMP"];
const WINDOWS_CHILD_ENV_KEYS = [
  "PATH",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "TEMP",
  "TMP",
];

export async function findNativeBinding(packagePath) {
  const entries = await readdir(packagePath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(packagePath, entry.name);
    if (entry.isDirectory()) {
      const binding = await findNativeBinding(entryPath);
      if (binding) {
        return binding;
      }
    } else if (entry.isFile() && entry.name.endsWith(".node")) {
      return entryPath;
    }
  }

  return undefined;
}

export function createCleanChildEnvironment(
  sourceEnv = process.env,
  platform = process.platform,
) {
  const keys = platform === "win32" ? WINDOWS_CHILD_ENV_KEYS : POSIX_CHILD_ENV_KEYS;
  const environment = {};
  for (const key of keys) {
    if (sourceEnv[key] !== undefined) {
      environment[key] = sourceEnv[key];
    }
  }
  return environment;
}

export function runSqliteRequire(cwd, options = {}) {
  return runNodeModuleRequire(cwd, "sqlite3", options);
}

export function runNodeModuleRequire(cwd, moduleName, options = {}) {
  if (typeof moduleName !== "string" || moduleName.length === 0) {
    throw new Error("Module name must be a non-empty string.");
  }
  return runNodeScript(cwd, `require(${JSON.stringify(moduleName)});`, [], options);
}

export function runNodeScript(cwd, script, scriptArgs = [], options = {}) {
  if (typeof script !== "string" || script.length === 0) {
    throw new Error("Node child script must be a non-empty string.");
  }
  if (!Array.isArray(scriptArgs) || !scriptArgs.every((argument) => typeof argument === "string")) {
    throw new Error("Node child script arguments must be strings.");
  }
  const {
    timeoutMs = SQLITE_LOAD_TIMEOUT_MS,
    maxOutputBytes = MAX_NATIVE_MODULE_LOAD_OUTPUT_BYTES,
    forceKillAfterMs = NATIVE_MODULE_FORCE_KILL_AFTER_MS,
    spawnProcess = spawn,
    sourceEnv = process.env,
    platform = process.platform,
  } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`SQLite load timeout must be a positive finite value: ${timeoutMs}`);
  }
  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error(`Native module output limit must be a positive finite value: ${maxOutputBytes}`);
  }
  if (!Number.isFinite(forceKillAfterMs) || forceKillAfterMs <= 0) {
    throw new Error(`Native module force-kill delay must be a positive finite value: ${forceKillAfterMs}`);
  }

  return new Promise((resolveResult, reject) => {
    let child;
    try {
      child = spawnProcess(
        process.execPath,
        ["--no-warnings", "-e", script, ...scriptArgs],
        {
          cwd,
          env: createCleanChildEnvironment(sourceEnv, platform),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      reject(error);
      return;
    }

    let output = "";
    let outputBytes = 0;
    let settled = false;
    let terminationReason;
    let timeout;
    let forceKillTimeout;
    const timeoutMessage = `Native SQLite load timed out after ${timeoutMs}ms.`;
    const clearTimers = () => {
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);
    };
    const finish = (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      if (terminationReason === "output") {
        reject(
          new Error(
            `Native module load output exceeded the maximum of ${maxOutputBytes} bytes.`,
          ),
        );
        return;
      }
      const timedOut = terminationReason === "timeout";
      resolveResult({
        exitCode: timedOut ? 1 : exitCode ?? 1,
        output: [output.trim(), timedOut ? timeoutMessage : undefined]
          .filter(Boolean)
          .join("\n"),
        timedOut,
        ...(timedOut ? { timeoutMs } : {}),
      });
    };
    const killChild = (signal) => {
      try {
        child.kill(signal);
      } catch {
        // The child may have exited between the timeout and kill.
      }
    };
    const terminate = (reason) => {
      if (settled || terminationReason) {
        return;
      }
      terminationReason = reason;
      killChild("SIGTERM");
      if (settled) {
        return;
      }
      forceKillTimeout = setTimeout(() => {
        killChild("SIGKILL");
        finish(1);
      }, forceKillAfterMs);
    };
    const captureOutput = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remainingBytes = maxOutputBytes - outputBytes;
      if (remainingBytes > 0) {
        output += buffer.subarray(0, remainingBytes).toString();
      }
      outputBytes += buffer.length;
      if (outputBytes > maxOutputBytes) {
        terminate("output");
      }
    };
    timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    child.stdout.on("data", captureOutput);
    child.stderr.on("data", captureOutput);
    child.once("error", (error) => {
      captureOutput(error.message);
      terminate("error");
    });
    child.once("close", (exitCode) => {
      finish(exitCode);
    });
  });
}
