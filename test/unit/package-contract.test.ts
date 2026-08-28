import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { buildWindowsFileOps } from "../../scripts/build-windows-file-ops.mjs";

const packagePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../package.json",
);
const vscodeIgnorePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.vscodeignore",
);
const windowsFileOperationsSourcePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../native/windows-file-ops/src/windows_file_ops.cc",
);

test("packages verified platform-specific native dependencies", async () => {
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    dependencies?: Record<string, string | undefined>;
    devDependencies?: Record<string, string | undefined>;
    repository?: {
      type?: string;
      url?: string;
    };
    scripts?: {
      package?: string;
      [name: string]: string | undefined;
    };
  };

  assert.equal(manifest.dependencies?.sqlite3, "^6.0.1");
  assert.equal(manifest.dependencies?.["@vscode/sqlite3"], undefined);
  assert.equal(manifest.devDependencies?.["@types/vscode"], "^1.98.0");
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "https://github.com/Li-changwu/codex-provider-switcher.git",
  });

  assert.equal(manifest.scripts?.package, "node scripts/package-extension.mjs");
  assert.equal(
    manifest.scripts?.["package:win32-x64"],
    "node scripts/package-extension.mjs win32-x64",
  );
  assert.equal(
    manifest.scripts?.["package:linux-x64"],
    "node scripts/package-extension.mjs linux-x64",
  );
  assert.equal(
    manifest.scripts?.["verify:binding"],
    "node scripts/verify-sqlite-binding.mjs",
  );
  assert.equal(manifest.scripts?.["verify:package"], "node scripts/verify-vsix.mjs");

  const vscodeIgnore = await readFile(vscodeIgnorePath, "utf8");
  const tomlAllowlistEntries = vscodeIgnore
    .split(/\r?\n/)
    .filter((entry) => entry.startsWith("!node_modules/@iarna/toml/"));
  assert.match(vscodeIgnore, /^\*\*\/\*.map$/m);
  assert.match(vscodeIgnore, /^node_modules\/\*\*$/m);
  assert.deepEqual(tomlAllowlistEntries, [
    "!node_modules/@iarna/toml/package.json",
    "!node_modules/@iarna/toml/toml.js",
    "!node_modules/@iarna/toml/parse.js",
    "!node_modules/@iarna/toml/stringify.js",
    "!node_modules/@iarna/toml/parse-string.js",
    "!node_modules/@iarna/toml/parse-async.js",
    "!node_modules/@iarna/toml/parse-stream.js",
    "!node_modules/@iarna/toml/parse-pretty-error.js",
    "!node_modules/@iarna/toml/lib/parser.js",
    "!node_modules/@iarna/toml/lib/toml-parser.js",
    "!node_modules/@iarna/toml/lib/create-datetime.js",
    "!node_modules/@iarna/toml/lib/create-datetime-float.js",
    "!node_modules/@iarna/toml/lib/create-date.js",
    "!node_modules/@iarna/toml/lib/create-time.js",
    "!node_modules/@iarna/toml/lib/format-num.js",
  ]);
  assert.doesNotMatch(vscodeIgnore, /^!node_modules\/@iarna\/toml\/lib\/\*\*$/m);
  assert.doesNotMatch(vscodeIgnore, /^!node_modules\/@iarna\/toml\/test\/fixture\.js$/m);
  assert.match(vscodeIgnore, /^!node_modules\/sqlite3\/lib\/sqlite3\.js$/m);
  assert.match(vscodeIgnore, /^!node_modules\/sqlite3\/lib\/sqlite3-binding\.js$/m);
  assert.match(vscodeIgnore, /^!node_modules\/sqlite3\/lib\/trace\.js$/m);
  assert.match(vscodeIgnore, /^!node_modules\/sqlite3\/\*\*\/\*.node$/m);
  assert.match(vscodeIgnore, /^!node_modules\/bindings\/bindings\.js$/m);
  assert.match(vscodeIgnore, /^!node_modules\/file-uri-to-path\/index\.js$/m);

});

test("pins the Windows file-operations build and exposes only its staged addon", async () => {
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    devDependencies?: Record<string, string | undefined>;
    scripts?: Record<string, string | undefined>;
  };
  const gitIgnore = await readFile(
    resolve(dirname(vscodeIgnorePath), ".gitignore"),
    "utf8",
  );
  const vscodeIgnore = await readFile(vscodeIgnorePath, "utf8");

  assert.equal(manifest.devDependencies?.["node-gyp"], "12.4.0");
  assert.equal(
    manifest.scripts?.["build:windows-file-ops"],
    "node scripts/build-windows-file-ops.mjs",
  );
  assert.match(gitIgnore, /^native\/windows-file-ops\/build\/$/m);
  assert.match(gitIgnore, /^native\/windows-file-ops\/windows_file_ops\.node$/m);
  assert.match(vscodeIgnore, /^native\/\*\*$/m);

  const nativeAllowlistEntries = vscodeIgnore
    .split(/\r?\n/)
    .filter((entry) => entry.startsWith("!native/"));
  assert.deepEqual(nativeAllowlistEntries, [
    "!native/windows-file-ops/windows_file_ops.node",
  ]);
});

test("formats the complete 64-bit Windows volume serial in native file identities", async () => {
  // Real test volumes may have a zero high half, so this source contract prevents
  // a future narrowing conversion from silently discarding it.
  const source = await readFile(windowsFileOperationsSourcePath, "utf8");

  assert.match(source, /std::string FormatVolumeSerial\(uint64_t serial\)/);
  assert.doesNotMatch(source, /std::string FormatVolumeSerial\(ULONG serial\)/);
  assert.match(
    source,
    /identity->volume_serial = FormatVolumeSerial\(file_id\.VolumeSerialNumber\);/,
  );
});

test("refuses unsupported Windows-addon hosts before filesystem mutation", async () => {
  let filesystemMutations = 0;
  const fsOps = {
    async rm(): Promise<void> {
      filesystemMutations += 1;
      throw new Error("filesystem mutation occurred");
    },
    async stat(): Promise<never> {
      throw new Error("stat should not run");
    },
    async copyFile(): Promise<never> {
      throw new Error("copy should not run");
    },
  };

  for (const [platform, arch] of [
    ["linux", "x64"],
    ["win32", "arm64"],
  ] as const) {
    await assert.rejects(
      buildWindowsFileOps({
        platform,
        arch,
        projectRoot: "C:\\extension-root",
        fsOps,
        run: async () => {
          throw new Error("node-gyp should not run");
        },
      }),
      /requires a win32-x64 host/,
    );
  }

  assert.equal(filesystemMutations, 0);
});
