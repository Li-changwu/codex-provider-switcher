import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activateExtensionWithStartupPrerequisites,
  commandAvailabilityContextKey,
  commandIds,
  getStartupProfilePrerequisites,
  registerExtensionLifecycle,
  type ExtensionHostApi,
} from "../../src/activation";
import { ActiveProfileStore } from "../../src/core/active-profile";
import { UnsupportedHostError } from "../../src/core/codex-home";
import { profileApiKeySecretId } from "../../src/core/profiles";
import { UnsupportedSecretStorageError } from "../../src/core/secrets";
import {
  createStartupProfilePrerequisites,
  type StartupProfilePrerequisites,
} from "../../src/core/startup";
import {
  beginTransaction,
  recoverPendingSwitches,
  type AuthJournalTarget,
  type RecoveryResult,
} from "../../src/core/transaction";
import type { ProfileRecord } from "../../src/core/types";

const startupRecoveryWarning =
  "Codex Provider Switcher could not safely complete startup recovery. Provider switching commands are disabled.";

test("registers only status bar lifecycle functionality without command handlers", () => {
  const commandDisposables = commandIds.map((command) => ({
    command,
    dispose: () => undefined,
  }));
  const statusBarDisposable = {
    dispose: () => undefined,
    show: () => undefined,
    text: "",
    command: undefined as string | undefined,
    tooltip: undefined as string | undefined,
  };
  const subscriptions: Array<{ dispose(): unknown }> = [];
  const registeredCommands: string[] = [];

  const vscode = {
    commands: {
      registerCommand: (command: string) => {
        registeredCommands.push(command);
        return commandDisposables.find((disposable) => disposable.command === command)!;
      },
    },
    window: {
      createStatusBarItem: () => statusBarDisposable,
    },
    StatusBarAlignment: {
      Left: 1,
    },
  } as unknown as ExtensionHostApi;

  registerExtensionLifecycle({ subscriptions }, vscode);

  assert.deepEqual(registeredCommands, []);
  assert.deepEqual(subscriptions, [statusBarDisposable]);
  assert.equal(statusBarDisposable.command, undefined);
  assert.match(statusBarDisposable.tooltip ?? "", /unavailable/i);
});

test("registers functional startup commands and refreshes the active Profile status", async () => {
  await withAuthRecoveryFixture(async (fixture) => {
    const activeProfile = {
      ...customProfile("research"),
      name: "Research",
    };
    fixture.profiles.set(activeProfile.id, activeProfile);
    await new ActiveProfileStore(fixture.layout).set(activeProfile.id);
    const prompts: string[] = [];
    const extensionWindow = fixture.api.window as unknown as {
      showInputBox(options: { prompt: string }): Promise<string | undefined>;
    };
    extensionWindow.showInputBox = async (options) => {
      prompts.push(options.prompt);
      return undefined;
    };

    await activateExtensionWithStartupPrerequisites(
      fixture.context,
      fixture.host,
      fixture.api,
      () => fixture.prerequisites,
      async () => recoveryResult(),
    );

    assert.deepEqual(fixture.registeredCommands, [...commandIds]);
    assert.deepEqual(fixture.contextValues, [
      [commandAvailabilityContextKey, false],
      [commandAvailabilityContextKey, true],
    ]);
    assert.equal(fixture.statusBarItem.text, "$(account) Codex: Research");
    assert.equal(fixture.statusBarItem.command, "codexProvider.switchProfile");
    fixture.profiles.set(activeProfile.id, {
      ...activeProfile,
      name: "Updated Research",
    });
    const createProfile = fixture.registeredHandlers.get("codexProvider.createProfile");
    assert.ok(createProfile);
    await createProfile?.();

    assert.deepEqual(prompts, ["Profile name"]);
    assert.equal(fixture.statusBarItem.text, "$(account) Codex: Updated Research");
  });
});

