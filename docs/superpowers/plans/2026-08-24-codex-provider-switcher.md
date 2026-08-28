# Codex Provider Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows/Linux VS Code extension that switches named Codex authentication/configuration Profiles and transactionally synchronizes native Codex session visibility, with native-session forking as a continuation fallback.

**Architecture:** The extension runs in the active VS Code Extension Host, so Remote SSH operations stay on the Linux server. Small core modules own Profile storage, Codex Home discovery, TOML/auth materialization, rollout metadata, SQLite updates, transaction journals, progress, and native `codex resume`/`codex fork` invocation. The extension never stores full conversation copies; its state database contains only Profile and branch mappings.

**Tech Stack:** TypeScript, VS Code Extension API (VS Code `^1.98.0`, Node >=20.17), Node.js `node:test`, `@iarna/toml`, `sqlite3` `^6.0.1`, `esbuild`, `tsx`, `@vscode/test-electron`, and GitHub Actions on Windows and Ubuntu.

---

## Repository Layout

The repository is empty, so the first implementation creates this structure:

```text
package.json                 Extension manifest and scripts
tsconfig.json                TypeScript settings
esbuild.mjs                  Extension bundle entrypoint
src/extension.ts             VS Code activation and command registration
src/core/types.ts            Shared domain types
src/core/codex-home.ts       Host and Codex Home/layout discovery
src/core/profiles.ts         Profile definitions and non-secret storage
src/core/secrets.ts          Remote Extension Host SecretStorage adapter
src/core/config.ts           TOML validation and active config/auth files
src/core/rollouts.ts         Rollout JSONL provider metadata operations
src/core/sqlite.ts           SQLite state inspection and transactional updates
src/core/transaction.ts      Backup, journal, lock, commit, rollback, recovery
src/core/continuation.ts     Native resume/fork and branch mapping
src/core/retention.ts        Branch/backup/temp retention policy
src/core/switch-service.ts   End-to-end Profile switch orchestration
src/ui/commands.ts           Command handlers and QuickPick/InputBox flows
src/ui/progress.ts           Progress event translation and cancellation
test/unit/*.test.ts          Pure unit tests using node:test
test/integration/*.test.ts   Temporary Codex Home integration fixtures
test/fixtures/*              Small rollout and SQLite fixtures
docs/superpowers/specs/*     Confirmed design specification
```

## Task 1: Initialize the Extension Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `esbuild.mjs`
- Create: `.gitignore`
- Create: `.vscodeignore`
- Create: `src/extension.ts`
- Create: `docs/superpowers/specs/2026-08-24-codex-provider-switcher-design.md`
- Test: `test/unit/extension-manifest.test.ts`

- [ ] **Step 1: Write the manifest contract test.**

