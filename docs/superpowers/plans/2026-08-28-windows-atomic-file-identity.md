# Windows Atomic File Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make managed Profile storage safe and usable on Windows zero-inode volumes by binding native file identity checks to deletion and index publication.

**Architecture:** A Windows x64 N-API 8 addon obtains a volume serial plus the complete `FILE_ID_INFO.FileId` from Windows handles. A TypeScript adapter isolates loading and makes the boundary injectable. `file-identity.ts` adopts that identity for `ino === 0`, and ProfileStore calls the addon for all identity-checked cleanup/deletion and holds a verified `config.toml` handle across `index.json` publication. Linux continues using its current `dev + ino` protocol and never loads the addon.

**Tech Stack:** TypeScript 5.6, Node 20-compatible N-API 8, C++/Win32 SDK, node-gyp, esbuild, Node test runner, VS Code VSIX packaging.

---

## File Structure

- Create: `native/windows-file-ops/binding.gyp` - N-API 8 Windows x64 target definition.
- Create: `native/windows-file-ops/src/windows_file_ops.cc` - handle-derived identity, verified deletion, and publication-hold implementation.
- Create: `scripts/build-windows-file-ops.mjs` - Windows-only build and staging contract for the addon.
- Create: `src/core/windows-file-operations.ts` - typed adapter, lazy production loader, and unavailable implementation.
- Create: `test/unit/windows-file-operations.test.ts` - adapter and platform-loading contract tests.
- Create: `test/integration/windows-file-operations.test.ts` - real Windows handle-operation tests.
- Modify: `src/core/file-identity.ts` - replace path-run `fsutil` hydration with typed native snapshots for zero inode.
- Modify: `src/core/profiles.ts` - use verified deletion and config holds in ProfileStore.
- Modify: `test/unit/file-identity.test.ts` - test native zero-inode identity behavior.
- Modify: `test/unit/profiles.test.ts` - test ProfileStore deletion and publication races with an injected helper.
- Modify: `package.json`, `package-lock.json`, `.gitignore`, `.vscodeignore` - build, test, and package the Windows addon without shipping its source.
- Modify: `scripts/package-target.mjs`, `scripts/vsix-verifier.mjs` - build and validate the target-specific addon payload.
- Modify: `test/unit/package-target.test.ts`, `test/unit/vsix-verifier.test.ts`, `test/unit/package-contract.test.ts` - protect the package contract.
- Modify: `.github/workflows/ci.yml`, `.github/workflows/package.yml`, `docs/development.md` - build prerequisites and Windows/Linux CI evidence.

### Task 1: Define The TypeScript Native Boundary

**Files:**
- Create: `src/core/windows-file-operations.ts`
- Create: `test/unit/windows-file-operations.test.ts`

- [ ] **Step 1: Write failing adapter tests for platform gating and value validation**

```ts
test("does not load the Windows addon outside win32-x64", () => {
  const operations = createWindowsFileOperations({ platform: "linux", arch: "x64" });
  assert.throws(() => operations.captureFileIdentity("C:\\profiles\\config.toml"), {
    code: "WINDOWS_FILE_OPERATIONS_UNAVAILABLE",
  });
});

test("rejects a malformed native identity result", () => {
  const operations = createWindowsFileOperations({
    platform: "win32",
    arch: "x64",
    loadBinding: () => ({ captureFileIdentity: () => ({ volumeSerial: "0", fileId: "bad" }) }),
  });
  assert.throws(() => operations.captureFileIdentity("C:\\profiles\\config.toml"));
});
```

- [ ] **Step 2: Run the new adapter test file and verify it fails because the module does not exist**

Run: `npx tsx --test test/unit/windows-file-operations.test.ts`

Expected: FAIL with `Cannot find module '../../src/core/windows-file-operations'`.

- [ ] **Step 3: Add the complete adapter interface and fail-closed loader**

