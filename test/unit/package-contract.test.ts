import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const packagePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../package.json",
);

test("packages runtime dependencies and exposes a cross-platform VSIX check", async () => {
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    scripts?: {
      package?: string;
      [name: string]: string | undefined;
    };
  };

  assert.equal(
    manifest.scripts?.package,
    "npm run check && npm run build && npx @vscode/vsce package",
  );
  assert.equal(manifest.scripts?.["verify:package"], "node scripts/verify-vsix.mjs");
});
