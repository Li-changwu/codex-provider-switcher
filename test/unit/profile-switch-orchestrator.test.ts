import assert from "node:assert/strict";
import { execFile as nativeExecFile } from "node:child_process";
import { link, lstat, mkdtemp, mkdir, open, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import sqlite3 from "sqlite3";
import { ActiveProfileStore } from "../../src/core/active-profile";
import { ProfileStore } from "../../src/core/profiles";
import {
  switchStoredProfile,
} from "../../src/core/profile-switch-orchestrator";
import { SecretStore, type SecretStorageLike } from "../../src/core/secrets";
import type { CodexLayout } from "../../src/core/types";

const fixtureApiKey = "fixture-custom-api-key";
const officialConfig = 'model_provider = "openai"\n';
const customConfig = [
  'model_provider = "custom"',
  'model = "gpt-5.6-sol"',
  '[model_providers.custom]',
  'name = "Fixture proxy"',
  'base_url = "https://example.test/v1"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  "",
].join("\n");
const execFile = promisify(nativeExecFile);
const nodeRequire = createRequire(import.meta.url);

test("switches a stored Profile on a Windows zero-inode filesystem", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows zero-inode file identity is not available on this platform.");
    return;
  }

  await withFixture(async ({ layout, secrets, custom }) => {
    await withZeroInodeFileStats(async () => {
      const profiles = new ProfileStore(layout);
      const activeProfiles = new ActiveProfileStore(layout);
      const result = await switchStoredProfile(
        { targetProfileId: custom.id },
        { layout, profiles, secrets, activeProfiles },
      );

      assert.equal(result.status, "committed");
      assert.equal(await readFile(layout.configPath, "utf8"), customConfig);
    });
  });
});

test("switches through a Windows 8.3 Codex Home alias", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows path aliases are not available on this platform.");
    return;
  }

  await withFixture(async ({ layout, secrets, custom }) => {
    const shortHome = await windowsShortPath(layout.codexHome);
    if (shortHome === undefined || shortHome === layout.codexHome) {
      t.skip("Windows short-path aliases are unavailable on this runner.");
      return;
    }
    const shortLayout: CodexLayout = {
      codexHome: shortHome,
      configPath: join(shortHome, "config.toml"),
      authPath: join(shortHome, "auth.json"),
      sessionsDir: join(shortHome, "sessions"),
      archivedSessionsDir: join(shortHome, "archived_sessions"),
      sqlitePath: join(shortHome, "state_5.sqlite"),
      switcherDir: join(shortHome, "provider-switcher"),
    };
    const indexPath = join(shortLayout.switcherDir, "profiles", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      profiles: Array<{ configFile: string }>;
    };
    for (const profile of index.profiles) {
      profile.configFile = profile.configFile.replace(layout.switcherDir, shortLayout.switcherDir);
    }
    await writeFile(indexPath, `${JSON.stringify(index, undefined, 2)}\n`, "utf8");
    const profiles = new ProfileStore(shortLayout);
    const activeProfiles = new ActiveProfileStore(shortLayout);

    const result = await switchStoredProfile(
      { targetProfileId: custom.id },
      { layout: shortLayout, profiles, secrets, activeProfiles },
    );

    assert.equal(result.status, "committed");
    assert.equal(await readFile(shortLayout.configPath, "utf8"), customConfig);
  });
});