```ts
export interface WindowsFileIdentity {
  readonly volumeSerial: string;
  readonly fileId: string;
  readonly linkCount: bigint;
}

export interface WindowsFileOperations {
  captureFileIdentity(path: string): WindowsFileIdentity;
  deleteFileIfMatches(path: string, expected: WindowsFileIdentity): "deleted" | "identity-mismatch";
  holdFileIfMatches(path: string, expected: WindowsFileIdentity): WindowsFileHold;
}

export interface WindowsFileHold { close(): void; }
```

`createWindowsFileOperations` must accept an internal dependency object for
`platform`, `arch`, `extensionRoot`, and `loadBinding`. It must require the
addon only after both platform checks pass, resolve
`native/windows-file-ops/windows_file_ops.node` below `extensionRoot`, reject
path traversal, validate 16 lowercase hexadecimal volume characters, 32
lowercase hexadecimal file-ID characters, and `linkCount === 1n`, and turn all
unexpected loader/binding faults into `WindowsFileOperationsError` with code
`WINDOWS_FILE_OPERATIONS_UNAVAILABLE` or `WINDOWS_FILE_OPERATIONS_INVALID`.

- [ ] **Step 4: Run type checking and the adapter tests**

Run: `npm run check && npx tsx --test test/unit/windows-file-operations.test.ts`

Expected: both commands exit `0` on the current non-Windows development host.

- [ ] **Step 5: Commit the tested boundary**

```text
git add src/core/windows-file-operations.ts test/unit/windows-file-operations.test.ts package.json
git commit -m "feat: add Windows file operation boundary"
```

### Task 2: Implement And Build The Windows N-API Addon

**Files:**
- Create: `native/windows-file-ops/binding.gyp`
- Create: `native/windows-file-ops/src/windows_file_ops.cc`
- Create: `scripts/build-windows-file-ops.mjs`
- Modify: `package.json`, `package-lock.json`, `.gitignore`, `.vscodeignore`

- [ ] **Step 1: Add a Windows-only build-contract test**

```ts
test("win32 package runs the addon build before packaging", async () => {
  const commands: string[][] = [];
  await packageExtension({ target: "win32-x64", run: async (_file, args) => commands.push(args) });
  assert.deepEqual(commands[0], [npmCliPath, "run", "build:windows-file-ops"]);
});
```

Add equivalent package-contract assertions that `.node` is a required Windows
payload and that C++ source, `binding.gyp`, object files, and `build/` cannot
appear in a VSIX.

- [ ] **Step 2: Run the focused package tests and verify the missing build contract fails**

Run: `npx tsx --test test/unit/package-target.test.ts test/unit/package-contract.test.ts`

Expected: FAIL because `build:windows-file-ops` and the addon archive rule do
not exist.

- [ ] **Step 3: Implement the N-API target and direct Win32 operations**

`binding.gyp` must compile only `src/windows_file_ops.cc`, define
`NAPI_VERSION=8`, define `UNICODE` and `_UNICODE`, use C++17, and write
`windows_file_ops.node` under `native/windows-file-ops/` for staging.

The C++ source must export exactly `captureFileIdentity`,
`deleteFileIfMatches`, `holdFileIfMatches`, and `releaseFileHold`. Its shared
`OpenVerifiedFile` routine must:

```cpp
HANDLE handle = CreateFileW(path.c_str(), desired_access, FILE_SHARE_READ,
                            nullptr, OPEN_EXISTING,
                            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                            nullptr);
FILE_ATTRIBUTE_TAG_INFO tag{};
GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag));
if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) { /* close and fail */ }
FILE_ID_INFO id{};
FILE_STANDARD_INFO standard{};
GetFileInformationByHandleEx(handle, FileIdInfo, &id, sizeof(id));
GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard));
```

