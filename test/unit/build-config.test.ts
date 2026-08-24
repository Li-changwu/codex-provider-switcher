import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const buildScriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../esbuild.mjs",
);

test("targets the Node 20 VS Code runtime and keeps vscode external", async () => {
  const buildScript = await readFile(buildScriptPath, "utf8");

  assert.match(buildScript, /target:\s*["']node20["']/);
  assert.match(buildScript, /external:\s*\[\s*["']vscode["']\s*\]/);
});
