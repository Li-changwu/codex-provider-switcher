# Native File Identity Consumer Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Task 3 without retaining the removed `fsutil` identity field, while preserving existing ActiveProfile and ProfileStore trust checks.

**Architecture:** `FileIdentity` owns the validated `windowsFileIdentity` snapshot. ActiveProfile and ProfileStore copy that snapshot onto their existing `BigIntStats`-derived records so their shared `sameStableFileIdentity` checks continue to use one representation. Test fakes implement `WindowsFileOperations`, derive stable complete IDs from the real test file metadata, and reject hard-linked files just as the native addon does.

**Tech Stack:** TypeScript 5.6, Node test runner, Windows N-API 8 helper.

---

### Task 1: Adapt Existing Trusted-Stat Consumers

**Files:**
- Modify: `src/core/active-profile.ts`
- Modify: `src/core/profiles.ts`
- Modify: `test/unit/active-profile.test.ts`
- Modify: `test/unit/profiles.test.ts`

- [ ] **Step 1: Write failing consumer tests using a native operations fake**

Replace every `fileIdentityOptions` fixture shaped as `{ platform, systemRoot, runner }` with `{ platform: "win32", windowsFileOperations }`. The fake must return:

```ts
{
  volumeSerial: "0000000000000001",
  fileId: `${stats.dev.toString(16)}${stats.ino.toString(16)}`.padStart(32, "0").slice(-32),
  linkCount: stats.nlink,
}
```

and throw when `stats.nlink !== 1n`. The unavailable-identity tests must instead inject `captureFileIdentity: () => { throw new Error("unavailable"); }`. Run:

```text
npx tsx --test test/unit/active-profile.test.ts test/unit/profiles.test.ts
```

Expected: type errors or unsafe-state failures because production code still reads `windowsFileId`.

- [ ] **Step 2: Project the native snapshot onto trusted stats**

In both `hydrateFileIdentity` and `hydrateProfileFileIdentity`, replace the old property projection with:

```ts
if (identity.windowsFileIdentity === undefined) return stats as TrustedStats;
Object.defineProperty(stats, "windowsFileIdentity", {
  configurable: false,
  enumerable: true,
  value: identity.windowsFileIdentity,
  writable: false,
});
```

Do not add `windowsFileId` back, do not add a path cache, and do not use the atomic delete/hold interface yet.

- [ ] **Step 3: Run consumer tests and type checking**

Run:

```text
npx tsx --test test/unit/active-profile.test.ts test/unit/profiles.test.ts
npm run check
```

Expected: both commands exit `0`.

### Task 2: Correct the Windows Identity Integration Fixture

**Files:**
- Modify: `test/integration/windows-file-id.test.ts`

- [ ] **Step 1: Replace the invalid hard-link expectation with a failing fail-closed test**

Write a Windows-only test that uses one single-link file, renames it, creates a same-content replacement at the original path, and hydrates all three zero-inode observations. Assert rename retains the same native identity, replacement differs, and a separately created hard link causes `hydrateWindowsFileIdentity` to reject. Run:

```text
npx tsx --test test/integration/windows-file-id.test.ts
```

Expected: the old test fails because it expects a hard-linked file to hydrate successfully.

- [ ] **Step 2: Use the production native helper in the integration fixture**

Do not inject a fake into this integration test. Keep its non-Windows skip only on the one Windows-only test. It must prove the live addon enforces the one-link policy and returns stable identities across rename/replacement.

- [ ] **Step 3: Re-run focused and complete identity evidence**

Run:

```text
npx tsx --test test/unit/file-identity.test.ts test/integration/windows-file-id.test.ts
npm run build:windows-file-ops
npm run check
npm test
npm run test:integration
```

Expected: all commands exit `0`; only platform-gated tests may skip on non-Windows.

### Task 3: Commit the Compatible Task 3 Migration

**Files:**
- Modify only the files listed above plus the existing Task 3 files `src/core/file-identity.ts` and `test/unit/file-identity.test.ts`.

