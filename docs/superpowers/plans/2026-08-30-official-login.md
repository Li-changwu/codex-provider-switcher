# Official Profile Native Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the native `codex login` flow and validate `codex login status` before an official Profile switch is committed, while preserving transactional rollback and keeping OAuth data outside the extension.

**Architecture:** The core switch orchestrator receives an injected `OfficialLoginExecutor`. When the target Profile is official, authentication materialization is journaled before it runs, removes the active custom auth file, invokes the executor, and throws on any non-success result so the existing transaction engine rolls back. The production executor uses VS Code Terminal Shell Integration with `CODEX_HOME` and the current Extension Host; it never reads terminal output or authentication files. The command layer injects this executor into stored Profile switching.

**Tech Stack:** TypeScript, Node `node:test`, VS Code `^1.98.0` Terminal Shell Integration, existing transaction journal and Profile switch services.

---

### Task 1: Add the core official-login contract and transactional behavior

**Files:**
- Create: `src/core/official-login.ts`
- Modify: `src/core/profile-switch-orchestrator.ts`
- Modify: `src/core/switch-service.ts`
- Modify: `test/unit/profile-switch-orchestrator.test.ts`
- Modify: `test/unit/switch-service.test.ts`
- Test: `test/unit/official-login.test.ts`

- [ ] **Step 1: Write the failing executor contract tests.**

Create `test/unit/official-login.test.ts` with a fake executor result and a direct helper test:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { assertSuccessfulOfficialLogin } from "../../src/core/official-login";

test("accepts only a successful login and status result", () => {
  assert.doesNotThrow(() => assertSuccessfulOfficialLogin({
    loginExitCode: 0,
    statusExitCode: 0,
  }));
});

test("rejects an unknown or non-zero native login result", () => {
  assert.throws(
    () => assertSuccessfulOfficialLogin({
      loginExitCode: undefined,
      statusExitCode: 0,
    }),
    /official Codex login could not be verified/i,
  );
  assert.throws(
    () => assertSuccessfulOfficialLogin({
      loginExitCode: 0,
      statusExitCode: 1,
    }),
    /official Codex login could not be verified/i,
  );
});
```

Add an official-target switch test to `test/unit/profile-switch-orchestrator.test.ts` that injects an executor, records the `codexHome`, and asserts the executor runs before the result is committed. Add tests for a failed executor and an aborted request; both must return `failed` or `cancelled` with `journalState === "rolledBack"`, leave the active Profile marker on the previous Profile, and never expose an OAuth value in the result diagnostics.

- [ ] **Step 2: Run the focused tests and verify they fail for the missing contract.**

Run:

```powershell
npm test -- test/unit/official-login.test.ts test/unit/profile-switch-orchestrator.test.ts
```

Expected: FAIL because `src/core/official-login.ts` and the official-login dependency are absent.

- [ ] **Step 3: Define the minimal core interface and result validation.**

Create `src/core/official-login.ts`:

```ts
import type { CodexLayout } from "./types";

export interface OfficialLoginResult {
  readonly loginExitCode: number | undefined;
  readonly statusExitCode: number | undefined;
  readonly cancelled?: boolean;
}

export interface OfficialLoginExecutor {
  run(layout: CodexLayout, signal?: AbortSignal): Promise<OfficialLoginResult>;
}

