# VS Code Marketplace Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Windows and Linux VSIX release pipeline ready for a secure, manual first publication to the VS Code Marketplace.

**Architecture:** Add Marketplace metadata and a reproducible PNG asset, upgrade vulnerable development tooling and Node 20 GitHub Actions, then add a manual tag-driven publishing workflow. Native runners build the two platform packages without credentials; one protected publish job validates both assets and receives the PAT only through a GitHub Environment secret.

**Tech Stack:** TypeScript, Node.js, `sharp`, `@vscode/vsce`, VSIX, GitHub Actions, Azure DevOps Marketplace PATs, Node test runner through `tsx`.

---

### Task 1: Upgrade development tooling and GitHub Actions runtimes

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/package.yml`
- Modify: `.github/workflows/release.yml`
- Create: `test/unit/workflow-runtime.test.ts`
- Modify: `test/unit/package-contract.test.ts`

- [ ] **Step 1: Write failing dependency and workflow-runtime contracts.** Require `@vscode/vsce` `^3.9.2`, `esbuild` `^0.28.2`, and `sharp` `^0.35.4`. Read every `.github/workflows/*.yml` file and reject the old action SHAs. Require the exact Node 24 pins `d23441a48e516b6c34aea4fa41551a30e30af803`, `249970729cb0ef3589644e2896645e5dc5ba9c38`, `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`, and `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` whenever their corresponding actions occur.
- [ ] **Step 2: Run the focused tests.** Run `npx tsx --test test/unit/package-contract.test.ts test/unit/workflow-runtime.test.ts`; expect failures naming the old dependency ranges and action commits.
- [ ] **Step 3: Upgrade the locked dependencies.** Run `npm install --save-dev @vscode/vsce@^3.9.2 esbuild@^0.28.2 sharp@^0.35.4` with `NODE_TLS_REJECT_UNAUTHORIZED` removed from the child environment. Do not use `npm audit fix --force`.
- [ ] **Step 4: Replace every action pin.** Use checkout `d23441a48e516b6c34aea4fa41551a30e30af803`, setup-node `249970729cb0ef3589644e2896645e5dc5ba9c38`, upload-artifact `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`, and download-artifact `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`. Preserve immutable pins and update version comments.
- [ ] **Step 5: Verify focused contracts and audit.** Run `npx tsx --test test/unit/package-contract.test.ts test/unit/workflow-runtime.test.ts && npm audit`; expect zero test failures and zero vulnerabilities.
- [ ] **Step 6: Commit.** Commit as `chore: update release toolchain`.

### Task 2: Add Marketplace branding and manifest metadata

**Files:**
- Create: `assets/marketplace-icon.svg`
- Create: `media/icon.png`
- Create: `scripts/generate-marketplace-icon.mjs`
- Create: `test/unit/marketplace-assets.test.ts`
- Create: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `.vscodeignore`
- Modify: `test/unit/extension-manifest.test.ts`

- [ ] **Step 1: Write failing Marketplace asset and manifest tests.** Require publisher `Li-changwu`, name `codex-provider-switcher`, description `Safely manage and switch local Codex provider profiles on Windows, Linux, and Remote SSH.`, category `Other`, keywords `codex`, `provider`, `profiles`, `configuration`, and `remote-ssh`, icon `media/icon.png`, GitHub homepage, and issue URL. Require `generate:icon` to run `node scripts/generate-marketplace-icon.mjs`. Parse the PNG signature and IHDR bytes and require 128 by 128 pixels. Generate to a temporary path and require byte equality with the checked-in PNG.
- [ ] **Step 2: Run focused tests.** Run `npx tsx --test test/unit/extension-manifest.test.ts test/unit/marketplace-assets.test.ts`; expect failures for missing fields and assets.
- [ ] **Step 3: Add the approved icon source.** Create a 128-square SVG with charcoal `#151515`, the four official Lucide `repeat-2` paths under ISC attribution, white round strokes, a lime `#b7f34b` signal, and a coral `#ff664d` signal. Do not include OpenAI or VS Code trademarks.
- [ ] **Step 4: Add the deterministic generator.** Export `generateMarketplaceIcon({ sourcePath, outputPath })`, render with `sharp` to exactly 128 by 128 PNG, read metadata back, and fail unless format and dimensions match. The CLI resolves paths from `import.meta.url`, writes `media/icon.png`, and prints only the relative output path.
- [ ] **Step 5: Add listing metadata and changelog.** Keep `private: true`, add the exact manifest fields from Step 1, add the icon script, and document the existing `0.1.0` behavior in `CHANGELOG.md` without future claims.
- [ ] **Step 6: Exclude design source from VSIX.** Add `assets/**` to `.vscodeignore`; leave `media/icon.png` and `CHANGELOG.md` included.
- [ ] **Step 7: Generate and verify the icon.** Run `npm run generate:icon` and the focused tests; expect deterministic byte equality and zero failures.
- [ ] **Step 8: Commit.** Commit as `feat: add Marketplace listing assets`.

### Task 3: Extend VSIX package verification for Marketplace assets

**Files:**
- Modify: `scripts/vsix-verifier.mjs`
- Modify: `test/unit/vsix-verifier.test.ts`
- Modify: `test/unit/package-contract.test.ts`

- [ ] **Step 1: Write failing VSIX tests.** Extend the valid archive fixture with `extension/CHANGELOG.md` and `extension/media/icon.png`. Add one test deleting each file and require `VSIX is missing required entry`. Require `.vscodeignore` to exclude `assets/**` and permit only the PNG under `media/`.
- [ ] **Step 2: Run focused tests.** Run `npx tsx --test test/unit/vsix-verifier.test.ts test/unit/package-contract.test.ts`; expect the new missing-entry cases to fail because the verifier does not require the files.
- [ ] **Step 3: Extend the exact package allowlist.** Add `extension/CHANGELOG.md` and `extension/media/icon.png` to required exact extension files. Preserve rejection of unexpected files, SVG files in the shipped media directory, source maps, declarations, and installer dependencies.
- [ ] **Step 4: Run focused tests and Windows packaging.** Run `npx tsx --test test/unit/vsix-verifier.test.ts test/unit/package-contract.test.ts && npm run package:win32-x64`; expect zero failures and a verified package containing the changelog and PNG.
- [ ] **Step 5: Commit.** Commit as `test: verify Marketplace package assets`.

### Task 4: Add the protected manual Marketplace workflow

**Files:**
- Create: `.github/workflows/marketplace.yml`
- Create: `test/unit/marketplace-workflow.test.ts`

- [ ] **Step 1: Write the failing workflow contract.** Assert manual-only `workflow_dispatch`, a required string `tag` input, default `contents: read`, tag-scoped concurrency without cancellation, exact checkout of `${{ inputs.tag }}`, native `win32-x64` and `linux-x64` packaging, missing-file artifact failure, `needs: package`, `environment: marketplace`, clean merged artifact download, release helper execution before publish, local `./node_modules/.bin/vsce`, two explicit package paths, `--skip-duplicate`, and `VSCE_PAT` only on the publish step. Reject `push`, `pull_request`, `contents: write`, tag creation, GitHub Release creation, and PAT use in package jobs.
- [ ] **Step 2: Run the focused test.** Run `npx tsx --test test/unit/marketplace-workflow.test.ts`; expect failure because the workflow is missing.
- [ ] **Step 3: Implement the package matrix.** Check out the exact input tag, use Node 22, run `npm ci`, package only the matching native target, and upload one artifact with the Node 24 action pins.
- [ ] **Step 4: Implement the protected publish job.** Use `needs: package`, Ubuntu, `environment: marketplace`, clean `marketplace-assets`, download both packages with merge enabled, run `node scripts/release-artifacts.mjs "$GITHUB_WORKSPACE/marketplace-assets" "${{ inputs.tag }}"`, then run `./node_modules/.bin/vsce publish --packagePath marketplace-assets/codex-provider-switcher-0.1.0@win32-x64.vsix marketplace-assets/codex-provider-switcher-0.1.0@linux-x64.vsix --skip-duplicate` with only `VSCE_PAT: ${{ secrets.VSCE_PAT }}` on that step.
- [ ] **Step 5: Run workflow and release contracts.** Run `npx tsx --test test/unit/marketplace-workflow.test.ts test/unit/release-workflow.test.ts test/unit/workflow-runtime.test.ts`; expect zero failures.
- [ ] **Step 6: Commit.** Commit as `ci: add protected Marketplace publishing`.

### Task 5: Document Publisher, PAT, and dual-channel installation

**Files:**
- Create: `docs/marketplace-publishing.md`
- Modify: `README.md`
- Modify: `docs/development.md`
- Modify: `test/unit/marketplace-workflow.test.ts`

- [ ] **Step 1: Add failing documentation contracts.** Require README references to the VS Code Marketplace, GitHub Releases, platform selection, Remote SSH, checksums, upgrade, and uninstall. Require the publisher guide to contain `Li-changwu`, `Marketplace: Manage`, `marketplace`, `VSCE_PAT`, `v0.1.0`, token rotation/revocation, and `Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED`; reject credential-shaped token examples.
- [ ] **Step 2: Run the focused test.** Run `npx tsx --test test/unit/marketplace-workflow.test.ts`; expect documentation assertions to fail.
- [ ] **Step 3: Update README distribution guidance.** Make Marketplace installation the normal path and retain GitHub Release checksum installation for offline/manual use. State that VS Code automatically selects a compatible target package and keep the exact Remote SSH Extension Host boundary.
- [ ] **Step 4: Write the step-by-step owner guide.** Document Publisher creation at `https://marketplace.visualstudio.com/manage`, a short-lived Azure DevOps PAT with only Marketplace Manage scope, GitHub Environment and secret creation, manual workflow dispatch, listing verification, and PAT rotation/revocation. Never include a real token or ask readers to expose it.
- [ ] **Step 5: Update development release gates.** Document that GitHub Release and Marketplace publication are separate, the Marketplace workflow accepts only a tag matching `package.json`, and only the protected publish step receives credentials.
- [ ] **Step 6: Run focused tests and secret scan.** Run `npx tsx --test test/unit/marketplace-workflow.test.ts` and `rg -n "(VSCE_PAT|Marketplace: Manage|NODE_TLS_REJECT_UNAUTHORIZED)" README.md docs .github`; inspect all matches and confirm none contains a token value.
- [ ] **Step 7: Commit.** Commit as `docs: add Marketplace publishing guide`.

### Task 6: Full verification, review, and integration

**Files:**
- Review: all files changed by Tasks 1-5

- [ ] **Step 1: Run local gates.** Run `npm audit`, `npm run check`, `npm test`, `npm run test:integration`, `npm run build`, `npm run generate:icon`, `npm run package:win32-x64`, and `git diff --check`; expect zero vulnerabilities, zero failures, and a verified Windows VSIX.
- [ ] **Step 2: Verify generated and packaged assets.** Confirm `media/icon.png` is 128x128, regeneration is byte-identical, the VSIX includes only `media/icon.png` under media, and the package includes `CHANGELOG.md`.
- [ ] **Step 3: Review the complete diff.** Run `git diff main...HEAD --stat` and `git diff main...HEAD --check`; expect only Marketplace preparation, maintenance, tests, docs, and approved assets.
- [ ] **Step 4: Push and open a PR.** Push `feature/marketplace-readiness`, open a PR summarizing Marketplace readiness and explicitly state that no Marketplace credential or publication is included.
- [ ] **Step 5: Wait for native CI.** Watch PR checks until Windows and Ubuntu pass. Inspect annotations and require no GitHub Actions Node 20 runtime warning.
- [ ] **Step 6: Merge after review.** Squash-merge the PR, update local `main`, and verify `origin/main` contains the manual workflow, icon, guide, and tests.
- [ ] **Step 7: Stop before external publication.** Do not run the Marketplace workflow. Hand the user the exact Publisher/PAT/Environment steps and wait until they confirm that `Li-changwu` and `VSCE_PAT` are configured.
