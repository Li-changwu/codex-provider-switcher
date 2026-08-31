import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import {
  findNativeBinding,
  runNodeModuleRequire,
  runNodeScript,
} from "./sqlite-binding-utils.mjs";

export const sqlitePrefix = "extension/node_modules/sqlite3/";
// The current sqlite3 VSIX has about 1,400 files and 12 MiB of payload.
export const MAX_ZIP_ENTRIES = 5_000;
export const MAX_VSIX_ENTRIES = MAX_ZIP_ENTRIES;
export const MAX_VSIX_ENTRY_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
export const MAX_VSIX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const requiredSqliteRuntimeEntries = [
  "extension/node_modules/sqlite3/package.json",
  "extension/node_modules/sqlite3/lib/sqlite3.js",
  "extension/node_modules/sqlite3/lib/sqlite3-binding.js",
  "extension/node_modules/sqlite3/lib/trace.js",
  "extension/node_modules/bindings/package.json",
  "extension/node_modules/bindings/bindings.js",
  "extension/node_modules/file-uri-to-path/package.json",
  "extension/node_modules/file-uri-to-path/index.js",
];
const requiredTomlRuntimeEntries = [
  "extension/node_modules/@iarna/toml/package.json",
  "extension/node_modules/@iarna/toml/toml.js",
  "extension/node_modules/@iarna/toml/parse.js",
  "extension/node_modules/@iarna/toml/stringify.js",
  "extension/node_modules/@iarna/toml/parse-string.js",
  "extension/node_modules/@iarna/toml/parse-async.js",
  "extension/node_modules/@iarna/toml/parse-stream.js",
  "extension/node_modules/@iarna/toml/parse-pretty-error.js",
  "extension/node_modules/@iarna/toml/lib/parser.js",
  "extension/node_modules/@iarna/toml/lib/toml-parser.js",
  "extension/node_modules/@iarna/toml/lib/create-datetime.js",
  "extension/node_modules/@iarna/toml/lib/create-datetime-float.js",
  "extension/node_modules/@iarna/toml/lib/create-date.js",
  "extension/node_modules/@iarna/toml/lib/create-time.js",
  "extension/node_modules/@iarna/toml/lib/format-num.js",
];
const baseRequiredVsixEntries = [
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/.gitignore",
  "extension/changelog.md",
  "extension/LICENSE.txt",
  "extension/readme.md",
  "extension/media/icon.png",
  "extension/package.json",
  "extension/dist/extension.js",
];
const windowsFileOperationsAddonEntry =
  "extension/native/windows-file-ops/windows_file_ops.node";
const windowsFileOperationsVerificationScript = [
  "const addonPath = process.argv[1];",
  "const addon = require(addonPath);",
  'if (typeof addon.captureFileIdentity !== "function") {',
  '  throw new TypeError("Windows file-operations addon does not export captureFileIdentity.");',
  "}",
  "addon.captureFileIdentity(addonPath);",
].join("\n");
const installerDependencies = ["node-gyp", "prebuild-install", "tar"];
const typeScriptDeclarationExtensions = [".d.ts", ".d.mts", ".d.cts"];
const sourceOrArchiveExtensions = [
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".gyp",
  ".gypi",
  ".tar",
  ".tar.gz",
  ".tgz",
  ".zip",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
];

