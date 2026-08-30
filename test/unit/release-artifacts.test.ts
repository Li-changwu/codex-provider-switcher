import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat as realLstat,
  mkdir,
  mkdtemp,
  open as realOpen,
  readFile,
  rm as realRm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stageReleaseArtifacts } from "../../scripts/release-artifacts.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(projectRoot, "scripts/release-artifacts.mjs");

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

test("CLI rejects missing and extra arguments with usage on stderr", async () => {
  for (const args of [[], ["release-directory", "v0.1.0", "extra"]]) {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, ...args], { cwd: projectRoot }),
      (error: unknown) => {
        const failure = error as { code?: number | string; stderr?: string };
        assert.notEqual(failure.code, 0);
        assert.match(failure.stderr ?? "", /Usage: node scripts\/release-artifacts\.mjs/);
        return true;
      },
    );
  }
});

test("CLI prints only sorted release asset names on success", async (t) => {
  const fixture = await createFixture(t, validFiles);
  const result = await execFileAsync(
    process.execPath,
    [cliPath, fixture.releaseDirectory, "v0.1.0"],
    { cwd: projectRoot },
  );

  assert.equal(result.stdout, `${linuxAsset}\n${windowsAsset}\nSHA256SUMS.txt\n`);
  assert.equal(result.stderr, "");
});

test("fails closed when the opened artifact identity differs from its path stat", async (t) => {
  const fixture = await createFixture(t, validFiles);
  let closed = false;
  let read = false;
  let observedFlags: number | undefined;

  await assert.rejects(
    stageReleaseArtifacts({
      projectRoot: fixture.projectRoot,
      releaseDirectory: fixture.releaseDirectory,
      tag: "v0.1.0",
      fsOps: {
        open: async (_path: string, flags: number) => {
          observedFlags = flags;
          return {
          stat: async () => ({
            dev: 1,
            ino: 2,
            size: validFiles[linuxAsset].byteLength,
            mtimeMs: 3,
            ctimeMs: 4,
            birthtimeMs: 5,
            isFile: () => true,
            isSymbolicLink: () => false,
          }),
          readFile: async () => {
            read = true;
            return validFiles[linuxAsset];
          },
          close: async () => {
            closed = true;
          },
          };
        },
      },
    }),
    /changed between path and opened handle/,
  );

  assert.equal(read, false);
  assert.equal(closed, true);
  assert.equal(
    observedFlags,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
  );
});

test("cleans the unique checksum temporary file when hard-link publish fails", async (t) => {
  const fixture = await createFixture(t, validFiles);
  const temporaryPaths: string[] = [];
  const removedPaths: string[] = [];

  await assert.rejects(
    stageReleaseArtifacts({
      projectRoot: fixture.projectRoot,
      releaseDirectory: fixture.releaseDirectory,
      tag: "v0.1.0",
      fsOps: {
        writeFile: async (path: string, contents: string, options: { flag: string }) => {
          temporaryPaths.push(path);
          return writeFile(path, contents, options);
        },
        link: async () => {
          throw new Error("hard-link publish failed");
        },
        rm: async (path: string, options: { force: boolean }) => {
          removedPaths.push(path);
          return realRm(path, options);
        },
      },
    }),
    /hard-link publish failed/,
  );

  assert.equal(temporaryPaths.length, 1);
  assert.deepEqual(removedPaths, temporaryPaths);
  await assert.rejects(realLstat(temporaryPaths[0]), { code: "ENOENT" });
  await assert.rejects(
    realLstat(join(fixture.releaseDirectory, "SHA256SUMS.txt")),
    { code: "ENOENT" },
  );
});

test("uses no-follow flags and canonical paths for real artifact opens", async (t) => {
  const fixture = await createFixture(t, validFiles);
  const observedFlags: number[] = [];
  const canonicalPathChecks: string[] = [];

  await stageReleaseArtifacts({
    projectRoot: fixture.projectRoot,
    releaseDirectory: fixture.releaseDirectory,
    tag: "v0.1.0",
    fsOps: {
      open: async (path: string, flags: number) => {
        observedFlags.push(flags);
        return realOpen(path, flags);
      },
      realpath: async (path: string) => {
        canonicalPathChecks.push(path);
        return path;
      },
    },
  });

  assert.deepEqual(observedFlags, [
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
  ]);
  if (process.platform === "win32") {
    assert.equal(canonicalPathChecks.length, 4);
  } else {
    assert.equal(canonicalPathChecks.length, 0);
  }
});

test("fails closed when a Windows artifact path changes after open", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows canonical-path replacement contract");
    return;
  }

  const fixture = await createFixture(t, validFiles);
  const canonicalPaths: string[] = [];
  let read = false;
  let closed = false;

  await assert.rejects(
    stageReleaseArtifacts({
      projectRoot: fixture.projectRoot,
      releaseDirectory: fixture.releaseDirectory,
      tag: "v0.1.0",
      fsOps: {
        realpath: async (path: string) => {
          canonicalPaths.push(path);
          return canonicalPaths.length === 1 ? path : `${path}.replaced`;
        },
        open: async (path: string) => {
          const stats = await realLstat(path);
          return {
            stat: async () => stats,
            readFile: async () => {
              read = true;
              return validFiles[linuxAsset];
            },
            close: async () => {
              closed = true;
            },
          };
        },
      },
    }),
    /Release artifact path is not canonical/,
  );

  assert.equal(canonicalPaths.length, 2);
  assert.equal(read, false);
  assert.equal(closed, true);
});

test("does not clobber a checksum created before hard-link publish", async (t) => {
  const fixture = await createFixture(t, validFiles);
  const checksumPath = join(fixture.releaseDirectory, "SHA256SUMS.txt");
  const temporaryPaths: string[] = [];
  const preexistingContents = "created concurrently\n";

  await assert.rejects(
    stageReleaseArtifacts({
      projectRoot: fixture.projectRoot,
      releaseDirectory: fixture.releaseDirectory,
      tag: "v0.1.0",
      fsOps: {
        writeFile: async (path: string, contents: string, options: { flag: string }) => {
          temporaryPaths.push(path);
          return writeFile(path, contents, options);
        },
        link: async (temporaryPath: string, finalPath: string) => {
          await writeFile(finalPath, preexistingContents, { flag: "wx" });
          const error = new Error("checksum target already exists");
          Object.assign(error, { code: "EEXIST" });
          throw error;
        },
      },
    }),
    /checksum target already exists/,
  );

  assert.equal(temporaryPaths.length, 1);
  assert.equal(await readFile(checksumPath, "utf8"), preexistingContents);
  await assert.rejects(realLstat(temporaryPaths[0]), { code: "ENOENT" });
});

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function createFixture(
  t: { after: (callback: () => void | Promise<void>) => void },
  files: Record<string, Buffer>,
): Promise<{ root: string; projectRoot: string; releaseDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), "release-artifacts-test-"));
  t.after(() => realRm(root, { recursive: true, force: true }));
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
