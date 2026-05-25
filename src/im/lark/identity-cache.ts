/**
 * User / bot identity cache for prompt injection.
 *
 * Lark events only carry the sender's open_id (no name). To inject a
 * `<sender name="张三" ... />` tag into the CLI prompt we need a name → open_id
 * dictionary. Three population sources, ordered by cost:
 *
 *   1. mentions — free. Lark mention payloads carry (name, open_id) pairs,
 *      so every @ that flows through us teaches the cache.
 *   2. sender — free, but only learns open_id + type, not name.
 *   3. contact API — `contact.v3.user.get` for users; only used as fallback
 *      when 1+2 didn't give us a name. Requires `contact:user.base:readonly`
 *      (already in `BOTMUX_REQUIRED_SCOPES`).
 *
 * Scope: per Lark app. Open_id values are app-scoped on Lark's side, so the
 * cache file follows the same `identities-${larkAppId}.json` shape as the
 * existing `bot-openids-${larkAppId}.json`. The two files are deliberately
 * kept separate: bot-openids doubles as a "trusted botmux peer" routing
 * signal, and merging would entangle that with the display-name dictionary.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getBotClient } from '../../bot-registry.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { larkGet } from './client.js';

export type IdentityType = 'user' | 'bot' | 'app' | 'unknown';

export interface IdentityRecord {
  openId: string;
  type: IdentityType;
  name?: string;
  source: 'sender' | 'mention' | 'contact_api' | 'bot_cross_ref' | 'bot_info';
  updatedAt: number;
}

const stores = new Map<string, Map<string, IdentityRecord>>();
const inflight = new Map<string, Promise<void>>();
const scopeUnavailable = new Set<string>();
const dirty = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;

const FLUSH_DEBOUNCE_MS = 2_000;
const RESOLVE_BUDGET_MS = 800;

function cacheFile(larkAppId: string): string {
  return join(config.session.dataDir, `identities-${larkAppId}.json`);
}

function getStore(larkAppId: string): Map<string, IdentityRecord> {
  let store = stores.get(larkAppId);
  if (store) return store;
  store = new Map();
  stores.set(larkAppId, store);
  try {
    const fp = cacheFile(larkAppId);
    if (existsSync(fp)) {
      const data: IdentityRecord[] = JSON.parse(readFileSync(fp, 'utf-8'));
      let n = 0;
      for (const rec of data) {
        if (rec?.openId) {
          store.set(rec.openId, rec);
          n++;
        }
      }
      if (n > 0) logger.info(`[identity] hydrated ${n} records for ${larkAppId} from ${fp}`);
    }
  } catch (err: any) {
    logger.warn(`[identity] failed to hydrate ${larkAppId}: ${err?.message ?? err}`);
  }
  return store;
}

function schedulePersist(larkAppId: string): void {
  dirty.add(larkAppId);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAll();
  }, FLUSH_DEBOUNCE_MS);
}

function flushAll(): void {
  const appIds = [...dirty];
  dirty.clear();
  for (const appId of appIds) {
    const store = stores.get(appId);
    if (!store) continue;
    try {
      const fp = cacheFile(appId);
      mkdirSync(dirname(fp), { recursive: true });
      const tmp = `${fp}.tmp`;
      writeFileSync(tmp, JSON.stringify([...store.values()], null, 2) + '\n');
      renameSync(tmp, fp);
    } catch (err: any) {
      logger.warn(`[identity] flush ${appId} failed: ${err?.message ?? err}`);
    }
  }
}

/** Best-effort flush on shutdown — pairs with the debounce above. */
export function flushIdentityCacheSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushAll();
}

/**
 * Merge a partial identity record into the cache. Existing `name` is preserved
 * unless the incoming record carries a real name (no clobbering). Existing
 * `type` is only overridden when the incoming value is more specific
 * (anything other than `unknown`).
 */
export function recordIdentity(
  larkAppId: string,
  rec: { openId: string; type?: IdentityType; name?: string; source?: IdentityRecord['source'] },
): void {
  if (!rec.openId) return;
  const store = getStore(larkAppId);
  const existing = store.get(rec.openId);
  const incomingType = rec.type && rec.type !== 'unknown' ? rec.type : undefined;
  const merged: IdentityRecord = {
    openId: rec.openId,
    type: incomingType ?? existing?.type ?? 'unknown',
    name: rec.name ?? existing?.name,
    source: rec.source ?? existing?.source ?? 'sender',
    updatedAt: Date.now(),
  };
  // Skip persist when nothing meaningful changed — avoids disk churn from
  // every sender event re-bumping updatedAt.
  if (existing && existing.type === merged.type && existing.name === merged.name) {
    return;
  }
  store.set(rec.openId, merged);
  schedulePersist(larkAppId);
}

/**
 * Learn (open_id, name) pairs from a parsed message's mentions. Free path —
 * no API call. Mentions don't carry sender_type, so we leave `type` as
 * `unknown` and let a subsequent sender event (or bot cross-ref lookup) tighten
 * it.
 */
export function learnFromMentions(
  larkAppId: string,
  mentions?: Array<{ name: string; openId?: string }>,
): void {
  if (!mentions || mentions.length === 0) return;
  for (const m of mentions) {
    if (!m.openId || !m.name) continue;
    recordIdentity(larkAppId, { openId: m.openId, name: m.name, source: 'mention' });
  }
}

