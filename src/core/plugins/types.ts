export type PluginRuntime = 'cli' | 'daemon' | 'worker' | 'dashboard' | 'service';
export type PluginHook = Exclude<PluginRuntime, 'service'> | 'adapters';
export type PluginServiceMode = 'manual' | 'lifecycle';

export interface PluginDashboardEntry {
  id: string;
  route: string;
  entry: string;
}

export interface PluginSkillEntry {
  path: string;
}

export interface PluginMcpServer {
  name: string;
  transport?: 'stdio';
  command: string[];
  env?: Record<string, string>;
}

export interface PluginServiceConfig {
  mode: PluginServiceMode;
}

export interface BotmuxPluginManifest {
  schemaVersion: 1;
  id: string;
  displayName?: string;
  main?: string;
  hooks?: PluginHook[];
  capabilities?: string[];
  dependencies?: {
    plugins?: Record<string, string>;
  };
  skills?: PluginSkillEntry[];
  dashboard?: PluginDashboardEntry[];
  service?: PluginServiceConfig;
  mcp?: PluginMcpServer[];
}

export interface PluginPackageManifest {
  name: string;
  version: string;
  type?: string;
  keywords?: string[];
  peerDependencies?: Record<string, string>;
  botmux: BotmuxPluginManifest;
}

export interface InstalledPluginRecord {
  id: string;
  packageName: string;
  version: string;
  integrity?: string;
  source: {
    type: 'npm' | 'local';
    spec: string;
  };
  manifest: BotmuxPluginManifest;
  installedAt: string;
  updatedAt: string;
}

export interface PluginRegistryFile {
  schemaVersion: 1;
  plugins: Record<string, InstalledPluginRecord>;
}

export interface PluginSettingsFile {
  schemaVersion: 1;
  defaults: Record<string, unknown>;
  bots: Record<string, Record<string, unknown>>;
}

export interface PluginServiceState {
  pluginId: string;
  version?: string;
  currentDir?: string;
  currentRealpath?: string;
  updatedAt: string;
  status?: string;
  pid?: number;
  port?: number;
  openUrl?: string;
  healthUrl?: string;
  [key: string]: unknown;
}
