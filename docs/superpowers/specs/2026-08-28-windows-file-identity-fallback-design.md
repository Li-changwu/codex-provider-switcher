# Windows File Identity Fallback Design

Status: approved by the confirmed Windows-native support requirement

## Problem

PR #14 executes the unit suite on real Windows and Ubuntu runners for the first
time. The Ubuntu failure is a test-only defect: one activation fixture supplies
a Windows `CodexLayout` while the process is Linux. The Windows runner exposes
a runtime limitation: its temporary volume reports `ino === 0n` for regular
files and directories. Four storage layers currently reject every such object
before performing an operation.

The extension must support native Windows. Requiring a volume that exposes an
inode is therefore not an acceptable operational requirement. The change must
not accept symbolic links, hard links, missing identity data, or Windows paths
on Linux.

## Decision

Task 1 creates `src/core/file-identity.ts` as the single policy owner for
trusted filesystem identity. This phase does not change active Profile,
ProfileStore, stored-profile preflight, or transaction code. Task 2 will make
their current `dev + ino` checks delegate to this policy.

The policy has two modes:

1. On Linux, and whenever both objects have nonzero inode values, identity is
   exactly `dev + ino`; regular files also require exactly one link.
2. Only on `win32`, when both inode values are zero, identity requires a stable
   Windows File ID. The extension invokes the Windows built-in
   `SystemRoot\\System32\\fsutil.exe file queryFileID` through `execFile` with
   an argument vector, bounded timeout, and bounded output. The parsed
   hexadecimal File ID must be present for both objects and match along with
   device and link count. It never activates if either inode is nonzero, a File
   ID is missing or malformed, the command fails, or the platform is not
   Windows.

Callers retain their existing object-kind and link checks. In particular, a
fallback file must still be regular, non-symbolic, and have `nlink === 1n`.
Directory callers still re-check canonical `realpath` and parent containment.
Transaction byte versions continue to compare hashes, sizes, modes, and times
in addition to the identity helper.

## Security Boundary

The fallback is deliberately limited to Windows volumes that provide no inode.
`fsutil` returns the filesystem File ID, which this implementation verified is
stable across a hard link and rename but changes for a replacement file at the
same path. If Windows cannot expose the ID, the extension fails closed instead
of treating timestamps as identity.

Production command execution derives its root only from the Extension Host
process's `SystemRoot`. A `systemRoot` override is accepted only with an
explicit injected command runner for unit tests; it cannot redirect the real
`execFile` invocation. Both paths require a canonical, drive-absolute Windows
root and verify that the derived executable is exactly
`System32\\fsutil.exe` beneath it.

The path query cannot be tied to a Node FileHandle, so it does not eliminate
every race an active local attacker could create around all observations. The
extension preserves the existing defenses around it: no-link checks, canonical
path checks, repeated pre/post-operation verification, file handle checks,
content hashes for byte mutations, and atomic rename publication. Linux never
uses this fallback and retains strict handle-verifiable `dev + ino` identity.

## Test Strategy

`test/unit/file-identity.test.ts` exercises the policy without depending on
the host filesystem:

- Linux accepts only equal nonzero `dev + ino` identities.
- Windows accepts equal zero-inode identities only with equal parsed File ID
  and link count.
- A different device, File ID, link count, a mixed zero/nonzero inode pair, or
  missing File ID is rejected.

The unit tests inject the File-ID query function and check the system command's
argument vector, timeout and output parsing separately. A Windows integration
test exercises `fsutil` on a real temporary file and proves that a hard link
shares the ID while a replacement file does not.

Task 2 will update active Profile, ProfileStore, orchestrator, and transaction
tests to exercise the policy through real temporary files. After that wiring,
Windows CI must prove those layers operate on a zero-inode volume. Existing
symlink and hard-link tests remain unchanged and must continue passing. Task 3
will make the activation fixture choose the actual host platform and
corresponding path values, so Linux no longer constructs a Windows layout.

## Out of Scope

No external native module, PowerShell invocation, broad filesystem refactor,
or change to Linux identity policy is introduced. macOS and WSL remain outside
the supported first-release scope.
