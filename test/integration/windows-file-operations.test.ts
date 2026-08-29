import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

interface NativeFileIdentity {
  readonly volumeSerial: string;
  readonly fileId: string;
  readonly linkCount: bigint;
}

interface NativeWindowsFileOperations {
  captureFileIdentity(path: string): NativeFileIdentity;
  deleteFileIfMatches(
    path: string,
    expected: NativeFileIdentity,
  ): "deleted" | "identity-mismatch";
  deleteHardLinkIfMatches(
    path: string,
    expected: NativeFileIdentity,
  ): "deleted" | "identity-mismatch";
  replaceFileIfMatches(
    source: string,
    destination: string,
    expected: NativeFileIdentity,
  ): "replaced" | "identity-mismatch";
  holdFileIfMatches(path: string, expected: NativeFileIdentity): object;
  releaseFileHold(hold: object): void;
}

const require = createRequire(import.meta.url);
const addonPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../native/windows-file-ops/windows_file_ops.node",
);

test(
  "Windows addon rejects deletion of a same-content replacement",
  { skip: process.platform !== "win32" },
  () => {
    const temporaryPrefix = join(tmpdir(), "codex-provider-switcher-file-ops-");
    const temporaryDirectory = mkdtempSync(temporaryPrefix);
    assert.ok(temporaryDirectory.startsWith(temporaryPrefix));

    const targetPath = join(temporaryDirectory, "config.toml");
    const replacementPath = join(temporaryDirectory, "replacement.toml");
    const addon = require(addonPath) as NativeWindowsFileOperations;
    const configContents = "model = \"gpt-5.6-sol\"\n";

    try {
      writeFileSync(targetPath, configContents, "utf8");
      const originalIdentity = addon.captureFileIdentity(targetPath);

      writeFileSync(replacementPath, configContents, "utf8");
      renameSync(replacementPath, targetPath);
      const replacementIdentity = addon.captureFileIdentity(targetPath);

      assert.notEqual(replacementIdentity.fileId, originalIdentity.fileId);
      assert.equal(
        addon.deleteFileIfMatches(targetPath, originalIdentity),
        "identity-mismatch",
      );
      assert.equal(existsSync(targetPath), true);
      assert.equal(readFileSync(targetPath, "utf8"), configContents);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  },
);

test(
  "Windows addon safely removes a hard-link handoff source",
  { skip: process.platform !== "win32" },
  () => {
    const temporaryPrefix = join(tmpdir(), "codex-provider-switcher-file-ops-");
    const temporaryDirectory = mkdtempSync(temporaryPrefix);
    assert.ok(temporaryDirectory.startsWith(temporaryPrefix));

    const sourcePath = join(temporaryDirectory, "lock.handoff");
    const destinationPath = join(temporaryDirectory, "lock");
    const addon = require(addonPath) as NativeWindowsFileOperations;

    try {
      writeFileSync(sourcePath, "original lock\n", "utf8");
      const originalIdentity = addon.captureFileIdentity(sourcePath);
      linkSync(sourcePath, destinationPath);

      assert.equal(
        addon.deleteHardLinkIfMatches(sourcePath, originalIdentity),
        "deleted",
      );
      assert.equal(existsSync(sourcePath), false);
      assert.equal(existsSync(destinationPath), true);
      assert.equal(readFileSync(destinationPath, "utf8"), "original lock\n");

      const replacedSourcePath = join(temporaryDirectory, "replaced.handoff");
      const replacedDestinationPath = join(temporaryDirectory, "replaced.lock");
      writeFileSync(replacedSourcePath, "original lock\n", "utf8");
      const replacedIdentity = addon.captureFileIdentity(replacedSourcePath);
      linkSync(replacedSourcePath, replacedDestinationPath);
      rmSync(replacedSourcePath);
      writeFileSync(replacedSourcePath, "replacement lock\n", "utf8");

      assert.equal(
        addon.deleteHardLinkIfMatches(replacedSourcePath, replacedIdentity),
        "identity-mismatch",
      );
      assert.equal(readFileSync(replacedSourcePath, "utf8"), "replacement lock\n");
      assert.equal(readFileSync(replacedDestinationPath, "utf8"), "original lock\n");
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  },
);

test(
  "Windows addon restores a matching target through verified handles",
  { skip: process.platform !== "win32" },
  () => {
    const temporaryPrefix = join(tmpdir(), "codex-provider-switcher-file-ops-");
    const temporaryDirectory = mkdtempSync(temporaryPrefix);
    assert.ok(temporaryDirectory.startsWith(temporaryPrefix));

    const sourcePath = join(temporaryDirectory, "config.restore");
    const destinationPath = join(temporaryDirectory, "config.toml");
    const addon = require(addonPath) as NativeWindowsFileOperations;

    try {
      writeFileSync(destinationPath, "original config\n", "utf8");
      writeFileSync(sourcePath, "restored config\n", "utf8");
      const originalIdentity = addon.captureFileIdentity(destinationPath);

      assert.equal(
        addon.replaceFileIfMatches(sourcePath, destinationPath, originalIdentity),
        "replaced",
      );
      assert.equal(existsSync(sourcePath), false);
      assert.equal(readFileSync(destinationPath, "utf8"), "restored config\n");
      assert.equal(addon.captureFileIdentity(destinationPath).fileId, originalIdentity.fileId);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  },
);

test(
  "Windows addon preserves a replacement when the target identity mismatches",
  { skip: process.platform !== "win32" },
  () => {
    const temporaryPrefix = join(tmpdir(), "codex-provider-switcher-file-ops-");
    const temporaryDirectory = mkdtempSync(temporaryPrefix);
    assert.ok(temporaryDirectory.startsWith(temporaryPrefix));

    const sourcePath = join(temporaryDirectory, "config.restore");
    const destinationPath = join(temporaryDirectory, "config.toml");
    const replacementPath = join(temporaryDirectory, "config.replacement");
    const addon = require(addonPath) as NativeWindowsFileOperations;

    try {
      writeFileSync(destinationPath, "original config\n", "utf8");
      writeFileSync(sourcePath, "restored config\n", "utf8");
      const originalIdentity = addon.captureFileIdentity(destinationPath);
      writeFileSync(replacementPath, "replacement config\n", "utf8");
      renameSync(replacementPath, destinationPath);

      assert.equal(
        addon.replaceFileIfMatches(sourcePath, destinationPath, originalIdentity),
        "identity-mismatch",
      );
      assert.equal(existsSync(sourcePath), true);
      assert.equal(readFileSync(destinationPath, "utf8"), "replacement config\n");
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  },
);

test(
  "Windows file hold prevents target replacement and source rename until released",
  { skip: process.platform !== "win32" },
  () => {
    const temporaryPrefix = join(tmpdir(), "codex-provider-switcher-file-ops-");
    const temporaryDirectory = mkdtempSync(temporaryPrefix);
    assert.ok(temporaryDirectory.startsWith(temporaryPrefix));

    const targetPath = join(temporaryDirectory, "config.toml");
    const replacementPath = join(temporaryDirectory, "replacement.toml");
    const renamedPath = join(temporaryDirectory, "renamed.toml");
    const addon = require(addonPath) as NativeWindowsFileOperations;
    let hold: object | undefined;
    const configContents = "model = \"gpt-5.6-sol\"\n";
    const replacementContents = "model = \"replacement\"\n";

    try {
      writeFileSync(targetPath, configContents, "utf8");
      writeFileSync(replacementPath, replacementContents, "utf8");
      const identity = addon.captureFileIdentity(targetPath);
      hold = addon.holdFileIfMatches(targetPath, identity);

      assertSharingViolation(() => renameSync(replacementPath, targetPath));
      assert.equal(existsSync(targetPath), true);
      assert.equal(readFileSync(targetPath, "utf8"), configContents);
      assert.equal(existsSync(replacementPath), true);
      assert.equal(readFileSync(replacementPath, "utf8"), replacementContents);

      assertSharingViolation(() => renameSync(targetPath, renamedPath));
      assert.equal(existsSync(targetPath), true);
      assert.equal(existsSync(renamedPath), false);
      assert.equal(readFileSync(targetPath, "utf8"), configContents);

      addon.releaseFileHold(hold);
      addon.releaseFileHold(hold);
      hold = undefined;
      renameSync(targetPath, renamedPath);
      assert.equal(existsSync(targetPath), false);
      assert.equal(existsSync(renamedPath), true);
      assert.equal(readFileSync(renamedPath, "utf8"), configContents);
    } finally {
      if (hold !== undefined) {
        addon.releaseFileHold(hold);
      }
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  },
);

test(
  "Windows addon rejects final-component reparse points",
  { skip: process.platform !== "win32" },
  (context) => {
    const temporaryPrefix = join(tmpdir(), "codex-provider-switcher-file-ops-");
    const temporaryDirectory = mkdtempSync(temporaryPrefix);
    assert.ok(temporaryDirectory.startsWith(temporaryPrefix));

    const targetPath = join(temporaryDirectory, "config.toml");
    const reparsePath = join(temporaryDirectory, "config-link.toml");
    const addon = require(addonPath) as NativeWindowsFileOperations;

    try {
      writeFileSync(targetPath, "model = \"gpt-5.6-sol\"\n", "utf8");
      try {
        symlinkSync(targetPath, reparsePath, "file");
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") {
          context.skip(`Windows cannot create a symbolic link for this test: ${code}`);
          return;
        }
        throw error;
      }

      assert.throws(() => addon.captureFileIdentity(reparsePath), (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, "WINDOWS_FILE_OPS_INVALID");
        return true;
      });
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  },
);

function assertSharingViolation(action: () => void): void {
  assert.throws(action, (error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    // Node maps Windows sharing violations to platform/version-dependent errno codes.
    assert.ok(
      code === "EPERM" || code === "EACCES" || code === "EBUSY",
      `unexpected code: ${code}`,
    );
    return true;
  });
}
