import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { config } from '../../../config.js';
import { readPluginRegistry } from '../../../services/plugin-registry-store.js';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { pluginMcpPrivatePath, pluginRuntimeDir } from '../paths.js';
import { sessionPluginManifestPath } from '../session-manifest.js';
import type { PluginMcpServer } from '../types.js';
import { isPluginMcpServer, readPluginMcpDescriptor } from './private-store.js';

export interface SessionMcpRuntimeEntry {
  pluginId: string;
  pluginDir: string;
  server: PluginMcpServer;
}

export interface SessionMcpRuntimeManifest {
  schemaVersion: 1;
  sessionId: string;
  pluginIds: string[];
  generatedAt: string;
  entries: SessionMcpRuntimeEntry[];
}

export function sessionMcpRuntimeManifestPath(
  sessionId: string,
  dataDir: string = config.session.dataDir,
): string {
  return join(dirname(sessionPluginManifestPath(sessionId, dataDir)), 'plugin-mcp-runtime.json');
}

export function readSessionMcpRuntimeManifest(
  sessionId: string,
  dataDir: string = config.session.dataDir,
): SessionMcpRuntimeManifest | null {
  const path = sessionMcpRuntimeManifestPath(sessionId, dataDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionMcpRuntimeManifest>;
    if (
      parsed.schemaVersion !== 1
      || parsed.sessionId !== sessionId
      || !Array.isArray(parsed.pluginIds)
      || !parsed.pluginIds.every(id => typeof id === 'string')
      || !Array.isArray(parsed.entries)
    ) return null;
    const enabled = new Set(parsed.pluginIds);
    if (!parsed.entries.every((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const value = entry as Partial<SessionMcpRuntimeEntry>;
      return typeof value.pluginId === 'string'
        && enabled.has(value.pluginId)
        && typeof value.pluginDir === 'string'
        && isAbsolute(value.pluginDir)
        && isPluginMcpServer(value.server);
    })) return null;
    return parsed as SessionMcpRuntimeManifest;
  } catch {
    return null;
  }
}

export function refreshSessionMcpRuntimeManifest(opts: {
  sessionId: string;
  pluginIds: readonly string[];
  dataDir?: string;
  now?: () => string;
}): SessionMcpRuntimeManifest {
  const registry = readPluginRegistry();
  const pluginIds = [...opts.pluginIds];
  const entries: SessionMcpRuntimeEntry[] = [];
  for (const pluginId of pluginIds) {
    const contribution = registry.plugins[pluginId]?.contributions?.mcp;
    if (!contribution) continue;
    const server = readPluginMcpDescriptor(pluginId, contribution);
    entries.push({ pluginId, pluginDir: pluginRuntimeDir(pluginId), server });
  }
  const manifest: SessionMcpRuntimeManifest = {
    schemaVersion: 1,
    sessionId: opts.sessionId,
    pluginIds,
    generatedAt: opts.now ? opts.now() : new Date().toISOString(),
    entries,
  };
  const path = sessionMcpRuntimeManifestPath(opts.sessionId, opts.dataDir);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

/** Credential-bearing paths consumed only by the trusted Gateway host. They
 * must never become CLI sandbox read carve-outs. */
export function sessionMcpRuntimeHostOnlyPaths(
  manifest: SessionMcpRuntimeManifest,
  dataDir: string = config.session.dataDir,
): string[] {
  return [...new Set([
    sessionMcpRuntimeManifestPath(manifest.sessionId, dataDir),
    ...manifest.entries.flatMap(entry => [
      pluginMcpPrivatePath(entry.pluginId),
      join(entry.pluginDir, 'mcp', 'index.json'),
    ]),
  ])];
}
