import { CODEX_APP_NO_PROGRESS_TIMEOUT_MS } from '../utils/codex-app-turn-liveness.js';

/**
 * Per-bot tuning for the Codex App once-per-turn "no observable progress"
 * nudge (#1162). Deliberately scoped to the Lark push only: the worker keeps
 * polling either way, so the dashboard stalled projection and the
 * `session.requires_attention` lifecycle hook stay observable even when muted.
 *
 * `timeoutMs` overrides the liveness window from the next worker fork (same
 * read-live-from-bot-config semantics as `turnTimeoutMs`); it never touches
 * `RECONCILIATION_KEEP_PENDING_TIMEOUT_MS`, which stays aligned to the
 * exported constant on purpose.
 */
export interface NoProgressNotifyPolicy {
  /** Default true. `false` mutes only the Lark push. */
  enabled: boolean;
  /** Positive integer within [MIN, MAX]; absent = built-in 90s default. */
  timeoutMs?: number;
}

/** Lower bound keeps a mis-typed value from turning the nudge into spam. */
export const MIN_NO_PROGRESS_NOTIFY_TIMEOUT_MS = 10_000;
/** Upper bound matches MAX_TURN_TIMEOUT_MS's spirit: one hour is beyond any sane nudge. */
export const MAX_NO_PROGRESS_NOTIFY_TIMEOUT_MS = 3_600_000;

/** Effective liveness window for a bot: explicit override or the built-in default. */
export function noProgressNotifyTimeoutMs(policy: NoProgressNotifyPolicy | undefined): number {
  return policy?.timeoutMs ?? CODEX_APP_NO_PROGRESS_TIMEOUT_MS;
}

/**
 * Normalize an untrusted `noProgressNotify` value (bots.json entry or
 * `/config set` JSON). `undefined`/`null` clears the override; anything
 * malformed throws, matching `normalizeOncallGroupPolicy` so both config
 * doors (registry load and coerce) share one verdict.
 */
export function normalizeNoProgressNotifyPolicy(value: unknown): NoProgressNotifyPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('noProgressNotify must be an object');
  const input = value as Record<string, unknown>;
  const unknownKey = Object.keys(input).find(key => key !== 'enabled' && key !== 'timeoutMs');
  if (unknownKey) throw new Error(`Unknown noProgressNotify field: ${unknownKey}`);
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new Error('noProgressNotify.enabled must be boolean');
  }
  if (input.timeoutMs !== undefined) {
    if (typeof input.timeoutMs !== 'number' || !Number.isInteger(input.timeoutMs)
      || input.timeoutMs < MIN_NO_PROGRESS_NOTIFY_TIMEOUT_MS
      || input.timeoutMs > MAX_NO_PROGRESS_NOTIFY_TIMEOUT_MS) {
      throw new Error(`noProgressNotify.timeoutMs must be an integer between ${MIN_NO_PROGRESS_NOTIFY_TIMEOUT_MS} and ${MAX_NO_PROGRESS_NOTIFY_TIMEOUT_MS}`);
    }
  }
  return {
    enabled: input.enabled !== false,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };
}
