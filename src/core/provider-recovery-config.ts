/**
 * Daemon-side reading of `providerRecovery` (services/provider-recovery-policy.ts):
 * the machine-wide layer from config.json merged with the bot's own, against
 * the bot's effective prompt-cache lifetime. Read live on every call.
 */
import type { BotConfig } from '../bot-registry.js';
import { readGlobalConfig } from '../global-config.js';
import { resolvedPromptCacheTtl } from './prompt-cache-keepalive.js';
import type { PromptCacheTtl } from '../services/prompt-cache-policy.js';
import {
  resolveProviderRecoveryPolicy,
  type ResolvedProviderRecoveryPolicy,
} from '../services/provider-recovery-policy.js';
import {
  DEFAULT_ORDINARY_TURN_RECOVERY_PACING,
  type OrdinaryTurnRecoveryPacing,
} from '../services/ordinary-turn-recovery.js';

/** `sessionTtl`: the prompt-cache lifetime a running CLI was started with
 *  (null = it requested none); omitted = the bot's current setting. */
export function botProviderRecoveryPolicy(
  bot: Pick<BotConfig, 'promptCache' | 'providerRecovery'>,
  sessionTtl?: PromptCacheTtl | null,
): ResolvedProviderRecoveryPolicy {
  const ttl = sessionTtl === undefined ? resolvedPromptCacheTtl(bot) : sessionTtl ?? undefined;
  return resolveProviderRecoveryPolicy(readGlobalConfig().providerRecovery, bot.providerRecovery, ttl);
}

/** The coordinator's pacing for a resolved policy: the window is the
 *  configured wait; the ten-minute floor never exceeds it. */
export function providerRecoveryPacing(policy: ResolvedProviderRecoveryPolicy): OrdinaryTurnRecoveryPacing {
  const windowMs = policy.maxWaitMinutes * 60_000;
  const longestStep = Math.max(...DEFAULT_ORDINARY_TURN_RECOVERY_PACING.backoffMs);
  return {
    ...DEFAULT_ORDINARY_TURN_RECOVERY_PACING,
    windowMs,
    minWindowMs: Math.min(DEFAULT_ORDINARY_TURN_RECOVERY_PACING.minWindowMs, windowMs),
    // A long window must not be cut short by the runaway guard: room for one
    // continuation per longest step across it, plus the short ones up front.
    maxContinuations: Math.max(DEFAULT_ORDINARY_TURN_RECOVERY_PACING.maxContinuations,
      Math.ceil(windowMs / longestStep) + DEFAULT_ORDINARY_TURN_RECOVERY_PACING.backoffMs.length),
    followsPromptCache: policy.maxWaitSource === 'cache_1h',
  };
}
