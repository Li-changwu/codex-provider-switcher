import assert from "node:assert/strict";
import test from "node:test";
import {
  activateExtensionWithStartupPrerequisites,
  commandIds,
  getStartupProfilePrerequisites,
  registerExtensionLifecycle,
  type ExtensionHostApi,
} from "../../src/activation";
import { UnsupportedHostError } from "../../src/core/codex-home";
import { UnsupportedSecretStorageError } from "../../src/core/secrets";

test("registers commands and status bar disposal with the extension context", () => {
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

  assert.deepEqual(registeredCommands, [...commandIds]);
  assert.equal(subscriptions.length, commandDisposables.length + 1);
  for (const disposable of [...commandDisposables, statusBarDisposable]) {
    assert.ok(subscriptions.includes(disposable));
  }
  assert.equal(statusBarDisposable.command, "codexProvider.switchProfile");
});

test("registers the lifecycle when typed startup prerequisites are unavailable", () => {
  for (const startupError of [
    new UnsupportedHostError("wsl", "WSL is unavailable."),
    new UnsupportedSecretStorageError("SecretStorage is unavailable."),
  ]) {
    const subscriptions: Array<{ dispose(): unknown }> = [];
    const registeredCommands: string[] = [];
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
      },
      window: {
        createStatusBarItem: () => statusBarItem,
      },
      StatusBarAlignment: {
        Left: 1,
      },
    } as unknown as ExtensionHostApi;

    assert.doesNotThrow(() =>
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
      ),
    );
    assert.deepEqual(registeredCommands, [...commandIds]);
    assert.equal(subscriptions.length, commandIds.length + 1);
    assert.equal(statusBarItem.command, "codexProvider.switchProfile");
    assert.equal(getStartupProfilePrerequisites(), undefined);
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
    () => registerExtensionLifecycle({ subscriptions }, vscode),
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
    () => registerExtensionLifecycle({ subscriptions }, vscode),
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
    () => registerExtensionLifecycle({ subscriptions }, vscode),
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