Format `id.VolumeSerialNumber` as 16 lowercase hexadecimal characters and the
16 FileId bytes as 32 lowercase hexadecimal characters. Reject any link count
other than one. `deleteFileIfMatches` compares this handle-derived value to
the JavaScript expected value and only then calls
`SetFileInformationByHandle(handle, FileDispositionInfo, ...)`. A mismatch
returns the literal string `"identity-mismatch"`; a successful disposition
returns `"deleted"`. The hold exports a N-API external whose finalizer closes
both its verified config-file handle and its verified immediate-parent
directory handle. The parent uses `FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES`,
`FILE_SHARE_READ`, `FILE_FLAG_BACKUP_SEMANTICS`, and
`FILE_FLAG_OPEN_REPARSE_POINT`; it must be a non-reparse directory. After the
parent is held, reopen the final config path and recheck the expected native
identity before returning the external. This second observation detects a
rename/replacement during hold acquisition, while the parent handle blocks a
later source rename. `releaseFileHold` closes both handles, keeps a failed
close available for retry, and makes later close/finalizer calls harmless.
Every failing branch closes any acquired handle before it throws a typed
JavaScript error.

`scripts/build-windows-file-ops.mjs` must reject non-`win32-x64`, remove only
the resolved addon output below `native/windows-file-ops/`, invoke the
lockfile-pinned `node-gyp` through `process.execPath`, check that the expected
`.node` exists and is a regular file, then copy it to
`native/windows-file-ops/windows_file_ops.node`. The script must never remove
the repository root or use a glob as a delete target.

Add `node-gyp` as a pinned development dependency. Add
`build:windows-file-ops` and `test:windows-file-ops` scripts, ignore generated
`native/windows-file-ops/build/` and `windows_file_ops.node`, and allowlist
only the staged `.node` in the Windows package.

- [ ] **Step 4: Run the contract tests and static checks**

Run: `npm run check && npx tsx --test test/unit/package-target.test.ts test/unit/package-contract.test.ts`

Expected: exit `0`; the local Linux host skips native compilation.

- [ ] **Step 5: Run the real addon build on a Windows worker**

Run: `npm run build:windows-file-ops`

Expected: exit `0` and create
`native/windows-file-ops/windows_file_ops.node`. This evidence is obtained in
the Windows GitHub Actions job when local C++ Build Tools are unavailable.

- [ ] **Step 6: Commit the addon and build pipeline**

```text
git add native/windows-file-ops scripts/build-windows-file-ops.mjs package.json package-lock.json .gitignore .vscodeignore scripts/package-target.mjs scripts/vsix-verifier.mjs test/unit/package-target.test.ts test/unit/package-contract.test.ts test/unit/vsix-verifier.test.ts
git commit -m "feat: add Windows atomic file operations addon"
```

### Task 3: Replace `fsutil` With Native Zero-Inode Identity

**Files:**
- Modify: `src/core/file-identity.ts`
- Modify: `src/core/windows-file-operations.ts`
- Modify: `test/unit/file-identity.test.ts`

- [ ] **Step 1: Add failing zero-inode identity tests using a fake native operation**

```ts
test("hydrates a Windows zero inode observation from the native file ID", async () => {
  const identity = await hydrateWindowsFileIdentity("C:\\codex\\config.toml", zeroInodeStats, {
    platform: "win32",
    windowsFileOperations: fakeOperations("000000000000002a", "0123456789abcdef0123456789abcdef"),
  });
  assert.equal(identity.windowsFileIdentity?.fileId, "0123456789abcdef0123456789abcdef");
});

test("does not equate a zero inode identity without matching native volume and file IDs", () => {
  assert.equal(sameStableFileIdentity(first, differentVolume, "win32"), false);
  assert.equal(sameStableFileIdentity(first, differentFileId, "win32"), false);
});
```

- [ ] **Step 2: Run the focused identity tests and verify failure against the old `fsutil` option shape**

Run: `npx tsx --test test/unit/file-identity.test.ts`

Expected: FAIL because `windowsFileOperations` and `windowsFileIdentity` do
not yet exist.

- [ ] **Step 3: Migrate identity representation and hydration**

Replace `WindowsFileIdCommandRunner`, `systemRoot`, `runner`, all `fsutil`
parsing, and the path-command timeout constants with an optional injected
`WindowsFileOperations`. Define:

```ts
export interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly nlink: number | bigint;
  readonly windowsFileIdentity?: WindowsFileIdentity;
}
```

