import type * as vscode from "vscode";
import type { ProfileKind, ProfileRecord } from "../core/types";

export interface ProviderTreeDependencies {
  listProfiles(): Promise<readonly ProfileRecord[]>;
  activeProfileId(): Promise<string | undefined>;
}

export interface ProviderTreeNode {
  readonly id: string;
  readonly label: string;
  readonly kind: ProfileKind;
  readonly active: boolean;
  readonly description: string;
  readonly contextValue: string;
  readonly command: {
    readonly command: "codexProvider.openWorkbench";
    readonly title: string;
    readonly arguments: [string];
  };
}

export class ProviderTreeDataProvider implements vscode.TreeDataProvider<ProviderTreeNode> {
  private readonly listeners = new Set<(node: ProviderTreeNode | undefined) => unknown>();

  constructor(private readonly dependencies: ProviderTreeDependencies) {}

  readonly onDidChangeTreeData: vscode.Event<ProviderTreeNode | undefined> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  refresh(): void {
    for (const listener of this.listeners) {
      listener(undefined);
    }
  }

  async getChildren(element?: ProviderTreeNode): Promise<ProviderTreeNode[]> {
    if (element) {
      return [];
    }
    const [profiles, activeProfileId] = await Promise.all([
      this.dependencies.listProfiles(),
      this.dependencies.activeProfileId(),
    ]);
    return profiles.map((profile) => toProviderTreeNode(profile, profile.id === activeProfileId));
  }

  getTreeItem(element: ProviderTreeNode): vscode.TreeItem {
    return {
      id: element.id,
      label: element.label,
      description: element.description,
      contextValue: element.contextValue,
      collapsibleState: 0,
      tooltip: `${element.label} (${element.kind === "official" ? "OpenAI official login" : "Custom configuration"})`,
      command: element.command,
      iconPath: { id: element.active ? "pass-filled" : element.kind === "official" ? "account" : "key" },
    } as unknown as vscode.TreeItem;
  }
}

function toProviderTreeNode(profile: ProfileRecord, active: boolean): ProviderTreeNode {
  return {
    id: profile.id,
    label: profile.name,
    kind: profile.kind,
    active,
    description: active ? "Active" : profile.kind === "official" ? "Official login" : "Custom",
    contextValue: active
      ? `active${profile.kind === "official" ? "Official" : "Custom"}Profile`
      : `${profile.kind}Profile`,
    command: {
      command: "codexProvider.openWorkbench",
      title: "Open Provider",
      arguments: [profile.id],
    },
  };
}
