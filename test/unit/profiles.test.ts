import assert from "node:assert/strict";
import { execFile as nativeExecFile } from "node:child_process";
import { lstatSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import type { CodexLayout, ProfileRecord } from "../../src/core/types";
import {
  ProfileStore,
  ProfileStoreError,
  createProfileAuthPreview,
  type ProfileFileSystem,
  type ProfileLockFileSystem,
  type ProfileLockOptions,
} from "../../src/core/profiles";
import {
  SecretStore,
  SecretStorageError,
  UnsupportedSecretStorageError,
  type SecretStorageLike,
} from "../../src/core/secrets";
import type {
  WindowsFileIdentity,
  WindowsFileOperations,
} from "../../src/core/windows-file-operations";

const nodeRequire = createRequire(import.meta.url);
const execFile = promisify(nativeExecFile);

test("deletes a managed Profile and removes it from the public index", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const created = await store.create({
      name: "Disposable",
      kind: "custom",
      configText: 'model_provider = "disposable"\n',
      providerId: "disposable",
    });

    assert.equal(await store.delete(created.id), true);
    assert.deepEqual(await store.list(), []);
    assert.equal(await access(join(layout.switcherDir, "profiles", created.id)).then(
      () => true,
      () => false,
    ), false);
    assert.equal(await store.delete(created.id), false);
  });
});

test("creates only redacted auth previews for Provider UI", () => {
  assert.deepEqual(createProfileAuthPreview("custom", true), {
    kind: "custom",
    json: '{\n  "OPENAI_API_KEY": "[REDACTED]"\n}',
    secretConfigured: true,
  });
  assert.deepEqual(createProfileAuthPreview("official", false), {
    kind: "official",
    secretConfigured: false,
  });
});

test("accepts a Windows 8.3 alias for Profile storage", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows path aliases are not available on this platform.");
    return;
  }

  const canonicalHome = await mkdtemp(join(tmpdir(), "codex-provider-switcher-short-path-"));
  try {
    const shortHome = await windowsShortPath(canonicalHome);
    if (shortHome === undefined || shortHome === canonicalHome) {
      t.skip("Windows short-path aliases are unavailable on this runner.");
      return;
    }

    const layout: CodexLayout = {
      codexHome: shortHome,
      configPath: join(shortHome, "config.toml"),
      authPath: join(shortHome, "auth.json"),
      sessionsDir: join(shortHome, "sessions"),
      archivedSessionsDir: join(shortHome, "archived_sessions"),
      sqlitePath: join(shortHome, "state_5.sqlite"),
      switcherDir: join(shortHome, "provider-switcher"),
    };
    const store = new ProfileStore(layout, {
      now: () => "2026-08-30T00:00:00.000Z",
    });

    const created = await store.create({
      name: "Short Path Proxy",
      kind: "custom",
      configText: 'model_provider = "proxy"\n',
      providerId: "proxy",
    });

    assert.equal(await store.readConfig(created.id), 'model_provider = "proxy"\n');
    await store.update(created.id, {
      name: "Short Path Updated",
      kind: "custom",
      configText: 'model_provider = "updated"\n',
      providerId: "updated",
    });
    assert.deepEqual((await store.list()).map((profile) => profile.name), ["Short Path Updated"]);
  } finally {
    await rm(canonicalHome, { recursive: true, force: true });
  }
});

test("creates normalized profile IDs and deterministic collision suffixes", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout, {
      now: () => "2026-08-24T00:00:00.000Z",
    });

    const first = await store.create({
      name: "Research Proxy!",
      kind: "custom",
      configText: 'model_provider = "research"\n',
      providerId: "research",
      apiKeySecretId: "supplied-but-not-persisted",
    });
    const second = await store.create({
      name: "Research Proxy!",
      kind: "custom",
      configText: 'model_provider = "research"\n',
      providerId: "research",
    });

    assert.equal(first.id, "research-proxy");
    assert.equal(second.id, "research-proxy-2");
    assert.equal(
      first.apiKeySecretId,
      "codex-provider-switcher.profile.research-proxy.api-key",
    );
    assert.equal(first.configFile, join(layout.switcherDir, "profiles", first.id, "config.toml"));
    assert.deepEqual(
      (await store.list()).map((profile) => profile.id),
      ["research-proxy", "research-proxy-2"],
    );
    assert.deepEqual(await store.get(first.id), first);
  });
});

test("accepts zero-inode Windows Profile storage with canonical file identities", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const store = new ProfileStore(layout, {
        now: () => "2026-08-28T00:00:00.000Z",
        fileIdentityOptions: zeroInodeProfileIdentityOptions(),
      });
      const created = await store.create({
        name: "Zero Inode Proxy",
        kind: "custom",
        configText: 'model_provider = "proxy"\n',
        providerId: "proxy",
      });

      assert.equal(await store.readConfig(created.id), 'model_provider = "proxy"\n');
      const updated = await store.update(created.id, {
        name: "Zero Inode Updated",
        kind: "custom",
        configText: 'model_provider = "updated"\n',
        providerId: "updated",
      });

      assert.equal(updated?.name, "Zero Inode Updated");
      assert.equal(await store.readConfig(created.id), 'model_provider = "updated"\n');
      assert.deepEqual((await store.list()).map((profile) => profile.id), [created.id]);
    });
  });
});

test("rejects zero-inode Profile storage without a canonical file identity", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const store = new ProfileStore(layout, {
        fileIdentityOptions: {
          platform: "win32",
          windowsFileOperations: unavailableProfileWindowsFileOperations(),
        },
      });

      await assert.rejects(() => store.create({
        name: "Missing Identity",
        kind: "official",
        configText: 'model_provider = "openai"\n',
      }));
    });
  });
});

test("preserves externally replaced zero-inode config when index publication fails", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const identityOptions = {
        platform: "win32" as const,
        windowsFileOperations: nativeProfileWindowsFileOperations(),
      };
      const initialStore = new ProfileStore(layout, { fileIdentityOptions: identityOptions });
      const created = await initialStore.create({
        name: "Replaced Zero Inode",
        kind: "official",
        configText: 'model_provider = "openai"\n',
      });
      const externalConfig = 'model_provider = "external"\n';
      const indexPath = join(layout.switcherDir, "profiles", "index.json");
      const indexBefore = await readFile(indexPath, "utf8");
      const store = new ProfileStore(layout, {
        fileIdentityOptions: identityOptions,
        fileSystem: new ExternalConfigEditOnIndexFailureProfileFileSystem(
          created.configFile,
          externalConfig,
        ),
      });

      await assert.rejects(
        () => store.update(created.id, {
          name: "Replaced Zero Inode",
          kind: "official",
          configText: 'model_provider = "updated"\n',
        }),
        (error: unknown) => error instanceof ProfileStoreError && error.code === "rollback-failed",
      );

      assert.equal(await readFile(created.configFile, "utf8"), externalConfig);
      assert.equal(await readFile(indexPath, "utf8"), indexBefore);
    });
  });
});

test("rejects zero-inode Profile config whose hard-link count changes", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const store = new ProfileStore(layout, {
        fileIdentityOptions: zeroInodeProfileIdentityOptions(),
      });
      const created = await store.create({
        name: "Linked Zero Inode",
        kind: "official",
        configText: 'model_provider = "openai"\n',
      });
      const hardLinkPath = `${created.configFile}.link`;
      await link(created.configFile, hardLinkPath);

      await assert.rejects(
        () => store.update(created.id, {
          name: "Linked Zero Inode",
          kind: "official",
          configText: 'model_provider = "updated"\n',
        }),
        (error: unknown) => error instanceof ProfileStoreError && error.code === "persistence-failed",
      );
      assert.equal(await readFile(created.configFile, "utf8"), 'model_provider = "openai"\n');
    });
  });
});

test("preserves a replaced zero-inode index temporary file during failed publication", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const externalContents = '{"profiles":"external"}\n';
      const fileSystem = new FailingIndexProfileFileSystem();
      const windowsFileOperations = new RecordingWindowsFileOperations(
        [{
          matches: (path) => basename(path).startsWith(".index.json.tmp-"),
          replacementContents: externalContents,
        }],
      );
      const store = new ProfileStore(layout, {
        fileSystem,
        fileIdentityOptions: zeroInodeProfileIdentityOptions(windowsFileOperations),
      });

      await assert.rejects(
        () => store.create({
          name: "Temporary Replacement",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
        (error: unknown) => error instanceof ProfileStoreError && error.code === "rollback-failed",
      );

      const replacement = windowsFileOperations.replacements.find(({ path }) =>
        basename(path).startsWith(".index.json.tmp-"),
      );
      assert.notEqual(replacement, undefined);
      assert.equal(await readFile(replacement!.path, "utf8"), externalContents);
      assert.deepEqual(fileSystem.unlinked, []);
      assert.equal(windowsFileOperations.deleteRequests.length > 0, true);
    });
  });
});

test("treats a missing zero-inode index temporary file after native delete failure as cleaned up", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const fileSystem = new FailingIndexProfileFileSystem();
      const windowsFileOperations = new RecordingWindowsFileOperations([
        {
          matches: (path) => basename(path).startsWith(".index.json.tmp-"),
          action: "disappear-and-throw",
        },
      ]);
      const store = new ProfileStore(layout, {
        fileSystem,
        fileIdentityOptions: zeroInodeProfileIdentityOptions(windowsFileOperations),
      });
      const writeAtomically = Reflect.get(store, "writeAtomically") as (
        path: string,
        contents: string,
      ) => Promise<unknown>;

      await assert.rejects(
        () => writeAtomically.call(store, join(layout.switcherDir, "profiles", "index.json"), "{}\n"),
        (error: unknown) => error instanceof ProfileStoreError && error.code === "persistence-failed",
      );

      const temporaryDelete = windowsFileOperations.deleteRequests.find(({ path }) =>
        basename(path).startsWith(".index.json.tmp-"),
      );
      assert.notEqual(temporaryDelete, undefined);
      await assert.rejects(() => lstat(temporaryDelete!.path), { code: "ENOENT" });
      assert.deepEqual(fileSystem.unlinked, []);
    });
  });
});

test("preserves a present zero-inode index temporary file after native delete failure without rereading it", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const fileSystem = new NoPostFailureReadFileSystem();
      const windowsFileOperations = new RecordingWindowsFileOperations([
        {
          matches: (path) => basename(path).startsWith(".index.json.tmp-"),
          action: "throw-and-keep",
        },
      ]);
      const store = new ProfileStore(layout, {
        fileSystem,
        fileIdentityOptions: zeroInodeProfileIdentityOptions(windowsFileOperations),
      });
      const indexPath = join(layout.switcherDir, "profiles", "index.json");
      const writeAtomically = Reflect.get(store, "writeAtomically") as (
        path: string,
        contents: string,
      ) => Promise<unknown>;

      await assert.rejects(
        () => writeAtomically.call(store, indexPath, "{}\n"),
        (error: unknown) => error instanceof ProfileStoreError && error.code === "rollback-failed",
      );

      const temporaryDelete = windowsFileOperations.deleteRequests.find(({ path }) =>
        basename(path).startsWith(".index.json.tmp-"),
      );
      assert.notEqual(temporaryDelete, undefined);
      assert.equal(await readFile(temporaryDelete!.path, "utf8"), "{}\n");
      assert.deepEqual(fileSystem.unlinked, []);
      assert.deepEqual(fileSystem.temporaryReads, []);
      assert.deepEqual(windowsFileOperations.capturesAfterDeleteFailure, []);
    });
  });
});

test("does not release a zero-inode Profile lock replaced during native delete", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const lockPath = join(layout.switcherDir, "profiles", ".create.lock");
      const lockFileSystem = new RecordingProfileLockFileSystem();
      const windowsFileOperations = new RecordingWindowsFileOperations(
        [{ matches: (path) => path === lockPath, replacementContents: "replacement lock" }],
      );
      const store = new ProfileStore(layout, {
        fileIdentityOptions: zeroInodeProfileIdentityOptions(windowsFileOperations),
        lockOptions: { fileSystem: lockFileSystem },
      });

      await assert.rejects(
        () => store.create({
          name: "Replaced Lock",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
        (error: unknown) => error instanceof ProfileStoreError && error.code === "persistence-failed",
      );
      assert.equal(await readFile(lockPath, "utf8"), "replacement lock");
      assert.deepEqual(lockFileSystem.unlinked, []);
      assert.equal(windowsFileOperations.deleteRequests.length, 1);
    });
  });
});