test("switches official and custom Profiles through config, auth, rollout, SQLite, and active state", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, official, custom, rolloutPath }) => {
    const customResult = await switchStoredProfile(
      { targetProfileId: custom.id },
      { layout, profiles, secrets, activeProfiles: active },
    );

    assert.equal(customResult.status, "committed");
    assert.equal(await readFile(layout.configPath, "utf8"), customConfig);
    assert.equal(await readFile(layout.authPath, "utf8"), JSON.stringify({ OPENAI_API_KEY: fixtureApiKey }));
    assert.match(await readFile(rolloutPath, "utf8"), /"custom"/);
    assert.equal(await readProvider(layout.sqlitePath), "custom");
    assert.equal((await active.get())?.profileId, custom.id);

    const officialResult = await switchStoredProfile(
      { targetProfileId: official.id },
      {
        layout,
        profiles,
        secrets,
        activeProfiles: active,
        officialLogin: {
          run: async (officialLayout) => {
            assert.equal(officialLayout.codexHome, layout.codexHome);
            assert.equal((await active.get())?.profileId, custom.id);
            return { loginExitCode: 0, statusExitCode: 0 };
          },
        },
      },
    );

    assert.equal(officialResult.status, "committed");
    assert.equal(await readFile(layout.configPath, "utf8"), officialConfig);
    await assert.rejects(() => readFile(layout.authPath, "utf8"), { code: "ENOENT" });
    assert.match(await readFile(rolloutPath, "utf8"), /"openai"/);
    assert.equal(await readProvider(layout.sqlitePath), "openai");
    assert.equal((await active.get())?.profileId, official.id);
  });
});

test("rolls back an official switch when native login is not verified", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, official, custom }) => {
    const customResult = await switchStoredProfile(
      { targetProfileId: custom.id },
      { layout, profiles, secrets, activeProfiles: active },
    );
    assert.equal(customResult.status, "committed");
    const configBefore = await readFile(layout.configPath, "utf8");
    const authBefore = await readFile(layout.authPath, "utf8");

    const result = await switchStoredProfile(
      { targetProfileId: official.id },
      {
        layout,
        profiles,
        secrets,
        activeProfiles: active,
        officialLogin: {
          run: async () => ({
            loginExitCode: 1,
            statusExitCode: undefined,
          }),
        },
      },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "rolledBack");
    assert.equal(await readFile(layout.configPath, "utf8"), configBefore);
    assert.equal(await readFile(layout.authPath, "utf8"), authBefore);
    assert.equal((await active.get())?.profileId, custom.id);
    assert.doesNotMatch(JSON.stringify(result), /fixture-custom-api-key/);
  });
});

test("rolls back an official switch after native login cancellation", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, official, custom }) => {
    const customResult = await switchStoredProfile(
      { targetProfileId: custom.id },
      { layout, profiles, secrets, activeProfiles: active },
    );
    assert.equal(customResult.status, "committed");
    const controller = new AbortController();
    const result = await switchStoredProfile(
      { targetProfileId: official.id, signal: controller.signal },
      {
        layout,
        profiles,
        secrets,
        activeProfiles: active,
        officialLogin: {
          run: async () => {
            controller.abort();
            return {
              loginExitCode: 130,
              statusExitCode: undefined,
              cancelled: true,
            };
          },
        },
      },
    );

    assert.equal(result.status, "cancelled");
    assert.equal(result.journalState, "rolledBack");
    assert.equal((await active.get())?.profileId, custom.id);
    assert.doesNotMatch(JSON.stringify(result), /fixture-custom-api-key/);
  });
});

test("fails closed before an official switch when no login executor is provided", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, official, custom }) => {
    const customResult = await switchStoredProfile(
      { targetProfileId: custom.id },
      { layout, profiles, secrets, activeProfiles: active },
    );
    assert.equal(customResult.status, "committed");

    const result = await switchStoredProfile(
      { targetProfileId: official.id },
      { layout, profiles, secrets, activeProfiles: active },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "rolledBack");
    assert.equal((await active.get())?.profileId, custom.id);
  });
});

test("fails a custom switch with redacted diagnostics when its SecretStorage key is missing", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, custom, rolloutPath }) => {
    await secrets.delete(custom.apiKeySecretId ?? "");
    const configBefore = await readFile(layout.configPath, "utf8");
    const rolloutBefore = await readFile(rolloutPath, "utf8");

    const result = await switchStoredProfile(
      { targetProfileId: custom.id },
      { layout, profiles, secrets, activeProfiles: active },
    );
    assertPreflightFailure(result);
    assert.equal(await readFile(layout.configPath, "utf8"), configBefore);
    assert.equal(await readFile(rolloutPath, "utf8"), rolloutBefore);
    assert.equal((await active.get())?.profileId, "official");
  });
});

