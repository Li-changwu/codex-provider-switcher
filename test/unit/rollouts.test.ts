import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  applyRolloutChanges,
  collectRolloutChanges,
  createRolloutInversePatches,
  listContinuationSourceAnchors,
  reverseRolloutInversePatch,
  RolloutCancelledError,
  RolloutPersistenceError,
  RolloutValidationError,
  scanRollouts,
  validateRolloutInversePatch,
} from "../../src/core/rollouts";
import type { CodexLayout } from "../../src/core/types";

test("lists deterministic metadata-only continuation anchors from active and archived rollouts", async () => {
  await withLayout(async (layout) => {
    const activePath = join(layout.sessionsDir, "sensitive-transcript-path.jsonl");
    const archivedPath = join(layout.archivedSessionsDir, "archived.jsonl");
    const active = `${sessionMetaLine("zeta", "openai")}\n${messageLineWithText("transcript-do-not-leak")}\n`;
    const archived = `${sessionMetaLine("alpha", "custom")}\n${messageLine(false)}\n`;
    await writeFile(activePath, active, "utf8");
    await writeFile(archivedPath, archived, "utf8");

    const anchors = await listContinuationSourceAnchors(layout);

    assert.deepEqual(anchors, [
      { sessionId: "alpha", sourceEventHash: sha256(archived) },
      { sessionId: "zeta", sourceEventHash: sha256(active) },
    ]);
    for (const anchor of anchors) {
      assert.deepEqual(Object.keys(anchor).sort(), ["sessionId", "sourceEventHash"]);
      assert.match(anchor.sourceEventHash, /^[a-f0-9]{64}$/);
    }
    const serialized = JSON.stringify(anchors);
    assert.equal(serialized.includes("transcript-do-not-leak"), false);
    assert.equal(serialized.includes("sensitive-transcript-path.jsonl"), false);
  });
});

test("updates only the edited rollout continuation source hash", async () => {
  await withLayout(async (layout) => {
    const activePath = join(layout.sessionsDir, "active.jsonl");
    const archivedPath = join(layout.archivedSessionsDir, "archived.jsonl");
    const active = `${sessionMetaLine("active", "openai")}\n${messageLine(false)}\n`;
    const archived = `${sessionMetaLine("archived", "custom")}\n${messageLine(false)}\n`;
    await writeFile(activePath, active, "utf8");
    await writeFile(archivedPath, archived, "utf8");
    const before = await listContinuationSourceAnchors(layout);

    const editedArchived = `${archived}${messageLineWithText("edited transcript")}\n`;
    await writeFile(archivedPath, editedArchived, "utf8");
    const after = await listContinuationSourceAnchors(layout);

    assert.deepEqual(before, [
      { sessionId: "active", sourceEventHash: sha256(active) },
      { sessionId: "archived", sourceEventHash: sha256(archived) },
    ]);
    assert.deepEqual(after, [
      { sessionId: "active", sourceEventHash: sha256(active) },
      { sessionId: "archived", sourceEventHash: sha256(editedArchived) },
    ]);
  });
});

test("fails closed when continuation source anchors contain duplicate session IDs", async () => {
  await withLayout(async (layout) => {
    const activePath = join(layout.sessionsDir, "active.jsonl");
    const archivedPath = join(layout.archivedSessionsDir, "archived.jsonl");
    const active = `${sessionMetaLine("duplicate", "openai")}\n`;
    const archived = `${sessionMetaLine("duplicate", "custom")}\n`;
    await writeFile(activePath, active, "utf8");
    await writeFile(archivedPath, archived, "utf8");

    await assert.rejects(
      () => listContinuationSourceAnchors(layout),
      (error: unknown) =>
        error instanceof RolloutValidationError && error.code === "unsupported-layout",
    );
    assert.equal(await readFile(activePath, "utf8"), active);
    assert.equal(await readFile(archivedPath, "utf8"), archived);
  });
});