test("releases an ordinary zero-inode Windows Profile lock through native delete without rereading", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const lockPath = join(layout.switcherDir, "profiles", ".create.lock");
      const lockFileSystem = new NoPostCreationLockReadFileSystem(lockPath);
      const windowsFileOperations = new RecordingWindowsFileOperations();
      const store = new ProfileStore(layout, {
        fileIdentityOptions: zeroInodeProfileIdentityOptions(windowsFileOperations),
        lockOptions: { fileSystem: lockFileSystem },
      });

      const created = await store.create({
        name: "Native Lock Release",
        kind: "official",
        configText: 'model_provider = "openai"\n',
      });

      assert.equal(created.id, "native-lock-release");
      assert.equal(windowsFileOperations.deleteRequests.length, 1);
      assert.equal(windowsFileOperations.deleteRequests[0]?.path, lockPath);
      assert.deepEqual(lockFileSystem.unlinked, []);
      await assert.rejects(() => lstat(lockPath), { code: "ENOENT" });
    });
  });
});

test("preserves a replacement zero-inode Windows Profile lock when close-failure cleanup deletes", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const lockPath = join(layout.switcherDir, "profiles", ".create.lock");
      const replacementContents = "replacement lock";
      const lockFileSystem = new CloseFailureProfileLockFileSystem(lockPath);
      const windowsFileOperations = new RecordingWindowsFileOperations(
        [{ matches: (path) => path === lockPath, replacementContents }],
      );
      const store = new ProfileStore(layout, {
        fileIdentityOptions: zeroInodeProfileIdentityOptions(windowsFileOperations),
        lockOptions: { fileSystem: lockFileSystem },
      });

      await assert.rejects(
        () => store.create({
          name: "Close Failure Lock",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
        (error: unknown) => error instanceof ProfileStoreError && error.code === "rollback-failed",
      );

      assert.equal(await readFile(lockPath, "utf8"), replacementContents);
      assert.deepEqual(lockFileSystem.unlinked, []);
      assert.equal(windowsFileOperations.deleteRequests.length, 1);
      assert.equal(windowsFileOperations.deleteRequests[0]?.path, lockPath);
    });
  });
});

test("does not reclaim a zero-inode stale Profile lock replaced during native delete", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const profilesDir = join(layout.switcherDir, "profiles");
      const lockPath = join(profilesDir, ".create.lock");
      const staleContents = JSON.stringify({ pid: 999999, createdAt: 0 });
      await mkdir(profilesDir, { recursive: true });
      await writeFile(lockPath, staleContents, "utf8");
      const lockFileSystem = new RecordingProfileLockFileSystem();
      const windowsFileOperations = new RecordingWindowsFileOperations(
        [{ matches: (path) => path === lockPath, replacementContents: staleContents }],
      );
      const store = new ProfileStore(layout, {
        fileIdentityOptions: zeroInodeProfileIdentityOptions(windowsFileOperations),
        lockOptions: {
          clock: () => 10_000,
          fileSystem: lockFileSystem,
          isProcessAlive: () => false,
          lockRetryMs: 1,
          lockTimeoutMs: 10,
          staleLockMs: 1,
        },
      });

      await assert.rejects(
        () => store.create({
          name: "Replaced Stale Lock",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
        (error: unknown) => error instanceof ProfileStoreError && error.code === "persistence-failed",
      );
      assert.equal(await readFile(lockPath, "utf8"), staleContents);
      assert.deepEqual(lockFileSystem.unlinked, []);
      assert.equal(windowsFileOperations.deleteRequests.some(({ path }) => path === lockPath), true);
    });
  });
});

test("continues stale zero-inode Profile lock recovery after native delete observes disappearance", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const profilesDir = join(layout.switcherDir, "profiles");
      const lockPath = join(profilesDir, ".create.lock");
      await mkdir(profilesDir, { recursive: true });
      await writeFile(lockPath, JSON.stringify({ pid: 999999, createdAt: 0 }), "utf8");
      const lockFileSystem = new RecordingProfileLockFileSystem();
      const windowsFileOperations = new RecordingWindowsFileOperations([
        { matches: (path) => path === lockPath, action: "disappear-and-throw" },
      ]);
      const store = new ProfileStore(layout, {
        fileIdentityOptions: zeroInodeProfileIdentityOptions(windowsFileOperations),
        lockOptions: {
          clock: () => 10_000,
          fileSystem: lockFileSystem,
          isProcessAlive: () => false,
          lockRetryMs: 1,
          lockTimeoutMs: 10,
          staleLockMs: 1,
        },
      });

      const created = await store.create({
        name: "Missing Native Stale Lock",
        kind: "official",
        configText: 'model_provider = "openai"\n',
      });

      assert.equal(created.id, "missing-native-stale-lock");
      assert.equal(windowsFileOperations.deleteRequests[0]?.path, lockPath);
      assert.equal(windowsFileOperations.deleteRequests.length >= 2, true);
      assert.deepEqual(lockFileSystem.unlinked, []);
    });
  });
});

test("does not reclaim a zero-inode stale recovery guard replaced during native delete", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const profilesDir = join(layout.switcherDir, "profiles");
      const lockPath = join(profilesDir, ".create.lock");
      const guardPath = join(profilesDir, ".create.lock.recovery");
      const staleContents = JSON.stringify({ pid: 999999, createdAt: 0 });
      await mkdir(profilesDir, { recursive: true });
      await writeFile(lockPath, staleContents, "utf8");
      await writeFile(guardPath, staleContents, "utf8");
      const lockFileSystem = new RecordingProfileLockFileSystem();
      const windowsFileOperations = new RecordingWindowsFileOperations(
        [{ matches: (path) => path === guardPath, replacementContents: staleContents }],
      );
      const store = new ProfileStore(layout, {
        fileIdentityOptions: zeroInodeProfileIdentityOptions(windowsFileOperations),
        lockOptions: {
          clock: () => 10_000,
          fileSystem: lockFileSystem,
          isProcessAlive: () => false,
          lockRetryMs: 1,
          lockTimeoutMs: 10,
          staleLockMs: 1,
        },
      });

      await assert.rejects(
        () => store.create({
          name: "Replaced Recovery Guard",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
        (error: unknown) => error instanceof ProfileStoreError && error.code === "persistence-failed",
      );
      assert.equal(await readFile(guardPath, "utf8"), staleContents);
      assert.deepEqual(lockFileSystem.unlinked, []);
      assert.equal(windowsFileOperations.deleteRequests.some(({ path }) => path === guardPath), true);
    });
  });
});

test("does not reclaim a zero-inode stale recovery claim replaced during native delete", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const profilesDir = join(layout.switcherDir, "profiles");
      const lockPath = join(profilesDir, ".create.lock");
      const claimPath = join(profilesDir, ".create.lock.recovery.claim");
      const staleContents = JSON.stringify({ pid: 999999, createdAt: 0 });
      await mkdir(profilesDir, { recursive: true });
      await writeFile(lockPath, staleContents, "utf8");
      await writeFile(claimPath, staleContents, "utf8");
      const lockFileSystem = new RecordingProfileLockFileSystem();
      const windowsFileOperations = new RecordingWindowsFileOperations(
        [{ matches: (path) => path === claimPath, replacementContents: staleContents }],
      );
      const store = new ProfileStore(layout, {
        fileIdentityOptions: zeroInodeProfileIdentityOptions(windowsFileOperations),
        lockOptions: {
          clock: () => 10_000,
          fileSystem: lockFileSystem,
          isProcessAlive: () => false,
          lockRetryMs: 1,
          lockTimeoutMs: 10,
          staleLockMs: 1,
        },
      });

      await assert.rejects(
        () => store.create({
          name: "Replaced Recovery Claim",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
        (error: unknown) => error instanceof ProfileStoreError && error.code === "persistence-failed",
      );
      assert.equal(await readFile(claimPath, "utf8"), staleContents);
      assert.deepEqual(lockFileSystem.unlinked, []);
      assert.equal(windowsFileOperations.deleteRequests.some(({ path }) => path === claimPath), true);
    });
  });
});

test("keeps non-Windows Profile lock deletion on the portable filesystem path", async () => {
  await withTemporaryLayout(async (layout) => {
    const lockPath = join(layout.switcherDir, "profiles", ".create.lock");
    const lockFileSystem = new RecordingProfileLockFileSystem();
    const windowsFileOperations = new RecordingWindowsFileOperations();
    const store = new ProfileStore(layout, {
      fileIdentityOptions: {
        platform: "linux",
        windowsFileOperations,
      },
      lockOptions: { fileSystem: lockFileSystem },
    });

    await store.create({
      name: "Portable Lock",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });

    assert.deepEqual(windowsFileOperations.deleteRequests, []);
    assert.deepEqual(lockFileSystem.unlinked, [lockPath]);
  });
});

test("does not publish an index after a newly created zero-inode config is replaced", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const configPath = join(
        layout.switcherDir,
        "profiles",
        "created-then-replaced",
        "config.toml",
      );
      const externalPath = join(layout.codexHome, "external-config.toml");
      const externalContents = 'model_provider = "external"\n';
      await writeFile(externalPath, externalContents, "utf8");
      const store = new ProfileStore(layout, {
        fileIdentityOptions: zeroInodeProfileIdentityOptions(),
        fileSystem: new ReplaceConfigBeforeIndexPublishProfileFileSystem(
          configPath,
          externalPath,
        ),
      });

      await assert.rejects(
        () => store.create({
          name: "Created Then Replaced",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
        (error: unknown) => error instanceof ProfileStoreError && error.code === "rollback-failed",
      );
      assert.equal(await readFile(configPath, "utf8"), externalContents);
      await assert.rejects(
        () => readFile(join(layout.switcherDir, "profiles", "index.json"), "utf8"),
        { code: "ENOENT" },
      );
    });
  });
});

test("does not read a zero-inode index replaced after its handle opens", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const identityOptions = zeroInodeProfileIdentityOptions();
      const initialStore = new ProfileStore(layout, { fileIdentityOptions: identityOptions });
      await initialStore.create({
        name: "Index Read Race",
        kind: "official",
        configText: 'model_provider = "openai"\n',
      });
      const indexPath = join(layout.switcherDir, "profiles", "index.json");
      const externalIndexPath = join(layout.codexHome, "external-index.json");
      const externalIndex = '{"profiles":[]}\n';
      await writeFile(externalIndexPath, externalIndex, "utf8");
      const store = new ProfileStore(layout, {
        fileIdentityOptions: identityOptions,
        fileSystem: new ReplaceIndexAfterReadHandleProfileFileSystem(
          indexPath,
          externalIndexPath,
        ),
      });

      await assert.rejects(
        () => store.list(),
        (error: unknown) => error instanceof ProfileStoreError && error.code === "index-read-failed",
      );
      assert.equal(await readFile(indexPath, "utf8"), externalIndex);
    });
  });
});

test("rejects a zero-inode config replaced after its read handle reads", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows File IDs are not available on this platform.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const identityOptions = zeroInodeProfileIdentityOptions();
      const initialStore = new ProfileStore(layout, { fileIdentityOptions: identityOptions });
      const created = await initialStore.create({
        name: "Config After Read Race",
        kind: "official",
        configText: 'model_provider = "openai"\n',
      });
      const externalPath = join(layout.codexHome, "external-config.toml");
      await writeFile(externalPath, 'model_provider = "external"\n', "utf8");
      const store = new ProfileStore(layout, {
        fileIdentityOptions: identityOptions,
        fileSystem: new ReplaceConfigAfterReadProfileFileSystem(
          created.configFile,
          externalPath,
        ),
      });

      await assert.rejects(
        () => store.readConfig(created.id),
        (error: unknown) => error instanceof ProfileStoreError && error.code === "persistence-failed",
      );
      assert.equal(await readFile(created.configFile, "utf8"), 'model_provider = "external"\n');
    });
  });
});

test("updates a profile without changing its identity, creation time, or custom secret identifier", async () => {
  await withTemporaryLayout(async (layout) => {
    const timestamps = [
      "2026-08-24T00:00:00.000Z",
      "2026-08-25T00:00:00.000Z",
    ];
    const store = new ProfileStore(layout, {
      now: () => timestamps.shift() ?? "2026-08-26T00:00:00.000Z",
    });
    const created = await store.create({
      name: "Research Proxy",
      kind: "custom",
      configText: 'model_provider = "research"\n',
      providerId: "research",
    });

    const updated = await store.update(created.id, {
      name: "Research Proxy V2",
      kind: "custom",
      configText: 'model_provider = "research-v2"\n',
      providerId: "research-v2",
    });

    assert.ok(updated);
    assert.equal(updated.id, created.id);
    assert.equal(updated.configFile, created.configFile);
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.updatedAt, "2026-08-25T00:00:00.000Z");
    assert.equal(updated.apiKeySecretId, created.apiKeySecretId);
    assert.equal(await readFile(created.configFile, "utf8"), 'model_provider = "research-v2"\n');
    const persistedIndex = await readFile(
      join(layout.switcherDir, "profiles", "index.json"),
      "utf8",
    );
    assert.doesNotMatch(persistedIndex, /api-key/);
    assert.deepEqual(await store.get(created.id), updated);
  });
});

