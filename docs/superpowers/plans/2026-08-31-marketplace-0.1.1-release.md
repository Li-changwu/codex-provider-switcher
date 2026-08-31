# Marketplace 0.1.1 Release Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the Marketplace-ready repository tree as immutable version `0.1.1` on GitHub Releases and the VS Code Marketplace without changing the existing `v0.1.0` release.

**Architecture:** Treat `package.json` as the release-version authority and keep the root lockfile metadata, exact Marketplace artifact paths, changelog, and owner guide aligned through one release contract test. Preserve the existing native two-runner packaging and credential-isolated manual publish architecture; deliver the repair through a reviewed PR, tag the merged commit, verify GitHub Release assets, then manually publish and revoke the temporary PAT.

**Tech Stack:** TypeScript, Node.js test runner through `tsx`, npm package metadata, GitHub Actions, VSIX, `@vscode/vsce`, GitHub CLI, Azure DevOps Marketplace PAT.

---

### Task 1: Add the 0.1.1 release contract

**Files:**
- Modify: `test/unit/marketplace-workflow.test.ts`

- [ ] **Step 1: Add release metadata paths and a failing contract test**

Add these constants beside the existing paths:

```ts
const packagePath = resolve(projectRoot, "package.json");
const packageLockPath = resolve(projectRoot, "package-lock.json");
const changelogPath = resolve(projectRoot, "CHANGELOG.md");
```

Add this test before the existing workflow tests:

```ts
test("Marketplace release metadata is aligned on version 0.1.1", async () => {
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    version?: unknown;
  };
  const lockfile = JSON.parse(await readFile(packageLockPath, "utf8")) as {
    version?: unknown;
    packages?: Record<string, { version?: unknown }>;
  };
  const changelog = await readFile(changelogPath, "utf8");
  const guide = await readFile(publishingGuidePath, "utf8");

  assert.equal(manifest.version, "0.1.1");
  assert.equal(lockfile.version, "0.1.1");
  assert.equal(lockfile.packages?.[""]?.version, "0.1.1");
  assert.match(changelog, /^## 0\.1\.1$/m);
  assert.match(guide, /`v0\.1\.1`/);
});
```

Change the package-job artifact assertion to require:

```ts
assert.match(packageJob, /path: codex-provider-switcher-0\.1\.1@\$\{\{ matrix\.target \}\}\.vsix/);
```

Change `publishCommand` to:

```ts
const publishCommand =
  "./node_modules/.bin/vsce publish --packagePath marketplace-assets/codex-provider-switcher-0.1.1@win32-x64.vsix marketplace-assets/codex-provider-switcher-0.1.1@linux-x64.vsix --skip-duplicate";
```

Change the owner-guide tag assertion to:

```ts
assert.match(guide, /`v0\.1\.1`/);
```

- [ ] **Step 2: Run the focused contract and verify RED**

Run:

```powershell
npx tsx --test test/unit/marketplace-workflow.test.ts
```

Expected: fail because the package metadata, Marketplace workflow paths,
changelog, and guide still identify `0.1.0`.

- [ ] **Step 3: Commit the failing release contract**

```powershell
git add -- test/unit/marketplace-workflow.test.ts
git commit -m "test: require Marketplace 0.1.1 release metadata"
```

### Task 2: Align the 0.1.1 release metadata

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/marketplace.yml`
- Modify: `CHANGELOG.md`
- Modify: `docs/marketplace-publishing.md`

- [ ] **Step 1: Update package and lockfile root versions**

Run:

```powershell
npm version 0.1.1 --no-git-tag-version
```

Expected: `package.json`, top-level `package-lock.json.version`, and
`package-lock.json.packages[""].version` become `0.1.1`; no Git tag or commit
is created.

- [ ] **Step 2: Update the Marketplace package and publish paths**

In `.github/workflows/marketplace.yml`, use these exact paths:

```yaml
          path: codex-provider-switcher-0.1.1@${{ matrix.target }}.vsix
```

```yaml
      - run: ./node_modules/.bin/vsce publish --packagePath marketplace-assets/codex-provider-switcher-0.1.1@win32-x64.vsix marketplace-assets/codex-provider-switcher-0.1.1@linux-x64.vsix --skip-duplicate
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}
```

Do not alter the manual trigger, exact tag checkout, permissions,
`marketplace` Environment, package matrix, validation step, or secret scope.

- [ ] **Step 3: Add the release changelog entry**

Insert above `0.1.0` in `CHANGELOG.md`:

```markdown
## 0.1.1

