/**
 * Automatic continuation after a transient model-provider failure (Claude
 * Code's ordinary-turn recovery, `[BOTMUX_RECOVERY]`): whether it runs at all,
 * and for how long it keeps trying.
 *
 * Two layers share one shape, like `promptCache`: the machine-wide default in
 * `~/.botmux/config.json` (`providerRecovery`) and the per-bot override in
 * `bots.json` (`providerRecovery`). Each field resolves independently — bot
 * value, else global value, else built-in default.
 *
 * OFF by default. Not every deployment wants a bot to keep re-driving a half-
 * done task on its own: a failed turn then gets the failure card with its
 * 「继续这一轮」 button, plus the provider's own recovery time when it named one.
 *
 * When on, how long it keeps trying (measured from the last request the
 * provider answered) defaults to the prompt cache: with a 1-hour cache
 * (`promptCache.ttl: '1h'`) 55 minutes, so a continuation still lands on a
 * warm cache; otherwise 15 minutes — there the cache is gone within minutes
 * anyway, and the bound is only how long to retry before handing back to a
 * human. Either can be set explicitly.
 *
 * Browser-safe: imported by the Dashboard editor (no node-only imports).
 */
import type { PromptCacheTtl } from './prompt-cache-policy.js';

export interface ProviderRecoveryConfig {
  enabled?: boolean;
  /** How long to keep continuing, from the last answered request. */
  maxWaitMinutes?: number;
}

export interface ResolvedProviderRecoveryPolicy {
  enabled: boolean;
  maxWaitMinutes: number;
  /** Where maxWaitMinutes came from: a layer, or the built-in default that
   *  follows the prompt cache. */
  maxWaitSource: 'configured' | 'cache_1h' | 'default';
}

export const PROVIDER_RECOVERY_MAX_WAIT_MINUTES_CACHE_1H = 55;
export const PROVIDER_RECOVERY_MAX_WAIT_MINUTES_DEFAULT = 15;
export const PROVIDER_RECOVERY_MAX_WAIT_MINUTES_MAX = 240;

const KEYS = new Set(['enabled', 'maxWaitMinutes']);

/** Strict normalizer for writes (Dashboard PUT, `/config set`, bots.json
 *  load): unknown keys and out-of-range values throw. `undefined`/`null`
 *  clears the layer. */
export function normalizeProviderRecoveryConfig(value: unknown): ProviderRecoveryConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('providerRecovery must be an object');
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find(key => !KEYS.has(key));
  if (unknown) throw new Error(`Unknown providerRecovery field: ${unknown}`);
  const out: ProviderRecoveryConfig = {};
  if (input.enabled !== undefined && input.enabled !== null) {
    if (typeof input.enabled !== 'boolean') throw new Error('providerRecovery.enabled must be boolean');
    out.enabled = input.enabled;
  }
  if (input.maxWaitMinutes !== undefined && input.maxWaitMinutes !== null) {
    const minutes = input.maxWaitMinutes;
    if (typeof minutes !== 'number' || !Number.isInteger(minutes)
      || minutes < 1 || minutes > PROVIDER_RECOVERY_MAX_WAIT_MINUTES_MAX) {
      throw new Error(`providerRecovery.maxWaitMinutes must be an integer between 1 and ${PROVIDER_RECOVERY_MAX_WAIT_MINUTES_MAX}`);
    }
    out.maxWaitMinutes = minutes;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Lenient reader for `config.json`: a malformed block is ignored whole. */
export function readProviderRecoveryConfig(raw: unknown): ProviderRecoveryConfig | undefined {
  try { return normalizeProviderRecoveryConfig(raw); } catch { return undefined; }
}

/** Field-wise merge: bot value, else global value, else built-in default.
 *  `promptCacheTtl` is the bot's effective prompt-cache lifetime. */
export function resolveProviderRecoveryPolicy(
  globalLayer: ProviderRecoveryConfig | undefined,
  botLayer: ProviderRecoveryConfig | undefined,
  promptCacheTtl: PromptCacheTtl | undefined,
): ResolvedProviderRecoveryPolicy {
  const enabled = (botLayer?.enabled ?? globalLayer?.enabled) === true;
  const configured = botLayer?.maxWaitMinutes ?? globalLayer?.maxWaitMinutes;
  if (configured !== undefined) return { enabled, maxWaitMinutes: configured, maxWaitSource: 'configured' };
  return promptCacheTtl === '1h'
    ? { enabled, maxWaitMinutes: PROVIDER_RECOVERY_MAX_WAIT_MINUTES_CACHE_1H, maxWaitSource: 'cache_1h' }
    : { enabled, maxWaitMinutes: PROVIDER_RECOVERY_MAX_WAIT_MINUTES_DEFAULT, maxWaitSource: 'default' };
}