test("reads managed Profile TOML through the ProfileStore trust boundary", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configText = 'model_provider = "openai"\nmodel = "gpt-5"\n';
    const created = await store.create({
      name: "Read Config",
      kind: "official",
      configText,
    });

    assert.equal(await store.readConfig(created.id), configText);
    assert.equal(await store.readConfig("missing-profile"), undefined);
  });
});

test("rejects an external config replacement that races the trusted read handle", async () => {
  await withTemporaryLayout(async (layout) => {
    const initialStore = new ProfileStore(layout);
    const created = await initialStore.create({
      name: "Read Race",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });
    const externalConfig = join(layout.codexHome, "external.toml");
    await writeFile(externalConfig, 'model_provider = "external"\n', "utf8");
    const store = new ProfileStore(layout, {
      fileSystem: new ReplaceConfigBeforeReadHandleProfileFileSystem(
        created.configFile,
        externalConfig,
      ),
    });

    await assert.rejects(
      () => store.readConfig(created.id),
      (error: unknown) => error instanceof ProfileStoreError
        && error.code === "persistence-failed",
    );
  });
});

test("rejects a tampered Profile index config path before update can touch auth or external files", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const profile = await store.create({
      name: "Trusted Profile",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });
    const authBefore = '{"native":"credential"}';
    const externalPath = join(layout.codexHome, "external.toml");
    const externalBefore = 'model_provider = "external"\n';
    await writeFile(layout.authPath, authBefore, "utf8");
    await writeFile(externalPath, externalBefore, "utf8");
    const indexPath = join(layout.switcherDir, "profiles", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      profiles: Array<Record<string, unknown>>;
    };
    index.profiles[0].configFile = layout.authPath;
    await writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");

    await assert.rejects(
      () => store.update(profile.id, {
        name: "Changed",
        kind: "official",
        configText: 'model_provider = "changed"\n',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProfileStoreError);
        assert.equal(error.code, "index-invalid");
        assert.doesNotMatch(error.message, /auth\.json|external\.toml/);
        return true;
      },
    );
    assert.equal(await readFile(layout.authPath, "utf8"), authBefore);
    assert.equal(await readFile(externalPath, "utf8"), externalBefore);
  });
});

test("rejects Profile index entries with non-public fields", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const profile = await store.create({
      name: "Strict Public Index",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });
    const indexPath = join(layout.switcherDir, "profiles", "index.json");

    for (const unexpectedField of [
      "apiKeySecretId",
      "credentials",
      "arbitraryField",
    ]) {
      const index = JSON.parse(await readFile(indexPath, "utf8")) as {
        profiles: Array<Record<string, unknown>>;
      };
      index.profiles[0][unexpectedField] = "untrusted";
      await writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");

      await assert.rejects(
        () => store.list(),
        (error: unknown) =>
          error instanceof ProfileStoreError && error.code === "index-invalid",
      );

      index.profiles[0] = {
        id: profile.id,
        name: profile.name,
        kind: profile.kind,
        configFile: profile.configFile,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      };
      await writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");
    }
  });
});

test("rejects Profile indexes with unknown top-level fields", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    await store.create({
      name: "Strict Index Root",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });
    const indexPath = join(layout.switcherDir, "profiles", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as Record<string, unknown>;
    index.OPENAI_API_KEY = "untrusted";
    await writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");

    await assert.rejects(
      () => store.list(),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "index-invalid",
    );
  });
});

test("rejects credential-bearing profile edits before changing an existing profile", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const created = await store.create({
      name: "Official",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });

    await assert.rejects(
      () => store.update(created.id, {
        name: "Official",
        kind: "official",
        configText: 'model_provider = "openai"\napi_key = "test-update-key"\n',
      }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "invalid-config",
    );

    assert.equal(await readFile(created.configFile, "utf8"), 'model_provider = "openai"\n');
    assert.deepEqual(await store.get(created.id), created);
  });
});

test("preserves the just-written config when an edit cannot publish its index", async () => {
  await withTemporaryLayout(async (layout) => {
    const initialStore = new ProfileStore(layout, {
      now: () => "2026-08-24T00:00:00.000Z",
    });
    const created = await initialStore.create({
      name: "Rollback Edit",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });
    const failingStore = new ProfileStore(layout, {
      fileSystem: new FailingIndexProfileFileSystem(),
      now: () => "2026-08-25T00:00:00.000Z",
    });

    await assert.rejects(
      () => failingStore.update(created.id, {
        name: "Changed Name",
        kind: "official",
        configText: 'model_provider = "changed"\n',
      }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "rollback-failed",
    );

    assert.equal(await readFile(created.configFile, "utf8"), 'model_provider = "changed"\n');
    assert.deepEqual(await initialStore.get(created.id), created);
  });
});

test("rejects creation through a symbolic profiles root without changing external config bytes", async (t) => {
  await withTemporaryLayout(async (layout) => {
    const profilesRoot = join(layout.switcherDir, "profiles");
    const externalRoot = join(layout.codexHome, "external-profiles");
    const externalConfig = join(externalRoot, "safe-profile", "config.toml");
    const externalBefore = 'model_provider = "external"\n';
    await mkdir(join(externalRoot, "safe-profile"), { recursive: true });
    await writeFile(externalConfig, externalBefore, "utf8");
    await mkdir(layout.switcherDir, { recursive: true });
    try {
      await symlink(externalRoot, profilesRoot, "dir");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Creating symbolic links requires Windows developer privileges.");
        return;
      }
      throw error;
    }

    const store = new ProfileStore(layout);
    await assert.rejects(
      () => store.create({
        name: "Safe Profile",
        kind: "official",
        configText: 'model_provider = "openai"\n',
      }),
      (error: unknown) => error instanceof ProfileStoreError && error.code === "persistence-failed",
    );
    assert.equal(await readFile(externalConfig, "utf8"), externalBefore);
  });
});

test("rejects an edit through a symbolic managed Profile directory without changing external config bytes", async (t) => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const profile = await store.create({
      name: "Managed Profile",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });
    const profileDirectory = dirname(profile.configFile);
    const externalDirectory = join(layout.codexHome, "external-profile");
    const externalConfig = join(externalDirectory, "config.toml");
    const externalBefore = 'model_provider = "external"\n';
    await mkdir(externalDirectory, { recursive: true });
    await writeFile(externalConfig, externalBefore, "utf8");
    await rm(profileDirectory, { recursive: true, force: true });
    try {
      await symlink(externalDirectory, profileDirectory, "dir");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Creating symbolic links requires Windows developer privileges.");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => store.update(profile.id, {
        name: "Changed Profile",
        kind: "official",
        configText: 'model_provider = "custom"\n',
      }),
      (error: unknown) => error instanceof ProfileStoreError && error.code === "persistence-failed",
    );
    assert.equal(await readFile(externalConfig, "utf8"), externalBefore);
  });
});

test("uses a filesystem lock to serialize independent profile stores", async () => {
  await withTemporaryLayout(async (layout) => {
    const fileSystem = new FirstIndexReadBarrierProfileFileSystem();
    const firstStore = new ProfileStore(layout, {
      fileSystem,
      now: () => "2026-08-24T00:00:00.000Z",
    });
    const secondStore = new ProfileStore(layout, {
      fileSystem,
      now: () => "2026-08-24T00:00:00.000Z",
    });

    const firstCreate = firstStore.create({
      name: "Concurrent Profile",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });
    await fileSystem.waitForFirstIndexRead();
    let secondCreate: Promise<ProfileRecord> | undefined;
    try {
      const lockPath = join(layout.switcherDir, "profiles", ".create.lock");
      const lockContents = JSON.parse(await readFile(lockPath, "utf8")) as {
        pid?: unknown;
        createdAt?: unknown;
      };
      assert.equal(lockContents.pid, process.pid);
      assert.equal(typeof lockContents.createdAt, "number");

      secondCreate = secondStore.create({
        name: "Concurrent Profile",
        kind: "official",
        configText: 'model_provider = "openai"\n',
      });
      fileSystem.releaseFirstIndexRead();

      const [first, second] = await Promise.all([firstCreate, secondCreate]);

      assert.deepEqual(
        [first.id, second.id],
        ["concurrent-profile", "concurrent-profile-2"],
      );
      assert.deepEqual(
        (await firstStore.list()).map((profile) => profile.id),
        ["concurrent-profile", "concurrent-profile-2"],
      );
      assert.equal(
        await readFile(first.configFile, "utf8"),
        'model_provider = "openai"\n',
      );
      assert.equal(
        await readFile(second.configFile, "utf8"),
        'model_provider = "openai"\n',
      );
      await assert.rejects(() => readFile(lockPath, "utf8"), { code: "ENOENT" });
    } finally {
      fileSystem.releaseFirstIndexRead();
      await Promise.allSettled(
        [firstCreate, secondCreate].filter(
          (create): create is Promise<ProfileRecord> => create !== undefined,
        ),
      );
    }
  });
});

test("recovers a stale profile lock owned by a known-dead process", async () => {
  await withTemporaryLayout(async (layout) => {
    const profilesDir = join(layout.switcherDir, "profiles");
    const lockPath = join(profilesDir, ".create.lock");
    await mkdir(profilesDir, { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: 12345, createdAt: 0 }), "utf8");
    const store = new ProfileStore(layout, {
      lockOptions: {
        clock: () => 10_000,
        staleLockMs: 1,
        isProcessAlive: () => false,
      },
    });

    const profile = await store.create({
      name: "Recovered Lock",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });

    assert.equal(profile.id, "recovered-lock");
    await assert.rejects(() => readFile(lockPath, "utf8"), { code: "ENOENT" });
  });
});