For `win32` and zero inode, `hydrateWindowsFileIdentity` must call
`captureFileIdentity(path)` and require the native link count to equal the
Node link count. `sameStableFileIdentity` must compare native volume serial,
native file ID, and link count for two zero-inode identities; it must reject
mixed zero/nonzero pairs. Nonzero inode and Linux branches keep their current
exact `dev + ino` comparison.

- [ ] **Step 4: Run all identity tests and compile**

Run: `npm run check && npx tsx --test test/unit/file-identity.test.ts`

Expected: exit `0`, with no child-process command runner remaining in
`src/core/file-identity.ts`.

- [ ] **Step 5: Commit native zero-inode identity migration**

```text
git add src/core/file-identity.ts src/core/windows-file-operations.ts test/unit/file-identity.test.ts
git commit -m "fix: use native Windows file identity"
```

### Task 4: Use Atomic Compare-And-Delete In ProfileStore

**Files:**
- Modify: `src/core/profiles.ts`
- Modify: `test/unit/profiles.test.ts`

- [ ] **Step 1: Add failing profile replacement tests at each cleanup class**

Create a `RecordingWindowsFileOperations` test double that records expected
identity and returns `"identity-mismatch"` after atomically replacing the
test target. Add tests asserting that ProfileStore rejects and preserves the
replacement for:

```ts
await store.create({ name: "atomic-lock", kind: "official", configText });
// release of .create.lock reports persistence-failed and the replacement remains

await store.create({ name: "atomic-recovery", kind: "official", configText });
// stale .create.lock, .create.lock.recovery, and .recovery.claim replacements remain
```

Add a temporary-cleanup case that forces `writeAtomically` to fail after its
temporary file is written; when the native compare returns mismatch, it must
return `rollback-failed` and never remove the replacement.

- [ ] **Step 2: Run these profile tests and verify their existing path-based unlink behavior fails them**

Run: `npx tsx --test test/unit/profiles.test.ts --test-name-pattern "atomic|replacement"`

Expected: FAIL because ProfileStore still calls `unlink` after a separate
identity observation.

- [ ] **Step 3: Route every protected deletion through one ProfileStore helper**

Add an internal function with the exact behavior:

```ts
async function deleteTrustedProfileFile(path, expected, operations, platform): Promise<void> {
  if (platform === "win32" && (expected.ino === 0 || expected.ino === 0n)) {
    if (operations.deleteFileIfMatches(path, requireWindowsIdentity(expected)) !== "deleted") {
      throw profilePersistenceError();
    }
    return;
  }
  await unlinkAfterExistingIdentityCheck(path, expected);
}
```

Pass `WindowsFileOperations` through `ProfileStoreOptions` and lock-recovery
functions. Replace `removeTemporaryFile`, `removeTrustedProfileLock`, stale
lock removal, recovery-guard cleanup, and claim cleanup with this helper.
Remove `unlinkStaleLock` from `ProfileLockFileSystem`, because the native path
must not perform a second path read before unlinking. Preserve existing
non-Windows test doubles and errors for the portable branch.

- [ ] **Step 4: Run ProfileStore tests and all existing lock-recovery tests**

Run: `npx tsx --test test/unit/profiles.test.ts`

Expected: exit `0`, including prior live-lock and rollback tests.

- [ ] **Step 5: Commit atomic ProfileStore deletion**

```text
git add src/core/profiles.ts test/unit/profiles.test.ts
git commit -m "fix: atomically delete Windows profile files"
```

### Task 5: Hold Verified Configs Through Index Publication

**Files:**
- Modify: `src/core/profiles.ts`
- Modify: `test/unit/profiles.test.ts`

- [ ] **Step 1: Add failing publication-hold tests**

Use a fake hold whose `close` increments a counter. Add tests that set a hook
immediately before index rename and assert:

```ts
assert.equal(fakeOperations.activeHolds, 1);
assert.equal(await readFile(profile.configFile, "utf8"), expectedConfig);
await releaseIndexRename();
assert.equal(fakeOperations.activeHolds, 0);
```

Cover create, update, rename failure, and config replacement before hold
acquisition. The replacement case must reject with `persistence-failed` and
leave the existing `index.json` unchanged.