test("fails closed when continuation source metadata is missing or malformed", async () => {
  const invalidRecords = [
    `${messageLine(false)}\n`,
    '{"type":"session_meta","payload":{}}\n',
    '{"type":"session_meta","payload":{"id":42}}\n',
    '{"type":"session_meta","payload":null}\n',
  ];

  for (const [index, content] of invalidRecords.entries()) {
    await withLayout(async (layout) => {
      const path = join(layout.sessionsDir, `invalid-${index}.jsonl`);
      await writeFile(path, content, "utf8");

      await assert.rejects(
        () => listContinuationSourceAnchors(layout),
        (error: unknown) => error instanceof RolloutValidationError,
      );
      assert.equal(await readFile(path, "utf8"), content);
    });
  }
});

test("redacts missing continuation anchor metadata failures", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "missing-anchor-fixture.jsonl");
    const transcript = "missing-anchor-transcript";
    await writeFile(path, `${messageLineWithText(transcript)}\n`, "utf8");

    await assert.rejects(
      () => listContinuationSourceAnchors(layout),
      (error: unknown) => {
        if (!(error instanceof RolloutValidationError)) {
          return false;
        }
        assert.equal(error.message.includes(path), false);
        assert.equal(error.message.includes(transcript), false);
        return error.code === "missing-session-id";
      },
    );
  });
});

test("redacts malformed continuation anchor metadata failures", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "malformed-anchor-fixture.jsonl");
    const transcript = "malformed-anchor-transcript";
    await writeFile(
      path,
      `{"type":"session_meta","payload":null}\n${messageLineWithText(transcript)}\n`,
      "utf8",
    );

    await assert.rejects(
      () => listContinuationSourceAnchors(layout),
      (error: unknown) => {
        if (!(error instanceof RolloutValidationError)) {
          return false;
        }
        assert.equal(error.message.includes(path), false);
        assert.equal(error.message.includes(transcript), false);
        return error.code === "unsupported-layout";
      },
    );
  });
});

test("redacts duplicate continuation anchor metadata failures", async () => {
  await withLayout(async (layout) => {
    const activePath = join(layout.sessionsDir, "duplicate-anchor-active.jsonl");
    const archivedPath = join(layout.archivedSessionsDir, "duplicate-anchor-fixture.jsonl");
    const transcript = "duplicate-anchor-transcript";
    await writeFile(activePath, `${sessionMetaLine("duplicate-anchor", "openai")}\n`, "utf8");
    await writeFile(
      archivedPath,
      `${sessionMetaLine("duplicate-anchor", "custom")}\n${messageLineWithText(transcript)}\n`,
      "utf8",
    );

    await assert.rejects(
      () => listContinuationSourceAnchors(layout),
      (error: unknown) => {
        if (!(error instanceof RolloutValidationError)) {
          return false;
        }
        assert.equal(error.message.includes(archivedPath), false);
        assert.equal(error.message.includes(transcript), false);
        return error.code === "unsupported-layout";
      },
    );
  });
});