test("recovers a stale profile lock recovery guard owned by a known-dead process", async () => {
  await withTemporaryLayout(async (layout) => {
    const profilesDir = join(layout.switcherDir, "profiles");
    const lockPath = join(profilesDir, ".create.lock");
    const recoveryLockPath = join(profilesDir, ".create.lock.recovery");
    const staleContents = JSON.stringify({ pid: 999999, createdAt: 0 });
    await mkdir(profilesDir, { recursive: true });
    await writeFile(lockPath, staleContents, "utf8");
    await writeFile(recoveryLockPath, staleContents, "utf8");

    const store = new ProfileStore(layout, {
      lockOptions: {
        clock: () => 10_000,
        isProcessAlive: () => false,
        lockRetryMs: 1,
        lockTimeoutMs: 10,
        staleLockMs: 1,
      },
    });

    const profile = await store.create({
      name: "Recovered Guard",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });

    assert.equal(profile.id, "recovered-guard");
    await assert.rejects(() => readFile(lockPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(recoveryLockPath, "utf8"), {
      code: "ENOENT",
    });
  });
});

test("cleans up a recovery claim when claim validation read fails", async () => {
  await withTemporaryLayout(async (layout) => {
    const profilesDir = join(layout.switcherDir, "profiles");
    const lockPath = join(profilesDir, ".create.lock");
    const recoveryLockPath = join(profilesDir, ".create.lock.recovery");
    const recoveryClaimPath = join(
      profilesDir,
      ".create.lock.recovery.claim",
    );
    const staleContents = JSON.stringify({ pid: 999999, createdAt: 0 });
    await mkdir(profilesDir, { recursive: true });
    await writeFile(lockPath, staleContents, "utf8");
    await writeFile(recoveryLockPath, staleContents, "utf8");

    const lockFileSystem = new FailingRecoveryClaimReadFileSystem(
      recoveryClaimPath,
    );
    const lockOptions: ProfileLockOptions = {
      clock: () => 10_000,
      isProcessAlive: () => false,
      lockRetryMs: 1,
      lockTimeoutMs: 0,
      staleLockMs: 1,
      fileSystem: lockFileSystem,
    };
    const store = new ProfileStore(layout, { lockOptions });

    await assert.rejects(
      () =>
        store.create({
          name: "Claim Validation Failure",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "persistence-failed",
    );
    await assert.rejects(() => readFile(recoveryClaimPath, "utf8"), {
      code: "ENOENT",
    });
  });
});

test("reports both claim validation and cleanup failures", async () => {
  await withTemporaryLayout(async (layout) => {
    const profilesDir = join(layout.switcherDir, "profiles");
    const lockPath = join(profilesDir, ".create.lock");
    const recoveryLockPath = join(profilesDir, ".create.lock.recovery");
    const recoveryClaimPath = join(
      profilesDir,
      ".create.lock.recovery.claim",
    );
    const staleContents = JSON.stringify({ pid: 999999, createdAt: 0 });
    await mkdir(profilesDir, { recursive: true });
    await writeFile(lockPath, staleContents, "utf8");
    await writeFile(recoveryLockPath, staleContents, "utf8");

    const lockFileSystem = new FailingRecoveryClaimReadFileSystem(
      recoveryClaimPath,
      true,
    );
    const store = new ProfileStore(layout, {
      lockOptions: {
        clock: () => 10_000,
        isProcessAlive: () => false,
        lockTimeoutMs: 0,
        staleLockMs: 1,
        fileSystem: lockFileSystem,
      },
    });

    await assert.rejects(
      () =>
        store.create({
          name: "Claim Cleanup Failure",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProfileStoreError);
        assert.equal(error.code, "rollback-failed");
        assert.ok(error.cause instanceof AggregateError);
        assert.equal(error.cause.errors.length, 2);
        assert.ok(error.cause.errors[0] instanceof ProfileStoreError);
        assert.ok(error.cause.errors[1] instanceof ProfileStoreError);
        return true;
      },
    );
    assert.equal(await readFile(recoveryClaimPath, "utf8"), JSON.stringify({
      pid: process.pid,
      createdAt: 10_000,
    }));
  });
});

test("reclaims a recovery claim left by a crashed reclaimer", async () => {
  await withTemporaryLayout(async (layout) => {
    const profilesDir = join(layout.switcherDir, "profiles");
    const lockPath = join(profilesDir, ".create.lock");
    const recoveryLockPath = join(profilesDir, ".create.lock.recovery");
    const recoveryClaimPath = join(
      profilesDir,
      ".create.lock.recovery.claim",
    );
    const staleContents = JSON.stringify({ pid: 999999, createdAt: 0 });
    await mkdir(profilesDir, { recursive: true });
    await writeFile(lockPath, staleContents, "utf8");
    await writeFile(recoveryLockPath, staleContents, "utf8");
    // A real crashed process cannot run its finally block; this is its orphaned lease.
    await writeFile(recoveryClaimPath, staleContents, "utf8");

    const restartedStore = new ProfileStore(layout, {
      lockOptions: {
        clock: () => 20_000,
        isProcessAlive: () => false,
        lockRetryMs: 1,
        lockTimeoutMs: 10,
        staleLockMs: 1,
      },
    });
    const profile = await restartedStore.create({
      name: "Recovered After Crash",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });

    assert.equal(profile.id, "recovered-after-crash");
    await assert.rejects(() => readFile(lockPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(recoveryLockPath, "utf8"), {
      code: "ENOENT",
    });
    await assert.rejects(() => readFile(recoveryClaimPath, "utf8"), {
      code: "ENOENT",
    });
  });
});

test("reclaims a stale orphaned recovery claim when the guard is missing", async () => {
  await withTemporaryLayout(async (layout) => {
    const profilesDir = join(layout.switcherDir, "profiles");
    const lockPath = join(profilesDir, ".create.lock");
    const recoveryClaimPath = join(
      profilesDir,
      ".create.lock.recovery.claim",
    );
    const staleContents = JSON.stringify({ pid: 999999, createdAt: 0 });
    await mkdir(profilesDir, { recursive: true });
    await writeFile(lockPath, staleContents, "utf8");
    await writeFile(recoveryClaimPath, staleContents, "utf8");

    const store = new ProfileStore(layout, {
      lockOptions: {
        clock: () => 10_000,
        isProcessAlive: () => false,
        lockRetryMs: 1,
        lockTimeoutMs: 10,
        staleLockMs: 1,
      },
    });

    const profile = await store.create({
      name: "Recovered Orphaned Claim",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });

    assert.equal(profile.id, "recovered-orphaned-claim");
    await assert.rejects(() => readFile(lockPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(recoveryClaimPath, "utf8"), {
      code: "ENOENT",
    });
  });
});

test("does not delete a live recovery claim when the guard is missing", async () => {
  await withTemporaryLayout(async (layout) => {
    const profilesDir = join(layout.switcherDir, "profiles");
    const lockPath = join(profilesDir, ".create.lock");
    const recoveryGuardPath = join(profilesDir, ".create.lock.recovery");
    const recoveryClaimPath = join(
      profilesDir,
      ".create.lock.recovery.claim",
    );
    const staleLockContents = JSON.stringify({ pid: 999999, createdAt: 0 });
    const liveClaimContents = JSON.stringify({
      pid: process.pid,
      createdAt: 10_000,
    });
    await mkdir(profilesDir, { recursive: true });
    await writeFile(lockPath, staleLockContents, "utf8");
    await writeFile(recoveryClaimPath, liveClaimContents, "utf8");

    const store = new ProfileStore(layout, {
      lockOptions: {
        clock: () => 10_000,
        isProcessAlive: (pid: number) => pid === process.pid,
        lockTimeoutMs: 0,
        staleLockMs: 1,
      },
    });

    await assert.rejects(
      () =>
        store.create({
          name: "Blocked By Live Claim",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "persistence-failed",
    );

    assert.equal(await readFile(recoveryClaimPath, "utf8"), liveClaimContents);
    await assert.rejects(() => readFile(recoveryGuardPath, "utf8"), {
      code: "ENOENT",
    });
  });
});

test("does not let stale recovery reclaiming delete a live recovery guard", async () => {
  await withTemporaryLayout(async (layout) => {
    const profilesDir = join(layout.switcherDir, "profiles");
    const lockPath = join(profilesDir, ".create.lock");
    const recoveryLockPath = join(profilesDir, ".create.lock.recovery");
    const staleContents = JSON.stringify({ pid: 999999, createdAt: 0 });
    await mkdir(profilesDir, { recursive: true });
    await writeFile(lockPath, staleContents, "utf8");
    await writeFile(recoveryLockPath, staleContents, "utf8");

    const raceCoordinator = new RecoveryGuardInterleavingCoordinator();
    const firstLockFileSystem = new InterleavingRecoveryGuardFileSystem(
      "A",
      recoveryLockPath,
      staleContents,
      raceCoordinator,
    );
    const secondLockFileSystem = new InterleavingRecoveryGuardFileSystem(
      "B",
      recoveryLockPath,
      staleContents,
      raceCoordinator,
    );
    const lockOptions: ProfileLockOptions = {
      clock: () => 10_000,
      isProcessAlive: (pid: number) => pid === process.pid,
      lockRetryMs: 1,
      lockTimeoutMs: 1_000,
      staleLockMs: 1,
    };
    const secondStore = new ProfileStore(layout, {
      lockOptions: { ...lockOptions, fileSystem: secondLockFileSystem },
    });
    const secondCreate = secondStore.create({
      name: "Guard Reclaimer B",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });
    let firstCreate: Promise<ProfileRecord> | undefined;

    try {
      await raceCoordinator.waitForBStaleGuardRead();
      await unlink(recoveryLockPath);
      const firstStore = new ProfileStore(layout, {
        lockOptions: { ...lockOptions, fileSystem: firstLockFileSystem },
      });
      firstCreate = firstStore.create({
        name: "Guard Reclaimer A",
        kind: "official",
        configText: 'model_provider = "openai"\n',
      });
      await raceCoordinator.waitForALiveRecoveryGuard();

      const liveGuardContents = JSON.stringify({
        pid: process.pid,
        createdAt: 10_000,
      });
      assert.notEqual(liveGuardContents, staleContents);
      assert.equal(await readFile(recoveryLockPath, "utf8"), liveGuardContents);
      await assert.rejects(() => open(recoveryLockPath, "wx", 0o600), {
        code: "EEXIST",
      });

      raceCoordinator.releaseBStaleGuardRead();
      await raceCoordinator.waitForBStaleRecoveryAttempt();
      assert.equal(await readFile(recoveryLockPath, "utf8"), liveGuardContents);
      await assert.rejects(() => open(recoveryLockPath, "wx", 0o600), {
        code: "EEXIST",
      });
      raceCoordinator.releaseALiveRecoveryGuard();

      const results = await Promise.all([firstCreate, secondCreate]);
      assert.deepEqual(
        results.map((profile) => profile.id).sort(),
        ["guard-reclaimer-a", "guard-reclaimer-b"],
      );
    } finally {
      raceCoordinator.releaseBStaleGuardRead();
      raceCoordinator.releaseALiveRecoveryGuard();
      await Promise.allSettled(
        [firstCreate, secondCreate].filter(
          (create): create is Promise<ProfileRecord> => create !== undefined,
        ),
      );
    }
  });
});

test("serializes interleaved stale lock recovery without unlinking a live lock", async () => {
  await withTemporaryLayout(async (layout) => {
    const profilesDir = join(layout.switcherDir, "profiles");
    const lockPath = join(profilesDir, ".create.lock");
    const recoveryLockPath = join(profilesDir, ".create.lock.recovery");
    const staleContents = JSON.stringify({ pid: 12345, createdAt: 0 });
    await mkdir(profilesDir, { recursive: true });
    await writeFile(lockPath, staleContents, "utf8");

    const lockFileSystem = new InterleavingProfileLockFileSystem(
      lockPath,
      recoveryLockPath,
      staleContents,
    );
    const lockOptions: ProfileLockOptions = {
      clock: () => 10_000,
      isProcessAlive: (pid: number) => pid === process.pid,
      lockRetryMs: 1,
      lockTimeoutMs: 1_000,
      staleLockMs: 1,
      fileSystem: lockFileSystem,
    };
    const firstStore = new ProfileStore(layout, { lockOptions });
    const secondStore = new ProfileStore(layout, { lockOptions });
    const firstCreate = firstStore.create({
      name: "First Reclaimer",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });
    let secondCreate: Promise<ProfileRecord> | undefined;

    try {
      await lockFileSystem.waitForFirstReclaimerValidation();
      secondCreate = secondStore.create({
        name: "Second Reclaimer",
        kind: "official",
        configText: 'model_provider = "openai"\n',
      });
      await lockFileSystem.waitForRecoveryGuardContention();
      lockFileSystem.releaseFirstReclaimer();

      const [first, second] = await Promise.all([firstCreate, secondCreate]);
      assert.deepEqual(
        [first.id, second.id].sort(),
        ["first-reclaimer", "second-reclaimer"],
      );
      assert.equal(lockFileSystem.finalStaleCleanupReadObserved, true);
      assert.deepEqual(
        (await firstStore.list()).map((profile) => profile.id).sort(),
        ["first-reclaimer", "second-reclaimer"],
      );
    } finally {
      lockFileSystem.releaseFirstReclaimer();
      await Promise.allSettled(
        [firstCreate, secondCreate].filter(
          (create): create is Promise<ProfileRecord> => create !== undefined,
        ),
      );
    }
  });
});

test("fails closed when recovery guard cleanup fails", async () => {
  await withTemporaryLayout(async (layout) => {
    const profilesDir = join(layout.switcherDir, "profiles");
    const lockPath = join(profilesDir, ".create.lock");
    const recoveryLockPath = join(profilesDir, ".create.lock.recovery");
    await mkdir(profilesDir, { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: 12345, createdAt: 0 }), "utf8");

    const lockFileSystem = new FailingRecoveryGuardCleanupLockFileSystem(
      recoveryLockPath,
    );
    const store = new ProfileStore(layout, {
      lockOptions: {
        clock: () => 10_000,
        isProcessAlive: () => false,
        lockRetryMs: 1,
        lockTimeoutMs: 10,
        staleLockMs: 1,
        fileSystem: lockFileSystem,
      },
    });

    await assert.rejects(
      () =>
        store.create({
          name: "Recovery Cleanup Failure",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "persistence-failed",
    );
    await assert.rejects(
      () => readFile(join(profilesDir, "recovery-cleanup-failure", "config.toml"), "utf8"),
      { code: "ENOENT" },
    );
    await assert.rejects(() => readFile(join(profilesDir, "index.json"), "utf8"), {
      code: "ENOENT",
    });
  });
});

test("fails closed when a stale profile lock owner cannot be verified", async () => {
  await withTemporaryLayout(async (layout) => {
    const profilesDir = join(layout.switcherDir, "profiles");
    const lockPath = join(profilesDir, ".create.lock");
    const configPath = join(profilesDir, "unverifiable-lock", "config.toml");
    const indexPath = join(profilesDir, "index.json");
    await mkdir(profilesDir, { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: 12345, createdAt: 0 }), "utf8");
    const store = new ProfileStore(layout, {
      lockOptions: {
        clock: () => 10_000,
        lockTimeoutMs: 0,
        staleLockMs: 1,
        isProcessAlive: () => undefined,
      },
    });

    await assert.rejects(
      () =>
        store.create({
          name: "Unverifiable Lock",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "persistence-failed",
    );
    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
  });
});

test("derives custom secret IDs after restart without persisting them", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout, {
      now: () => "2026-08-24T00:00:00.000Z",
    });
    const profile = await store.create({
      name: "Research Proxy",
      kind: "custom",
      configText: 'model_provider = "research"\n',
      apiKeySecretId: "supplied-but-not-persisted",
    });

    const indexPath = join(layout.switcherDir, "profiles", "index.json");
    const indexText = await readFile(indexPath, "utf8");
    const persistedProfile = JSON.parse(indexText) as {
      profiles: Array<Record<string, unknown>>;
    };

    const expectedSecretId = "codex-provider-switcher.profile.research-proxy.api-key";
    assert.equal(await readFile(profile.configFile, "utf8"), 'model_provider = "research"\n');
    assert.equal(profile.apiKeySecretId, expectedSecretId);
    assert.equal(persistedProfile.profiles[0].apiKeySecretId, undefined);
    assert.doesNotMatch(indexText, /supplied-but-not-persisted/);
    assert.doesNotMatch(indexText, new RegExp(expectedSecretId));
    assert.equal((await new ProfileStore(layout).get(profile.id))?.apiKeySecretId, expectedSecretId);
  });
});

test("rejects credential assignments before writing profile files", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "credentialed-profile",
      "config.toml",
    );
    const indexPath = join(layout.switcherDir, "profiles", "index.json");

    await assert.rejects(
      () =>
        store.create({
          name: "Credentialed Profile",
          kind: "custom",
          configText: 'model_providers.research.api_key = "fixture-secret-value"\n',
        }),
      ProfileStoreError,
    );
    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
  });
});

test("rejects quoted TOML api_key assignments before writing profile files", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "quoted-credential",
      "config.toml",
    );
    const indexPath = join(layout.switcherDir, "profiles", "index.json");

    await assert.rejects(
      () =>
        store.create({
          name: "Quoted Credential",
          kind: "custom",
          configText: '"api_key" = "fixture-secret-value"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "invalid-config",
    );
    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
  });
});

