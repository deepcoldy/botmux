import type { CardUsageSnapshot } from '../im/lark/md-card.js';
import { normalizeReplyFooter, type ReplyFooterPreferences } from './reply-footer.js';

/** Display decisions and measured timing are separate from native usage facts. */
export interface ReplyCardPresentation {
  footerPreferences: ReplyFooterPreferences;
  timing?: ReplyCardTiming;
}
export interface ReplyCardTiming {
  executionDurationMs?: number;
  waitingDurationMs?: number;
  /** A normal send can occur before the native turn completes. */
  executionInProgress?: boolean;
}
/** Freeze this entire object for final-output retries. */
export interface ReplyCardRenderSnapshot extends ReplyCardPresentation {
  usage: CardUsageSnapshot;
}

export function normalizeReplyCardPresentation(value: unknown): ReplyCardPresentation {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const timing = raw.timing && typeof raw.timing === 'object' && !Array.isArray(raw.timing)
    ? raw.timing as Record<string, unknown> : {};
  const out: ReplyCardTiming = {};
  for (const key of ['executionDurationMs', 'waitingDurationMs'] as const) {
    const n = timing[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[key] = n;
  }
  if (out.executionDurationMs !== undefined && timing.executionInProgress === true) out.executionInProgress = true;
  return { footerPreferences: normalizeReplyFooter(raw.footerPreferences), ...(Object.keys(out).length ? { timing: out } : {}) };
}

/** Use only observed native starts/completions. Never count queue time as execution. */
export function measureReplyTiming(input: {
  startedAtMs?: number; receivedAtMs?: number; durationMs?: number; nowMs: number; completed: boolean;
}): ReplyCardTiming | undefined {
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const started = valid(input.startedAtMs) && input.startedAtMs <= input.nowMs ? input.startedAtMs : undefined;
  const duration = input.completed ? input.durationMs
    : valid(started) && started <= input.nowMs ? input.nowMs - started : undefined;
  const executionDurationMs = valid(duration) ? duration : undefined;
  const waiting = valid(started) && valid(input.receivedAtMs) ? started - input.receivedAtMs : undefined;
  const waitingDurationMs = valid(waiting) ? waiting : undefined;
  if (executionDurationMs === undefined && waitingDurationMs === undefined) return undefined;
  return { ...(executionDurationMs !== undefined ? { executionDurationMs, ...(!input.completed ? { executionInProgress: true } : {}) } : {}),
    ...(waitingDurationMs !== undefined ? { waitingDurationMs } : {}) };
}
