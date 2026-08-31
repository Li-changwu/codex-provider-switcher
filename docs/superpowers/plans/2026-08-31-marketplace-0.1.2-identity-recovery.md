# Marketplace 0.1.2 Identity Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish immutable version `0.1.2` under the available Marketplace identity `Li-changwu.codex-provider-switcher-vscode` for Windows x64 and Linux x64.

**Architecture:** Keep runtime and repository identity unchanged while treating `package.json` as the authority for the new package name and version. Enforce alignment across the lockfile, both delivery workflows, current documentation, and exact VSIX paths with release-facing contract tests; then deliver through PR, immutable tag, verified GitHub Release, protected Marketplace publication, and PAT revocation.

**Tech Stack:** TypeScript, Node.js test runner through `tsx`, npm package metadata, GitHub Actions, VSIX, `@vscode/vsce`, GitHub CLI, Azure DevOps Marketplace PAT.

---

### Task 1: Commit the approved recovery design and plan

**Files:**
- Create: `docs/superpowers/specs/2026-08-31-marketplace-0.1.2-identity-recovery-design.md`
- Create: `docs/superpowers/plans/2026-08-31-marketplace-0.1.2-identity-recovery.md`

- [ ] **Step 1: Review the design against the approved identity**

Run:

```powershell
rg -n "codex-provider-switcher-vscode|Li-changwu\.codex-provider-switcher-vscode|0\.1\.2|v0\.1\.2" docs/superpowers/specs/2026-08-31-marketplace-0.1.2-identity-recovery-design.md docs/superpowers/plans/2026-08-31-marketplace-0.1.2-identity-recovery.md
```

Expected: both documents identify the new package, permanent Marketplace ID,
and immutable patch release; neither proposes runtime or repository renaming.

- [ ] **Step 2: Check document formatting**

Run:

```powershell
git diff --check
```

Expected: exit code zero and no whitespace diagnostics.

- [ ] **Step 3: Commit the approved documents**

```powershell
git add -- docs/superpowers/specs/2026-08-31-marketplace-0.1.2-identity-recovery-design.md docs/superpowers/plans/2026-08-31-marketplace-0.1.2-identity-recovery.md
git commit -m "docs: approve Marketplace 0.1.2 identity recovery"
```

### Task 2: Add failing identity and release contracts

**Files:**
- Modify: `test/unit/extension-manifest.test.ts`
- Modify: `test/unit/marketplace-workflow.test.ts`
- Modify: `test/unit/package-contract.test.ts`

- [ ] **Step 1: Require the permanent manifest identity**

Extend the manifest type with `displayName` and `version`, then require:

```ts
assert.equal(manifest.name, "codex-provider-switcher-vscode");
assert.equal(manifest.displayName, "Codex Provider Switcher");
assert.equal(manifest.version, "0.1.2");
assert.equal(manifest.publisher, "Li-changwu");
```

- [ ] **Step 2: Require aligned Marketplace release metadata and paths**

In `test/unit/marketplace-workflow.test.ts`, update the release contract to
assert package and root lockfile names are `codex-provider-switcher-vscode`,
all release versions are `0.1.2`, the changelog contains `## 0.1.2`, and the
guide contains both `v0.1.2` and the permanent Marketplace ID. Require these
exact workflow paths:

```text
codex-provider-switcher-vscode-0.1.2@${{ matrix.target }}.vsix
marketplace-assets/codex-provider-switcher-vscode-0.1.2@win32-x64.vsix
marketplace-assets/codex-provider-switcher-vscode-0.1.2@linux-x64.vsix
```

Require README installation and manual artifact examples to use
`Li-changwu.codex-provider-switcher-vscode` and
`codex-provider-switcher-vscode-<version>@<target>.vsix`.

- [ ] **Step 3: Require the package workflow's exact current path**

Add an assertion in `test/unit/package-contract.test.ts`:

```ts
assert.match(
  workflow,
  /path: codex-provider-switcher-vscode-0\.1\.2@\*\.vsix/,
);
```

- [ ] **Step 4: Run focused tests and verify RED**

Run:

```powershell
npx tsx --test test/unit/extension-manifest.test.ts test/unit/marketplace-workflow.test.ts test/unit/package-contract.test.ts
```

