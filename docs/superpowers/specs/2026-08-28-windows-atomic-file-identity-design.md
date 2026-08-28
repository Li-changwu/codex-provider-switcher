# Windows Atomic File Identity Design

Status: approved architecture decision; awaiting review of this written specification

Issue: #16

## Purpose

The extension supports Windows volumes on which Node reports `ino === 0n`.
The previous fallback obtains a Windows File ID by running `fsutil`, but it
cannot bind that path-based observation to a later `unlink` or `rename`.
An attacker with local filesystem access can replace a file in the interval
between the final comparison and that path operation.

This design adds a Windows-only N-API helper that derives identity from the
same Windows handle used for the protected operation. It removes that final
file replacement interval for managed Profile storage. Linux keeps its current
portable `dev + ino` behavior and does not load a native helper.

This specification supersedes the "no external native module" exclusion in
`2026-08-28-windows-file-identity-fallback-design.md`. The earlier document's
requirements for fail-closed behavior, no symbolic links, no hard links, and
no Windows fallback on Linux remain in force.

## Scope

The first implementation changes the Windows zero-inode path in
`src/core/file-identity.ts` and the ProfileStore operations that manage:

- Profile lock files, stale-lock recovery guards, and recovery claims.
- Identity-checked temporary-file cleanup.
- The managed `config.toml` file while its corresponding `index.json` entry
  is published.

The helper is intentionally generic so the transaction lock protocol can use
the same primitive in a subsequent reviewed subtask. Its existing Linux
behavior is not changed by this work. It is not a mechanism for cross-device
sync, transcript persistence, user supplied arbitrary paths, or macOS/WSL
support.

## Security Model And Invariants

The managed Profile root is still checked by the existing TypeScript code:
paths must be beneath the expected Codex Home directory, all inspected
objects must be non-symbolic, and regular files must have exactly one link.
The native helper protects the final filesystem object selected by a managed
absolute path. It does not make the existing parent-directory validation a
general-purpose Windows sandbox.

For every Windows zero-inode mutation, the following invariants apply:

1. A native identity is a pair of the volume serial number and the complete
   16-byte `FILE_ID_INFO.FileId`, represented as canonical lowercase fixed
   width hexadecimal text. It is never inferred from timestamps, content, a
   Node inode, or a path cache.
2. The helper opens the final component with `FILE_FLAG_OPEN_REPARSE_POINT`
   and rejects `FileAttributeTagInfo` objects marked as reparse points. It
   reads `FileIdInfo` and `FileStandardInfo` from that handle, including the
   link count.
3. Identity is valid only when the captured native ID and link count equal the
   caller's expected values, and the link count is one. A mismatch performs no
   mutation and is reported as a normal failed comparison.
4. An unavailable addon, unsupported architecture, malformed native result,
   reparse point, sharing violation, or any other native error fails closed.
   TypeScript must not fall back to `fsutil` plus a path-based delete or
   publication on Windows.
5. After a failure, all opened Windows handles are closed. The external handle
   used for a publication hold is also finalized as a safety net, but callers
   release it in `finally` and must not rely on garbage collection.

If an attacker replaces a managed final file before the helper opens it, the
handle-derived ID mismatches and the operation does nothing. If replacement
happens after the helper opens it for deletion, deletion applies to that
already-opened original handle, never to the later replacement.

## Native Addon

The addon lives in `native/windows-file-ops/` and is compiled with the stable
Node-API C ABI, with `NAPI_VERSION=8`. The extension host supported by VS Code
1.98 contains Node 20 and supports that ABI; the addon must use no V8, NAN, or
Node-ABI-specific API. `node-gyp` is a development build tool only and the
addon has no runtime npm dependency.

The compiled module is named `windows_file_ops.node`. It is loaded through a
small TypeScript adapter only when both `process.platform === "win32"` and
`process.arch === "x64"`. The adapter resolves it from the installed extension
root rather than from the developer's working directory. On every other host
the adapter exposes an unavailable implementation that throws a typed,
fail-closed error when a Windows-only operation is requested.

The JavaScript surface is deliberately small:

```ts
type WindowsFileIdentity = Readonly<{
  volumeSerial: string;
  fileId: string;
  linkCount: bigint;
}>;

type DeleteResult = "deleted" | "identity-mismatch";

captureFileIdentity(path: string): WindowsFileIdentity;
deleteFileIfMatches(path: string, expected: WindowsFileIdentity): DeleteResult;
holdFileIfMatches(path: string, expected: WindowsFileIdentity): object;
releaseFileHold(hold: object): void;
```

`captureFileIdentity` opens the file only long enough to obtain its metadata.
`deleteFileIfMatches` opens the named file with `DELETE | FILE_READ_ATTRIBUTES`
and `FILE_SHARE_READ` only, gets and compares identity from that same handle,
then calls `SetFileInformationByHandle(FileDispositionInfo)` on the same
handle. The restricted share mode prevents new write, delete, rename, and
hard-link operations on the selected file while this comparison and deletion
are in progress; an already conflicting handle makes acquisition fail. It
returns `"identity-mismatch"` without deleting anything when the selected
object does not match.

