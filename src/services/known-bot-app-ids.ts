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
 * By default every source is best-effort: a sandboxed CLI cannot read bots.json
 * (denied → treated as absent) and may not list descriptors; its own app id still
 * comes from the environment. `strict` is for destructive callers (the worktree
 * reclaim inventory): an unreadable source throws instead of narrowing the set.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listOnlineDaemons } from '../utils/daemon-discovery.js';

export function defaultBotsJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.BOTS_CONFIG || join(homedir(), '.botmux', 'bots.json');
}

function configuredBotAppIds(botsJsonPath: string, strict: boolean): string[] {
  let raw: string;
  try {
    raw = readFileSync(botsJsonPath, 'utf-8');
  } catch (err) {
    if (strict) throw new Error(`cannot read bots.json at ${botsJsonPath}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    if (strict) throw new Error(`bots.json at ${botsJsonPath} is not valid JSON`);
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { bots?: unknown } | null)?.bots;
  if (!Array.isArray(list)) {
    if (strict) throw new Error(`bots.json at ${botsJsonPath} has no bot list`);
    return [];
  }
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
  /** Throw instead of degrading when bots.json or the daemon registry cannot be
   *  read. For a caller whose decision is destructive, "could not tell which
   *  bots exist" must not quietly narrow into "that bot no longer exists". */
  strict?: boolean;
}): Set<string> {
  const env = opts.env ?? process.env;
  const strict = opts.strict === true;
  const known = new Set<string>();
  if (env.BOTMUX_LARK_APP_ID) known.add(env.BOTMUX_LARK_APP_ID);
  for (const id of configuredBotAppIds(opts.botsJsonPath ?? defaultBotsJsonPath(env), strict)) known.add(id);
  try {
    for (const daemon of listOnlineDaemons(opts.dataDir, { strict })) known.add(daemon.larkAppId);
  } catch (err) {
    if (strict) throw err;
    /* unreadable registry → nothing to add */
  }
  return known;
}
