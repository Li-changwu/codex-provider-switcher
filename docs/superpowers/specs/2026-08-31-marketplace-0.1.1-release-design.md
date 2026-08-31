# Marketplace 0.1.1 Release Repair Design

**Status:** Proposed on 2026-08-31

## Context

The Marketplace delivery implementation is present on `main`, and Publisher
`Li-changwu`, GitHub Environment `marketplace`, and Environment Secret
`VSCE_PAT` are configured. However, the public, immutable `v0.1.0` tag points
to commit `eb812ef5`, which predates the Marketplace workflow, listing assets,
documentation, and release-readiness tests now on `main` at `314cf1e`.

Publishing from `v0.1.0` would therefore build the old tagged tree. Rewriting
that public tag or replacing its existing GitHub Release assets would break the
meaning of an immutable release. The first Marketplace publication will use a
new patch version, `0.1.1`, built from a reviewed commit containing the current
Marketplace-ready tree and the release repair described here.

## Goal

Publish `Li-changwu.codex-provider-switcher` version `0.1.1` to the VS Code
Marketplace for both supported targets, while preserving the existing
`v0.1.0` tag and GitHub Release unchanged. The same `v0.1.1` commit will be the
source of the GitHub Release and Marketplace packages.

## Scope

This repair will:

- bump the extension version in `package.json` and the root package metadata in
  `package-lock.json` from `0.1.0` to `0.1.1`;
- add a `0.1.1` changelog entry describing the release-delivery correction
  without claiming new product behavior;
- update exact Marketplace VSIX paths and their contract tests to `0.1.1`;
- update the owner publishing guide to dispatch `v0.1.1`;
- deliver the change through a pull request before creating the immutable tag;
- verify the native GitHub Release assets before manually publishing them to
  the Marketplace; and
- revoke the temporary Marketplace PAT after both listings are verified.

This repair will not rewrite `v0.1.0`, alter its release assets, change runtime
provider-switching behavior, broaden platform support, or expose the PAT to
package jobs, repository contents, logs, or chat.

Historical design and plan documents that accurately record the earlier
`v0.1.0` proposal remain unchanged. Tests that use `0.1.0` only as an isolated
fixture for generic filename or artifact-validation behavior also remain
unchanged. Only release-facing expectations tied to the next real publication
move to `0.1.1`.

## Version And Workflow Contract

`package.json` is the authoritative release version. `package-lock.json` must
carry the same root package version. Marketplace packaging must upload these
exact files:

- `codex-provider-switcher-0.1.1@win32-x64.vsix`
- `codex-provider-switcher-0.1.1@linux-x64.vsix`

The protected publish job must pass those same two explicit paths to the
repository-pinned `vsce` binary. Before publication,
`scripts/release-artifacts.mjs` must validate that the workflow input is
exactly `v0.1.1`, that both expected files are regular and non-empty, and that
their names match the package version. Existing credential isolation,
read-only permissions, native runner matrix, protected Environment, and
`--skip-duplicate` behavior remain unchanged.

The workflow stays manual-only. Creating or pushing `v0.1.1` triggers the
independent GitHub Release workflow, but it does not automatically publish to
the Marketplace.

## Implementation And Test Strategy

The implementation will follow test-driven development. Release-facing tests
will first require version `0.1.1`, exact `0.1.1` Marketplace paths, the new
changelog entry, and `v0.1.1` publishing instructions. The manifest, lockfile,
workflow, changelog, and guide will then be updated until those tests pass.

Local verification will include dependency audit, type checking, unit tests,
integration tests, production build, deterministic icon generation, Windows
x64 packaging and VSIX verification, and `git diff --check`. The Windows native
addon must be built before local tests on Windows. Linux x64 packaging remains
the responsibility of the Ubuntu CI runner because the packaging script
intentionally rejects cross-host native packaging.

## Delivery Sequence

1. Commit the implementation on branch `release/marketplace-0.1.1` in its
   isolated worktree.
2. Push the branch and open a pull request against `main`.
3. Require Windows and Ubuntu CI to pass, then merge the reviewed pull request.
4. Create and push annotated tag `v0.1.1` at the merged `main` commit.
5. Wait for the Release workflow and verify the public GitHub Release contains
   both target-specific VSIX files and `SHA256SUMS.txt`.
6. Manually dispatch `Marketplace Publish` with input `v0.1.1`.
7. Verify the Marketplace page identifies publisher `Li-changwu`, version
   `0.1.1`, and both `win32-x64` and `linux-x64` target variants.
8. Revoke the temporary Azure DevOps PAT named
   `codex-provider-switcher-v0.1.0-publish`, then confirm future publishing is
   intentionally disabled until a replacement token is stored.

## Failure Handling

No tag is created until the pull request has merged and CI is green. If the
GitHub Release workflow fails, fix the repository through another reviewed
commit and create a newer patch version rather than moving a public tag after
users can observe it. If Marketplace publication fails before either target is
accepted, diagnose and retry the manual workflow with the same immutable tag.
If only one target is accepted, `--skip-duplicate` permits a retry without
republishing the accepted target. The PAT remains active only while diagnosing
or completing this publication and is revoked immediately after verification.

## Acceptance Criteria

The release is complete when:

- `main` contains matching `0.1.1` package metadata and reviewed release-facing
  documentation and workflow contracts;
- all local verification and native CI checks pass;
- immutable tag `v0.1.1` points to the verified merged commit;
- the GitHub Release exposes both verified VSIX files and checksums;
- the VS Code Marketplace exposes version `0.1.1` for Windows x64 and Linux
  x64 under `Li-changwu.codex-provider-switcher`;
- no credential appears in source, artifacts, logs, or chat; and
- the temporary Marketplace PAT is revoked after successful verification.