- [ ] **Step 1: Confirm no old command identity remains**

Run:

```text
rg -n "windowsFileId|WindowsFileIdCommandRunner|fsutil|systemRoot|runner:" src/core/file-identity.ts src/core/active-profile.ts src/core/profiles.ts test/unit/file-identity.test.ts test/unit/active-profile.test.ts test/unit/profiles.test.ts test/integration/windows-file-id.test.ts
```

Expected: no matches for the old identity field or command-runner terms; unrelated `runner:` fields outside this file set are out of scope.

- [ ] **Step 2: Commit the tested migration**

```text
git add src/core/file-identity.ts src/core/active-profile.ts src/core/profiles.ts test/unit/file-identity.test.ts test/unit/active-profile.test.ts test/unit/profiles.test.ts test/integration/windows-file-id.test.ts docs/superpowers/plans/2026-08-28-native-file-identity-consumer-adaptation.md
git commit -m "fix: adopt native Windows file identities"
```

## Plan Self-Review

- The adaptation preserves the Task 3 API: every zero-inode identity has a complete volume serial, file ID, and link count from the Windows native helper.
- The only consumer changes are property projection and fixture injection. Atomic mutation routing remains reserved for Tasks 4 and 5.
- The old hard-link integration assertion is replaced with the native helper's required fail-closed behavior.

### Task 4: Validate the Open-Then-Replace Read Boundary

**Files:**
- Modify: `src/core/file-identity.ts`
- Modify: `test/unit/file-identity.test.ts`
- Modify: `test/unit/active-profile.test.ts`
- Modify: `test/unit/profiles.test.ts`

- [x] **Step 1: Add an open-then-replace regression test using a path-faithful fake**

The fake `captureFileIdentity(path)` must synchronously read the current path's real
`BigIntStats` with `lstatSync`, rather than accepting a map populated by a file
handle's `stat`. Add a zero-inode ActiveProfile test that opens file A, atomically
renames file B onto the logical path before the first handle stat, and asserts the
read rejects with `unsafe-state`. This test establishes the reviewed race's actual
observable result: the retained pre-open snapshot for A cannot equal B.

Run:

```text
npx tsx --test test/unit/active-profile.test.ts --test-name-pattern "opened zero-inode"
```

Expected: PASS before any production change; it demonstrates the alleged bypass
does not reproduce with a path-faithful native identity source.

- [x] **Step 2: Add a failing mutable-accessor identity test**

Add a test where `windowsFileIdentity` is a getter returning a valid snapshot on
its first read and an invalid or substituted snapshot on its next read. Assert
`sameStableFileIdentity` returns `false`; run it before the implementation change.

```text
npx tsx --test test/unit/file-identity.test.ts --test-name-pattern "mutable"
```

Expected: FAIL because the current comparison reads the property more than once.

- [x] **Step 3: Snapshot comparable identities exactly once**

Replace repeated direct property accesses in `hasComparableFileIdentity` and
`sameStableFileIdentity` with a private helper that reads `dev`, `ino`, `nlink`,
and (for zero inode) native identity fields once inside `try/catch`, validates all
values, and returns frozen copied primitives. An accessor exception or a malformed
second value must return false, never throw. Preserve exact `dev + ino` behavior
for nonzero inode.

- [x] **Step 4: Run the Task 3 regression suite and commit**

Run:

```text
npx tsx --test test/unit/file-identity.test.ts test/unit/active-profile.test.ts test/unit/profiles.test.ts
npm run check
npm test
npm run test:integration
git diff --check
```

Then commit only the tested Task 3 hardening:

```text
git add src/core/file-identity.ts test/unit/file-identity.test.ts test/unit/active-profile.test.ts test/unit/profiles.test.ts docs/superpowers/plans/2026-08-28-native-file-identity-consumer-adaptation.md
git commit -m "fix: harden native file identity comparison"
```
