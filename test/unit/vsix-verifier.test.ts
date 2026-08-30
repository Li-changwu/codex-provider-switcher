import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import yazl from "yazl";
import * as vsixVerifier from "../../scripts/vsix-verifier.mjs";

const { verifyVsix } = vsixVerifier;
const createArchiveRules = vsixVerifier.createArchiveRules as
  | ((expectedNativeBindingEntry: string, target: string) => unknown)
  | undefined;
const validateArchiveEntries = vsixVerifier.validateArchiveEntries as
  | ((entries: Iterable<string>, archiveRules: unknown) => void)
  | undefined;
const extractVsix = vsixVerifier.extractVsix as
  | ((
      vsixPath: string,
      extractionRoot: string,
      options?: { limits?: { maxEntryUncompressedBytes?: number } },
    ) => Promise<void>)
  | undefined;

const sqlitePrefix = "extension/node_modules/sqlite3/";

test("rejects a VSIX without a native SQLite binding under sqlite3", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "missing-binding.vsix");

  await writeVsix(vsixPath, baseEntries());

  await assert.rejects(
    verifyVsix(vsixPath, {
      expectedNativeBindingEntry:
        "extension/node_modules/sqlite3/bindings/current/binding.node",
    }),
    new RegExp(`Missing native SQLite binding under: ${escapeRegex(sqlitePrefix)}`),
  );
});

for (const requiredEntry of ["[Content_Types].xml", "extension.vsixmanifest"]) {
  test(`rejects a VSIX without required metadata: ${requiredEntry}`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const vsixPath = join(directory, "missing-metadata.vsix");
    const entries = baseEntries();
    delete entries[requiredEntry];

    await writeVsix(vsixPath, entries);

    await assert.rejects(
      verifyVsix(vsixPath),
      new RegExp(`VSIX is missing required entry: ${escapeRegex(requiredEntry)}`),
    );
  });
}

test("rejects a VSIX without required README documentation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "missing-readme.vsix");
  const entries = baseEntries();
  delete entries["extension/README.md"];

  await writeVsix(vsixPath, entries);

  await assert.rejects(
    verifyVsix(vsixPath),
    /VSIX is missing required entry: extension\/README\.md/,
  );
});

test("rejects a VSIX without required license documentation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "missing-license.vsix");
  const entries = baseEntries();
  delete entries["extension/LICENSE.txt"];

  await writeVsix(vsixPath, entries);

  await assert.rejects(
    verifyVsix(vsixPath),
    /VSIX is missing required entry: extension\/LICENSE\.txt/,
  );
});

test("permits required README documentation in a VSIX", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "readme.vsix");

  await writeVsix(vsixPath, baseEntries());

  await assert.rejects(
    verifyVsix(vsixPath, {
      expectedNativeBindingEntry:
        "extension/node_modules/sqlite3/bindings/current/binding.node",
    }),
    new RegExp(`Missing native SQLite binding under: ${escapeRegex(sqlitePrefix)}`),
  );
});

test("rejects an archive entry that exceeds the configured extraction limit", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "oversized-entry.vsix");

  await writeVsix(vsixPath, {
    "extension/package.json": "{}",
  });

  await assert.rejects(
    verifyVsix(vsixPath, {
      limits: { maxEntryUncompressedBytes: 1 },
    }),
    /VSIX entry exceeds the maximum uncompressed size/,
  );
});

test("enforces extraction limits before directly extracting an oversized entry", async (context) => {
  assert.equal(typeof extractVsix, "function");
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "direct-extraction-limit.vsix");
  const extractionRoot = join(directory, "extracted");
  await mkdir(extractionRoot);
  await writeVsix(vsixPath, { "extension/payload.txt": "too large" });

  await assert.rejects(
    extractVsix!(vsixPath, extractionRoot, {
      limits: { maxEntryUncompressedBytes: 1 },
    }),
    /VSIX entry exceeds the maximum uncompressed size: extension\/payload\.txt/,
  );
  assert.deepEqual(await readdir(extractionRoot), []);
});

test("rejects duplicate exact archive paths before verification extraction", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "duplicate-entry.vsix");

  await writeVsixEntries(vsixPath, [
    ...Object.entries(baseEntries()),
    ["extension/package.json", '{"duplicate":true}'],
  ]);

  await assert.rejects(
    verifyVsix(vsixPath),
    /VSIX contains duplicate canonical path: extension\/package\.json/,
  );
});

test("rejects duplicate archive paths that differ only by case", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "case-collision.vsix");

  await writeVsixEntries(vsixPath, [
    ...Object.entries(baseEntries()),
    ["extension/Package.json", '{"collision":true}'],
  ]);

  await assert.rejects(
    verifyVsix(vsixPath),
    /VSIX contains duplicate canonical path: extension\/package\.json/,
  );
});