- [ ] **Step 2: Run the new tests and verify no current code requests a config hold**

Run: `npx tsx --test test/unit/profiles.test.ts --test-name-pattern "publication hold|index replacement"`

Expected: FAIL because `holdFileIfMatches` is not called.

- [ ] **Step 3: Make index publication execute inside a verified config hold**

Split the existing `beforePublish` callback into an identity assertion and an
`acquirePublicationHold` callback. `writeAtomically` must use this exact
control flow around its final index rename:

```ts
await assertBeforePublish?.();
const hold = await acquirePublicationHold?.();
try {
  await this.fileSystem.rename(temporaryPath, path);
} finally {
  hold?.close();
}
```

For config-index publication, `acquirePublicationHold` calls
`holdFileIfMatches(config.path, requireWindowsIdentity(config))` only for a
Windows zero-inode config. Keep the hold path inactive on Linux and nonzero-
inode Windows. Do not return success until the rename has completed and the
hold has closed.

The current `assertTrustedProfileConfigIdentity` remains a precondition. On
the native path it must use the native identity field so replacement before
hold acquisition fails before the index becomes visible.

- [ ] **Step 4: Run the complete ProfileStore suite and integration rollback suite**

Run: `npx tsx --test test/unit/profiles.test.ts test/integration/rollback.test.ts`

Expected: exit `0`.

- [ ] **Step 5: Commit verified publication holds**

```text
git add src/core/profiles.ts test/unit/profiles.test.ts
git commit -m "fix: hold Windows configs during profile publication"
```

### Task 6: Verify The Real Addon And Target-Specific VSIX Contents

**Files:**
- Create: `test/integration/windows-file-operations.test.ts`
- Modify: `scripts/package-target.mjs`, `scripts/vsix-verifier.mjs`
- Modify: `test/unit/package-target.test.ts`, `test/unit/vsix-verifier.test.ts`, `test/unit/package-contract.test.ts`

- [ ] **Step 1: Add Windows integration tests that skip on other hosts**

```ts
test("verified deletion preserves a same-content replacement", { skip: process.platform !== "win32" }, () => {
  const expected = operations.captureFileIdentity(target);
  replaceWithSameContents(target);
  assert.equal(operations.deleteFileIfMatches(target, expected), "identity-mismatch");
  assert.equal(readFileSync(target, "utf8"), contents);
});

test("a verified hold blocks config rename until it closes", { skip: process.platform !== "win32" }, () => {
  const hold = operations.holdFileIfMatches(target, operations.captureFileIdentity(target));
  assert.throws(() => renameSync(replacement, target));
  assert.throws(() => renameSync(target, renamed));
  assert.equal(readFileSync(target, "utf8"), contents);
  hold.close();
  renameSync(replacement, target);
});
```

Add a final reparse-point test with an available Windows symlink or junction;
when creation requires unavailable Windows developer privileges, mark only
that case skipped with its concrete Windows error code. The deletion and hold
tests must never be skipped on `windows-latest`. Sharing violations may be
reported by Node as `EPERM`, `EACCES`, or `EBUSY`; assert one of those codes and
also assert that the source path and original bytes remain unchanged.

- [ ] **Step 2: Run the file on the local non-Windows host and verify clean skips**

Run: `npx tsx --test test/integration/windows-file-operations.test.ts`

Expected: exit `0` with Windows-only cases marked skipped.

- [ ] **Step 3: Enforce Windows-only VSIX payload rules**

Extend `packageExtension` to run `build:windows-file-ops` before check/build
for `win32-x64`, and pass the target to `verifyVsix`. Make the verifier require
`extension/native/windows-file-ops/windows_file_ops.node` only for
`win32-x64`, reject it for `linux-x64`, and keep its size, path canonicality,
and source/installer exclusions. The extracted Windows artifact must load the
addon and invoke a harmless identity capture against its staged binary; the
Linux verifier must prove the loader is not invoked.

- [ ] **Step 4: Run all package verifier tests**

Run: `npx tsx --test test/unit/package-target.test.ts test/unit/vsix-verifier.test.ts test/unit/package-contract.test.ts`

