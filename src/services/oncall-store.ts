/**
 * Oncall bindings — persist chat_id → default workingDir into the bot config
 * JSON file, and keep the in-memory BotConfig in sync so events pick up
 * changes without a daemon restart.
 *
 * Permission model is intentionally simple: anyone in the bot's allowedUsers
 * can bind/unbind/edit (enforced at the call sites — daemon command handler
 * + dashboard token gate). No per-chat owner list.
 *
 * Multi-process safety: 12 daemon processes + 1 dashboard process all share
 * a single `bots.json`. Every write path goes through `withFileLock(path)`
 * so a burst of concurrent auto-binds (each daemon sees a new chat for its
 * own bot at roughly the same time) doesn't lose updates via read-modify-
 * write race. The lock is also re-acquired around the read so the modify
 * step always works against the latest on-disk snapshot.
 */
import { promises as fsp } from 'node:fs';
import { readFileSync } from 'node:fs';
import { getBot, getLoadedConfigPath, type BotDefaultOncall, type OncallChat } from '../bot-registry.js';
import { withFileLock } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';

async function readRawConfig(path: string): Promise<any[]> {
  const raw = JSON.parse(await fsp.readFile(path, 'utf-8'));
  if (!Array.isArray(raw)) throw new Error(`Config file is not a JSON array: ${path}`);
  return raw;
}

async function writeRawConfigAtomic(path: string, raw: any[]): Promise<void> {
  const tmp = path + '.tmp.' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
  await fsp.rename(tmp, path);
}

function findEntryIndex(raw: any[], larkAppId: string): number {
  return raw.findIndex((e: any) => e?.larkAppId === larkAppId);
}

function requireConfigPath(): string {
  const p = getLoadedConfigPath();
  if (!p) throw new Error('Bot config path unknown — cannot persist oncall bindings');
  return p;
}

/**
 * Run a read-modify-write critical section against the bot config file under
 * a cross-process lock. `mutate` runs against the freshest on-disk snapshot
 * and decides what to write back; returning `undefined` means "no write".
 */
async function rmwBotEntry<T>(
  larkAppId: string,
  mutate: (entry: any, raw: any[]) => { write: boolean; result: T } | T,
): Promise<{ ok: true; result: T } | { ok: false; reason: string }> {
  const path = requireConfigPath();
  return withFileLock(path, async () => {
    const raw = await readRawConfig(path);
    const idx = findEntryIndex(raw, larkAppId);
    if (idx < 0) return { ok: false, reason: 'bot_not_in_config' };
    const entry = raw[idx];
    const out = mutate(entry, raw);
    if (out && typeof out === 'object' && 'write' in (out as any)) {
      const wrap = out as { write: boolean; result: T };
      if (wrap.write) await writeRawConfigAtomic(path, raw);
      return { ok: true, result: wrap.result };
    }
    await writeRawConfigAtomic(path, raw);
    return { ok: true, result: out as T };
  });
}

// ─── Manual binding ───────────────────────────────────────────────────────

/**
 * Upsert an oncall binding. Returns whether it was newly created.
 */
