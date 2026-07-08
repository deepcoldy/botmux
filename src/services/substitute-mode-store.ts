import { getBot, type SubstituteModeConfig, type SubstituteTarget } from '../bot-registry.js';
import { rmwBotEntry } from './config-store.js';

export function normalizeSubstituteMode(raw: unknown): SubstituteModeConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const targets = Array.isArray(rec.targets)
    ? rec.targets.flatMap((item): SubstituteTarget[] => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const src = item as Record<string, unknown>;
        const target: SubstituteTarget = {};
        if (typeof src.openId === 'string' && src.openId.trim()) target.openId = src.openId.trim();
        if (typeof src.userId === 'string' && src.userId.trim()) target.userId = src.userId.trim();
        if (typeof src.unionId === 'string' && src.unionId.trim()) target.unionId = src.unionId.trim();
        if (typeof src.email === 'string' && src.email.trim()) target.email = src.email.trim();
        if (typeof src.name === 'string' && src.name.trim()) target.name = src.name.trim();
        return target.openId || target.userId || target.unionId || target.email ? [target] : [];
      })
    : [];
  if (rec.enabled !== true || targets.length === 0) return undefined;
  return {
    enabled: true,
    targets,
    disclosure: rec.disclosure === 'none' ? 'none' : 'prefix',
  };
}

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