test("rejects provider-prefixed TOML API key aliases before writing profile files", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "openai-alias",
      "config.toml",
    );
    const indexPath = join(layout.switcherDir, "profiles", "index.json");

    await assert.rejects(
      () =>
        store.create({
          name: "OpenAI Alias",
          kind: "custom",
          configText: '"OPENAI_API_KEY" = "fixture-secret-value"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "invalid-config",
    );
    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
  });
});

test("rejects private and access key aliases before writing profile files", async () => {
  for (const fixture of [
    {
      name: "Private Key",
      id: "private-key",
      configText: '"private_key" = "fixture-secret-value"\n',
    },
    {
      name: "Access Key",
      id: "access-key",
      configText: '"access-key" = "fixture-secret-value"\n',
    },
  ]) {
    await withTemporaryLayout(async (layout) => {
      const store = new ProfileStore(layout);
      const configPath = join(
        layout.switcherDir,
        "profiles",
        fixture.id,
        "config.toml",
      );
      const indexPath = join(layout.switcherDir, "profiles", "index.json");

      await assert.rejects(
        () =>
          store.create({
            name: fixture.name,
            kind: "custom",
            configText: fixture.configText,
          }),
        (error: unknown) =>
          error instanceof ProfileStoreError && error.code === "invalid-config",
      );
      await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
      await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
    });
  }
});

test("rejects secret and authorization header aliases before writing profile files", async () => {
  for (const fixture of [
    {
      name: "Secret Key",
      id: "secret-key",
      configText: '"secret_key" = "fixture-secret-value"\n',
    },
    {
      name: "Authorization Header",
      id: "authorization-header",
      configText: '"authorization_header" = "fixture-secret-value"\n',
    },
  ]) {
    await withTemporaryLayout(async (layout) => {
      const store = new ProfileStore(layout);
      const configPath = join(
        layout.switcherDir,
        "profiles",
        fixture.id,
        "config.toml",
      );
      const indexPath = join(layout.switcherDir, "profiles", "index.json");

      await assert.rejects(
        () =>
          store.create({
            name: fixture.name,
            kind: "custom",
            configText: fixture.configText,
          }),
        (error: unknown) =>
          error instanceof ProfileStoreError && error.code === "invalid-config",
      );
      await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
      await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
    });
  }
});

test("rejects auth fields before writing profile files", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "auth-field",
      "config.toml",
    );
    const indexPath = join(layout.switcherDir, "profiles", "index.json");

    await assert.rejects(
      () =>
        store.create({
          name: "Auth Field",
          kind: "custom",
          configText: 'auth = "Bearer fixture-secret-value"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "invalid-config",
    );
    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
  });
});

test("rejects nested provider header containers before writing profile files", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "provider-headers",
      "config.toml",
    );
    const indexPath = join(layout.switcherDir, "profiles", "index.json");

    await assert.rejects(
      () =>
        store.create({
          name: "Provider Headers",
          kind: "custom",
          configText: [
            'model_provider = "research"',
            "[model_providers.research.headers]",
            'user_agent = "fixture-header-value"',
            "",
          ].join("\n"),
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "invalid-config",
    );
    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
  });
});

test("rejects nested TOML authorization assignments before writing profile files", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "authorization-header",
      "config.toml",
    );
    const indexPath = join(layout.switcherDir, "profiles", "index.json");

    await assert.rejects(
      () =>
        store.create({
          name: "Authorization Header",
          kind: "custom",
          configText: '[headers]\nauthorization = "fixture-secret-value"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "invalid-config",
    );
    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
  });
});

test("rejects malformed TOML before writing profile files", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "broken-toml",
      "config.toml",
    );
    const indexPath = join(layout.switcherDir, "profiles", "index.json");

    await assert.rejects(
      () =>
        store.create({
          name: "Broken TOML",
          kind: "official",
          configText: 'model_provider = ["openai"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "invalid-config",
    );
    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
  });
});

test("preserves valid non-secret TOML text without reserialization", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configText = [
      "# Retain comments and quoted keys exactly.",
      '"model-provider" = "research"',
      '[model_providers."research endpoint"]',
      'base_url = "https://proxy.invalid/v1"',
      "request_max_retries = 3",
      "",
    ].join("\n");

    const profile = await store.create({
      name: "Raw TOML",
      kind: "official",
      configText,
    });

    assert.equal(await readFile(profile.configFile, "utf8"), configText);
  });
});

test("accepts documented non-secret provider configuration fields", async () => {
  await withTemporaryLayout(async (layout) => {
    const store = new ProfileStore(layout);
    const configText = [
      'model_provider = "research"',
      'model = "research-model"',
      'model_reasoning_effort = "high"',
      'model_verbosity = "low"',
      'approval_policy = "never"',
      'sandbox_mode = "workspace-write"',
      "project_doc_max_bytes = 4096",
      "[model_providers.research]",
      'name = "Research Proxy"',
      'base_url = "https://proxy.invalid/v1"',
      'wire_api = "responses"',
      "request_max_retries = 3",
      "stream_max_retries = 4",
      "stream_idle_timeout_ms = 30000",
      "requires_openai_auth = false",
      "supports_websockets = true",
      'query_params = { api_version = "v1" }',
      "",
    ].join("\n");

    const profile = await store.create({
      name: "Documented Provider",
      kind: "official",
      configText,
    });

    assert.equal(await readFile(profile.configFile, "utf8"), configText);
  });
});

test("rejects undocumented generic provider retry and timeout fields", async () => {
  for (const [name, configText] of [
    [
      "Generic Timeout",
      '[model_providers.research]\ntimeout = 1000\n',
    ],
    [
      "Generic Retries",
      '[model_providers.research]\nretries = 3\n',
    ],
    [
      "Generic Retry Table",
      '[model_providers.research.retry]\nmax_attempts = 3\n',
    ],
  ]) {
    await withTemporaryLayout(async (layout) => {
      const store = new ProfileStore(layout);
      const id = name.toLowerCase().replace(/ /g, "-");
      const profilesDir = join(layout.switcherDir, "profiles");

      await assert.rejects(
        () =>
          store.create({
            name,
            kind: "official",
            configText,
          }),
        (error: unknown) =>
          error instanceof ProfileStoreError && error.code === "invalid-config",
      );
      await assert.rejects(
        () => readFile(join(profilesDir, id, "config.toml"), "utf8"),
        { code: "ENOENT" },
      );
      await assert.rejects(() => readFile(join(profilesDir, "index.json"), "utf8"), {
        code: "ENOENT",
      });
    });
  }
});

test("uses exclusive config creation, atomic index renames, and Linux 0600 file modes", async () => {
  await withTemporaryLayout(async (layout) => {
    const fileSystem = new RecordingProfileFileSystem();
    const store = new ProfileStore(layout, {
      fileSystem,
      platform: "linux",
      now: () => "2026-08-24T00:00:00.000Z",
    });

    await store.create({
      name: "Atomic Profile",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });

    assert.ok(fileSystem.renames.length >= 1);
    assert.ok(
      fileSystem.renames.every(
        ({ from, to }) => dirname(from) === dirname(to) && basename(from).includes(".tmp-"),
      ),
    );
    assert.equal(fileSystem.exclusiveWrites.length, 1);
    assert.equal(fileSystem.exclusiveWrites[0]?.mode, 0o600);
    assert.ok(fileSystem.chmods.length >= 1);
    assert.ok(fileSystem.chmods.every(({ mode }) => mode === 0o600));
  });
});

test("holds a zero-inode Windows config while creating and updating its index", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows config publication holds require Windows.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const fileSystem = new RecordingProfileFileSystem();
      const windowsFileOperations = new RecordingWindowsFileOperations();
      const store = new ProfileStore(layout, {
        fileSystem,
        fileIdentityOptions: zeroInodeProfileIdentityOptions(windowsFileOperations),
      });
      const indexPath = join(layout.switcherDir, "profiles", "index.json");
      const publicationStates: number[] = [];
      fileSystem.renameHook = async (_from, to) => {
        if (to === indexPath) {
          publicationStates.push(windowsFileOperations.activeHolds);
        }
      };

      const created = await store.create({
        name: "Held Config",
        kind: "official",
        configText: 'model_provider = "openai"\n',
      });
      await store.update(created.id, {
        name: "Held Config Updated",
        kind: "official",
        configText: 'model_provider = "updated"\n',
      });

      assert.deepEqual(publicationStates, [1, 1]);
      assert.equal(windowsFileOperations.activeHolds, 0);
      assert.equal(windowsFileOperations.holdRequests.length, 2);
      assert.equal(await readFile(indexPath, "utf8").then((value) => value.includes("Held Config Updated")), true);
    });
  });
});

test("closes a zero-inode Windows config hold when index rename fails", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows config publication holds require Windows.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const fileSystem = new FailingIndexProfileFileSystem();
      const windowsFileOperations = new RecordingWindowsFileOperations();
      const store = new ProfileStore(layout, {
        fileSystem,
        fileIdentityOptions: zeroInodeProfileIdentityOptions(windowsFileOperations),
      });

      await assert.rejects(
        () => store.create({
          name: "Held Rename Failure",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
        (error: unknown) => error instanceof ProfileStoreError && error.code === "rollback-failed",
      );
      assert.equal(windowsFileOperations.holdRequests.length, 1);
      assert.equal(windowsFileOperations.activeHolds, 0);
    });
  });
});