export function getIdentity(larkAppId: string, openId: string): IdentityRecord | undefined {
  return getStore(larkAppId).get(openId);
}

/**
 * Best-effort name resolution. Returns the cached name on hit; on miss for a
 * user open_id, calls `contact.v3.user.get` with a budget and updates the
 * cache. Bots/apps skip the API (no public contact endpoint). Failures
 * (permission denied, network, timeout) degrade silently to `undefined`.
 *
 * When the bot lacks `contact:user.base:readonly`, the first 99991672 from
 * the API trips a per-app circuit breaker so subsequent calls short-circuit
 * without burning quota.
 */
export async function resolveName(larkAppId: string, openId: string): Promise<string | undefined> {
  if (!openId) return undefined;
  const cached = getIdentity(larkAppId, openId);
  if (cached?.name) return cached.name;
  if (cached?.type === 'bot' || cached?.type === 'app') return undefined;
  if (scopeUnavailable.has(larkAppId)) return undefined;

  const key = `${larkAppId}:${openId}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchUserName(larkAppId, openId);
    inflight.set(key, pending);
    // Identity-guarded cleanup. A request that times out is evicted by the
    // catch below; if its underlying fetch later settles, we must NOT clobber
    // whatever inflight entry now lives there — that entry belongs to a
    // newer caller. Comparing by reference catches both this race and the
    // simple "settled normally" case.
    //
    // `.then(cleanup, cleanup)` (not `.finally`) so a future fetchUserName
    // refactor that rejects can't leave the returned cleanup promise as an
    // unhandled rejection. Current fetchUserName swallows everything to
    // logger.debug, but that's an undocumented invariant we shouldn't rely on.
    const local = pending;
    const cleanup = () => { if (inflight.get(key) === local) inflight.delete(key); };
    void local.then(cleanup, cleanup);
  }

  try {
    await withTimeout(pending, RESOLVE_BUDGET_MS);
  } catch {
    // withTimeout rejected → either the budget elapsed or the underlying
    // request errored. If the Lark SDK call hangs forever (no built-in
    // request timeout) the cleanup wired via local.then(...) above never
    // fires, and every subsequent caller would re-wait the full budget.
    // Evict here so the next caller starts a fresh attempt. Same identity
    // guard: only evict if the entry still IS our promise — otherwise we'd
    // race-clobber a newer caller's entry that arrived between our await
    // rejection and this line.
    if (inflight.get(key) === pending) inflight.delete(key);
  }
  return getIdentity(larkAppId, openId)?.name;
}

async function fetchUserName(larkAppId: string, openId: string): Promise<void> {
  try {
    const c = getBotClient(larkAppId);
    const res = await larkGet(c, `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`, {
      user_id_type: 'open_id',
    });
    if (res?.code === 0) {
      const name: string | undefined = res.data?.user?.name;
      if (name) {
        recordIdentity(larkAppId, { openId, name, type: 'user', source: 'contact_api' });
      }
      return;
    }
    // 99991672 = app身份缺权限 (contact:user.base:readonly 没开)
    if (res?.code === 99991672) {
      if (!scopeUnavailable.has(larkAppId)) {
        scopeUnavailable.add(larkAppId);
        logger.warn(
          `[identity] [${larkAppId}] contact:user.base:readonly 未开通，sender name 解析将降级到 open_id (code=99991672)`,
        );
      }
      return;
    }
    logger.debug(
      `[identity] contact.user.get(${openId.substring(0, 12)}) code=${res?.code} msg=${res?.msg ?? ''}`,
    );
  } catch (err: any) {
    logger.debug(
      `[identity] contact.user.get(${openId.substring(0, 12)}) failed: ${err?.message ?? err}`,
    );
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('identity-resolve-timeout')), ms);
    p.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); },
    );
  });
}

export interface ResolvedSender {
  openId: string;
  type: 'user' | 'bot';
  name?: string;
}

/**
 * Resolve sender identity for prompt injection.
 *
 * Inputs are taken directly from the Lark event (`sender_id.open_id`,
 * `sender_type` ∈ {user, app, bot}). We normalize Lark's `app`/`bot` to our
 * prompt vocabulary (`bot`), record the sender event in the cache for future
 * lookups, and best-effort resolve the display name. Caller-supplied hints
 * (e.g. a known foreign-bot display name from `bot-openids-${appId}.json`)
 * win over cache.
 */
export async function resolveSender(
  larkAppId: string,
  openId: string | undefined,
  senderType: string | undefined,
  hint?: { name?: string; type?: 'user' | 'bot' },
): Promise<ResolvedSender | undefined> {
  if (!openId) return undefined;

  let type: 'user' | 'bot';
  if (hint?.type) {
    type = hint.type;
  } else if (senderType === 'app' || senderType === 'bot') {
    type = 'bot';
  } else {
    type = 'user';
  }

  recordIdentity(larkAppId, { openId, type, source: 'sender' });

  let name = hint?.name ?? getIdentity(larkAppId, openId)?.name;
  if (!name && type === 'user') {
    name = await resolveName(larkAppId, openId);
  }
  return { openId, type, name };
}