test("rejects a sessions directory symlink that escapes Codex Home", async (t) => {
  const externalRoot = await mkdtemp(join(tmpdir(), "codex-rollout-external-"));
  try {
    await withLayout(async (layout) => {
      const externalPath = join(externalRoot, "outside.jsonl");
      const before = `${sessionMetaLine("outside", "openai")}\n`;
      await writeFile(externalPath, before, "utf8");
      await rm(layout.sessionsDir, { recursive: true, force: true });
      try {
        await symlink(
          externalRoot,
          layout.sessionsDir,
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          t.skip("This platform does not permit creating directory links.");
          return;
        }
        throw error;
      }

      await assert.rejects(
        () => collectRolloutChanges(layout, "custom"),
        (error: unknown) =>
          error instanceof RolloutValidationError && error.code === "unsupported-layout",
      );
      assert.equal(await readFile(externalPath, "utf8"), before);
    });
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("rejects a JSONL hard link to content outside Codex Home", async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), "codex-rollout-hardlink-"));
  try {
    await withLayout(async (layout) => {
      const externalPath = join(externalRoot, "outside.jsonl");
      const linkedPath = join(layout.sessionsDir, "linked.jsonl");
      const before = `${sessionMetaLine("hard-linked", "openai")}\n`;
      await writeFile(externalPath, before, "utf8");
      await link(externalPath, linkedPath);

      await assert.rejects(
        () => collectRolloutChanges(layout, "custom"),
        (error: unknown) =>
          error instanceof RolloutValidationError && error.code === "unsupported-layout",
      );
      assert.equal(await readFile(externalPath, "utf8"), before);
    });
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("refuses apply after a rollout is replaced by an external symlink", async (t) => {
  const externalRoot = await mkdtemp(join(tmpdir(), "codex-rollout-swap-"));
  try {
    await withLayout(async (layout) => {
      const path = join(layout.sessionsDir, "swapped.jsonl");
      const externalPath = join(externalRoot, "outside.jsonl");
      const before = `${sessionMetaLine("swapped", "openai")}\n`;
      await writeFile(path, before, "utf8");
      const changes = await collectRolloutChanges(layout, "custom");
      await rm(path);
      await writeFile(externalPath, before, "utf8");
      try {
        await symlink(externalPath, path, "file");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          t.skip("This platform does not permit creating file links.");
          return;
        }
        throw error;
      }

      await assert.rejects(
        () => applyRolloutChanges(changes),
        (error: unknown) =>
          error instanceof RolloutValidationError && error.code === "change-mismatch",
      );
      assert.equal(await readFile(externalPath, "utf8"), before);
    });
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("rejects an external inverse patch against the supplied Codex layout", async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), "codex-rollout-inverse-external-"));
  try {
    await withLayout(async (layout) => {
      const externalPath = join(externalRoot, "outside.jsonl");
      const before = '{"type":"session_meta","payload":{"id":"outside","model_provider":"custom"}}\n';
      const after = '{"type":"session_meta","payload":{"id":"outside","model_provider":"openai"}}\n';
      await writeFile(externalPath, before, "utf8");
      const start = before.indexOf('"custom"');
      const patch = {
        version: 1 as const,
        path: externalPath,
        sessionId: "outside",
        preHash: sha256(after),
        postHash: sha256(before),
        replacements: [{
          line: 0,
          start,
          end: start + '"custom"'.length,
          expectedValue: '"custom"',
          value: '"openai"',
        }],
      };

      const validateOutcome = await rolloutOutcome(() =>
        validateRolloutInversePatch(patch, layout),
      );
      const reverseOutcome = await rolloutOutcome(() =>
        reverseRolloutInversePatch(patch, layout),
      );

      assert.deepEqual(
        [validateOutcome, reverseOutcome, await readFile(externalPath, "utf8")],
        ["unsupported-layout", "unsupported-layout", before],
      );
    });
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("rejects a source handle opened through an external hard link", async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), "codex-rollout-open-swap-"));
  try {
    await withLayout(async (layout) => {
      const path = join(layout.sessionsDir, "open-swapped.jsonl");
      const externalPath = join(externalRoot, "outside.jsonl");
      const before = `${sessionMetaLine("open-swapped", "openai")}\n`;
      await writeFile(path, before, "utf8");
      await writeFile(externalPath, before, "utf8");
      const changes = await collectRolloutChanges(layout, "custom");

      await assert.rejects(
        () =>
          applyRolloutChanges(changes, undefined, {
            beforeReadOpen: async () => {
              await rm(path);
              await link(externalPath, path);
            },
          }),
        (error: unknown) =>
          error instanceof RolloutValidationError && error.code === "change-mismatch",
      );
      assert.equal(await readFile(externalPath, "utf8"), before);
      assert.equal(
        (await readdir(layout.sessionsDir)).some((name) => name.includes(".tmp-")),
        false,
      );
    });
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("refuses rename after a rollout is replaced by an external hard link", async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), "codex-rollout-rename-swap-"));
  try {
    await withLayout(async (layout) => {
      const path = join(layout.sessionsDir, "rename-swapped.jsonl");
      const externalPath = join(externalRoot, "outside.jsonl");
      const before = `${sessionMetaLine("rename-swapped", "openai")}\n`;
      await writeFile(path, before, "utf8");
      await writeFile(externalPath, before, "utf8");
      const changes = await collectRolloutChanges(layout, "custom");

      await assert.rejects(
        () =>
          applyRolloutChanges(changes, undefined, {
            beforeRename: async () => {
              await rm(path);
              await link(externalPath, path);
            },
          }),
        (error: unknown) =>
          error instanceof RolloutValidationError && error.code === "change-mismatch",
      );
      assert.equal(await readFile(externalPath, "utf8"), before);
      assert.equal(
        (await readdir(layout.sessionsDir)).some((name) => name.includes(".tmp-")),
        false,
      );
    });
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
});

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