test("rejects a traversal-style Profile record without exposing its escaped config path", async () => {
  await withFixture(async ({ layout, secrets, active, official }) => {
    const escapedConfig = join(layout.switcherDir, "outside", "config.toml");
    await mkdir(join(layout.switcherDir, "outside"), { recursive: true });
    const externalBefore = 'model_provider = "openai"\n';
    await writeFile(escapedConfig, externalBefore, "utf8");
    const traversalProfile = {
      ...official,
      id: "../outside",
      configFile: escapedConfig,
    };

    const result = await switchStoredProfile(
      { targetProfileId: traversalProfile.id },
      {
        layout,
        profiles: {
          get: async () => traversalProfile,
          list: async () => [traversalProfile],
        },
        secrets,
        activeProfiles: active,
      },
    );
    assertPreflightFailure(result);
    assert.equal(await readFile(escapedConfig, "utf8"), externalBefore);
  });
});

test("rejects a managed Profile config symlink without reading its external target", async (t) => {
  await withFixture(async ({ layout, profiles, secrets, active, custom }) => {
    const externalPath = join(layout.codexHome, "external-config.toml");
    const externalBefore = customConfig;
    await writeFile(externalPath, externalBefore, "utf8");
    await unlink(custom.configFile);
    try {
      await symlink(externalPath, custom.configFile, "file");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Creating symbolic links requires Windows developer privileges.");
        return;
      }
      throw error;
    }

    const result = await switchStoredProfile(
      { targetProfileId: custom.id },
      { layout, profiles, secrets, activeProfiles: active },
    );
    assertPreflightFailure(result);
    assert.equal(await readFile(externalPath, "utf8"), externalBefore);
  });
});

test("rejects a hard-linked stored Profile config without touching its external target", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, custom }) => {
    const externalPath = join(layout.codexHome, "external-linked-config.toml");
    const externalBefore = customConfig;
    await writeFile(externalPath, externalBefore, "utf8");
    await unlink(custom.configFile);
    await link(externalPath, custom.configFile);

    const result = await switchStoredProfile(
      { targetProfileId: custom.id },
      { layout, profiles, secrets, activeProfiles: active },
    );

    assertPreflightFailure(result);
    assert.equal(await readFile(externalPath, "utf8"), externalBefore);
  });
});

test("forwards every real rollout scan update before the scan stage completes", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, custom }) => {
    await writeFile(
      join(layout.sessionsDir, "second-session.jsonl"),
      sessionMetaLine("session-2", "openai"),
      "utf8",
    );
    const events: Array<{ stage: string; completed: number; total?: number; index: number }> = [];

    const result = await switchStoredProfile(
      { targetProfileId: custom.id },
      {
        layout,
        profiles,
        secrets,
        activeProfiles: active,
        onProgress: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "committed");
    assert.equal(result.synchronizedChanges, 2);
    const scans = events.filter((event) => event.stage === "scan");
    assert.deepEqual(scans.map(({ completed, total }) => ({ completed, total })), [
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ]);
    assert.ok(events.findIndex((event) => event.stage === "rollouts") > events.indexOf(scans[1]));
    assert.ok(events.every((event, index) => index === 0 || event.index >= events[index - 1].index));
  });
});

test("waits for cancellation rollback and leaves the previous active Profile authoritative", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, custom, rolloutPath }) => {
    const controller = new AbortController();
    const configBefore = await readFile(layout.configPath, "utf8");
    const rolloutBefore = await readFile(rolloutPath, "utf8");
    const sqliteBefore = await readFile(layout.sqlitePath);
    const result = await switchStoredProfile(
      { targetProfileId: custom.id, signal: controller.signal },
      {
        layout,
        profiles,
        secrets,
        activeProfiles: active,
        onProgress: (event) => {
          if (event.stage === "rollouts") {
            controller.abort();
          }
        },
      },
    );

    assert.equal(result.status, "cancelled");
    assert.equal(result.journalState, "rolledBack");
    assert.equal(await readFile(layout.configPath, "utf8"), configBefore);
    assert.equal(await readFile(rolloutPath, "utf8"), rolloutBefore);
    assert.deepEqual(await readFile(layout.sqlitePath), sqliteBefore);
    assert.equal((await active.get())?.profileId, "official");
  });
});

