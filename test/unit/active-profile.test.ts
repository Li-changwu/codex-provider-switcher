import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodexLayout } from "../../src/core/types";
import {
  ActiveProfileStore,
  ActiveProfileStoreError,
} from "../../src/core/active-profile";
import type { WindowsFileOperations } from "../../src/core/windows-file-operations";

const nodeRequire = createRequire(import.meta.url);

test("persists a strict non-secret active Profile record inside Codex Home", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ActiveProfileStore(layout, {
      now: () => "2026-08-25T00:00:00.000Z",
    });

    const previous = await store.set("research-proxy");

    assert.deepEqual(previous, { state: "missing" });
    assert.deepEqual(await store.get(), {
      version: 1,
      profileId: "research-proxy",
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    const contents = await readFile(store.path, "utf8");
    assert.match(contents, /research-proxy/);
    assert.doesNotMatch(contents, /OPENAI_API_KEY|api.?key/i);
    assert.ok(store.path.startsWith(layout.codexHome));
  });
});

test("accepts zero-inode Windows active Profile storage with canonical file identities", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const store = new ActiveProfileStore(layout, {
        now: () => "2026-08-25T00:00:00.000Z",
        fileIdentityOptions: {
          platform: "win32",
          windowsFileOperations: nativeWindowsFileOperations(),
        },
      });

      await store.set("research-proxy");

      assert.deepEqual(await store.get(), {
        version: 1,
        profileId: "research-proxy",
        updatedAt: "2026-08-25T00:00:00.000Z",
      });
      assert.deepEqual(await store.clear(), {
        state: "present",
        record: {
          version: 1,
          profileId: "research-proxy",
          updatedAt: "2026-08-25T00:00:00.000Z",
        },
      });
      assert.equal(await store.get(), undefined);
      await assert.rejects(() => readFile(store.path, "utf8"), { code: "ENOENT" });
    });
  });
});

test("rejects zero-inode active Profile storage without a canonical file identity", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const store = new ActiveProfileStore(layout, {
        fileIdentityOptions: {
          platform: "win32",
          windowsFileOperations: unavailableWindowsFileOperations(),
        },
      });

      await assert.rejects(
        () => store.set("research-proxy"),
        (error: unknown) => error instanceof ActiveProfileStoreError && error.code === "unsafe-state",
      );
    });
  });
});

test("rejects a replaced zero-inode active Profile file after its path is checked", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  let replaceOnRead = false;
  let activeProfilePath: string | undefined;
  await withZeroInodeStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const store = new ActiveProfileStore(layout, {
        now: () => "2026-08-25T00:00:00.000Z",
        fileIdentityOptions: {
          platform: "win32",
          windowsFileOperations: nativeWindowsFileOperations(),
        },
      });
      activeProfilePath = store.path;
      await store.set("official");
      replaceOnRead = true;

      await assert.rejects(
        () => store.get(),
        (error: unknown) => error instanceof ActiveProfileStoreError && error.code === "unsafe-state",
      );
    });
  }, {
    beforeOpen: async (path, flags) => {
      if (!replaceOnRead || path !== activeProfilePath || flags !== "r") {
        return;
      }
      replaceOnRead = false;
      const replacementPath = `${path}.replacement`;
      await writeFile(
        replacementPath,
        '{\n  "version": 1,\n  "profileId": "replacement",\n  "updatedAt": "2026-08-25T00:00:00.000Z"\n}\n',
        "utf8",
      );
      await rename(replacementPath, path);
    },
  });
});

test("rejects a zero-inode active Profile file whose link count changes before open", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  let linkOnRead = false;
  let activeProfilePath: string | undefined;
  let linkPath: string | undefined;
  await withZeroInodeStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const store = new ActiveProfileStore(layout, {
        now: () => "2026-08-25T00:00:00.000Z",
        fileIdentityOptions: {
          platform: "win32",
          windowsFileOperations: nativeWindowsFileOperations(),
        },
      });
      activeProfilePath = store.path;
      linkPath = join(layout.codexHome, "active-profile-link.json");
      await store.set("official");
      linkOnRead = true;

      await assert.rejects(
        () => store.get(),
        (error: unknown) => error instanceof ActiveProfileStoreError && error.code === "unsafe-state",
      );
    });
  }, {
    beforeOpen: async (path, flags) => {
      if (!linkOnRead || path !== activeProfilePath || flags !== "r") {
        return;
      }
      linkOnRead = false;
      await link(path, linkPath!);
    },
  });
});

