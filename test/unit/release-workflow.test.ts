import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = resolve(projectRoot, ".github/workflows/release.yml");
const readmePath = resolve(projectRoot, "README.md");
const developmentPath = resolve(projectRoot, "docs/development.md");

async function readWorkflow(): Promise<string> {
  return (await readFile(workflowPath, "utf8")).replace(/\r\n/g, "\n");
}

test("release workflow is triggered only by pushed version tags", async () => {
  const workflow = await readWorkflow();
  const triggerBlock = workflow.match(/^on:\n([\s\S]*?)^permissions:/m)?.[1];

  assert.match(workflow, /name:\s*Release\b/);
  assert.equal(
    triggerBlock?.trim(),
    'push:\n    tags:\n      - "v*"',
    "workflow must have only a push v* tag trigger",
  );
});

test("package matrix builds both native VSIX targets and fails on missing artifacts", async () => {
  const workflow = await readWorkflow();
  const packageJob = workflow.match(/^  package:\n([\s\S]*?)^  release:/m)?.[1] ?? "";

  assert.notEqual(packageJob, "", "package job must be present");
  assert.match(packageJob, /- os: windows-latest\r?\n\s+target: win32-x64/);
  assert.match(packageJob, /- os: ubuntu-latest\r?\n\s+target: linux-x64/);
  assert.match(
    packageJob,
    /if: matrix\.target == 'win32-x64'\r?\n\s+run: npm run package:win32-x64/,
  );
  assert.match(
    packageJob,
    /if: matrix\.target == 'linux-x64'\r?\n\s+run: npm run package:linux-x64/,
  );
  assert.match(packageJob, /uses: actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(packageJob, /if-no-files-found:\s*error/);
});

test("workflow pins every third-party action to an immutable commit", async () => {
  const workflow = await readWorkflow();
  const actionUses = [...workflow.matchAll(/^\s+-\s+uses:\s+([^\s]+)$/gm)].map(
    (match) => match[1],
  );
  const requiredActions = [
    "actions/checkout",
    "actions/setup-node",
    "actions/upload-artifact",
    "actions/download-artifact",
  ];

  assert.ok(actionUses.length > 0);
  for (const actionName of requiredActions) {
    assert.ok(
      actionUses.some((action) => action.startsWith(`${actionName}@`)),
      `${actionName} must be used`,
    );
  }
  for (const action of actionUses) {
    assert.match(action, /^[^@]+@[0-9a-f]{40}$/);
  }
});

test("only the release job can write repository contents", async () => {
  const workflow = await readWorkflow();

  const releaseJob = workflow.match(/^  release:\n([\s\S]*)$/m)?.[1] ?? "";

  assert.match(workflow, /^permissions:\r?\n  contents:\s*read\s*$/m);
  assert.match(releaseJob, /^    permissions:\r?\n      contents:\s*write\s*$/m);
  assert.equal((workflow.match(/contents:\s*write/g) ?? []).length, 1);
  const packageJob = workflow.match(/\n  package:\s*\n([\s\S]*?)\n  release:/)?.[1] ?? "";
  assert.notEqual(packageJob, "", "package job must be present");
  assert.doesNotMatch(packageJob, /contents:\s*write/);
});

test("release job waits for both packages, validates assets, then creates the release", async () => {
  const workflow = await readWorkflow();
  const releaseJob = workflow.match(/^  release:\n([\s\S]*)$/m)?.[1] ?? "";

  assert.notEqual(releaseJob, "", "release job must be present");
  assert.match(releaseJob, /^    needs:\s*package\s*$/m);
  assert.match(releaseJob, /run: rm -rf release-assets && mkdir release-assets/);
  assert.equal(
    (releaseJob.match(/uses: actions\/download-artifact@[0-9a-f]{40}/g) ?? []).length,
    1,
  );
  assert.match(
    releaseJob,
    /pattern:\s*codex-provider-switcher-\*\r?\n\s+path:\s*release-assets\r?\n\s+merge-multiple:\s*true/,
  );

  const helperCommand =
    'node scripts/release-artifacts.mjs "$GITHUB_WORKSPACE/release-assets" "$GITHUB_REF_NAME"';
  const releaseCommand =
    'gh release create "$GITHUB_REF_NAME" release-assets/* --repo "$GITHUB_REPOSITORY" --title "$GITHUB_REF_NAME" --generate-notes';
  const validateIndex = releaseJob.indexOf(helperCommand);
  const releaseIndex = releaseJob.indexOf(releaseCommand);
  assert.ok(validateIndex >= 0, "release artifact helper must run with exact paths");
  assert.ok(releaseIndex > validateIndex, "release must be created after validation");
  assert.match(
    releaseJob,
    /run: gh release create "\$GITHUB_REF_NAME" release-assets\/\* --repo "\$GITHUB_REPOSITORY" --title "\$GITHUB_REF_NAME" --generate-notes\r?\n\s+env:\r?\n\s+GH_TOKEN:\s+\$\{\{\s*github\.token\s*\}\}/,
  );
});

test("README documents verified VSIX installation, Remote SSH, upgrade, and uninstall", async () => {
  const readme = await readFile(readmePath, "utf8");

  assert.match(readme, /GitHub Releases/);
  assert.match(readme, /SHA256SUMS\.txt/);
  assert.match(readme, /Install from VSIX\.\.\./);
  assert.match(readme, /Remote SSH/);
  assert.match(readme, /Upgrade/);
  assert.match(readme, /Uninstall/);
});

test("development documentation defines the tag contract and release gates", async () => {
  const development = await readFile(developmentPath, "utf8");

  assert.match(development, /v\$\{version\}/);
  assert.match(development, /package\.json/);
  assert.match(development, /SHA256SUMS\.txt/);
  assert.match(development, /npm run package:win32-x64/);
  assert.match(development, /npm run package:linux-x64/);
  assert.match(development, /GitHub Release/);
});