test("rolls back durable config, auth, rollout, and SQLite targets after a real SQLite mutation fails", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, custom, rolloutPath }) => {
    const configBefore = await readFile(layout.configPath, "utf8");
    const authBefore = await readFile(layout.authPath, "utf8");
    const rolloutBefore = await readFile(rolloutPath, "utf8");
    const sqliteBefore = await readFile(layout.sqlitePath);
    let sqliteMutationObserved = false;
    const result = await switchStoredProfile(
      { targetProfileId: custom.id },
      {
        layout,
        profiles,
        secrets,
        activeProfiles: active,
        mutationHooks: {
          afterSqliteUpdate: () => {
            sqliteMutationObserved = true;
            throw new Error("injected SQLite boundary failure");
          },
        },
      },
    );

    assert.equal(sqliteMutationObserved, true);
    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "rolledBack");
    assert.equal(await readFile(layout.configPath, "utf8"), configBefore);
    assert.equal(await readFile(layout.authPath, "utf8"), authBefore);
    assert.equal(await readFile(rolloutPath, "utf8"), rolloutBefore);
    assert.deepEqual(await readFile(layout.sqlitePath), sqliteBefore);
    assert.equal((await active.get())?.profileId, "official");
  });
});

test("reports a recoverable active Profile reconciliation state without undoing a committed switch", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, custom }) => {
    const result = await switchStoredProfile(
      { targetProfileId: custom.id },
      {
        layout,
        profiles,
        secrets,
        activeProfiles: {
          snapshot: () => active.snapshot(),
          set: async () => {
            throw new Error("active Profile persistence failed");
          },
        },
      },
    );

    assert.equal(result.status, "committed");
    assert.equal(result.activeProfileState, "reconciliation-required");
    assert.equal(await readFile(layout.configPath, "utf8"), customConfig);
    assert.equal(await readProvider(layout.sqlitePath), "custom");
    assert.equal((await active.get())?.profileId, "official");
  });
});

test("reconciles a failed active marker acknowledgement before a later rollback restores custom auth", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, official, custom }) => {
    let failAcknowledgement = true;
    const flakyActive = {
      snapshot: () => active.snapshot(),
      set: async (profileId: string) => {
        if (failAcknowledgement) {
          failAcknowledgement = false;
          throw new Error("injected active Profile acknowledgement failure");
        }
        return active.set(profileId);
      },
    };
    const committed = await switchStoredProfile(
      { targetProfileId: custom.id },
      { layout, profiles, secrets, activeProfiles: flakyActive },
    );
    assert.equal(committed.status, "committed");
    assert.equal(committed.activeProfileState, "reconciliation-required");
    assert.equal((await active.get())?.profileId, official.id);
    assert.equal(await readFile(layout.authPath, "utf8"), JSON.stringify({ OPENAI_API_KEY: fixtureApiKey }));

    const rolledBack = await switchStoredProfile(
      { targetProfileId: official.id },
      {
        layout,
        profiles,
        secrets,
        activeProfiles: flakyActive,
        officialLogin: {
          run: async () => ({ loginExitCode: 0, statusExitCode: 0 }),
        },
        mutationHooks: {
          afterSqliteUpdate: () => {
            throw new Error("injected ordinary mutation failure");
          },
        },
      },
    );

    assert.equal(rolledBack.status, "failed");
    assert.equal(rolledBack.journalState, "rolledBack");
    assert.equal(await readFile(layout.configPath, "utf8"), customConfig);
    assert.equal(await readFile(layout.authPath, "utf8"), JSON.stringify({ OPENAI_API_KEY: fixtureApiKey }));
    assert.equal(await readProvider(layout.sqlitePath), "custom");
    assert.equal((await active.get())?.profileId, custom.id);
  });
});

