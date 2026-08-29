import { spawn } from "node:child_process";
import { copyFile, lstat, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");

export async function buildWindowsFileOps(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  assertWindowsX64Host(platform, arch);

  const root = resolveProjectRoot(options.projectRoot ?? projectRoot);
  const nativeRoot = resolveUnder(root, "native", "windows-file-ops");
  const stagedAddonPath = resolveUnder(nativeRoot, "windows_file_ops.node");
  const buildPath = resolveUnder(nativeRoot, "build");
  const builtAddonPath = resolveUnder(
    buildPath,
    "Release",
    "windows_file_ops.node",
  );
  const nodeGypPath = resolveUnder(
    root,
    "node_modules",
    "node-gyp",
    "bin",
    "node-gyp.js",
  );
  const fsOps = options.fsOps ?? { copyFile, lstat, rm };
  const run = options.run ?? runProcess;

  await fsOps.rm(stagedAddonPath, { force: true });
  await fsOps.rm(buildPath, { force: true, recursive: true });
  await run(process.execPath, [nodeGypPath, "rebuild", "--directory", nativeRoot], {
    cwd: nativeRoot,
  });

  const builtAddon = await fsOps.lstat(builtAddonPath);
  if (!builtAddon.isFile()) {
    throw new Error(`node-gyp did not produce a regular addon: ${builtAddonPath}`);
  }
  await fsOps.copyFile(builtAddonPath, stagedAddonPath);
}

function assertWindowsX64Host(platform, arch) {
  if (platform !== "win32" || arch !== "x64") {
    throw new Error("Windows file-ops build requires a win32-x64 host.");
  }
}

function resolveProjectRoot(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error("Windows file-ops build requires an absolute project root.");
  }
  return resolve(value);
}

function resolveUnder(root, ...segments) {
  const target = resolve(root, ...segments);
  const targetRelative = relative(root, target);
  if (
    targetRelative.length === 0 ||
    targetRelative === ".." ||
    targetRelative.startsWith(`..${sep}`) ||
    isAbsolute(targetRelative)
  ) {
    throw new Error("Windows file-ops build resolved a path outside its project root.");
  }
  return target;
}

function runProcess(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          signal === null
            ? `node-gyp exited with code ${code}.`
            : `node-gyp terminated with signal ${signal}.`,
        ),
      );
    });
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  buildWindowsFileOps().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
