import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyVsix } from "./vsix-verifier.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf8"),
);
const target = `${process.platform}-${process.arch}`;
const vsixName =
  process.argv[2] ?? `${packageJson.name}-${packageJson.version}@${target}.vsix`;
const vsixPath = resolve(projectRoot, vsixName);

const entries = await verifyVsix(vsixPath, { target });
console.log(`Verified ${vsixPath}`);
console.log(`Verified ${entries.size} VSIX entries, native SQLite, and no source maps`);
