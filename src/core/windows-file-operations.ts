import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

const ADDON_PATH_SEGMENTS = ["native", "windows-file-ops", "windows_file_ops.node"] as const;
const VOLUME_SERIAL_PATTERN = /^[0-9a-f]{16}$/;
const FILE_ID_PATTERN = /^[0-9a-f]{32}$/;

export interface WindowsFileIdentity {
  readonly volumeSerial: string;
  readonly fileId: string;
  readonly linkCount: bigint;
}

export interface WindowsFileOperations {
  captureFileIdentity(path: string): WindowsFileIdentity;
  deleteFileIfMatches(
    path: string,
    expected: WindowsFileIdentity,
  ): "deleted" | "identity-mismatch";
  holdFileIfMatches(path: string, expected: WindowsFileIdentity): WindowsFileHold;
}

export interface WindowsFileHold {
  close(): void;
}

export type WindowsFileOperationsErrorCode =
  | "WINDOWS_FILE_OPERATIONS_UNAVAILABLE"
  | "WINDOWS_FILE_OPERATIONS_INVALID";

export class WindowsFileOperationsError extends Error {
  constructor(readonly code: WindowsFileOperationsErrorCode) {
    super(
      code === "WINDOWS_FILE_OPERATIONS_UNAVAILABLE"
        ? "Windows file operations are unavailable."
        : "Windows file operations received invalid data.",
    );
    this.name = "WindowsFileOperationsError";
  }
}

interface NativeWindowsFileOperationsBinding {
  captureFileIdentity(path: string): unknown;
  deleteFileIfMatches(path: string, expected: WindowsFileIdentity): unknown;
  holdFileIfMatches(path: string, expected: WindowsFileIdentity): unknown;
  releaseFileHold(hold: object): unknown;
}

interface WindowsFileOperationsDependencies {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly extensionRoot?: string;
  readonly loadBinding?: (addonPath: string) => unknown;
}

export function createWindowsFileOperations(
  dependencies: WindowsFileOperationsDependencies = {},
): WindowsFileOperations {
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  if (platform !== "win32" || arch !== "x64") {
    return unavailableOperations();
  }

  const extensionRoot = dependencies.extensionRoot ?? findExtensionRoot();
  const loadBinding = dependencies.loadBinding ?? loadNativeBinding;
  let binding: NativeWindowsFileOperationsBinding | undefined;

  function getBinding(): NativeWindowsFileOperationsBinding {
    if (binding !== undefined) {
      return binding;
    }

    const addonPath = resolveAddonPath(extensionRoot);
    let loaded: unknown;
    try {
      loaded = loadBinding(addonPath);
    } catch {
      throw unavailableError();
    }
    if (!isNativeBinding(loaded)) {
      throw invalidError();
    }

    binding = loaded;
    return binding;
  }

  return {
    captureFileIdentity(path): WindowsFileIdentity {
      assertWindowsPath(path);
      return validateIdentity(callBinding(getBinding, (native) => native.captureFileIdentity(path)));
    },

    deleteFileIfMatches(path, expected): "deleted" | "identity-mismatch" {
      assertWindowsPath(path);
      assertIdentity(expected);
      const result = callBinding(
        getBinding,
        (native) => native.deleteFileIfMatches(path, expected),
      );
      if (result !== "deleted" && result !== "identity-mismatch") {
        throw invalidError();
      }
      return result;
    },

    holdFileIfMatches(path, expected): WindowsFileHold {
      assertWindowsPath(path);
      assertIdentity(expected);
      const native = getBinding();
      const token = callBinding(
        () => native,
        (current) => current.holdFileIfMatches(path, expected),
      );
      if (!isObject(token)) {
        throw invalidError();
      }

      let closed = false;
      return {
        close(): void {
          if (closed) {
            return;
          }
          closed = true;
          callBinding(() => native, (current) => current.releaseFileHold(token));
        },
      };
    },
  };
}

function unavailableOperations(): WindowsFileOperations {
  const unavailable = (): never => {
    throw unavailableError();
  };

  return {
    captureFileIdentity: unavailable,
    deleteFileIfMatches: unavailable,
    holdFileIfMatches: unavailable,
  };
}

function resolveAddonPath(extensionRoot: string): string {
  if (
    typeof extensionRoot !== "string" ||
    extensionRoot.includes("\0") ||
    !isAbsolute(extensionRoot)
  ) {
    throw invalidError();
  }

  const resolvedRoot = resolve(extensionRoot);
  if (resolvedRoot !== extensionRoot) {
    throw invalidError();
  }
  const addonPath = resolve(resolvedRoot, ...ADDON_PATH_SEGMENTS);
  const addonRelativePath = relative(resolvedRoot, addonPath);
  if (
    addonRelativePath.length === 0 ||
    addonRelativePath === ".." ||
    addonRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(addonRelativePath)
  ) {
    throw invalidError();
  }
  return addonPath;
}

function assertWindowsPath(path: string): void {
  if (typeof path !== "string" || path.includes("\0") || !win32.isAbsolute(path)) {
    throw invalidError();
  }
}

function callBinding<T>(
  getBinding: () => NativeWindowsFileOperationsBinding,
  operation: (binding: NativeWindowsFileOperationsBinding) => T,
): T {
  try {
    return operation(getBinding());
  } catch (error: unknown) {
    if (error instanceof WindowsFileOperationsError) {
      throw error;
    }
    throw invalidError();
  }
}

function isNativeBinding(value: unknown): value is NativeWindowsFileOperationsBinding {
  if (!isObject(value)) {
    return false;
  }

  try {
    return typeof value.captureFileIdentity === "function" &&
      typeof value.deleteFileIfMatches === "function" &&
      typeof value.holdFileIfMatches === "function" &&
      typeof value.releaseFileHold === "function";
  } catch {
    return false;
  }
}

function validateIdentity(value: unknown): WindowsFileIdentity {
  if (!isObject(value)) {
    throw invalidError();
  }

  try {
    assertIdentity(value);
  } catch (error: unknown) {
    if (error instanceof WindowsFileOperationsError) {
      throw error;
    }
    throw invalidError();
  }
  return value;
}

function assertIdentity(value: unknown): asserts value is WindowsFileIdentity {
  if (
    !isObject(value) ||
    typeof value.volumeSerial !== "string" ||
    typeof value.fileId !== "string" ||
    !VOLUME_SERIAL_PATTERN.test(value.volumeSerial) ||
    !FILE_ID_PATTERN.test(value.fileId) ||
    value.linkCount !== 1n
  ) {
    throw invalidError();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findExtensionRoot(): string {
  let candidate = resolve(__dirname);
  for (;;) {
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      return resolve(__dirname, "..");
    }
    candidate = parent;
  }
}

function loadNativeBinding(addonPath: string): unknown {
  return createRequire(__filename)(addonPath);
}

function unavailableError(): WindowsFileOperationsError {
  return new WindowsFileOperationsError("WINDOWS_FILE_OPERATIONS_UNAVAILABLE");
}

function invalidError(): WindowsFileOperationsError {
  return new WindowsFileOperationsError("WINDOWS_FILE_OPERATIONS_INVALID");
}