The test reads `package.json` and asserts that the extension declares VS Code `^1.98.0` (required by SQLite 6's Node >=20.17 runtime), Node-compatible activation, the commands `codexProvider.createProfile`, `codexProvider.switchProfile`, `codexProvider.syncSessions`, `codexProvider.continueSession`, and `codexProvider.restoreBackup`, plus a status-bar activation entry.

- [ ] **Step 2: Run the contract test and verify it fails.**

Run: `node --test test/unit/extension-manifest.test.ts`

Expected: FAIL because the manifest and test file do not yet exist.

- [ ] **Step 3: Add the minimal extension project.**

`package.json` must contain these scripts and dependencies:

```json
{
  "name": "codex-provider-switcher",
  "displayName": "Codex Provider Switcher",
  "version": "0.1.0",
  "private": true,
  "engines": { "vscode": "^1.98.0" },
  "main": "./dist/extension.js",
  "activationEvents": ["onStartupFinished"],
  "scripts": {
    "build": "node esbuild.mjs",
    "check": "tsc --noEmit",
    "test": "tsx --test test/unit/*.test.ts",
    "test:integration": "tsx --test test/integration/*.test.ts",
    "package": "node scripts/package-extension.mjs",
    "package:win32-x64": "node scripts/package-extension.mjs win32-x64",
    "package:linux-x64": "node scripts/package-extension.mjs linux-x64",
    "verify:binding": "node scripts/verify-sqlite-binding.mjs",
    "verify:package": "node scripts/verify-vsix.mjs"
  },
  "dependencies": {
    "@iarna/toml": "^3.0.0",
    "sqlite3": "^6.0.1"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/vscode": "^1.98.0",
    "@vscode/test-electron": "^2.4.1",
    "@vscode/vsce": "^2.26.1",
    "esbuild": "^0.24.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

The bundle must externalize `vscode`, target the current Node runtime, and write `dist/extension.js`. `src/extension.ts` registers the five commands, creates one status-bar item, and disposes every registration through `context.subscriptions`.

Packaging is host-targeted: Windows x64 may produce only `@win32-x64` and Linux x64 only `@linux-x64`; cross-compilation is not claimed. A generic Linux artifact additionally requires a glibc Linux x64 host. Before its SQLite preflight, the Linux target runs the lockfile-pinned local `prebuild-install` from sqlite3's package directory with explicit N-API, linux, x64, and glibc arguments plus a URL derived from the installed sqlite3 version and its highest compatible N-API declaration. It runs in a TLS-verified, injection-free OS/proxy whitelist with a fresh temporary npm cache, removes sqlite3's previous `build` directory first, disables package-local prebuild overrides, and cleans that cache on every outcome. It must obtain sqlite3's official matching prebuild and never falls back to `node-gyp`; any cleanup, download, extraction, or binding-discovery failure aborts before the ordinary SQLite preflight. The target script removes only exact root-resolved stale legacy, target, VSCE, and temporary artifact names, then runs `check`, `build`, that Linux-only prebuild gate, the clean-child SQLite N-API preflight (minimal environment without Node loader variables and a bounded timeout), and a controlled production audit with explicit `https://registry.npmjs.org/`, strict SSL, an isolated temporary cache, and the TLS-verified OS/proxy whitelist. It packages to a hidden nonpublishable temporary VSIX, verifies that archive and its extracted clean-child `require("sqlite3")`, and only then renames it to `<name>-<version>@<target>.vsix`. Any failure removes the exact temporary and final target artifacts. Task 8's Ubuntu glibc job provides the actual Linux package-load evidence.

The VSIX packages an explicit runtime closure only: extension output, `@iarna/toml` runtime JavaScript, sqlite3's package manifest and runtime loaders, the native `.node` selected by the installed sqlite3 layout, and the `bindings`/`file-uri-to-path` loader dependencies. It excludes install/build tooling such as `node-gyp`, `prebuild-install`, and `tar`, as well as declarations, source/archive content, and source maps. Verification retains normal VSIX metadata such as `[Content_Types].xml` and `extension.vsixmanifest`, requires the extension manifest and bundle plus the SQLite runtime closure, rejects unsafe or oversized archives, and performs the extracted-package native load.

- [ ] **Step 4: Run the contract test and type check.**

Run: `npm install`

Expected: exit code 0 and a lockfile is created.

Run: `node --test test/unit/extension-manifest.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit the project skeleton.**

```bash
git add package.json package-lock.json tsconfig.json esbuild.mjs .gitignore .vscodeignore src/extension.ts test/unit/extension-manifest.test.ts
git commit -m "chore: initialize VS Code extension"
```

## Task 2: Add Codex Home Discovery and Profile Storage

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/codex-home.ts`
- Create: `src/core/profiles.ts`
- Create: `src/core/secrets.ts`
- Create: `test/unit/codex-home.test.ts`
- Create: `test/unit/profiles.test.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Define the shared types and failing tests.**

Use these domain types:

```ts
export type ProfileKind = "official" | "custom";

export interface ProfileRecord {
  id: string;
  name: string;
  kind: ProfileKind;
  configFile: string;
  providerId?: string;
  apiKeySecretId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexLayout {
  codexHome: string;
  configPath: string;
  authPath: string;
  sessionsDir: string;
  archivedSessionsDir: string;
  sqlitePath: string;
  switcherDir: string;
}
```

Tests must cover explicit `CODEX_HOME`, platform defaults, Remote SSH execution on Linux, refusal of WSL/UNC SQLite paths, Profile ID normalization, and redaction of `apiKeySecretId` from serialized public Profile files.

- [ ] **Step 2: Run the new tests and verify they fail.**

Run: `npm test -- test/unit/codex-home.test.ts test/unit/profiles.test.ts`

Expected: FAIL because the modules and implementations are absent.

- [ ] **Step 3: Implement discovery, Profile records, and SecretStorage.**

`resolveCodexLayout({ env, platform, homeDir, extensionStorageUri })` must prefer `CODEX_HOME`, otherwise use the platform home directory and `.codex`. It must return the complete `CodexLayout` and throw a typed `UnsupportedHostError` for WSL or a Windows UNC SQLite path.

`ProfileStore` must write non-secret records under `<codexHome>/provider-switcher/profiles/index.json`, write one `config.toml` per Profile, use stable IDs derived from a normalized name plus a collision suffix, and write files atomically with mode `0600` on Linux. `SecretStore` wraps `ExtensionContext.secrets`; its constructor receives the resolved Extension Host storage location and rejects a non-remote/unverifiable store rather than writing an API Key to `index.json`.

- [ ] **Step 4: Run the tests and verify they pass.**

Run: `npm test -- test/unit/codex-home.test.ts test/unit/profiles.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the Profile layer.**

```bash
git add src/core/types.ts src/core/codex-home.ts src/core/profiles.ts src/core/secrets.ts src/extension.ts test/unit/codex-home.test.ts test/unit/profiles.test.ts
git commit -m "feat: add remote Codex profiles and home discovery"
```

## Task 3: Implement TOML and Authentication Materialization

**Files:**
- Create: `src/core/config.ts`
- Create: `test/unit/config.test.ts`
- Modify: `src/core/types.ts`

- [ ] **Step 1: Write failing TOML/auth tests.**

Tests must assert:

```ts
validateCustomConfig(`model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://nowcoding.ai/v1"`);
// returns the parsed provider ID and no errors

materializeAuth({ kind: "custom", apiKey: "secret" });
// returns exactly { OPENAI_API_KEY: "secret" }

validateCustomConfig("model_provider = \"custom\"");
// throws a ValidationError describing the missing provider section/base_url
```

Also test that malformed TOML, empty API Keys, unsupported `wire_api`, and unknown official Profile kinds fail before any file write.

- [ ] **Step 2: Run the tests and verify they fail.**

Run: `npm test -- test/unit/config.test.ts`

Expected: FAIL because the config module is absent.

- [ ] **Step 3: Implement config validation and atomic writes.**

Expose:

```ts
export function validateProfileConfig(input: string, kind: ProfileKind): ValidatedConfig;
export function serializeActiveAuth(apiKey: string): string;
export async function writeActiveConfig(layout: CodexLayout, text: string): Promise<void>;
export async function writeActiveCustomAuth(layout: CodexLayout, apiKey: string): Promise<void>;
export async function removeActiveCustomAuth(layout: CodexLayout): Promise<void>;
```

Use `@iarna/toml` to parse. Require `model_provider`, the selected `[model_providers.<id>]` table, `base_url`, and `wire_api = "responses"` for custom Profiles. Preserve the raw user TOML in the Profile; never reserialize it merely to switch. Write through a same-directory temporary file, `rename`, and set Linux mode `0600`. Never copy `auth.json` into a backup or log.

- [ ] **Step 4: Run the tests and verify they pass.**

Run: `npm test -- test/unit/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit configuration handling.**

```bash
git add src/core/config.ts src/core/types.ts test/unit/config.test.ts
git commit -m "feat: validate and materialize Codex provider configs"
```

## Task 4: Implement Rollout and SQLite Provider Synchronization

**Files:**
- Create: `src/core/rollouts.ts`
- Create: `src/core/sqlite.ts`
- Create: `test/fixtures/sessions/rollout-openai.jsonl`
- Create: `test/fixtures/sessions/rollout-custom.jsonl`
- Create: `test/fixtures/state_5.sqlite`
- Create: `test/unit/rollouts.test.ts`
- Create: `test/unit/sqlite.test.ts`
- Create: `test/integration/sync-storage.test.ts`
- Create: `NOTICE.md`

- [ ] **Step 1: Add fixtures and failing tests for provider-only changes.**

Tests must assert that a rollout with provider `openai` becomes `custom` without changing message lines, titles, timestamps, or unrelated JSON fields. Tests must assert that archived sessions are included, malformed JSONL is rejected without writing, and encrypted-content counters produce a warning rather than rewriting message bodies.

SQLite tests must create a temporary database with the fixture schema, update only recognized provider columns inside a transaction, report changed-row counts, and reject an unknown schema version. A failed transaction must leave the database byte-for-byte unchanged after restore.

- [ ] **Step 2: Run the tests and verify they fail.**

Run: `npm test -- test/unit/rollouts.test.ts test/unit/sqlite.test.ts test/integration/sync-storage.test.ts`

Expected: FAIL because the storage modules and fixtures are absent.

- [ ] **Step 3: Implement streaming rollout rewriting.**

Expose:

```ts
export interface RolloutChange {
  path: string;
  sessionId: string;
  beforeProvider: string | null;
  afterProvider: string;
  encryptedContent: boolean;
}

export async function collectRolloutChanges(layout: CodexLayout, targetProvider: string): Promise<RolloutChange[]>;
export async function applyRolloutChanges(changes: RolloutChange[], signal?: AbortSignal): Promise<number>;
```

Scan `sessions` and `archived_sessions` as streams. Rewrite only the provider metadata fields identified by the fixture and the supported Codex layout. Write each changed rollout through a temporary sibling file and rename it; do not load all transcript bodies into memory. Abort before the next rename when the signal is cancelled.

- [ ] **Step 4: Implement SQLite discovery and transaction updates.**

Expose:

```ts
export async function inspectStateDatabase(layout: CodexLayout): Promise<SqliteInspection>;
export async function updateProviderMetadata(layout: CodexLayout, targetProvider: string, signal?: AbortSignal): Promise<SqliteUpdateResult>;
```

Use `sqlite3`, serialized database operations, `BEGIN IMMEDIATE`, targeted `UPDATE` statements for the known fixture schema, `COMMIT`, and `ROLLBACK` on any error. Wrap its callback API in a focused Promise adapter so the public storage API remains asynchronous. Set a bounded busy timeout and return `locked` rather than waiting indefinitely. The adapter must fail closed for an unknown schema and never use a full transcript table as a copy store.

- [ ] **Step 5: Run storage tests and integration tests.**

Run: `npm test -- test/unit/rollouts.test.ts test/unit/sqlite.test.ts`

Expected: PASS.

Run: `npm run test:integration -- test/integration/sync-storage.test.ts`

Expected: PASS on Windows and Ubuntu runners.

- [ ] **Step 6: Commit the storage adapter.**

```bash
git add src/core/rollouts.ts src/core/sqlite.ts test/fixtures test/unit/rollouts.test.ts test/unit/sqlite.test.ts test/integration/sync-storage.test.ts NOTICE.md
git commit -m "feat: synchronize native Codex provider metadata"
```

`NOTICE.md` must attribute any directly reused MIT-licensed implementation or fixture logic to `Dailin521/codex-provider-sync` and include its license URL.

## Task 5: Add Transaction Journal, Backups, Rollback, and Progress

**Files:**
- Create: `src/core/transaction.ts`
- Create: `src/core/switch-service.ts`
- Create: `src/ui/progress.ts`
- Create: `test/unit/transaction.test.ts`
- Create: `test/unit/progress.test.ts`
- Create: `test/integration/rollback.test.ts`

- [ ] **Step 1: Write failing transaction and progress tests.**

Tests must simulate failures before backup, after one rollout rename, after SQLite commit, before final commit, user cancellation, and process interruption. Each case must assert that config, auth mode, rollout hashes, and SQLite bytes equal the pre-switch snapshot. A test for a terminal committed journal must assert that recovery never rolls it back.

Progress tests must assert ordered stages `preflight`, `backup`, `scan`, `rollouts`, `sqlite`, `verify`, `commit`, monotonic percentages, an indeterminate scan when total is unknown, and cancellation propagation.

- [ ] **Step 2: Run the tests and verify they fail.**

Run: `npm test -- test/unit/transaction.test.ts test/unit/progress.test.ts test/integration/rollback.test.ts`

Expected: FAIL because transaction and progress modules are absent.

- [ ] **Step 3: Implement the journal and backup protocol.**

Use `<codexHome>/provider-switcher/transactions/<operation-id>/journal.jsonl` and a sibling backup directory. Journal states are `prepared`, `applying`, `committed`, `rolledBack`, and `recoveryRequired`. Each applied target records its absolute path and kind. Backups include config, rollout files, SQLite, and file hashes, but exclude `auth.json`, SecretStorage values, and message-derived temporary context.

Expose:

```ts
export interface SwitchRequest { targetProfileId: string; expectedConfigHash?: string; signal?: AbortSignal; }
export async function switchProfile(request: SwitchRequest, deps: SwitchDependencies): Promise<SwitchResult>;
export async function recoverPendingSwitches(layout: CodexLayout, deps: RecoveryDependencies): Promise<RecoveryResult>;
```

Acquire a per-Codex-Home lock file with the current process ID. Refuse a second operation, detect stale locks only after checking the owning process, and restore pending transactions before a new write. Treat the journal as authoritative after a durable terminal commit; never compensate a committed switch because a UI acknowledgement failed.

- [ ] **Step 4: Implement progress translation and cancellable orchestration.**

`switchProfile` composes ProfileManager, config materialization, rollout adapter, SQLite adapter, and RecoveryManager. It emits typed progress events and only changes the active Profile marker after every required stage verifies successfully. A cancellation invokes rollback and resolves with a cancellation result only after the rollback terminal record is durable.

- [ ] **Step 5: Run all transaction tests and inspect rollback fixtures.**

Run: `npm test -- test/unit/transaction.test.ts test/unit/progress.test.ts`

Expected: PASS.

Run: `npm run test:integration -- test/integration/rollback.test.ts`

Expected: PASS, including injected failures at every mutation boundary.

- [ ] **Step 6: Commit transactional switching.**

```bash
git add src/core/transaction.ts src/core/switch-service.ts src/ui/progress.ts test/unit/transaction.test.ts test/unit/progress.test.ts test/integration/rollback.test.ts
git commit -m "feat: add transactional provider switching and rollback"
```

## Task 6: Add Native Continuation and Retention

**Files:**
- Create: `src/core/continuation.ts`
- Create: `src/core/retention.ts`
- Create: `test/unit/continuation.test.ts`
- Create: `test/unit/retention.test.ts`
- Create: `test/integration/continuation.test.ts`

- [ ] **Step 1: Write failing continuation tests.**

Use a fake `codex` executable and assert:

```ts
await continueSession({ sessionId: "source-1", mode: "resume" });
// invokes: codex resume source-1

await continueSession({ sessionId: "source-1", mode: "fork" });
// invokes: codex fork source-1
```

When `fork` exits nonzero with an encrypted-content error, the result must be `readableContentFallback`, preserve the source mapping, and require an explicit user confirmation before launching the fallback prompt. Repeated continuation for the same source Profile pair must reuse the recorded branch until the source event hash changes.

- [ ] **Step 2: Run continuation tests and verify they fail.**

Run: `npm test -- test/unit/continuation.test.ts test/unit/retention.test.ts`

Expected: FAIL because the modules are absent.

- [ ] **Step 3: Implement CLI invocation and branch mapping.**

Use `child_process.spawn` with an argument array, never a shell string, and strip API Keys from captured stderr. Check `codex --help` once per process to confirm `resume` and `fork` support. Use `vscode.window.createTerminal` for interactive native sessions; do not run a hidden assistant process.

Persist mappings in `<codexHome>/provider-switcher/state.sqlite` with source session ID, target Profile ID, branch session ID, source event hash, status, and timestamps. Do not store transcript text in this database.

- [ ] **Step 4: Implement retention.**

Keep at most three active branches for each source/target pair by default. Archive older branches through the native Codex command where available; never permanently delete without a confirmation command. Keep the ten most recent completed transaction backups by default, and delete expired temporary context files on successful launch or startup cleanup.

- [ ] **Step 5: Run continuation integration tests and commit.**

Run: `npm run test:integration -- test/integration/continuation.test.ts`

Expected: PASS using the fake CLI and a temporary Codex Home.

```bash
git add src/core/continuation.ts src/core/retention.ts test/unit/continuation.test.ts test/unit/retention.test.ts test/integration/continuation.test.ts
git commit -m "feat: continue native sessions with bounded branches"
```

## Task 7: Connect the VS Code UI

**Files:**
- Create: `src/ui/commands.ts`
- Create: `test/unit/commands.test.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Write command-handler tests.**

Mock the VS Code API and assert that:

- Create Profile prompts for name, kind, TOML, and API Key only for custom Profiles.
- Switch Profile shows current and target Profile names, asks for confirmation, and calls `switchProfile` once.
- Sync cancellation passes an `AbortSignal` and waits for the rollback result.
- Continue requires confirmation before transferring readable content to a new provider.
- Errors show a redacted message and never display the raw API Key.

- [ ] **Step 2: Run command tests and verify they fail.**

Run: `npm test -- test/unit/commands.test.ts`

Expected: FAIL because command handlers are absent.

- [ ] **Step 3: Implement native VS Code commands and status bar.**

Register these command IDs:

```text
codexProvider.createProfile
codexProvider.editProfile
codexProvider.switchProfile
codexProvider.syncSessions
codexProvider.continueSession
codexProvider.restoreBackup
```

Use `QuickPick` for Profile selection, `InputBox` with password mode for API Keys, `window.withProgress({ cancellable: true })` for switching, and a status-bar item with the active Profile. All asynchronous commands must serialize through one operation mutex.

- [ ] **Step 4: Add user-facing documentation and run checks.**

`README.md` must explain Remote SSH behavior, Windows/Linux scope, Profile creation, official `codex login`, API Key handling, backup recovery, the encrypted-content limitation, and the exact commands to build/test/package. It must never contain a real API Key.

Run: `npm run check`

Expected: PASS.

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit the UI integration.**

```bash
git add src/extension.ts src/ui/commands.ts test/unit/commands.test.ts package.json README.md
git commit -m "feat: add VS Code commands and provider status UI"
```

## Task 8: Add Cross-Platform CI and Packaging Verification

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/package.yml`
- Create: `test/integration/platform-matrix.test.ts`
- Modify: `package.json`
- Modify: `.vscodeignore`

- [ ] **Step 1: Add platform matrix tests.**

Use injected platform and home-directory values to test Windows and Linux path resolution without touching a real Codex Home. Add a real temporary-file smoke test for atomic rename and Linux mode `0600`; skip the mode assertion on Windows.

- [ ] **Step 2: Add GitHub Actions.**

Run `npm ci`, `npm run check`, unit tests, integration tests, and packaging on `windows-latest` and `ubuntu-latest`. The package workflow runs only after CI succeeds and executes `npm run package`; it must not publish a release or expose secrets.

- [ ] **Step 3: Run the complete local verification.**

Run:

```bash
npm ci
npm run check
npm test
npm run test:integration
npm run package
```

Expected: all commands exit 0 and produce one `.vsix` that excludes tests, fixtures, Profile secrets, and transaction data.

- [ ] **Step 4: Commit CI and packaging.**

```bash
git add .github/workflows/ci.yml .github/workflows/package.yml test/integration/platform-matrix.test.ts package.json .vscodeignore
git commit -m "ci: verify Windows and Linux extension packaging"
```

## Task 9: Final Verification and GitHub Handoff

**Files:**
- Modify: `README.md`
- Create: `CHANGELOG.md`

- [ ] **Step 1: Verify the acceptance criteria against the design.**

Check that the implementation can switch official/custom Profiles, does not save OAuth credentials, writes only the active custom `auth.json`, synchronizes provider metadata, rolls back all mutation targets on cancellation/failure, shows progress, reuses branches, and keeps all state on the current Extension Host machine.

- [ ] **Step 2: Review the final diff and sensitive-data scan.**

Run:

```bash
git diff --check
git status --short
rg -n -i "sk-[A-Za-z0-9]|OPENAI_API_KEY\"\s*:\s*\"[^\"]+|api[-_ ]?key\s*[:=]\s*[^<$({]" --glob '!package-lock.json' .
```

Expected: no whitespace errors, only intended files changed, and no real credentials.

- [ ] **Step 3: Create the first development commit set and push a review branch.**

Use a branch named `feature/provider-switching`, push it to `origin`, and open a draft pull request after all tests pass. The PR description must link the design spec, list the known encrypted-content limitation, and include the Windows/Linux CI results.

- [ ] **Step 4: Commit the final documentation.**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document provider switcher workflow"
```

## Plan Self-Review

- Spec coverage: Profile storage, official re-login, Windows/Linux/Remote SSH boundaries, provider metadata synchronization, native fork continuation, progress, rollback, bounded retention, security, and tests are mapped to Tasks 2 through 8.
- Placeholder scan: no unresolved task names or empty implementation steps are used.
- Type consistency: `ProfileRecord`, `CodexLayout`, `SwitchRequest`, `RolloutChange`, and the public service function names are defined before later tasks consume them.
- Scope: the empty repository is split into one vertical extension build with independently testable storage, transaction, continuation, UI, and packaging layers. macOS, WSL, cloud synchronization, and an owned chat UI remain outside this plan.
