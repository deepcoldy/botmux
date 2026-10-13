/**
 * Per-bot file-sandbox toggle persistence. Mirrors brand-store: cross-process
 * file lock + atomic bots.json write + in-memory registry sync, so the daemon
 * picks up the change without a restart (the next session spawn reads
 * `botCfg.sandbox` in forkWorker). Pure opt-in; absent = off (legacy behaviour).
 */
import { rmwBotEntry } from './config-store.js';
import { getBot } from '../bot-registry.js';
import { logger } from '../utils/logger.js';
import {
  normalizeSandboxMode,
  normalizeScratchStorage,
  type SandboxMode,
} from '../adapters/cli/sandbox-mode.js';

/** Current configured sandbox mode for a bot. */
export function getBotSandboxMode(larkAppId: string): SandboxMode {
  try { return normalizeSandboxMode(getBot(larkAppId).config.sandbox); } catch { return 'off'; }
}

/** Back-compat boolean view (oncall/scratch both count as sandboxed). */
export function getBotSandbox(larkAppId: string): boolean {
  return getBotSandboxMode(larkAppId) !== 'off';
}

/** Persist the tri-state sandbox selection (+ scratch sub-options) for a bot.
 *  Atomic bots.json write + in-memory sync, next new session生效. Writing
 *  'off' omits the key (absent = off, the historical contract). */