export function assertSuccessfulOfficialLogin(result: OfficialLoginResult): void {
  if (
    result.cancelled === true ||
    result.loginExitCode !== 0 ||
    result.statusExitCode !== 0
  ) {
    throw new Error("The official Codex login could not be verified.");
  }
}
```

- [ ] **Step 4: Make mutation journaling cover an auth change that fails during its apply callback.**

Extend `PreparedSwitchMutation` in `src/core/switch-service.ts` with:

```ts
readonly markTargetAppliedBeforeApply?: boolean;
```

In `runPlannedMutations`, after `prepareTarget` and before `mutation.apply`, call `markTargetApplied` when this flag is true; call it after `mutation.apply` only when the flag is false. Permit the flag only for `auth` targets, and reject invalid plans with `TypeError`. This ensures a failed native login leaves durable auth mutation evidence for rollback without changing the behavior of rollout, SQLite, or config mutations.

- [ ] **Step 5: Inject and invoke the executor for official targets.**

Add `officialLogin?: OfficialLoginExecutor` to `StoredProfileSwitchDependencies`. In `createStoredProfileSwitchDependencies`, require it during preflight when the selected target is official. In the existing `materialize active authentication mode` mutation:

```ts
if (materialization.target.kind === "custom") {
  await writeActiveCustomAuth(dependencies.layout, materialization.targetApiKey as string);
} else {
  await removeActiveCustomAuth(dependencies.layout);
  const executor = dependencies.officialLogin;
  if (!executor) {
    throw preparationError();
  }
  const result = await executor.run(dependencies.layout, request.signal);
  assertSuccessfulOfficialLogin(result);
}
```

Set `markTargetAppliedBeforeApply: true` on this auth mutation. Keep `restoreActiveAuthMode` as the only rollback path; it may restore a previous custom key from SecretStorage but must never read or restore OAuth data.

- [ ] **Step 6: Run the focused tests, then the full unit suite.**

Run:

```powershell
npm test -- test/unit/official-login.test.ts test/unit/profile-switch-orchestrator.test.ts test/unit/switch-service.test.ts
npm test
```

Expected: both commands exit with code 0 and report no failures. Update existing official-switch fixtures to inject a successful fake executor where required.

- [ ] **Step 7: Commit the core behavior.**

```powershell
git add src/core/official-login.ts src/core/profile-switch-orchestrator.ts src/core/switch-service.ts test/unit/official-login.test.ts test/unit/profile-switch-orchestrator.test.ts test/unit/switch-service.test.ts
git commit -m "feat: run native login for official Profile switches"
```

### Task 2: Implement the VS Code Terminal Shell Integration executor

**Files:**
- Create: `src/ui/official-login-terminal.ts`
- Create: `test/unit/official-login-terminal.test.ts`
- Modify: `src/ui/commands.ts`
- Modify: `src/activation.ts`

- [ ] **Step 1: Write failing terminal adapter tests.**

Use injected terminal and event doubles to assert these behaviors:

```ts
test("runs login then status in the terminal with the current Codex Home", async () => {
  const result = await executor.run(layout);
  assert.deepEqual(commands, [
    ["codex", ["login"]],
    ["codex", ["login", "status"]],
  ]);
  assert.equal(terminalOptions.env?.CODEX_HOME, layout.codexHome);
  assert.deepEqual(result, { loginExitCode: 0, statusExitCode: 0 });
});

test("fails closed when Shell Integration never becomes available", async () => {
  await assert.rejects(
    executor.run(layout),
    /shell integration/i,
  );
});

