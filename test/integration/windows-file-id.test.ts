import assert from "node:assert/strict";
import { lstat, link, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileIdentityError,
  hydrateWindowsFileIdentity,
  sameStableFileIdentity,
  type FileIdentity,
} from "../../src/core/file-identity";

test("hydrates native Windows identities across rename and rejects hard links", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs require Windows");
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "codex-file-id-"));
  const originalPath = join(directory, "original.txt");
  const renamedPath = join(directory, "renamed.txt");
  const hardLinkPath = join(directory, "renamed-link.txt");

  try {
    await writeFile(originalPath, "same contents", "utf8");
    const hydratedOriginal = await hydrateWindowsFileIdentity(
      originalPath,
      zeroInodeIdentity(await lstat(originalPath, { bigint: true })),
    );

    await rename(originalPath, renamedPath);
    await writeFile(originalPath, "same contents", "utf8");
    const hydratedRenamed = await hydrateWindowsFileIdentity(
      renamedPath,
      zeroInodeIdentity(await lstat(renamedPath, { bigint: true })),
    );
    const hydratedReplacement = await hydrateWindowsFileIdentity(
      originalPath,
      zeroInodeIdentity(await lstat(originalPath, { bigint: true })),
    );

    assert.equal(sameStableFileIdentity(hydratedOriginal, hydratedRenamed, "win32"), true);
    assert.equal(sameStableFileIdentity(hydratedRenamed, hydratedReplacement, "win32"), false);
    assert.deepEqual(
      hydratedOriginal.windowsFileIdentity,
      hydratedRenamed.windowsFileIdentity,
    );
    assert.notDeepEqual(
      hydratedRenamed.windowsFileIdentity,
      hydratedReplacement.windowsFileIdentity,
    );

    await link(renamedPath, hardLinkPath);
    await assert.rejects(
      async () => hydrateWindowsFileIdentity(
        hardLinkPath,
        zeroInodeIdentity(await lstat(hardLinkPath, { bigint: true })),
      ),
      FileIdentityError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function zeroInodeIdentity(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: 0n,
    nlink: stats.nlink,
  };
}