export async function updateBotSandboxMode(
  larkAppId: string,
  mode: SandboxMode,
  scratch?: { storage?: 'tmpfs' | 'disk'; tmpfsSizeMb?: number; denyPaths?: string[] },
): Promise<{ ok: true; sandbox: SandboxMode } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const storage = normalizeScratchStorage(scratch?.storage);
  const tmpfsSizeMb = typeof scratch?.tmpfsSizeMb === 'number'
    && Number.isFinite(scratch.tmpfsSizeMb) && scratch.tmpfsSizeMb > 0
    ? Math.floor(scratch.tmpfsSizeMb)
    : undefined;
  const denyPaths = Array.isArray(scratch?.denyPaths)
    ? [...new Set(scratch!.denyPaths.filter((p): p is string => typeof p === 'string' && !!p.trim()).map(p => p.trim()))]
    : undefined;

  const r = await rmwBotEntry<SandboxMode>(larkAppId, (entry) => {
    if (mode === 'off') {
      delete entry.sandbox;
    } else {
      entry.sandbox = mode;
    }
    if (mode === 'scratch') {
      entry.scratchStorage = storage;
      if (tmpfsSizeMb) entry.scratchTmpfsSizeMb = tmpfsSizeMb;
      else delete entry.scratchTmpfsSizeMb;
      if (denyPaths?.length) entry.scratchDenyPaths = denyPaths;
      else delete entry.scratchDenyPaths;
    } else {
      delete entry.scratchStorage;
      delete entry.scratchTmpfsSizeMb;
      delete entry.scratchDenyPaths;
    }
    return { write: true, result: mode };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  const cfg = bot.config;
  if (mode === 'off') delete cfg.sandbox;
  else cfg.sandbox = mode;
  if (mode === 'scratch') {
    cfg.scratchStorage = storage;
    if (tmpfsSizeMb) cfg.scratchTmpfsSizeMb = tmpfsSizeMb;
    else delete cfg.scratchTmpfsSizeMb;
    if (denyPaths?.length) cfg.scratchDenyPaths = denyPaths;
    else delete cfg.scratchDenyPaths;
  } else {
    delete cfg.scratchStorage;
    delete cfg.scratchTmpfsSizeMb;
    delete cfg.scratchDenyPaths;
  }
  logger.info(`[sandbox:${larkAppId}] sandbox mode → ${mode}`);
  return { ok: true, sandbox: mode };
}

/** Back-compat boolean toggle (used by the old dashboard route). */
export async function updateBotSandbox(
  larkAppId: string,
  enabled: boolean,
): Promise<{ ok: true; sandbox: boolean } | { ok: false; reason: string }> {
  const r = await updateBotSandboxMode(larkAppId, enabled ? 'oncall' : 'off');
  return r.ok ? { ok: true, sandbox: r.sandbox !== 'off' } : r;
}

/** Current configured read-isolation flag for a bot. */
export function getBotReadIsolation(larkAppId: string): boolean {
  try { return getBot(larkAppId).config.readIsolation === true; } catch { return false; }
}

/** Publish only the daemon's live spawn view (in-memory `botCfg.readIsolation`)
 * without touching bots.json. Split out from {@link persistBotReadIsolation} so
 * a future fence-then-publish caller can order the durable write and the
 * worker-admission view independently — e.g. to close the window where a cold
 * refork consumes a transient value while bots.json is rolled back after a
 * Codex App ownership conflict. No caller stages the two halves yet;
 * {@link updateBotReadIsolation} composes them in the usual persist→publish
 * order, so today this only ever runs after a successful persist. */
export function setBotReadIsolationRuntime(larkAppId: string, enabled: boolean): void {
  try {
    const cfg = getBot(larkAppId).config;
    if (enabled) cfg.readIsolation = true;
    else delete cfg.readIsolation;
  } catch { /* the preceding successful update already proves this in production */ }
}

/** Persist the desired flag to bots.json without publishing it to the live
 * worker-admission view yet (see {@link setBotReadIsolationRuntime} for that
 * half). Split from {@link updateBotReadIsolation} so a future caller can fence
 * old generations between the durable write and the spawn-view publish; no
 * caller stages the two halves today, so this runs as the first step of the
 * composed {@link updateBotReadIsolation}. */
export async function persistBotReadIsolation(
  larkAppId: string,
  enabled: boolean,
): Promise<{ ok: true; readIsolation: boolean } | { ok: false; reason: string }> {
  try { getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const r = await rmwBotEntry<boolean>(larkAppId, (entry) => {
    if (enabled) entry.readIsolation = true;
    else delete entry.readIsolation;
    return { write: true, result: enabled };
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, readIsolation: enabled };
}

/** Per-bot read-isolation toggle (macOS Seatbelt read-deny). Same persistence
 *  contract as {@link updateBotSandbox}: atomic bots.json write + in-memory sync,
 *  so the next session spawn reads `botCfg.readIsolation` without a daemon restart. */
export async function updateBotReadIsolation(
  larkAppId: string,
  enabled: boolean,
): Promise<{ ok: true; readIsolation: boolean } | { ok: false; reason: string }> {
  const r = await persistBotReadIsolation(larkAppId, enabled);
  if (!r.ok) return { ok: false, reason: r.reason };
  setBotReadIsolationRuntime(larkAppId, enabled);
  logger.info(`[read-isolation:${larkAppId}] readIsolation → ${enabled}`);
  return { ok: true, readIsolation: enabled };
}

/** The three-tier sandbox path lists a bot may declare (highest-precedence
 *  layer of the FsPolicy). Empty/absent tiers fall back to deny-by-default. */
export interface SandboxPathTiers {
  readWrite?: string[];
  readOnly?: string[];
  deny?: string[];
}

/** Current configured sandboxPaths for a bot (undefined = none set). */
export function getBotSandboxPaths(larkAppId: string): SandboxPathTiers | undefined {
  try { return getBot(larkAppId).config.sandboxPaths; } catch { return undefined; }
}

/** Trim + drop empties + dedupe one tier's path list. Returns undefined for an
 *  empty result so an all-empty tiers object collapses to "no sandboxPaths". */
function normalizeTier(list: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const p = raw.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.length ? out : undefined;
}

/** Normalize a three-tier sandboxPaths object for storage: per-tier trim/dedup,
 *  then CROSS-TIER dedup resolving a path listed in >1 tier to the MORE
 *  RESTRICTIVE tier (deny > readOnly > readWrite) — matching fs-policy's
 *  mergeFsRules same-source tie-break, so what's stored matches what the sandbox
 *  (and the dashboard UI/tester) resolve. Returns `{}` when every tier is empty
 *  (caller treats that as "clear the field"). Pure — unit-tested directly. */
export function normalizeSandboxPaths(tiers: SandboxPathTiers): SandboxPathTiers {
  const rw = normalizeTier(tiers.readWrite);
  const ro = normalizeTier(tiers.readOnly);
  const deny = normalizeTier(tiers.deny);
  const normPath = (p: string) => p.replace(/\/+$/, '') || '/';
  const denySet = new Set((deny ?? []).map(normPath));
  const roSet = new Set((ro ?? []).map(normPath));
  const keptRw = (rw ?? []).filter(p => !denySet.has(normPath(p)) && !roSet.has(normPath(p)));
  const keptRo = (ro ?? []).filter(p => !denySet.has(normPath(p)));
  const out: SandboxPathTiers = {};
  if (keptRw.length) out.readWrite = keptRw;
  if (keptRo.length) out.readOnly = keptRo;
  if (deny) out.deny = deny;
  return out;
}

/** Per-bot sandboxPaths (readWrite/readOnly/deny) persistence. Same contract as
 *  {@link updateBotSandbox}: atomic bots.json write + in-memory sync, so the next
 *  session spawn reads `botCfg.sandboxPaths` without a daemon restart. Passing an
 *  all-empty tiers object CLEARS the field (bots.json stays clean → pure
 *  deny-by-default baseline). */
export async function updateBotSandboxPaths(
  larkAppId: string,
  tiers: SandboxPathTiers,
): Promise<{ ok: true; sandboxPaths?: SandboxPathTiers } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const normalized = normalizeSandboxPaths(tiers);
  const isEmpty = !normalized.readWrite && !normalized.readOnly && !normalized.deny;

  const r = await rmwBotEntry<SandboxPathTiers | undefined>(larkAppId, (entry) => {
    if (isEmpty) delete entry.sandboxPaths;   // clear → preserves deny-by-default baseline
    else entry.sandboxPaths = normalized;
    return { write: true, result: isEmpty ? undefined : normalized };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  if (isEmpty) delete bot.config.sandboxPaths;
  else bot.config.sandboxPaths = normalized;
  logger.info(`[sandbox:${larkAppId}] sandboxPaths → rw=${normalized.readWrite?.length ?? 0} ro=${normalized.readOnly?.length ?? 0} deny=${normalized.deny?.length ?? 0}`);
  return { ok: true, sandboxPaths: isEmpty ? undefined : normalized };
}
