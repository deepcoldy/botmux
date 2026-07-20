import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { assertValidPluginId } from '../ids.js';
import {
  pluginHome,
  pluginMcpPrivatePath,
  pluginPrivateDir,
} from '../paths.js';
import type {
  PluginMcpContribution,
  PluginMcpServer,
} from '../types.js';

export const PLUGIN_MCP_PRIVATE_REF = 'private/mcp.json';

interface PluginMcpPrivateFile {
  schemaVersion: 1;
  pluginId: string;
  server: PluginMcpServer;
}

export interface PluginMcpPrivateSnapshot {
  existed: boolean;
  content?: Buffer;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every(item => typeof item === 'string');
}

export function isPluginMcpServer(value: unknown): value is PluginMcpServer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const server = value as Record<string, unknown>;
  if (typeof server.name !== 'string' || !server.name) return false;
  if (server.transport === 'stdio') {
    return Array.isArray(server.command)
      && server.command.length > 0
      && server.command.every(part => typeof part === 'string' && part.length > 0)
      && (server.env === undefined || isStringRecord(server.env));
  }
  if (server.transport === 'streamable-http') {
    if (typeof server.url !== 'string' || !server.url) return false;
    try {
      const protocol = new URL(server.url).protocol;
      if (protocol !== 'http:' && protocol !== 'https:') return false;
    } catch {
      return false;
    }
    return server.headers === undefined || isStringRecord(server.headers);
  }
  return false;
}

export function isPluginMcpContribution(value: unknown): value is PluginMcpContribution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.name === 'string'
    && !!entry.name
    && (entry.transport === 'stdio' || entry.transport === 'streamable-http')
    && entry.privateRef === PLUGIN_MCP_PRIVATE_REF;
}

export function publicPluginMcpContribution(server: PluginMcpServer): PluginMcpContribution {
  return {
    name: server.name,
    transport: server.transport,
    privateRef: PLUGIN_MCP_PRIVATE_REF,
  };
}

function assertPrivateStorageLayout(pluginId: string, create: boolean): void {
  const id = assertValidPluginId(pluginId);
  const home = pluginHome(id);
  if (existsSync(home)) {
    const stat = lstatSync(home);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe_plugin_home:${id}`);
  } else if (create) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }

  const dir = pluginPrivateDir(id);
  if (existsSync(dir)) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe_plugin_private_dir:${id}`);
    chmodSync(dir, 0o700);
  } else if (create) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  const file = pluginMcpPrivatePath(id);
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe_plugin_mcp_private_file:${id}`);
  }
}

export function capturePluginMcpPrivateSnapshot(pluginId: string): PluginMcpPrivateSnapshot {
  assertPrivateStorageLayout(pluginId, false);
  const file = pluginMcpPrivatePath(pluginId);
  if (!existsSync(file)) return { existed: false };
  return { existed: true, content: readFileSync(file) };
}

export function restorePluginMcpPrivateSnapshot(
  pluginId: string,
  snapshot: PluginMcpPrivateSnapshot,
): void {
  const file = pluginMcpPrivatePath(pluginId);
  if (snapshot.existed) {
    assertPrivateStorageLayout(pluginId, true);
    atomicWriteFileSync(file, snapshot.content ?? Buffer.alloc(0), { mode: 0o600 });
    return;
  }
  rmSync(file, { force: true });
  const dir = pluginPrivateDir(pluginId);
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  } catch {
    // The directory may not have existed before the attempted migration.
  }
}

export function writePluginMcpDescriptor(
  pluginId: string,
  server: PluginMcpServer,
): PluginMcpContribution {
  const id = assertValidPluginId(pluginId);
  if (!isPluginMcpServer(server) || server.name !== id) {
    throw new Error(`invalid_plugin_mcp_private_descriptor:${id}`);
  }
  assertPrivateStorageLayout(id, true);
  const value: PluginMcpPrivateFile = { schemaVersion: 1, pluginId: id, server };
  atomicWriteFileSync(
    pluginMcpPrivatePath(id),
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
  return publicPluginMcpContribution(server);
}

export function removePluginMcpDescriptor(pluginId: string): void {
  assertPrivateStorageLayout(pluginId, false);
  rmSync(pluginMcpPrivatePath(pluginId), { force: true });
  const dir = pluginPrivateDir(pluginId);
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  } catch {
    // No private directory is a valid state for a plugin without MCP.
  }
}

export function readPluginMcpDescriptor(
  pluginId: string,
  contribution: PluginMcpContribution,
): PluginMcpServer {
  const id = assertValidPluginId(pluginId);
  if (!isPluginMcpContribution(contribution)) {
    throw new Error(`invalid_plugin_mcp_private_ref:${id}`);
  }
  assertPrivateStorageLayout(id, false);
  const file = pluginMcpPrivatePath(id);
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) throw new Error(`invalid_plugin_mcp_private_file:${id}`);
    const parsed = JSON.parse(readFileSync(fd, 'utf8')) as Partial<PluginMcpPrivateFile>;
    if (
      parsed.schemaVersion !== 1
      || parsed.pluginId !== id
      || !isPluginMcpServer(parsed.server)
      || parsed.server.name !== contribution.name
      || parsed.server.transport !== contribution.transport
    ) throw new Error(`invalid_plugin_mcp_private_descriptor:${id}`);
    return parsed.server;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`plugin_mcp_private_descriptor_missing:${id}`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
