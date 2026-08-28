import assert from "node:assert/strict";
import test from "node:test";
import {
  createProfileCommandHandlers,
  createVscodeProfileCommandUi,
} from "../../src/ui/commands";
import type { CodexLayout, ProfileRecord } from "../../src/core/types";

const customToml = [
  'model_provider = "research"',
  "",
  "[model_providers.research]",
  'base_url = "https://example.test/v1"',
  'wire_api = "responses"',
].join("\n");
const officialToml = 'model = "gpt-5"';

function thenable<Value>(value: Value) {
  return {
    then(onfulfilled: (resolved: Value) => unknown) {
      return Promise.resolve(value).then(onfulfilled);
    },
  };
}

test("adapts VS Code Thenables to native Promises at the command UI boundary", async () => {
  const ui = createVscodeProfileCommandUi({
    window: {
      showInputBox: () => thenable("Profile name"),
      showQuickPick: () => thenable({ label: "Research", value: "research" }),
      showWarningMessage: () => thenable("Switch"),
      showInformationMessage: () => thenable(undefined),
      showErrorMessage: () => thenable(undefined),
      withProgress: () => thenable(undefined),
      createTerminal: () => ({
        show: () => undefined,
        sendText: () => undefined,
      }),
    },
    ProgressLocation: { Notification: 15 },
  } as never);

  const input = ui.input({ prompt: "Profile name" });
  const pick = ui.pick([{ label: "Research", value: "research" }], {
    placeHolder: "Select a Profile",
  });
  const info = ui.info("Profile created.");

  assert.ok(input instanceof Promise);
  assert.ok(pick instanceof Promise);
  assert.ok(info instanceof Promise);
  assert.equal(await input, "Profile name");
  assert.deepEqual(await pick, { label: "Research", value: "research" });
});

test("prompts for and stores API keys only for custom Profiles after persistence", async () => {
  const fixture = commandFixture({
    inputs: ["Research", customToml, "sk-test-custom-key", "Official", officialToml],
    picks: ["custom", "official"],
  });

  await fixture.handlers.createProfile();
  await fixture.handlers.createProfile();

  assert.equal(fixture.profiles.created.length, 2);
  assert.deepEqual(
    fixture.profiles.created.map((profile) => profile.kind),
    ["custom", "official"],
  );
  assert.deepEqual(fixture.secrets.stored, [
    { id: "codex-provider-switcher.profile.research.api-key", value: "sk-test-custom-key" },
  ]);
  assert.deepEqual(fixture.events.slice(0, 2), ["create:research", "secret:research"]);
  assert.equal(
    fixture.ui.inputOptions.filter((options) => options.password === true).length,
    1,
  );
});

test("confirms a selected target Profile and invokes one stored switch", async () => {
  const active = profile("official", "Official", "official");
  const target = profile("research", "Research", "custom");
  const fixture = commandFixture({
    records: [active, target],
    activeProfileId: active.id,
    picks: [target.id],
    confirmations: [true],
  });
  const calls: Array<{ targetProfileId: string; signal?: AbortSignal }> = [];
  fixture.switchStoredProfile = async (request, dependencies) => {
    calls.push(request);
    dependencies.onProgress?.({
      stage: "preflight",
      index: 0,
      completed: 1,
      total: 1,
      percentage: 100 / 7,
      indeterminate: false,
    });
    return switchResult("committed");
  };
  fixture.rebuildHandlers();

  await fixture.handlers.switchProfile();

  assert.deepEqual(calls.map((call) => call.targetProfileId), [target.id]);
  assert.equal(fixture.ui.confirmations.length, 1);
  assert.deepEqual(
    fixture.ui.pickItems[0].map((item) => ({ label: item.label, description: item.description })),
    [
      { label: "Official", description: "Active profile" },
      { label: "Research", description: "Switch to this profile" },
    ],
  );
  assert.match(fixture.ui.progressReports[0].message, /Preflight \(1\/1\)/);
  assert.equal(fixture.statusRefreshes, 1);
});

