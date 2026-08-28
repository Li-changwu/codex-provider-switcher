import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  clearCodexCapabilityCacheForTests,
  continueSession,
  type InteractiveCodexTerminal,
  type TerminalInvocation,
} from "../../src/core/continuation";
import type { CodexLayout } from "../../src/core/types";

test("runs a fake Codex CLI with argument vectors for capability discovery and native fork", async () => {
  await withLayout(async (layout) => {
    clearCodexCapabilityCacheForTests();
    const fakeCliPath = join(layout.codexHome, "fake-codex.cjs");
    const invocationLogPath = join(layout.codexHome, "fake-codex.log");
    await writeFile(fakeCliPath, [
      "const { appendFileSync } = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + '\\n');",
      "if (args.at(-1) === '--help') { process.stdout.write('Commands: resume fork\\n'); process.exit(0); }",
      "if (args.at(-2) === 'fork' && args.at(-1) === 'source-1') { process.exit(0); }",
      "process.exit(17);",
    ].join("\n"), "utf8");
    const terminal = new SpawnTerminal({ branchSessionId: "branch-1" });

    const result = await continueSession({
      layout,
      sessionId: "source-1",
      mode: "fork",
      targetProfileId: "custom",
      sourceEventHash: "a".repeat(64),
      terminal,
      codexCommand: process.execPath,
      codexCommandPrefixArgs: [fakeCliPath],
      commandRunner: async (command, args) => run(command, args, {
        ...process.env,
        FAKE_CODEX_LOG: invocationLogPath,
      }),
    });

    assert.equal(result.status, "forked");
    assert.deepEqual(terminal.invocations, [{
      command: process.execPath,
      args: [fakeCliPath, "fork", "source-1"],
      title: "Codex: Fork source-1",
      shell: false,
    }]);
    const invocations = (await readFile(invocationLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(invocations, [["--help"]]);
  });
});

class SpawnTerminal implements InteractiveCodexTerminal {
  readonly reportsForkOutcome = true;
  readonly invocations: TerminalInvocation[] = [];

  constructor(private readonly result: { branchSessionId: string }) {}

  async launch(invocation: TerminalInvocation) {
    this.invocations.push(invocation);
    const completed = await run(invocation.command, invocation.args);
    return { exitCode: completed.exitCode, branchSessionId: this.result.branchSessionId };
  }
}

function run(
  command: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, env: environment });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      exitCode: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function withLayout(callback: (layout: CodexLayout) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "continuation-integration-"));
  const layout: CodexLayout = {
    codexHome: root,
    configPath: join(root, "config.toml"),
    authPath: join(root, "auth.json"),
    sessionsDir: join(root, "sessions"),
    archivedSessionsDir: join(root, "archived_sessions"),
    sqlitePath: join(root, "state_5.sqlite"),
    switcherDir: join(root, "provider-switcher"),
  };
  await mkdir(layout.sessionsDir);
  await mkdir(layout.archivedSessionsDir);
  await mkdir(layout.switcherDir);
  try {
    await callback(layout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
