import * as vscode from "vscode";
import { registerExtensionLifecycle } from "./activation";

export function activate(context: vscode.ExtensionContext): void {
  registerExtensionLifecycle(context, vscode);
}
