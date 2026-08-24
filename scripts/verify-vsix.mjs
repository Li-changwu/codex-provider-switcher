import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf8"),
);
const vsixPath = resolve(
  projectRoot,
  `${packageJson.name}-${packageJson.version}.vsix`,
);

const entries = await readZipEntries(vsixPath);
const requiredEntries = [
  "extension/package.json",
  "extension/dist/extension.js",
];

for (const entry of requiredEntries) {
  if (!entries.has(entry)) {
    throw new Error(`VSIX is missing required entry: ${entry}`);
  }
}

const sqlitePrefix = "extension/node_modules/@vscode/sqlite3/";
if (![...entries].some((entry) => entry.startsWith(sqlitePrefix))) {
  throw new Error(`VSIX is missing runtime dependency directory: ${sqlitePrefix}`);
}

console.log(`Verified ${vsixPath}`);
console.log(`Verified ${entries.size} VSIX entries including runtime SQLite`);

function readZipEntries(path) {
  return new Promise((resolveEntries, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }

      const entries = new Set();
      zipFile.on("error", reject);
      zipFile.on("entry", (entry) => {
        entries.add(entry.fileName.replaceAll("\\", "/"));
        zipFile.readEntry();
      });
      zipFile.on("end", () => resolveEntries(entries));
      zipFile.readEntry();
    });
  });
}
