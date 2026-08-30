# Recovery Marker Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a failed provider switch retries durable `recoveryRequired` journaling when transaction rollback cannot complete.

**Architecture:** Keep `TransactionHandle` and its journal protocol unchanged. The switch service owns the outer failure boundary and will retry `markRecoveryRequired()` exactly after `rollback()` rejects; the retry is best-effort and never compensates a committed transaction.

**Tech Stack:** TypeScript 5.6, Node.js test runner, `tsx`, SQLite-backed transaction journals, GitHub Issue/PR workflow.

---

### Task 1: Add Regression Coverage For Outer Recovery Marker Retry

**Files:**
- Modify: `test/unit/switch-service.test.ts`
- Test: `test/unit/switch-service.test.ts`

- [x] **Step 1: Write a failing test for a retry that succeeds**

Add a test named `retries recoveryRequired journalling after rollback fails`.
Use the existing `withLayout` and `dependencies` helpers. Supply a legal auth
mutation with `markTargetAppliedBeforeApply: true`; its `apply` removes the
auth file and throws, while the injected `restoreAuthMode` throws during
rollback. In `transactionIo`, wrap `renameJournal` and count published
`recoveryRequired` records. Throw on the first such publication only, then
delegate to the real `rename`; the transaction's internal marker attempt
fails and the outer switch service must retry. Assert the result is `failed`,
its `journalState` is `recoveryRequired`, the marker publication count is
exactly two, and the final journal entry has that state. Assert the auth mode
and missing auth file remain in the failed post-apply state. Run:

```text
npx tsx --test test/unit/switch-service.test.ts --test-name-pattern "retries recoveryRequired"
```

Expected: FAIL with one observed marker publication because
`rollbackAfterFailure` currently skips the outer `markRecoveryRequired()`
call.

- [x] **Step 2: Add a failing test for a second marker failure**

Add a test named `keeps recovery marker failure diagnostics bounded` using the
same auth mutation and restoration failure. Make every `recoveryRequired`
journal publication throw an error containing the sentinel text
`journal-secret-detail`. Assert the result is `failed`, `journalState` is
`recoveryRequired`, the two marker attempts are observed, and serializing the
result does not contain `journal-secret-detail`. Assert the transaction lock
is released so a later `beginTransaction` can acquire it. Run the focused test
command again and confirm the test fails with one marker attempt because the
retry is unreachable.

- [x] **Step 3: Preserve the no-retry success path**

Update the existing successful rollback assertion in
`test/unit/switch-service.test.ts` to record `recoveryRequired` journal
publications and assert the count is zero. Run:

```text
npx tsx --test test/unit/switch-service.test.ts --test-name-pattern "rollback|recovery marker"
```

Expected: the new tests fail only on the missing retry behavior; the existing
success-path assertion remains green.

### Task 2: Implement The Minimal Retry

**Files:**
- Modify: `src/core/switch-service.ts`
- Test: `test/unit/switch-service.test.ts`

- [x] **Step 1: Replace the unreachable condition**

In `rollbackAfterFailure`, replace the second duplicated condition:

```ts
  if (!durableRollbackFailed) {
    try {
      await transaction.markRecoveryRequired();
    } catch {
      // The result must remain bounded even if the journal cannot record it.
    }
  }
```

with:

```ts
  if (durableRollbackFailed) {
    try {
      await transaction.markRecoveryRequired();
    } catch (markerError: unknown) {
      errors.push(markerError);
    }
  }
```

Do not change the `rollback()` call, state return, error summarization, or
transaction release logic. The returned state remains `recoveryRequired` when
durable rollback fails, regardless of whether the retry succeeds.

- [x] **Step 2: Run focused tests and type checking**

Run:

```text
npx tsx --test test/unit/switch-service.test.ts --test-name-pattern "rollback|recovery marker"
npm run check
```

Expected: all selected tests pass and TypeScript exits with code 0.

### Task 3: Verify, Document, And Commit

**Files:**
- Modify: `src/core/switch-service.ts`
- Modify: `test/unit/switch-service.test.ts`
- Add: `docs/superpowers/specs/2026-08-30-recovery-marker-retry-design.md`
- Add: `docs/superpowers/plans/2026-08-30-recovery-marker-retry.md`

- [x] **Step 1: Run the full verification suite**

Run:

```text
npm run check
npm run build
npm test
npm run test:integration
git diff --check
```

Expected: every command exits 0; unit and integration output reports zero
failures; only the repository's existing platform-gated skips remain.

- [x] **Step 2: Confirm scope and sensitive-data invariants**

Run:

```text
rg -n "journal-secret-detail|recoveryRequired|rollbackAfterFailure|markRecoveryRequired" src/core/switch-service.ts test/unit/switch-service.test.ts
git status --short
```

Confirm the production diff is limited to the retry condition and bounded
error collection, tests cover success/failure paths, and no credential or
transcript content is added.

- [x] **Step 3: Commit the implementation**

```text
git add src/core/switch-service.ts test/unit/switch-service.test.ts docs/superpowers/specs/2026-08-30-recovery-marker-retry-design.md docs/superpowers/plans/2026-08-30-recovery-marker-retry.md
git commit -m "fix: retry durable recovery marker after rollback failure"
```
