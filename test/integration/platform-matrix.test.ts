import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { writeActiveConfig } from "../../src/core/config";
import { resolveCodexLayout } from "../../src/core/codex-home";
import { ProfileStore } from "../../src/core/profiles";
import type { CodexLayout } from "../../src/core/types";

test("resolves injected Windows and Linux Extension Host homeDir fallbacks without cross-platform leakage", () => {
  const cases = [
    {
      name: "Windows native",
      options: {
        env: {},
        platform: "win32" as const,
        homeDir: "C:\\Users\\MatrixWindows",
        extensionStorageUri: {
          scheme: "file",
          fsPath: "C:\\Users\\MatrixWindows\\AppData\\Roaming\\Code\\User\\globalStorage",
        },
        kernelReleaseProbe: () => "not-used-for-windows",
      },
      expectedHome: "C:\\Users\\MatrixWindows\\.codex",
    },
    {
      name: "Linux native",
      options: {
        env: {},
        platform: "linux" as const,
        homeDir: "/home/matrix-linux",
        extensionStorageUri: {
          scheme: "file",
          fsPath: "/home/matrix-linux/.config/Code/User/globalStorage",
        },
        kernelReleaseProbe: () => "6.8.0-matrix",
      },
      expectedHome: "/home/matrix-linux/.codex",
    },
    {
      name: "Linux Remote SSH",
      options: {
        env: {},
        platform: "linux" as const,
        homeDir: "/home/matrix-remote",
        extensionStorageUri: {
          scheme: "vscode-remote",
          authority: "ssh-remote+matrix-host",
          fsPath: "/home/matrix-remote/.vscode-server/data/User/globalStorage",
        },
        kernelReleaseProbe: () => "6.8.0-matrix",
      },
      expectedHome: "/home/matrix-remote/.codex",
    },
  ];

  for (const fixture of cases) {
    const layout = resolveCodexLayout(fixture.options);
    assert.equal(layout.codexHome, fixture.expectedHome, fixture.name);
    assert.equal(
      layout.configPath,
      fixture.options.platform === "win32"
        ? `${fixture.expectedHome}\\config.toml`
        : `${fixture.expectedHome}/config.toml`,
      fixture.name,
    );
    assertPlatformPathForms(layout, fixture.options.platform, fixture.name);
  }
});

test("atomically replaces an existing active config without leaving a sibling temporary file", async () => {
  await withTemporaryLayout(async (layout) => {
    const previous = 'model_provider = "previous"\n';
    const replacement = 'model_provider = "replacement"\n';
    await writeFile(layout.configPath, previous, "utf8");

    await writeActiveConfig(layout, replacement, {
      beforePublish: async (path) => {
        assert.equal(path, layout.configPath);
        assert.deepEqual(await readFile(layout.configPath), Buffer.from(previous));
        const temporaryNames = (await readdir(layout.codexHome)).filter((name) =>
          name.startsWith(".config.toml.tmp-"),
        );
        assert.equal(temporaryNames.length, 1);
        const [temporaryName] = temporaryNames;
        assert.ok(temporaryName);
        assert.deepEqual(
          await readFile(join(layout.codexHome, temporaryName)),
          Buffer.from(replacement),
        );
      },
    });

    assert.deepEqual(await readFile(layout.configPath), Buffer.from(replacement));
    const siblingNames = await readdir(layout.codexHome);
    assert.deepEqual(
      siblingNames.filter((name) => name.startsWith(".config.toml.tmp-")),
      [],
    );
  });
});

test("writes a ProfileStore config to disk with Linux-only private-mode verification", async () => {
  await withTemporaryLayout(async (layout) => {
    const configText = 'model_provider = "openai"\n';
    const profile = await new ProfileStore(layout, {
      now: () => "2026-08-28T00:00:00.000Z",
    }).create({
      name: "matrix profile",
      kind: "official",
      configText,
    });

    assert.deepEqual(await readFile(profile.configFile), Buffer.from(configText));
    if (process.platform === "win32") {
      return;
    }
    assert.equal(process.platform, "linux");
    assert.equal((await stat(profile.configFile)).mode & 0o777, 0o600);
  });
});

function assertPlatformPathForms(
  layout: CodexLayout,
  platform: "linux" | "win32",
  label: string,
): void {
  for (const path of Object.values(layout)) {
    if (platform === "win32") {
      assert.equal(path.includes("/"), false, `${label}: leaked POSIX path form`);
      continue;
    }
    assert.doesNotMatch(path, /[A-Za-z]:[\\/]|\\\\/, `${label}: leaked Windows path form`);
  }
}

async function withTemporaryLayout(
  operation: (layout: CodexLayout) => Promise<void>,
): Promise<void> {
  const codexHome = await mkdtemp(join(tmpdir(), "platform-matrix-"));
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
    await operation(layout);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}
