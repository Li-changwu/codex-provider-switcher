# GitHub Release Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish verified Windows and Linux VSIX artifacts with checksums on a GitHub Release when a matching version tag is pushed.

**Architecture:** Keep target packaging in the existing package scripts. Add a small Node helper that validates release assets and writes deterministic SHA-256 checksums. A tag-triggered GitHub Actions workflow builds each target on its native runner, then a least-privilege release job validates downloaded assets and invokes the GitHub CLI. README documentation gives users the manual install path.

**Tech Stack:** Node.js, `fs/promises`, `crypto`, GitHub Actions, GitHub CLI, existing VSIX packaging scripts, and the Node test runner through `tsx`.

---

### Task 1: Release artifact helper

**Files:**
- Create: `scripts/release-artifacts.mjs`
- Create: `test/unit/release-artifacts.test.ts`

- [ ] **Step 1: Write failing tests.** Cover exact `v${package.json.version}` matching, the two target filenames, missing and unexpected files, empty files, directories, symbolic links, and deterministic SHA-256 output.
- [ ] **Step 2: Run the focused test.** Run `npx tsx --test test/unit/release-artifacts.test.ts`; it must fail because the helper does not exist.
- [ ] **Step 3: Implement the helper.** Export `stageReleaseArtifacts({ projectRoot, releaseDirectory, tag })`. Read the manifest, require the tag to equal `v` followed by the manifest version, require exactly the expected Linux and Windows regular non-empty VSIX files, reject symlinks and unexpected entries, hash files with `createHash("sha256")`, sort names, and write `SHA256SUMS.txt`. When run as `node scripts/release-artifacts.mjs <directory> <tag>`, resolve the project root from `import.meta.url` and print only the three asset names.
- [ ] **Step 4: Run focused tests and type checking.** Run `npx tsx --test test/unit/release-artifacts.test.ts && npm run check`; expect zero failures and exit code 0.
- [ ] **Step 5: Commit.** Run `git add scripts/release-artifacts.mjs test/unit/release-artifacts.test.ts && git commit -m "feat: validate release VSIX artifacts"`.

### Task 2: Tag-triggered release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `test/unit/release-workflow.test.ts`

- [ ] **Step 1: Write a failing workflow contract test.** Read `.github/workflows/release.yml` and assert tag-only triggering, `win32-x64` and `linux-x64` matrix targets, immutable action pins, default `contents: read`, release-job-only `contents: write`, matching package commands, artifact upload with missing-file failure, helper execution before `gh release create`, and a `needs: package` dependency.
- [ ] **Step 2: Run the focused test.** Run `npx tsx --test test/unit/release-workflow.test.ts`; it must fail because the workflow does not exist.
- [ ] **Step 3: Implement the workflow.** Use `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, and `actions/download-artifact` at immutable commit pins. Package each target on its matching native runner. Give only the release job `contents: write`; download both assets into one clean directory, run `node scripts/release-artifacts.mjs "$GITHUB_WORKSPACE/release-assets" "$GITHUB_REF_NAME"`, then run `gh release create "$GITHUB_REF_NAME" release-assets/* --repo "$GITHUB_REPOSITORY" --title "$GITHUB_REF_NAME" --generate-notes` with `GH_TOKEN`.
- [ ] **Step 4: Run the workflow contract and unit suite.** Run `npx tsx --test test/unit/release-workflow.test.ts && npm test`; expect zero failures.
- [ ] **Step 5: Commit.** Run `git add .github/workflows/release.yml test/unit/release-workflow.test.ts && git commit -m "ci: publish verified VSIX releases"`.

### Task 3: Installation documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/development.md`
- Modify: `test/unit/release-workflow.test.ts`

- [ ] **Step 1: Add failing documentation assertions.** Require README text for GitHub Releases, `SHA256SUMS.txt`, Install from VSIX, Remote SSH, upgrade, and uninstall.
- [ ] **Step 2: Run the focused test and observe the documentation assertion fail.** Run `npx tsx --test test/unit/release-workflow.test.ts`.
- [ ] **Step 3: Document the user path.** Add platform selection, PowerShell `Get-FileHash`, Linux `sha256sum -c`, VS Code `Install from VSIX...`, correct Remote SSH window, upgrade preservation, uninstall behavior, and the unsupported-host boundary. Add the tag contract and release gates to `docs/development.md`. Include no credentials.
- [ ] **Step 4: Run complete local validation.** Run `npm test && npm run test:integration && npm run check && npm run build && npm run package:win32-x64`; expect zero test failures and a verified Windows VSIX.
- [ ] **Step 5: Commit.** Run `git add README.md docs/development.md test/unit/release-workflow.test.ts && git commit -m "docs: explain GitHub Release installation"`.

### Task 4: PR, CI, and merge

**Files:**
- Review: all files changed by Tasks 1-3

- [ ] **Step 1: Inspect the complete diff.** Run `git diff main...HEAD --check && git diff --stat main...HEAD`; expect only release helper, workflow, tests, and documentation changes.
- [ ] **Step 2: Push and create the Issue-linked PR.** Run `git push -u origin feature/github-release-delivery` and create a PR whose body contains `Closes #30`.
- [ ] **Step 3: Wait for platform CI.** Run `gh pr checks <number> --repo Li-changwu/codex-provider-switcher --watch`; both Windows and Ubuntu jobs must pass.
- [ ] **Step 4: Merge.** Run `gh pr merge <number> --repo Li-changwu/codex-provider-switcher --squash --delete-branch` only after CI and review pass; verify the PR is merged and Issue #30 is closed.
- [ ] **Step 5: Verify release workflow readiness.** Confirm `origin/main` contains the workflow and helper, and do not push a version tag unless the user explicitly requests a public release.
