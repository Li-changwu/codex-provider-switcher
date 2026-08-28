import {
  createWindowsFileOperations,
  type WindowsFileIdentity,
  type WindowsFileOperations,
} from "./windows-file-operations";

const VOLUME_SERIAL_PATTERN = /^[0-9a-f]{16}$/;
const FILE_ID_PATTERN = /^[0-9a-f]{32}$/;

export interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly nlink: number | bigint;
  readonly windowsFileIdentity?: WindowsFileIdentity;
}

export interface HydrateWindowsFileIdentityOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsFileOperations?: WindowsFileOperations;
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

  return platform === "win32" &&
    hasNativeWindowsFileIdentity(identity.windowsFileIdentity) &&
    sameIdentityValue(identity.nlink, identity.windowsFileIdentity.linkCount);
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

  if (platform !== "win32" || !isZero(left.ino) || !isZero(right.ino)) {
    return false;
  }

  const leftWindowsIdentity = left.windowsFileIdentity;
  const rightWindowsIdentity = right.windowsFileIdentity;
  return leftWindowsIdentity !== undefined &&
    rightWindowsIdentity !== undefined &&
    leftWindowsIdentity.volumeSerial === rightWindowsIdentity.volumeSerial &&
    leftWindowsIdentity.fileId === rightWindowsIdentity.fileId &&
    leftWindowsIdentity.linkCount === rightWindowsIdentity.linkCount;
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

  try {
    const captured = (options.windowsFileOperations ?? createWindowsFileOperations())
      .captureFileIdentity(path);
    const windowsFileIdentity = snapshotWindowsFileIdentity(captured);
    if (
      windowsFileIdentity === undefined ||
      !sameIdentityValue(identity.nlink, windowsFileIdentity.linkCount)
    ) {
      throw new FileIdentityError();
    }
    return { ...identity, windowsFileIdentity };
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

function snapshotWindowsFileIdentity(value: unknown): WindowsFileIdentity | undefined {
  if (!hasNativeWindowsFileIdentity(value)) {
    return undefined;
  }

  return Object.freeze({
    volumeSerial: value.volumeSerial,
    fileId: value.fileId,
    linkCount: value.linkCount,
  });
}

function hasNativeWindowsFileIdentity(value: unknown): value is WindowsFileIdentity {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.volumeSerial === "string" &&
    VOLUME_SERIAL_PATTERN.test(value.volumeSerial) &&
    typeof value.fileId === "string" &&
    FILE_ID_PATTERN.test(value.fileId) &&
    typeof value.linkCount === "bigint" &&
    value.linkCount === 1n;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
