import assert from "node:assert/strict";
import test from "node:test";
import { ProviderTreeDataProvider } from "../../src/ui/provider-tree";
import type { ProfileRecord } from "../../src/core/types";

test("maps Providers to compact tree items with active and kind context", async () => {
  const profiles: ProfileRecord[] = [
    profile("openai", "OpenAI", "official"),
    profile("proxy", "Research Proxy", "custom"),
  ];
  const tree = new ProviderTreeDataProvider({
    listProfiles: async () => profiles,
    activeProfileId: async () => "proxy",
  });

  const children = await tree.getChildren();
  assert.deepEqual(children.map((node) => ({
    id: node.id,
    label: node.label,
    description: node.description,
    contextValue: node.contextValue,
  })), [
    { id: "openai", label: "OpenAI", description: "Official login", contextValue: "officialProfile" },
    { id: "proxy", label: "Research Proxy", description: "Active", contextValue: "activeCustomProfile" },
  ]);
  assert.equal(tree.getTreeItem(children[1]).command?.command, "codexProvider.openWorkbench");
});

function profile(id: string, name: string, kind: "official" | "custom"): ProfileRecord {
  return {
    id,
    name,
    kind,
    configFile: `/profiles/${id}/config.toml`,
    providerId: kind === "official" ? "openai" : id,
    apiKeySecretId: kind === "custom" ? `secret.${id}` : undefined,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}
