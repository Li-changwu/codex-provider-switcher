import assert from "node:assert/strict";
import test from "node:test";
import {
  requiredVsixName,
  vsceVsixName,
} from "../../scripts/package-target.mjs";
import * as packageTarget from "../../scripts/package-target.mjs";
import { resolve } from "node:path";

type PackageTargetValidator = (input: {
  hostTarget: string;
  target: string;
  runtimeLibc?: { glibcVersionRuntime?: string };
}) => string;

const validatePackageTarget = packageTarget.validatePackageTarget as
  | PackageTargetValidator
  | undefined;
type PackageExtension = (input: {
  projectRoot: string;
  manifest: { name: string; version: string };
  target: string;
  npmCliPath: string;
  vsceCliPath: string;
  run: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => Promise<void>;
  verifyVsix: (path: string, options?: { target?: string }) => Promise<unknown>;
  runProductionAudit?: RunProductionAudit;
  prepareLinuxPrebuild?: (input: {
    projectRoot: string;
    nodePath: string;
    run: (
      command: string,
      args: string[],
      options?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => Promise<void>;
  }) => Promise<string>;
  fsOps: {
    rm: (path: string, options: { force: boolean }) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
  };
}) => Promise<string>;
const packageExtension = packageTarget.packageExtension as PackageExtension | undefined;

type PrepareLinuxSqlitePrebuild = (input: {
  projectRoot: string;
  nodePath: string;
  prebuildInstallCliPath: string;
  getOfficialPrebuildUrl?: () => string;
  sourceEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fsOps?: PrebuildFileSystem;
  run: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => Promise<void>;
  findNativeBinding: (packagePath: string) => Promise<string | undefined>;
}) => Promise<string>;
const prepareLinuxSqlitePrebuild = packageTarget.prepareLinuxSqlitePrebuild as
  | PrepareLinuxSqlitePrebuild
  | undefined;

type PrebuildFileSystem = {
  mkdtemp: (prefix: string) => Promise<string>;
  rm: (
    path: string,
    options: { recursive: boolean; force: boolean },
  ) => Promise<void>;
};

type RunProductionAudit = (input: {
  projectRoot: string;
  nodePath: string;
  npmCliPath: string;
  run: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => Promise<void>;
  sourceEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fsOps?: PrebuildFileSystem;
}) => Promise<void>;
const runProductionAudit = packageTarget.runProductionAudit as
  | RunProductionAudit
  | undefined;

type CreateLinuxPrebuildEnvironment = (input: {
  sourceEnv: NodeJS.ProcessEnv;
  cachePath: string;
  platform: NodeJS.Platform;
}) => NodeJS.ProcessEnv;
const createLinuxPrebuildEnvironment = packageTarget.createLinuxPrebuildEnvironment as
  | CreateLinuxPrebuildEnvironment
  | undefined;

type GetOfficialLinuxSqlitePrebuildUrl = (input: {
  sqliteVersion: string;
  napiVersions: number[];
  nodeNapiVersion: string;
}) => string;
const getOfficialLinuxSqlitePrebuildUrl = packageTarget.getOfficialLinuxSqlitePrebuildUrl as
  | GetOfficialLinuxSqlitePrebuildUrl
  | undefined;

test("maps VS Code packaging output to the required target-suffixed artifact", () => {
  assert.equal(
    vsceVsixName("codex-provider-switcher", "0.1.0", "win32-x64"),
    "codex-provider-switcher-win32-x64-0.1.0.vsix",
  );
  assert.equal(
    requiredVsixName("codex-provider-switcher", "0.1.0", "win32-x64"),
    "codex-provider-switcher-0.1.0@win32-x64.vsix",
  );
});

test("rejects a Linux target from a Windows host", () => {
  assert.equal(typeof validatePackageTarget, "function");
  assert.throws(
    () => validatePackageTarget!({ hostTarget: "win32-x64", target: "linux-x64" }),
    /Cannot package linux-x64 from win32-x64/,
  );
});

test("rejects an unsupported package target", () => {
  assert.equal(typeof validatePackageTarget, "function");
  assert.throws(
    () => validatePackageTarget!({ hostTarget: "win32-x64", target: "darwin-arm64" }),
    /Unsupported package target: darwin-arm64/,
  );
});

test("accepts a generic Linux package target only with glibc runtime metadata", () => {
  assert.equal(typeof validatePackageTarget, "function");
  assert.equal(
    validatePackageTarget!({
      hostTarget: "linux-x64",
      target: "linux-x64",
      runtimeLibc: { glibcVersionRuntime: "2.31" },
    }),
    "linux-x64",
  );
});

test("rejects a generic Linux package target from a musl runtime", () => {
  assert.equal(typeof validatePackageTarget, "function");
  assert.throws(
    () =>
      validatePackageTarget!({
        hostTarget: "linux-x64",
        target: "linux-x64",
        runtimeLibc: {},
      }),
    /Cannot package linux-x64 without a glibc runtime/,
  );
});

test("derives the exact official sqlite3 linux-x64 N-API asset URL", () => {
  assert.equal(typeof getOfficialLinuxSqlitePrebuildUrl, "function");
  assert.equal(
    getOfficialLinuxSqlitePrebuildUrl!({
      sqliteVersion: "6.0.1",
      napiVersions: [3, 6],
      nodeNapiVersion: "10",
    }),
    "https://github.com/TryGhost/node-sqlite3/releases/download/v6.0.1/sqlite3-v6.0.1-napi-v6-linux-x64.tar.gz",
  );
});

test("creates a TLS-verified, injection-free Linux prebuild environment", () => {
  assert.equal(typeof createLinuxPrebuildEnvironment, "function");
  const cachePath = resolve("isolated-prebuild-cache");
  const environment = createLinuxPrebuildEnvironment!({
    sourceEnv: sourcePrebuildEnvironment(),
    cachePath,
    platform: "win32",
  });

  assert.deepEqual(environment, expectedPrebuildEnvironment(cachePath));
  for (const forbiddenKey of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_COMPILE_CACHE",
    "NODE_V8_COVERAGE",
    "NODE_REPL_EXTERNAL_MODULE",
    "npm_config_sqlite3_binary_host",
    "npm_config_sqlite3_binary_host_mirror",
    "npm_config_sqlite3_local_prebuilds",
    "npm_config_download",
    "npm_config_registry",
    "npm_config_strict_ssl",
    "NPM_CONFIG_CACHE",
  ]) {
    assert.equal(environment[forbiddenKey], undefined, forbiddenKey);
  }
});