test("rejects duplicate archive paths that differ only by separators", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "separator-collision.vsix");

  await writeVsixEntries(vsixPath, [
    ...Object.entries(baseEntries()),
    ["extension\\package.json", '{"collision":true}'],
  ]);

  await assert.rejects(
    verifyVsix(vsixPath),
    /VSIX contains duplicate canonical path: extension\/package\.json/,
  );
});

test("rejects duplicate archive paths before direct extraction writes files", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "duplicate-direct-extraction.vsix");
  const extractionRoot = join(directory, "extracted");
  await mkdir(extractionRoot);
  await writeVsixEntries(vsixPath, [
    ["extension/payload.txt", "first payload"],
    ["extension/payload.txt", "second payload"],
  ]);

  await assert.rejects(
    extractVsix!(vsixPath, extractionRoot),
    /VSIX contains duplicate canonical path: extension\/payload\.txt/,
  );
  assert.deepEqual(await readdir(extractionRoot), []);
});

test("rejects an archive whose aggregate uncompressed size exceeds the limit", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "oversized-archive.vsix");

  await writeVsix(vsixPath, {
    "extension/package.json": "{}",
    "extension/dist/extension.js": "",
    "extension/payload.txt": "abc",
  });

  await assert.rejects(
    verifyVsix(vsixPath, {
      limits: { maxUncompressedBytes: 4 },
    }),
    /VSIX exceeds the maximum aggregate uncompressed size: 4/,
  );
});

test("rejects installer dependencies in a VSIX", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "installer-dependency.vsix");

  await writeVsix(vsixPath, {
    ...baseEntries(),
    ...sqliteRuntimeEntries(),
    "extension/node_modules/node-gyp/package.json": "{}",
  });

  await assert.rejects(
    verifyVsix(vsixPath, {
      expectedNativeBindingEntry:
        "extension/node_modules/sqlite3/bindings/current/binding.node",
    }),
    /VSIX must not include install-time dependency: node-gyp/,
  );
});

test("rejects mixed-case node_modules paths before platform-dependent extraction", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "mixed-case-node-modules.vsix");

  await writeVsix(vsixPath, {
    ...baseEntries(),
    "extension/Node_Modules/sqlite3/lib/sqlite3.js": "module.exports = {};",
  });

  await assert.rejects(
    verifyVsix(vsixPath),
    /VSIX entry path is not canonical: extension\/Node_Modules\/sqlite3\/lib\/sqlite3\.js/,
  );
});

test("rejects unexpected extension files before platform-dependent extraction", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "unexpected-extension-file.vsix");

  await writeVsix(vsixPath, {
    ...baseEntries(),
    "extension/unapproved.js": "module.exports = {};",
  });

  await assert.rejects(
    verifyVsix(vsixPath),
    /VSIX contains unexpected archive entry: extension\/unapproved\.js/,
  );
});

test("allows the Windows file-operations addon only in a win32-x64 VSIX", () => {
  assert.equal(typeof createArchiveRules, "function");
  assert.equal(typeof validateArchiveEntries, "function");

  const addonEntry = "extension/native/windows-file-ops/windows_file_ops.node";
  const expectedNativeBindingEntry =
    "extension/node_modules/sqlite3/bindings/current/binding.node";
  const entries = [...Object.keys(baseEntries()), addonEntry];

  assert.doesNotThrow(() =>
    validateArchiveEntries!(
      entries,
      createArchiveRules!(expectedNativeBindingEntry, "win32-x64"),
    ),
  );
  assert.throws(
    () =>
      validateArchiveEntries!(
        entries,
        createArchiveRules!(expectedNativeBindingEntry, "linux-x64"),
      ),
    new RegExp(`VSIX contains unexpected archive entry: ${escapeRegex(addonEntry)}`),
  );
});

test("requires the staged addon in a win32-x64 VSIX", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "missing-windows-addon.vsix");

  await writeVsix(vsixPath, baseEntries());

  await assert.rejects(
    verifyVsix(vsixPath, {
      target: "win32-x64",
      expectedNativeBindingEntry:
        "extension/node_modules/sqlite3/bindings/current/binding.node",
    }),
    /VSIX is missing required entry: extension\/native\/windows-file-ops\/windows_file_ops\.node/,
  );
});

test(
  "rejects an unloadable Windows file-operations addon from a win32-x64 VSIX",
  { skip: process.platform !== "win32" },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const vsixPath = join(directory, "invalid-windows-addon.vsix");

    await writeVsix(vsixPath, {
      ...baseEntries(),
      ...sqliteRuntimeEntries(),
      ...tomlRuntimeEntries(),
      "extension/node_modules/sqlite3/package.json": '{"main":"./lib/sqlite3.js"}',
      "extension/node_modules/sqlite3/lib/sqlite3.js": "module.exports = {};",
      "extension/native/windows-file-ops/windows_file_ops.node": "",
    });

    await assert.rejects(
      verifyVsix(vsixPath, {
        target: "win32-x64",
        expectedNativeBindingEntry:
          "extension/node_modules/sqlite3/bindings/current/binding.node",
      }),
      /Windows file-operations addon failed to load or validate from extracted VSIX/,
    );
  },
);

