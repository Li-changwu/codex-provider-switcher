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

interface ComparableFileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly nlink: number | bigint;
  readonly windowsFileIdentity?: WindowsFileIdentity;
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
  return snapshotComparableFileIdentity(identity, platform) !== undefined;
}

export function sameStableFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const leftSnapshot = snapshotComparableFileIdentity(left, platform);
  const rightSnapshot = snapshotComparableFileIdentity(right, platform);
  if (leftSnapshot === undefined || rightSnapshot === undefined) {
    return false;
  }

  if (!isZero(leftSnapshot.ino) && !isZero(rightSnapshot.ino)) {
    return sameIdentityValue(leftSnapshot.dev, rightSnapshot.dev) &&
      sameIdentityValue(leftSnapshot.ino, rightSnapshot.ino);
  }

  if (platform !== "win32" || !isZero(leftSnapshot.ino) || !isZero(rightSnapshot.ino)) {
    return false;
  }

  const leftWindowsIdentity = leftSnapshot.windowsFileIdentity;
  const rightWindowsIdentity = rightSnapshot.windowsFileIdentity;
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

function snapshotComparableFileIdentity(
  identity: FileIdentity,
  platform: NodeJS.Platform,
): ComparableFileIdentity | undefined {
  try {
    const dev = readOwnDataProperty(identity, "dev");
    const ino = readOwnDataProperty(identity, "ino");
    const nlink = readOwnDataProperty(identity, "nlink");
    if (!isSafeIdentityValue(dev) || !isSafeIdentityValue(ino) || !isSafeIdentityValue(nlink)) {
      return undefined;
    }

    if (!isZero(ino)) {
      return Object.freeze({ dev, ino, nlink });
    }

    if (platform !== "win32") {
      return undefined;
    }

    const windowsFileIdentity = snapshotWindowsFileIdentity(
      readOwnDataProperty(identity, "windowsFileIdentity"),
    );
    if (
      windowsFileIdentity === undefined ||
      !sameIdentityValue(nlink, windowsFileIdentity.linkCount)
    ) {
      return undefined;
    }
    return Object.freeze({ dev, ino, nlink, windowsFileIdentity });
  } catch {
    return undefined;
  }
}

function readOwnDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function isSafeIdentityValue(value: unknown): value is number | bigint {
  return typeof value === "bigint"
    ? value >= 0n
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
  try {
    if (!isRecord(value)) {
      return undefined;
    }
    const volumeSerial = readOwnDataProperty(value, "volumeSerial");
    const fileId = readOwnDataProperty(value, "fileId");
    const linkCount = readOwnDataProperty(value, "linkCount");
    if (
      typeof volumeSerial !== "string" ||
      !VOLUME_SERIAL_PATTERN.test(volumeSerial) ||
      typeof fileId !== "string" ||
      !FILE_ID_PATTERN.test(fileId) ||
      typeof linkCount !== "bigint" ||
      linkCount !== 1n
    ) {
      return undefined;
    }
    return Object.freeze({ volumeSerial, fileId, linkCount });
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