test("runs the production audit with a trusted registry and isolated cache", async () => {
  assert.equal(typeof runProductionAudit, "function");
  const projectRoot = resolve("production-audit-success");
  const cachePath = resolve(projectRoot, "isolated-audit-cache");
  const auditFileSystem = fakePrebuildFileSystem(cachePath);
  const calls: Array<{
    command: string;
    args: string[];
    options?: { cwd?: string; env?: NodeJS.ProcessEnv };
  }> = [];

  await runProductionAudit!({
    projectRoot,
    nodePath: "node",
    npmCliPath: "npm-cli.js",
    sourceEnv: sourcePrebuildEnvironment(),
    platform: "win32",
    fsOps: auditFileSystem,
    run: async (command, args, options) => {
      calls.push({ command, args, options });
    },
  });

  assert.deepEqual(calls, [
    {
      command: "node",
      args: [
        "npm-cli.js",
        "audit",
        "--omit=dev",
        "--json",
        "--registry",
        "https://registry.npmjs.org/",
        "--strict-ssl",
        "true",
        "--cache",
        cachePath,
      ],
      options: {
        cwd: projectRoot,
        env: expectedPrebuildEnvironment(cachePath),
      },
    },
  ]);
  assert.deepEqual(auditFileSystem.removed, [cachePath]);
});

test("cleans the isolated audit cache when the production audit fails", async () => {
  assert.equal(typeof runProductionAudit, "function");
  const projectRoot = resolve("production-audit-failure");
  const cachePath = resolve(projectRoot, "isolated-audit-cache");
  const auditFileSystem = fakePrebuildFileSystem(cachePath);

  await assert.rejects(
    runProductionAudit!({
      projectRoot,
      nodePath: "node",
      npmCliPath: "npm-cli.js",
      sourceEnv: sourcePrebuildEnvironment(),
      platform: "win32",
      fsOps: auditFileSystem,
      run: async () => {
        throw new Error("audit failed");
      },
    }),
    /Production dependency audit failed: audit failed/,
  );

  assert.deepEqual(auditFileSystem.removed, [cachePath]);
});

