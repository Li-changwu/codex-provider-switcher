import assert from "node:assert/strict";
import test from "node:test";
import { ProviderWorkbenchController } from "../../src/ui/provider-workbench";
import type { ProfileRecord } from "../../src/core/types";

test("rejects unknown messages and never exposes a configured custom secret", async () => {
  const fixture = workbenchFixture();
  await assert.rejects(() => fixture.controller.handleMessage({ type: "unknown", apiKey: "raw-key" }), /message/i);

  const snapshot = await fixture.controller.handleMessage({ type: "loadProfile", profileId: "proxy" });
  const serialized = JSON.stringify(snapshot);
  assert.match(serialized, /REDACTED/);
  assert.doesNotMatch(serialized, /raw-key/);
});

test("lists public Provider navigation data without configuration contents", async () => {
  const fixture = workbenchFixture();
  const result = await fixture.controller.handleMessage({ type: "listProfiles" });
  assert.deepEqual(result, {
    type: "profileList",
    activeProfileId: "proxy",
    profiles: [{ id: "proxy", name: "Research Proxy", kind: "custom", active: true }],
  });
});

test("enables sessions only after a successful user-triggered synchronization", async () => {
  const fixture = workbenchFixture();
  assert.equal(fixture.switchCalls.length, 0);

  const result = await fixture.controller.handleMessage({ type: "syncSessions", profileId: "proxy" });

  assert.equal(fixture.switchCalls.length, 1);
  assert.equal(result.type, "operationCompleted");
  assert.equal(result.message, "No session metadata needs synchronization.");
  const sessions = await fixture.controller.handleMessage({ type: "listSessions", profileId: "proxy" });
  assert.deepEqual(sessions.sessions.map((session) => ({ id: session.sessionId, canContinue: session.canContinue })), [
    { id: "session-1", canContinue: true },
  ]);
});

test("confirms and forks synchronized history when native resume is unavailable", async () => {
  const fixture = workbenchFixture();
  await fixture.controller.handleMessage({ type: "syncSessions", profileId: "proxy" });

  const result = await fixture.controller.handleMessage({
    type: "continueSession",
    profileId: "proxy",
    sessionId: "session-1",
  });

  assert.deepEqual(fixture.continuationModes, ["resume", "fork"]);
  assert.equal(fixture.confirmations.length, 1);
  assert.equal(result.type, "continuationCompleted");
  assert.equal(result.mode, "fork");
  assert.equal(result.branchSessionId, "branch-1");
});

test("starts the native official login switch after creating an official Provider", async () => {
  const created: ProfileRecord = {
    ...profile(),
    id: "official-lab",
    name: "Official Lab",
    kind: "official",
    providerId: "openai",
    apiKeySecretId: undefined,
  };
  const switched: string[] = [];
  const controller = new ProviderWorkbenchController({
    profiles: {
      list: async () => [],
      get: async () => undefined,
      readConfig: async () => undefined,
      create: async () => created,
      update: async () => undefined,
      delete: async () => false,
    },
    secrets: { get: async () => undefined, set: async () => undefined },
    activeProfileId: async () => undefined,
    switchProfile: async (id) => {
      switched.push(id);
      return { status: "committed", synchronizedChanges: 0 };
    },
    listSessionAnchors: async () => [],
    continueSession: async () => { throw new Error("unused"); },
    confirm: async () => true,
  });

  const result = await controller.handleMessage({
    type: "createProfile",
    name: "Official Lab",
    kind: "official",
  });

  assert.deepEqual(switched, ["official-lab"]);
  assert.equal(result.type, "operationCompleted");
  assert.equal(result.loginCompleted, true);
});

function workbenchFixture() {
  const records = new Map<string, ProfileRecord>([["proxy", profile()]]);
  const switchCalls: string[] = [];
  const continuationModes: string[] = [];
  const confirmations: string[] = [];
  const controller = new ProviderWorkbenchController({
    profiles: {
      list: async () => [...records.values()],
      get: async (id) => records.get(id),
      readConfig: async () => [
        'model_provider = "proxy"',
        '[model_providers.proxy]',
        'name = "Proxy"',
        'base_url = "https://example.test/v1"',
        'wire_api = "responses"',
        "",
      ].join("\n"),
      create: async () => { throw new Error("unused"); },
      update: async () => { throw new Error("unused"); },
      delete: async () => true,
    },
    secrets: {
      get: async () => "raw-key",
      set: async () => undefined,
      delete: async () => undefined,
    },
    activeProfileId: async () => "proxy",
    switchProfile: async (profileId) => {
      switchCalls.push(profileId);
      return { status: "committed", synchronizedChanges: 0 };
    },
    listSessionAnchors: async () => [{ sessionId: "session-1", sourceEventHash: "a".repeat(64) }],
    continueSession: async (request) => {
      continuationModes.push(request.mode);
      return request.mode === "resume"
        ? { status: "readableContentFallback", sourceSessionId: request.sessionId }
        : { status: "forked", sourceSessionId: request.sessionId, branchSessionId: "branch-1" };
    },
    confirm: async (message) => {
      confirmations.push(message);
      return true;
    },
  });
  return { controller, switchCalls, continuationModes, confirmations };
}

function profile(): ProfileRecord {
  return {
    id: "proxy",
    name: "Research Proxy",
    kind: "custom",
    configFile: "/profiles/proxy/config.toml",
    providerId: "proxy",
    apiKeySecretId: "secret.proxy",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}
