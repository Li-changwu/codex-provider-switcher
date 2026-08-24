import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCodexLayout,
  UnsupportedHostError,
} from "../../src/core/codex-home";

test("prefers an explicit CODEX_HOME on Windows", () => {
  const layout = resolveCodexLayout({
    env: { CODEX_HOME: "D:\\Codex Data" },
    platform: "win32",
    homeDir: "C:\\Users\\Ada",
    extensionStorageUri: {
      scheme: "file",
      fsPath: "C:\\Users\\Ada\\AppData\\Roaming\\Code\\User\\globalStorage",
    },
  });

  assert.deepEqual(layout, {
    codexHome: "D:\\Codex Data",
    configPath: "D:\\Codex Data\\config.toml",
    authPath: "D:\\Codex Data\\auth.json",
    sessionsDir: "D:\\Codex Data\\sessions",
    archivedSessionsDir: "D:\\Codex Data\\archived_sessions",
    sqlitePath: "D:\\Codex Data\\state_5.sqlite",
    switcherDir: "D:\\Codex Data\\provider-switcher",
  });
});

test("uses the Linux home directory when CODEX_HOME is absent", () => {
  const layout = resolveCodexLayout({
    env: {},
    platform: "linux",
    homeDir: "/home/ada",
    extensionStorageUri: {
      scheme: "file",
      fsPath: "/home/ada/.config/Code/User/globalStorage",
    },
  });

  assert.deepEqual(layout, {
    codexHome: "/home/ada/.codex",
    configPath: "/home/ada/.codex/config.toml",
    authPath: "/home/ada/.codex/auth.json",
    sessionsDir: "/home/ada/.codex/sessions",
    archivedSessionsDir: "/home/ada/.codex/archived_sessions",
    sqlitePath: "/home/ada/.codex/state_5.sqlite",
    switcherDir: "/home/ada/.codex/provider-switcher",
  });
});

test("uses the Windows home directory when CODEX_HOME is absent", () => {
  const layout = resolveCodexLayout({
    env: {},
    platform: "win32",
    homeDir: "C:\\Users\\Ada",
    extensionStorageUri: {
      scheme: "file",
      fsPath: "C:\\Users\\Ada\\AppData\\Roaming\\Code\\User\\globalStorage",
    },
  });

  assert.equal(layout.codexHome, "C:\\Users\\Ada\\.codex");
  assert.equal(layout.sqlitePath, "C:\\Users\\Ada\\.codex\\state_5.sqlite");
});

test("uses only Remote SSH Linux Extension Host inputs", () => {
  const layout = resolveCodexLayout({
    env: { VSCODE_IPC_HOOK_CLI: "/run/user/1000/vscode-ipc.sock" },
    platform: "linux",
    homeDir: "/home/remote-user",
    extensionStorageUri: {
      scheme: "vscode-remote",
      authority: "ssh-remote+research-host",
      fsPath: "/home/remote-user/.vscode-server/data/User/globalStorage",
    },
  });

  assert.equal(layout.codexHome, "/home/remote-user/.codex");
  assert.equal(layout.sqlitePath, "/home/remote-user/.codex/state_5.sqlite");
  assert.equal(layout.switcherDir, "/home/remote-user/.codex/provider-switcher");
  assert.doesNotMatch(layout.codexHome, /[A-Za-z]:\\|\\\\/);
});

test("refuses WSL environments and mounted Windows home paths", () => {
  assertUnsupportedHost(
    {
      env: { WSL_INTEROP: "/run/WSL/123_interop" },
      platform: "linux",
      homeDir: "/home/ada",
      extensionStorageUri: { scheme: "file", fsPath: "/home/ada/.vscode-server" },
    },
    "wsl",
  );
  assertUnsupportedHost(
    {
      env: {},
      platform: "linux",
      homeDir: "/mnt/c/Users/Ada",
      extensionStorageUri: { scheme: "file", fsPath: "/mnt/c/Users/Ada/.vscode-server" },
    },
    "wsl",
  );
});

test("refuses Windows UNC and Windows-shaped paths on Linux hosts", () => {
  assertUnsupportedHost(
    {
      env: { CODEX_HOME: "\\\\fileserver\\profiles\\ada\\.codex" },
      platform: "win32",
      homeDir: "C:\\Users\\Ada",
      extensionStorageUri: { scheme: "file", fsPath: "C:\\Users\\Ada\\storage" },
    },
    "windows-unc",
  );
  assertUnsupportedHost(
    {
      env: { CODEX_HOME: "C:\\Users\\Ada\\.codex" },
      platform: "linux",
      homeDir: "/home/remote-user",
      extensionStorageUri: {
        scheme: "vscode-remote",
        authority: "ssh-remote+research-host",
        fsPath: "/home/remote-user/.vscode-server",
      },
    },
    "cross-host-path",
  );
  assertUnsupportedHost(
    {
      env: {},
      platform: "linux",
      homeDir: "/home/remote-user",
      extensionStorageUri: {
        scheme: "vscode-remote",
        authority: "ssh-remote+research-host",
        fsPath: "C:\\Users\\Ada\\AppData\\Roaming\\Code",
      },
    },
    "cross-host-path",
  );
});

function assertUnsupportedHost(
  options: Parameters<typeof resolveCodexLayout>[0],
  code: UnsupportedHostError["code"],
): void {
  assert.throws(
    () => resolveCodexLayout(options),
    (error: unknown) =>
      error instanceof UnsupportedHostError && error.code === code,
  );
}
