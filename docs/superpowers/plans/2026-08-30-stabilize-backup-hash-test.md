# Backup Hash Test Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the CI timing race in the backup-hash source-replacement test without changing transaction runtime behavior.

**Architecture:** The test currently starts an asynchronous 8 MiB backup and polls for its published file for approximately 200 ms before replacing the source. The transaction already exposes `TransactionIo.readHashChunk`, which runs while the finalized backup file is being hashed and after the source copy has completed. Replace the polling race with this hook so the test atomically replaces the source at a deterministic point, then proves the manifest hash belongs to the saved backup rather than the new source contents.

**Tech Stack:** TypeScript, Node.js built-in test runner, `tsx`, Node.js `fs/promises`.

---

### Task 1: Make The Backup Hash Test Deterministic

**Files:**
- Create: `docs/superpowers/plans/2026-08-30-stabilize-backup-hash-test.md`
- Modify: `test/unit/transaction.test.ts:1992-2013`
- Test: `test/unit/transaction.test.ts`

- [x] **Step 1: Record the failing reproduction**

Use the existing failed Ubuntu CI run as the red phase:

```text
Test: records the SHA256 of the saved backup bytes after the source path changes
Failure: Timed out waiting for .../backup/0000-config.toml
Cause: waitForFile checks for only 200 one-millisecond polling intervals while an 8 MiB copy is in progress.
```

- [x] **Step 2: Replace the timing race with the existing backup-hash hook**

Construct the transaction with `io.readHashChunk`. On its first call, write replacement bytes to `replacement-config.toml` and rename that file over `layout.configPath`. Run `transaction.backupTargets` normally and assert that the hook executed, the manifest entry SHA-256 equals the backup file SHA-256, and the manifest SHA-256 differs from the final source path SHA-256.

```ts
test("records the SHA256 of the saved backup bytes after the source path changes", async () => {
  await withLayout(async (layout) => {
    const original = "source content before the backup copy";
    const replacement = "source content after the backup copy";
    const replacementPath = join(layout.codexHome, "replacement-config.toml");
    let sourceReplaced = false;
    const transaction = await beginTransaction(layout, {
      operationId: "saved-backup-hash",
      io: {
        async readHashChunk() {
          if (sourceReplaced) {
            return;
          }
          sourceReplaced = true;
          await writeFile(replacementPath, replacement, "utf8");
          await rename(replacementPath, layout.configPath);
        },
      },
    });
    try {
      await writeFile(layout.configPath, original, "utf8");
      const manifest = await transaction.backupTargets([{ kind: "config", path: layout.configPath }]);
      const [entry] = manifest.entries;

      assert.equal(sourceReplaced, true);
      assert.ok(entry?.backupPath);
      assert.equal(entry.sha256, sha256(await readFile(entry.backupPath)));
      assert.notEqual(entry.sha256, sha256(await readFile(layout.configPath)));
    } finally {
      await transaction.markRolledBack().catch(() => undefined);
      await transaction.release().catch(() => undefined);
    }
  });
});
```

Keep cleanup in a `finally` block so a failed assertion cannot retain a transaction lock in the temporary test layout.

- [x] **Step 3: Verify the focused test and full test suite**

Run:

```powershell
npx tsx --test --test-name-pattern "records the SHA256 of the saved backup bytes after the source path changes" test/unit/transaction.test.ts
npm run check
npm test
npm run test:integration
git diff --check
```

Expected: the named test passes without `waitForFile`; the check, unit suite, integration suite, and whitespace validation succeed.

- [x] **Step 4: Commit the scoped change**

```powershell
git add docs/superpowers/plans/2026-08-30-stabilize-backup-hash-test.md test/unit/transaction.test.ts
git commit -m "test: stabilize backup hash source replacement"
```
