export type ProfileKind = "official" | "custom";

export interface ProfileRecord {
  id: string;
  name: string;
  kind: ProfileKind;
  configFile: string;
  providerId?: string;
  apiKeySecretId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexLayout {
  codexHome: string;
  configPath: string;
  authPath: string;
  sessionsDir: string;
  archivedSessionsDir: string;
  sqlitePath: string;
  switcherDir: string;
}

export interface ExtensionHostStorageUri {
  scheme: string;
  fsPath: string;
  authority?: string;
}

export interface ResolvedExtensionHostStorageLocation {
  uri?: ExtensionHostStorageUri;
  platform: NodeJS.Platform;
  remoteAuthority?: string;
}