test("rejects a zero-inode Windows config replacement before publication hold", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows config publication holds require Windows.");
    return;
  }
  await withZeroInodeProfileStats(async () => {
    await withTemporaryLayout(async (layout) => {
      const configPath = join(
        layout.switcherDir,
        "profiles",
        "held-replacement",
        "config.toml",
      );
      const externalPath = join(layout.codexHome, "held-external-config.toml");
      const externalContents = 'model_provider = "external"\n';
      await writeFile(externalPath, externalContents, "utf8");
      const fileSystem = new RecordingProfileFileSystem();
      const windowsFileOperations = new RecordingWindowsFileOperations([], (path) => {
        if (path === configPath) {
          writeFileSync(configPath, externalContents, "utf8");
          throw new Error("config replaced before publication hold");
        }
      });
      const store = new ProfileStore(layout, {
        fileSystem,
        fileIdentityOptions: zeroInodeProfileIdentityOptions(windowsFileOperations),
      });

      await assert.rejects(
        () => store.create({
          name: "Held Replacement",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
        (error: unknown) => error instanceof ProfileStoreError && error.code === "rollback-failed",
      );
      assert.equal(await readFile(configPath, "utf8"), externalContents);
      assert.equal(fileSystem.renames.some(({ to }) => to.endsWith("index.json")), false);
      assert.equal(windowsFileOperations.activeHolds, 0);
    });
  });
});

