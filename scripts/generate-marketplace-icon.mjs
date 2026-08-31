import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");

export async function generateMarketplaceIcon({ sourcePath, outputPath }) {
  await mkdir(dirname(outputPath), { recursive: true });
  await sharp(sourcePath)
    .resize(128, 128, { fit: "fill" })
    .png({
      adaptiveFiltering: false,
      compressionLevel: 9,
      palette: false,
    })
    .toFile(outputPath);

  const metadata = await sharp(outputPath).metadata();
  if (metadata.format !== "png" || metadata.width !== 128 || metadata.height !== 128) {
    throw new Error("Marketplace icon must be a 128 by 128 PNG");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const sourcePath = resolve(repositoryRoot, "assets/marketplace-icon.svg");
  const outputPath = resolve(repositoryRoot, "media/icon.png");
  await generateMarketplaceIcon({ sourcePath, outputPath });
  console.log(relative(repositoryRoot, outputPath).replaceAll("\\", "/"));
}