test("cancels an already aborted scan before inspecting rollout files", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "malformed.jsonl");
    const before = "not valid JSONL\n";
    const controller = new AbortController();
    await writeFile(path, before, "utf8");
    controller.abort();

    await assert.rejects(
      () => scanRollouts(layout, "custom", { signal: controller.signal }),
      (error: unknown) => error instanceof RolloutCancelledError,
    );
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("reports ordered rollout scan progress with the discovered total", async () => {
  await withLayout(async (layout) => {
    const activeFirst = join(layout.sessionsDir, "a-first.jsonl");
    const activeSecond = join(layout.sessionsDir, "b-second.jsonl");
    const archived = join(layout.archivedSessionsDir, "c-archived.jsonl");
    await writeFile(activeFirst, `${sessionMetaLine("first", "openai")}\n`, "utf8");
    await writeFile(activeSecond, `${sessionMetaLine("second", "openai")}\n`, "utf8");
    await writeFile(archived, `${sessionMetaLine("archived", "openai")}\n`, "utf8");
    const progress: Array<{ completed: number; total: number }> = [];

    const report = await scanRollouts(layout, "custom", {
      onProgress: (update) => progress.push(update),
    });

    assert.deepEqual(progress, [
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ]);
    assert.deepEqual(report.changes.map((change) => change.path), [
      activeFirst,
      activeSecond,
      archived,
    ]);
  });
});

test("cancels collection after progress without scanning the next rollout", async () => {
  await withLayout(async (layout) => {
    const firstPath = join(layout.sessionsDir, "a-first.jsonl");
    const secondPath = join(layout.sessionsDir, "b-unreadable.jsonl");
    const firstBefore = `${sessionMetaLine("first", "openai")}\n`;
    const secondBefore = "not valid JSONL\n";
    const controller = new AbortController();
    const progress: Array<{ completed: number; total: number }> = [];
    await writeFile(firstPath, firstBefore, "utf8");
    await writeFile(secondPath, secondBefore, "utf8");

    await assert.rejects(
      () =>
        collectRolloutChanges(layout, "custom", {
          signal: controller.signal,
          onProgress: (update) => {
            progress.push(update);
            controller.abort();
          },
        }),
      (error: unknown) => error instanceof RolloutCancelledError,
    );
    assert.deepEqual(progress, [{ completed: 1, total: 2 }]);
    assert.equal(await readFile(firstPath, "utf8"), firstBefore);
    assert.equal(await readFile(secondPath, "utf8"), secondBefore);
  });
});

test("builds a metadata-only inverse patch and refuses an externally modified rollout", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "inverse.jsonl");
    const before = `${sessionMetaLine("inverse", "openai")}\n${messageLine(true)}\n`;
    await writeFile(path, before, "utf8");
    const changes = await collectRolloutChanges(layout, "custom");
    const [patch] = createRolloutInversePatches(changes);
    assert.equal(patch.sessionId, "inverse");
    assert.doesNotMatch(
      JSON.stringify(patch),
      /Keep message|opaque-history|Keep title|unknown bytes|encrypted_content/,
    );
    await applyRolloutChanges(changes);
    const externallyModified = `${await readFile(path, "utf8")}{"type":"response_item","external":true}\n`;
    await writeFile(path, externallyModified, "utf8");

    await assert.rejects(
      () => reverseRolloutInversePatch(patch, layout),
      /hash|changed/i,
    );
    assert.equal(await readFile(path, "utf8"), externallyModified);
  });
});