test("reports progress as non-negative deltas across multiple switch events", async () => {
  const target = profile("research", "Research", "custom");
  const fixture = commandFixture({
    records: [target],
    activeProfileId: target.id,
    picks: [target.id],
    confirmations: [true],
  });
  fixture.switchStoredProfile = async (_request, dependencies) => {
    for (const percentage of [10, 25, 20, 30]) {
      dependencies.onProgress?.({
        stage: "scan",
        index: 0,
        completed: percentage,
        total: 100,
        percentage,
        indeterminate: false,
      });
    }
    return switchResult("committed");
  };
  fixture.rebuildHandlers();

  await fixture.handlers.switchProfile();

  assert.deepEqual(
    fixture.ui.progressReports.map((report) => report.increment),
    [10, 15, 0, 5],
  );
});

test("aborts the stored switch and waits for its cancellation rollback result", async () => {
  const target = profile("research", "Research", "custom");
  const fixture = commandFixture({
    records: [target],
    activeProfileId: target.id,
    picks: [target.id],
    confirmations: [true],
    cancelProgress: true,
  });
  let switchSignal: AbortSignal | undefined;
  let finishSwitch: ((result: ReturnType<typeof switchResult>) => void) | undefined;
  const switchStarted = new Promise<void>((resolve) => {
    fixture.switchStoredProfile = async (request) => {
      switchSignal = request.signal;
      resolve();
      return new Promise((finish) => {
        finishSwitch = finish;
      });
    };
  });
  fixture.rebuildHandlers();

  let completed = false;
  const operation = fixture.handlers.switchProfile().then(() => {
    completed = true;
  });
  await switchStarted;

  assert.equal(switchSignal?.aborted, true);
  await Promise.resolve();
  assert.equal(completed, false);

  finishSwitch?.(switchResult("cancelled"));
  await operation;
  assert.equal(completed, true);
  assert.match(fixture.ui.infos.at(-1) ?? "", /cancelled/i);
});

test("holds the command mutex until a cancelled switch finishes rollback", async () => {
  const target = profile("research", "Research", "custom");
  const fixture = commandFixture({
    records: [target],
    activeProfileId: target.id,
    picks: [target.id],
    confirmations: [true],
    cancelProgress: true,
  });
  let finishSwitch: ((result: ReturnType<typeof switchResult>) => void) | undefined;
  const switchStarted = new Promise<void>((resolve) => {
    fixture.switchStoredProfile = async () => {
      resolve();
      return new Promise((finish) => {
        finishSwitch = finish;
      });
    };
  });
  let recoveryCalls = 0;
  fixture.recoverPendingSwitches = async () => {
    recoveryCalls += 1;
    return {
      recoveredOperationIds: [],
      skippedCommittedOperationIds: [],
      recoveryRequiredOperationIds: [],
      recoveryDiagnostics: [],
    };
  };
  fixture.rebuildHandlers();

  const switching = fixture.handlers.switchProfile();
  await switchStarted;
  const recovering = fixture.handlers.restoreBackup();
  await Promise.resolve();

  assert.equal(recoveryCalls, 0);
  finishSwitch?.(switchResult("cancelled"));
  await Promise.all([switching, recovering]);
  assert.equal(recoveryCalls, 1);
});

test("does not provide readable content or implicit consent to a continuation fallback", async () => {
  const active = profile("research", "Research", "custom");
  const fixture = commandFixture({
    records: [active],
    activeProfileId: active.id,
    inputs: ["session-123"],
  });
  let request: Record<string, unknown> | undefined;
  fixture.continueSession = async (value) => {
    request = value as unknown as Record<string, unknown>;
    return {
      status: "readableContentFallback",
      sourceSessionId: "session-123",
      confirmationRequired: true,
    };
  };
  fixture.rebuildHandlers();

  await fixture.handlers.continueSession();

  assert.equal(request?.mode, "resume");
  assert.equal(request?.readableFallbackPrompt, undefined);
  assert.equal(request?.confirmReadableContent, undefined);
  assert.equal(fixture.ui.confirmations.length, 0);
  assert.match(fixture.ui.infos.at(-1) ?? "", /No readable content was transferred/);
});

