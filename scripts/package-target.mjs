import { readFileSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { findNativeBinding } from "./sqlite-binding-utils.mjs";

const supportedTargets = new Set(["win32-x64", "linux-x64"]);
const WINDOWS_PREBUILD_ENV_KEYS = [
  "PATH",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "TEMP",
  "TMP",
];
const POSIX_PREBUILD_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TMP"];
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];
const PREBUILD_CACHE_PREFIX = join(tmpdir(), "codex-provider-switcher-sqlite3-prebuild-");
const AUDIT_CACHE_PREFIX = join(tmpdir(), "codex-provider-switcher-audit-");
const TRUSTED_NPM_REGISTRY = "https://registry.npmjs.org/";

export function validatePackageTarget({ hostTarget, target, runtimeLibc }) {
  if (!supportedTargets.has(target)) {
    throw new Error(`Unsupported package target: ${target}`);
  }
  if (target !== hostTarget) {
    throw new Error(
      `Cannot package ${target} from ${hostTarget}: sqlite3 must be installed on the matching target platform.`,
    );
  }
  if (target === "linux-x64" && !runtimeLibc?.glibcVersionRuntime) {
    throw new Error(
      "Cannot package linux-x64 without a glibc runtime: generic Linux artifacts cannot target musl.",
    );
  }

  return target;
}

export function getRuntimeLibcMetadata(report = process.report?.getReport?.()) {
  return {
    glibcVersionRuntime: report?.header?.glibcVersionRuntime,
  };
}

export function vsceVsixName(name, version, target) {
  return `${name}-${target}-${version}.vsix`;
}

export function requiredVsixName(name, version, target) {
  return `${name}-${version}@${target}.vsix`;
}

export function getOfficialLinuxSqlitePrebuildUrl({
  sqliteVersion,
  napiVersions,
  nodeNapiVersion = process.versions.napi,
}) {
  const supportedNodeNapiVersion = Number(nodeNapiVersion);
  const selectedNapiVersion = Math.max(
    ...napiVersions.filter(
      (napiVersion) =>
        Number.isInteger(napiVersion) && napiVersion <= supportedNodeNapiVersion,
    ),
  );
  if (!Number.isInteger(selectedNapiVersion)) {
    throw new Error(
      `sqlite3 ${sqliteVersion} has no N-API prebuild compatible with Node N-API ${nodeNapiVersion}.`,
    );
  }
  return `https://github.com/TryGhost/node-sqlite3/releases/download/v${sqliteVersion}/sqlite3-v${sqliteVersion}-napi-v${selectedNapiVersion}-linux-x64.tar.gz`;
}

export function createLinuxPrebuildEnvironment({
  sourceEnv = process.env,
  cachePath,
  platform = process.platform,
}) {
  const environment = {};
  const allowedKeys = [
    ...(platform === "win32" ? WINDOWS_PREBUILD_ENV_KEYS : POSIX_PREBUILD_ENV_KEYS),
    ...PROXY_ENV_KEYS,
  ];
  for (const key of allowedKeys) {
    if (sourceEnv[key] !== undefined) {
      environment[key] = sourceEnv[key];
    }
  }
  environment.NODE_TLS_REJECT_UNAUTHORIZED = "1";
  environment.npm_config_cache = cachePath;
  return environment;
}

export async function runProductionAudit({
  projectRoot,
  nodePath = process.execPath,
  npmCliPath,
  run,
  sourceEnv = process.env,
  platform = process.platform,
  fsOps = { mkdtemp, rm },
}) {
  let cachePath;
  try {
    cachePath = await fsOps.mkdtemp(AUDIT_CACHE_PREFIX);
  } catch (error) {
    throw new Error(
      `Unable to create temporary npm audit cache: ${error.message}`,
      { cause: error },
    );
  }

  let auditError;
  try {
    await run(
      nodePath,
      [
        npmCliPath,
        "audit",
        "--omit=dev",
        "--json",
        "--registry",
        TRUSTED_NPM_REGISTRY,
        "--strict-ssl",
        "true",
        "--cache",
        cachePath,
      ],
      {
        cwd: projectRoot,
        env: createLinuxPrebuildEnvironment({ sourceEnv, cachePath, platform }),
      },
    );
  } catch (error) {
    auditError = new Error(`Production dependency audit failed: ${error.message}`, {
      cause: error,
    });
  }

  try {
    await fsOps.rm(cachePath, { recursive: true, force: true });
  } catch (cleanupError) {
    const cacheCleanupError = new Error(
      `Unable to remove temporary npm audit cache: ${cleanupError.message}`,
      { cause: cleanupError },
    );
    if (auditError) {
      throw new AggregateError(
        [auditError, cacheCleanupError],
        `Production dependency audit failed and its temporary cache could not be removed: ${auditError.message}; ${cacheCleanupError.message}`,
      );
    }
    throw cacheCleanupError;
  }
  if (auditError) {
    throw auditError;
  }
}