export async function bindOncall(
  larkAppId: string,
  chatId: string,
  workingDir: string,
): Promise<{ ok: true; entry: OncallChat; created: boolean } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const next: OncallChat = { chatId, workingDir };

  const r = await rmwBotEntry<{ created: boolean }>(larkAppId, (entry) => {
    const cur: any[] = Array.isArray(entry.oncallChats) ? entry.oncallChats : [];
    const curIdx = cur.findIndex((c: any) => c?.chatId === chatId);
    const created = curIdx < 0;
    if (created) cur.push(next);
    else cur[curIdx] = next; // wholesale replace strips legacy keys
    entry.oncallChats = cur;
    return { write: true, result: { created } };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  // Keep in-memory config in sync
  const inMem = (bot.config.oncallChats ??= []);
  const memIdx = inMem.findIndex(c => c.chatId === chatId);
  if (memIdx >= 0) inMem[memIdx] = next; else inMem.push(next);

  logger.info(`[oncall:${larkAppId}] bind chat=${chatId} dir=${workingDir}`);
  return { ok: true, entry: next, created: r.result.created };
}

/**
 * Unbind oncall for `chatId` and ALWAYS write a tombstone into
 * `defaultOncallAutoboundChats`. The tombstone protects against the case
 * where a user manually fiddled with a chat (bound then unbound, or just
 * unbound) and we then mis-classify it as "new" on the next observation
 * and re-auto-bind. Treating unbind as "default's one shot is spent" is
 * symmetric with auto-bind already adding to the same list.
 *
 * Idempotent: never errors on "not bound". `wasBound` reports whether an
 * existing binding was actually removed so callers can phrase UI text
 * accordingly (the Lark `/oncall unbind` command still wants to say "未绑定"
 * vs "已解绑").
 */
export async function unbindOncall(
  larkAppId: string,
  chatId: string,
): Promise<{ ok: true; wasBound: boolean } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const r = await rmwBotEntry<{ wasBound: boolean }>(larkAppId, (entry) => {
    const cur: OncallChat[] = Array.isArray(entry.oncallChats) ? entry.oncallChats : [];
    const wasBound = cur.some(c => c?.chatId === chatId);
    entry.oncallChats = cur.filter((c: OncallChat) => c?.chatId !== chatId);

    const tomb: string[] = Array.isArray(entry.defaultOncallAutoboundChats)
      ? entry.defaultOncallAutoboundChats : [];
    if (!tomb.includes(chatId)) tomb.push(chatId);
    entry.defaultOncallAutoboundChats = tomb;

    return { write: true, result: { wasBound } };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  if (bot.config.oncallChats) {
    bot.config.oncallChats = bot.config.oncallChats.filter(c => c.chatId !== chatId);
  }
  const inMemTomb = (bot.config.defaultOncallAutoboundChats ??= []);
  if (!inMemTomb.includes(chatId)) inMemTomb.push(chatId);

  logger.info(`[oncall:${larkAppId}] unbind chat=${chatId} wasBound=${r.result.wasBound} (tombstoned)`);
  return { ok: true, wasBound: r.result.wasBound };
}

export function getOncallStatus(larkAppId: string, chatId: string): OncallChat | undefined {
  // Defensive: dashboard callers may probe with an app id whose bot isn't
  // registered yet (boot races, or tests exercising the IPC layer without
  // a full registry). Treat "no such bot" as "no oncall binding" — this
  // is best-effort enrichment, not a critical path.
  let bot;
  try { bot = getBot(larkAppId); } catch { return undefined; }
  return bot.config.oncallChats?.find(c => c.chatId === chatId);
}

// ─── Per-bot defaultOncall ───────────────────────────────────────────────

/** Read the current defaultOncall config + autobound list for a bot. Used by
 *  the dashboard GET route and by the daemon's auto-bind judge. Sync because
 *  it only reads the in-memory snapshot — file-level consistency comes from
 *  the daemon never racing with itself on reads. */
export function getBotDefaultOncall(larkAppId: string): {
  defaultOncall: BotDefaultOncall | undefined;
  autoboundChats: string[];
} {
  let bot;
  try { bot = getBot(larkAppId); } catch {
    return { defaultOncall: undefined, autoboundChats: [] };
  }
  return {
    defaultOncall: bot.config.defaultOncall,
    autoboundChats: [...(bot.config.defaultOncallAutoboundChats ?? [])],
  };
}

/**
 * Persist a defaultOncall change for the given bot. The dashboard PUT route
 * is the only authorized caller — `since` is server-side authoritative so the
 * frontend can't backdate the cut-off and accidentally include existing chats.
 *
 * `since` is stamped on every enabled save, not just the first transition.
 * This matches the dashboard copy/requirement and prevents a later workingDir
 * edit from reaching chats that were first observed before that edit.
 *
 * When disabled with an empty `workingDir`, the prior workingDir is preserved
 * so the UI can round-trip (toggle off → toggle back on) without forcing the
 * user to retype the path. Disable with a non-empty workingDir overwrites.
 */
export async function updateBotDefaultOncall(
  larkAppId: string,
  patch: { enabled: boolean; workingDir: string },
): Promise<{ ok: true; defaultOncall: BotDefaultOncall } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  let next: BotDefaultOncall | null = null;
  const r = await rmwBotEntry<BotDefaultOncall>(larkAppId, (entry) => {
    const prior: BotDefaultOncall | undefined = entry.defaultOncall;
    // Cut-off line: every enabled save re-stamps so a workingDir edit while
    // enabled doesn't reach back to chats observed under the old setting.
    const nextSince = patch.enabled ? Date.now() : (prior?.since ?? 0);
    const trimmed = (patch.workingDir ?? '').trim();
    const resolvedWorkingDir = patch.enabled
      ? trimmed
      // Disabled + empty input → keep the prior path so the toggle is round-
      // trippable. Disabled + explicit non-empty → user is replacing it.
      : (trimmed || prior?.workingDir || '');
    next = {
      enabled: !!patch.enabled,
      workingDir: resolvedWorkingDir,
      since: nextSince,
    };
    entry.defaultOncall = next;
    return { write: true, result: next };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  bot.config.defaultOncall = next!;
  logger.info(
    `[oncall:${larkAppId}] defaultOncall ${next!.enabled ? 'enabled' : 'disabled'} ` +
    `(workingDir=${next!.workingDir || '∅'}, since=${next!.since})`,
  );
  return { ok: true, defaultOncall: next! };
}

/**
 * Auto-bind a chat as part of the defaultOncall flow. Atomically:
 *   1. RE-CHECK tombstone + existing binding against the freshest on-disk
 *      snapshot. The daemon's fast-path tombstone check is informational —
 *      if a concurrent `unbindOncall` wrote a tombstone between then and
 *      now, the lock-internal view sees it and we skip.
 *   2. Upsert the oncallChats entry (same shape as manual bindOncall).
 *   3. Append chatId to defaultOncallAutoboundChats (idempotent).
 *
 * Returns `skipped: 'tombstoned'` when the lock-internal tombstone check
 * trips, `skipped: 'already_bound'` when another writer (manual bind by
 * the user, or a sibling daemon) bound the chat between the fast-path read
 * and the lock acquisition. Neither is an error.
 */
export async function autoBindOncallFromDefault(
  larkAppId: string,
  chatId: string,
  workingDir: string,
): Promise<
  | { ok: true; entry: OncallChat; created: boolean; skipped?: undefined }
  | { ok: true; skipped: 'tombstoned' | 'already_bound'; entry?: undefined; created?: undefined }
  | { ok: false; reason: string }
> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const next: OncallChat = { chatId, workingDir };

  type Result =
    | { kind: 'bound'; created: boolean }
    | { kind: 'skipped'; reason: 'tombstoned' | 'already_bound' };

  const r = await rmwBotEntry<Result>(larkAppId, (entry) => {
    // Authoritative re-check #1: tombstone wins. If a concurrent unbind or
    // earlier autoBind wrote one, the user has effectively opted out — never
    // overwrite that decision from the auto-bind path.
    const tomb: string[] = Array.isArray(entry.defaultOncallAutoboundChats)
      ? entry.defaultOncallAutoboundChats : [];
    if (tomb.includes(chatId)) {
      return { write: false, result: { kind: 'skipped', reason: 'tombstoned' } };
    }
    // Authoritative re-check #2: existing binding wins. Could be from
    // a sibling daemon, a manual /oncall bind, or a dashboard PUT racing
    // with us. We never overwrite an existing binding with the default —
    // the user's explicit choice (or a sibling's earlier auto-bind to its
    // own default) is authoritative.
    const cur: any[] = Array.isArray(entry.oncallChats) ? entry.oncallChats : [];
    if (cur.some(c => c?.chatId === chatId)) {
      return { write: false, result: { kind: 'skipped', reason: 'already_bound' } };
    }

    cur.push(next);
    entry.oncallChats = cur;
    tomb.push(chatId);
    entry.defaultOncallAutoboundChats = tomb;
    return { write: true, result: { kind: 'bound', created: true } };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  if (r.result.kind === 'skipped') {
    return { ok: true, skipped: r.result.reason };
  }

  // Sync in-memory
  const inMem = (bot.config.oncallChats ??= []);
  const memIdx = inMem.findIndex(c => c.chatId === chatId);
  if (memIdx >= 0) inMem[memIdx] = next; else inMem.push(next);
  const inMemAutobound = (bot.config.defaultOncallAutoboundChats ??= []);
  if (!inMemAutobound.includes(chatId)) inMemAutobound.push(chatId);

  logger.info(`[oncall:${larkAppId}] auto-bind (default) chat=${chatId} dir=${workingDir}`);
  return { ok: true, entry: next, created: r.result.created };
}

// Test helper — read raw bots.json synchronously. Not for production use.
export function _readRawConfigSyncForTesting(path: string): any[] {
  return JSON.parse(readFileSync(path, 'utf-8'));
}
