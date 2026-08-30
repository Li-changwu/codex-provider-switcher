import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageReleaseArtifacts } from "../../scripts/release-artifacts.mjs";

const manifest = {
  name: "codex-provider-switcher",
  version: "0.1.0",
};
const linuxAsset = `${manifest.name}-${manifest.version}@linux-x64.vsix`;
const windowsAsset = `${manifest.name}-${manifest.version}@win32-x64.vsix`;
const validFiles = {
  [linuxAsset]: Buffer.from("linux artifact"),
  [windowsAsset]: Buffer.from("windows artifact"),
};

test("rejects a tag that does not exactly match the manifest version", async (t) => {
  const fixture = await createFixture(t, validFiles);

  await assert.rejects(
    stageReleaseArtifacts({
      projectRoot: fixture.projectRoot,
      releaseDirectory: fixture.releaseDirectory,
      tag: "v0.1.1",
    }),
    /tag must exactly match v0\.1\.0/,
  );
});

test("stages sorted assets with deterministic SHA-256 checksums", async (t) => {
  const fixture = await createFixture(t, validFiles);
  const first = await stageReleaseArtifacts({
    projectRoot: fixture.projectRoot,
    releaseDirectory: fixture.releaseDirectory,
    tag: "v0.1.0",
  });
  const firstContents = await readFile(first.checksumPath, "utf8");

  await unlink(first.checksumPath);
  const second = await stageReleaseArtifacts({
    projectRoot: fixture.projectRoot,
    releaseDirectory: fixture.releaseDirectory,
    tag: "v0.1.0",
  });
  const secondContents = await readFile(second.checksumPath, "utf8");
  const linuxChecksum = sha256(validFiles[linuxAsset]);
  const windowsChecksum = sha256(validFiles[windowsAsset]);

  assert.deepEqual(first.assetNames, [linuxAsset, windowsAsset, "SHA256SUMS.txt"]);
  assert.equal(first.checksumPath, join(fixture.releaseDirectory, "SHA256SUMS.txt"));
  assert.deepEqual(second, first);
  assert.equal(
    firstContents,
    `${linuxChecksum}  ${linuxAsset}\n${windowsChecksum}  ${windowsAsset}\n`,
  );
  assert.equal(secondContents, firstContents);
});

test("rejects a missing target artifact", async (t) => {
  const fixture = await createFixture(t, { [linuxAsset]: validFiles[linuxAsset] });

  await assert.rejects(
    stageReleaseArtifacts({
      projectRoot: fixture.projectRoot,
      releaseDirectory: fixture.releaseDirectory,
      tag: "v0.1.0",
    }),
    /must contain exactly the two target VSIX files/,
  );
});

test("rejects an unexpected release artifact", async (t) => {
  const fixture = await createFixture(t, {
    ...validFiles,
    "unexpected.txt": Buffer.from("unexpected"),
  });

  await assert.rejects(
    stageReleaseArtifacts({
      projectRoot: fixture.projectRoot,
      releaseDirectory: fixture.releaseDirectory,
      tag: "v0.1.0",
    }),
    /unexpected release entries: unexpected\.txt/,
  );
});

test("rejects an empty target artifact", async (t) => {
  const fixture = await createFixture(t, {
    ...validFiles,
    [windowsAsset]: Buffer.alloc(0),
  });

  await assert.rejects(
    stageReleaseArtifacts({
      projectRoot: fixture.projectRoot,
      releaseDirectory: fixture.releaseDirectory,
      tag: "v0.1.0",
    }),
    /must be non-empty: .*win32-x64\.vsix/,
  );
});

test("rejects a directory at a target artifact path", async (t) => {
  const fixture = await createFixture(t, { [linuxAsset]: validFiles[linuxAsset] });
  await mkdir(join(fixture.releaseDirectory, windowsAsset));

  await assert.rejects(
    stageReleaseArtifacts({
      projectRoot: fixture.projectRoot,
      releaseDirectory: fixture.releaseDirectory,
      tag: "v0.1.0",
    }),
    /must be a regular non-symlink file: .*win32-x64\.vsix/,
  );
});

test("rejects a symbolic link at a target artifact path", async (t) => {
  const fixture = await createFixture(t, { [linuxAsset]: validFiles[linuxAsset] });
  const target = join(fixture.root, "outside.vsix");
  await writeFile(target, validFiles[windowsAsset]);
  try {
    await symlink(target, join(fixture.releaseDirectory, windowsAsset), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("creating file symlinks requires Windows developer mode or equivalent privilege");
      return;
    }
    throw error;
  }

  await assert.rejects(
    stageReleaseArtifacts({
      projectRoot: fixture.projectRoot,
      releaseDirectory: fixture.releaseDirectory,
      tag: "v0.1.0",
    }),
    /must be a regular non-symlink file: .*win32-x64\.vsix/,
  );
});

test("rejects an existing SHA256SUMS.txt", async (t) => {
  const fixture = await createFixture(t, validFiles);
  const checksumPath = join(fixture.releaseDirectory, "SHA256SUMS.txt");
  await writeFile(checksumPath, "pre-existing\n");

  await assert.rejects(
    stageReleaseArtifacts({
      projectRoot: fixture.projectRoot,
      releaseDirectory: fixture.releaseDirectory,
      tag: "v0.1.0",
    }),
    /SHA256SUMS\.txt already exists/,
  );
  assert.equal(await readFile(checksumPath, "utf8"), "pre-existing\n");
});

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function createFixture(
  t: { after: (callback: () => void | Promise<void>) => void },
  files: Record<string, Buffer>,
): Promise<{ root: string; projectRoot: string; releaseDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), "release-artifacts-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const releaseDirectory = join(root, "release");
  await mkdir(projectRoot);
  await mkdir(releaseDirectory);
  await writeFile(join(projectRoot, "package.json"), JSON.stringify(manifest));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(releaseDirectory, name), contents);
  }
  return { root, projectRoot, releaseDirectory };
}
