/**
 * Which app ids count as "a bot on this machine" for the unmigrated probe.
 *
 * A leftover `sessions-<appId>.json` without a `.db` means "that bot's daemon
 * has not migrated yet" only while the bot still exists: configured in
 * bots.json, currently advertising a descriptor, or the bot this process runs
 * under. Files left behind by bots removed from bots.json are abandoned data,
 * not a pending upgrade — no daemon will ever import them — so they must not
 * trigger the "restart the daemon" hint.
 *
 * Every source is best-effort: a sandboxed CLI cannot read bots.json (denied
 * → treated as absent) and may not list descriptors; its own app id still
 * comes from the environment.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listOnlineDaemons } from '../utils/daemon-discovery.js';

export function defaultBotsJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.BOTS_CONFIG || join(homedir(), '.botmux', 'bots.json');
}

function configuredBotAppIds(botsJsonPath: string): string[] {
  let raw: string;
  try {
    if (!existsSync(botsJsonPath)) return [];
    raw = readFileSync(botsJsonPath, 'utf-8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const list = Array.isArray(parsed) ? parsed : (parsed as { bots?: unknown } | null)?.bots;
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const entry of list) {
    const bot = (entry ?? {}) as { larkAppId?: unknown; appId?: unknown };
    const id = typeof bot.larkAppId === 'string' && bot.larkAppId
      ? bot.larkAppId
      : typeof bot.appId === 'string' && bot.appId ? bot.appId : undefined;
    if (id) ids.push(id);
  }
  return ids;
}

export function knownBotAppIds(opts: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  botsJsonPath?: string;
}): Set<string> {
  const env = opts.env ?? process.env;
  const known = new Set<string>();
  if (env.BOTMUX_LARK_APP_ID) known.add(env.BOTMUX_LARK_APP_ID);
  for (const id of configuredBotAppIds(opts.botsJsonPath ?? defaultBotsJsonPath(env))) known.add(id);
  try {
    for (const daemon of listOnlineDaemons(opts.dataDir)) known.add(daemon.larkAppId);
  } catch { /* unreadable registry → nothing to add */ }
  return known;
}
