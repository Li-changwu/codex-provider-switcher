# Provider Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Ship a VS Code Activity Bar Provider workbench that manages custom and official profiles, supports manual session synchronization, and gates native/fork continuation on synchronization eligibility.

**Architecture:** Keep `ProfileStore`, `switchStoredProfile`, `continueSession`, and SecretStorage as the authoritative core boundaries. Add a native TreeDataProvider for the Activity Bar and a WebviewPanel controller for the main work area; the controller validates typed messages and adapts them to existing handlers. Synchronization eligibility is an in-memory `Provider + session` catalog owned by the controller and is invalidated on Provider changes or failed operations.

**Tech Stack:** TypeScript, VS Code Extension API 1.98, existing `tsx --test` tests, esbuild, `@iarna/toml`, SQLite/rollout services.

---

### Task 1: Establish isolated implementation workspace and baseline

**Files:**
- Create: `.worktrees/provider-management-ui` (git worktree, branch `codex/provider-management-ui`)

- [ ] **Step 1: Create the worktree from the approved main commit**

Run `git worktree add .worktrees/provider-management-ui -b codex/provider-management-ui main` and work from that directory for all implementation edits.

- [ ] **Step 2: Install and run the baseline suite**

Run `npm install`, then `npm test`. Expected: the existing unit suite passes with zero failures before feature changes.

- [ ] **Step 3: Commit no code; record baseline in the execution notes**

Keep the worktree clean after setup so later failures are attributable to the feature.

### Task 2: Extend core profile APIs for safe deletion and auth presentation

**Files:**
- Modify: `src/core/profiles.ts`
- Modify: `src/core/types.ts`
- Test: `test/unit/profiles.test.ts`

- [ ] **Step 1: Write failing deletion and redacted-auth tests**

Add tests asserting `ProfileStore.delete(id)` removes the managed profile directory and index entry, rejects an unknown id without mutation, and never returns credential material when `toPublicProfileRecord` or the new `readAuthPreview` helper is used.

- [ ] **Step 2: Run the focused tests and verify RED**

Run `npx tsx --test test/unit/profiles.test.ts`. Expected: failures because the deletion/auth-preview APIs do not exist.

- [ ] **Step 3: Implement the minimal locked deletion API**

Add `delete(id: string): Promise<boolean>` to `ProfileStore`, extend its filesystem seam with a recursive managed-directory removal operation, verify the profile path and identities under the existing profile lock, remove only the trusted profile directory, then atomically rewrite `index.json`. Return `false` for a missing id. Add `readAuthPreview(id, secretReader)` that returns `{ kind: "custom", json: "{\"OPENAI_API_KEY\":\"[REDACTED]\"}" }` or `{ kind: "official" }` without exposing the secret.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run `npx tsx --test test/unit/profiles.test.ts`; expected: PASS.

- [ ] **Step 5: Commit**

Run `git add src/core/profiles.ts src/core/types.ts test/unit/profiles.test.ts && git commit -m "feat: add safe profile deletion and auth preview"`.

### Task 3: Expose synchronization counts and continuation eligibility primitives

**Files:**
- Modify: `src/core/switch-service.ts`
- Modify: `src/core/profile-switch-orchestrator.ts`
- Modify: `src/core/continuation.ts`
- Test: `test/unit/switch-service.test.ts`
- Test: `test/unit/profile-switch-orchestrator.test.ts`
- Test: `test/unit/continuation.test.ts`

- [ ] **Step 1: Write failing result-contract tests**

Assert a stored switch result includes `synchronizedChanges` (the number of rollout changes applied) and that a successful scan with zero changes returns `0`; add a continuation helper test that rejects an attempt without a caller-provided synchronization eligibility record.

- [ ] **Step 2: Run focused tests and verify RED**

Run `npx tsx --test test/unit/switch-service.test.ts test/unit/profile-switch-orchestrator.test.ts test/unit/continuation.test.ts`. Expected: failures for the missing result field/helper.

- [ ] **Step 3: Implement minimal result plumbing**

Track the rollout change count during `createStoredProfileSwitchDependencies`, add optional `synchronizedChanges` to `SwitchResult`, copy the count into `StoredProfileSwitchResult`, and add a pure `assertContinuationEligible(eligibility, providerId, sessionId)` helper that throws for missing or stale entries. Do not alter rollback or capability-probe semantics.

- [ ] **Step 4: Run focused tests and verify GREEN**

Re-run the three test files; expected: PASS.

- [ ] **Step 5: Commit**

Commit as `feat: expose sync counts and continuation eligibility`.

### Task 4: Add native Provider TreeDataProvider and workbench message model

**Files:**
- Create: `src/ui/provider-tree.ts`
- Create: `src/ui/provider-workbench.ts`
- Test: `test/unit/provider-tree.test.ts`
- Test: `test/unit/provider-workbench.test.ts`

- [ ] **Step 1: Write failing TreeView and message-validation tests**

Test that profile records map to tree labels/descriptions/icons with an active marker, and that the Webview controller rejects unknown messages, invalid profile ids, raw credentials, and malformed custom TOML payloads before invoking dependencies.

- [ ] **Step 2: Run focused tests and verify RED**

Run `npx tsx --test test/unit/provider-tree.test.ts test/unit/provider-workbench.test.ts`; expected: module/API failures.

- [ ] **Step 3: Implement the tree provider**

Implement `ProviderTreeDataProvider` with `onDidChangeTreeData`, `refresh()`, `getChildren()`, `getTreeItem()`, and item commands for open, switch, edit, and delete. Use VS Code theme-safe labels and `$(check)`/`$(key)`/`$(person)` icon paths; never put TOML or auth contents in tree state.

- [ ] **Step 4: Implement the Webview controller and typed messages**

