import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const packagePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../package.json",
);

test("declares the VS Code extension manifest contract", async () => {
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    engines?: { vscode?: string };
    main?: string;
    browser?: string;
    activationEvents?: string[];
    contributes?: {
      commands?: Array<{ command?: string }>;
    };
  };

  assert.equal(manifest.engines?.vscode, "^1.92.0");
  assert.equal(manifest.main, "./dist/extension.js");
  assert.equal(manifest.browser, undefined);
  assert.deepEqual(manifest.activationEvents, ["onStartupFinished"]);

  const commands = new Set(
    manifest.contributes?.commands?.map((entry) => entry.command),
  );
  assert.deepEqual(
    [...commands].sort(),
    [
      "codexProvider.continueSession",
      "codexProvider.createProfile",
      "codexProvider.restoreBackup",
      "codexProvider.syncSessions",
      "codexProvider.switchProfile",
    ].sort(),
  );
});
