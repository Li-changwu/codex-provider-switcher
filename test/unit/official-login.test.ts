import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSuccessfulOfficialLogin,
  type OfficialLoginExecutor,
} from "../../src/core/official-login";
import type { CodexLayout } from "../../src/core/types";

const layout: CodexLayout = {
  codexHome: "C:/codex",
  configPath: "C:/codex/config.toml",
  authPath: "C:/codex/auth.json",
  sessionsDir: "C:/codex/sessions",
  archivedSessionsDir: "C:/codex/archived_sessions",
  sqlitePath: "C:/codex/state_5.sqlite",
  switcherDir: "C:/codex/provider-switcher",
};

test("accepts only a successful login and status result", () => {
  assert.doesNotThrow(() => assertSuccessfulOfficialLogin({
    loginExitCode: 0,
    statusExitCode: 0,
  }));
});

test("rejects an unknown or non-zero native login result without exposing credentials", () => {
  for (const result of [
    { loginExitCode: undefined, statusExitCode: 0 },
    { loginExitCode: 0, statusExitCode: 1 },
    { loginExitCode: 0, statusExitCode: 0, cancelled: true },
  ]) {
    assert.throws(
      () => assertSuccessfulOfficialLogin(result),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /official Codex login could not be verified/i);
        assert.doesNotMatch(error.message, /oauth|api[_ -]?key|token/i);
        return true;
      },
    );
  }
});

test("supports an executor that receives the Codex layout and cancellation signal", async () => {
  const controller = new AbortController();
  let receivedLayout: CodexLayout | undefined;
  let receivedSignal: AbortSignal | undefined;
  const executor: OfficialLoginExecutor = {
    run: async (received, signal) => {
      receivedLayout = received;
      receivedSignal = signal;
      return { loginExitCode: 0, statusExitCode: 0 };
    },
  };

  const result = await executor.run(layout, controller.signal);

  assert.deepEqual(receivedLayout, layout);
  assert.equal(receivedSignal, controller.signal);
  assert.deepEqual(result, { loginExitCode: 0, statusExitCode: 0 });
});