test("fails closed when the isolated audit cache cannot be removed", async () => {
  assert.equal(typeof runProductionAudit, "function");
  const projectRoot = resolve("production-audit-cache-cleanup-failure");
  const cachePath = resolve(projectRoot, "isolated-audit-cache");
  const auditFileSystem = fakePrebuildFileSystem(cachePath, [cachePath]);

  await assert.rejects(
    runProductionAudit!({
      projectRoot,
      nodePath: "node",
      npmCliPath: "npm-cli.js",
      sourceEnv: sourcePrebuildEnvironment(),
      platform: "win32",
      fsOps: auditFileSystem,
      run: async () => undefined,
    }),
    /Unable to remove temporary npm audit cache/,
  );

  assert.deepEqual(auditFileSystem.removed, [cachePath]);
});

test("prepares sqlite3 with the pinned local Linux x64 N-API prebuild installer", async () => {
  assert.equal(typeof prepareLinuxSqlitePrebuild, "function");
  const projectRoot = resolve("linux-prebuild-success");
  const sqlitePackagePath = resolve(projectRoot, "node_modules/sqlite3");
  const staleBuildPath = resolve(sqlitePackagePath, "build");
  const nativeBindingPath = resolve(sqlitePackagePath, "build/Release/node_sqlite3.node");
  const cachePath = resolve(projectRoot, "isolated-prebuild-cache");
  const prebuildFileSystem = fakePrebuildFileSystem(cachePath);
  const calls: Array<{
    command: string;
    args: string[];
    options?: { cwd?: string; env?: NodeJS.ProcessEnv };
  }> = [];

  const result = await prepareLinuxSqlitePrebuild!({
    projectRoot,
    nodePath: "node",
    prebuildInstallCliPath: "pinned-prebuild-install.js",
    getOfficialPrebuildUrl: () =>
      "https://github.com/TryGhost/node-sqlite3/releases/download/v6.0.1/sqlite3-v6.0.1-napi-v6-linux-x64.tar.gz",
    sourceEnv: sourcePrebuildEnvironment(),
    platform: "win32",
    fsOps: prebuildFileSystem,
    run: async (command, args, options) => {
      assert.deepEqual(prebuildFileSystem.removed, [staleBuildPath]);
      calls.push({ command, args, options });
    },
    findNativeBinding: async (packagePath) => {
      assert.equal(packagePath, sqlitePackagePath);
      return nativeBindingPath;
    },
  });

  assert.equal(result, nativeBindingPath);
  assert.deepEqual(calls, [
    {
      command: "node",
      args: [
        "pinned-prebuild-install.js",
        "--runtime",
        "napi",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--libc",
        "glibc",
        "--download",
        "https://github.com/TryGhost/node-sqlite3/releases/download/v6.0.1/sqlite3-v6.0.1-napi-v6-linux-x64.tar.gz",
        "--nolocal",
      ],
      options: {
        cwd: sqlitePackagePath,
        env: expectedPrebuildEnvironment(cachePath),
      },
    },
  ]);
  assert.deepEqual(prebuildFileSystem.removed, [staleBuildPath, cachePath]);
});

test("fails closed when the Linux sqlite3 N-API prebuild is unavailable without node-gyp fallback", async () => {
  assert.equal(typeof prepareLinuxSqlitePrebuild, "function");
  const projectRoot = resolve("linux-prebuild-unavailable");
  const sqlitePackagePath = resolve(projectRoot, "node_modules/sqlite3");
  const cachePath = resolve(projectRoot, "isolated-prebuild-cache");
  const prebuildFileSystem = fakePrebuildFileSystem(cachePath);
  const calls: string[][] = [];

  await assert.rejects(
    prepareLinuxSqlitePrebuild!({
      projectRoot,
      nodePath: "node",
      prebuildInstallCliPath: "pinned-prebuild-install.js",
      getOfficialPrebuildUrl: () =>
        "https://github.com/TryGhost/node-sqlite3/releases/download/v6.0.1/sqlite3-v6.0.1-napi-v6-linux-x64.tar.gz",
      sourceEnv: sourcePrebuildEnvironment(),
      platform: "win32",
      fsOps: prebuildFileSystem,
      run: async (_command, args) => {
        calls.push(args);
        throw new Error("no official prebuild is available");
      },
      findNativeBinding: async () => {
        throw new Error("findNativeBinding must not run after download failure");
      },
    }),
    /Unable to prepare the official sqlite3 linux-x64 N-API prebuild: no official prebuild is available/,
  );

  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("--runtime"));
  assert.ok(!calls.flat().some((argument) => argument.includes("node-gyp")));
  assert.deepEqual(prebuildFileSystem.removed, [
    resolve(sqlitePackagePath, "build"),
    cachePath,
  ]);
});

