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

Create `src/core/file-identity.ts` as the single policy owner for trusted
filesystem identity. Every current `dev + ino` check in active Profile,
ProfileStore, stored-profile preflight, and transaction code delegates to it.

The policy has two modes:

1. On Linux, and whenever both objects have nonzero inode values, identity is
   exactly `dev + ino`; regular files also require exactly one link.
2. Only on `win32`, when both inode values are zero, identity may fall back to
   `dev + birthtimeNs`. The fallback requires a nonzero, matching birth time
   and matching link count. It never activates if either inode is nonzero, a
   birth time is missing or zero, or the platform is not Windows.

Callers retain their existing object-kind and link checks. In particular, a
fallback file must still be regular, non-symbolic, and have `nlink === 1n`.
Directory callers still re-check canonical `realpath` and parent containment.
Transaction byte versions continue to compare hashes, sizes, modes, and times
in addition to the identity helper.

## Security Boundary

The fallback is deliberately limited to Windows volumes that provide no inode.
It distinguishes ordinary replacement by the stable creation time and device
while retaining the existing symlink and hard-link rejection. If a volume also
cannot supply a stable nonzero creation time, the extension fails closed.

This is weaker than an inode-bearing filesystem against a hostile local actor
able to reproduce creation-time metadata. Node exposes no portable Windows file
handle identifier for such a volume. The extension preserves every stronger
guard available through Node: no-link checks, canonical-path checks, repeated
pre/post-operation verification, file handle checks, content hashes for byte
mutations, and atomic rename publication. Linux never uses this fallback.

## Test Strategy

`test/unit/file-identity.test.ts` exercises the policy without depending on
the host filesystem:

- Linux accepts only equal nonzero `dev + ino` identities.
- Windows accepts equal zero-inode identities only with equal nonzero
  `birthtimeNs` and link count.
- A different device, birth time, link count, a mixed zero/nonzero inode pair,
  or missing creation time is rejected.

Existing active Profile, ProfileStore, orchestrator, and transaction tests run
against real temporary files. Windows CI proves that those layers operate on a
zero-inode volume. Existing symlink and hard-link tests remain unchanged and
must continue passing. The activation fixture chooses the actual host platform
and corresponding path values, so Linux no longer constructs a Windows layout.

## Out of Scope

No external native module, PowerShell invocation, broad filesystem refactor,
or change to Linux identity policy is introduced. macOS and WSL remain outside
the supported first-release scope.
