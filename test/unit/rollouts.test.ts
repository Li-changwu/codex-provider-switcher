import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  applyRolloutChanges,
  collectRolloutChanges,
  RolloutValidationError,
  scanRollouts,
} from "../../src/core/rollouts";
import type { CodexLayout } from "../../src/core/types";

test("updates active and archived provider rows while preserving every other byte", async () => {
  await withLayout(async (layout) => {
    const activePath = join(layout.sessionsDir, "active.jsonl");
    const archivedPath = join(layout.archivedSessionsDir, "archived.jsonl");
    const activeProvider = providerLine("active", "openai");
    const activeMessage = messageLine("active", true);
    const archivedProvider = providerLine("archived", "openai");
    const archivedMessage = messageLine("archived", false);
    const activeBefore = `${activeProvider}\r\n${activeMessage}\n`;
    const archivedBefore = `${archivedProvider}\n${archivedMessage}`;
    await writeFile(activePath, activeBefore, "utf8");
    await writeFile(archivedPath, archivedBefore, "utf8");

    const report = await scanRollouts(layout, "custom");
    assert.equal(report.changes.length, 2);
    assert.equal(report.encryptedContentCount, 1);
    assert.match(report.warnings[0] ?? "", /encrypted_content/);
    assert.deepEqual(
      report.changes.map(({ path, sessionId, encryptedContent }) => ({
        path,
        sessionId,
        encryptedContent,
      })),
      [
        { path: activePath, sessionId: "active", encryptedContent: true },
        { path: archivedPath, sessionId: "archived", encryptedContent: false },
      ],
    );

    const result = await applyRolloutChanges(report.changes);
    assert.equal(result.applied, 2);
    assert.equal(
      await readFile(activePath, "utf8"),
      `${activeProvider.replace('"openai"', '"custom"')}\r\n${activeMessage}\n`,
    );
    assert.equal(
      await readFile(archivedPath, "utf8"),
      `${archivedProvider.replace('"openai"', '"custom"')}\n${archivedMessage}`,
    );
  });
});

test("rejects malformed JSONL during preflight before writing any file", async () => {
  await withLayout(async (layout) => {
    const validPath = join(layout.sessionsDir, "valid.jsonl");
    const malformedPath = join(layout.archivedSessionsDir, "malformed.jsonl");
    await writeFile(validPath, `${providerLine("valid", "openai")}\n`, "utf8");
    await writeFile(
      malformedPath,
      `${providerLine("bad", "openai")}\n{"session_id":`,
      "utf8",
    );
    const validBefore = await readFile(validPath, "utf8");
    const malformedBefore = await readFile(malformedPath, "utf8");

    await assert.rejects(
      () => collectRolloutChanges(layout, "custom"),
      (error: unknown) =>
        error instanceof RolloutValidationError && error.code === "malformed-jsonl",
    );
    assert.equal(await readFile(validPath, "utf8"), validBefore);
    assert.equal(await readFile(malformedPath, "utf8"), malformedBefore);
  });
});

test("fails closed for duplicate or different provider session IDs", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "unknown-layout.jsonl");
    const before = `${providerLine("one", "openai")}\n${providerLine("two", "openai")}\n`;
    await writeFile(path, before, "utf8");

    await assert.rejects(
      () => collectRolloutChanges(layout, "custom"),
      (error: unknown) =>
        error instanceof RolloutValidationError && error.code === "unsupported-layout",
    );
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("rejects provider metadata nested outside the root object", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "nested-provider.jsonl");
    const before = `${JSON.stringify({ session_id: "nested", data: { provider: "openai" } })}\n`;
    await writeFile(path, before, "utf8");

    await assert.rejects(
      () => collectRolloutChanges(layout, "custom"),
      (error: unknown) =>
        error instanceof RolloutValidationError && error.code === "unsupported-layout",
    );
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("leaves a rollout without a non-target provider completely untouched", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "unchanged.jsonl");
    const before = `${providerLine("same", "custom")}\n${messageLine("same", false)}\n`;
    await writeFile(path, before, "utf8");

    const changes = await collectRolloutChanges(layout, "custom");
    assert.equal(changes.length, 0);
    assert.equal((await applyRolloutChanges(changes)).applied, 0);
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("refuses to rename a file whose bytes changed after preflight", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "changed-after-scan.jsonl");
    await writeFile(path, `${providerLine("stale", "openai")}\n`, "utf8");
    const changes = await collectRolloutChanges(layout, "custom");
    const changed = `${providerLine("stale", "openai", "changed-title")}\n`;
    await writeFile(path, changed, "utf8");

    await assert.rejects(
      () => applyRolloutChanges(changes),
      (error: unknown) =>
        error instanceof RolloutValidationError && error.code === "change-mismatch",
    );
    assert.equal(await readFile(path, "utf8"), changed);
  });
});

test("cancellation before the first rename leaves the old file and temp file state clean", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "cancelled.jsonl");
    const before = `${providerLine("cancelled", "openai")}\n`;
    await writeFile(path, before, "utf8");
    const changes = await collectRolloutChanges(layout, "custom");
    const controller = new AbortController();

    await assert.rejects(
      () =>
        applyRolloutChanges(changes, controller.signal, {
          beforeRename: () => controller.abort(),
        }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(
      (await readdir(layout.sessionsDir)).some((name) => name.includes(".tmp-")),
      false,
    );
  });
});

test("cleans the sibling temp file when a single-file write fails", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "write-failure.jsonl");
    const before = `${providerLine("failure", "openai")}\n`;
    await writeFile(path, before, "utf8");
    const changes = await collectRolloutChanges(layout, "custom");

    await assert.rejects(() =>
      applyRolloutChanges(changes, undefined, {
        beforeRename: () => {
          throw new Error("injected write failure");
        },
      }),
    );
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(
      (await readdir(layout.sessionsDir)).some((name) => name.includes(".tmp-")),
      false,
    );
  });
});

test("rejects a rollout that contains no session_id event", async () => {
  await withLayout(async (layout) => {
    await writeFile(
      join(layout.sessionsDir, "missing-session.jsonl"),
      `${JSON.stringify({ message: "no session" })}\n`,
      "utf8",
    );

    await assert.rejects(
      () => collectRolloutChanges(layout, "custom"),
      (error: unknown) =>
        error instanceof RolloutValidationError && error.code === "missing-session-id",
    );
  });
});

async function withLayout(callback: (layout: CodexLayout) => Promise<void>): Promise<void> {
  const codexHome = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "codex-rollouts-"));
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
  try {
    await callback(layout);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

function providerLine(
  sessionId: string,
  provider: string | null,
  title = "Keep title",
): string {
  const providerValue = provider === null ? "null" : JSON.stringify(provider);
  return ` { "session_id": ${JSON.stringify(sessionId)}, "provider" : ${providerValue}, "title": ${JSON.stringify(title)}, "timestamp": "2026-08-25T00:00:00.000Z", "unknown": "Keep\\nunknown bytes" } `;
}

function messageLine(sessionId: string, encrypted: boolean): string {
  return JSON.stringify({
    session_id: sessionId,
    type: "message",
    data: encrypted ? { encrypted_content: "opaque-history" } : { text: "Keep message" },
    title: "Keep message title",
    timestamp: "2026-08-25T00:01:00.000Z",
  });
}
