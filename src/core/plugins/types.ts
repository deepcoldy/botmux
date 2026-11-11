import type { ProtectedHttpEgressPolicy } from '../protected-http-egress.js';

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
  protectedCapability?: string;
  protectedEgressPolicy?: ProtectedHttpEgressPolicy;
}

export interface PluginStreamableHttpMcpServer {
  name: string;
  transport: 'streamable-http';
  url: string;
  headers?: Record<string, string>;
}

export type PluginMcpServer = PluginStdioMcpServer | PluginStreamableHttpMcpServer;

/** Public registry metadata. The executable/URL and credentials live in the
 * plugin-private descriptor referenced here and are never copied into the
 * globally readable plugin registry. */
export interface PluginMcpContribution {
  name: string;
  transport: PluginMcpServer['transport'];
  privateRef: string;
}

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

/** Public, install-time allowlist for card actions handled by a plugin service. */
export interface PluginCardActionsContribution {
  schemaVersion: 1;
  actions?: string[];
  actionPrefixes?: string[];
  endpoint: string;
}

/** One Lark slash command a plugin service handles (`/work-bind`). */
export interface PluginCommandEntry {
  name: string;
  description?: string;
}

/** Public, install-time declaration of Lark slash commands routed to a plugin service. */
export interface PluginCommandsContribution {
  /** Receive a host-authenticated /close notification only after a clean explicit close. */
  afterClose?: true;
  /** This close hook owns classification, replacing the legacy closed-name migration. */
  replacesCloseTag?: true;
  schemaVersion: 1;
  endpoint: string;
  commands: PluginCommandEntry[];
}

export interface PluginContributions {
  skills?: PluginSkillEntry[];
  dashboard?: PluginDashboardEntry[];
  mcp?: PluginMcpContribution;
  cli?: PluginCliContribution;
  service?: PluginServiceContribution;
  cardActions?: PluginCardActionsContribution;
  commands?: PluginCommandsContribution;
}

/** Installation-time scan result before MCP details are moved to private
 * storage. This shape must never be persisted in plugins-registry.json. */
export type ScannedPluginContributions = Omit<PluginContributions, 'mcp'> & {
  mcp?: PluginMcpServer;
};

export interface BotmuxPluginManifest {
  schemaVersion: 1;
  id: string;
  displayName?: string;
  audience?: string;
  dependencies?: {
    plugins?: string[];
  };
  service?: PluginServiceConfig;
}

export interface PluginPackageManifest {
  name: string;
  version: string;
  description?: string;
  type?: string;
  keywords?: string[];
  botmux: BotmuxPluginManifest;
}

export interface InstalledPluginRecord {
  id: string;
  packageName: string;
  version: string;
  description?: string;
  integrity?: string;
  source: {
    type: 'npm' | 'local';
    spec: string;
    link?: boolean;
  };
  manifest: BotmuxPluginManifest;
  contributions?: PluginContributions;
  installedAt: string;
  updatedAt: string;
}

export interface PluginRegistryFile {
  schemaVersion: 1;
  plugins: Record<string, InstalledPluginRecord>;
  /** Monotonic per-file mutation counter, bumped on every atomic rewrite.
   *  Stat-based identity (inode/mtime) is not safe on ext4: back-to-back
   *  rewrites of equal-size content reuse the inode and land inside the same
   *  timestamp tick, so an install/uninstall A→B→A looked unchanged. */
  revision?: number;
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
  cardActions?: PluginCardActionsContribution;
  commands?: PluginCommandsContribution;
}
