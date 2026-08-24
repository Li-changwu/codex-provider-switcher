import { resolveCodexLayout, type ResolveCodexLayoutOptions } from "./codex-home";
import { ProfileStore } from "./profiles";
import { SecretStore, type SecretStorageLike } from "./secrets";
import type { CodexLayout, ExtensionHostStorageUri } from "./types";

export interface StartupExtensionContext {
  globalStorageUri: ExtensionHostStorageUri;
  secrets: SecretStorageLike;
}

export interface StartupHostInputs
  extends Omit<ResolveCodexLayoutOptions, "extensionStorageUri"> {
  remoteAuthority?: string;
}

export interface StartupProfilePrerequisites {
  layout: CodexLayout;
  profiles: ProfileStore;
  secrets: SecretStore;
}

export function createStartupProfilePrerequisites(
  context: StartupExtensionContext,
  host: StartupHostInputs,
): StartupProfilePrerequisites {
  const layout = resolveCodexLayout({
    ...host,
    extensionStorageUri: context.globalStorageUri,
  });
  return {
    layout,
    profiles: new ProfileStore(layout),
    secrets: new SecretStore(context.secrets, {
      uri: context.globalStorageUri,
      platform: host.platform,
      remoteAuthority: host.remoteAuthority,
    }),
  };
}
