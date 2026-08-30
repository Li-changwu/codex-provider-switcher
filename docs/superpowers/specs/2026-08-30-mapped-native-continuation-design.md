# Mapped Native Continuation Design

## Goal

After a profile switch commits, the extension lets the user select a local
Codex session and continue it under the selected profile. The continuation is
always a native Codex branch or resume; the extension never constructs a chat
prompt from stored conversation content.

## Scope

- Windows native, Linux native, and Remote SSH Linux extension hosts.
- Existing local Codex Home only; no cross-device or cloud synchronization.
- The existing three-active-branch limit and archive/unarchive behavior remain
  the source of truth.
- `Codex: Continue Session` remains the manual native `codex resume` command.

Out of scope: transcript replay, a standalone chat UI, WSL, macOS, automatic
selection of a source session, and cancelling an already-created native fork.

## Source Anchors

`listContinuationSourceAnchors(layout)` will enumerate active and archived
rollout files through the existing trusted-layout discovery. It returns only:

```ts
interface ContinuationSourceAnchor {
  readonly sessionId: string;
  readonly sourceEventHash: string;
}
```

The resolver streams each rollout into SHA-256 and reads only the
`session_meta.payload.id` metadata needed to identify a source. It emits no
titles, messages, previews, paths, provider values, or transcript bytes. It
does not write a file or database. Duplicate IDs and malformed session metadata
fail closed, matching the rollout safety model. Returned anchors are sorted by
session ID for deterministic UI and tests.

The hash is canonical lower-case SHA-256 of the current rollout bytes. It is
the existing branch-mapping revision key: unchanged bytes reuse the mapping;
changed bytes request a new native branch subject to the bounded-retention
policy.

## Trusted Native Fork

Terminal output has no documented machine-readable result contract, so it is
not a source of branch IDs. A `NativeContinuationTerminal` retains the normal
visible VS Code terminal route for `resume`, with `cwd` and `CODEX_HOME` set to
the active layout. For `fork`, it starts a short-lived native Codex app-server
child process with the same `cwd` and `CODEX_HOME`.

The child uses newline-delimited JSON over stdio. It sends exactly this
sequence:

1. JSON-RPC `initialize` request with extension client metadata.
2. `initialized` notification after the matching initialize response.
3. `thread/fork` with `threadId` equal to the selected session ID and
   `excludeTurns: true`.

It validates only `result.thread.id` against the existing session-ID grammar,
then returns that ID to `continueSession`. It does not invoke `thread/read`,
`thread/items/list`, or `thread/turns/list`; it ignores every response field
other than the forked ID, stores no app-server response, and never logs raw
protocol output. Stdout and stderr are capped, protocol startup/fork has a
bounded timeout, and malformed, oversized, failed, or missing-ID responses
fail closed. The child is terminated once the fork request resolves.

The adapter advertises `reportsForkOutcome: true` because a fork result comes
from the app-server response rather than terminal text. `continueSession`
continues to own branch reservation, compensation, persistence, retention, and
the rule that readable-content fallback is not supplied by the UI.

## UI Flow

After `switchStoredProfile` returns `committed`, the command shows a Quick Pick
containing session IDs only. Selecting one calls `continueSession` with:

```ts
{
  layout,
  sessionId: selected.sessionId,
  sourceEventHash: selected.sourceEventHash,
  targetProfileId: switchedProfileId,
  mode: "fork",
  terminal: nativeContinuationTerminal,
}
```

No fallback prompt or confirmation callback is passed. Closing the picker does
nothing beyond the already-successful switch. Failed or cancelled switches do
not show the picker. Reused mappings and new native forks each show a concise
success message; fallback-unavailable and native failures show generic,
redacted messages. The existing operation mutex protects the entire sequence,
so a second profile operation cannot begin while a source is being selected or
a fork mapping is committed.

## Testing

Unit tests establish the metadata-only anchor contract, including hashes,
deterministic ordering, duplicates, malformed metadata, and the absence of
transcript-shaped fields. App-server tests use a fake JSONL child process to
verify handshake order, `excludeTurns`, trusted ID extraction, and fail-closed
timeouts/errors. Command tests cover committed-switch selection, picker
cancellation, no continuation for a noncommitted switch, no readable fallback,
and unchanged manual resume behavior. A focused integration test derives the
branch ID from a fake app-server protocol response instead of injecting it.

## Failure Handling

The profile switch's existing transaction is terminal before source selection.
Closing the source picker means no fork was launched. If a fork starts and the
app-server result is missing or invalid, continuation rejects before any mapping
is persisted and the core rolls back any capacity reservation. A native branch
that exists but cannot be identified is deliberately left unmapped rather than
guessing from content or output.