- Publish the Marketplace-ready extension metadata, icon, documentation, and
  protected two-platform Marketplace delivery workflow.
- Preserve the existing provider switching behavior and supported Windows x64,
  Linux x64, and Remote SSH Extension Host boundaries from 0.1.0.
```

- [ ] **Step 4: Update the owner publishing guide**

In `docs/marketplace-publishing.md`, replace only the actionable release tag
and package version in the dispatch instructions:

```markdown
1. Confirm that the existing tag is `v0.1.1` and that `package.json` contains
   version `0.1.1`.
```

```markdown
3. Choose **Run workflow**, enter `v0.1.1` in the `tag` field, and start the
   run.
```

- [ ] **Step 5: Run the focused contract and verify GREEN**

Run:

```powershell
npx tsx --test test/unit/marketplace-workflow.test.ts
```

Expected: all Marketplace workflow and documentation tests pass.

- [ ] **Step 6: Inspect the version scope**

Run:

```powershell
rg -n --glob '!node_modules/**' --glob '!native/windows-file-ops/build/**' "0\.1\.0|v0\.1\.0|0\.1\.1|v0\.1\.1" .
```

Expected: release-facing files identify `0.1.1`; the old approved design and
plan, the `0.1.0` changelog history, runtime client fallback, and generic unit
fixtures may continue to contain `0.1.0`.

- [ ] **Step 7: Commit the minimal implementation**

```powershell
git add -- package.json package-lock.json .github/workflows/marketplace.yml CHANGELOG.md docs/marketplace-publishing.md
git commit -m "chore: prepare Marketplace release 0.1.1"
```

### Task 3: Run complete local release verification

**Files:**
- Verify: all files changed since `main`

- [ ] **Step 1: Build the Windows native addon**

Run:

```powershell
npm run build:windows-file-ops
```

Expected: `node-gyp` exits successfully and stages
`native/windows-file-ops/windows_file_ops.node`.

- [ ] **Step 2: Run static, dependency, and test gates**

Run each command and require exit code zero:

```powershell
npm audit
npm run check
npm test
npm run test:integration
npm run build
```

Expected: zero known vulnerabilities, zero type errors, and zero test or build
failures.

- [ ] **Step 3: Verify deterministic listing assets**

Record the SHA-256 of `media/icon.png`, run the generator, and compare again:

```powershell
Get-FileHash media/icon.png -Algorithm SHA256
npm run generate:icon
Get-FileHash media/icon.png -Algorithm SHA256
```

Expected: both hashes are identical and the generator exits successfully.

- [ ] **Step 4: Build and verify the Windows release package**

Run:

```powershell
npm run package:win32-x64
```

Expected: a verified non-empty
`codex-provider-switcher-0.1.1@win32-x64.vsix` is created. Linux packaging is
left to the Ubuntu CI runner because cross-host native packaging is rejected by
design.

- [ ] **Step 5: Verify repository hygiene and secret isolation**

Run:

```powershell
git diff main...HEAD --check
git status --short
rg -n "VSCE_PAT|Marketplace: Manage|NODE_TLS_REJECT_UNAUTHORIZED" README.md docs .github
```

Expected: no whitespace errors; only intended source and documentation changes
are tracked; no PAT value or credential-shaped example appears. Generated
native build files and VSIX outputs remain ignored.

### Task 4: Review and integrate the release branch

**Files:**
- Review: `docs/superpowers/specs/2026-08-31-marketplace-0.1.1-release-design.md`
- Review: `docs/superpowers/plans/2026-08-31-marketplace-0.1.1-release.md`
- Review: `test/unit/marketplace-workflow.test.ts`
- Review: `package.json`
- Review: `package-lock.json`
- Review: `.github/workflows/marketplace.yml`
- Review: `CHANGELOG.md`
- Review: `docs/marketplace-publishing.md`

- [ ] **Step 1: Review the complete branch diff against the approved design**

Run:

```powershell
git diff --stat main...HEAD
git diff main...HEAD
```

Expected: the diff contains only the approved design, plan, release contract,
version metadata, exact Marketplace paths, changelog, and publishing guide.

- [ ] **Step 2: Push and create a pull request**

Run:

```powershell
git push -u origin release/marketplace-0.1.1
$releasePrBody = @'
## Summary

