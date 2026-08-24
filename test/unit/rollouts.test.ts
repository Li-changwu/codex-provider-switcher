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

test("updates actual session_meta provider metadata and preserves every other byte", async () => {
  await withLayout(async (layout) => {
    const activePath = join(layout.sessionsDir, "active.jsonl");
    const archivedPath = join(layout.archivedSessionsDir, "archived.jsonl");
    const activeMeta = sessionMetaLine("active", "openai");
    const activeMessage = messageLine(true);
    const archivedMeta = sessionMetaLine("archived", "openai");
    const archivedMessage = messageLine(false);
    const activeBefore = `${activeMeta}\r\n${activeMessage}\n`;
    const archivedBefore = `${archivedMeta}\n${archivedMessage}`;
    await writeFile(activePath, activeBefore, "utf8");
    await writeFile(archivedPath, archivedBefore, "utf8");

    const report = await scanRollouts(layout, "custom");
    assert.equal(report.changes.length, 2);
    assert.equal(report.encryptedContentCount, 1);
    assert.match(report.warnings[0] ?? "", /encrypted_content/);
    assert.deepEqual(
      report.changes.map(({ path, sessionId, beforeProvider, encryptedContent }) => ({
        path,
        sessionId,
        beforeProvider,
        encryptedContent,
      })),
      [
        { path: activePath, sessionId: "active", beforeProvider: "openai", encryptedContent: true },
        { path: archivedPath, sessionId: "archived", beforeProvider: "openai", encryptedContent: false },
      ],
    );

    const result = await applyRolloutChanges(report.changes);
    assert.equal(result.applied, 2);
    assert.equal(
      await readFile(activePath, "utf8"),
      `${activeMeta.replace('"openai"', '"custom"')}\r\n${activeMessage}\n`,
    );
    assert.equal(
      await readFile(archivedPath, "utf8"),
      `${archivedMeta.replace('"openai"', '"custom"')}\n${archivedMessage}`,
    );
  });
});

test("rejects invalid UTF-8 before writing a rollout or changing its bytes", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "invalid-utf8.jsonl");
    const before = Buffer.concat([
      Buffer.from(`${sessionMetaLine("invalid-bytes", "openai")}\n`, "utf8"),
      Buffer.from('{"type":"message","raw":"', "utf8"),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n', "utf8"),
    ]);
    await writeFile(path, before);

    await assert.rejects(
      () => collectRolloutChanges(layout, "custom"),
      (error: unknown) =>
        error instanceof RolloutValidationError && error.code === "invalid-utf8",
    );
    assert.deepEqual(await readFile(path), before);
  });
});

