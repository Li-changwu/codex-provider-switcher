import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
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
  holdFileIfMatches(path: string, expected: NativeFileIdentity): object;
  releaseFileHold(hold: object): void;
}

const require = createRequire(import.meta.url);
const addonPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../native/windows-file-ops/windows_file_ops.node",
);

test(
  "Windows file hold prevents source rename until released",
  { skip: process.platform !== "win32" },
  () => {
    const temporaryPrefix = join(tmpdir(), "codex-provider-switcher-file-ops-");
    const temporaryDirectory = mkdtempSync(temporaryPrefix);
    assert.ok(temporaryDirectory.startsWith(temporaryPrefix));

    const targetPath = join(temporaryDirectory, "config.toml");
    const renamedPath = join(temporaryDirectory, "renamed.toml");
    const addon = require(addonPath) as NativeWindowsFileOperations;
    let hold: object | undefined;
    const configContents = "model = \"gpt-5.6-sol\"\n";

    try {
      writeFileSync(targetPath, configContents, "utf8");
      const identity = addon.captureFileIdentity(targetPath);
      hold = addon.holdFileIfMatches(targetPath, identity);

      assert.throws(
        () => renameSync(targetPath, renamedPath),
        (error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code;
          // Node maps Windows sharing violations to platform/version-dependent errno codes.
          assert.ok(
            code === "EPERM" || code === "EACCES" || code === "EBUSY",
            `unexpected code: ${code}`,
          );
          return true;
        },
      );
      assert.equal(existsSync(targetPath), true);
      assert.equal(existsSync(renamedPath), false);
      assert.equal(readFileSync(targetPath, "utf8"), configContents);

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