test("restores an active Profile snapshot after an unapplied switch fails", async () => {
  await withTemporaryLayout(async (layout) => {
    const timestamps = [
      "2026-08-24T00:00:00.000Z",
      "2026-08-25T00:00:00.000Z",
    ];
    const store = new ActiveProfileStore(layout, {
      now: () => timestamps.shift() ?? "2026-08-26T00:00:00.000Z",
    });
    await store.set("official");
    const beforeTarget = await store.set("custom");

    await store.restore(beforeTarget);

    assert.deepEqual(await store.get(), {
      version: 1,
      profileId: "official",
      updatedAt: "2026-08-24T00:00:00.000Z",
    });
    await store.clear();
    assert.equal(await store.get(), undefined);
  });
});

test("fails closed for malformed state, invalid IDs, and a switcher directory outside Codex Home", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ActiveProfileStore(layout);
    await assert.rejects(
      () => store.set("../outside"),
      (error: unknown) => error instanceof ActiveProfileStoreError && error.code === "invalid-profile-id",
    );

    assert.throws(
      () => new ActiveProfileStore({ ...layout, switcherDir: tmpdir() }),
      (error: unknown) => error instanceof ActiveProfileStoreError && error.code === "invalid-layout",
    );
  });
});

test("rejects a symbolic provider-switcher directory without creating external active state", async (t) => {
  await withTemporaryLayout(async (layout) => {
    const external = await mkdtemp(join(tmpdir(), "codex-provider-switcher-active-profile-external-"));
    const marker = join(external, "marker.txt");
    const externalState = join(external, "active-profile.json");
    await writeFile(marker, "external directory must remain unchanged", "utf8");
    try {
      try {
        await symlink(external, layout.switcherDir, "dir");
      } catch (error: unknown) {
        if (isWindowsSymlinkPrivilegeError(error)) {
          t.skip("Creating symbolic links requires Windows developer privileges.");
          return;
        }
        throw error;
      }

      const store = new ActiveProfileStore(layout);
      await assert.rejects(
        () => store.set("external-profile"),
        (error: unknown) => {
          assert.ok(error instanceof ActiveProfileStoreError);
          assert.equal(error.code, "unsafe-state");
          assert.doesNotMatch(error.message, /external|provider-switcher/i);
          return true;
        },
      );
      assert.equal(await readFile(marker, "utf8"), "external directory must remain unchanged");
      await assert.rejects(() => readFile(externalState, "utf8"), { code: "ENOENT" });
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

test("rejects symbolic and hard-linked active Profile state without touching the external file", async (t) => {
  await withTemporaryLayout(async (layout) => {
    const store = new ActiveProfileStore(layout, {
      now: () => "2026-08-26T00:00:00.000Z",
    });
    await store.set("official");
    const external = join(layout.codexHome, "external-active-profile.json");
    const originalState = await readFile(store.path, "utf8");
    await writeFile(external, originalState, "utf8");
    await unlink(store.path);

    try {
      await symlink(external, store.path, "file");
    } catch (error: unknown) {
      if (isWindowsSymlinkPrivilegeError(error)) {
        t.skip("Creating symbolic links requires Windows developer privileges.");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => store.get(),
      (error: unknown) => {
        assert.ok(error instanceof ActiveProfileStoreError);
        assert.equal(error.code, "unsafe-state");
        assert.doesNotMatch(error.message, /external-active-profile/i);
        return true;
      },
    );
    await assert.rejects(
      () => store.set("custom"),
      (error: unknown) => error instanceof ActiveProfileStoreError && error.code === "unsafe-state",
    );
    assert.equal(await readFile(external, "utf8"), originalState);

    await unlink(store.path);
    await link(external, store.path);
    await assert.rejects(
      () => store.set("custom"),
      (error: unknown) => error instanceof ActiveProfileStoreError && error.code === "unsafe-state",
    );
    assert.equal(await readFile(external, "utf8"), originalState);
  });
});

test("rejects a non-regular active Profile state file without replacing it", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ActiveProfileStore(layout);
    await mkdir(layout.switcherDir);
    await mkdir(store.path);

    await assert.rejects(
      () => store.get(),
      (error: unknown) => error instanceof ActiveProfileStoreError && error.code === "unsafe-state",
    );
    await assert.rejects(
      () => store.set("custom"),
      (error: unknown) => error instanceof ActiveProfileStoreError && error.code === "unsafe-state",
    );
    assert.equal((await lstat(store.path)).isDirectory(), true);
  });
});

async function withTemporaryLayout(
  callback: (layout: CodexLayout) => Promise<void>,
): Promise<void> {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-provider-switcher-active-profile-"));
  const layout: CodexLayout = {
    codexHome,
    configPath: join(codexHome, "config.toml"),
    authPath: join(codexHome, "auth.json"),
    sessionsDir: join(codexHome, "sessions"),
    archivedSessionsDir: join(codexHome, "archived_sessions"),
    sqlitePath: join(codexHome, "state_5.sqlite"),
    switcherDir: join(codexHome, "provider-switcher"),
  };
  try {
    await callback(layout);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

function isWindowsSymlinkPrivilegeError(error: unknown): boolean {
  return process.platform === "win32" &&
    (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
}

interface ZeroInodeStatsHooks {
  beforeOpen?: (path: string, flags: string | number | undefined) => Promise<void>;
}

async function withZeroInodeStats(
  callback: () => Promise<void>,
  hooks: ZeroInodeStatsHooks = {},
): Promise<void> {
  const mutableFs = nodeRequire("node:fs/promises") as {
    lstat: typeof lstat;
    open: typeof open;
  };
  const originalLstat = mutableFs.lstat;
  const originalOpen = mutableFs.open;
  mutableFs.lstat = (async (...args: Parameters<typeof lstat>) => {
    const stats = await originalLstat(...args);
    rememberNativeIdentity(args[0], stats);
    return withZeroInode(stats);
  }) as typeof lstat;
  mutableFs.open = (async (...args: Parameters<typeof open>) => {
    const logicalPath = args[0];
    const path = args[0];
    if (typeof path === "string") {
      await hooks.beforeOpen?.(path, args[1]);
    }
    const handle = await originalOpen(...args);
    return new Proxy(handle, {
      get(target, property) {
        if (property === "stat") {
          return async (...statArgs: Parameters<typeof target.stat>) => {
            const stats = await target.stat(...statArgs);
            rememberNativeIdentity(logicalPath, stats);
            return withZeroInode(stats);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof open;
  syncBuiltinESMExports();
  try {
    await callback();
  } finally {
    mutableFs.lstat = originalLstat;
    mutableFs.open = originalOpen;
    nativeIdentityStats.clear();
    syncBuiltinESMExports();
  }
}

function withZeroInode<T extends Awaited<ReturnType<typeof lstat>>>(stats: T): T {
  const copy = Object.create(
    Object.getPrototypeOf(stats),
    Object.getOwnPropertyDescriptors(stats),
  ) as T;
  Object.defineProperty(copy, "ino", {
    configurable: true,
    enumerable: true,
    value: 0n,
    writable: false,
  });
  return copy;
}

const nativeIdentityStats = new Map<string, {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
}>();

function nativeWindowsFileOperations(): WindowsFileOperations {
  return {
    captureFileIdentity(path) {
      const stats = nativeIdentityStats.get(path);
      if (stats === undefined || stats.nlink !== 1n) {
        throw new Error("native identity is unavailable");
      }
      return {
        volumeSerial: "0000000000000001",
        fileId: `${stats.dev.toString(16)}${stats.ino.toString(16)}`
          .padStart(32, "0")
          .slice(-32),
        linkCount: stats.nlink,
      };
    },
    deleteFileIfMatches() {
      throw new Error("unused");
    },
    holdFileIfMatches() {
      throw new Error("unused");
    },
  };
}

function unavailableWindowsFileOperations(): WindowsFileOperations {
  return {
    captureFileIdentity() {
      throw new Error("native identity is unavailable");
    },
    deleteFileIfMatches() {
      throw new Error("unused");
    },
    holdFileIfMatches() {
      throw new Error("unused");
    },
  };
}

function rememberNativeIdentity(
  path: unknown,
  stats: { dev: bigint; ino: bigint; nlink: bigint },
): void {
  if (typeof path === "string") {
    nativeIdentityStats.set(path, {
      dev: stats.dev,
      ino: stats.ino,
      nlink: stats.nlink,
    });
  }
}
