import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = resolve(projectRoot, ".github/workflows/marketplace.yml");
const packagePath = resolve(projectRoot, "package.json");
const packageLockPath = resolve(projectRoot, "package-lock.json");
const changelogPath = resolve(projectRoot, "CHANGELOG.md");
const readmePath = resolve(projectRoot, "README.md");
const developmentPath = resolve(projectRoot, "docs/development.md");
const publishingGuidePath = resolve(projectRoot, "docs/marketplace-publishing.md");

async function readWorkflow(): Promise<string> {
  return (await readFile(workflowPath, "utf8")).replace(/\r\n/g, "\n");
}

test("Marketplace release metadata is aligned on identity and version 0.1.3", async () => {
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  const lockfile = JSON.parse(await readFile(packageLockPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
    packages?: Record<string, { name?: unknown; version?: unknown }>;
  };
  const changelog = await readFile(changelogPath, "utf8");
  const guide = await readFile(publishingGuidePath, "utf8");

  assert.equal(manifest.name, "codex-provider-switcher-vscode");
  assert.equal(manifest.version, "0.1.3");
  assert.equal(lockfile.name, "codex-provider-switcher-vscode");
  assert.equal(lockfile.version, "0.1.3");
  assert.equal(lockfile.packages?.[""]?.name, "codex-provider-switcher-vscode");
  assert.equal(lockfile.packages?.[""]?.version, "0.1.3");
  assert.match(changelog, /^## 0\.1\.3$/m);
  assert.match(guide, /`v0\.1\.3`/);
  assert.match(guide, /`Li-changwu\.codex-provider-switcher-vscode`/);
});

test("Marketplace publication is manual, tag-scoped, and read-only", async () => {
  const workflow = await readWorkflow();
  const triggerBlock = workflow.match(/^on:\n([\s\S]*?)^permissions:/m)?.[1] ?? "";

  assert.match(workflow, /^name: Marketplace Publish$/m);
  assert.match(
    triggerBlock,
    /^  workflow_dispatch:\n    inputs:\n      tag:\n[\s\S]*?        required: true\n        type: string$/m,
  );
  assert.doesNotMatch(triggerBlock, /\b(?:push|pull_request|schedule):/);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /contents:\s*write/);
  assert.match(
    workflow,
    /^concurrency:\n  group: marketplace-\$\{\{ inputs\.tag \}\}\n  cancel-in-progress: false$/m,
  );
});

test("native package jobs build the exact input tag without Marketplace credentials", async () => {
  const workflow = await readWorkflow();
  const packageJob = workflow.match(/^  package:\n([\s\S]*?)^  publish:/m)?.[1] ?? "";

  assert.notEqual(packageJob, "", "package job must be present");
  assert.match(packageJob, /- os: windows-latest\n\s+target: win32-x64/);
  assert.match(packageJob, /- os: ubuntu-latest\n\s+target: linux-x64/);
  assert.match(
    packageJob,
    /uses: actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803[^\n]*\n\s+with:\n\s+ref: \$\{\{ inputs\.tag \}\}/,
  );
  assert.match(
    packageJob,
    /uses: actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/,
  );
  assert.match(packageJob, /node-version: 22/);
  assert.match(packageJob, /run: npm ci/);
  assert.match(
    packageJob,
    /if: matrix\.target == 'win32-x64'\n\s+run: npm run package:win32-x64/,
  );
  assert.match(
    packageJob,
    /if: matrix\.target == 'linux-x64'\n\s+run: npm run package:linux-x64/,
  );
  assert.match(
    packageJob,
    /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/,
  );
  assert.match(
    packageJob,
    /path: codex-provider-switcher-vscode-\$\{\{ steps\.version\.outputs\.version \}\}@\$\{\{ matrix\.target \}\}\.vsix/,
  );
  assert.match(packageJob, /if-no-files-found: error/);
  assert.doesNotMatch(packageJob, /\b(?:environment|VSCE_PAT|secrets\.)\b/);
});

test("protected publish job validates both native packages before local vsce publication", async () => {
  const workflow = await readWorkflow();
  const publishJob = workflow.match(/^  publish:\n([\s\S]*)$/m)?.[1] ?? "";

  assert.notEqual(publishJob, "", "publish job must be present");
  assert.match(publishJob, /^    needs: package$/m);
  assert.match(publishJob, /^    environment: marketplace$/m);
  assert.match(publishJob, /run: rm -rf marketplace-assets && mkdir marketplace-assets/);
  assert.match(
    publishJob,
    /uses: actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/,
  );
  assert.match(
    publishJob,
    /pattern: marketplace-\*\n\s+path: marketplace-assets\n\s+merge-multiple: true/,
  );

  const validationCommand =
    'node scripts/release-artifacts.mjs "$GITHUB_WORKSPACE/marketplace-assets" "${{ inputs.tag }}"';
  const publishCommand =
    './node_modules/.bin/vsce publish --packagePath "marketplace-assets/codex-provider-switcher-vscode-${{ steps.version.outputs.version }}@win32-x64.vsix" "marketplace-assets/codex-provider-switcher-vscode-${{ steps.version.outputs.version }}@linux-x64.vsix" --skip-duplicate';
  const validationIndex = publishJob.indexOf(validationCommand);
  const publishIndex = publishJob.indexOf(publishCommand);
  assert.ok(validationIndex >= 0, "release artifact validation must use the input tag");
  assert.ok(publishIndex > validationIndex, "publication must run after artifact validation");
  assert.match(
    publishJob,
    /run: \.\/node_modules\/\.bin\/vsce publish[^\n]+ --skip-duplicate\n\s+env:\n\s+VSCE_PAT: \$\{\{ secrets\.VSCE_PAT \}\}/,
  );

  const secretLines = workflow
    .split("\n")
    .filter((line) => line.includes("VSCE_PAT"));
  assert.deepEqual(secretLines, ["          VSCE_PAT: ${{ secrets.VSCE_PAT }}"]);
  assert.doesNotMatch(workflow, /\bgh release\b|\bgit tag\b|create-release/);
});

test("README documents Marketplace and verified GitHub Release installation", async () => {
  const readme = await readFile(readmePath, "utf8");

  assert.match(readme, /VS Code Marketplace/);
  assert.match(
    readme,
    /items\?itemName=Li-changwu\.codex-provider-switcher-vscode/,
  );
  assert.match(
    readme,
    /code --install-extension Li-changwu\.codex-provider-switcher-vscode/,
  );
  assert.match(readme, /codex-provider-switcher-vscode-<version>@win32-x64\.vsix/);
  assert.match(readme, /codex-provider-switcher-vscode-<version>@linux-x64\.vsix/);
  assert.match(readme, /automatically selects[^.]*compatible target/iu);
  assert.match(readme, /GitHub Releases/);
  assert.match(readme, /win32-x64/);
  assert.match(readme, /linux-x64/);
  assert.match(readme, /Remote SSH/);
  assert.match(readme, /SHA256SUMS\.txt/);
  assert.match(readme, /Upgrade/);
  assert.match(readme, /Uninstall/);
  assert.doesNotMatch(readme, /not the VS Code Marketplace/);
});

test("owner guide covers Publisher and least-privilege PAT setup without token examples", async () => {
  const guide = await readFile(publishingGuidePath, "utf8");

  assert.match(guide, /https:\/\/marketplace\.visualstudio\.com\/manage/);
  assert.match(guide, /Publisher ID[^\n]*`Li-changwu`/);
  assert.match(guide, /Azure DevOps[^\n]*PAT/);
  assert.match(guide, /Marketplace: Manage/);
  assert.match(guide, /all accessible organizations/iu);
  assert.match(guide, /GitHub Environment[^\n]*`marketplace`/);
  assert.match(guide, /Environment Secret[^\n]*`VSCE_PAT`/);
  assert.match(guide, /Marketplace Publish/);
  assert.match(guide, /`Li-changwu\.codex-provider-switcher-vscode`/);
  assert.match(guide, /`v0\.1\.3`/);
  assert.match(guide, /rotate|rotation/iu);
  assert.match(guide, /revoke|revocation/iu);
  assert.match(guide, /Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED/);
  assert.match(guide, /Never paste[^\n]*PAT[^\n]*chat/iu);
  assert.doesNotMatch(guide, /\b[a-z0-9]{52}\b/iu);
  assert.doesNotMatch(guide, /\b[a-z0-9]{75}AZDO[a-z0-9]{4}\b/iu);
  assert.doesNotMatch(guide, /VSCE_PAT\s*[:=]\s*[^\s`]+/u);
});

test("development guide keeps GitHub and Marketplace release gates separate", async () => {
  const development = await readFile(developmentPath, "utf8");

  assert.match(development, /GitHub Release[^\n]*Marketplace[^\n]*separate/iu);
  assert.match(development, /Marketplace Publish/);
  assert.match(development, /workflow_dispatch/);
  assert.match(development, /tag[^\n]*package\.json/iu);
  assert.match(development, /marketplace[^\n]*Environment/iu);
  assert.match(development, /VSCE_PAT/);
  assert.match(development, /only[^\n]*publish step/iu);
});