test("rejects malformed JSONL during preflight before writing any file", async () => {
  await withLayout(async (layout) => {
    const validPath = join(layout.sessionsDir, "valid.jsonl");
    const malformedPath = join(layout.archivedSessionsDir, "malformed.jsonl");
    await writeFile(validPath, `${sessionMetaLine("valid", "openai")}\n`, "utf8");
    await writeFile(
      malformedPath,
      `${sessionMetaLine("bad", "openai")}\n{"type":"response_item"`,
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

test("fails closed for multiple session IDs in one rollout", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "multiple-sessions.jsonl");
    const before = `${sessionMetaLine("one", "openai")}\n${sessionMetaLine("two", "openai")}\n`;
    await writeFile(path, before, "utf8");

    await assert.rejects(
      () => collectRolloutChanges(layout, "custom"),
      (error: unknown) =>
        error instanceof RolloutValidationError && error.code === "unsupported-layout",
    );
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("fails closed for duplicate session_meta records with the same session ID", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "duplicate-session-meta.jsonl");
    const before = `${sessionMetaLine("duplicate", "openai")}\n${sessionMetaLine("duplicate", "openai")}\n`;
    await writeFile(path, before, "utf8");

    await assert.rejects(
      () => collectRolloutChanges(layout, "custom"),
      (error: unknown) =>
        error instanceof RolloutValidationError && error.code === "unsupported-layout",
    );
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("rejects duplicate session IDs across active and archived rollouts before writing", async () => {
  await withLayout(async (layout) => {
    const activePath = join(layout.sessionsDir, "same-active.jsonl");
    const archivedPath = join(layout.archivedSessionsDir, "same-archived.jsonl");
    const activeBefore = `${sessionMetaLine("duplicate", "openai")}\n`;
    const archivedBefore = `${sessionMetaLine("duplicate", "openai")}\n`;
    await writeFile(activePath, activeBefore, "utf8");
    await writeFile(archivedPath, archivedBefore, "utf8");

    await assert.rejects(
      () => collectRolloutChanges(layout, "custom"),
      (error: unknown) =>
        error instanceof RolloutValidationError && error.code === "unsupported-layout",
    );
    assert.equal(await readFile(activePath, "utf8"), activeBefore);
    assert.equal(await readFile(archivedPath, "utf8"), archivedBefore);
  });
});

test("rejects provider metadata nested outside session_meta.payload.model_provider", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "nested-provider.jsonl");
    const before = `${JSON.stringify({
      type: "session_meta",
      payload: { id: "nested", model_provider: "openai", provider: "openai" },
    })}\n`;
    await writeFile(path, before, "utf8");

    await assert.rejects(
      () => collectRolloutChanges(layout, "custom"),
      (error: unknown) =>
        error instanceof RolloutValidationError && error.code === "unsupported-layout",
    );
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("rejects model_provider at every path except session_meta.payload.model_provider", async () => {
  const invalidLines = [
    [
      "message-payload.jsonl",
      JSON.stringify({ type: "response_item", payload: { model_provider: "openai" } }),
    ],
    [
      "root.jsonl",
      JSON.stringify({ type: "response_item", model_provider: "openai" }),
    ],
    [
      "nested.jsonl",
      JSON.stringify({ type: "response_item", data: { payload: { model_provider: "openai" } } }),
    ],
  ] as const;

  for (const [fileName, invalidLine] of invalidLines) {
    await withLayout(async (layout) => {
      const path = join(layout.sessionsDir, fileName);
      const before = `${sessionMetaLine("valid", "openai")}\n${invalidLine}\n`;
      await writeFile(path, before, "utf8");

      await assert.rejects(
        () => collectRolloutChanges(layout, "custom"),
        (error: unknown) =>
          error instanceof RolloutValidationError && error.code === "unsupported-layout",
      );
      assert.equal(await readFile(path, "utf8"), before);
    });
  }
});

test("leaves a rollout with the target provider completely untouched", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "unchanged.jsonl");
    const before = `${sessionMetaLine("same", "custom")}\n${messageLine(false)}\n`;
    await writeFile(path, before, "utf8");

    const changes = await collectRolloutChanges(layout, "custom");
    assert.equal(changes.length, 0);
    assert.equal((await applyRolloutChanges(changes)).applied, 0);
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("rejects a forged change without scan provenance and leaves the file unchanged", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "forged.jsonl");
    const before = `${sessionMetaLine("forged", "openai")}\n`;
    await writeFile(path, before, "utf8");
    const changes = await collectRolloutChanges(layout, "custom");
    assert.equal(changes.length, 1);
    const forged = { ...changes[0] };

    await assert.rejects(
      () => applyRolloutChanges([forged]),
      (error: unknown) =>
        error instanceof RolloutValidationError && error.code === "change-mismatch",
    );
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("rejects a scan change after its replacement value is modified", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "mutated-replacement.jsonl");
    const before = `${sessionMetaLine("mutated", "openai")}\n`;
    await writeFile(path, before, "utf8");
    const changes = await collectRolloutChanges(layout, "custom");
    assert.equal(changes.length, 1);
    assert.equal(Object.isFrozen(changes[0]), true);
    assert.equal(Object.isFrozen(changes[0].replacements), true);
    assert.equal(Object.isFrozen(changes[0].replacements[0]), true);
    assert.throws(
      () => {
        changes[0].replacements[0].value = JSON.stringify("forged");
      },
      TypeError,
    );

    await assert.rejects(
      () => applyRolloutChanges(changes),
      (error: unknown) =>
        error instanceof RolloutValidationError && error.code === "change-mismatch",
    );
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("refuses to rename a file whose bytes changed after preflight", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "changed-after-scan.jsonl");
    await writeFile(path, `${sessionMetaLine("stale", "openai")}\n`, "utf8");
    const changes = await collectRolloutChanges(layout, "custom");
    const changed = `${sessionMetaLine("stale", "openai", "changed-title")}\n`;
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
    const before = `${sessionMetaLine("cancelled", "openai")}\n`;
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
    const before = `${sessionMetaLine("failure", "openai")}\n`;
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

test("rejects a rollout without a session_meta event", async () => {
  await withLayout(async (layout) => {
    await writeFile(
      join(layout.sessionsDir, "missing-session.jsonl"),
      `${messageLine(false)}\n`,
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

function sessionMetaLine(
  sessionId: string,
  provider: string | null,
  title = "Keep title",
): string {
  const providerValue = provider === null ? "null" : JSON.stringify(provider);
  return ` { "timestamp": "2026-08-25T00:00:00.000Z", "type" : "session_meta", "payload" : { "id": ${JSON.stringify(sessionId)}, "model_provider" : ${providerValue}, "title": ${JSON.stringify(title)}, "unknown": "Keep\\nunknown bytes" }, "unknown_record_field": { "keep": true } } `;
}

function messageLine(encrypted: boolean): string {
  return JSON.stringify({
    timestamp: "2026-08-25T00:01:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Keep message" }],
    },
    ...(encrypted ? { encrypted_content: "opaque-history" } : {}),
  });
}
