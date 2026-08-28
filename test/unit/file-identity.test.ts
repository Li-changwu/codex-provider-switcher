import assert from "node:assert/strict";
import test from "node:test";
import {
  FileIdentityError,
  hasComparableFileIdentity,
  hydrateWindowsFileIdentity,
  sameStableFileIdentity,
  type FileIdentity,
  type WindowsFileIdCommandRunner,
} from "../../src/core/file-identity";

const FILE_ID = "0x0123456789abcdef";
const OTHER_FILE_ID = "0xfedcba9876543210";

function identity(overrides: Partial<FileIdentity> = {}): FileIdentity {
  return {
    dev: 1n,
    ino: 2n,
    nlink: 1n,
    ...overrides,
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

test("uses only canonical Windows File IDs for zero-inode fallback", () => {
  const expected = identity({ ino: 0n, windowsFileId: FILE_ID });
  const matchingNumbers: FileIdentity = {
    dev: 1,
    ino: 0,
    nlink: 1,
    windowsFileId: FILE_ID,
  };

  assert.equal(hasComparableFileIdentity(expected, "win32"), true);
  assert.equal(hasComparableFileIdentity(expected, "linux"), false);
  assert.equal(sameStableFileIdentity(expected, matchingNumbers, "win32"), true);
  assert.equal(sameStableFileIdentity(expected, matchingNumbers, "linux"), false);
  assert.equal(sameStableFileIdentity(expected, identity({ windowsFileId: FILE_ID }), "win32"), false);
  assert.equal(sameStableFileIdentity(expected, identity({ ino: 0n, windowsFileId: OTHER_FILE_ID }), "win32"), false);
  assert.equal(sameStableFileIdentity(expected, identity({ ino: 0n, dev: 2n, windowsFileId: FILE_ID }), "win32"), false);
  assert.equal(sameStableFileIdentity(expected, identity({ ino: 0n, nlink: 2n, windowsFileId: FILE_ID }), "win32"), false);

  for (const malformed of [
    undefined,
    "0x1234",
    `0x${"a".repeat(65)}`,
    "not-a-file-id",
  ]) {
    assert.equal(
      hasComparableFileIdentity(identity({ ino: 0n, windowsFileId: malformed }), "win32"),
      false,
    );
  }
});

test("canonicalizes Windows File IDs on the identity instead of retaining them out of band", async () => {
  const original = identity({ ino: 0n });
  const hydrated = await hydrateWindowsFileIdentity(
    "C:\\work\\active.toml",
    original,
    {
      platform: "win32",
      systemRoot: "C:\\Windows",
      runner: async () => ({ stdout: "File ID is 0X0123456789ABCDEF\r\n" }),
    },
  );
  const canonical = identity({ ino: 0n, windowsFileId: FILE_ID });
  const canonicalizable = identity({ ino: 0n, windowsFileId: "0X0123456789ABCDEF" });
  const timestampOnly = {
    ...identity({ ino: 0n }),
    birthtimeNs: 1n,
  } as FileIdentity;

  assert.equal(original.windowsFileId, undefined);
  assert.equal(hydrated.windowsFileId, FILE_ID);
  assert.equal(hasComparableFileIdentity(original, "win32"), false);
  assert.equal(sameStableFileIdentity(original, hydrated, "win32"), false);
  assert.equal(hasComparableFileIdentity(canonicalizable, "win32"), true);
  assert.equal(sameStableFileIdentity(canonical, canonicalizable, "win32"), true);
  assert.equal(hasComparableFileIdentity(timestampOnly, "win32"), false);
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

test("hydrates zero-inode Windows identities through the constrained File ID command", async () => {
  const calls: Array<{ file: string; args: readonly string[]; options: object }> = [];
  const runner: WindowsFileIdCommandRunner = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: "File ID is 0x0123456789ABCDEF\r\n" };
  };
  const original = identity({ ino: 0n });

  const hydrated = await hydrateWindowsFileIdentity(
    "C:\\work\\profiles\\..\\active.toml",
    original,
    { platform: "win32", systemRoot: "C:\\Windows", runner },
  );

  assert.deepEqual(calls, [
    {
      file: "C:\\Windows\\System32\\fsutil.exe",
      args: ["file", "queryFileID", "C:\\work\\active.toml"],
      options: { shell: false, windowsHide: true, timeout: 2000, maxBuffer: 8192 },
    },
  ]);
  assert.equal(original.windowsFileId, undefined);
  assert.equal(hydrated.windowsFileId, FILE_ID);
  assert.equal(sameStableFileIdentity(original, hydrated, "win32"), false);
});

test("hydrates through a canonical nondefault Windows system root", async () => {
  const calls: Array<{ file: string; args: readonly string[]; options: object }> = [];
  const runner: WindowsFileIdCommandRunner = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: FILE_ID };
  };

  const hydrated = await hydrateWindowsFileIdentity(
    "C:\\work\\active.toml",
    identity({ ino: 0n }),
    { platform: "win32", systemRoot: "C:\\WINNT", runner },
  );

  assert.equal(hydrated.windowsFileId, FILE_ID);
  assert.deepEqual(calls, [
    {
      file: "C:\\WINNT\\System32\\fsutil.exe",
      args: ["file", "queryFileID", "C:\\work\\active.toml"],
      options: { shell: false, windowsHide: true, timeout: 2000, maxBuffer: 8192 },
    },
  ]);
});

