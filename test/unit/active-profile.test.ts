import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodexLayout } from "../../src/core/types";
import {
  ActiveProfileStore,
  ActiveProfileStoreError,
} from "../../src/core/active-profile";

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