test("rejects TypeScript declarations from the sqlite3 runtime package", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "sqlite-declaration.vsix");

  await writeVsix(vsixPath, {
    ...baseEntries(),
    "extension/node_modules/sqlite3/lib/sqlite3.d.ts": "export {};",
  });

  await assert.rejects(
    verifyVsix(vsixPath),
    /VSIX must not include TypeScript declarations: extension\/node_modules\/sqlite3\/lib\/sqlite3\.d\.ts/,
  );
});

test("rejects TypeScript declarations anywhere in a VSIX", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "extension-declaration.vsix");

  await writeVsix(vsixPath, {
    ...baseEntries(),
    "extension/foo.d.ts": "export {};",
  });

  await assert.rejects(
    verifyVsix(vsixPath),
    /VSIX must not include TypeScript declarations: extension\/foo\.d\.ts/,
  );
});

test("rejects source archives anywhere in a VSIX", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "source-archive.vsix");

  await writeVsix(vsixPath, {
    ...baseEntries(),
    "extension/sqlite-source.tar.gz": "source archive",
  });

  await assert.rejects(
    verifyVsix(vsixPath),
    /VSIX must not include source or archive content: extension\/sqlite-source\.tar\.gz/,
  );
});

test("rejects source maps and unloadable sqlite3 packages in a child process", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const mapVsixPath = join(directory, "source-map.vsix");

  await writeVsix(mapVsixPath, {
    ...baseEntries(),
    "extension/dist/extension.js.map": "{}",
  });

  await assert.rejects(verifyVsix(mapVsixPath), /VSIX must not include source maps/);

  const bindingVsixPath = join(directory, "invalid-binding.vsix");
  await writeVsix(bindingVsixPath, {
    ...baseEntries(),
    ...tomlRuntimeEntries(),
    "extension/node_modules/sqlite3/package.json": '{"main":"./lib/sqlite3.js"}',
    "extension/node_modules/sqlite3/lib/sqlite3.js":
      'module.exports = require("./sqlite3-binding.js");',
    "extension/node_modules/sqlite3/lib/sqlite3-binding.js":
      'module.exports = require("../bindings/current/binding.node");',
    "extension/node_modules/sqlite3/lib/trace.js": "module.exports = {};",
    "extension/node_modules/sqlite3/bindings/current/binding.node": "not a native binding",
    "extension/node_modules/bindings/package.json": "{}",
    "extension/node_modules/bindings/bindings.js": "module.exports = {};",
    "extension/node_modules/file-uri-to-path/package.json": "{}",
    "extension/node_modules/file-uri-to-path/index.js": "module.exports = {};",
  });

  await assert.rejects(
    verifyVsix(bindingVsixPath, {
      expectedNativeBindingEntry:
        "extension/node_modules/sqlite3/bindings/current/binding.node",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Native SQLite binding failed to load from extracted VSIX/);
      assert.match(error.message, /binding\.node/);
      assert.doesNotMatch(error.message, /MODULE_NOT_FOUND/);
      return true;
    },
  );
});

test("reports verification and extraction cleanup errors together", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "invalid-binding-cleanup-failure.vsix");
  await writeVsix(vsixPath, {
    ...baseEntries(),
    ...tomlRuntimeEntries(),
    "extension/node_modules/sqlite3/package.json": '{"main":"./lib/sqlite3.js"}',
    "extension/node_modules/sqlite3/lib/sqlite3.js":
      'module.exports = require("./sqlite3-binding.js");',
    "extension/node_modules/sqlite3/lib/sqlite3-binding.js":
      'module.exports = require("../bindings/current/binding.node");',
    "extension/node_modules/sqlite3/lib/trace.js": "module.exports = {};",
    "extension/node_modules/sqlite3/bindings/current/binding.node": "not a native binding",
    "extension/node_modules/bindings/package.json": "{}",
    "extension/node_modules/bindings/bindings.js": "module.exports = {};",
    "extension/node_modules/file-uri-to-path/package.json": "{}",
    "extension/node_modules/file-uri-to-path/index.js": "module.exports = {};",
  });

  await assert.rejects(
    verifyVsix(vsixPath, {
      expectedNativeBindingEntry:
        "extension/node_modules/sqlite3/bindings/current/binding.node",
      fsOps: {
        rm: async (path: string, options: { recursive: true; force: true }) => {
          await rm(path, options);
          throw new Error("extraction cleanup failed");
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /Native SQLite binding failed to load from extracted VSIX/);
      assert.match(error.message, /extraction cleanup failed/);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );
});

test("rejects source maps with uppercase extensions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "uppercase-source-map.vsix");

  await writeVsix(vsixPath, {
    ...baseEntries(),
    "extension/dist/extension.js.MAP": "{}",
  });

  await assert.rejects(
    verifyVsix(vsixPath),
    /VSIX must not include source maps: extension\/dist\/extension\.js\.MAP/,
  );
});