test("rejects noncanonical Windows system roots before the File ID runner", async () => {
  let calls = 0;
  const runner: WindowsFileIdCommandRunner = async () => {
    calls += 1;
    return { stdout: FILE_ID };
  };

  for (const systemRoot of [
    "C:\\Windows\\..\\attacker",
    "C:\\Windows\\.\\attacker",
    "C:\\Windows\\System32\\..\\attacker",
    "C:/Windows",
    "C:\\Windows\\",
    "C:\\attacker\\",
    "C:\\",
    "C:Windows",
    "Windows",
    "\\\\server\\share\\Windows",
  ]) {
    const result = await hydrateWindowsFileIdentity(
      "C:\\work\\active.toml",
      identity({ ino: 0n }),
      { platform: "win32", systemRoot, runner },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    assert.equal(result instanceof FileIdentityError, true, systemRoot);
  }

  assert.equal(calls, 0);
});

test("does not query File IDs outside the zero-inode Windows path", async () => {
  let calls = 0;
  const runner: WindowsFileIdCommandRunner = async () => {
    calls += 1;
    return { stdout: FILE_ID };
  };
  const zeroInode = identity({ ino: 0n });
  const nonzeroInode = identity();

  assert.strictEqual(
    await hydrateWindowsFileIdentity("C:\\work\\active.toml", zeroInode, {
      platform: "linux",
      systemRoot: "C:\\Windows",
      runner,
    }),
    zeroInode,
  );
  assert.strictEqual(
    await hydrateWindowsFileIdentity("C:\\work\\active.toml", nonzeroInode, {
      platform: "win32",
      systemRoot: "C:\\Windows",
      runner,
    }),
    nonzeroInode,
  );
  assert.equal(calls, 0);
});

test("redacts Windows File ID root, query, and parser failures", async () => {
  const targetPath = "C:\\sensitive\\active.toml";
  const baseOptions = { platform: "win32" as const, systemRoot: "C:\\Windows" };

  await assertRedactedFileIdentityFailure(
    () => hydrateWindowsFileIdentity(targetPath, identity({ ino: 0n }), {
      ...baseOptions,
      systemRoot: "not-an-absolute-windows-root",
      runner: async () => ({ stdout: FILE_ID }),
    }),
    targetPath,
  );
  await assertRedactedFileIdentityFailure(
    () => hydrateWindowsFileIdentity(targetPath, identity({ ino: 0n }), {
      ...baseOptions,
      runner: async () => {
        throw new Error(`${targetPath} leaked-command-output`);
      },
    }),
    targetPath,
    "leaked-command-output",
  );

  for (const stdout of [
    "missing file id",
    `${FILE_ID}\n${OTHER_FILE_ID}`,
    "0x0123456789abcdeg",
    "x".repeat(8193),
  ]) {
    await assertRedactedFileIdentityFailure(
      () => hydrateWindowsFileIdentity(targetPath, identity({ ino: 0n }), {
        ...baseOptions,
        runner: async () => ({ stdout }),
      }),
      targetPath,
    );
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