test("compensates when publishing command availability fails", async () => {
  const fixture = activationFixture();
  const publicationError = new Error("context publication failed");
  const commands = fixture.api.commands as unknown as {
    executeCommand(command: string, contextKey: string, value: boolean): Promise<void>;
  };
  commands.executeCommand = async (_command, contextKey, value) => {
    fixture.contextValues.push([contextKey, value]);
    if (contextKey === commandAvailabilityContextKey && value) {
      throw publicationError;
    }
  };

  await assert.rejects(
    () => activateExtensionWithStartupPrerequisites(
      fixture.context,
      fixture.host,
      fixture.api,
      () => fixture.prerequisites,
      async () => recoveryResult(),
    ),
    (error: unknown) => error === publicationError,
  );

  assert.deepEqual(fixture.contextValues, [
    [commandAvailabilityContextKey, false],
    [commandAvailabilityContextKey, true],
    [commandAvailabilityContextKey, false],
  ]);
  assert.deepEqual(fixture.registeredCommands, [...commandIds]);
  assert.equal(fixture.registeredHandlers.size, 0);
  assert.ok(fixture.commandDisposables.every((disposable) => disposable.disposed));
  assert.deepEqual(fixture.context.subscriptions, []);
  assert.equal(fixture.statusBarItem.disposed, true);
  assert.equal(fixture.statusBarItem.command, undefined);
});

test("preserves publication failure when compensation disposal throws", async () => {
  const fixture = activationFixture();
  const publicationError = new Error("context publication failed");
  let statusDisposeAttempted = false;
  fixture.statusBarItem.dispose = () => {
    statusDisposeAttempted = true;
    throw new Error("status disposal failed");
  };
  const commands = fixture.api.commands as unknown as {
    executeCommand(command: string, contextKey: string, value: boolean): Promise<void>;
  };
  commands.executeCommand = async (_command, contextKey, value) => {
    fixture.contextValues.push([contextKey, value]);
    if (contextKey === commandAvailabilityContextKey && value) {
      throw publicationError;
    }
  };

  await assert.rejects(
    () => activateExtensionWithStartupPrerequisites(
      fixture.context,
      fixture.host,
      fixture.api,
      () => fixture.prerequisites,
      async () => recoveryResult(),
    ),
    (error: unknown) => error === publicationError,
  );

  assert.equal(statusDisposeAttempted, true);
  assert.deepEqual(fixture.contextValues, [
    [commandAvailabilityContextKey, false],
    [commandAvailabilityContextKey, true],
    [commandAvailabilityContextKey, false],
  ]);
  assert.ok(fixture.commandDisposables.every((disposable) => disposable.disposed));
  assert.deepEqual(fixture.context.subscriptions, []);
  assert.equal(fixture.statusBarItem.command, undefined);
});

test("awaits startup recovery once before registering commands", async () => {
  const fixture = activationFixture();
  let resolveRecovery: (() => void) | undefined;
  let recoveryCalls = 0;
  const recoveryStarted = new Promise<void>((resolve) => {
    resolveRecovery = resolve;
  });

  const activation = activateExtensionWithStartupPrerequisites(
    fixture.context,
    fixture.host,
    fixture.api,
    () => fixture.prerequisites,
    async (layout) => {
      recoveryCalls += 1;
      assert.equal(layout, fixture.layout);
      await recoveryStarted;
      return recoveryResult();
    },
  );

  await Promise.resolve();
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(fixture.registeredCommands, []);

  resolveRecovery?.();
  await activation;

  assert.deepEqual(fixture.registeredCommands, [...commandIds]);
  assert.deepEqual(fixture.warnings, []);
});

test("does not register commands when startup recovery remains required", async () => {
  const fixture = activationFixture();

  await activateExtensionWithStartupPrerequisites(
    fixture.context,
    fixture.host,
    fixture.api,
    () => fixture.prerequisites,
    async () => recoveryResult(["operation-containing-secret-value"]),
  );

  assert.deepEqual(fixture.registeredCommands, []);
  assert.deepEqual(fixture.warnings, [startupRecoveryWarning]);
  assert.deepEqual(fixture.context.subscriptions, []);
  assert.deepEqual(fixture.contextValues, [[commandAvailabilityContextKey, false]]);
  assert.equal(fixture.statusBarCreated, 0);
  assert.equal(fixture.statusBarItem.command, undefined);
  assert.doesNotMatch(fixture.warnings[0], /operation-containing-secret-value/);
});