Expected: assertions fail because the production tree still uses package name
`codex-provider-switcher`, version `0.1.1`, old Marketplace ID, and stale
workflow paths. There must be no syntax or test-loader error.

- [ ] **Step 5: Commit the failing contracts**

```powershell
git add -- test/unit/extension-manifest.test.ts test/unit/marketplace-workflow.test.ts test/unit/package-contract.test.ts
git commit -m "test: require Marketplace 0.1.2 identity"
```

### Task 3: Align package metadata and delivery workflows

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/marketplace.yml`
- Modify: `.github/workflows/package.yml`

- [ ] **Step 1: Update package name and version without creating a tag**

Edit the manifest and only the root package metadata in the lockfile so they
contain:

```json
"name": "codex-provider-switcher-vscode",
"version": "0.1.2"
```

Preserve all dependency package names and versions.

- [ ] **Step 2: Update exact Marketplace paths**

Set the upload path to:

```yaml
path: codex-provider-switcher-vscode-0.1.2@${{ matrix.target }}.vsix
```

Set the publish command to:

```yaml
./node_modules/.bin/vsce publish --packagePath marketplace-assets/codex-provider-switcher-vscode-0.1.2@win32-x64.vsix marketplace-assets/codex-provider-switcher-vscode-0.1.2@linux-x64.vsix --skip-duplicate
```

Preserve the manual trigger, read-only permission, tag checkout, protected
Environment, validation ordering, and single secret reference.

- [ ] **Step 3: Repair the package workflow path**

Set `.github/workflows/package.yml` to upload:

```yaml
path: codex-provider-switcher-vscode-0.1.2@*.vsix
```

- [ ] **Step 4: Run metadata and workflow tests**

Run:

```powershell
npx tsx --test test/unit/extension-manifest.test.ts test/unit/marketplace-workflow.test.ts test/unit/package-contract.test.ts
```

Expected: identity and workflow assertions pass; documentation assertions
remain red until Task 4.

### Task 4: Align current release documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/marketplace-publishing.md`

- [ ] **Step 1: Update the public install identity and manual filenames**

Use `Li-changwu.codex-provider-switcher-vscode` in the Marketplace URL and CLI
command. Use `codex-provider-switcher-vscode-<version>@win32-x64.vsix` and
`codex-provider-switcher-vscode-<version>@linux-x64.vsix` in download and
checksum examples. Preserve the repository URLs and display name.

- [ ] **Step 2: Add the 0.1.2 changelog entry**

Insert before `0.1.1`:

```markdown
## 0.1.2

- Publish under the permanent Marketplace identity
  `Li-changwu.codex-provider-switcher-vscode` after the original package name
  was found to be globally unavailable.
- Preserve the runtime behavior and supported Windows x64, Linux x64, and
  Remote SSH Extension Host boundaries from 0.1.1.
```

- [ ] **Step 3: Update the owner publishing guide**

