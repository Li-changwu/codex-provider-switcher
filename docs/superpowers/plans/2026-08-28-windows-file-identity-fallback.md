# Windows File Identity Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native Windows storage operations work on volumes with zero inode values without weakening Linux identity checks or link defenses.

**Architecture:** Task 1 adds a shared identity-policy module that owns the exact inode rule and a narrowly scoped Windows zero-inode File ID path. Production queries the Extension Host process's `SystemRoot\\System32\\fsutil.exe`; a `systemRoot` override is valid only with an injected test runner. Task 2 will delegate the four storage layers' repeated local helpers to this module, and Task 3 will make the activation fixture OS-consistent.

**Tech Stack:** TypeScript, Node `BigIntStats` and `child_process.execFile`, `node:test`, GitHub Actions Windows and Ubuntu runners.

---

### Task 1: Add the Pure Identity Policy

**Files:**
- Create: `src/core/file-identity.ts`
- Create: `test/unit/file-identity.test.ts`
- Create: `test/integration/windows-file-id.test.ts`

- [ ] **Step 1: Write the failing platform-injected identity tests.**

Test exact Linux identity, equal zero-inode Windows File ID identity, and failed
fallback identity after changing the File ID, device, link count, or one inode
to nonzero. Test File-ID query parsing with an injected execFile function: only
a bounded hexadecimal `0x...` result succeeds; command failure, oversized or
missing output, and non-Windows invocation fail closed. The identity helper
must build explicit bigint records, not use host stats.

- [ ] **Step 2: Verify RED.**

Run: `npx tsx --test test/unit/file-identity.test.ts`

Expected: fail because `file-identity.ts` does not exist.

- [ ] **Step 3: Implement the minimal shared policy.**

Expose `FileIdentity`, `hasComparableFileIdentity`,
`sameStableFileIdentity`, and async `hydrateWindowsFileIdentity`. Preserve
nonzero `dev + ino` equality on every platform. Permit only a `win32` pair
whose inode values are both zero and whose device, link count, and validated
Windows File ID match. `hydrateWindowsFileIdentity` must use an injected
execFile-like function in tests; production passes an absolute path inside the
validated `SystemRoot\\System32` and invokes `fsutil.exe file queryFileID` with
the target path as a separate argument. It must use no shell, redacted errors,
a timeout, and a maximum buffer. Reject mixed exact/File-ID identity, missing
or malformed IDs, command errors, and non-safe numeric identities.

- [ ] **Step 4: Verify GREEN and type safety.**

Run: `npx tsx --test test/unit/file-identity.test.ts`

Expected: pass.

Run: `npm run check`

Expected: pass.

### Task 2: Adopt the Policy in Runtime Storage Layers

**Files:**
- Modify: `src/core/active-profile.ts`
- Modify: `src/core/profiles.ts`
- Modify: `src/core/profile-switch-orchestrator.ts`
- Modify: `src/core/transaction.ts`

- [ ] **Step 1: Extend the failing shared-policy tests.**

Add assertions that different devices and link counts fail under the Windows
fallback. Re-run the Task 1 focused command and observe the new assertions fail
before changing production consumers.

- [ ] **Step 2: Replace duplicated inode predicates and equality helpers.**

Each layer imports `hasComparableFileIdentity`, `sameStableFileIdentity`, and
the async identity hydrator. Rename its `lstat` import to `nativeLstat` and
provide a local `lstat` wrapper that hydrates a zero-inode Windows stat before
it reaches a trust comparison. Before each `FileHandle.stat()` comparison,
hydrate the returned stat with the same known logical path. The wrapper must
not invoke `fsutil` when inode is nonzero or on Linux.
Keep `isFile`, `isDirectory`, `isSymbolicLink`, `nlink === 1n`, `realpath`,
source-hash, journal, lock-content, and backup-version checks unchanged.
Replace only local `ino !== 0n` predicates and local `dev + ino` equality
helpers. `transaction.ts` retains its public `hasSameStableFileIdentity` API as
a delegating wrapper so existing callers compile unchanged.

- [ ] **Step 3: Verify affected runtime tests.**

Run: `npx tsx --test test/unit/active-profile.test.ts test/unit/profiles.test.ts test/unit/profile-switch-orchestrator.test.ts test/unit/transaction.test.ts`

Expected: pass, with existing Windows-only symbolic-link skips unchanged.

- [ ] **Step 4: Verify the complete unit suite.**

Run: `npm test`

Expected: pass.

### Task 3: Correct the Linux Activation Fixture

**Files:**
- Modify: `test/unit/activation-lifecycle.test.ts`

- [ ] **Step 1: Add a failing actual-host layout assertion.**

Assert that `fixture.layout.switcherDir` is the platform-native
`join(fixture.layout.codexHome, "provider-switcher")`. The old hardcoded
Windows fixture must fail under Linux when ActiveProfileStore validates it.

- [ ] **Step 2: Implement the platform-consistent fixture.**

`activationFixture()` selects `homeDir`, `globalStorageUri.fsPath`, and
`host.platform` from the actual process: Windows uses the existing `C:\\Users`
fixture paths and Linux uses `/home/ada` paths. Pass this host unchanged to
`createStartupProfilePrerequisites`.

- [ ] **Step 3: Verify the focused fixture test.**

Run: `npx tsx --test test/unit/activation-lifecycle.test.ts`

Expected: pass.

### Task 4: Verify the Real CI Regression

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the bounded Windows fallback.**

Add one concise security note: Windows volumes without inode data require a
Windows filesystem File ID through the built-in `fsutil` utility; unavailable
identity data still disables unsafe operations. Do not claim equivalent
verification across all Windows volumes.

- [ ] **Step 2: Run complete local verification.**

Run: `npm ci`

Run: `npm run check`

Run: `npm test`

Run: `npm run test:integration`

Run: `npm run package`

Run: `git diff --check`

Expected: every command exits 0 and local packaging produces a verified Windows
x64 VSIX.

- [ ] **Step 3: Commit and push the CI-regression fix.**

Stage `src/core/file-identity.ts`, the four runtime consumers, both new or
changed unit tests, `README.md`, and these design documents. Commit with
`fix: support Windows filesystems without inode data`, then push PR #14 so it
links `Closes #15` and triggers Windows and Ubuntu verification.

## Plan Self-Review

- Spec coverage: Tasks 1-2 centralize and enforce the zero-inode fallback, Task
  3 corrects Linux-only fixture misuse, and Task 4 documents and verifies the
  actual CI regression.
- Placeholder scan: every production change names the exact files, invariant,
  and verification command; no deferred behavior is unspecified.
- Type consistency: `FileIdentity` keeps `dev`, `ino`, and `nlink` compatible
  with the transaction API, adding an optional canonical Windows File ID only
  for the zero-inode fallback.