test("fails closed when the isolated Linux prebuild cache cannot be removed", async () => {
  assert.equal(typeof prepareLinuxSqlitePrebuild, "function");
  const projectRoot = resolve("linux-prebuild-cache-cleanup-failure");
  const sqlitePackagePath = resolve(projectRoot, "node_modules/sqlite3");
  const cachePath = resolve(projectRoot, "isolated-prebuild-cache");
  const prebuildFileSystem = fakePrebuildFileSystem(cachePath, [cachePath]);

  await assert.rejects(
    prepareLinuxSqlitePrebuild!({
      projectRoot,
      nodePath: "node",
      prebuildInstallCliPath: "pinned-prebuild-install.js",
      getOfficialPrebuildUrl: () =>
        "https://github.com/TryGhost/node-sqlite3/releases/download/v6.0.1/sqlite3-v6.0.1-napi-v6-linux-x64.tar.gz",
      sourceEnv: sourcePrebuildEnvironment(),
      platform: "win32",
      fsOps: prebuildFileSystem,
      run: async () => undefined,
      findNativeBinding: async () =>
        resolve(sqlitePackagePath, "build/Release/node_sqlite3.node"),
    }),
    /Unable to remove temporary SQLite prebuild cache/,
  );

  assert.deepEqual(prebuildFileSystem.removed, [
    resolve(sqlitePackagePath, "build"),
    cachePath,
  ]);
});

test("runs Linux prebuild preparation before binding verification", async () => {
  assert.equal(typeof packageExtension, "function");
  const projectRoot = resolve("package-linux-prebuild-success");
  const paths = artifactPaths(projectRoot, "linux-x64");
  const fileSystem = fakeFileSystem([]);
  const lifecycle: string[] = [];

  await packageExtension!({
    projectRoot,
    manifest: { name: "codex-provider-switcher", version: "0.1.0" },
    target: "linux-x64",
    npmCliPath: "npm-cli.js",
    vsceCliPath: "vsce.js",
    run: async (_command, args) => {
      lifecycle.push(args.slice(1, 3).join(" "));
      const outputIndex = args.indexOf("--out");
      if (outputIndex >= 0) {
        fileSystem.files.add(args[outputIndex + 1]);
      }
    },
    prepareLinuxPrebuild: async () => {
      lifecycle.push("prepare-linux-prebuild");
      return "sqlite3.node";
    },
    verifyVsix: async () => {
      lifecycle.push("verify-vsix");
    },
    fsOps: fileSystem,
  });

  assert.deepEqual(lifecycle, [
    "run check",
    "run build",
    "prepare-linux-prebuild",
    "run verify:binding",
    "audit --omit=dev",
    "package --target",
    "verify-vsix",
  ]);
});

