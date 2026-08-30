# Mapped Native Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a successful provider switch fork or reuse a native Codex session in the selected profile without exposing transcript content.

**Architecture:** A rollout-level read-only anchor resolver produces only a session ID and byte hash. A short-lived app-server JSONL client obtains the authoritative forked thread ID. The existing continuation core remains responsible for mapping persistence, bounded retention, and compensation; the command UI orchestrates selection after a committed switch.

**Tech Stack:** TypeScript, Node.js streams and `child_process`, VS Code extension API, Node test runner, SQLite continuation mapping store.

---

### Task 1: Add Metadata-only Continuation Source Anchors

**Files:**
- Modify: `src/core/rollouts.ts`
- Modify: `test/unit/rollouts.test.ts`

- [ ] **Step 1: Write failing anchor-resolver tests.**

Add tests that create active and archived JSONL rollouts and assert that
`listContinuationSourceAnchors(layout)` returns a sorted list containing only
`sessionId` and a lower-case 64-character SHA-256 hash. Assert an edited file
changes only its own hash. Assert duplicate session IDs and malformed or missing
`session_meta.payload.id` reject with the existing redacted validation errors.
Assert serialized anchors do not contain a fixture's message text or file path.

- [ ] **Step 2: Run the focused test and verify it fails.**

Run: `npm test -- test/unit/rollouts.test.ts`

Expected: FAIL because `listContinuationSourceAnchors` is not exported.

- [ ] **Step 3: Implement the resolver.**

Export `ContinuationSourceAnchor` and
`listContinuationSourceAnchors(layout): Promise<ContinuationSourceAnchor[]>`.
Reuse trusted rollout-file discovery and verified handles. Stream every file into
SHA-256 while identifying exactly one `session_meta.payload.id`; do not return
or persist any source line, message field, title, provider value, or path. Sort
by session ID and reject unsafe, duplicate, malformed, or missing metadata.

- [ ] **Step 4: Run focused and type verification.**

Run: `npm test -- test/unit/rollouts.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit the isolated behavior.**

```powershell
git add src/core/rollouts.ts test/unit/rollouts.test.ts
git commit -m "feat: expose metadata-only continuation anchors"
```

### Task 2: Add the Bounded App-server JSONL Fork Client

**Files:**
- Create: `src/ui/app-server-fork.ts`
- Create: `test/unit/app-server-fork.test.ts`

- [ ] **Step 1: Write failing JSONL-client tests.**

Use an injected fake child process to assert `forkNativeCodexThread(...)` sends
`initialize`, waits for the matching response, sends `initialized`, then sends
`thread/fork` with the input session ID and `excludeTurns: true`. Assert it
returns the valid `result.thread.id`. Assert malformed or missing IDs, server
errors, oversized output, early exit, and timeout reject without returning an
ID. Assert sent methods never include a transcript-read method.

- [ ] **Step 2: Run the focused test and verify it fails.**

Run: `npm test -- test/unit/app-server-fork.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the bounded JSONL client.**

Create `forkNativeCodexThread(...)` with an injected child-process factory for
tests. Spawn `codex app-server --listen stdio://` under the supplied Codex Home
and drive bounded JSONL `initialize` / `initialized` / `thread/fork` requests.
Set `excludeTurns: true`, accept only a valid `result.thread.id`, and terminate
the child on every terminal path. Never parse terminal output, log raw protocol
records, or call a transcript API.

- [ ] **Step 4: Run focused and type verification.**

Run: `npm test -- test/unit/app-server-fork.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit the fork client.**

```powershell
git add src/ui/app-server-fork.ts test/unit/app-server-fork.test.ts
git commit -m "feat: obtain native fork IDs through app-server"
```

### Task 3: Add the Native Continuation Terminal Adapter

**Files:**
- Create: `src/ui/native-continuation-terminal.ts`
- Create: `test/unit/native-continuation-terminal.test.ts`

- [ ] **Step 1: Write failing terminal-adapter tests.**

Use a fake VS Code terminal and injected `forkNativeCodexThread` dependency.
Assert resume creates a visible terminal using `{ cwd: layout.codexHome, env:
{ CODEX_HOME: layout.codexHome } }` and submits only a safe argument-vector
invocation. Assert fork does not create a VS Code terminal, delegates only the
source ID to the fork client, and returns `{ exitCode: 0, branchSessionId }`.
Assert malformed fork invocations and fork-client failures reject without
inventing an ID.

- [ ] **Step 2: Run the focused test and verify it fails.**

Run: `npm test -- test/unit/native-continuation-terminal.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the thin terminal adapter.**

