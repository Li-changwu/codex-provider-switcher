import * as vscode from "vscode";
import { homedir } from "node:os";
import { activateExtensionWithStartupPrerequisites } from "./activation";
import { createStartupProfilePrerequisites } from "./core/startup";

export {
  createStartupProfilePrerequisites,
  type StartupProfilePrerequisites,
} from "./core/startup";

export function activate(context: vscode.ExtensionContext): void {
  activateExtensionWithStartupPrerequisites(
    context,
    {
      env: process.env,
      platform: process.platform,
      homeDir: homedir(),
      remoteName: vscode.env.remoteName,
    },
    vscode,
    createStartupProfilePrerequisites,
  );
}