test("runs the Windows addon build before packaging preflight and never on Linux", async () => {
  assert.equal(typeof packageExtension, "function");
  const manifest = { name: "codex-provider-switcher", version: "0.1.0" };
  const windowsFileSystem = fakeFileSystem([]);
  const linuxFileSystem = fakeFileSystem([]);
  const windowsLifecycle: string[] = [];
  const linuxLifecycle: string[] = [];

  await packageExtension!({
    projectRoot: resolve("package-windows-addon-build"),
    manifest,
    target: "win32-x64",
    npmCliPath: "npm-cli.js",
    vsceCliPath: "vsce.js",
    run: async (_command, args) => {
      windowsLifecycle.push(args.slice(1, 3).join(" "));
      const outputIndex = args.indexOf("--out");
      if (outputIndex >= 0) {
        windowsFileSystem.files.add(args[outputIndex + 1]);
      }
    },
    verifyVsix: async () => undefined,
    fsOps: windowsFileSystem,
  });
  await packageExtension!({
    projectRoot: resolve("package-linux-addon-build-bypass"),
    manifest,
    target: "linux-x64",
    npmCliPath: "npm-cli.js",
    vsceCliPath: "vsce.js",
    run: async (_command, args) => {
      linuxLifecycle.push(args.slice(1, 3).join(" "));
      const outputIndex = args.indexOf("--out");
      if (outputIndex >= 0) {
        linuxFileSystem.files.add(args[outputIndex + 1]);
      }
    },
    prepareLinuxPrebuild: async () => "sqlite3.node",
    verifyVsix: async () => undefined,
    fsOps: linuxFileSystem,
  });

  assert.deepEqual(windowsLifecycle.slice(0, 3), [
    "run build:windows-file-ops",
    "run check",
    "run build",
  ]);
  assert.ok(!linuxLifecycle.includes("run build:windows-file-ops"));
});

test("does not prepare a Linux prebuild when packaging Windows", async () => {
  assert.equal(typeof packageExtension, "function");
  const projectRoot = resolve("package-windows-prebuild-bypass");
  const paths = artifactPaths(projectRoot);
  const fileSystem = fakeFileSystem([]);
  let preparedLinuxPrebuild = false;

  await packageExtension!({
    projectRoot,
    manifest: { name: "codex-provider-switcher", version: "0.1.0" },
    target: "win32-x64",
    npmCliPath: "npm-cli.js",
    vsceCliPath: "vsce.js",
    run: async (_command, args) => {
      const outputIndex = args.indexOf("--out");
      if (outputIndex >= 0) {
        fileSystem.files.add(args[outputIndex + 1]);
      }
    },
    prepareLinuxPrebuild: async () => {
      preparedLinuxPrebuild = true;
      return "sqlite3.node";
    },
    verifyVsix: async () => undefined,
    fsOps: fileSystem,
  });

  assert.equal(preparedLinuxPrebuild, false);
  assert.deepEqual(fileSystem.files, new Set([paths.final]));
});

test("stops Linux packaging before SQLite preflight when its prebuild is unavailable", async () => {
  assert.equal(typeof packageExtension, "function");
  const projectRoot = resolve("package-linux-prebuild-failure");
  const paths = artifactPaths(projectRoot, "linux-x64");
  const fileSystem = fakeFileSystem([paths.final]);
  const commands: string[][] = [];

  await assert.rejects(
    packageExtension!({
      projectRoot,
      manifest: { name: "codex-provider-switcher", version: "0.1.0" },
      target: "linux-x64",
      npmCliPath: "npm-cli.js",
      vsceCliPath: "vsce.js",
      run: async (_command, args) => {
        commands.push(args);
      },
      prepareLinuxPrebuild: async () => {
        throw new Error("official Linux prebuild unavailable");
      },
      verifyVsix: async () => undefined,
      fsOps: fileSystem,
    }),
    /official Linux prebuild unavailable/,
  );

  assert.deepEqual(
    commands.map((args) => args.slice(1, 3).join(" ")),
    ["run check", "run build"],
  );
  assert.ok(!commands.flat().some((argument) => argument.includes("node-gyp")));
  assert.deepEqual(fileSystem.files, new Set());
});

test("publishes only the verified target artifact after cleaning stale outputs", async () => {
  assert.equal(typeof packageExtension, "function");
  const projectRoot = resolve("package-orchestration-success");
  const paths = artifactPaths(projectRoot);
  const fileSystem = fakeFileSystem([paths.legacy, paths.final, paths.temporary, paths.vsce]);
  let verifiedPath: string | undefined;

  const result = await packageExtension!({
    projectRoot,
    manifest: { name: "codex-provider-switcher", version: "0.1.0" },
    target: "win32-x64",
    npmCliPath: "npm-cli.js",
    vsceCliPath: "vsce.js",
    run: async (_command, args) => {
      const outputIndex = args.indexOf("--out");
      if (outputIndex >= 0) {
        fileSystem.files.add(args[outputIndex + 1]);
      }
    },
    verifyVsix: async (path) => {
      verifiedPath = path;
    },
    fsOps: fileSystem,
  });

  assert.equal(result, paths.final);
  assert.equal(verifiedPath, paths.temporary);
  assert.deepEqual(fileSystem.files, new Set([paths.final]));
  for (const stalePath of [paths.legacy, paths.final, paths.temporary, paths.vsce]) {
    assert.ok(fileSystem.removed.includes(stalePath));
  }
});

