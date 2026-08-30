import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checksumName = "SHA256SUMS.txt";
const artifactStatFields = ["dev", "ino", "size", "mtimeMs", "ctimeMs", "birthtimeMs"];
const defaultFsOps = { lstat, open, readdir, rename, rm, writeFile };

export async function stageReleaseArtifacts({
  projectRoot,
  releaseDirectory,
  tag,
  fsOps = {},
}) {
  const operations = { ...defaultFsOps, ...fsOps };
  const manifest = JSON.parse(
    await readFile(resolve(projectRoot, "package.json"), "utf8"),
  );
  const expectedTag = `v${manifest.version}`;
  if (tag !== expectedTag) {
    throw new Error(`Release tag must exactly match ${expectedTag}.`);
  }

  const assetNames = [
    `${manifest.name}-${manifest.version}@linux-x64.vsix`,
    `${manifest.name}-${manifest.version}@win32-x64.vsix`,
  ].sort();
  const entries = (await operations.readdir(releaseDirectory)).sort();

  if (entries.includes(checksumName)) {
    throw new Error(`${checksumName} already exists.`);
  }

  const missing = assetNames.filter((name) => !entries.includes(name));
  const unexpected = entries.filter((name) => !assetNames.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [];
    if (missing.length > 0) {
      details.push(`missing: ${missing.join(", ")}`);
    }
    if (unexpected.length > 0) {
      details.push(`unexpected release entries: ${unexpected.join(", ")}`);
    }
    throw new Error(
      `Release directory must contain exactly the two target VSIX files (${details.join("; ")}).`,
    );
  }

  const checksums = new Map();
  for (const assetName of assetNames) {
    const assetPath = join(releaseDirectory, assetName);
    const contents = await readReleaseArtifact({
      assetName,
      assetPath,
      fsOps: operations,
    });
    const checksum = createHash("sha256").update(contents).digest("hex");
    checksums.set(assetName, checksum);
  }

  const checksumPath = join(releaseDirectory, checksumName);
  const checksumContents = `${assetNames
    .map((assetName) => `${checksums.get(assetName)}  ${assetName}`)
    .join("\n")}\n`;
  await writeChecksumFile({
    checksumPath,
    checksumContents,
    fsOps: operations,
  });

  return {
    assetNames: [...assetNames, checksumName],
    checksumPath,
  };
}

async function readReleaseArtifact({ assetName, assetPath, fsOps }) {
  const pathStats = await fsOps.lstat(assetPath);
  assertRegularNonEmptyArtifact(pathStats, assetName);

  const noFollowFlag = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const fileHandle = await fsOps.open(assetPath, constants.O_RDONLY | noFollowFlag);
  try {
    const openedStats = await fileHandle.stat();
    assertRegularNonEmptyArtifact(openedStats, assetName);
    assertSameArtifactStats(pathStats, openedStats, assetName, "between path and opened handle");

    const contents = await fileHandle.readFile();
    const finalStats = await fileHandle.stat();
    assertSameArtifactStats(openedStats, finalStats, assetName, "while being read");
    if (contents.byteLength !== openedStats.size) {
      throw new Error(`Release artifact changed while being read: ${assetName}.`);
    }
    return contents;
  } finally {
    await fileHandle.close();
  }
}

function assertRegularNonEmptyArtifact(stats, assetName) {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(
      `Release artifact must be a regular non-symlink file: ${assetName}.`,
    );
  }
  if (stats.size === 0) {
    throw new Error(`Release artifact must be non-empty: ${assetName}.`);
  }
}

function assertSameArtifactStats(before, after, assetName, phase) {
  if (artifactStatFields.some((field) => before[field] !== after[field])) {
    throw new Error(`Release artifact changed ${phase}: ${assetName}.`);
  }
}

async function writeChecksumFile({ checksumPath, checksumContents, fsOps }) {
  const temporaryPath = join(
    dirname(checksumPath),
    `.${checksumName}.${randomUUID()}.tmp`,
  );
  try {
    await fsOps.writeFile(temporaryPath, checksumContents, { flag: "wx" });
    await fsOps.rename(temporaryPath, checksumPath);
  } catch (error) {
    try {
      await fsOps.rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Failed to publish ${checksumName} and remove its temporary file.`,
      );
    }
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    throw new Error(
      "Usage: node scripts/release-artifacts.mjs <releaseDirectory> <tag>",
    );
  }

  const [releaseDirectory, tag] = args;
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await stageReleaseArtifacts({
    projectRoot,
    releaseDirectory,
    tag,
  });
  process.stdout.write(`${result.assetNames.join("\n")}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
