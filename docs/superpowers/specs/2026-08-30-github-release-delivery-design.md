# GitHub Release Delivery Design

Status: approved for implementation under Issue #30.

## Goal

Ship the first installable release of Codex Provider Switcher as two verified,
platform-specific VSIX assets on GitHub Releases:

- `codex-provider-switcher-<version>@win32-x64.vsix`
- `codex-provider-switcher-<version>@linux-x64.vsix`

The release also contains `SHA256SUMS.txt` for manual integrity verification.

## Scope

This release path supports the same hosts as the extension: native Windows x64,
native glibc Linux x64, and VS Code Remote SSH when its Extension Host is Linux
x64. It does not publish to the VS Code Marketplace, support macOS or WSL, or
change Profile switching, credentials, sessions, or continuation behavior.

## Trigger and Version Contract

The workflow runs only for pushed `v*` tags. Its release job reads
`package.json` and requires the tag to be exactly `v${version}`. A mismatch
fails before artifact publication. This prevents a release title and package
payload from claiming different versions.

## Build and Verification Flow

Two native package jobs run in a matrix:

1. Windows runs `npm run package:win32-x64`.
2. Ubuntu runs `npm run package:linux-x64`.

Those commands remain the single packaging boundary. They already execute type
checking, extension bundling, the matching native binding preflight, production
dependency audit, and VSIX verification. Each job uploads only the single,
target-suffixed verified VSIX as a short-lived workflow artifact.

The release job runs only after both package jobs succeed. It downloads the two
artifacts, validates that their names are exactly the two names derived from the
manifest version, checks that both are regular non-empty files, and generates a
deterministic `SHA256SUMS.txt` with Node's SHA-256 implementation. It then uses
the GitHub CLI with the workflow token to create the GitHub Release and upload
exactly those three release assets.

## Permissions and Failure Behavior

The workflow default is `contents: read`. Package jobs inherit that permission.
Only the release job receives `contents: write`; its `GH_TOKEN` is scoped to the
GitHub CLI release command. Third-party checkout, setup-node, upload-artifact,
and download-artifact actions use immutable commit pins.

Any failed package, version mismatch, unexpected artifact, missing artifact,
checksum write failure, or release upload failure fails the workflow. The
release job is dependent on the complete package matrix, so it cannot create a
release when only one platform completed.

The workflow never receives provider API keys, OAuth credentials, Profile data,
or session contents. The normal VSIX packager continues to reject unsafe or
unverified runtime contents before an artifact is uploaded.

## User Documentation

The README documents manual installation from GitHub Releases, platform choice,
SHA-256 verification on Windows and Linux, installation into the correct VS
Code Remote SSH window, upgrade, and uninstall behavior. It preserves the
existing support boundaries and avoids config or credential examples.

## Tests

The release artifact helper has unit coverage for:

- exact tag-to-manifest version matching;
- both expected VSIX names;
- missing, unexpected, empty, directory, and symbolic-link artifacts;
- deterministic checksum content.

The workflow contract test reads the workflow source to assert tag-only
triggering, package matrix targets, pinned actions, least-privilege
permissions, and artifact validation before `gh release create`. Existing CI
then executes the normal Windows and Linux package commands. A real release is
validated by pushing a version tag after the release PR is merged.
