import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  createWindowsFileOperations,
  WindowsFileOperationsError,
  type WindowsFileIdentity,
} from "../../src/core/windows-file-operations";

const EXTENSION_ROOT = resolve("C:\\codex-provider-switcher");
const CONFIG_PATH = "C:\\profiles\\config.toml";
const IDENTITY: WindowsFileIdentity = {
  volumeSerial: "0123456789abcdef",
  fileId: "0123456789abcdef0123456789abcdef",
  linkCount: 1n,
};

test("does not load the Windows addon on Linux and fails closed", () => {
  let loads = 0;
  const operations = createWindowsFileOperations({
    platform: "linux",
    arch: "x64",
    extensionRoot: EXTENSION_ROOT,
    loadBinding: () => {
      loads += 1;
      return validBinding();
    },
  });

  assertWindowsError(
    () => operations.captureFileIdentity(CONFIG_PATH),
    "WINDOWS_FILE_OPERATIONS_UNAVAILABLE",
  );
  assert.equal(loads, 0);
});

test("fails closed without loading the addon on unsupported Windows architecture", () => {
  let loads = 0;
  const operations = createWindowsFileOperations({
    platform: "win32",
    arch: "arm64",
    extensionRoot: EXTENSION_ROOT,
    loadBinding: () => {
      loads += 1;
      return validBinding();
    },
  });

  assertWindowsError(
    () => operations.captureFileIdentity(CONFIG_PATH),
    "WINDOWS_FILE_OPERATIONS_UNAVAILABLE",
  );
  assert.equal(loads, 0);
});

test("rejects malformed native identities", () => {
  for (const malformed of [
    { ...IDENTITY, volumeSerial: "0123456789ABCDEf" },
    { ...IDENTITY, fileId: "0123456789abcdef" },
    { ...IDENTITY, linkCount: 2n },
  ]) {
    const operations = createWindowsFileOperations({
      platform: "win32",
      arch: "x64",
      extensionRoot: EXTENSION_ROOT,
      loadBinding: () => validBinding({ captureFileIdentity: () => malformed }),
    });

    assertWindowsError(
      () => operations.captureFileIdentity(CONFIG_PATH),
      "WINDOWS_FILE_OPERATIONS_INVALID",
    );
  }
});

test("passes canonical values to the binding and releases a hold exactly once", () => {
  const calls: Array<{ path: string; expected: WindowsFileIdentity }> = [];
  const holdToken = {};
  let releases = 0;
  const operations = createWindowsFileOperations({
    platform: "win32",
    arch: "x64",
    extensionRoot: EXTENSION_ROOT,
    loadBinding: () => ({
      captureFileIdentity: () => IDENTITY,
      deleteFileIfMatches: (path, expected) => {
        calls.push({ path, expected });
        return "deleted";
      },
      holdFileIfMatches: (path, expected) => {
        calls.push({ path, expected });
        return holdToken;
      },
      releaseFileHold: (hold) => {
        assert.strictEqual(hold, holdToken);
        releases += 1;
      },
    }),
  });

  assert.deepEqual(operations.captureFileIdentity(CONFIG_PATH), IDENTITY);
  assert.equal(operations.deleteFileIfMatches(CONFIG_PATH, IDENTITY), "deleted");
  const hold = operations.holdFileIfMatches(CONFIG_PATH, IDENTITY);
  hold.close();
  hold.close();

  assert.deepEqual(calls, [
    { path: CONFIG_PATH, expected: IDENTITY },
    { path: CONFIG_PATH, expected: IDENTITY },
  ]);
  assert.equal(releases, 1);
});

test("normalizes loader and binding failures", () => {
  const unavailable = createWindowsFileOperations({
    platform: "win32",
    arch: "x64",
    extensionRoot: EXTENSION_ROOT,
    loadBinding: () => {
      throw new Error("native addon load failed");
    },
  });
  assertWindowsError(
    () => unavailable.captureFileIdentity(CONFIG_PATH),
    "WINDOWS_FILE_OPERATIONS_UNAVAILABLE",
  );

  const invalid = createWindowsFileOperations({
    platform: "win32",
    arch: "x64",
    extensionRoot: EXTENSION_ROOT,
    loadBinding: () => validBinding({
      captureFileIdentity: () => {
        throw new Error("native capture failed");
      },
    }),
  });
  assertWindowsError(
    () => invalid.captureFileIdentity(CONFIG_PATH),
    "WINDOWS_FILE_OPERATIONS_INVALID",
  );
});

test("rejects an addon resolution that escapes the extension root", () => {
  let loads = 0;
  const operations = createWindowsFileOperations({
    platform: "win32",
    arch: "x64",
    extensionRoot: `${EXTENSION_ROOT}\\..\\outside`,
    loadBinding: () => {
      loads += 1;
      return validBinding();
    },
  });

  assertWindowsError(
    () => operations.captureFileIdentity(CONFIG_PATH),
    "WINDOWS_FILE_OPERATIONS_INVALID",
  );
  assert.equal(loads, 0);
});

test("rejects invalid paths before calling the native binding", () => {
  let captures = 0;
  const operations = createWindowsFileOperations({
    platform: "win32",
    arch: "x64",
    extensionRoot: EXTENSION_ROOT,
    loadBinding: () => validBinding({
      captureFileIdentity: () => {
        captures += 1;
        return IDENTITY;
      },
    }),
  });

  for (const path of ["config.toml", "C:\\profiles\\config\u0000.toml"]) {
    assertWindowsError(
      () => operations.captureFileIdentity(path),
      "WINDOWS_FILE_OPERATIONS_INVALID",
    );
  }
  assert.equal(captures, 0);
});

interface NativeBindingOverrides {
  captureFileIdentity?: (path: string) => unknown;
  deleteFileIfMatches?: (path: string, expected: WindowsFileIdentity) => unknown;
  holdFileIfMatches?: (path: string, expected: WindowsFileIdentity) => unknown;
  releaseFileHold?: (hold: object) => void;
}

function validBinding(overrides: NativeBindingOverrides = {}) {
  return {
    captureFileIdentity: overrides.captureFileIdentity ?? (() => IDENTITY),
    deleteFileIfMatches: overrides.deleteFileIfMatches ?? (() => "deleted"),
    holdFileIfMatches: overrides.holdFileIfMatches ?? (() => ({})),
    releaseFileHold: overrides.releaseFileHold ?? (() => undefined),
  };
}

function assertWindowsError(
  action: () => unknown,
  code: WindowsFileOperationsError["code"],
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof WindowsFileOperationsError);
    assert.equal(error.code, code);
    return true;
  });
}