test("returns a cancelled result after aborting the active command", async () => {
  controller.abort();
  const result = await executor.run(layout, controller.signal);
  assert.equal(result.cancelled, true);
  assert.equal(ctrlCCount, 1);
});
```

The doubles must expose only command names, argument arrays, exit codes, and cancellation calls; they must not contain OAuth text or API keys.

- [ ] **Step 2: Run the adapter tests and verify they fail.**

Run:

```powershell
npm test -- test/unit/official-login-terminal.test.ts
```

Expected: FAIL because the production terminal adapter does not exist.

- [ ] **Step 3: Implement the terminal adapter with strict failure handling.**

Create `src/ui/official-login-terminal.ts` around a narrow injected API:

```ts
export interface OfficialLoginTerminalApi {
  createTerminal(options: {
    name: string;
    cwd: string;
    env: { CODEX_HOME: string };
  }): OfficialLoginTerminal;
  onDidChangeTerminalShellIntegration: OfficialLoginEvent<OfficialLoginShellIntegrationEvent>;
  onDidEndTerminalShellExecution: OfficialLoginEvent<OfficialLoginShellExecutionEndEvent>;
}
```

Create and show one terminal with `cwd` and `CODEX_HOME` set to the resolved layout. Wait for Shell Integration with a bounded timeout. Execute `codex login`, then `codex login status` through `shellIntegration.executeCommand("codex", args)`. Register the end-execution listener before each command and match the exact execution object. Treat `undefined` exit codes as failure. On abort, send Ctrl+C to the terminal, wait for the command to end or dispose the terminal after the bounded cancellation deadline, and return `{ cancelled: true }`. Do not call `read()`, do not capture terminal output, do not use a shell command string, and do not dispose a successfully completed terminal so the user can inspect the native CLI interaction.

- [ ] **Step 4: Wire the adapter into command dependencies.**

Extend `ProfileCommandDependencies` with `officialLogin?: OfficialLoginExecutor`. Pass it through `switchWithProgress` into `switchStoredProfile`. Remove the messages that tell users to run `codex login` manually; successful official switches should report completion, while failed/cancelled switches keep the existing rollback messages.

In `src/activation.ts`, create the production adapter from the `vscode.window` API and pass it when constructing command handlers. Keep the adapter optional in test-only command fixtures, but an official switch without an executor must fail safely during preflight.

- [ ] **Step 5: Run adapter, command, activation, and full unit tests.**

Run:

```powershell
npm test -- test/unit/official-login-terminal.test.ts test/unit/commands.test.ts test/unit/activation-lifecycle.test.ts
npm test
npm run check
```

Expected: all commands exit with code 0. No test output may contain an API key, OAuth token, or full terminal transcript.

- [ ] **Step 6: Commit the VS Code integration.**

```powershell
git add src/ui/official-login-terminal.ts src/ui/commands.ts src/activation.ts test/unit/official-login-terminal.test.ts test/unit/commands.test.ts test/unit/activation-lifecycle.test.ts
git commit -m "feat: connect official login to VS Code terminal"
```

### Task 3: Add integration coverage and user-facing documentation

**Files:**
- Modify: `test/integration/rollback.test.ts`
- Modify: `README.md`
- Modify: `docs/development.md`

- [ ] **Step 1: Add an integration test for login failure rollback.**

Use the existing temporary Codex Home fixture and an injected executor that returns `{ loginExitCode: 1, statusExitCode: undefined }`. Assert that the result is `failed`, the journal is `rolledBack`, the config, rollout hashes, SQLite bytes, and active Profile match the pre-switch snapshot, and the extension never writes a backup containing `auth.json` or a SecretStorage value.

- [ ] **Step 2: Add an integration test for successful login and status validation.**

Use an executor that records the layout and returns `{ loginExitCode: 0, statusExitCode: 0 }`. Assert that the official config, provider metadata, and active Profile are committed only after both executor steps have completed. Add a second case with `statusExitCode: 1` and assert complete rollback.

- [ ] **Step 3: Run integration and packaging checks.**

Run:

```powershell
npm run test:integration -- test/integration/rollback.test.ts
npm run check
npm run build
```

Expected: all commands exit with code 0. The integration assertions must hold on Windows, native Linux, and Remote SSH Linux fixtures; no packaging code needs to change because the feature uses only the existing VS Code API and TypeScript bundle.

- [ ] **Step 4: Document the behavior without documenting secrets.**

Update `README.md` and `docs/development.md` to state that switching to an official Profile opens the native `codex login` flow in the current Extension Host terminal, validates with `codex login status`, and rolls back on failure or cancellation. State that OAuth credentials remain owned by Codex and are never copied into Profiles, logs, backups, or extension storage. Do not add API keys, tokens, or full terminal output.

- [ ] **Step 5: Run the complete verification suite and commit documentation.**

Run:

```powershell
npm test
npm run test:integration
npm run check
npm run build
```

Expected: exit code 0 from every command.

```powershell
git add test/integration/rollback.test.ts README.md docs/development.md
git commit -m "test: verify official login rollback and document flow"
```

## Plan Self-Review

- The existing approved design requirement for native official login is covered by Tasks 1 and 2.
- Rollback evidence for an auth mutation that fails after removing `auth.json` is covered by the pre-apply journal marker in Task 1 and the integration case in Task 3.
- Unknown Shell Integration state, unknown exit codes, cancellation, non-zero login, and non-zero status are all fail-closed.
- The plan does not copy OAuth data, API keys, full transcripts, or terminal output into extension-owned state.
- Windows, native Linux, and Remote SSH Linux use the same Extension Host APIs; no device-crossing path or WSL behavior is introduced.
- The plan has no placeholder steps and each implementation step names its files, commands, and expected result.