test("rejects mixed-case source archives anywhere in a VSIX", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "mixed-case-source-archive.vsix");

  await writeVsix(vsixPath, {
    ...baseEntries(),
    "extension/SQLite-Source.TaR.Gz": "source archive",
  });

  await assert.rejects(
    verifyVsix(vsixPath),
    /VSIX must not include source or archive content: extension\/SQLite-Source\.TaR\.Gz/,
  );
});

test("rejects non-runtime JavaScript from the TOML dependency", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const vsixPath = join(directory, "toml-test-helper.vsix");

  await writeVsix(vsixPath, {
    ...baseEntries(),
    ...sqliteRuntimeEntries(),
    "extension/node_modules/@iarna/toml/package.json": '{"main":"toml.js"}',
    "extension/node_modules/@iarna/toml/toml.js": "module.exports = {};",
    "extension/node_modules/@iarna/toml/test/fixture.js": "module.exports = {};",
  });

  await assert.rejects(
    verifyVsix(vsixPath, {
      expectedNativeBindingEntry:
        "extension/node_modules/sqlite3/bindings/current/binding.node",
    }),
    /VSIX contains non-runtime dependency content: extension\/node_modules\/@iarna\/toml\/test\/fixture\.js/,
  );
});

function baseEntries(): Record<string, string> {
  return {
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    "extension.vsixmanifest":
      '<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Id="fixture" Version="0.0.0" Publisher="fixture"/></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation></PackageManifest>',
    "extension/.gitignore": "node_modules/\n",
    "extension/LICENSE.txt": "MIT License\n",
    "extension/README.md": "# Codex Provider Switcher\n",
    "extension/package.json": "{}",
    "extension/dist/extension.js": "",
  };
}

function sqliteRuntimeEntries(): Record<string, string> {
  return {
    "extension/node_modules/sqlite3/package.json": "{}",
    "extension/node_modules/sqlite3/lib/sqlite3.js": "module.exports = {};",
    "extension/node_modules/sqlite3/lib/sqlite3-binding.js": "module.exports = {};",
    "extension/node_modules/sqlite3/lib/trace.js": "module.exports = {};",
    "extension/node_modules/sqlite3/bindings/current/binding.node": "not a native binding",
    "extension/node_modules/bindings/package.json": "{}",
    "extension/node_modules/bindings/bindings.js": "module.exports = {};",
    "extension/node_modules/file-uri-to-path/package.json": "{}",
    "extension/node_modules/file-uri-to-path/index.js": "module.exports = {};",
  };
}

function tomlRuntimeEntries(): Record<string, string> {
  return {
    "extension/node_modules/@iarna/toml/package.json": '{"main":"toml.js"}',
    "extension/node_modules/@iarna/toml/toml.js": "module.exports = {};",
    "extension/node_modules/@iarna/toml/parse.js": "module.exports = {};",
    "extension/node_modules/@iarna/toml/stringify.js": "module.exports = {};",
    "extension/node_modules/@iarna/toml/parse-string.js": "module.exports = {};",
    "extension/node_modules/@iarna/toml/parse-async.js": "module.exports = {};",
    "extension/node_modules/@iarna/toml/parse-stream.js": "module.exports = {};",
    "extension/node_modules/@iarna/toml/parse-pretty-error.js": "module.exports = {};",
    "extension/node_modules/@iarna/toml/lib/parser.js": "module.exports = {};",
    "extension/node_modules/@iarna/toml/lib/toml-parser.js": "module.exports = {};",
    "extension/node_modules/@iarna/toml/lib/create-datetime.js": "module.exports = {};",
    "extension/node_modules/@iarna/toml/lib/create-datetime-float.js": "module.exports = {};",
    "extension/node_modules/@iarna/toml/lib/create-date.js": "module.exports = {};",
    "extension/node_modules/@iarna/toml/lib/create-time.js": "module.exports = {};",
    "extension/node_modules/@iarna/toml/lib/format-num.js": "module.exports = {};",
  };
}

async function writeVsix(
  path: string,
  entries: Record<string, string>,
): Promise<void> {
  await writeVsixEntries(path, Object.entries(entries));
}

async function writeVsixEntries(
  path: string,
  entries: Array<[string, string]>,
): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const [entryPath, content] of entries) {
    zip.addBuffer(Buffer.from(content), entryPath);
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
