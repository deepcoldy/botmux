export type PluginRuntime = 'cli' | 'service';
export type PluginServiceMode = 'manual' | 'auto';

export interface PluginDashboardEntry {
  id: string;
  route: string;
  entry: string;
}

export interface PluginSkillEntry {
  name?: string;
  path: string;
}

export interface PluginStdioMcpServer {
  name: string;
  transport: 'stdio';
  command: string[];
  env?: Record<string, string>;
}

export interface PluginStreamableHttpMcpServer {
  name: string;
  transport: 'streamable-http';
  url: string;
  headers?: Record<string, string>;
}

export type PluginMcpServer = PluginStdioMcpServer | PluginStreamableHttpMcpServer;

export interface PluginServiceConfig {
  mode: PluginServiceMode;
}

export interface PluginRuntimeEntrypoint {
  entry: string;
}

export interface PluginCliCommandIndexEntry {
  name: string;
  description?: string;
}

export interface PluginCliContribution extends PluginRuntimeEntrypoint {
  commandsPath: string;
  commands: PluginCliCommandIndexEntry[];
}

export interface PluginServiceContribution extends PluginRuntimeEntrypoint {
  mode: PluginServiceMode;
}

export interface PluginContributions {
  skills?: PluginSkillEntry[];
  dashboard?: PluginDashboardEntry[];
  mcp?: PluginMcpServer;
  cli?: PluginCliContribution;
  service?: PluginServiceContribution;
}

export interface BotmuxPluginManifest {
  schemaVersion: 1;
  id: string;
  displayName?: string;
  dependencies?: {
    plugins?: string[];
  };
  service?: PluginServiceConfig;
}

export interface PluginPackageManifest {
  name: string;
  version: string;
  type?: string;
  keywords?: string[];
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
  contributions?: PluginContributions;
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
  runtimeDir?: string;
  runtimeRealpath?: string;
  updatedAt: string;
  status?: string;
  pid?: number;
  port?: number;
  openUrl?: string;
  healthUrl?: string;
  [key: string]: unknown;
}

export interface PluginMaterializedFile {
  schemaVersion: 1;
  pluginId: string;
  updatedAt: string;
  skills?: Array<{ name: string; path: string }>;
  mcp?: Array<{ cliId: string; name: string; path: string }>;
  cli?: Array<{ name: string }>;
  dashboard?: Array<{ id: string; entry: string }>;
  service?: Array<{ name: string }>;
}
