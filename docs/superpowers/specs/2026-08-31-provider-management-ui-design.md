# Provider Management UI Design

Date: 2026-08-31
Status: Approved direction, pending written-spec review

## Goal

Add a VS Code Activity Bar entry for Codex Provider Switcher. The entry uses a native tree for navigation and a Webview workbench for Provider details. Users can create, edit, delete, and activate Provider profiles, and can manually synchronize Codex session metadata with visible progress and an explicit no-op result.

The feature must preserve the existing transactional switching, backup, rollback, path validation, SecretStorage, and remote-host behavior. The new UI is an adapter over the existing core services, not a second implementation of profile switching or rollout synchronization.

## User Model

Each Provider is one of two immutable kinds:

- **Custom configuration**: a named profile with `config.toml` and an associated `auth.json` view. The editable TOML remains non-secret. API keys are entered through a protected field and stored only in VS Code SecretStorage. The `auth.json` view is generated from the protected secret, redacted when displayed, and cannot persist a plaintext key in the managed profile directory.
- **OpenAI official login**: a named profile with no configuration form. Creation and re-authentication invoke the existing official Codex login executor; after successful verification the resulting official-auth state is associated with that profile. Multiple official profiles are allowed and names are user-defined.

Provider kind cannot change after creation, matching the current ProfileStore contract. Deletion requires an explicit confirmation and removes the profile through a dedicated store operation; deleting the active profile is rejected or requires selecting a replacement before commit (implementation will use the safer rejection path unless the existing store exposes an atomic replacement operation).

## Layout and Navigation

1. `viewsContainers.activitybar` contributes a Codex icon and a `codexProvider.providers` container.
2. A native `TreeDataProvider` renders a compact list of profiles. Each item shows the name, kind marker, and active marker. The tree has toolbar actions for add and refresh; item context actions expose edit, switch, and delete.
3. Selecting a profile opens or focuses a Webview editor in the main area. A top-level empty state explains how to add the first profile.
4. The Webview uses VS Code theme variables, keyboard-accessible controls, restrained layout, and no credentials in HTML or Webview state beyond redacted values.

The workbench has three logical regions:

- Provider header: name, kind, active state, switch and delete actions.
- Configuration region: custom profiles show structured fields first, with tabs for `auth.json` and `config.toml` raw editing. Official profiles show login status, login/re-login action, and name editing only.
- Session region: a manually triggered “Sync session metadata” action, progress bar, current stage, result count, warnings, and errors.

“Continue Codex session” is deliberately outside this first workbench design. The existing command remains available; no new continuation interaction is inferred until its product behavior is specified.

## Webview Message Contract

Messages from Webview to extension host are typed commands: `loadProfile`, `createProfile`, `saveProfile`, `loginOfficial`, `switchProfile`, `deleteProfile`, `syncSessions`, and `openRawFile`. The host validates every payload, calls the corresponding core/service or existing command handler, and returns typed results. The Webview never reads the filesystem or invokes Codex directly.

Host-to-Webview events include `profileSnapshot`, `operationProgress`, `operationCompleted`, `operationFailed`, and `notification`. Progress events map the existing switch progress stages (`preflight`, `backup`, `scan`, `rollouts`, `sqlite`, `verify`, `commit`) to a determinate bar when totals are known and an indeterminate state otherwise.

The panel and tree share a refresh event. After create, edit, delete, switch, login, or sync, the host reloads the profile list and active marker. Panel disposal cancels an in-flight operation through the existing cancellation path.

## Configuration Editing

Structured custom editing exposes the existing validated fields (`model_provider`, selected `model_providers` entry, `base_url`, and `wire_api`) and an API-key field that is write-only. “View/edit raw file” opens a controlled editor surface:

- `config.toml` is validated with `validateProfileConfig` before save.
- `auth.json` is parsed and validated against the supported auth shape; its credential value is never echoed back to the Webview and is written via SecretStorage.
- Invalid JSON/TOML keeps the editor open and returns field-level error text.

The existing `ProfileStore` remains the authority for managed TOML. Any necessary auth metadata persistence must be added behind the core store boundary so path and atomic-write checks remain centralized.

## Official Login Flow

The host invokes `OfficialLoginExecutor.run` for the selected official profile, reports login and status verification progress, and only marks the profile ready after `assertSuccessfulOfficialLogin` succeeds. A failed or cancelled login leaves the previous profile state unchanged and reports a recoverable error. The browser/terminal login surface is unchanged; the Webview only starts it and displays status.

## Manual Session Synchronization

No synchronization runs on activation or panel open. The user must click the sync action. The host selects the active profile, invokes the existing switch/synchronization orchestration, and streams progress. Before mutating anything, the scan result is inspected:

- zero candidate changes: show “No session metadata needs synchronization.”, zero progress mutation, and a completed state;
- one or more changes: show determinate progress and final applied count;
- encrypted or skipped records: show the existing warning text without exposing message content;
- cancellation or failure: show the existing safe rollback result and keep the last stable snapshot.

The UI does not auto-sync local Codex metadata and does not add a new background watcher.

## Error and Safety Rules

- Disable mutating controls while an operation is active; allow cancellation where the core operation supports it.
- Never display or log API keys, auth tokens, raw official auth content, or full sensitive command output.
- Require confirmation before switching and deleting.
- Surface recovery-required and commit-durability warnings distinctly; link to the existing restore-backup command where applicable.
- If startup prerequisites or recovery fail, render a read-only unavailable state and preserve the current command availability context behavior.

## Testing Strategy

- Manifest tests for Activity Bar container, view, commands, menus, and activation contributions.
- Unit tests for TreeDataProvider mapping, Webview message validation, redaction, and panel refresh behavior using a fake VS Code API.
- Core tests for auth metadata handling, custom/official kind invariants, deletion rules, and no-op synchronization reporting.
- Integration tests that exercise manual sync progress, cancellation, rollback, and remote/Windows layouts through the existing service seams.
- Build, package, and VSIX verification on supported targets; no claim of release readiness until the full existing test suite and new UI tests pass.

## Out of Scope

- Designing a new “continue Codex session” workflow.
- Automatic session synchronization.
- Storing API keys or official tokens in TOML, JSON profile files, Webview state, telemetry, or logs.
- Replacing the existing transactional switch engine, official-login executor, or continuation implementation.
