import * as vscode from "vscode";
import { homedir } from "node:os";
import { registerExtensionLifecycle } from "./activation";
import { resolveCodexLayout } from "./core/codex-home";
import { ProfileStore } from "./core/profiles";
import type { CodexLayout } from "./core/types";

export interface StartupProfilePrerequisites {
  layout: CodexLayout;
  profiles: ProfileStore;
}

export function activate(context: vscode.ExtensionContext): void {
  void createStartupProfilePrerequisites(context);
  registerExtensionLifecycle(context, vscode);
}

export function createStartupProfilePrerequisites(
  context: Pick<vscode.ExtensionContext, "globalStorageUri">,
): StartupProfilePrerequisites {
  const layout = resolveCodexLayout({
    env: process.env,
    platform: process.platform,
    homeDir: homedir(),
    extensionStorageUri: context.globalStorageUri,
  });
  return { layout, profiles: new ProfileStore(layout) };
}