export async function prepareLinuxSqlitePrebuild({
  projectRoot,
  nodePath = process.execPath,
  prebuildInstallCliPath = resolve(
    projectRoot,
    "node_modules/prebuild-install/bin.js",
  ),
  run,
  getOfficialPrebuildUrl = () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(projectRoot, "node_modules/sqlite3/package.json"), "utf8"),
    );
    return getOfficialLinuxSqlitePrebuildUrl({
      sqliteVersion: packageJson.version,
      napiVersions: packageJson.binary?.napi_versions ?? [],
    });
  },
  findNativeBinding: findInstalledNativeBinding = findNativeBinding,
  sourceEnv = process.env,
  platform = process.platform,
  fsOps = { mkdtemp, rm },
}) {
  const sqlitePackagePath = resolve(projectRoot, "node_modules/sqlite3");
  const staleBuildPath = resolve(sqlitePackagePath, "build");
  const prebuildUrl = getOfficialPrebuildUrl();
  const cachePath = await fsOps.mkdtemp(PREBUILD_CACHE_PREFIX);
  let nativeBindingPath;
  let operationError;

  try {
    await fsOps.rm(staleBuildPath, { recursive: true, force: true });
    await run(
      nodePath,
      [
        prebuildInstallCliPath,
        "--runtime",
        "napi",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--libc",
        "glibc",
        "--download",
        prebuildUrl,
        "--nolocal",
      ],
      {
        cwd: sqlitePackagePath,
        env: createLinuxPrebuildEnvironment({ sourceEnv, cachePath, platform }),
      },
    );
    nativeBindingPath = await findInstalledNativeBinding(sqlitePackagePath);
    if (!nativeBindingPath) {
      throw new Error(
        `Official sqlite3 linux-x64 N-API prebuild did not install a native binding under: ${sqlitePackagePath}`,
      );
    }
  } catch (error) {
    operationError = new Error(
      `Unable to prepare the official sqlite3 linux-x64 N-API prebuild: ${error.message}`,
      { cause: error },
    );
  }

  try {
    await fsOps.rm(cachePath, { recursive: true, force: true });
  } catch (cleanupError) {
    const cacheCleanupError = new Error(
      `Unable to remove temporary SQLite prebuild cache: ${cleanupError.message}`,
      { cause: cleanupError },
    );
    if (operationError) {
      throw new AggregateError(
        [operationError, cacheCleanupError],
        `Linux SQLite prebuild failed and its temporary cache could not be removed: ${operationError.message}; ${cacheCleanupError.message}`,
      );
    }
    throw cacheCleanupError;
  }
  if (operationError) {
    throw operationError;
  }
  return nativeBindingPath;
}

export async function packageExtension({
  projectRoot,
  manifest,
  target,
  npmCliPath,
  vsceCliPath,
  run,
  verifyVsix,
  prepareLinuxPrebuild = prepareLinuxSqlitePrebuild,
  runProductionAudit: auditProductionDependencies = runProductionAudit,
  fsOps = { rename, rm },
  nodePath = process.execPath,
}) {
  const artifacts = packageArtifactPaths(projectRoot, manifest, target);
  try {
    await removeArtifacts(artifacts, fsOps);
    if (target === "win32-x64") {
      await run(nodePath, [npmCliPath, "run", "build:windows-file-ops"]);
    }
    await run(nodePath, [npmCliPath, "run", "check"]);
    await run(nodePath, [npmCliPath, "run", "build"]);
    if (target === "linux-x64") {
      await prepareLinuxPrebuild({ projectRoot, nodePath, run });
    }
    await run(nodePath, [npmCliPath, "run", "verify:binding"]);
    await auditProductionDependencies({ projectRoot, nodePath, npmCliPath, run });
    await run(nodePath, [
      vsceCliPath,
      "package",
      "--target",
      target,
      "--out",
      artifacts.temporary,
    ]);
    await verifyVsix(artifacts.temporary, { target });
    await fsOps.rename(artifacts.temporary, artifacts.final);
    return artifacts.final;
  } catch (operationError) {
    try {
      await removeArtifacts(artifacts, fsOps);
    } catch (cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        `Artifact cleanup was incomplete: ${cleanupError.message}`,
      );
    }
    throw operationError;
  }
}

function packageArtifactPaths(projectRoot, manifest, target) {
  const requiredName = requiredVsixName(manifest.name, manifest.version, target);
  return {
    legacy: resolveArtifactPath(projectRoot, `${manifest.name}-${manifest.version}.vsix`),
    final: resolveArtifactPath(projectRoot, requiredName),
    temporary: resolveArtifactPath(projectRoot, `.${requiredName}.verify`),
    vsce: resolveArtifactPath(
      projectRoot,
      vsceVsixName(manifest.name, manifest.version, target),
    ),
  };
}

function resolveArtifactPath(projectRoot, artifactName) {
  const artifactPath = resolve(projectRoot, artifactName);
  const relativePath = relative(projectRoot, artifactPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Artifact path escapes project root: ${artifactName}`);
  }
  return artifactPath;
}

async function removeArtifacts(artifacts, fsOps) {
  const failures = [];
  for (const artifactPath of Object.values(artifacts)) {
    try {
      await fsOps.rm(artifactPath, { force: true });
    } catch (error) {
      failures.push({ artifactPath, error });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `Failed to remove package artifacts: ${failures
        .map(({ artifactPath }) => artifactPath)
        .join(", ")}`,
    );
  }
}
