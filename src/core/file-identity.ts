import { execFile } from "node:child_process";
import { win32 } from "node:path";

const FILE_ID_PATTERN = /(?<![0-9A-Za-z])0[xX][0-9A-Fa-f]{16,64}(?![0-9A-Za-z])/g;
const CANONICALIZABLE_FILE_ID_PATTERN = /^0[xX][0-9A-Fa-f]{16,64}$/;
const FILE_ID_TIMEOUT_MS = 2_000;
const FILE_ID_MAX_BUFFER = 8_192;

export interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly nlink: number | bigint;
  readonly windowsFileId?: string;
}

export interface WindowsFileIdCommandOptions {
  readonly shell: false;
  readonly windowsHide: true;
  readonly timeout: number;
  readonly maxBuffer: number;
}

export interface WindowsFileIdCommandResult {
  readonly stdout: string;
}

export type WindowsFileIdCommandRunner = (
  file: string,
  args: readonly string[],
  options: WindowsFileIdCommandOptions,
) => Promise<WindowsFileIdCommandResult>;

export interface HydrateWindowsFileIdentityOptions {
  readonly platform?: NodeJS.Platform;
  readonly systemRoot?: string;
  readonly runner?: WindowsFileIdCommandRunner;
}

export class FileIdentityError extends Error {
  constructor() {
    super("Windows file identity is unavailable.");
    this.name = "FileIdentityError";
  }
}

export function hasComparableFileIdentity(
  identity: FileIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (
    !isSafeIdentityValue(identity.dev) ||
    !isSafeIdentityValue(identity.ino) ||
    !isSafeIdentityValue(identity.nlink)
  ) {
    return false;
  }

  if (!isZero(identity.ino)) {
    return true;
  }

  return platform === "win32" && getCanonicalWindowsFileId(identity) !== undefined;
}

export function sameStableFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (
    !hasComparableFileIdentity(left, platform) ||
    !hasComparableFileIdentity(right, platform)
  ) {
    return false;
  }

  if (!isZero(left.ino) && !isZero(right.ino)) {
    return sameIdentityValue(left.dev, right.dev) && sameIdentityValue(left.ino, right.ino);
  }

  if (
    platform !== "win32" ||
    !isZero(left.ino) ||
    !isZero(right.ino) ||
    !sameIdentityValue(left.dev, right.dev)
  ) {
    return false;
  }

  const leftFileId = getCanonicalWindowsFileId(left);
  const rightFileId = getCanonicalWindowsFileId(right);
  return leftFileId !== undefined &&
    leftFileId === rightFileId &&
    sameIdentityValue(left.nlink, right.nlink);
}

export async function hydrateWindowsFileIdentity(
  path: string,
  identity: FileIdentity,
  options: HydrateWindowsFileIdentityOptions = {},
): Promise<FileIdentity> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !isZero(identity.ino)) {
    return identity;
  }

  if (typeof path !== "string" || !win32.isAbsolute(path)) {
    throw new FileIdentityError();
  }

  const runner = options.runner;
  if (runner === undefined && options.systemRoot !== undefined) {
    throw new FileIdentityError();
  }

  const systemRoot = runner === undefined
    ? process.env.SystemRoot
    : options.systemRoot ?? process.env.SystemRoot;
  if (!isValidWindowsSystemRoot(systemRoot)) {
    throw new FileIdentityError();
  }
  const fsutilPath = getWindowsFsutilPath(systemRoot);
  if (fsutilPath === undefined) {
    throw new FileIdentityError();
  }

  try {
    const targetPath = win32.normalize(path);
    const result = await (runner ?? runWindowsFileIdCommand)(
      fsutilPath,
      ["file", "queryFileID", targetPath],
      {
        shell: false,
        windowsHide: true,
        timeout: FILE_ID_TIMEOUT_MS,
        maxBuffer: FILE_ID_MAX_BUFFER,
      },
    );
    const windowsFileId = parseWindowsFileId(result.stdout);
    return { ...identity, windowsFileId };
  } catch (error: unknown) {
    if (error instanceof FileIdentityError) {
      throw error;
    }
    throw new FileIdentityError();
  }
}

function isSafeIdentityValue(value: number | bigint): boolean {
  return typeof value === "bigint"
    ? value >= 0n
    : Number.isSafeInteger(value) && value >= 0;
}

function sameIdentityValue(left: number | bigint, right: number | bigint): boolean {
  if (typeof left === typeof right) {
    return left === right;
  }
  return typeof left === "number" ? BigInt(left) === right : left === BigInt(right);
}

function isZero(value: number | bigint): boolean {
  return value === 0 || value === 0n;
}

function getCanonicalWindowsFileId(identity: FileIdentity): string | undefined {
  return typeof identity.windowsFileId === "string" &&
    CANONICALIZABLE_FILE_ID_PATTERN.test(identity.windowsFileId)
    ? identity.windowsFileId.toLowerCase()
    : undefined;
}

function isValidWindowsSystemRoot(value: string | undefined): value is string {
  if (typeof value !== "string" || value.includes("/") || !win32.isAbsolute(value)) {
    return false;
  }

  const normalized = win32.normalize(value);
  const parsed = win32.parse(normalized);
  const segments = normalized.slice(parsed.root.length).split("\\");
  return normalized === value &&
    /^[A-Za-z]:\\$/.test(parsed.root) &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function getWindowsFsutilPath(systemRoot: string): string | undefined {
  const fsutilPath = win32.join(systemRoot, "System32", "fsutil.exe");
  return win32.relative(systemRoot, fsutilPath).toLowerCase() === "system32\\fsutil.exe"
    ? fsutilPath
    : undefined;
}

function parseWindowsFileId(stdout: string): string {
  if (Buffer.byteLength(stdout, "utf8") > FILE_ID_MAX_BUFFER) {
    throw new FileIdentityError();
  }

  const matches = stdout.match(FILE_ID_PATTERN);
  if (matches === null || matches.length !== 1) {
    throw new FileIdentityError();
  }

  return matches[0].toLowerCase();
}

function runWindowsFileIdCommand(
  file: string,
  args: readonly string[],
  options: WindowsFileIdCommandOptions,
): Promise<WindowsFileIdCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });
}
