import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const packagePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../package.json",
);
const commandAvailabilityContextKey = "codexProvider.commandsAvailable";
const expectedCommandIds = [
  "codexProvider.continueSession",
  "codexProvider.createProfile",
  "codexProvider.editProfile",
  "codexProvider.restoreBackup",
  "codexProvider.switchProfile",
  "codexProvider.syncSessions",
].sort();

test("declares the VS Code extension manifest contract", async () => {
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    name?: string;
    private?: boolean;
    publisher?: string;
    description?: string;
    categories?: string[];
    keywords?: string[];
    icon?: string;
    homepage?: string;
    bugs?: { url?: string };
    extensionKind?: string[];
    engines?: { vscode?: string };
    main?: string;
    browser?: string;
    activationEvents?: string[];
    contributes?: {
      commands?: Array<{ command?: string; enablement?: string }>;
      menus?: {
        commandPalette?: Array<{ command?: string; when?: string }>;
        statusBar?: Array<{ command?: string; when?: string }>;
      };
    };
  };

  assert.equal(manifest.name, "codex-provider-switcher");
  assert.equal(manifest.private, true);
  assert.equal(manifest.publisher, "Li-changwu");
  assert.equal(
    manifest.description,
    "Safely manage and switch local Codex provider profiles on Windows, Linux, and Remote SSH.",
  );
  assert.deepEqual(manifest.categories, ["Other"]);
  assert.deepEqual(manifest.keywords, [
    "codex",
    "provider",
    "profiles",
    "configuration",
    "remote-ssh",
  ]);
  assert.equal(manifest.icon, "media/icon.png");
  assert.equal(
    manifest.homepage,
    "https://github.com/Li-changwu/codex-provider-switcher#readme",
  );
  assert.deepEqual(manifest.bugs, {
    url: "https://github.com/Li-changwu/codex-provider-switcher/issues",
  });
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.equal(manifest.engines?.vscode, "^1.98.0");
  assert.equal(manifest.main, "./dist/extension.js");
  assert.equal(manifest.browser, undefined);
  assert.deepEqual(manifest.activationEvents, ["onStartupFinished"]);

  const commands = new Set(
    manifest.contributes?.commands?.map((entry) => entry.command),
  );
  assert.deepEqual([...commands].sort(), expectedCommandIds);
  assert.ok(
    manifest.contributes?.commands?.every(
      (entry) => entry.enablement === commandAvailabilityContextKey,
    ),
  );
  const commandPalette = manifest.contributes?.menus?.commandPalette ?? [];
  assert.deepEqual(
    commandPalette.map((entry) => entry.command).sort(),
    expectedCommandIds,
  );
  assert.ok(
    commandPalette.every((entry) => entry.when === commandAvailabilityContextKey),
  );

  assert.ok(
    manifest.contributes?.menus?.statusBar?.some(
      (entry) => (
        entry.command === "codexProvider.switchProfile"
        && entry.when === commandAvailabilityContextKey
      ),
    ),
  );
});
