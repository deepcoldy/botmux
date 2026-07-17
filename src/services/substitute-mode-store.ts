import { getBot, type SubstituteModeConfig, type SubstituteTarget } from '../bot-registry.js';
import { rmwBotEntry } from './config-store.js';
import { normalizeSubstituteMode } from './substitute-mode-normalize.js';

export { normalizeSubstituteMode };

export function getBotSubstituteMode(larkAppId: string): SubstituteModeConfig | undefined {
  try {
    return getBot(larkAppId).config.substituteMode;
  } catch {
    return undefined;
  }
}

export async function updateBotSubstituteMode(
  larkAppId: string,
  raw: unknown,
): Promise<{ ok: true; substituteMode: SubstituteModeConfig | null } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const rec = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const chats = Array.isArray(rec.chats)
    ? [...new Set(rec.chats.map(String).map(s => s.trim()).filter(Boolean))]
    : [];
  const normalized = normalizeSubstituteMode({ ...rec, chats: chats.length ? chats : undefined });
  if (rec.enabled === true && (!Array.isArray(rec.targets) || rec.targets.length === 0 || !normalized)) {
    return { ok: false, reason: 'targets_required' };
  }

  const r = await rmwBotEntry<SubstituteModeConfig | null>(larkAppId, (entry) => {
    if (normalized) entry.substituteMode = normalized;
    else delete entry.substituteMode;
    return { write: true, result: normalized ?? null };
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  bot.config.substituteMode = r.result ?? undefined;
  return { ok: true, substituteMode: r.result };
}

// ── target resolution (email / union_id → open_id + display name) ────────────

/** A single line's resolution outcome, surfaced back to the dashboard so the UI
 *  can render ✓ name / ✗ input chips. */
export interface SubstituteTargetResolution {
  /** What the user typed (email / ou_ / on_ / u_ — trimmed). */
  input: string;
  ok: boolean;
  openId?: string;
  name?: string;
  avatarUrl?: string;
  /** Machine-readable failure reason when ok=false. */
  reason?: 'cross_app_open_id' | 'not_visible' | 'resolve_failed' | 'unresolvable';
}

/** Injected Lark resolvers (real impls live in `im/lark/client`; tests mock). */
export interface SubstituteResolveDeps {
  /** Resolve a mixed list of `ou_*` / `on_*` / email strings → open_ids, with a
   *  `raw → open_id` map (matches `resolveAllowedUsersWithMap`). `errored`
   *  reports a transient failure during resolution (real impl swallows API
   *  errors internally, so a thrown rejection alone can't signal this). */
  resolveRaw: (larkAppId: string, raw: string[]) => Promise<{ resolved: string[]; map: Map<string, string>; errored?: boolean }>;
  /** open_id → profile lookup with per-cause definitive/transient distinction
   *  (matches `getUserProfileStrict`): 'cross_app' = belongs to another app;
   *  'not_visible' = outside this app's contact visibility scope; 'invalid_id'
   *  = no such user / malformed; 'error' = transient, retry may succeed. */
  getProfile: (larkAppId: string, openId: string) => Promise<
    | { status: 'ok'; profile: { name: string; avatarUrl?: string } }
    | { status: 'cross_app' }
    | { status: 'not_visible' }
    | { status: 'invalid_id' }
    | { status: 'error' }
  >;
}

type RawTarget = { openId?: string; userId?: string; unionId?: string; email?: string; name?: string };

/**
 * Resolve dashboard-submitted targets into runtime-matchable ones: every
 * email / union_id gets turned into an app-scoped open_id (bounded by the bot's
 * 通讯录可见范围) and every resolved person gets a fresh display name. Entries that
 * can't be resolved are dropped from the stored targets but reported back with
 * `ok:false` so the UI can flag them.
 *
 * A tenant `userId` (no openId) can't be resolved to a name here, so it is
 * passed through untouched (rare hand-authored / back-compat path).
 */
export async function resolveSubstituteTargets(
  larkAppId: string,
  rawTargets: unknown,
  deps: SubstituteResolveDeps,
): Promise<{ targets: SubstituteTarget[]; resolution: SubstituteTargetResolution[] }> {
  const list: RawTarget[] = Array.isArray(rawTargets)
    ? rawTargets.filter((t): t is RawTarget => !!t && typeof t === 'object' && !Array.isArray(t))
    : [];

  // The single identifier we resolve per target, preferring the most stable id.
  const inputs = list.map(t => ({
    t,
    raw: String(t.openId ?? t.unionId ?? t.email ?? t.userId ?? '').trim(),
  }));

  const rawList = inputs.map(i => i.raw).filter(Boolean);
  let map = new Map<string, string>();
  let resolveErrored = false;
  if (rawList.length) {
    try {
      const r = await deps.resolveRaw(larkAppId, rawList);
      map = r.map;
      resolveErrored = r.errored === true;
    } catch { resolveErrored = true; map = new Map(); }
  }

  const targets: SubstituteTarget[] = [];
  const resolution: SubstituteTargetResolution[] = [];
  const seen = new Set<string>();

  for (const { t, raw } of inputs) {
    if (!raw) continue;
    const isRawOpenId = !!t.openId;
    const openId = map.get(raw) ?? (t.openId && map.has(t.openId) ? map.get(t.openId) : undefined);

    if (openId) {
      let name = t.name;
      let avatarUrl: string | undefined;
      // Per-cause lookup: definitive failures keep their reason (跨应用 ≠
      // 通讯录不可见 ≠ 无效 id)，'error' is transient (network / rate limit)
      // and must not masquerade as any definitive cause or the user gets told
      // to discard a perfectly valid target.
      const lookup = await deps.getProfile(larkAppId, openId)
        .catch(() => ({ status: 'error' as const }));
      if (lookup.status === 'ok' && lookup.profile.name) {
        name = lookup.profile.name;
        avatarUrl = lookup.profile.avatarUrl;
      } else if (isRawOpenId) {
        // A hand-typed open_id must be reachable by this app to be matchable at
        // runtime. Email/union_id resolved open_ids are already app-scoped, so a
        // failed profile lookup is not fatal for them.
        const reason = lookup.status === 'cross_app' ? 'cross_app_open_id'
          : lookup.status === 'not_visible' ? 'not_visible'
          : lookup.status === 'invalid_id' ? 'unresolvable'
          : 'resolve_failed';
        resolution.push({ input: raw, ok: false, reason });
        continue;
      }
      resolution.push({ input: raw, ok: true, openId, name, avatarUrl });
      if (seen.has(openId)) continue; // dedupe duplicate people, keep both chips
      seen.add(openId);
      const out: SubstituteTarget = { openId };
      if (name) out.name = name;
      if (avatarUrl) out.avatarUrl = avatarUrl;
      if (t.email) out.email = t.email;
      targets.push(out);
    } else if (t.userId) {
      // tenant user_id passthrough — not resolvable to a name here.
      resolution.push({ input: raw, ok: true, name: t.name });
      const out: SubstituteTarget = { userId: t.userId };
      if (t.name) out.name = t.name;
      if (t.email) out.email = t.email;
      targets.push(out);
    } else {
      resolution.push({ input: raw, ok: false, reason: resolveErrored ? 'resolve_failed' : 'unresolvable' });
    }
  }

  return { targets, resolution };
}