test("wraps profile directory access errors without writing profile files", async () => {
  await withTemporaryLayout(async (layout) => {
    const fileSystem = new FailingMkdirProfileFileSystem();
    const store = new ProfileStore(layout, { fileSystem });
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "directory-error",
      "config.toml",
    );
    const indexPath = join(layout.switcherDir, "profiles", "index.json");

    await assert.rejects(
      () =>
        store.create({
          name: "Directory Error",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
      (error: unknown) => isPersistenceErrorWithCause(error, fileSystem.failure),
    );
    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
  });
});

test("wraps profile write I/O errors without writing profile files", async () => {
  await withTemporaryLayout(async (layout) => {
    const fileSystem = new FailingWriteProfileFileSystem();
    const store = new ProfileStore(layout, { fileSystem });
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "write-error",
      "config.toml",
    );
    const indexPath = join(layout.switcherDir, "profiles", "index.json");

    await assert.rejects(
      () =>
        store.create({
          name: "Write Error",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
      (error: unknown) => isPersistenceErrorWithCause(error, fileSystem.failure),
    );
    await assert.rejects(() => readFile(configPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(indexPath, "utf8"), { code: "ENOENT" });
  });
});

test("reports exclusive Profile config write failures without cleanup attempts", async () => {
  await withTemporaryLayout(async (layout) => {
    const fileSystem = new FailingWriteAndTemporaryCleanupProfileFileSystem();
    const store = new ProfileStore(layout, { fileSystem });

    await assert.rejects(
      () =>
        store.create({
          name: "Write And Cleanup Error",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProfileStoreError);
        assert.equal(error.code, "persistence-failed");
        assert.equal(error.cause, fileSystem.writeFailure);
        return true;
      },
    );
  });
});

test("preserves the just-written config when index persistence fails", async () => {
  await withTemporaryLayout(async (layout) => {
    const fileSystem = new FailingIndexProfileFileSystem();
    const store = new ProfileStore(layout, { fileSystem });
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "rollback-profile",
      "config.toml",
    );

    await assert.rejects(
      () =>
        store.create({
          name: "Rollback Profile",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "rollback-failed",
    );

    assert.equal(await readFile(configPath, "utf8"), 'model_provider = "openai"\n');
    assert.equal(fileSystem.unlinked.includes(configPath), false);
  });
});

test("allocates a new Profile id instead of overwriting retained config after a failed create", async () => {
  await withTemporaryLayout(async (layout) => {
    const failingStore = new ProfileStore(layout, {
      fileSystem: new FailingIndexProfileFileSystem(),
    });
    const retainedConfigPath = join(
      layout.switcherDir,
      "profiles",
      "retry-profile",
      "config.toml",
    );
    const externalConfig = 'model_provider = "external"\n';

    await assert.rejects(
      () => failingStore.create({
        name: "Retry Profile",
        kind: "official",
        configText: 'model_provider = "initial"\n',
      }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "rollback-failed",
    );
    await writeFile(retainedConfigPath, externalConfig, "utf8");

    const created = await new ProfileStore(layout).create({
      name: "Retry Profile",
      kind: "official",
      configText: 'model_provider = "replacement"\n',
    });

    assert.equal(created.id, "retry-profile-2");
    assert.equal(await readFile(retainedConfigPath, "utf8"), externalConfig);
    assert.equal(await readFile(created.configFile, "utf8"), 'model_provider = "replacement"\n');
  });
});

test("does not overwrite config created after a new Profile directory is reserved", async () => {
  await withTemporaryLayout(async (layout) => {
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "publish-race",
      "config.toml",
    );
    const externalConfig = 'model_provider = "external"\n';
    const store = new ProfileStore(layout, {
      fileSystem: new ExternalConfigBeforeExclusiveWriteProfileFileSystem(
        configPath,
        externalConfig,
      ),
    });

    await assert.rejects(
      () => store.create({
        name: "Publish Race",
        kind: "official",
        configText: 'model_provider = "extension"\n',
      }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "persistence-failed",
    );

    assert.equal(await readFile(configPath, "utf8"), externalConfig);
  });
});

test("fails closed when a reserved Profile directory is replaced before config publication", async () => {
  await withTemporaryLayout(async (layout) => {
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "directory-race",
      "config.toml",
    );
    const store = new ProfileStore(layout, {
      fileSystem: new ReplaceDirectoryAfterTemporaryWriteProfileFileSystem(configPath),
    });

    await assert.rejects(
      () => store.create({
        name: "Directory Race",
        kind: "official",
        configText: 'model_provider = "extension"\n',
      }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "persistence-failed",
    );
    assert.equal(await readFile(configPath, "utf8"), 'model_provider = "extension"\n');
    await assert.rejects(
      () => readFile(join(layout.switcherDir, "profiles", "index.json"), "utf8"),
      { code: "ENOENT" },
    );
  });
});

test("preserves an externally replaced config when Profile creation cannot publish its index", async () => {
  await withTemporaryLayout(async (layout) => {
    const configPath = join(
      layout.switcherDir,
      "profiles",
      "externally-replaced-profile",
      "config.toml",
    );
    const externalConfig = 'model_provider = "external"\n';
    const store = new ProfileStore(layout, {
      fileSystem: new ExternalConfigEditOnIndexFailureProfileFileSystem(
        configPath,
        externalConfig,
      ),
    });

    await assert.rejects(
      () =>
        store.create({
          name: "Externally Replaced Profile",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "rollback-failed",
    );

    assert.equal(await readFile(configPath, "utf8"), externalConfig);
  });
});

test("preserves an externally replaced config when Profile update cannot publish its index", async () => {
  await withTemporaryLayout(async (layout) => {
    const initialStore = new ProfileStore(layout);
    const created = await initialStore.create({
      name: "Externally Replaced Update",
      kind: "official",
      configText: 'model_provider = "openai"\n',
    });
    const externalConfig = 'model_provider = "external"\n';
    const store = new ProfileStore(layout, {
      fileSystem: new ExternalConfigEditOnIndexFailureProfileFileSystem(
        created.configFile,
        externalConfig,
      ),
    });

    await assert.rejects(
      () =>
        store.update(created.id, {
          name: "Externally Replaced Update",
          kind: "official",
          configText: 'model_provider = "updated"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "rollback-failed",
    );

    assert.equal(await readFile(created.configFile, "utf8"), externalConfig);
  });
});

test("reports a config cleanup failure after index persistence fails", async () => {
  await withTemporaryLayout(async (layout) => {
    const fileSystem = new FailingIndexProfileFileSystem({ failConfigCleanup: true });
    const store = new ProfileStore(layout, { fileSystem });

    await assert.rejects(
      () =>
        store.create({
          name: "Cleanup Failure",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "rollback-failed",
    );
  });
});

test("reports a temporary cleanup failure after index persistence fails", async () => {
  await withTemporaryLayout(async (layout) => {
    const fileSystem = new FailingIndexProfileFileSystem({
      failTemporaryCleanup: true,
    });
    const store = new ProfileStore(layout, { fileSystem });

    await assert.rejects(
      () =>
        store.create({
          name: "Temporary Cleanup Failure",
          kind: "official",
          configText: 'model_provider = "openai"\n',
        }),
      (error: unknown) =>
        error instanceof ProfileStoreError && error.code === "rollback-failed",
    );
  });
});

test("stores secret values through verified local or Remote SSH SecretStorage", async () => {
  const secrets = new FakeSecretStorage();
  const store = new SecretStore(secrets, verifiedRemoteStorage());
  const secretId = "profile.research-proxy.secret";
  const fixtureSecretValue = "fixture-secret-value";

  await store.set(secretId, fixtureSecretValue);
  assert.equal(await store.get(secretId), fixtureSecretValue);
  await store.delete(secretId);
  assert.equal(await store.get(secretId), undefined);

  const localStore = new SecretStore(secrets, verifiedLocalWindowsStorage());
  await localStore.set(secretId, fixtureSecretValue);
  assert.equal(await localStore.get(secretId), fixtureSecretValue);

  const localLinuxStore = new SecretStore(secrets, verifiedLocalLinuxStorage());
  await localLinuxStore.set(secretId, fixtureSecretValue);
  assert.equal(await localLinuxStore.get(secretId), fixtureSecretValue);

  assert.throws(
    () => new SecretStore(secrets, { platform: "win32" }),
    UnsupportedSecretStorageError,
  );
  assert.throws(
    () =>
      new SecretStore(secrets, {
        uri: {
          scheme: "file",
          fsPath: "C:\\Users\\Ada\\AppData\\Roaming\\Code\\User\\globalStorage",
        },
        platform: "linux",
        remoteName: "ssh-remote",
      }),
    UnsupportedSecretStorageError,
  );
  assert.throws(
    () =>
      new SecretStore(secrets, {
        uri: {
          scheme: "vscode-remote",
          authority: "ssh-remote+research-host",
          fsPath: "/home/remote-user/.vscode-server/data/User/globalStorage",
        },
        platform: "win32",
        remoteName: "ssh-remote",
      }),
    UnsupportedSecretStorageError,
  );
  assert.throws(
    () =>
      new SecretStore(secrets, {
        uri: {
          scheme: "file",
          fsPath: "//fileserver/profiles/ada/globalStorage",
        },
        platform: "linux",
      }),
    UnsupportedSecretStorageError,
  );
  assert.throws(
    () =>
      new SecretStore(secrets, {
        uri: {
          scheme: "vscode-remote",
          authority: "ssh-remote",
          fsPath: "/home/remote-user/.vscode-server/data/User/globalStorage",
        },
        platform: "linux",
        remoteName: "ssh-remote",
      }),
    UnsupportedSecretStorageError,
  );
});

test("does not expose secret values in SecretStorage errors", async () => {
  const fixtureSecretValue = "fixture-secret-value";
  const store = new SecretStore(new FailingSecretStorage(), verifiedRemoteStorage());

  await assert.rejects(
    () => store.set("profile.research-proxy.secret", fixtureSecretValue),
    (error: unknown) => {
      assert.ok(error instanceof SecretStorageError);
      assert.doesNotMatch(error.message, /fixture-secret-value/);
      return true;
    },
  );
});

async function withTemporaryLayout(
  callback: (layout: CodexLayout) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-switcher-profiles-"));
  try {
    await callback({
      codexHome: directory,
      configPath: join(directory, "config.toml"),
      authPath: join(directory, "auth.json"),
      sessionsDir: join(directory, "sessions"),
      archivedSessionsDir: join(directory, "archived_sessions"),
      sqlitePath: join(directory, "state_5.sqlite"),
      switcherDir: join(directory, "provider-switcher"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withZeroInodeProfileStats(callback: () => Promise<void>): Promise<void> {
  const mutableFs = nodeRequire("node:fs/promises") as {
    lstat: typeof lstat;
    open: typeof open;
  };
  const originalLstat = mutableFs.lstat;
  const originalOpen = mutableFs.open;
  mutableFs.lstat = (async (...args: Parameters<typeof lstat>) => {
    const stats = await originalLstat(...args);
    return withZeroInodeProfileStatsValue(stats);
  }) as typeof lstat;
  mutableFs.open = (async (...args: Parameters<typeof open>) => {
    const handle = await originalOpen(...args);
    return new Proxy(handle, {
      get(target, property) {
        if (property === "stat") {
          return async (...statArgs: Parameters<typeof target.stat>) => {
            const stats = await target.stat(...statArgs);
            return withZeroInodeProfileStatsValue(stats);
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
    syncBuiltinESMExports();
  }
}

function withZeroInodeProfileStatsValue<T extends Awaited<ReturnType<typeof lstat>>>(
  stats: T,
): T {
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

function zeroInodeProfileIdentityOptions(
  windowsFileOperations: WindowsFileOperations = nativeProfileWindowsFileOperations(),
) {
  return {
    platform: "win32" as const,
    windowsFileOperations,
  };
}

function nativeProfileWindowsFileOperations(): WindowsFileOperations {
  return {
    captureFileIdentity: captureProfileWindowsFileIdentity,
    deleteFileIfMatches(path, expected) {
      const current = captureProfileWindowsFileIdentity(path);
      if (!sameProfileWindowsFileIdentity(current, expected)) {
        return "identity-mismatch";
      }
      unlinkSync(path);
      return "deleted";
    },
    holdFileIfMatches(path, expected) {
      const current = captureProfileWindowsFileIdentity(path);
      if (!sameProfileWindowsFileIdentity(current, expected)) {
        throw new Error("identity mismatch");
      }
      let closed = false;
      return {
        close() {
          if (closed) {
            return;
          }
          closed = true;
        },
      };
    },
  };
}

interface WindowsReplacementRule {
  readonly matches: (path: string) => boolean;
  readonly replacementContents: string;
}

interface WindowsDeleteFailureRule {
  readonly matches: (path: string) => boolean;
  readonly action: "disappear-and-throw" | "throw-and-keep";
}

type WindowsDeleteRule = WindowsReplacementRule | WindowsDeleteFailureRule;

class RecordingWindowsFileOperations implements WindowsFileOperations {
  readonly capturedPaths: string[] = [];
  readonly capturesAfterDeleteFailure: string[] = [];
  readonly holdRequests: Array<{
    path: string;
    expected: WindowsFileIdentity;
  }> = [];
  readonly deleteRequests: Array<{
    path: string;
    expected: WindowsFileIdentity;
  }> = [];
  readonly replacements: Array<{ path: string; contents: string }> = [];
  activeHolds = 0;
  private readonly processedRules = new Set<WindowsDeleteRule>();
  private deleteFailureObserved = false;

  constructor(
    private readonly deletionRules: readonly WindowsDeleteRule[] = [],
    private readonly holdHook?: (path: string) => void,
  ) {}

  captureFileIdentity(path: string): WindowsFileIdentity {
    this.capturedPaths.push(path);
    if (this.deleteFailureObserved) {
      this.capturesAfterDeleteFailure.push(path);
    }
    return captureProfileWindowsFileIdentity(path);
  }

  deleteFileIfMatches(
    path: string,
    expected: WindowsFileIdentity,
  ): "deleted" | "identity-mismatch" {
    const expectedSnapshot = snapshotProfileWindowsFileIdentity(expected);
    this.deleteRequests.push({ path, expected: expectedSnapshot });

    let current: WindowsFileIdentity;
    try {
      current = captureProfileWindowsFileIdentity(path);
    } catch {
      return "identity-mismatch";
    }
    if (!sameProfileWindowsFileIdentity(current, expectedSnapshot)) {
      return "identity-mismatch";
    }

    const rule = this.deletionRules.find(
      (candidate) => !this.processedRules.has(candidate) && candidate.matches(path),
    );
    if (rule !== undefined && "action" in rule) {
      this.processedRules.add(rule);
      this.deleteFailureObserved = true;
      if (rule.action === "disappear-and-throw") {
        unlinkSync(path);
      }
      throw new Error("controlled native delete failure");
    }
    if (rule !== undefined) {
      const replacementPath = `${path}.replacement`;
      writeFileSync(replacementPath, rule.replacementContents, "utf8");
      renameSync(replacementPath, path);
      this.processedRules.add(rule);
      this.replacements.push({ path, contents: rule.replacementContents });
      return "identity-mismatch";
    }

    unlinkSync(path);
    return "deleted";
  }

  holdFileIfMatches(
    path: string,
    expected: WindowsFileIdentity,
  ): { close: () => void } {
    this.holdHook?.(path);
    const expectedSnapshot = snapshotProfileWindowsFileIdentity(expected);
    const current = captureProfileWindowsFileIdentity(path);
    if (!sameProfileWindowsFileIdentity(current, expectedSnapshot)) {
      throw new Error("identity mismatch");
    }
    this.holdRequests.push({ path, expected: expectedSnapshot });
    this.activeHolds += 1;
    let closed = false;
    return {
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        this.activeHolds -= 1;
      },
    };
  }
}

function captureProfileWindowsFileIdentity(path: string): WindowsFileIdentity {
  const stats = lstatSync(path, { bigint: true });
  if (stats.nlink !== 1n) {
    throw new Error("native identity is unavailable");
  }
  return {
    volumeSerial: "0000000000000001",
    fileId: `${stats.dev.toString(16).padStart(16, "0").slice(-16)}${stats.ino
      .toString(16)
      .padStart(16, "0")
      .slice(-16)}`,
    linkCount: 1n,
  };
}

function snapshotProfileWindowsFileIdentity(
  identity: WindowsFileIdentity,
): WindowsFileIdentity {
  if (
    !/^[0-9a-f]{16}$/u.test(identity.volumeSerial) ||
    !/^[0-9a-f]{32}$/u.test(identity.fileId) ||
    identity.linkCount !== 1n
  ) {
    throw new Error("invalid expected Windows file identity");
  }
  return {
    volumeSerial: identity.volumeSerial,
    fileId: identity.fileId,
    linkCount: identity.linkCount,
  };
}

function sameProfileWindowsFileIdentity(
  left: WindowsFileIdentity,
  right: WindowsFileIdentity,
): boolean {
  return left.volumeSerial === right.volumeSerial &&
    left.fileId === right.fileId &&
    left.linkCount === right.linkCount;
}

function unavailableProfileWindowsFileOperations(): WindowsFileOperations {
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

class RecordingProfileFileSystem implements ProfileFileSystem {
  readonly exclusiveWrites: Array<{ path: string; mode: number }> = [];
  readonly renames: Array<{ from: string; to: string }> = [];
  readonly chmods: Array<{ path: string; mode: number }> = [];
  readonly unlinked: string[] = [];
  renameHook?: (from: string, to: string) => void | Promise<void>;

  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async readFile(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async openRead(path: string) {
    const handle = await open(path, "r");
    return {
      stat: () => handle.stat({ bigint: true }),
      readFile: () => handle.readFile({ encoding: "utf8" }),
      close: () => handle.close(),
    };
  }

  async writeFile(path: string, contents: string): Promise<void> {
    await writeFile(path, contents, "utf8");
  }

  async writeFileExclusive(path: string, contents: string, mode: number): Promise<void> {
    this.exclusiveWrites.push({ path, mode });
    const handle = await open(path, "wx", mode);
    try {
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
  }

  async rename(from: string, to: string): Promise<void> {
    this.renames.push({ from, to });
    await this.renameHook?.(from, to);
    await rename(from, to);
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.chmods.push({ path, mode });
    await chmod(path, mode);
  }

  async unlink(path: string): Promise<void> {
    this.unlinked.push(path);
    await unlink(path);
  }
}

class RecordingProfileLockFileSystem
  extends RecordingProfileFileSystem
  implements ProfileLockFileSystem
{
  async open(path: string, flags: "wx", mode: number) {
    return open(path, flags, mode);
  }
}

class NoPostCreationLockReadFileSystem extends RecordingProfileLockFileSystem {
  private lockCreated = false;

  constructor(private readonly lockPath: string) {
    super();
  }

  override async open(path: string, flags: "wx", mode: number) {
    const handle = await super.open(path, flags, mode);
    if (path === this.lockPath) {
      this.lockCreated = true;
    }
    return handle;
  }

  override async readFile(path: string): Promise<string> {
    if (this.lockCreated && path === this.lockPath) {
      throw new Error("lock was read after creation");
    }
    return super.readFile(path);
  }
}

class CloseFailureProfileLockFileSystem extends RecordingProfileLockFileSystem {
  constructor(private readonly lockPath: string) {
    super();
  }

  override async open(path: string, flags: "wx", mode: number) {
    const handle = await super.open(path, flags, mode);
    if (path !== this.lockPath) {
      return handle;
    }
    return {
      writeFile: (contents: string, encoding: BufferEncoding) =>
        handle.writeFile(contents, encoding),
      async close(): Promise<void> {
        await handle.close();
        throw new Error("controlled profile lock close failure");
      },
    };
  }
}

class ReplaceConfigBeforeIndexPublishProfileFileSystem
  extends RecordingProfileFileSystem
{
  private replaced = false;

  constructor(
    private readonly configPath: string,
    private readonly externalPath: string,
  ) {
    super();
  }

  override async writeFile(path: string, contents: string): Promise<void> {
    await super.writeFile(path, contents);
    if (!this.replaced && path.includes(".index.json.tmp-")) {
      this.replaced = true;
      await rename(this.externalPath, this.configPath);
    }
  }
}

class ReplaceIndexAfterReadHandleProfileFileSystem
  extends RecordingProfileFileSystem
{
  private replaced = false;

  constructor(
    private readonly indexPath: string,
    private readonly externalIndexPath: string,
  ) {
    super();
  }

  override async openRead(path: string) {
    const handle = await super.openRead(path);
    if (!this.replaced && path === this.indexPath) {
      try {
        this.replaced = true;
        await rm(this.indexPath);
        await rename(this.externalIndexPath, this.indexPath);
      } catch (error: unknown) {
        await handle.close();
        throw error;
      }
    }
    return handle;
  }
}

class ReplaceConfigAfterReadProfileFileSystem
  extends RecordingProfileFileSystem
{
  private replaced = false;

  constructor(
    private readonly configPath: string,
    private readonly externalPath: string,
  ) {
    super();
  }

  override async openRead(path: string) {
    const handle = await super.openRead(path);
    if (path !== this.configPath || this.replaced) {
      return handle;
    }
    return {
      close: () => handle.close(),
      readFile: async () => {
        const contents = await handle.readFile();
        this.replaced = true;
        await rm(this.configPath);
        await rename(this.externalPath, this.configPath);
        return contents;
      },
      stat: () => handle.stat(),
    };
  }
}

class FirstIndexReadBarrierProfileFileSystem extends RecordingProfileFileSystem {
  private firstIndexReadStarted = false;
  private indexReadReleased = false;
  private releaseIndexReadBarrier!: () => void;
  private resolveFirstIndexRead!: () => void;
  private readonly firstIndexRead = new Promise<void>((resolve) => {
    this.resolveFirstIndexRead = resolve;
  });
  private readonly indexReadBarrier = new Promise<void>((resolve) => {
    this.releaseIndexReadBarrier = resolve;
  });

  async waitForFirstIndexRead(): Promise<void> {
    await this.firstIndexRead;
  }

  releaseFirstIndexRead(): void {
    this.indexReadReleased = true;
    this.releaseIndexReadBarrier();
  }

  override async openRead(path: string) {
    if (path.endsWith("index.json") && !this.indexReadReleased) {
      if (!this.firstIndexReadStarted) {
        this.firstIndexReadStarted = true;
        this.resolveFirstIndexRead();
        await this.indexReadBarrier;
      }
      const error = new Error("profile index is not available") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return super.openRead(path);
  }
}

class InterleavingProfileLockFileSystem
  extends RecordingProfileFileSystem
  implements ProfileLockFileSystem
{
  finalStaleCleanupReadObserved = false;
  private firstValidationReleased = false;
  private profileLockReadCount = 0;
  private recoveryGuardContentionResolved = false;
  private releaseFirstValidationBarrier!: () => void;
  private resolveFirstValidation!: () => void;
  private resolveRecoveryGuardContention!: () => void;
  private readonly firstValidation = new Promise<void>((resolve) => {
    this.resolveFirstValidation = resolve;
  });
  private readonly firstValidationBarrier = new Promise<void>((resolve) => {
    this.releaseFirstValidationBarrier = resolve;
  });
  private readonly recoveryGuardContention = new Promise<void>((resolve) => {
    this.resolveRecoveryGuardContention = resolve;
  });

  constructor(
    private readonly profileLockPath: string,
    private readonly recoveryLockPath: string,
    private readonly staleContents: string,
  ) {
    super();
  }

  async waitForFirstReclaimerValidation(): Promise<void> {
    await withTimeout(this.firstValidation, "first stale lock validation");
  }

  async waitForRecoveryGuardContention(): Promise<void> {
    await withTimeout(this.recoveryGuardContention, "recovery guard contention");
  }

  releaseFirstReclaimer(): void {
    if (!this.firstValidationReleased) {
      this.firstValidationReleased = true;
      this.releaseFirstValidationBarrier();
    }
  }

  async open(path: string, flags: "wx", mode: number) {
    try {
      return await open(path, flags, mode);
    } catch (error: unknown) {
      if (
        path === this.recoveryLockPath &&
        (error as NodeJS.ErrnoException).code === "EEXIST" &&
        !this.recoveryGuardContentionResolved
      ) {
        this.recoveryGuardContentionResolved = true;
        this.resolveRecoveryGuardContention();
      }
      throw error;
    }
  }

  override async readFile(path: string): Promise<string> {
    const contents = await super.readFile(path);
    if (path === this.profileLockPath) {
      this.profileLockReadCount += 1;
      if (this.profileLockReadCount === 1 && !this.firstValidationReleased) {
        this.resolveFirstValidation();
        await this.firstValidationBarrier;
      }
      if (this.profileLockReadCount === 3) {
        this.finalStaleCleanupReadObserved = contents === this.staleContents;
      }
    }
    return contents;
  }
}

class RecoveryGuardInterleavingCoordinator {
  private bStaleGuardReadReleased = false;
  private aLiveRecoveryGuardReleased = false;
  private resolveBStaleGuardRead!: () => void;
  private releaseBStaleGuardReadBarrier!: () => void;
  private resolveALiveRecoveryGuard!: () => void;
  private releaseALiveRecoveryGuardBarrier!: () => void;
  private resolveBStaleRecoveryAttempt!: () => void;
  private readonly bStaleGuardRead = new Promise<void>((resolve) => {
    this.resolveBStaleGuardRead = resolve;
  });
  private readonly bStaleGuardReadBarrier = new Promise<void>((resolve) => {
    this.releaseBStaleGuardReadBarrier = resolve;
  });
  private readonly aLiveRecoveryGuard = new Promise<void>((resolve) => {
    this.resolveALiveRecoveryGuard = resolve;
  });
  private readonly aLiveRecoveryGuardBarrier = new Promise<void>((resolve) => {
    this.releaseALiveRecoveryGuardBarrier = resolve;
  });
  private readonly bStaleRecoveryAttempt = new Promise<void>((resolve) => {
    this.resolveBStaleRecoveryAttempt = resolve;
  });

  async waitForBStaleGuardRead(): Promise<void> {
    await withTimeout(this.bStaleGuardRead, "B stale recovery guard read");
  }

  async recordBStaleGuardRead(): Promise<void> {
    this.resolveBStaleGuardRead();
    if (!this.bStaleGuardReadReleased) {
      await this.bStaleGuardReadBarrier;
    }
  }

  releaseBStaleGuardRead(): void {
    if (!this.bStaleGuardReadReleased) {
      this.bStaleGuardReadReleased = true;
      this.releaseBStaleGuardReadBarrier();
    }
  }

  async waitForALiveRecoveryGuard(): Promise<void> {
    await withTimeout(this.aLiveRecoveryGuard, "A live recovery guard");
  }

  async recordALiveRecoveryGuard(): Promise<void> {
    this.resolveALiveRecoveryGuard();
    if (!this.aLiveRecoveryGuardReleased) {
      await this.aLiveRecoveryGuardBarrier;
    }
  }

  releaseALiveRecoveryGuard(): void {
    if (!this.aLiveRecoveryGuardReleased) {
      this.aLiveRecoveryGuardReleased = true;
      this.releaseALiveRecoveryGuardBarrier();
    }
  }

  async waitForBStaleRecoveryAttempt(): Promise<void> {
    await withTimeout(
      this.bStaleRecoveryAttempt,
      "B stale recovery attempt",
    );
  }

  recordBStaleRecoveryAttempt(): void {
    this.resolveBStaleRecoveryAttempt();
  }
}

class InterleavingRecoveryGuardFileSystem
  extends RecordingProfileFileSystem
  implements ProfileLockFileSystem
{
  private bStaleGuardReadObserved = false;

  constructor(
    private readonly role: "A" | "B",
    private readonly recoveryLockPath: string,
    private readonly staleContents: string,
    private readonly coordinator: RecoveryGuardInterleavingCoordinator,
  ) {
    super();
  }

  async open(path: string, flags: "wx", mode: number) {
    const handle = await open(path, flags, mode);
    if (this.role !== "A" || path !== this.recoveryLockPath) {
      return handle;
    }
    const coordinator = this.coordinator;
    return {
      async writeFile(contents: string, encoding: BufferEncoding): Promise<void> {
        await handle.writeFile(contents, encoding);
      },
      async close(): Promise<void> {
        await handle.close();
        await coordinator.recordALiveRecoveryGuard();
      },
    };
  }

  override async readFile(path: string): Promise<string> {
    const contents = await super.readFile(path);
    if (
      this.role === "B" &&
      path === this.recoveryLockPath &&
      !this.bStaleGuardReadObserved
    ) {
      if (contents === this.staleContents) {
        this.bStaleGuardReadObserved = true;
        await this.coordinator.recordBStaleGuardRead();
      }
    } else if (
      this.role === "B" &&
      path === this.recoveryLockPath &&
      this.bStaleGuardReadObserved &&
      contents !== this.staleContents
    ) {
      this.coordinator.recordBStaleRecoveryAttempt();
    }
    return contents;
  }

}

class FailingRecoveryClaimReadFileSystem
  extends RecordingProfileFileSystem
  implements ProfileLockFileSystem
{
  private claimCreated = false;
  private claimReadFailed = false;

  constructor(
    private readonly recoveryClaimPath: string,
    private readonly failClaimCleanup = false,
  ) {
    super();
  }

  async open(path: string, flags: "wx", mode: number) {
    const handle = await open(path, flags, mode);
    if (path !== this.recoveryClaimPath) {
      return handle;
    }
    const markClaimCreated = (): void => {
      this.claimCreated = true;
    };
    return {
      async writeFile(contents: string, encoding: BufferEncoding): Promise<void> {
        await handle.writeFile(contents, encoding);
      },
      async close(): Promise<void> {
        await handle.close();
        markClaimCreated();
      },
    };
  }

  override async readFile(path: string): Promise<string> {
    if (
      path === this.recoveryClaimPath &&
      this.claimCreated &&
      !this.claimReadFailed
    ) {
      this.claimReadFailed = true;
      throw createFileSystemError("EIO", "recovery claim read failed");
    }
    return super.readFile(path);
  }

  override async unlink(path: string): Promise<void> {
    if (path === this.recoveryClaimPath && this.failClaimCleanup) {
      throw createFileSystemError("EIO", "recovery claim cleanup failed");
    }
    await super.unlink(path);
  }

}

class FailingRecoveryGuardCleanupLockFileSystem
  extends RecordingProfileFileSystem
  implements ProfileLockFileSystem
{
  constructor(private readonly recoveryLockPath: string) {
    super();
  }

  async open(path: string, flags: "wx", mode: number) {
    return open(path, flags, mode);
  }

  override async unlink(path: string): Promise<void> {
    if (path === this.recoveryLockPath) {
      throw createFileSystemError("EIO", "recovery guard cleanup failed");
    }
    await super.unlink(path);
  }

}

class FailingMkdirProfileFileSystem extends RecordingProfileFileSystem {
  readonly failure = createFileSystemError("EACCES", "profile directory denied");

  override async mkdir(): Promise<void> {
    throw this.failure;
  }
}

class FailingWriteProfileFileSystem extends RecordingProfileFileSystem {
  readonly failure = createFileSystemError("EIO", "profile write failed");

  override async writeFileExclusive(): Promise<void> {
    throw this.failure;
  }
}

class FailingWriteAndTemporaryCleanupProfileFileSystem extends RecordingProfileFileSystem {
  readonly writeFailure = createFileSystemError("EIO", "profile write failed");

  override async writeFileExclusive(): Promise<void> {
    throw this.writeFailure;
  }
}

class FailingIndexProfileFileSystem extends RecordingProfileFileSystem {
  constructor(
    private readonly options: {
      failConfigCleanup?: boolean;
      failTemporaryCleanup?: boolean;
    } = {},
  ) {
    super();
  }

  override async rename(from: string, to: string): Promise<void> {
    if (to.endsWith("index.json")) {
      throw new Error("index persistence failed");
    }
    await super.rename(from, to);
  }

  override async unlink(path: string): Promise<void> {
    this.unlinked.push(path);
    if (this.options.failConfigCleanup && path.endsWith("config.toml")) {
      throw new Error("config cleanup failed");
    }
    if (this.options.failTemporaryCleanup && path.includes(".index.json.tmp-")) {
      throw new Error("temporary cleanup failed");
    }
    await unlink(path);
  }
}

class NoPostFailureReadFileSystem extends FailingIndexProfileFileSystem {
  readonly temporaryReads: string[] = [];

  override async readFile(path: string): Promise<string> {
    if (basename(path).startsWith(".index.json.tmp-")) {
      this.temporaryReads.push(path);
      throw new Error("temporary contents must not be read after native delete failure");
    }
    return super.readFile(path);
  }
}

class ExternalConfigEditOnIndexFailureProfileFileSystem
  extends RecordingProfileFileSystem
{
  constructor(
    private readonly configPath: string,
    private readonly externalConfig: string,
  ) {
    super();
  }

  override async rename(from: string, to: string): Promise<void> {
    if (to.endsWith("index.json")) {
      await writeFile(this.configPath, this.externalConfig, "utf8");
      throw new Error("index persistence failed");
    }
    await super.rename(from, to);
  }
}

class ExternalConfigBeforeExclusiveWriteProfileFileSystem
  extends RecordingProfileFileSystem
{
  constructor(
    private readonly configPath: string,
    private readonly externalConfig: string,
  ) {
    super();
  }

  override async writeFileExclusive(path: string, contents: string, mode: number): Promise<void> {
    await writeFile(this.configPath, this.externalConfig, "utf8");
    await super.writeFileExclusive(path, contents, mode);
  }
}

class ReplaceConfigBeforeReadHandleProfileFileSystem
  extends RecordingProfileFileSystem
{
  private replaced = false;

  constructor(
    private readonly configPath: string,
    private readonly externalConfigPath: string,
  ) {
    super();
  }

  override async openRead(path: string) {
    if (!this.replaced && path === this.configPath) {
      this.replaced = true;
      await rm(this.configPath);
      await rename(this.externalConfigPath, this.configPath);
    }
    return super.openRead(path);
  }
}

class ReplaceDirectoryAfterTemporaryWriteProfileFileSystem
  extends RecordingProfileFileSystem
{
  constructor(private readonly configPath: string) {
    super();
  }

  override async writeFileExclusive(path: string, contents: string, mode: number): Promise<void> {
    const originalDirectory = dirname(this.configPath);
    const movedDirectory = `${originalDirectory}-replaced`;
    await rename(originalDirectory, movedDirectory);
    await mkdir(dirname(this.configPath));
    await super.writeFileExclusive(path, contents, mode);
  }
}

class FakeSecretStorage implements SecretStorageLike {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class FailingSecretStorage implements SecretStorageLike {
  async get(): Promise<string | undefined> {
    return undefined;
  }

  async store(_key: string, value: string): Promise<void> {
    throw new Error(`storage rejected ${value}`);
  }

  async delete(): Promise<void> {
    return undefined;
  }
}

function verifiedRemoteStorage() {
  return {
    uri: {
      scheme: "vscode-remote",
      authority: "ssh-remote+research-host",
      fsPath: "/home/remote-user/.vscode-server/data/User/globalStorage",
    },
    platform: "linux" as const,
    remoteName: "ssh-remote",
  };
}

function verifiedLocalWindowsStorage() {
  return {
    uri: {
      scheme: "file",
      fsPath: "C:\\Users\\Ada\\AppData\\Roaming\\Code\\User\\globalStorage",
    },
    platform: "win32" as const,
  };
}

function verifiedLocalLinuxStorage() {
  return {
    uri: {
      scheme: "file",
      fsPath: "/home/ada/.config/Code/User/globalStorage",
    },
    platform: "linux" as const,
  };
}

function createFileSystemError(
  code: string,
  message: string,
): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

async function windowsShortPath(path: string): Promise<string | undefined> {
  try {
    const result = await execFile(
      "cmd.exe",
      ["/d", "/c", `for %I in (${path}) do @echo %~sI`],
      { encoding: "utf8" },
    );
    const shortPath = result.stdout.trim();
    return shortPath.length === 0 ? undefined : shortPath;
  } catch {
    return undefined;
  }
}

function isPersistenceErrorWithCause(
  error: unknown,
  cause: unknown,
): boolean {
  return (
    error instanceof ProfileStoreError &&
    error.code === "persistence-failed" &&
    (error as Error & { cause?: unknown }).cause === cause
  );
}

async function withTimeout<T>(promise: Promise<T>, description: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}.`)),
          500,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
