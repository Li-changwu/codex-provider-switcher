import * as vscode from "vscode";
import { homedir } from "node:os";
import { registerExtensionLifecycle } from "./activation";
import { createStartupProfilePrerequisites } from "./core/startup";

export {
  createStartupProfilePrerequisites,
  type StartupProfilePrerequisites,
} from "./core/startup";

export function activate(context: vscode.ExtensionContext): void {
  void createStartupProfilePrerequisites(context, {
    env: process.env,
    platform: process.platform,
    homeDir: homedir(),
    remoteAuthority: vscode.env.remoteName,
  });
  registerExtensionLifecycle(context, vscode);
}