export async function verifyVsix(vsixPath, options = {}) {
  const fsOps = { mkdtemp, rm, ...options.fsOps };
  const limits = resolveLimits(options.limits);
  const requiredEntries = requiredVsixEntriesForTarget(options.target);
  const expectedNativeBindingEntry = await resolveExpectedNativeBindingEntry(
    options.expectedNativeBindingEntry,
  );
  const archiveRules = createArchiveRules(expectedNativeBindingEntry, options.target);
  const listedEntries = await listZipEntries(vsixPath, limits);
  validateArchiveEntries(listedEntries, archiveRules);
  const entries = new Set(listedEntries);

  for (const entry of requiredEntries) {
    if (!entries.has(entry)) {
      throw new Error(`VSIX is missing required entry: ${entry}`);
    }
  }
  if (!entries.has(expectedNativeBindingEntry)) {
    throw new Error(`Missing native SQLite binding under: ${sqlitePrefix}`);
  }
  for (const entry of [...requiredSqliteRuntimeEntries, ...requiredTomlRuntimeEntries]) {
    if (!entries.has(entry)) {
      throw new Error(`VSIX is missing SQLite runtime entry: ${entry}`);
    }
  }

  const extractionRoot = await fsOps.mkdtemp(join(tmpdir(), "codex-provider-switcher-vsix-"));
  let verificationError;
  try {
    await extractVsix(vsixPath, extractionRoot, {
      limits,
      validateEntry: (entry) => validateArchiveEntry(entry, archiveRules),
    });
    const extensionRoot = resolve(extractionRoot, "extension");
    const nativeBindingPath = await findNativeBinding(
      resolve(extensionRoot, "node_modules/sqlite3"),
    );
    if (!nativeBindingPath) {
      throw new Error(`Missing native SQLite binding under: ${sqlitePrefix}`);
    }
    await verifyExtractedModule(extensionRoot, "sqlite3", "Native SQLite binding");
    await verifyExtractedModule(extensionRoot, "@iarna/toml", "TOML runtime");
    if (options.target === "win32-x64") {
      await verifyWindowsFileOperationsAddon(extensionRoot);
    }

    return entries;
  } catch (error) {
    verificationError = error;
    throw error;
  } finally {
    try {
      await fsOps.rm(extractionRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      if (verificationError) {
        throw new AggregateError(
          [verificationError, cleanupError],
          `VSIX verification failed and extraction cleanup failed: ${verificationError.message}\n${cleanupError.message}`,
        );
      }
      throw cleanupError;
    }
  }
}

async function resolveExpectedNativeBindingEntry(configuredEntry) {
  if (configuredEntry) {
    return normalizeArchiveEntryPath(configuredEntry);
  }

  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sqlitePackagePath = resolve(projectRoot, "node_modules/sqlite3");
  const nativeBindingPath = await findNativeBinding(sqlitePackagePath);
  if (!nativeBindingPath) {
    throw new Error(`Missing installed native SQLite binding under: ${sqlitePackagePath}`);
  }

  return `${sqlitePrefix}${normalizeArchiveEntryPath(
    relative(sqlitePackagePath, nativeBindingPath),
  )}`;
}

export function createArchiveRules(expectedNativeBindingEntry, target) {
  const allowedEntries = [
    ...requiredVsixEntriesForTarget(target),
    ...requiredSqliteRuntimeEntries,
    ...requiredTomlRuntimeEntries,
    expectedNativeBindingEntry,
  ];
  const entriesByCanonicalPath = new Map();
  for (const entry of allowedEntries) {
    const normalizedEntry = normalizeArchiveEntryPath(entry);
    entriesByCanonicalPath.set(canonicalArchiveEntryPath(normalizedEntry), normalizedEntry);
  }

  const directoriesByCanonicalPath = new Map();
  for (const entry of allowedEntries) {
    const parts = normalizeArchiveEntryPath(entry).split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const directory = `${parts.slice(0, index).join("/")}/`;
      directoriesByCanonicalPath.set(canonicalArchiveEntryPath(directory), directory);
    }
  }

  return { entriesByCanonicalPath, directoriesByCanonicalPath };
}

export function validateArchiveEntries(entries, archiveRules) {
  const sourceMaps = [...entries].filter((entry) =>
    canonicalArchiveEntryPath(entry).endsWith(".map"),
  );
  if (sourceMaps.length > 0) {
    throw new Error(`VSIX must not include source maps: ${sourceMaps.join(", ")}`);
  }
  for (const entry of entries) {
    const canonicalEntry = canonicalArchiveEntryPath(entry);
    if (
      typeScriptDeclarationExtensions.some((extension) => canonicalEntry.endsWith(extension))
    ) {
      throw new Error(`VSIX must not include TypeScript declarations: ${entry}`);
    }
    if (sourceOrArchiveExtensions.some((extension) => canonicalEntry.endsWith(extension))) {
      throw new Error(`VSIX must not include source or archive content: ${entry}`);
    }
    const installerDependency = installerDependencies.find((dependency) =>
      canonicalEntry.includes(`/node_modules/${dependency}/`),
    );
    if (installerDependency) {
      throw new Error(`VSIX must not include install-time dependency: ${installerDependency}`);
    }
    validateArchiveEntry(entry, archiveRules);
  }
}

