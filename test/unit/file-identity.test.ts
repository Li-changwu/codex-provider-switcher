import assert from "node:assert/strict";
import test from "node:test";
import {
  FileIdentityError,
  hasComparableFileIdentity,
  hydrateWindowsFileIdentity,
  sameStableFileIdentity,
  type FileIdentity,
} from "../../src/core/file-identity";
import type {
  WindowsFileIdentity,
  WindowsFileOperations,
} from "../../src/core/windows-file-operations";

const NATIVE_IDENTITY: WindowsFileIdentity = {
  volumeSerial: "000000000000002a",
  fileId: "0123456789abcdef0123456789abcdef",
  linkCount: 1n,
};

function identity(overrides: Partial<FileIdentity> = {}): FileIdentity {
  return {
    dev: 1n,
    ino: 2n,
    nlink: 1n,
    ...overrides,
  };
}

function nativeIdentity(
  overrides: Partial<WindowsFileIdentity> = {},
): WindowsFileIdentity {
  return { ...NATIVE_IDENTITY, ...overrides };
}

function fakeOperations(
  capture: (path: string) => WindowsFileIdentity,
): WindowsFileOperations {
  return {
    captureFileIdentity: capture,
    deleteFileIfMatches: () => {
      throw new Error("not used by file identity hydration");
    },
    holdFileIfMatches: () => {
      throw new Error("not used by file identity hydration");
    },
  };
}

test("compares exact nonzero inode identities by value on every platform", () => {
  const expected = identity();
  const numberIdentity: FileIdentity = { dev: 1, ino: 2, nlink: 1 };

  assert.equal(hasComparableFileIdentity(expected, "linux"), true);
  assert.equal(hasComparableFileIdentity(expected, "win32"), true);
  assert.equal(sameStableFileIdentity(expected, numberIdentity, "linux"), true);
  assert.equal(sameStableFileIdentity(expected, numberIdentity, "win32"), true);
  assert.equal(sameStableFileIdentity(expected, identity({ dev: 2n }), "win32"), false);
  assert.equal(sameStableFileIdentity(expected, identity({ ino: 3n }), "win32"), false);
  assert.equal(sameStableFileIdentity(expected, identity({ nlink: 2n }), "win32"), true);
});

test("hydrates a Windows zero inode observation from the native file identity", async () => {
  const calls: string[] = [];
  const original = identity({ ino: 0n });
  const hydrated = await hydrateWindowsFileIdentity(
    "C:\\codex\\config.toml",
    original,
    {
      platform: "win32",
      windowsFileOperations: fakeOperations((path) => {
        calls.push(path);
        return nativeIdentity();
      }),
    },
  );

  assert.deepEqual(calls, ["C:\\codex\\config.toml"]);
  assert.equal(original.windowsFileIdentity, undefined);
  assert.deepEqual(hydrated.windowsFileIdentity, NATIVE_IDENTITY);
  assert.equal(hasComparableFileIdentity(hydrated, "win32"), true);
});

test("compares complete native Windows identities for zero inode observations", () => {
  const first = identity({ ino: 0n, windowsFileIdentity: nativeIdentity() });
  const sameFileOnDifferentDeviceNumber = identity({
    dev: 999n,
    ino: 0n,
    windowsFileIdentity: nativeIdentity(),
  });
  const differentVolume = identity({
    ino: 0n,
    windowsFileIdentity: nativeIdentity({ volumeSerial: "0000000000000042" }),
  });
  const differentFile = identity({
    ino: 0n,
    windowsFileIdentity: nativeIdentity({ fileId: "fedcba9876543210fedcba9876543210" }),
  });
  const differentLinkCount = identity({
    ino: 0n,
    nlink: 2n,
    windowsFileIdentity: nativeIdentity({ linkCount: 2n }),
  });

  assert.equal(sameStableFileIdentity(first, sameFileOnDifferentDeviceNumber, "win32"), true);
  assert.equal(sameStableFileIdentity(first, differentVolume, "win32"), false);
  assert.equal(sameStableFileIdentity(first, differentFile, "win32"), false);
  assert.equal(sameStableFileIdentity(first, differentLinkCount, "win32"), false);
});