`holdFileIfMatches` owns two verified handles. First it opens the config file
with `FILE_READ_ATTRIBUTES` and `FILE_SHARE_READ` only. Then it opens the
config's immediate parent directory with `FILE_LIST_DIRECTORY |
FILE_READ_ATTRIBUTES`, `FILE_SHARE_READ` only,
`FILE_FLAG_BACKUP_SEMANTICS`, and `FILE_FLAG_OPEN_REPARSE_POINT`; the parent
must be a non-reparse directory. Finally it reopens the final config path and
requires the expected File ID before returning the hold.

The file handle rejects direct write/delete opens and replacement-at-target
operations. Windows can nevertheless rename an open source file through its
parent directory, so the parent handle is required to reject child mutation
opens, including source rename, until `releaseFileHold` closes both handles.
If a conflicting file or parent-directory writer already exists, acquisition
fails. The returned opaque external owns the two handles; explicit release
closes each handle, retains a handle whose close fails for retry, and is
idempotent after both handles are closed.

The helper validates JavaScript arguments before use. It accepts only absolute
Windows paths without an embedded NUL, exact lowercase hexadecimal identity
fields, and link count `1n`. It creates typed errors with a stable addon error
code for unavailable, malformed-input, reparse-point, and I/O failures. A
comparison mismatch is a result value, not an exception.

## TypeScript Integration

`src/core/windows-file-operations.ts` is the only TypeScript module that
loads or calls the addon. It provides a narrow injectable interface so unit
tests can simulate the Windows boundary without a compiler or Windows host.
Production construction obtains the real adapter; tests pass a fake through
`ProfileStoreOptions`.

`file-identity.ts` retains `dev + ino` for nonzero inode observations. When a
Windows observation has `ino === 0`, it obtains and stores the native identity
from `captureFileIdentity`; it no longer invokes `fsutil`. For those Windows
objects, equality compares the native volume serial, complete file ID, and
link count. A mixed zero/nonzero pair is never equal.

ProfileStore receives the following changes:

- Every current identity-checked delete selects `deleteFileIfMatches` for a
  Windows zero-inode expected identity. Its `identity-mismatch` result becomes
  the existing persistence failure, leaving the replacement in place. Other
  platforms retain their present checked path operation.
- This applies to lock release, stale lock reclamation, recovery guard and
  claim cleanup, and temporary file cleanup. The old `read then unlink` and
  `read then unlinkStaleLock` implementations are not used on this path.
- Before publishing a Profile index whose entry references a new or updated
  config, ProfileStore calls `holdFileIfMatches` for the expected config
  identity. It holds the returned external across the index temporary-file
  rename and releases it in `finally` immediately after that rename finishes
  or fails.
- A failed hold or failed index publication preserves the existing durable
  recovery semantics: the config may remain as unindexed/update recovery
  state, but no index is published for a different config identity. The error
  remains a ProfileStore persistence or rollback error, so no partial success
  is reported to the UI.

The checked hold is acquired immediately before index publication, not merely
before writing the index temporary file. Therefore the configuration is bound
through the only point at which that index becomes visible. The index itself
continues to use the current atomic temporary-file rename protocol.

## Packaging And Build

The source tree contains the addon C++ source and `binding.gyp`; generated
build directories and `.node` artifacts are ignored by git. A Windows-only
build script compiles the addon before Windows tests and stages exactly
`windows_file_ops.node` in the extension package layout. The VSIX allowlist
and verifier are extended to require that file in `win32-x64` artifacts and to
reject it in `linux-x64` artifacts. Source files, headers, `node-gyp`, object
files, and build caches are never packaged.

GitHub Actions `windows-latest` builds the addon with its hosted C++ toolchain
before type checking, tests, and `package:win32-x64`. Ubuntu never invokes the
build script and verifies both the Linux behavior and the absence of an addon
load/package entry. Local Windows contributors need Visual Studio Build Tools
with the Desktop C++ workload; a missing toolchain is a clear failed build,
not a fallback to unsafe TypeScript operations.

## Test Plan

Unit tests cover the adapter contract and ProfileStore decisions using an
injected operation implementation:

- native identity canonicalization, unsupported-host failure, and malformed
  result rejection;
- a replacement with the same contents returns `identity-mismatch` and is not
  deleted;
- a different live lock owner remains intact when the old owner releases or a
  stale recovery attempts reclamation;
- index publication cannot begin without a valid config hold, and every hold
  is released on success, index rename failure, and cancellation/error paths.

Windows integration tests build and call the real addon. They verify that the
identity returned by a handle changes on replacement, final reparse points are
rejected, `deleteFileIfMatches` never removes a replacement, and a live config
hold rejects both replacement-at-target and source rename while preserving the
original path and bytes until release. Windows may surface a sharing violation
as `EPERM`, `EACCES`, or `EBUSY`; the test accepts those mappings but must prove
the filesystem state. ProfileStore integration tests inject a deterministic
replacement hook just before deletion and before index publication to prove the
operation fails closed.

The full Windows CI run executes native build, type checking, unit tests,
integration tests, and VSIX verification. The Ubuntu CI run executes the same
TypeScript suites under the Linux branch and verifies its VSIX does not contain
or load the Windows addon. Existing rollback, session sync, and activation
tests remain required in both environments.

## Non-Goals

This work does not silently repair or delete untrusted state, weaken one-link
or non-reparse requirements, add a macOS implementation, ship a universal
VSIX, or convert native continuation/session data into duplicate transcript
copies. It also does not claim to protect arbitrary user-selected filesystem
paths outside the extension's existing managed root validation.
