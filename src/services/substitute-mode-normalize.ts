import type { SubstituteModeConfig, SubstituteTarget } from '../bot-registry.js';

/**
 * Pure normalizer for a raw substituteMode object (from bots.json OR a dashboard
 * PUT body) into a `SubstituteModeConfig`. Shared by `bot-registry` (load path)
 * and `substitute-mode-store` (write path) so the two never drift.
 *
 * Rules:
 *  - Each target keeps openId / userId / unionId / email / name; a target with
 *    none of those is dropped.
 *  - `email` rides along as a label but never matches at runtime (mentions carry
 *    openId/userId/unionId, not email) — it is resolved to an openId at save
 *    time by `resolveSubstituteTargets`, so a persisted email-only target only
 *    happens for an entry that failed resolution.
 *  - ENABLING requires at least one matchable id (openId/userId/unionId);
 *    otherwise the ON state would be silently dead → return undefined so the
 *    caller can reject it.
 *  - A DISABLED config still persists its target list (as long as it has ≥1
 *    target), so the dashboard toggle can flip on/off without re-entering
 *    everyone. Only an empty disabled config collapses to undefined (delete).
 */
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
  if (targets.length === 0) return undefined;
  const enabled = rec.enabled === true;
  const hasMatchableTarget = targets.some(t => t.openId || t.userId || t.unionId);
  // Enabling with no matchable id is a dead ON state — reject (undefined).
  if (enabled && !hasMatchableTarget) return undefined;
  return {
    enabled,
    targets,
    disclosure: rec.disclosure === 'none' ? 'none' : 'prefix',
  };
}