test("redacts a custom key when SecretStorage rejects a post-create write", async () => {
  const secret = "sk-test-do-not-display-this-value";
  const fixture = commandFixture({
    inputs: ["Research", customToml, secret],
    picks: ["custom"],
    failSecretWrite: true,
  });

  await fixture.handlers.createProfile();

  assert.equal(fixture.profiles.created.length, 1);
  assert.equal(fixture.ui.errors.length, 1);
  assert.doesNotMatch(fixture.ui.errors[0], new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(fixture.ui.errors), /SecretStorage rejected/);
});

function commandFixture(options: {
  inputs?: string[];
  picks?: string[];
  confirmations?: boolean[];
  records?: ProfileRecord[];
  activeProfileId?: string;
  cancelProgress?: boolean;
  failSecretWrite?: boolean;
} = {}) {
  const events: string[] = [];
  const profiles = new FakeProfiles(options.records ?? [], events);
  const secrets = new FakeSecrets(events, options.failSecretWrite ?? false);
  const activeProfiles = new FakeActiveProfiles(options.activeProfileId);
  const ui = new FakeUi(options);
  let statusRefreshes = 0;
  let switchStoredProfile = async () => switchResult("committed");
  let continueSession = async () => ({
    status: "resumed" as const,
    sourceSessionId: "unused",
  });
  let recoverPendingSwitches = async () => ({
    recoveredOperationIds: [],
    skippedCommittedOperationIds: [],
    recoveryRequiredOperationIds: [],
    recoveryDiagnostics: [],
  });

  const dependencies = () => ({
    layout: layout(),
    profiles,
    secrets,
    activeProfiles,
    ui,
    switchStoredProfile,
    continueSession,
    recoverPendingSwitches,
    refreshStatus: async () => {
      statusRefreshes += 1;
    },
  });
  let handlers = createProfileCommandHandlers(dependencies());

  return {
    activeProfiles,
    continueSession,
    events,
    get handlers() {
      return handlers;
    },
    profiles,
    rebuildHandlers() {
      handlers = createProfileCommandHandlers(dependencies());
    },
    secrets,
    get statusRefreshes() {
      return statusRefreshes;
    },
    get switchStoredProfile() {
      return switchStoredProfile;
    },
    set switchStoredProfile(value) {
      switchStoredProfile = value;
    },
    set continueSession(value) {
      continueSession = value;
    },
    set recoverPendingSwitches(value) {
      recoverPendingSwitches = value;
    },
    ui,
  };
}

class FakeProfiles {
  readonly created: ProfileRecord[] = [];

  constructor(
    private readonly records: ProfileRecord[],
    private readonly events: string[],
  ) {}

  async create(input: {
    name: string;
    kind: "official" | "custom";
    configText: string;
    providerId?: string;
  }): Promise<ProfileRecord> {
    const record = profile(
      input.name.toLowerCase(),
      input.name,
      input.kind,
      input.configText,
      input.providerId,
    );
    this.records.push(record);
    this.created.push(record);
    this.events.push(`create:${record.id}`);
    return record;
  }

  async get(id: string): Promise<ProfileRecord | undefined> {
    return this.records.find((record) => record.id === id);
  }

  async list(): Promise<ProfileRecord[]> {
    return [...this.records];
  }

  async readConfig(id: string): Promise<string | undefined> {
    return this.records.find((record) => record.id === id)?.configFile;
  }

  async update(): Promise<ProfileRecord | undefined> {
    throw new Error("not exercised by this test");
  }
}

class FakeSecrets {
  readonly stored: Array<{ id: string; value: string }> = [];

  constructor(
    private readonly events: string[],
    private readonly failWrites: boolean,
  ) {}

  async get(): Promise<string | undefined> {
    return undefined;
  }

  async set(id: string, value: string): Promise<void> {
    if (this.failWrites) {
      throw new Error(`SecretStorage rejected ${value}`);
    }
    this.stored.push({ id, value });
    this.events.push(`secret:${id.split(".")[2]}`);
  }
}