test("does not read the blocked switch target before the operation lock is acquired", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, official, custom }) => {
    let acknowledgeEntered!: () => void;
    let releaseAcknowledgement!: () => void;
    const acknowledgementEntered = new Promise<void>((resolve) => {
      acknowledgeEntered = resolve;
    });
    const acknowledgementBarrier = new Promise<void>((resolve) => {
      releaseAcknowledgement = resolve;
    });
    const activeWithBarrier = {
      snapshot: () => active.snapshot(),
      set: async (profileId: string) => {
        if (profileId === custom.id) {
          acknowledgeEntered();
          await acknowledgementBarrier;
        }
        return active.set(profileId);
      },
    };
    let blockedTargetReads = 0;
    const watchedProfiles = {
      get: async (profileId: string) => {
        if (profileId === official.id) {
          blockedTargetReads += 1;
        }
        return profiles.get(profileId);
      },
      list: () => profiles.list(),
    };
    const first = switchStoredProfile(
      { targetProfileId: custom.id },
      { layout, profiles: watchedProfiles, secrets, activeProfiles: activeWithBarrier },
    );
    await acknowledgementEntered;

    const blocked = await switchStoredProfile(
      { targetProfileId: official.id },
      { layout, profiles: watchedProfiles, secrets, activeProfiles: activeWithBarrier },
    );
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.operationId, "unstarted");
    assert.equal(blockedTargetReads, 0);

    releaseAcknowledgement();
    assert.equal((await first).status, "committed");
  });
});

test("serializes a selected Profile edit through switch acknowledgement", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, custom }) => {
    let acknowledgeEntered!: () => void;
    let releaseAcknowledgement!: () => void;
    const acknowledgementEntered = new Promise<void>((resolve) => {
      acknowledgeEntered = resolve;
    });
    const acknowledgementBarrier = new Promise<void>((resolve) => {
      releaseAcknowledgement = resolve;
    });
    const activeWithBarrier = {
      snapshot: () => active.snapshot(),
      set: async (profileId: string) => {
        if (profileId === custom.id) {
          acknowledgeEntered();
          await acknowledgementBarrier;
        }
        return active.set(profileId);
      },
    };
    const switchPromise = switchStoredProfile(
      { targetProfileId: custom.id },
      { layout, profiles, secrets, activeProfiles: activeWithBarrier },
    );
    await acknowledgementEntered;

    let updateCompleted = false;
    const updatePromise = profiles.update(custom.id, {
      name: "Custom renamed",
      kind: custom.kind,
      configText: customConfig,
      providerId: custom.providerId,
    }).then((profile) => {
      updateCompleted = true;
      return profile;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(updateCompleted, false);

    releaseAcknowledgement();
    const [result, updated] = await Promise.all([switchPromise, updatePromise]);
    assert.equal(result.status, "committed");
    assert.equal(updated?.name, "Custom renamed");
    assert.equal(await readFile(layout.configPath, "utf8"), customConfig);
    assert.equal(await readFile(updated?.configFile ?? "", "utf8"), customConfig);
    assert.equal((await active.get())?.profileId, custom.id);
  });
});

