# VS Code Marketplace Delivery Design

**Status:** Approved on 2026-08-31

## Goal

Prepare Codex Provider Switcher for a controlled first publication to the VS Code Marketplace while retaining GitHub Releases as an independent distribution channel. Repository work ends when the listing, platform packages, documentation, tests, and manual publishing workflow are ready. The Publisher account and PAT remain user-owned setup steps; no credential is committed, logged, or pasted into chat.

## Scope

The Marketplace extension identity is `Li-changwu.codex-provider-switcher`. The first Marketplace publication may reuse version `0.1.0` because that version has not been published to the Marketplace. The Marketplace receives two target-specific packages under the same extension version:

- `win32-x64` for native Windows x64 Extension Hosts.
- `linux-x64` for glibc Linux x64 Extension Hosts, including Remote SSH Linux.

GitHub Releases remain supported. macOS, WSL, musl Linux, non-x64 hosts, cloud synchronization, and the VS Code Open VSX registry remain outside this release.

## Marketplace Listing

The manifest will add a concise description, `Other` category, focused discovery keywords, repository homepage, issue tracker, and a 128x128 PNG icon. The README will describe Marketplace installation first while preserving verified GitHub Release installation, checksum, upgrade, uninstall, Remote SSH, and unsupported-host guidance. A `CHANGELOG.md` will describe `0.1.0` without adding claims not supported by the implementation.

The selected icon is the approved second-round **Signal Switch** direction: a charcoal tile, white Lucide `repeat-2` glyph, lime source signal, and coral destination signal. The design does not reproduce the OpenAI knot, VS Code product logo, or other trademarked brand marks and does not imply official affiliation. A checked-in SVG source includes the Lucide ISC attribution, and a deterministic generator produces the Marketplace-required PNG.

## Toolchain Maintenance

The development toolchain will move to versions with patched dependency trees:

- `@vscode/vsce` `^3.9.2`
- `esbuild` `^0.28.2`
- `sharp` `^0.35.4` as the development-only SVG-to-PNG renderer

All workflows will use immutable commits whose action runtimes are Node 24:

- `actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803` (`v6.1.0`)
- `actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38` (`v6.5.0`)
- `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` (`v7.0.1`)
- `actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` (`v8.0.1`)

The local process-level `NODE_TLS_REJECT_UNAUTHORIZED=0` setting is not stored in the repository and is not propagated to GitHub Actions. Publishing documentation explicitly requires a normal TLS-valid environment and tells local PowerShell users how to clear that process variable before any local Marketplace command.

## Publishing Workflow

`.github/workflows/marketplace.yml` is manual-only through `workflow_dispatch` and requires a `tag` input. It has default `contents: read` permission and a concurrency key scoped to the requested tag.

The package job checks out the exact input tag on native Windows and Ubuntu runners, installs locked dependencies, builds the corresponding target package, runs the existing package verifier, and uploads one VSIX per target. No Marketplace credential is available to package jobs.

The publish job:

1. Depends on both native package jobs.
2. Runs in the protected GitHub Environment named `marketplace`.
3. Downloads both artifacts into a clean directory.
4. Runs `scripts/release-artifacts.mjs` with the requested tag, which enforces exact `v<package.version>` matching, exact filenames, regular non-empty files, and SHA-256 generation.
5. Exposes `secrets.VSCE_PAT` only as the `VSCE_PAT` environment variable for the publish step.
6. Runs the repository-pinned `vsce` binary with both explicit package paths and `--skip-duplicate`.

The workflow never writes repository contents, creates tags, creates GitHub Releases, or prints the PAT. A missing environment approval, missing secret, invalid tag, package mismatch, audit failure, packaging failure, or Marketplace rejection stops the workflow.

## Publisher And PAT Setup

The user guide will provide one step at a time for:

1. Signing in at `https://marketplace.visualstudio.com/manage`.
2. Creating Publisher ID `Li-changwu` and recording its display name and contact address.
3. Creating a short-lived Azure DevOps PAT with only `Marketplace: Manage` scope and all accessible organizations as required by the Marketplace publisher API.
4. Creating the GitHub Environment `marketplace`, optionally adding a required reviewer, and storing the token as Environment Secret `VSCE_PAT`.
5. Manually running `Marketplace Publish` for `v0.1.0`.
6. Verifying both target variants and the public listing, then rotating or revoking the PAT when appropriate.

The guide never contains a real token, credential-shaped example, or instruction to paste a token into chat.

## Package Verification

The VSIX verifier will require the icon and changelog in addition to existing manifest, README, license, runtime bundle, and native dependency checks. The SVG source, icon generator, tests, workflows, and development documents remain excluded from VSIX packages.

Contract tests will verify:

- Marketplace manifest fields and permanent extension identity.
- Deterministic 128x128 PNG generation from the approved SVG source.
- Exact packaged icon and changelog paths.
- Node 24 action pins across every workflow.
- Manual-only Marketplace triggering and exact tag checkout.
- Native two-target package matrix.
- Least-privilege permissions and `marketplace` environment protection.
- PAT isolation to the publish step.
- Artifact validation before the local `vsce` binary publishes both target paths.
- README and publisher guide coverage without credential examples.

## Acceptance Criteria

The preparation is complete when:

- `npm audit` reports zero known development and production vulnerabilities.
- Type checking, unit tests, and integration tests pass.
- Windows and Linux packages pass their native verifiers.
- The checked-in PNG is deterministic and exactly 128x128.
- Windows and Ubuntu CI pass with no Node 20 action-runtime annotation.
- The Marketplace workflow is present, manual-only, and ready to wait for the user-owned `marketplace` Environment and `VSCE_PAT` secret.
- No actual Marketplace publication is attempted before the user completes Publisher and PAT setup.