test("verifies a package with its target-specific payload rules", async () => {
  assert.equal(typeof packageExtension, "function");
  const projectRoot = resolve("package-target-specific-verification");
  const paths = artifactPaths(projectRoot, "win32-x64");
  const fileSystem = fakeFileSystem([]);
  let verificationTarget: string | undefined;

  await packageExtension!({
    projectRoot,
    manifest: { name: "codex-provider-switcher", version: "0.1.0" },
    target: "win32-x64",
    npmCliPath: "npm-cli.js",
    vsceCliPath: "vsce.js",
    run: async (_command, args) => {
      const outputIndex = args.indexOf("--out");
      if (outputIndex >= 0) {
        fileSystem.files.add(args[outputIndex + 1]);
      }
    },
    verifyVsix: async (_path, options) => {
      verificationTarget = options?.target;
    },
    fsOps: fileSystem,
  });

  assert.equal(verificationTarget, "win32-x64");
  assert.deepEqual(fileSystem.files, new Set([paths.final]));
});

test("removes temporary and target artifacts when verification fails", async () => {
  assert.equal(typeof packageExtension, "function");
  const projectRoot = resolve("package-orchestration-failure");
  const paths = artifactPaths(projectRoot);
  const fileSystem = fakeFileSystem([paths.final]);

  await assert.rejects(
    packageExtension!({
      projectRoot,
      manifest: { name: "codex-provider-switcher", version: "0.1.0" },
      target: "win32-x64",
      npmCliPath: "npm-cli.js",
      vsceCliPath: "vsce.js",
      run: async (_command, args) => {
        const outputIndex = args.indexOf("--out");
        if (outputIndex >= 0) {
          fileSystem.files.add(args[outputIndex + 1]);
        }
      },
      verifyVsix: async () => {
        throw new Error("verification failed");
      },
      fsOps: fileSystem,
    }),
    /verification failed/,
  );

  assert.deepEqual(fileSystem.files, new Set());
  assert.ok(fileSystem.removed.includes(paths.temporary));
  assert.ok(fileSystem.removed.includes(paths.final));
});

test("removes target artifacts when the production audit fails before packaging", async () => {
  assert.equal(typeof packageExtension, "function");
  const projectRoot = resolve("package-orchestration-audit-failure");
  const paths = artifactPaths(projectRoot);
  const fileSystem = fakeFileSystem([paths.final]);
  const commands: string[][] = [];

  await assert.rejects(
    packageExtension!({
      projectRoot,
      manifest: { name: "codex-provider-switcher", version: "0.1.0" },
      target: "win32-x64",
      npmCliPath: "npm-cli.js",
      vsceCliPath: "vsce.js",
      run: async (_command, args) => {
        commands.push(args);
        if (args[1] === "audit") {
          throw new Error("audit failed");
        }
      },
      verifyVsix: async () => undefined,
      fsOps: fileSystem,
    }),
    /audit failed/,
  );

  assert.deepEqual(
    commands.find((args) => args[1] === "audit")?.slice(0, 4),
    ["npm-cli.js", "audit", "--omit=dev", "--json"],
  );
  assert.deepEqual(fileSystem.files, new Set());
  assert.ok(fileSystem.removed.includes(paths.final));
  assert.ok(fileSystem.removed.includes(paths.temporary));
  assert.ok(!commands.some((args) => args.includes("--out")));
});

