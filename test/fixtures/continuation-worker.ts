import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  continueSession,
  type InteractiveCodexTerminal,
  type TerminalInvocation,
} from "../../src/core/continuation";
import type { CodexLayout } from "../../src/core/types";

const workerId = requiredEnvironment("CONTINUATION_WORKER_ID");
const layout = JSON.parse(requiredEnvironment("CONTINUATION_WORKER_LAYOUT")) as CodexLayout;
const synchronizationDirectory = requiredEnvironment("CONTINUATION_WORKER_SYNC_DIRECTORY");

async function main(): Promise<void> {
  await writeFile(join(synchronizationDirectory, `started-${workerId}`), "started", "utf8");
  await waitForFile(join(synchronizationDirectory, "start"));
  await continueSession({
    layout,
    sessionId: "source-1",
    mode: "fork",
    targetProfileId: "custom",
    sourceEventHash: `a${workerId === "one" ? "3".repeat(63) : "4".repeat(63)}`,
    terminal: new WorkerTerminal(),
    commandRunner: async () => ({
      exitCode: 0,
      stdout: "Commands: resume fork archive unarchive",
      stderr: "",
    }),
  });
}

class WorkerTerminal implements InteractiveCodexTerminal {
  readonly reportsForkOutcome = true;

  async launch(invocation: TerminalInvocation) {
    if (invocation.args.includes("fork")) {
      await writeFile(join(synchronizationDirectory, `ready-${workerId}`), "ready", "utf8");
      await waitForFile(join(synchronizationDirectory, "release"));
      return { branchSessionId: `branch-worker-${workerId}` };
    }
    return {};
  }
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