test("refuses a hash-matching inverse patch whose coordinates target a non-provider field", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "wrong-coordinate.jsonl");
    const preImage = '{"type":"session_meta","payload":{"id":"coordinate","model_provider":"custom","title":"openai"}}\n';
    const postImage = '{"type":"session_meta","payload":{"id":"coordinate","model_provider":"custom","title":"custom"}}\n';
    await writeFile(path, postImage, "utf8");
    const start = postImage.lastIndexOf('"custom"');
    const end = start + '"custom"'.length;

    await assert.rejects(
      () =>
        reverseRolloutInversePatch({
          version: 1,
          path,
          sessionId: "coordinate",
          preHash: sha256(preImage),
          postHash: sha256(postImage),
          replacements: [{
            line: 0,
            start,
            end,
            expectedValue: '"custom"',
            value: '"openai"',
          }],
        }, layout),
      (error: unknown) =>
        error instanceof RolloutValidationError && error.code === "change-mismatch",
    );
    assert.equal(await readFile(path, "utf8"), postImage);
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

test("rejects an oversized no-newline JSONL record before parsing or writing", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "oversized.jsonl");
    const maxRecordBytes = 8 * 1024 * 1024;
    const before = Buffer.alloc(maxRecordBytes + 1, 0x7b);
    await writeFile(path, before);

    await assert.rejects(
      () => collectRolloutChanges(layout, "custom"),
      (error: unknown) =>
        error instanceof RolloutValidationError &&
        error.code === "jsonl-record-too-large" &&
        error.message.includes(path),
    );

    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(await readdir(layout.sessionsDir), ["oversized.jsonl"]);
  });
});

test("allows a valid no-newline JSONL record at the byte limit", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "exact-limit.jsonl");
    const maxRecordBytes = 8 * 1024 * 1024;
    const prefix = '{"type":"session_meta","payload":{"id":"exact-limit","model_provider":"openai","padding":"';
    const suffix = '"}}';
    const paddingBytes = maxRecordBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    const before = Buffer.from(`${prefix}${"x".repeat(paddingBytes)}${suffix}`, "utf8");
    assert.equal(before.length, maxRecordBytes);
    await writeFile(path, before);

    const changes = await collectRolloutChanges(layout, "custom");

    assert.equal(changes.length, 1);
    assert.equal(changes[0].sessionId, "exact-limit");
    assert.deepEqual(await readFile(path), before);
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

test("preserves rollout permission bits when applying a change", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix permission bits are not portable on Windows.");
    return;
  }

  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "permissions.jsonl");
    const before = `${sessionMetaLine("permissions", "openai")}\n`;
    const sourceMode = 0o600;
    await writeFile(path, before, "utf8");
    await chmod(path, sourceMode);

    const changes = await collectRolloutChanges(layout, "custom");
    await applyRolloutChanges(changes);

    const resultingMode = (await lstat(path)).mode & 0o7777;
    assert.equal(resultingMode & ~sourceMode, 0);
    assert.equal(resultingMode, sourceMode);
  });
});

test("syncs the rollout parent directory after rename", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "directory-sync.jsonl");
    const before = `${sessionMetaLine("directory-sync", "openai")}\n`;
    const after = `${sessionMetaLine("directory-sync", "custom")}\n`;
    await writeFile(path, before, "utf8");
    const changes = await collectRolloutChanges(layout, "custom");
    const syncedDirectories: string[] = [];

    await applyRolloutChanges(changes, undefined, {
      io: {
        syncDirectory: async (directoryPath) => {
          syncedDirectories.push(directoryPath);
          assert.equal(await readFile(path, "utf8"), after);
        },
      },
    });

    assert.deepEqual(syncedDirectories, [layout.sessionsDir]);
    assert.equal(await readFile(path, "utf8"), after);
  });
});

test("reports a parent directory sync failure after rename without losing the rollout path", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "directory-sync-failure.jsonl");
    const before = `${sessionMetaLine("directory-sync-failure", "openai")}\n`;
    const after = `${sessionMetaLine("directory-sync-failure", "custom")}\n`;
    const syncError = new Error("injected directory sync failure");
    await writeFile(path, before, "utf8");
    const changes = await collectRolloutChanges(layout, "custom");

    await assert.rejects(
      () =>
        applyRolloutChanges(changes, undefined, {
          io: {
            syncDirectory: async (directoryPath) => {
              assert.equal(directoryPath, layout.sessionsDir);
              throw syncError;
            },
          },
        }),
      (error: unknown) =>
        error instanceof RolloutPersistenceError &&
        error.message.includes(path) &&
        error.cause === syncError,
    );

    assert.equal(await readFile(path, "utf8"), after);
    assert.equal(
      (await readdir(layout.sessionsDir)).some((name) => name.includes(".tmp-")),
      false,
    );
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