function requiredVsixEntriesForTarget(target) {
  return target === "win32-x64"
    ? [...baseRequiredVsixEntries, windowsFileOperationsAddonEntry]
    : baseRequiredVsixEntries;
}

function validateArchiveEntry(entry, archiveRules) {
  const normalizedEntry = normalizeArchiveEntryPath(entry);
  const canonicalEntry = canonicalArchiveEntryPath(normalizedEntry);
  const expectedEntry = normalizedEntry.endsWith("/")
    ? archiveRules.directoriesByCanonicalPath.get(canonicalEntry)
    : archiveRules.entriesByCanonicalPath.get(canonicalEntry);
  if (expectedEntry === undefined) {
    if (canonicalEntry.startsWith("extension/node_modules/")) {
      throw new Error(`VSIX contains non-runtime dependency content: ${normalizedEntry}`);
    }
    throw new Error(`VSIX contains unexpected archive entry: ${normalizedEntry}`);
  }
  if (normalizedEntry !== expectedEntry) {
    throw new Error(`VSIX entry path is not canonical: ${normalizedEntry}`);
  }
}

function normalizeArchiveEntryPath(entry) {
  return entry.replaceAll("\\", "/");
}

function canonicalArchiveEntryPath(entry) {
  return normalizeArchiveEntryPath(entry).toLowerCase();
}

function createCanonicalPathTracker() {
  const seenEntries = new Set();
  return (entryPath) => {
    const canonicalPath = canonicalArchiveEntryPath(entryPath);
    if (seenEntries.has(canonicalPath)) {
      throw new Error(`VSIX contains duplicate canonical path: ${canonicalPath}`);
    }
    seenEntries.add(canonicalPath);
  };
}

async function verifyExtractedModule(extensionRoot, moduleName, moduleLabel) {
  const result = await runNodeModuleRequire(extensionRoot, moduleName);
  if (result.timedOut) {
    throw new Error(
      `${moduleLabel} load timed out after ${result.timeoutMs}ms from extracted VSIX.`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      [`${moduleLabel} failed to load from extracted VSIX.`, result.output].join("\n"),
    );
  }
}

async function verifyWindowsFileOperationsAddon(extensionRoot) {
  const addonPath = resolve(
    extensionRoot,
    "native/windows-file-ops/windows_file_ops.node",
  );
  const result = await runNodeScript(
    extensionRoot,
    windowsFileOperationsVerificationScript,
    [addonPath],
  );
  if (result.timedOut) {
    throw new Error(
      `Windows file-operations addon validation timed out after ${result.timeoutMs}ms from extracted VSIX.`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      [
        "Windows file-operations addon failed to load or validate from extracted VSIX.",
        result.output,
      ].join("\n"),
    );
  }
}

function resolveLimits(overrides = {}) {
  return {
    maxEntries: MAX_ZIP_ENTRIES,
    maxEntryUncompressedBytes: MAX_VSIX_ENTRY_UNCOMPRESSED_BYTES,
    maxUncompressedBytes: MAX_VSIX_UNCOMPRESSED_BYTES,
    ...overrides,
  };
}

function createArchiveLimitTracker(limits) {
  let entryCount = 0;
  let uncompressedBytes = 0;
  return (entry) => {
    entryCount += 1;
    const entrySize = entry.uncompressedSize;
    if (entryCount > limits.maxEntries) {
      throw new Error(`VSIX exceeds the maximum entry count: ${limits.maxEntries}`);
    }
    if (entrySize > limits.maxEntryUncompressedBytes) {
      throw new Error(`VSIX entry exceeds the maximum uncompressed size: ${entry.fileName}`);
    }
    uncompressedBytes += entrySize;
    if (uncompressedBytes > limits.maxUncompressedBytes) {
      throw new Error(
        `VSIX exceeds the maximum aggregate uncompressed size: ${limits.maxUncompressedBytes}`,
      );
    }
  };
}

function normalizedDeclaredArchiveEntryPath(entry) {
  return normalizeArchiveEntryPath(entry.fileName);
}