test("rolls back when the selected Profile is edited after preflight and before commit", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, official, custom, rolloutPath }) => {
    let selectedKeyRead!: () => void;
    let releaseSelectedKey!: () => void;
    const selectedKeyRequested = new Promise<void>((resolve) => {
      selectedKeyRead = resolve;
    });
    const selectedKeyBarrier = new Promise<void>((resolve) => {
      releaseSelectedKey = resolve;
    });
    const delayedSecrets = {
      get: async (key: string) => {
        if (key === custom.apiKeySecretId) {
          selectedKeyRead();
          await selectedKeyBarrier;
        }
        return secrets.get(key);
      },
    };
    const switchPromise = switchStoredProfile(
      { targetProfileId: custom.id },
      { layout, profiles, secrets: delayedSecrets, activeProfiles: active },
    );

    await selectedKeyRequested;
    const editedConfig = customConfig.replace('model = "gpt-5.6-sol"', 'model = "gpt-5.6-sol-edited"');
    await profiles.update(custom.id, {
      name: custom.name,
      kind: custom.kind,
      configText: editedConfig,
      providerId: custom.providerId,
    });
    releaseSelectedKey();

    const result = await switchPromise;
    assert.equal(result.status, "failed");
    assert.equal(result.journalState, "rolledBack");
    assert.equal(await readFile(layout.configPath, "utf8"), officialConfig);
    assert.match(await readFile(rolloutPath, "utf8"), /"openai"/);
    assert.equal((await active.get())?.profileId, official.id);
  });
});

test("refuses switching when the active config does not match exactly one stored Profile", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, custom }) => {
    await writeFile(layout.configPath, 'model_provider = "unmanaged"\n', "utf8");

    const result = await switchStoredProfile(
      { targetProfileId: custom.id },
      { layout, profiles, secrets, activeProfiles: active },
    );

    assertPreflightFailure(result, "reconciliation-required");
    assert.equal(await readFile(layout.configPath, "utf8"), 'model_provider = "unmanaged"\n');
  });
});

test("refuses switching when multiple stored Profiles match the active config", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, custom }) => {
    await profiles.create({
      name: "Duplicate official",
      kind: "official",
      configText: officialConfig,
      providerId: "openai",
    });

    const result = await switchStoredProfile(
      { targetProfileId: custom.id },
      { layout, profiles, secrets, activeProfiles: active },
    );

    assertPreflightFailure(result, "reconciliation-required");
    assert.equal(await readFile(layout.configPath, "utf8"), officialConfig);
  });
});

test("redacts tampered Profile TOML in the public preflight failure", async () => {
  await withFixture(async ({ layout, profiles, secrets, active, custom }) => {
    const tamperedSecret = "test-orchestrator-tampered-secret";
    await writeFile(
      custom.configFile,
      `model_provider = "custom"\napi_key = "${tamperedSecret}"\n`,
      "utf8",
    );

    const result = await switchStoredProfile(
      { targetProfileId: custom.id },
      { layout, profiles, secrets, activeProfiles: active },
    );
    assertPreflightFailure(result);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(tamperedSecret));
  });
});

function assertPreflightFailure(
  result: Awaited<ReturnType<typeof switchStoredProfile>>,
  activeProfileState: "unchanged" | "reconciliation-required" = "unchanged",
): void {
  assert.equal(result.status, "failed");
  assert.equal(result.failureStage, "preflight");
  assert.equal(result.failureMessage, "The provider switch operation failed.");
  assert.equal(result.errorSummary?.message, "The provider switch operation failed.");
  assert.equal(result.activeProfileState, activeProfileState);
}