Set the permanent Marketplace identity to
`Li-changwu.codex-provider-switcher-vscode`, the actionable version to
`0.1.2`, and the workflow input to `v0.1.2`. Add a concise note that package
names are global across Publishers and the old identity was never published by
this Publisher. Preserve the least-privilege PAT and protected Environment
instructions.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
npx tsx --test test/unit/extension-manifest.test.ts test/unit/marketplace-workflow.test.ts test/unit/package-contract.test.ts
```

Expected: all focused release identity, workflow, and documentation tests pass.

- [ ] **Step 5: Inspect identity scope**

Run:

```powershell
rg -n --glob '!node_modules/**' --glob '!native/windows-file-ops/build/**' "Li-changwu\.codex-provider-switcher|codex-provider-switcher-0\.1\.[012]|codex-provider-switcher-vscode|v0\.1\.[012]" .
```

Expected: live release files use the new identity. Repository URLs, historical
design records, changelog history, and generic fixtures may retain old strings.

- [ ] **Step 6: Commit the minimal implementation**

```powershell
git add -- package.json package-lock.json .github/workflows/marketplace.yml .github/workflows/package.yml README.md CHANGELOG.md docs/marketplace-publishing.md
git commit -m "chore: prepare Marketplace release 0.1.2"
```

### Task 5: Run complete local release verification

**Files:**
- Verify: all files changed from `origin/main`

- [ ] **Step 1: Build the Windows native helper**

Run `npm run build:windows-file-ops` and require `node-gyp` exit code zero.

- [ ] **Step 2: Run static, dependency, test, and build gates**

Run each command with normal TLS validation and require exit code zero:

```powershell
Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED -ErrorAction SilentlyContinue
npm audit
npm run check
npm test
npm run test:integration
npm run build
```

Expected: zero vulnerabilities, type errors, test failures, or build failures.

- [ ] **Step 3: Verify deterministic icon generation**

Record the SHA-256 of `media/icon.png`, run `npm run generate:icon`, and record
the hash again. Expected: identical hashes and a clean worktree for the icon.

- [ ] **Step 4: Build and verify the Windows release package**

Run:

```powershell
npm run package:win32-x64
npm run verify:package -- codex-provider-switcher-vscode-0.1.2@win32-x64.vsix win32-x64
```

Expected: both commands exit zero and the non-empty VSIX has the new identity.
Ubuntu CI remains authoritative for Linux x64 native packaging.

- [ ] **Step 5: Verify repository hygiene and credential isolation**

Run:

```powershell
git diff origin/main...HEAD --check
git status --short
git diff --stat origin/main...HEAD
rg -n "VSCE_PAT|Marketplace: Manage|NODE_TLS_REJECT_UNAUTHORIZED" README.md docs .github
```

Expected: only intended files are tracked, generated files remain ignored,
and no PAT value or credential-shaped example appears.

### Task 6: Review, integrate, and create immutable v0.1.2

**Files:**
- External state: pull request from `release/marketplace-0.1.2`
- External state: Git tag and GitHub Release `v0.1.2`

- [ ] **Step 1: Review and push the complete branch**

Run `git diff origin/main...HEAD`, push the branch, and open a PR that states
the global name conflict, permanent new identity, unchanged runtime behavior,
local verification, and credential isolation.

- [ ] **Step 2: Require CI before merge**

Run `gh pr checks release/marketplace-0.1.2 --watch` and require Windows and
Ubuntu jobs, including native packaging, to succeed. Merge only after all
required checks are green, then fetch and verify the merge commit on
`origin/main`.

- [ ] **Step 3: Create the immutable tag**

First require `git ls-remote --tags origin refs/tags/v0.1.2` to return no tag.
Create annotated tag `v0.1.2` at the verified merged commit and push it once.

- [ ] **Step 4: Verify the GitHub Release**

Watch the tag-triggered Release workflow to success. Verify the public release
contains non-empty `win32-x64` and `linux-x64` VSIX files with the exact new
names plus `SHA256SUMS.txt`; download and verify both checksums.

### Task 7: Publish, verify, and revoke the temporary PAT

**Files:**
- External state: GitHub Actions workflow `Marketplace Publish`
- External state: Marketplace item `Li-changwu.codex-provider-switcher-vscode`
- External state: Azure DevOps PAT

- [ ] **Step 1: Dispatch protected publication**

Run:

```powershell
gh workflow run marketplace.yml --ref main -f tag=v0.1.2
```

Watch the exact new workflow run to completion and require both native package
jobs, artifact validation, and `vsce publish` to succeed.

- [ ] **Step 2: Verify the public listing**

Verify the public item URL, Publisher, display name, version `0.1.2`, repository
link, icon, README, changelog, and both `win32-x64` and `linux-x64` target
variants. Do not infer publication solely from workflow success.

- [ ] **Step 3: Revoke the temporary PAT**

After public verification, revoke Azure DevOps PAT
`codex-provider-switcher-v0.1.0-publish`. Confirm it is inactive without
exposing its value. Leave the GitHub Environment in place; future publication
requires replacing its stale secret with a new least-privilege token.

- [ ] **Step 4: Record final evidence**

Report the PR and merge commit, immutable tag, GitHub Release URL and verified
asset checksums, Marketplace URL and both targets, workflow run IDs, and PAT
revocation status. Never include token material.
