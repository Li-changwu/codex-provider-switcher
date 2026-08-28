import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the sqlite binding preflight loads sqlite3 in a clean child process", async () => {
  const result = await runPreflight();

  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /Verified native SQLite binding:/);
});

function runPreflight(): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["scripts/verify-sqlite-binding.mjs"], {
      cwd: projectRoot,
      env: { ...process.env, NODE_PATH: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolveResult({ exitCode: exitCode ?? 1, output: output.trim() });
    });
  });
}