function assertForwardSlashArchiveEntryPath(entry, normalizedEntry) {
  if (normalizedEntry !== entry.fileName) {
    throw new Error(`VSIX entry path must use forward slashes: ${entry.fileName}`);
  }
}

function listZipEntries(vsixPath, limits, options = {}) {
  const validateEntry = options.validateEntry;
  return new Promise((resolveEntries, reject) => {
    let zipFile;
    let settled = false;
    const trackEntry = createArchiveLimitTracker(limits);
    const trackCanonicalPath = createCanonicalPathTracker();
    const settle = (error, entries) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        zipFile?.close();
      } catch {
        // The zip may already be closed after an error.
      }
      if (error) {
        reject(error);
      } else {
        resolveEntries(entries);
      }
    };

    yauzl.open(vsixPath, { lazyEntries: true }, (error, openedZipFile) => {
      if (error) {
        settle(error);
        return;
      }

      zipFile = openedZipFile;
      const entries = [];
      zipFile.once("error", (zipError) => settle(zipError));
      zipFile.on("entry", (entry) => {
        if (settled) {
          return;
        }
        try {
          trackEntry(entry);
          const entryPath = normalizedDeclaredArchiveEntryPath(entry);
          trackCanonicalPath(entryPath);
          assertForwardSlashArchiveEntryPath(entry, entryPath);
          validateEntry?.(entryPath);
          entries.push(entryPath);
        } catch (entryError) {
          settle(entryError);
          return;
        }
        zipFile.readEntry();
      });
      zipFile.once("end", () => settle(undefined, entries));
      zipFile.readEntry();
    });
  });
}

export async function extractVsix(vsixPath, extractionRoot, options = {}) {
  const limits = resolveLimits(options.limits);
  const validateEntry = options.validateEntry;
  await listZipEntries(vsixPath, limits, { validateEntry });
  return extractZipEntries(vsixPath, extractionRoot, limits, validateEntry);
}

function extractZipEntries(vsixPath, extractionRoot, limits, validateEntry) {
  return new Promise((resolveExtraction, reject) => {
    let zipFile;
    let input;
    let output;
    let settled = false;
    const trackEntry = createArchiveLimitTracker(limits);
    const trackCanonicalPath = createCanonicalPathTracker();
    const destroyActiveStreams = () => {
      input?.destroy();
      output?.destroy();
    };
    const settle = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      destroyActiveStreams();
      try {
        zipFile?.close();
      } catch {
        // The zip may already be closed after an error.
      }
      if (error) {
        reject(error);
      } else {
        resolveExtraction();
      }
    };

    yauzl.open(vsixPath, { lazyEntries: true }, (openError, openedZipFile) => {
      if (openError) {
        settle(openError);
        return;
      }

      zipFile = openedZipFile;
      const fail = (error) => settle(error);
      zipFile.once("error", fail);
      zipFile.on("entry", (entry) => {
        if (settled) {
          return;
        }
        let entryPath;
        try {
          trackEntry(entry);
          entryPath = normalizedDeclaredArchiveEntryPath(entry);
          trackCanonicalPath(entryPath);
          assertForwardSlashArchiveEntryPath(entry, entryPath);
          validateEntry?.(entryPath);
        } catch (entryError) {
          fail(entryError);
          return;
        }
        if (entryPath.endsWith("/")) {
          zipFile.readEntry();
          return;
        }

        const outputPath = resolve(extractionRoot, entryPath);
        const relativePath = relative(extractionRoot, outputPath);
        if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
          fail(new Error(`Unsafe VSIX path: ${entryPath}`));
          return;
        }

        zipFile.openReadStream(entry, (streamError, readStream) => {
          if (streamError) {
            fail(streamError);
            return;
          }
          input = readStream;
          mkdir(dirname(outputPath), { recursive: true }).then(
            () => {
              if (settled) {
                return;
              }
              output = createWriteStream(outputPath);
              input.once("error", fail);
              output.once("error", fail);
              output.once("finish", () => {
                input = undefined;
                output = undefined;
                if (!settled) {
                  zipFile.readEntry();
                }
              });
              input.pipe(output);
            },
            fail,
          );
        });
      });
      zipFile.once("end", () => settle());
      zipFile.readEntry();
    });
  });
}
