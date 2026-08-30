import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checksumName = "SHA256SUMS.txt";

export async function stageReleaseArtifacts({
  projectRoot,
  releaseDirectory,
  tag,
}) {
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
  const entries = (await readdir(releaseDirectory)).sort();

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
    const stats = await lstat(assetPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(
        `Release artifact must be a regular non-symlink file: ${assetName}.`,
      );
    }
    if (stats.size === 0) {
      throw new Error(`Release artifact must be non-empty: ${assetName}.`);
    }

    const contents = await readFile(assetPath);
    const checksum = createHash("sha256").update(contents).digest("hex");
    checksums.set(assetName, checksum);
  }

  const checksumPath = join(releaseDirectory, checksumName);
  const checksumContents = `${assetNames
    .map((assetName) => `${checksums.get(assetName)}  ${assetName}`)
    .join("\n")}\n`;
  await writeFile(checksumPath, checksumContents, { flag: "wx" });

  return {
    assetNames: [...assetNames, checksumName],
    checksumPath,
  };
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
