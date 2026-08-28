import assert from "node:assert/strict";
import { lstat, link, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hydrateWindowsFileIdentity,
  sameStableFileIdentity,
  type FileIdentity,
} from "../../src/core/file-identity";

test("hydrates real Windows File IDs across hard links, renames, and replacements", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs require Windows");
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "codex-file-id-"));
  const originalPath = join(directory, "original.txt");
  const hardLinkPath = join(directory, "hard-link.txt");
  const renamedPath = join(directory, "renamed.txt");
  const replacementLinkPath = join(directory, "replacement-link.txt");

  try {
    await writeFile(originalPath, "original", "utf8");
    await link(originalPath, hardLinkPath);
    await rename(originalPath, renamedPath);
    await writeFile(originalPath, "replacement", "utf8");
    await link(originalPath, replacementLinkPath);

    const hardLinkIdentity = zeroInodeIdentity(await lstat(hardLinkPath, { bigint: true }));
    const renamedIdentity = zeroInodeIdentity(await lstat(renamedPath, { bigint: true }));
    const replacementIdentity = zeroInodeIdentity(await lstat(originalPath, { bigint: true }));

    const [hydratedHardLink, hydratedRenamed, hydratedReplacement] = await Promise.all([
      hydrateWindowsFileIdentity(hardLinkPath, hardLinkIdentity),
      hydrateWindowsFileIdentity(renamedPath, renamedIdentity),
      hydrateWindowsFileIdentity(originalPath, replacementIdentity),
    ]);

    assert.equal(hardLinkIdentity.nlink, renamedIdentity.nlink);
    assert.equal(hardLinkIdentity.nlink, replacementIdentity.nlink);
    assert.equal(sameStableFileIdentity(hydratedHardLink, hydratedRenamed, "win32"), true);
    assert.equal(sameStableFileIdentity(hydratedHardLink, hydratedReplacement, "win32"), false);
    assert.equal(hydratedHardLink.windowsFileId, hydratedRenamed.windowsFileId);
    assert.notEqual(hydratedHardLink.windowsFileId, hydratedReplacement.windowsFileId);
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