test("rejects a zero-progress write after a deterministic partial rollout write", async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), "codex-rollout-short-write-"));
  try {
    await withLayout(async (layout) => {
      const path = join(layout.sessionsDir, "short-write.jsonl");
      const externalPath = join(externalRoot, "outside.jsonl");
      const before = `${sessionMetaLine("short-write", "openai")}\n${messageLine(false)}\n`;
      const externalBefore = "outside content must remain unchanged\n";
      await writeFile(path, before, "utf8");
      await writeFile(externalPath, externalBefore, "utf8");
      const changes = await collectRolloutChanges(layout, "custom");
      let writeCalls = 0;

      await assert.rejects(
        () =>
          applyRolloutChanges(changes, undefined, {
            io: {
              write: async (handle, buffer, offset, length) => {
                writeCalls += 1;
                if (writeCalls > 1) {
                  return 0;
                }
                const partialLength = Math.max(1, Math.floor(length / 2));
                const { bytesWritten } = await handle.write(
                  buffer,
                  offset,
                  partialLength,
                );
                return bytesWritten;
              },
            },
          }),
        (error: unknown) =>
          error instanceof RolloutValidationError &&
          error.cause instanceof RolloutPersistenceError &&
          error.cause.message.includes("made no progress"),
      );

      assert.equal(writeCalls, 2);
      assert.equal(await readFile(path, "utf8"), before);
      assert.equal(await readFile(externalPath, "utf8"), externalBefore);
      assert.equal(
        (await readdir(layout.sessionsDir)).some((name) => name.includes(".tmp-")),
        false,
      );
    });
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("rejects a successful rollout read when closing its handle fails", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "close-failure.jsonl");
    const before = `${sessionMetaLine("close-failure", "openai")}\n`;
    await writeFile(path, before, "utf8");
    const changes = await collectRolloutChanges(layout, "custom");
    const closeError = new Error("injected rollout close failure");

    await assert.rejects(
      () =>
        applyRolloutChanges(changes, undefined, {
          io: {
            closeHandle: async (handle) => {
              await handle.close();
              throw closeError;
            },
          },
        }),
      (error: unknown) =>
        error instanceof RolloutValidationError && error.cause === closeError,
    );

    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(
      (await readdir(layout.sessionsDir)).some((name) => name.includes(".tmp-")),
      false,
    );
  });
});

test("preserves rollout operation and close failures in an AggregateError", async () => {
  await withLayout(async (layout) => {
    const path = join(layout.sessionsDir, "operation-close-failure.jsonl");
    const before = `${sessionMetaLine("operation-close-failure", "openai")}\n`;
    await writeFile(path, before, "utf8");
    const changes = await collectRolloutChanges(layout, "custom");
    const operationError = new Error("injected rollout operation failure");
    const closeError = new Error("injected rollout close failure");

    await assert.rejects(
      () =>
        applyRolloutChanges(changes, undefined, {
          io: {
            write: async () => {
              throw operationError;
            },
            closeHandle: async (handle) => {
              await handle.close();
              throw closeError;
            },
          },
        }),
      (error: unknown) => {
        const cause = error instanceof RolloutValidationError ? error.cause : undefined;
        return (
          cause instanceof AggregateError &&
          cause.errors.includes(operationError) &&
          cause.errors.includes(closeError)
        );
      },
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
  return messageLineWithText("Keep message", encrypted);
}

function messageLineWithText(text: string, encrypted = false): string {
  return JSON.stringify({
    timestamp: "2026-08-25T00:01:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
    ...(encrypted ? { encrypted_content: "opaque-history" } : {}),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function rolloutOutcome(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return "fulfilled";
  } catch (error: unknown) {
    return error instanceof RolloutValidationError ? error.code : "other-error";
  }
}