- preserve the existing immutable v0.1.0 release
- align Marketplace-ready release metadata and native package paths on v0.1.1
- keep Marketplace publication manual and credential-isolated

## Verification

- npm audit
- npm run check
- npm test
- npm run test:integration
- npm run build
- npm run generate:icon
- npm run package:win32-x64

No Marketplace credential or automatic Marketplace publication is included.
'@
gh pr create --base main --head release/marketplace-0.1.1 --title "Prepare Marketplace release 0.1.1" --body $releasePrBody
```

The reviewed PR body must summarize the immutable `v0.1.0` constraint, list
local verification, state that Marketplace publication remains manual, and
state that no credential is included.

- [ ] **Step 3: Wait for required PR checks**

Run:

```powershell
gh pr checks release/marketplace-0.1.1 --watch
```

Expected: Windows and Ubuntu CI/package checks finish successfully, including
Linux x64 native packaging.

- [ ] **Step 4: Merge the pull request and verify `main`**

Run the repository-supported non-interactive merge method, then verify:

```powershell
gh pr merge release/marketplace-0.1.1 --squash --delete-branch
git fetch origin main
git rev-parse origin/main
gh pr view release/marketplace-0.1.1 --json state,mergeCommit
```

Expected: PR state is `MERGED`, and `origin/main` contains the reviewed changes.

### Task 5: Create and verify GitHub Release v0.1.1

**Files:**
- External state: Git tag `v0.1.1`
- External state: GitHub Release `v0.1.1`

- [ ] **Step 1: Confirm the tag is unused and the target commit is merged**

Run:

```powershell
git ls-remote --tags origin refs/tags/v0.1.1
$releaseCommit = git rev-parse origin/main
git merge-base --is-ancestor $releaseCommit origin/main
```

Expected: the remote tag query is empty and the ancestry check exits zero.

- [ ] **Step 2: Create and push the annotated immutable tag**

Run:

```powershell
$releaseCommit = git rev-parse origin/main
git tag -a v0.1.1 $releaseCommit -m "Codex Provider Switcher v0.1.1"
git push origin v0.1.1
```

- [ ] **Step 3: Wait for the Release workflow**

Find the tag-triggered run and wait for it:

```powershell
$releaseRunId = gh run list --workflow release.yml --branch v0.1.1 --event push --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $releaseRunId --exit-status
```

Expected: both native package jobs and the GitHub Release job succeed.

- [ ] **Step 4: Verify public release assets and checksums**

Run:

```powershell
gh release view v0.1.1 --json tagName,targetCommitish,isDraft,isPrerelease,assets,url
```

Expected: the release is public and contains non-empty Windows x64 and Linux
x64 VSIX assets plus `SHA256SUMS.txt`, all from the immutable tag.

### Task 6: Publish and verify VS Code Marketplace 0.1.1

**Files:**
- External state: GitHub Actions workflow `Marketplace Publish`
- External state: VS Code Marketplace listing `Li-changwu.codex-provider-switcher`

- [ ] **Step 1: Manually dispatch the protected workflow**

Run:

```powershell
gh workflow run marketplace.yml --ref main -f tag=v0.1.1
```

Expected: one workflow run is queued using the protected `marketplace`
Environment and its `VSCE_PAT` secret.

- [ ] **Step 2: Wait for Marketplace publication**

Run:

```powershell
$marketplaceRunId = gh run list --workflow marketplace.yml --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $marketplaceRunId --exit-status
```

Expected: Windows and Ubuntu packages validate before the protected publish job
successfully submits both explicit VSIX files.

- [ ] **Step 3: Verify the public listing and target variants**

Open the public Marketplace item and publisher management page. Confirm the
extension identity is `Li-changwu.codex-provider-switcher`, the displayed
version is `0.1.1`, and both `win32-x64` and `linux-x64` packages are available.
Record the public listing URL and publication evidence without recording any
credential.

- [ ] **Step 4: Revoke the temporary PAT**

In Azure DevOps user settings, revoke PAT
`codex-provider-switcher-v0.1.0-publish` after both target variants are
verified. Confirm the PAT is no longer active. Leave the GitHub Environment in
place; its stale secret cannot authenticate after server-side revocation and
must be replaced before a future release.

- [ ] **Step 5: Record the final release state**

Report the merged commit, tag, GitHub Release URL, Marketplace listing URL,
both supported targets, final workflow results, and PAT revocation status. Do
not include token material.
