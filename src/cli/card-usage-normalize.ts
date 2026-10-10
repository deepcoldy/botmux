/**
 * card-usage-normalize.ts — `botmux send` 从 daemon IPC `/api/sessions/:id/usage`
 * 读回的用量快照的白名单式规范化。
 *
 * 白名单而非透传：IPC 响应来自 daemon 进程（可信），但版本可能不一致（旧 daemon /
 * 新 CLI 或反之），逐字段校验后 CLI 侧的卡片渲染永远不会拿到 NaN / 负数 / 字符串。
 * 每个字段独立判定，不合法就丢弃该字段而不是整份快照。
 *
 * 独立成模块（不放 cli.ts）：cli.ts 顶层就是命令分发 switch，测试无法直接 import。
 */
import type { CardUsageSnapshot } from '../im/lark/md-card.js';
import type { StatuslineQuota } from '../services/statusline-snapshot.js';

function nonNegativeFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** 0–100 的百分比；越界 / 非数值 ⇒ undefined。 */
function percentField(v: unknown): number | undefined {
  return nonNegativeFinite(v) && v <= 100 ? v : undefined;
}

/** 正毫秒时间戳；`<= 0` / 非数值 ⇒ undefined。 */
function resetsAtField(v: unknown): number | undefined {
  return nonNegativeFinite(v) && v > 0 ? v : undefined;
}

/** statusline 配额段（ctx / 5h / 7d）。一个字段都没通过 ⇒ undefined（调用方不带 key）。 */
export function normalizeCardUsageQuota(value: unknown): StatuslineQuota | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const q = value as Record<string, unknown>;
  const out: StatuslineQuota = {};
  const set = <K extends keyof StatuslineQuota>(k: K, v: StatuslineQuota[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set('contextPercent', percentField(q.contextPercent));
  set('contextWindowTokens', nonNegativeFinite(q.contextWindowTokens) && q.contextWindowTokens > 0 ? q.contextWindowTokens : undefined);
  set('fiveHourPercent', percentField(q.fiveHourPercent));
  set('fiveHourResetsAtMs', resetsAtField(q.fiveHourResetsAtMs));
  set('sevenDayPercent', percentField(q.sevenDayPercent));
  set('sevenDayResetsAtMs', resetsAtField(q.sevenDayResetsAtMs));
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeCardUsageSnapshot(value: unknown): CardUsageSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const rawContext = raw.context;
  const rawTokens = raw.tokens;

  let context: CardUsageSnapshot['context'] = null;
  if (rawContext && typeof rawContext === 'object' && !Array.isArray(rawContext)) {
    const c = rawContext as Record<string, unknown>;
    if (typeof c.usedTokens === 'number'
      && Number.isFinite(c.usedTokens)
      && c.usedTokens >= 0) {
      context = {
        usedTokens: c.usedTokens,
        ...(typeof c.windowTokens === 'number'
          && Number.isFinite(c.windowTokens)
          && c.windowTokens > 0
          ? { windowTokens: c.windowTokens }
          : {}),
        ...(typeof c.percentUsed === 'number'
          && Number.isFinite(c.percentUsed)
          && c.percentUsed >= 0
          ? { percentUsed: c.percentUsed }
          : {}),
      };
    }
  }

  let tokens: CardUsageSnapshot['tokens'] = null;
  if (rawTokens && typeof rawTokens === 'object' && !Array.isArray(rawTokens)) {
    const u = rawTokens as Record<string, unknown>;
    if (typeof u.in === 'number'
      && Number.isFinite(u.in)
      && u.in >= 0
      && typeof u.out === 'number'
      && Number.isFinite(u.out)
      && u.out >= 0) {
      tokens = { in: u.in, out: u.out };
    }
  }

  // statusline 配额段：只在至少一个字段合法时才带 key，保证「无数据 ⇒ 卡片与现状逐字节相同」。
  const quota = normalizeCardUsageQuota(raw.quota);
  return quota ? { context, tokens, quota } : { context, tokens };
}