test("attempts every artifact cleanup path before reporting a cleanup failure", async () => {
  assert.equal(typeof packageExtension, "function");
  const projectRoot = resolve("package-orchestration-cleanup-failure");
  const paths = artifactPaths(projectRoot);
  const fileSystem = fakeFileSystem(
    [paths.legacy, paths.final, paths.temporary, paths.vsce],
    [paths.legacy],
  );
  const commands: string[][] = [];

  await assert.rejects(
    packageExtension!({
      projectRoot,
      manifest: { name: "codex-provider-switcher", version: "0.1.0" },
      target: "win32-x64",
      npmCliPath: "npm-cli.js",
      vsceCliPath: "vsce.js",
      run: async (_command, args) => {
        commands.push(args);
      },
      verifyVsix: async () => undefined,
      fsOps: fileSystem,
    }),
    /Artifact cleanup was incomplete: .*codex-provider-switcher-0\.1\.0\.vsix/,
  );

  for (const artifactPath of Object.values(paths)) {
    assert.ok(fileSystem.removeAttempts.includes(artifactPath));
  }
  assert.ok(fileSystem.files.has(paths.legacy));
  assert.ok(!fileSystem.files.has(paths.final));
  assert.ok(!fileSystem.files.has(paths.temporary));
  assert.ok(!fileSystem.files.has(paths.vsce));
  assert.deepEqual(commands, []);
});

function artifactPaths(projectRoot: string, target = "win32-x64") {
  return {
    legacy: resolve(projectRoot, "codex-provider-switcher-0.1.0.vsix"),
    final: resolve(projectRoot, `codex-provider-switcher-0.1.0@${target}.vsix`),
    temporary: resolve(projectRoot, `.codex-provider-switcher-0.1.0@${target}.vsix.verify`),
    vsce: resolve(projectRoot, `codex-provider-switcher-${target}-0.1.0.vsix`),
  };
}

function sourcePrebuildEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "safe-path",
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    TEMP: "C:\\Temp",
    HTTP_PROXY: "http://127.0.0.1:27890",
    HTTPS_PROXY: "http://127.0.0.1:27890",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NODE_OPTIONS: "--require injected.js",
    NODE_PATH: "injected-modules",
    NODE_COMPILE_CACHE: "injected-cache",
    NODE_V8_COVERAGE: "injected-coverage",
    NODE_REPL_EXTERNAL_MODULE: "injected-repl",
    npm_config_cache: "shared-cache",
    npm_config_sqlite3_binary_host: "https://untrusted.example",
    npm_config_sqlite3_binary_host_mirror: "https://untrusted.example",
    npm_config_sqlite3_local_prebuilds: "untrusted-prebuilds",
    npm_config_download: "https://untrusted.example/archive.tar.gz",
    npm_config_registry: "http://untrusted.example",
    npm_config_strict_ssl: "false",
    NPM_CONFIG_CACHE: "shared-uppercase-cache",
  };
}

function expectedPrebuildEnvironment(cachePath: string): NodeJS.ProcessEnv {
  return {
    PATH: "safe-path",
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    TEMP: "C:\\Temp",
    HTTP_PROXY: "http://127.0.0.1:27890",
    HTTPS_PROXY: "http://127.0.0.1:27890",
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
    npm_config_cache: cachePath,
  };
}

function fakePrebuildFileSystem(cachePath: string, failedRemovals: string[] = []) {
  const removed: string[] = [];
  const failedRemovalPaths = new Set(failedRemovals);
  const prefixes: string[] = [];
  return {
    removed,
    prefixes,
    mkdtemp: async (prefix: string) => {
      prefixes.push(prefix);
      return cachePath;
    },
    rm: async (path: string) => {
      removed.push(path);
      if (failedRemovalPaths.has(path)) {
        throw new Error(`simulated removal failure: ${path}`);
      }
    },
  };
}

function fakeFileSystem(initialFiles: string[], failedRemovals: string[] = []) {
  const files = new Set(initialFiles);
  const removed: string[] = [];
  const removeAttempts: string[] = [];
  const failedRemovalPaths = new Set(failedRemovals);
  return {
    files,
    removed,
    removeAttempts,
    rm: async (path: string) => {
      removeAttempts.push(path);
      if (failedRemovalPaths.has(path)) {
        throw new Error(`simulated removal failure: ${path}`);
      }
      removed.push(path);
      files.delete(path);
    },
    rename: async (from: string, to: string) => {
      assert.ok(files.delete(from), `Missing temporary artifact: ${from}`);
      files.add(to);
    },
  };
}