Create `createNativeContinuationTerminal(...)` returning an
`InteractiveCodexTerminal` with `reportsForkOutcome: true`. Route resume to a
visible terminal scoped to the active layout; route a validated fork invocation
to `forkNativeCodexThread(...)`. The adapter contains no protocol parsing,
transcript behavior, or mapping persistence.

- [ ] **Step 4: Run focused and type verification.**

Run: `npm test -- test/unit/native-continuation-terminal.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit the terminal adapter.**

```powershell
git add src/ui/native-continuation-terminal.ts test/unit/native-continuation-terminal.test.ts
git commit -m "feat: add native continuation terminal adapter"
```

### Task 4: Connect Post-switch Continuation Selection

**Files:**
- Modify: `src/ui/commands.ts`
- Modify: `src/activation.ts`
- Modify: `test/unit/commands.test.ts`

- [ ] **Step 1: Write failing UI-orchestration tests.**

Extend the command fixture with a metadata-only anchor catalog and assert a
committed switch presents only session IDs. Selecting an anchor must call
`continueSession` with `mode: "fork"`, the switched profile ID, exact session
ID/hash, and no `readableFallbackPrompt` or `confirmReadableContent`. Assert a
dismissed picker creates no continuation, and failed/cancelled switches show no
picker. Preserve a regression assertion that the manual command prompts for an
ID and calls `mode: "resume"`.

- [ ] **Step 2: Run the focused test and verify it fails.**

Run: `npm test -- test/unit/commands.test.ts`

Expected: FAIL because no post-switch anchor catalog is used.

- [ ] **Step 3: Wire dependencies and reporting.**

Add an injectable source-anchor catalog dependency defaulting to
`listContinuationSourceAnchors`. After a committed switch, list anchors,
present the metadata-only picker, and call existing `continueSession` with the
app-server-backed terminal and selected anchor. Treat picker dismissal as no-op;
report unavailable native continuation and failures generically. Leave command
IDs and manual resume semantics unchanged. Create the production terminal in
activation with the VS Code API and active `CodexLayout`.

- [ ] **Step 4: Run focused and type verification.**

Run: `npm test -- test/unit/commands.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit the UI integration.**

```powershell
git add src/ui/commands.ts src/activation.ts test/unit/commands.test.ts
git commit -m "feat: offer mapped native continuation after switch"
```

### Task 5: Cover the Native Fork Contract and Document It

**Files:**
- Modify: `test/integration/continuation.test.ts`
- Modify: `README.md`
- Modify: `docs/development.md`

- [ ] **Step 1: Write the failing integration assertion.**

Add a fake app-server JSONL fixture whose only successful fork result contains
`result.thread.id`. Assert the continuation mapping uses that returned ID and
does not accept a branch ID injected independently of protocol output.

- [ ] **Step 2: Run the focused test and verify it fails.**

Run: `npm run test:integration -- test/integration/continuation.test.ts`

Expected: FAIL until the fixture uses the trusted app-server adapter.

- [ ] **Step 3: Update documentation.**

Document that a committed profile switch offers a metadata-only local session
picker; continuation uses native Codex fork/reuse, keeps three active branches,
and does not expose or replay transcript text. Document the app-server
requirement and the development test commands. Do not include credentials or
session content.

- [ ] **Step 4: Run focused and full verification.**

Run: `npm run check`

Expected: PASS.

Run: `npm test`

Expected: PASS.

Run: `npm run test:integration`

Expected: PASS.

Run: `npm run package:win32-x64`

Expected: PASS and produce one Windows-targeted VSIX.

- [ ] **Step 5: Commit documentation and contract coverage.**

```powershell
git add test/integration/continuation.test.ts README.md docs/development.md
git commit -m "docs: describe mapped native continuation"
```

## Plan Self-Review

- Spec coverage: source anchors, app-server trust, post-switch selection,
  no-readable-fallback behavior, bounded mappings, failure behavior, and
  regression coverage each have a dedicated task.
- Placeholder scan: each task names exact files, APIs, expected test outcomes,
  and commands; no deferred implementation notes remain.
- Type consistency: `ContinuationSourceAnchor`, `InteractiveCodexTerminal`,
  `ContinueSessionRequest`, and the injected anchor catalog are introduced
  before their consumers.