Implement `ProviderWorkbench` with `openProfile(id?)`, `resolveWebviewView`/panel HTML, a strict message union (`loadProfile`, `createProfile`, `saveProfile`, `loginOfficial`, `switchProfile`, `deleteProfile`, `syncSessions`, `continueSession`, `openRawFile`), nonce/CSP generation, and redacted snapshots. Route create/edit/switch/login/sync/continue to injected core callbacks. Maintain a `Map<providerId, Set<sessionId>>` eligibility catalog, clear it on Provider change, and emit `operationProgress`, `notification`, `continuationEligibility`, and completion/failure messages. For native resume fallback, ask confirmation before selecting a target Provider and invoking existing `fork` mode.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run both new test files; expected: PASS.

- [ ] **Step 6: Commit**

Commit as `feat: add provider tree and webview workbench`.

### Task 5: Wire Activity Bar contributions and activation lifecycle

**Files:**
- Modify: `package.json`
- Modify: `src/activation.ts`
- Modify: `src/extension.ts`
- Test: `test/unit/extension-manifest.test.ts`
- Test: `test/unit/activation-lifecycle.test.ts`

- [ ] **Step 1: Write failing manifest/lifecycle tests**

Assert the manifest contributes `codexProvider` to `viewsContainers.activitybar`, a `codexProvider.providers` view, `codexProvider.openWorkbench`, and toolbar/context menu entries. Assert activation registers and disposes the tree/workbench alongside existing commands and preserves the unavailable state after startup recovery failure.

- [ ] **Step 2: Run focused tests and verify RED**

Run `npx tsx --test test/unit/extension-manifest.test.ts test/unit/activation-lifecycle.test.ts`; expected: failures for missing contributions/registrations.

- [ ] **Step 3: Implement manifest contributions**

Add the Activity Bar container, tree view, `openWorkbench` command, `addProfile`/`refresh` toolbar commands, and `view/item/context` menus with `codexProvider.commandsAvailable` enablement. Keep the Marketplace identity and existing command ids unchanged.

- [ ] **Step 4: Register and dispose UI services**

Construct `ProviderTreeDataProvider` and `ProviderWorkbench` from startup prerequisites, register `window.registerTreeDataProvider`, `commands.registerCommand("codexProvider.openWorkbench", ...)`, and push every disposable into `context.subscriptions`. Refresh the tree and panel after each mutating operation and after `refreshStatus()`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Re-run manifest/lifecycle tests; expected: PASS.

- [ ] **Step 6: Commit**

Commit as `feat: expose provider management in activity bar`.

### Task 6: Implement structured/raw configuration and manual sync UX

**Files:**
- Modify: `src/ui/provider-workbench.ts`
- Modify: `src/core/config.ts`
- Test: `test/unit/provider-workbench.test.ts`
- Test: `test/unit/config.test.ts`

- [ ] **Step 1: Write failing configuration and sync-state tests**

Cover structured custom save serialization, TOML validation errors, redacted `auth.json` preview, official-login snapshots with no file fields, manual-only sync invocation, determinate progress forwarding, and the exact no-op notification `No session metadata needs synchronization.`.

- [ ] **Step 2: Run tests and verify RED**

Run `npx tsx --test test/unit/provider-workbench.test.ts test/unit/config.test.ts`; expected: failures for the new UI behavior.

- [ ] **Step 3: Implement configuration modes**

Render custom fields (`model_provider`, provider id, `base_url`, `wire_api`) first and raw tabs second. Validate JSON/TOML before calling stores. Keep API keys write-only and pass them only to `SecretStore.set`; official profiles render login/re-login controls and name only.

- [ ] **Step 4: Implement manual sync state machine**

Do not call sync during activation or panel open. On `syncSessions`, call the existing stored switch handler with progress forwarding, mark the active Provider eligible for discovered session anchors only after a committed result, show the no-op notification when `synchronizedChanges === 0`, and clear eligibility on cancellation/failure/recovery-required results.

- [ ] **Step 5: Implement gated continuation paths**

Disable session Continue controls until eligibility exists. For eligible sessions, call the existing continuation path in `resume` mode first. On the explicit capability-unavailable result/error, show a confirmation naming the source session and target Provider, then call existing `fork` mode; do not downgrade malformed data or persistence failures.

- [ ] **Step 6: Run focused tests and verify GREEN**

Re-run the two test files; expected: PASS.

- [ ] **Step 7: Commit**

Commit as `feat: add manual sync and gated continuation UX`.

### Task 7: Documentation, packaging, and full verification

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `.vscodeignore` if new assets require inclusion
- Test: `test/unit/marketplace-assets.test.ts`
- Test: `test/unit/package-contract.test.ts`

- [ ] **Step 1: Document user workflow**

Add screenshots-free instructions for opening the Codex Activity Bar view, creating custom/official Providers, editing raw files, manually synchronizing, interpreting no-op status, and using Continue/fork fallback. State clearly that API keys remain in SecretStorage and sync is never automatic.

- [ ] **Step 2: Run the complete test and type-check suites**

Run `npm run check`, `npm test`, and `npm run test:integration`. Expected: zero failures.

- [ ] **Step 3: Build and verify the VSIX**

Run `npm run build`, `npm run package:win32-x64`, `npm run package:linux-x64`, and `npm run verify:package`. Expected: both target packages verify and contain the new manifest contributions.

- [ ] **Step 4: Commit release-ready changes**

Run `git add README.md CHANGELOG.md .vscodeignore src package.json test docs && git commit -m "feat: ship provider management workbench"`.

- [ ] **Step 5: Final review checkpoint**

Run `git diff main...HEAD --check`, inspect `git status --short`, and report exact test/package results. Do not claim Marketplace publication until the user separately authorizes the release operation.
