/** 卡片授权默认限制：任一条件先到即失效。 */
export const DEFAULT_GRANT_DURATION_MS = 60 * 60 * 1000;
export const DEFAULT_GRANT_QUOTA = 3;
/** 卡片消息额度自由输入的上限。卡片 normalize 与初值夹取共用此常量，避免历史
 *  `messageQuota.defaultLimit`（parser 无上限）超过它时生成一张无法提交的坏卡。 */
export const MAX_GRANT_QUOTA = 1000;

/** 把任意来源的额度（含历史无上限的 defaultLimit）夹到卡片可提交区间 [1, MAX]。
 *  undefined（不限）原样透传。用于构卡初值，保证卡片 normalize 一定认得这个初值。 */
export function clampGrantQuotaForCard(quota: number | undefined): number | undefined {
  if (quota === undefined) return undefined;
  if (!Number.isFinite(quota) || quota <= 0) return undefined;
  return Math.min(Math.floor(quota), MAX_GRANT_QUOTA);
}

export const GRANT_DURATION_OPTIONS = [
  60 * 60 * 1000,
  8 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
] as const;

export type GrantDurationMs = (typeof GRANT_DURATION_OPTIONS)[number];

/** Dashboard/config 只允许卡片本身支持的四个有限时长。 */
export function isGrantDurationOption(raw: unknown): raw is GrantDurationMs {
  return typeof raw === 'number'
    && GRANT_DURATION_OPTIONS.includes(raw as GrantDurationMs);
}

export function normalizeGrantDurationOption(raw: unknown): number | undefined | null {
  if (raw === 'permanent') return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return GRANT_DURATION_OPTIONS.includes(value as (typeof GRANT_DURATION_OPTIONS)[number])
    ? value
    : null;
}

export function normalizeGrantQuotaOption(raw: unknown): number | undefined | null {
  if (raw === 'unlimited' || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_GRANT_QUOTA ? value : null;
}
