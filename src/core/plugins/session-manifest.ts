import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import type { BotConfig } from '../../bot-registry.js';
import type { GlobalConfig } from '../../global-config.js';
import { resolveEffectivePluginIds } from './effective.js';

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SessionPluginManifest {
  schemaVersion: 1;
  sessionId: string;
  botId?: string;
  source: 'bot' | 'machine-default';
  pluginIds: string[];
  generatedAt: string;
}

function assertSafeSessionId(sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new Error('invalid_plugin_session_id');
  }
  return sessionId;
}

export function sessionPluginManifestPath(
  sessionId: string,
  dataDir: string = config.session.dataDir,
): string {
  return join(dataDir, 'sessions', assertSafeSessionId(sessionId), 'plugin-manifest.json');
}

export function readSessionPluginManifest(
  sessionId: string,
  dataDir: string = config.session.dataDir,
): SessionPluginManifest | null {
  const path = sessionPluginManifestPath(sessionId, dataDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SessionPluginManifest>;
    if (parsed.schemaVersion !== 1 || parsed.sessionId !== sessionId || !Array.isArray(parsed.pluginIds)) return null;
    if (!parsed.pluginIds.every(id => typeof id === 'string')) return null;
    return parsed as SessionPluginManifest;
  } catch {
    return null;
  }
}

export function writeSessionPluginManifest(
  manifest: SessionPluginManifest,
  dataDir: string = config.session.dataDir,
): void {
  const path = sessionPluginManifestPath(manifest.sessionId, dataDir);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

export interface SessionPluginManifestOptions {
  sessionId: string;
  bot: Pick<BotConfig, 'larkAppId' | 'name' | 'plugins'>;
  global?: Pick<GlobalConfig, 'plugins'>;
  dataDir?: string;
  now?: () => string;
}

function buildSessionPluginManifest(opts: SessionPluginManifestOptions): SessionPluginManifest {
  const manifest: SessionPluginManifest = {
    schemaVersion: 1,
    sessionId: opts.sessionId,
    botId: opts.bot.name?.trim() || opts.bot.larkAppId,
    source: opts.bot.plugins === undefined ? 'machine-default' : 'bot',
    pluginIds: resolveEffectivePluginIds(opts.bot, opts.global),
    generatedAt: opts.now ? opts.now() : new Date().toISOString(),
  };
  return manifest;
}

/** Recompute the plugin set for a newly spawned CLI process generation. */
export function refreshSessionPluginManifest(opts: SessionPluginManifestOptions): SessionPluginManifest {
  const manifest = buildSessionPluginManifest(opts);
  writeSessionPluginManifest(manifest, opts.dataDir);
  return manifest;
}

/** Keep the current CLI generation stable when a worker only reattaches to it. */
export function ensureSessionPluginManifest(opts: SessionPluginManifestOptions): SessionPluginManifest {
  return readSessionPluginManifest(opts.sessionId, opts.dataDir) ?? refreshSessionPluginManifest(opts);
}
