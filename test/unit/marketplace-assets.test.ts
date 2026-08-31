import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packagePath = resolve(repositoryRoot, "package.json");
const iconSourcePath = resolve(repositoryRoot, "assets/marketplace-icon.svg");
const iconPath = resolve(repositoryRoot, "media/icon.png");
const generatorPath = resolve(repositoryRoot, "scripts/generate-marketplace-icon.mjs");

test("declares the deterministic Marketplace icon generator", async () => {
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    scripts?: Record<string, string | undefined>;
  };

  assert.equal(
    manifest.scripts?.["generate:icon"],
    "node scripts/generate-marketplace-icon.mjs",
  );
});

test("ships the approved 128 by 128 Signal Switch icon", async () => {
  const source = await readFile(iconSourcePath, "utf8");
  assert.match(source, /Lucide.*ISC/iu);
  assert.match(source, /#151515/iu);
  assert.match(source, /#f7f7f2/iu);
  assert.match(source, /#b7f34b/iu);
  assert.match(source, /#ff664d/iu);

  const png = await readFile(iconPath);
  assert.deepEqual(
    png.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.readUInt32BE(16), 128);
  assert.equal(png.readUInt32BE(20), 128);
});

test("regenerates the checked-in Marketplace icon byte for byte", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "marketplace-icon-"));
  const outputPath = join(temporaryDirectory, "icon.png");

  try {
    const generator = (await import(pathToFileURL(generatorPath).href)) as {
      generateMarketplaceIcon(options: {
        sourcePath: string;
        outputPath: string;
      }): Promise<void>;
    };
    await generator.generateMarketplaceIcon({
      sourcePath: iconSourcePath,
      outputPath,
    });

    assert.deepEqual(await readFile(outputPath), await readFile(iconPath));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
