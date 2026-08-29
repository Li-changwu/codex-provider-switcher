import type { CodexLayout } from "./types";

export interface OfficialLoginResult {
  readonly loginExitCode: number | undefined;
  readonly statusExitCode: number | undefined;
  readonly cancelled?: boolean;
}

export interface OfficialLoginExecutor {
  run(layout: CodexLayout, signal?: AbortSignal): Promise<OfficialLoginResult>;
}

export function assertSuccessfulOfficialLogin(result: OfficialLoginResult): void {
  if (
    result.cancelled === true ||
    result.loginExitCode !== 0 ||
    result.statusExitCode !== 0
  ) {
    throw new Error("The official Codex login could not be verified.");
  }
}