Expected: exit `0`.

- [ ] **Step 5: Run matching-target package commands**

Run on Windows: `npm run package:win32-x64`

Expected: exit `0` and produce a verified `@win32-x64.vsix` containing the
addon and the SQLite binding.

Run on Ubuntu glibc: `npm run package:linux-x64`

Expected: exit `0` and produce a verified `@linux-x64.vsix` without the
Windows addon.

- [ ] **Step 6: Commit real native and packaging verification**

```text
git add test/integration/windows-file-operations.test.ts scripts/package-target.mjs scripts/vsix-verifier.mjs test/unit/package-target.test.ts test/unit/vsix-verifier.test.ts test/unit/package-contract.test.ts
git commit -m "test: verify Windows native file operations packaging"
```

### Task 7: Run CI, Review, And Merge The Focused PR

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/package.yml`
- Modify: `docs/development.md`

- [ ] **Step 1: Add failing workflow-contract assertions**

```ts
assert.match(readWorkflow(".github/workflows/ci.yml"), /npm run build:windows-file-ops/);
assert.match(readWorkflow(".github/workflows/package.yml"), /package:win32-x64/);
assert.match(readWorkflow(".github/workflows/package.yml"), /package:linux-x64/);
```

- [ ] **Step 2: Run the workflow contract test and verify it fails before workflow edits**

Run: `npx tsx --test test/unit/package-contract.test.ts`

Expected: FAIL until the Windows addon build command appears before Windows
tests and package generation.

- [ ] **Step 3: Make CI provide platform-specific evidence**

In the Windows matrix branch, run `npm run build:windows-file-ops` before
`npm run check`, unit tests, integration tests, and `npm run package:win32-x64`.
In the Ubuntu branch, omit the native build and run `npm run package:linux-x64`.
The package workflow uploads separate target-suffixed VSIX artifacts after its
matching package command. Update `docs/development.md` with the Windows Build
Tools requirement and the exact build/package commands.

- [ ] **Step 4: Run local Linux evidence before pushing**

Run: `npm run check && npm test && npm run test:integration && npm run package:linux-x64`

Expected: exit `0`; the package verifier reports no Windows addon in Linux
artifact contents.

- [ ] **Step 5: Commit the CI and documentation changes**

```text
git add .github/workflows/ci.yml .github/workflows/package.yml docs/development.md test/unit/package-contract.test.ts
git commit -m "ci: build and verify Windows file operations"
```

- [ ] **Step 6: Create/update GitHub review state**

Push `feature/ci-packaging`, update PR #14 with `Fixes #16`, and include the
Windows and Linux package artifact names in the PR body. Request the two
required reviews in order: specification compliance first, then code quality.
Do not merge while either review identifies an unresolved race or either
Windows/Ubuntu CI matrix leg is red.

- [ ] **Step 7: Merge only after evidence is green**

Require the PR's Windows and Ubuntu test/package jobs to pass, inspect the
uploaded VSIXs with the verifier, re-run `git diff --check`, then squash merge
PR #14. Confirm that the resulting `main` commit contains the addon source,
Windows artifact rules, and no generated `.node` binary tracked by git.

## Plan Self-Review

Spec coverage:

- Handle-derived `FileIdInfo`, one-link checks, reparse rejection, failure
  cleanup, and N-API 8 are implemented in Task 2.
- No `fsutil` fallback and native identity equality are implemented in Task 3.
- Atomic deletion for all ProfileStore cleanup paths is implemented in Task 4.
- Config-handle lifetime through index rename is implemented in Task 5.
- Windows-only load/package inclusion and Linux absence are implemented in
  Tasks 1, 2, and 6.
- Windows and Ubuntu CI, target VSIX artifacts, documentation, reviews, and
  merge gating are implemented in Task 7.

Placeholder scan: this plan contains no unassigned implementation task or
unspecified error-handling branch. Type names used after Task 1 match the
boundary defined there; `WindowsFileIdentity`, `WindowsFileOperations`, and
`WindowsFileHold` remain the only public native boundary types.