test("does not register commands or expose errors when startup recovery throws", async () => {
  const fixture = activationFixture();

  await activateExtensionWithStartupPrerequisites(
    fixture.context,
    fixture.host,
    fixture.api,
    () => fixture.prerequisites,
    async () => {
      throw new Error("raw secret recovery failure");
    },
  );

  assert.deepEqual(fixture.registeredCommands, []);
  assert.deepEqual(fixture.warnings, [startupRecoveryWarning]);
  assert.doesNotMatch(fixture.warnings[0], /raw secret recovery failure/);
});

test("fails closed before startup restoration for incomplete custom auth metadata", async () => {
  await withAuthRecoveryFixture(async (fixture) => {
    const operationId = "incomplete-custom-auth";
    const activeApiKey = "synthetic-active-auth-value";
    const transactionDirectory = join(
      fixture.layout.switcherDir,
      "transactions",
      operationId,
    );
    const journalPath = join(transactionDirectory, "journal.jsonl");
    const journal = `${[
      {
        version: 1,
        operationId,
        state: "prepared",
        timestamp: "2026-08-26T00:00:00.000Z",
      },
      {
        version: 1,
        operationId,
        state: "applying",
        timestamp: "2026-08-26T00:00:01.000Z",
        pendingTargets: [{ kind: "auth", previousMode: "custom" }],
      },
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await mkdir(transactionDirectory, { recursive: true });
    await writeFile(journalPath, journal, "utf8");
    await writeFile(
      fixture.layout.authPath,
      JSON.stringify({ OPENAI_API_KEY: activeApiKey }),
      "utf8",
    );

    await activateExtensionWithStartupPrerequisites(
      fixture.context,
      fixture.host,
      fixture.api,
      () => fixture.prerequisites,
      recoverPendingSwitches,
    );

    assert.equal(await readFile(journalPath, "utf8"), journal);
    assert.deepEqual(JSON.parse(await readFile(fixture.layout.authPath, "utf8")), {
      OPENAI_API_KEY: activeApiKey,
    });
    assert.deepEqual(fixture.registeredCommands, []);
    assert.deepEqual(fixture.warnings, [startupRecoveryWarning]);
    assert.doesNotMatch(fixture.warnings[0], new RegExp(activeApiKey));
  });
});

test("restores custom auth from the previous profile secret during startup recovery", async () => {
  await withAuthRecoveryFixture(async (fixture) => {
    const profileId = "research-proxy";
    const previousApiKey = "previous-custom-api-key";
    fixture.profiles.set(profileId, customProfile(profileId));
    fixture.secrets.set(profileApiKeySecretId(profileId), previousApiKey);
    await interruptAuthSwitch(fixture.layout, "restore-custom-auth", {
      kind: "auth",
      path: fixture.layout.authPath,
      previousMode: "custom",
      customProfileId: profileId,
    });
    await writeFile(
      fixture.layout.authPath,
      '{"OPENAI_API_KEY":"interrupted-target-api-key"}',
      "utf8",
    );

    await activateExtensionWithStartupPrerequisites(
      fixture.context,
      fixture.host,
      fixture.api,
      () => fixture.prerequisites,
      recoverPendingSwitches,
    );

    assert.deepEqual(JSON.parse(await readFile(fixture.layout.authPath, "utf8")), {
      OPENAI_API_KEY: previousApiKey,
    });
    assert.deepEqual(fixture.registeredCommands, [...commandIds]);
    assert.deepEqual(fixture.warnings, []);
  });
});

test("removes custom auth when startup recovery restores official mode", async () => {
  await withAuthRecoveryFixture(async (fixture) => {
    await interruptAuthSwitch(fixture.layout, "restore-official-auth", {
      kind: "auth",
      path: fixture.layout.authPath,
      previousMode: "official",
    });
    await writeFile(
      fixture.layout.authPath,
      '{"OPENAI_API_KEY":"interrupted-target-api-key"}',
      "utf8",
    );

    await activateExtensionWithStartupPrerequisites(
      fixture.context,
      fixture.host,
      fixture.api,
      () => fixture.prerequisites,
      recoverPendingSwitches,
    );

    assert.equal(await fileExists(fixture.layout.authPath), false);
    assert.deepEqual(fixture.registeredCommands, [...commandIds]);
    assert.deepEqual(fixture.warnings, []);
  });
});

test("fails closed without exposing keys when the previous custom secret is missing", async () => {
  await withAuthRecoveryFixture(async (fixture) => {
    const profileId = "missing-secret-profile";
    const activeApiKey = "interrupted-target-secret-value";
    const operationId = "missing-previous-secret";
    fixture.profiles.set(profileId, customProfile(profileId));
    await interruptAuthSwitch(fixture.layout, operationId, {
      kind: "auth",
      path: fixture.layout.authPath,
      previousMode: "custom",
      customProfileId: profileId,
    });
    const activeAuth = JSON.stringify({ OPENAI_API_KEY: activeApiKey });
    await writeFile(fixture.layout.authPath, activeAuth, "utf8");
    let recovery: RecoveryResult | undefined;

    await activateExtensionWithStartupPrerequisites(
      fixture.context,
      fixture.host,
      fixture.api,
      () => fixture.prerequisites,
      async (layout, dependencies) => {
        recovery = await recoverPendingSwitches(layout, dependencies);
        return recovery;
      },
    );

    assert.deepEqual(recovery?.recoveryRequiredOperationIds, [operationId]);
    assert.equal(await readFile(fixture.layout.authPath, "utf8"), activeAuth);
    assert.deepEqual(fixture.registeredCommands, []);
    assert.deepEqual(fixture.warnings, [startupRecoveryWarning]);
    const journal = await readFile(
      join(
        fixture.layout.switcherDir,
        "transactions",
        operationId,
        "journal.jsonl",
      ),
      "utf8",
    );
    assert.doesNotMatch(
      JSON.stringify({ recovery, warnings: fixture.warnings, journal }),
      new RegExp(activeApiKey),
    );
  });
});

test("registers no command handlers when typed startup prerequisites are unavailable", async () => {
  for (const startupError of [
    new UnsupportedHostError("wsl", "WSL is unavailable."),
    new UnsupportedSecretStorageError("SecretStorage is unavailable."),
  ]) {
    const subscriptions: Array<{ dispose(): unknown }> = [];
    const registeredCommands: string[] = [];
    const contextValues: Array<[string, boolean]> = [];
    let recoveryCalls = 0;
    const statusBarItem = {
      dispose: () => undefined,
      show: () => undefined,
      text: "",
      command: undefined as string | undefined,
      tooltip: undefined as string | undefined,
    };
    const vscode = {
      commands: {
        registerCommand: (command: string) => {
          registeredCommands.push(command);
          return { dispose: () => undefined };
        },
        executeCommand: async (
          _command: string,
          contextKey: string,
          value: boolean,
        ) => {
          contextValues.push([contextKey, value]);
          return undefined;
        },
      },
      window: {
        createStatusBarItem: () => statusBarItem,
      },
      StatusBarAlignment: {
        Left: 1,
      },
    } as unknown as ExtensionHostApi;

    await assert.doesNotReject(() =>
      activateExtensionWithStartupPrerequisites(
        {
          subscriptions,
          secrets: {
            get: async () => undefined,
            store: async () => undefined,
            delete: async () => undefined,
          },
          globalStorageUri: {
            scheme: "file",
            fsPath: "C:\\Users\\Ada\\AppData\\Roaming\\Code\\User\\globalStorage",
          },
        },
        {
          env: {},
          platform: "win32",
          homeDir: "C:\\Users\\Ada",
        },
        vscode,
        () => {
          throw startupError;
        },
        async () => {
          recoveryCalls += 1;
          return recoveryResult();
        },
      ),
    );
    assert.deepEqual(registeredCommands, []);
    assert.equal(subscriptions.length, 1);
    assert.equal(statusBarItem.command, undefined);
    assert.match(statusBarItem.tooltip ?? "", /unavailable/i);
    assert.deepEqual(contextValues, [[commandAvailabilityContextKey, false]]);
    assert.equal(getStartupProfilePrerequisites(), undefined);
    assert.equal(recoveryCalls, 0);
  }
});

test("disposes earlier registrations when a later command registration throws", () => {
  const disposables: Array<{ disposed: boolean; dispose(): void }> = [];
  const subscriptions: Array<{ dispose(): unknown }> = [];
  const throwingCommand = commandIds[2];
  const vscode = {
    commands: {
      registerCommand: (command: string) => {
        if (command === throwingCommand) {
          throw new Error("registration failed");
        }
        const disposable = {
          disposed: false,
          dispose() {
            this.disposed = true;
          },
        };
        disposables.push(disposable);
        return disposable;
      },
    },
    window: {
      createStatusBarItem: () => {
        throw new Error("status bar must not be created");
      },
    },
    StatusBarAlignment: {
      Left: 1,
    },
  } as unknown as ExtensionHostApi;

  assert.throws(
    () => registerExtensionLifecycle({ subscriptions }, vscode, {
      createCommandHandlers: () => lifecycleCommandHandlers(),
    }),
    /registration failed/,
  );
  assert.equal(disposables.length, 2);
  assert.ok(disposables.every((disposable) => disposable.disposed));
  assert.deepEqual(subscriptions, []);
});

test("disposes registrations and status bar when showing it throws", () => {
  const commandDisposables = commandIds.map(() => trackedDisposable());
  const statusBarDisposable = {
    ...trackedDisposable(),
    show: () => {
      throw new Error("status show failed");
    },
    text: "",
    command: undefined as string | undefined,
    tooltip: undefined as string | undefined,
  };
  const subscriptions: Array<{ dispose(): unknown }> = [];
  let commandIndex = 0;
  const vscode = {
    commands: {
      registerCommand: () => commandDisposables[commandIndex++],
    },
    window: {
      createStatusBarItem: () => statusBarDisposable,
    },
    StatusBarAlignment: {
      Left: 1,
    },
  } as unknown as ExtensionHostApi;

  assert.throws(
    () => registerExtensionLifecycle({ subscriptions }, vscode, {
      createCommandHandlers: () => lifecycleCommandHandlers(),
    }),
    /status show failed/,
  );
  assert.ok(commandDisposables.every((disposable) => disposable.disposed));
  assert.equal(statusBarDisposable.disposed, true);
  assert.deepEqual(subscriptions, []);
});

test("disposes every rollback value without masking the activation error", () => {
  const firstDisposable = {
    dispose() {
      throw new Error("dispose failed");
    },
  };
  const secondDisposable = trackedDisposable();
  const subscriptions: Array<{ dispose(): unknown }> = [];
  let registrationCount = 0;
  const vscode = {
    commands: {
      registerCommand: () => {
        registrationCount += 1;
        if (registrationCount === 1) {
          return firstDisposable;
        }
        if (registrationCount === 2) {
          return secondDisposable;
        }
        throw new Error("registration failed");
      },
    },
    window: {
      createStatusBarItem: () => {
        throw new Error("status bar must not be created");
      },
    },
    StatusBarAlignment: {
      Left: 1,
    },
  } as unknown as ExtensionHostApi;

  assert.throws(
    () => registerExtensionLifecycle({ subscriptions }, vscode, {
      createCommandHandlers: () => lifecycleCommandHandlers(),
    }),
    /registration failed/,
  );
  assert.equal(secondDisposable.disposed, true);
  assert.deepEqual(subscriptions, []);
});

function trackedDisposable() {
  return {
    disposed: false,
    dispose() {
      this.disposed = true;
    },
  };
}

function lifecycleCommandHandlers() {
  return {
    "codexProvider.createProfile": async () => undefined,
    "codexProvider.editProfile": async () => undefined,
    "codexProvider.switchProfile": async () => undefined,
    "codexProvider.syncSessions": async () => undefined,
    "codexProvider.continueSession": async () => undefined,
    "codexProvider.restoreBackup": async () => undefined,
  };
}

function activationFixture() {
  const registeredCommands: string[] = [];
  const registeredHandlers = new Map<string, () => unknown>();
  const commandDisposables: Array<{
    command: string;
    disposed: boolean;
    dispose(): void;
  }> = [];
  const contextValues: Array<[string, boolean]> = [];
  const warnings: string[] = [];
  let statusBarCreated = 0;
  const statusBarItem = {
    disposed: false,
    dispose() {
      this.disposed = true;
    },
    show: () => undefined,
    text: "",
    command: undefined as string | undefined,
    tooltip: undefined as string | undefined,
  };
  const api = {
    commands: {
      registerCommand: (command: string, handler: () => unknown) => {
        registeredCommands.push(command);
        registeredHandlers.set(command, handler);
        const disposable = {
          command,
          disposed: false,
          dispose() {
            this.disposed = true;
            registeredHandlers.delete(command);
          },
        };
        commandDisposables.push(disposable);
        return disposable;
      },
      executeCommand: async (
        _command: string,
        contextKey: string,
        value: boolean,
      ) => {
        contextValues.push([contextKey, value]);
        return undefined;
      },
    },
    window: {
      createStatusBarItem: () => {
        statusBarCreated += 1;
        return statusBarItem;
      },
      showWarningMessage: async (message: string) => {
        warnings.push(message);
        return undefined;
      },
    },
    StatusBarAlignment: {
      Left: 1,
    },
  } as unknown as ExtensionHostApi;
  const context = {
    subscriptions: [] as Array<{ dispose(): unknown }>,
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    globalStorageUri: {
      scheme: "file",
      fsPath: "C:\\Users\\Ada\\AppData\\Roaming\\Code\\User\\globalStorage",
    },
  };
  const host = {
    env: {},
    platform: "win32" as const,
    homeDir: "C:\\Users\\Ada",
  };
  const prerequisites = createStartupProfilePrerequisites(context, host);
  return {
    api,
    context,
    commandDisposables,
    contextValues,
    host,
    layout: prerequisites.layout,
    prerequisites,
    registeredCommands,
    registeredHandlers,
    statusBarItem,
    get statusBarCreated() {
      return statusBarCreated;
    },
    warnings,
  };
}

function recoveryResult(recoveryRequiredOperationIds: string[] = []) {
  return {
    recoveredOperationIds: [],
    skippedCommittedOperationIds: [],
    recoveryRequiredOperationIds,
    recoveryDiagnostics: [],
  };
}

async function withAuthRecoveryFixture(
  operation: (fixture: ReturnType<typeof authRecoveryFixture>) => Promise<void>,
): Promise<void> {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-activation-recovery-"));
  const fixture = authRecoveryFixture(codexHome);
  try {
    await mkdir(codexHome, { recursive: true });
    await operation(fixture);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

function authRecoveryFixture(codexHome: string) {
  const fixture = activationFixture();
  const profiles = new Map<string, ProfileRecord>();
  const secrets = new Map<string, string>();
  const layout = {
    codexHome,
    configPath: join(codexHome, "config.toml"),
    authPath: join(codexHome, "auth.json"),
    sessionsDir: join(codexHome, "sessions"),
    archivedSessionsDir: join(codexHome, "archived_sessions"),
    sqlitePath: join(codexHome, "state_5.sqlite"),
    switcherDir: join(codexHome, "provider-switcher"),
  };
  const prerequisites = {
    layout,
    profiles: {
      get: async (id: string) => profiles.get(id),
    },
    secrets: {
      get: async (id: string) => secrets.get(id),
    },
  } as unknown as StartupProfilePrerequisites;
  return {
    ...fixture,
    context: {
      ...fixture.context,
      globalStorageUri: {
        scheme: "file" as const,
        fsPath: join(codexHome, "extension-storage"),
      },
    },
    host: {
      ...fixture.host,
      env: { CODEX_HOME: codexHome },
      homeDir: codexHome,
    },
    layout,
    prerequisites,
    profiles,
    secrets,
  };
}

function customProfile(id: string): ProfileRecord {
  return {
    id,
    name: id,
    kind: "custom",
    configFile: "unused-in-auth-recovery.toml",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

async function interruptAuthSwitch(
  layout: StartupProfilePrerequisites["layout"],
  operationId: string,
  target: AuthJournalTarget,
): Promise<void> {
  const transaction = await beginTransaction(layout, { operationId });
  try {
    await transaction.markApplying([target]);
  } finally {
    await transaction.release();
  }
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
