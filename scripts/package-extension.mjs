import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getRuntimeLibcMetadata,
  packageExtension,
  validatePackageTarget,
} from "./package-target.mjs";
import { verifyVsix } from "./vsix-verifier.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf8"),
);
const hostTarget = `${process.platform}-${process.arch}`;
const target = validatePackageTarget({
  hostTarget,
  target: process.argv[2] ?? hostTarget,
  runtimeLibc: getRuntimeLibcMetadata(),
});
const npmCliPath = process.env.npm_execpath;
const vsceCliPath = resolve(projectRoot, "node_modules/@vscode/vsce/vsce");

if (!npmCliPath) {
  throw new Error("Run this packaging script through npm so npm_execpath is available.");
}

const vsixPath = await packageExtension({
  projectRoot,
  manifest: packageJson,
  target,
  npmCliPath,
  vsceCliPath,
  run,
  verifyVsix,
});
console.log(`Verified ${vsixPath}`);

function run(command, args, { cwd = projectRoot, env } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      ...(env ? { env } : {}),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolveRun();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${exitCode}`));
    });
  });
}