async function withFixture(
  callback: (fixture: {
    layout: CodexLayout;
    profiles: ProfileStore;
    secrets: SecretStore;
    active: ActiveProfileStore;
    official: Awaited<ReturnType<ProfileStore["create"]>>;
    custom: Awaited<ReturnType<ProfileStore["create"]>>;
    rolloutPath: string;
  }) => Promise<void>,
): Promise<void> {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-provider-switch-orchestrator-"));
  const layout: CodexLayout = {
    codexHome,
    configPath: join(codexHome, "config.toml"),
    authPath: join(codexHome, "auth.json"),
    sessionsDir: join(codexHome, "sessions"),
    archivedSessionsDir: join(codexHome, "archived_sessions"),
    sqlitePath: join(codexHome, "state_5.sqlite"),
    switcherDir: join(codexHome, "provider-switcher"),
  };
  await mkdir(layout.sessionsDir);
  await mkdir(layout.archivedSessionsDir);
  await writeFile(layout.configPath, officialConfig, "utf8");
  await writeFile(layout.authPath, '{"native":"credential"}', "utf8");
  const rolloutPath = join(layout.sessionsDir, "session.jsonl");
  await writeFile(rolloutPath, sessionMetaLine("session-1", "openai"), "utf8");
  await seedDatabase(layout.sqlitePath, "openai");
  const profiles = new ProfileStore(layout);
  const official = await profiles.create({
    name: "Official",
    kind: "official",
    configText: officialConfig,
    providerId: "openai",
  });
  const custom = await profiles.create({
    name: "Custom",
    kind: "custom",
    configText: customConfig,
    providerId: "custom",
  });
  const secrets = new SecretStore(new MemorySecrets(), verifiedLocalStorage());
  await secrets.set(custom.apiKeySecretId ?? "", fixtureApiKey);
  const active = new ActiveProfileStore(layout, {
    now: () => "2026-08-27T00:00:00.000Z",
  });
  await active.set(official.id);
  try {
    await callback({ layout, profiles, secrets, active, official, custom, rolloutPath });
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

function sessionMetaLine(sessionId: string, provider: string): string {
  return JSON.stringify({
    timestamp: "2026-08-27T00:00:00.000Z",
    type: "session_meta",
    payload: { id: sessionId, model_provider: provider, title: "Fixture" },
  });
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

async function withZeroInodeFileStats(callback: () => Promise<void>): Promise<void> {
  const mutableFs = nodeRequire("node:fs/promises") as {
    lstat: typeof lstat;
    open: typeof open;
  };
  const originalLstat = mutableFs.lstat;
  const originalOpen = mutableFs.open;
  mutableFs.lstat = (async (...args: Parameters<typeof lstat>) => {
    return zeroInodeStats(await originalLstat(...args));
  }) as typeof lstat;
  mutableFs.open = (async (...args: Parameters<typeof open>) => {
    const handle = await originalOpen(...args);
    return new Proxy(handle, {
      get(target, property) {
        if (property === "stat") {
          return async (...statArgs: Parameters<typeof target.stat>) =>
            zeroInodeStats(await target.stat(...statArgs));
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

function zeroInodeStats<T extends Awaited<ReturnType<typeof lstat>>>(stats: T): T {
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

async function seedDatabase(path: string, provider: string): Promise<void> {
  const database = await openDatabase(path);
  try {
    await run(database, "PRAGMA user_version = 5");
    await run(database, "CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, title TEXT, encrypted_content TEXT)");
    await run(database, "INSERT INTO threads (id, model_provider, title, encrypted_content) VALUES (?, ?, ?, ?)", "thread-1", provider, "Fixture", null);
  } finally {
    await closeDatabase(database);
  }
}

async function readProvider(path: string): Promise<string | null> {
  const database = await openDatabase(path);
  try {
    return await getValue<string | null>(database, "SELECT model_provider FROM threads WHERE id = ?", "thread-1");
  } finally {
    await closeDatabase(database);
  }
}

function openDatabase(path: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(path, (error) => error ? reject(error) : resolve(database));
  });
}

function closeDatabase(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()));
}

function run(database: sqlite3.Database, sql: string, ...params: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => database.run(sql, params, (error) => error ? reject(error) : resolve()));
}

function getValue<T>(database: sqlite3.Database, sql: string, ...params: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => database.get<{ model_provider: T }>(sql, params, (error, row) => error ? reject(error) : resolve(row?.model_provider as T)));
}

class MemorySecrets implements SecretStorageLike {
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

function verifiedLocalStorage() {
  return process.platform === "win32"
    ? { uri: { scheme: "file", fsPath: "C:\\Users\\Test\\AppData\\Roaming\\Code\\User\\globalStorage" }, platform: "win32" as const }
    : { uri: { scheme: "file", fsPath: "/tmp/codex-provider-switcher-tests" }, platform: "linux" as const };
}