test("rejects missing native identities and mixed zero and nonzero inode observations", () => {
  const nativeZeroInode = identity({ ino: 0n, windowsFileIdentity: nativeIdentity() });
  const missingNativeIdentity = identity({ ino: 0n });
  const nonzeroInode = identity();

  assert.equal(hasComparableFileIdentity(missingNativeIdentity, "win32"), false);
  assert.equal(hasComparableFileIdentity(nativeZeroInode, "linux"), false);
  assert.equal(sameStableFileIdentity(nativeZeroInode, missingNativeIdentity, "win32"), false);
  assert.equal(sameStableFileIdentity(nativeZeroInode, nonzeroInode, "win32"), false);
});

test("rejects hand-crafted zero inode native identities outside the one-link boundary", () => {
  const trusted = identity({ ino: 0n, windowsFileIdentity: nativeIdentity() });
  const mismatchedLinkCount = identity({
    ino: 0n,
    nlink: 1n,
    windowsFileIdentity: nativeIdentity({ linkCount: 2n }),
  });
  const multipleLinks = identity({
    ino: 0n,
    nlink: 2n,
    windowsFileIdentity: nativeIdentity({ linkCount: 2n }),
  });

  assert.equal(hasComparableFileIdentity(mismatchedLinkCount, "win32"), false);
  assert.equal(hasComparableFileIdentity(multipleLinks, "win32"), false);
  assert.equal(sameStableFileIdentity(trusted, mismatchedLinkCount, "win32"), false);
  assert.equal(sameStableFileIdentity(trusted, multipleLinks, "win32"), false);
});

test("fails closed when native and Node link counts differ", async () => {
  let calls = 0;
  await assertRedactedFileIdentityFailure(
    () => hydrateWindowsFileIdentity(
      "C:\\sensitive\\config.toml",
      identity({ ino: 0n, nlink: 1n }),
      {
        platform: "win32",
        windowsFileOperations: fakeOperations(() => {
          calls += 1;
          return nativeIdentity({ linkCount: 2n });
        }),
      },
    ),
    "C:\\sensitive\\config.toml",
  );
  assert.equal(calls, 1);
});

test("does not invoke the native addon outside the zero inode Windows path", async () => {
  let calls = 0;
  const operations = fakeOperations(() => {
    calls += 1;
    return nativeIdentity();
  });
  const zeroInode = identity({ ino: 0n });
  const nonzeroInode = identity();

  assert.strictEqual(
    await hydrateWindowsFileIdentity("C:\\codex\\config.toml", zeroInode, {
      platform: "linux",
      windowsFileOperations: operations,
    }),
    zeroInode,
  );
  assert.strictEqual(
    await hydrateWindowsFileIdentity("C:\\codex\\config.toml", nonzeroInode, {
      platform: "win32",
      windowsFileOperations: operations,
    }),
    nonzeroInode,
  );
  assert.equal(calls, 0);
});

test("redacts native Windows identity failures", async () => {
  const targetPath = "C:\\sensitive\\config.toml";
  let calls = 0;
  await assertRedactedFileIdentityFailure(
    () => hydrateWindowsFileIdentity(targetPath, identity({ ino: 0n }), {
      platform: "win32",
      windowsFileOperations: fakeOperations(() => {
        calls += 1;
        throw new Error(`${targetPath} leaked-native-error`);
      }),
    }),
    targetPath,
    "leaked-native-error",
  );
  assert.equal(calls, 1);
});

test("rejects unsafe or negative numeric identity values", () => {
  assert.equal(
    hasComparableFileIdentity(
      { dev: Number.MAX_SAFE_INTEGER + 1, ino: 2, nlink: 1 },
      "linux",
    ),
    false,
  );
  assert.equal(
    hasComparableFileIdentity(
      { dev: 1, ino: Number.MAX_SAFE_INTEGER + 1, nlink: 1 },
      "linux",
    ),
    false,
  );

  for (const negative of [-1, -1n] as const) {
    assert.equal(hasComparableFileIdentity(identity({ dev: negative }), "linux"), false);
    assert.equal(hasComparableFileIdentity(identity({ ino: negative }), "linux"), false);
    assert.equal(hasComparableFileIdentity(identity({ nlink: negative }), "linux"), false);
  }
});

async function assertRedactedFileIdentityFailure(
  action: () => Promise<unknown>,
  ...secrets: string[]
): Promise<void> {
  const result = await action().then(
    () => undefined,
    (error: unknown) => error,
  );

  assert.equal(result instanceof FileIdentityError, true);
  assert.equal(result instanceof Error && result.cause, undefined);
  for (const secret of secrets) {
    assert.equal(result instanceof Error && result.message.includes(secret), false);
  }
}
