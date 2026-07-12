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
  const normalized = normalizeSubstituteMode(raw);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const enabled = (raw as Record<string, unknown>).enabled;
    const targets = (raw as Record<string, unknown>).targets;
    if (enabled === true && (!Array.isArray(targets) || targets.length === 0 || !normalized)) {
      return { ok: false, reason: 'targets_required' };
    }
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
}

/** Injected Lark resolvers (real impls live in `im/lark/client`; tests mock). */
export interface SubstituteResolveDeps {
  /** Resolve a mixed list of `ou_*` / `on_*` / email strings → open_ids, with a
   *  `raw → open_id` map (matches `resolveAllowedUsersWithMap`). */
  resolveRaw: (larkAppId: string, raw: string[]) => Promise<{ resolved: string[]; map: Map<string, string> }>;
  /** open_id → display name (+ avatar). Returns null when unknown. */
  getProfile: (larkAppId: string, openId: string) => Promise<{ name: string; avatarUrl?: string } | null>;
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
  if (rawList.length) {
    try { ({ map } = await deps.resolveRaw(larkAppId, rawList)); }
    catch { map = new Map(); }
  }

  const targets: SubstituteTarget[] = [];
  const resolution: SubstituteTargetResolution[] = [];
  const seen = new Set<string>();

  for (const { t, raw } of inputs) {
    if (!raw) continue;
    const openId = map.get(raw) ?? (t.openId && map.has(t.openId) ? map.get(t.openId) : undefined);

    if (openId) {
      let name = t.name;
      let avatarUrl: string | undefined;
      try {
        const p = await deps.getProfile(larkAppId, openId);
        if (p?.name) { name = p.name; avatarUrl = p.avatarUrl; }
      } catch { /* keep the caller-supplied name */ }
      resolution.push({ input: raw, ok: true, openId, name, avatarUrl });
      if (seen.has(openId)) continue; // dedupe duplicate people, keep both chips
      seen.add(openId);
      const out: SubstituteTarget = { openId };
      if (name) out.name = name;
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
      resolution.push({ input: raw, ok: false });
    }
  }

  return { targets, resolution };
}