class FakeActiveProfiles {
  constructor(private profileId: string | undefined) {}

  async set(profileId: string): Promise<void> {
    this.profileId = profileId;
  }

  async snapshot() {
    return this.profileId
      ? {
        state: "present" as const,
        record: {
          version: 1 as const,
          profileId: this.profileId,
          updatedAt: "2026-08-28T00:00:00.000Z",
        },
      }
      : { state: "missing" as const };
  }
}

class FakeUi {
  readonly confirmations: string[] = [];
  readonly errors: string[] = [];
  readonly infos: string[] = [];
  readonly inputOptions: Array<{ password?: boolean }> = [];
  readonly pickItems: Array<Array<{ label: string; description?: string; value: string }>> = [];
  readonly progressReports: Array<{ message: string; increment?: number }> = [];
  private readonly inputs: string[];
  private readonly picks: string[];
  private readonly confirmationAnswers: boolean[];

  constructor(
    options: {
      inputs?: string[];
      picks?: string[];
      confirmations?: boolean[];
      cancelProgress?: boolean;
    },
  ) {
    this.inputs = [...(options.inputs ?? [])];
    this.picks = [...(options.picks ?? [])];
    this.confirmationAnswers = [...(options.confirmations ?? [])];
    this.cancelProgress = options.cancelProgress ?? false;
  }

  private readonly cancelProgress: boolean;

  async input(options: { password?: boolean }): Promise<string | undefined> {
    this.inputOptions.push(options);
    return this.inputs.shift();
  }

  async pick<T extends { value: string }>(items: readonly T[]): Promise<T | undefined> {
    this.pickItems.push(items.map((item) => ({
      label: (item as T & { label: string }).label,
      description: (item as T & { description?: string }).description,
      value: item.value,
    })));
    const selected = this.picks.shift();
    return items.find((item) => item.value === selected);
  }

  async confirm(message: string): Promise<boolean> {
    this.confirmations.push(message);
    return this.confirmationAnswers.shift() ?? false;
  }

  async error(message: string): Promise<void> {
    this.errors.push(message);
  }

  async info(message: string): Promise<void> {
    this.infos.push(message);
  }

  async withProgress(
    _title: string,
    operation: (
      progress: { report(update: { message: string; increment?: number }): void },
      cancellation: { onCancellationRequested(listener: () => void): { dispose(): void } },
    ) => Promise<void>,
  ): Promise<void> {
    let cancellationListener: (() => void) | undefined;
    const task = operation(
      {
        report: (update) => this.progressReports.push(update),
      },
      {
        onCancellationRequested(listener) {
          cancellationListener = listener;
          return { dispose: () => undefined };
        },
      },
    );
    if (this.cancelProgress) {
      cancellationListener?.();
    }
    await task;
  }

  createTerminal() {
    return {
      launch: async () => ({}),
    };
  }
}

function layout(): CodexLayout {
  return {
    codexHome: "/home/ada/.codex",
    configPath: "/home/ada/.codex/config.toml",
    authPath: "/home/ada/.codex/auth.json",
    sessionsDir: "/home/ada/.codex/sessions",
    archivedSessionsDir: "/home/ada/.codex/archived_sessions",
    sqlitePath: "/home/ada/.codex/state_5.sqlite",
    switcherDir: "/home/ada/.codex/provider-switcher",
  };
}

function profile(
  id: string,
  name: string,
  kind: "official" | "custom",
  configFile = kind === "custom" ? customToml : officialToml,
  providerId?: string,
): ProfileRecord {
  return {
    id,
    name,
    kind,
    configFile,
    providerId,
    apiKeySecretId: kind === "custom"
      ? `codex-provider-switcher.profile.${id}.api-key`
      : undefined,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

function switchResult(status: "committed" | "cancelled") {
  return {
    status,
    operationId: "operation-1",
    activeProfileState: status === "committed" ? "updated" as const : "unchanged" as const,
  };
}
