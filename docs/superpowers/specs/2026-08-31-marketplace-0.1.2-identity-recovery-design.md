# Marketplace 0.1.2 Identity Recovery Design

**Status:** Approved on 2026-08-31

## Context

The protected Marketplace workflow for `v0.1.1` successfully authenticated,
built, downloaded, and validated both native packages before `vsce publish`
reported:

```text
The extension 'codex-provider-switcher' already exists in the Marketplace.
Please use a different 'name' in the package.json file
```

Marketplace extension names are globally unique across Publishers. The name
`codex-provider-switcher` is already owned by Publisher `e50max`, so Publisher
`Li-changwu` cannot create `Li-changwu.codex-provider-switcher`. No partial
Marketplace publication occurred. The Publisher, least-privilege PAT, GitHub
Environment, native packages, validation step, and credential isolation all
worked as designed.

The approved recovery is to change only the package and Marketplace identity
to `codex-provider-switcher-vscode`. The permanent Marketplace identifier will
be `Li-changwu.codex-provider-switcher-vscode`; the user-facing display name
remains `Codex Provider Switcher`.

## Goal

Publish immutable version `0.1.2` for both supported native targets under
`Li-changwu.codex-provider-switcher-vscode`, without rewriting the existing
`v0.1.1` tag or changing runtime behavior.

## Scope

This recovery will:

- set `package.json.name` and the root lockfile package name to
  `codex-provider-switcher-vscode`;
- bump the extension and root lockfile version to `0.1.2`;
- update exact package, upload, and publish paths to the new package name and
  version;
- update the Marketplace ID and manual VSIX filenames in current user and
  owner documentation;
- add a `0.1.2` changelog entry explaining the identity correction;
- deliver the change through a reviewed pull request and new immutable tag;
- verify both GitHub Release artifacts before Marketplace publication; and
- revoke the temporary Marketplace PAT after the public listing is verified.

This recovery will not change the repository name or URLs, Publisher,
`displayName`, command IDs, SecretStorage namespace, runtime behavior,
supported platforms, existing release tags, or historical design records.
Generic test fixtures that intentionally use earlier names or versions remain
unchanged unless they are contracts for the live release identity.

## Identity And Artifact Contract

The release identity is:

- package name: `codex-provider-switcher-vscode`;
- display name: `Codex Provider Switcher`;
- Publisher: `Li-changwu`;
- Marketplace ID: `Li-changwu.codex-provider-switcher-vscode`;
- release version and tag: `0.1.2` and `v0.1.2`.

The exact native artifacts are:

- `codex-provider-switcher-vscode-0.1.2@win32-x64.vsix`;
- `codex-provider-switcher-vscode-0.1.2@linux-x64.vsix`.

`package.json` remains authoritative for package name and version. The root
entries in `package-lock.json`, current Marketplace workflow paths, package
workflow path, README, changelog, and owner guide must agree with it. The
Release workflow may retain its existing generic pattern because it accepts
the new filenames while continuing to validate artifacts against the tagged
manifest.

## Workflow And Security Contract

Marketplace publication remains manual, tag-scoped, read-only, and protected
by the GitHub Environment named `marketplace`. Native package jobs never
receive Marketplace credentials. The publish job downloads both packages,
validates their names, versions, target metadata, and content before invoking
the repository-pinned `vsce` binary with two explicit package paths.

The Environment Secret remains named `VSCE_PAT`; no token value is written to
source, documentation, commands, logs, issues, pull requests, or chat. The
temporary Azure DevOps PAT retains only `Marketplace: Manage` scope until the
listing is verified, then is revoked server-side.

## Implementation And Test Strategy

Implementation follows test-driven development. Release-facing tests first
require the new package name, Marketplace ID, version, exact workflow paths,
README filenames, changelog entry, and owner-guide tag. The focused tests must
fail against the `0.1.1` tree for those expected reasons before production
metadata and documentation are updated.

Local verification includes the native Windows helper build, dependency audit,
type checking, all unit and integration tests, production build, deterministic
icon check, Windows x64 package creation and VSIX verification, repository
hygiene, and credential-pattern review. Ubuntu CI is authoritative for the
Linux x64 native package because cross-host native packaging is rejected by
design.

## Delivery Sequence

1. Commit this approved design and its implementation plan on the isolated
   `release/marketplace-0.1.2` branch.
2. Add and observe failing release-identity contracts.
3. Apply the minimal identity, version, workflow, changelog, and documentation
   changes until focused and complete local verification pass.
4. Push the branch, open a pull request, and require Windows and Ubuntu checks
   to pass before merge.
5. Create `v0.1.2` at the merged commit and verify both public GitHub Release
   VSIX files and `SHA256SUMS.txt`.
6. Dispatch `Marketplace Publish` with `tag=v0.1.2` and verify the public item
   and both target variants.
7. Revoke PAT `codex-provider-switcher-v0.1.0-publish` and record final
   publication evidence without credential material.

## Failure Handling

No tag is created before merge and green CI. A public tag is never moved or
rewritten. If a repository defect is found after `v0.1.2` becomes observable,
it is corrected through a reviewed newer patch release. If publication fails
before either target is accepted, diagnose and rerun the same immutable tag.
If one target is already accepted, `--skip-duplicate` permits an idempotent
retry for the remaining target. The PAT stays active only while it is required
to complete and verify this publication.

## Acceptance Criteria

The release is complete when:

- `main` contains the reviewed permanent identity and aligned `0.1.2` release
  metadata;
- local verification and Windows and Ubuntu CI pass;
- immutable tag and GitHub Release `v0.1.2` expose both verified VSIX files and
  checksums;
- the public Marketplace item is
  `Li-changwu.codex-provider-switcher-vscode` at version `0.1.2` with
  `win32-x64` and `linux-x64` variants;
- no credential appears in repository content, artifacts, logs, or chat; and
- the temporary Marketplace PAT is revoked after verification.
