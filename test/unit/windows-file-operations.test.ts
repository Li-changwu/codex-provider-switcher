import assert from "node:assert/strict";
import { win32 } from "node:path";
import test from "node:test";
import {
  createWindowsFileOperations,
  WindowsFileOperationsError,
  type WindowsFileIdentity,
} from "../../src/core/windows-file-operations";

const EXTENSION_ROOT = win32.resolve("C:\\codex-provider-switcher");
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

test("uses owned immutable identity snapshots at the native binding boundary", () => {
  const nativeIdentity = { ...IDENTITY };
  const callerIdentity = { ...IDENTITY };
  const calls: WindowsFileIdentity[] = [];
  const holdToken = {};
  const operations = createWindowsFileOperations({
    platform: "win32",
    arch: "x64",
    extensionRoot: EXTENSION_ROOT,
    loadBinding: () => ({
      captureFileIdentity: () => nativeIdentity,
      deleteFileIfMatches: (_path, expected) => {
        calls.push(expected);
        return "deleted";
      },
      holdFileIfMatches: (_path, expected) => {
        calls.push(expected);
        return holdToken;
      },
      releaseFileHold: (hold) => {
        assert.strictEqual(hold, holdToken);
      },
    }),
  });

  const captured = operations.captureFileIdentity(CONFIG_PATH);
  assert.deepEqual(captured, IDENTITY);
  assert.notStrictEqual(captured, nativeIdentity);
  assert.ok(Object.isFrozen(captured));
  nativeIdentity.fileId = "fedcba9876543210fedcba9876543210";
  assert.deepEqual(captured, IDENTITY);

  assert.equal(operations.deleteFileIfMatches(CONFIG_PATH, callerIdentity), "deleted");
  const hold = operations.holdFileIfMatches(CONFIG_PATH, callerIdentity);
  assert.equal(calls.length, 2);
  for (const expected of calls) {
    assert.notStrictEqual(expected, callerIdentity);
    assert.deepEqual(expected, IDENTITY);
    assert.ok(Object.isFrozen(expected));
  }

  callerIdentity.fileId = "fedcba9876543210fedcba9876543210";
  for (const expected of calls) {
    assert.deepEqual(expected, IDENTITY);
  }
  hold.close();
});

test("retries a failed hold release and releases no more than once after success", () => {
  const holdToken = {};
  let releases = 0;
  const operations = createWindowsFileOperations({
    platform: "win32",
    arch: "x64",
    extensionRoot: EXTENSION_ROOT,
    loadBinding: () => validBinding({
      holdFileIfMatches: () => holdToken,
      releaseFileHold: (hold) => {
        assert.strictEqual(hold, holdToken);
        releases += 1;
        if (releases === 1) {
          throw new Error("native release failed");
        }
      },
    }),
  });

  const hold = operations.holdFileIfMatches(CONFIG_PATH, IDENTITY);
  assertWindowsError(() => hold.close(), "WINDOWS_FILE_OPERATIONS_INVALID");
  assert.equal(releases, 1);

  hold.close();
  assert.equal(releases, 2);

  hold.close();
  assert.equal(releases, 2);
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

test("rejects a Windows backslash traversal root on every host", () => {
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

test("constructs the addon path with Windows semantics when win32 is mocked", () => {
  let addonPath: string | undefined;
  const operations = createWindowsFileOperations({
    platform: "win32",
    arch: "x64",
    extensionRoot: EXTENSION_ROOT,
    loadBinding: (path) => {
      addonPath = path;
      return validBinding();
    },
  });

  assert.deepEqual(operations.captureFileIdentity(CONFIG_PATH), IDENTITY);
  assert.equal(
    addonPath,
    win32.resolve(EXTENSION_ROOT, "native", "windows-file-ops", "windows_file_ops.node"),
  );
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
