import type { TrustedCaller } from '../types.js';
import { resolveVerifiedUserIdentityByUnionId } from '../im/lark/identity-cache.js';
import {
  findBotActorOwnerBinding,
  type BotActorOwnerBinding,
} from './bot-actor-owner-binding.js';

export interface BotOwnerAttributionDeps {
  resolveOwnerIdentity: typeof resolveVerifiedUserIdentityByUnionId;
}

const DEFAULT_DEPS: BotOwnerAttributionDeps = {
  resolveOwnerIdentity: resolveVerifiedUserIdentityByUnionId,
};

/**
 * Attach a human developer only to a positively identified bot turn. The
 * source bot stays the immediate caller; this annotation is a separate,
 * narrowly sourced credential choice for consumers that explicitly implement
 * developer_default.
 */
export async function withConfiguredBotOwner(
  caller: TrustedCaller | undefined,
  bindings: readonly BotActorOwnerBinding[] | undefined,
  deps: BotOwnerAttributionDeps = DEFAULT_DEPS,
): Promise<TrustedCaller | undefined> {
  if (caller?.senderType !== 'bot' || !caller.requestLarkAppId) {
    return caller;
  }
  const binding = findBotActorOwnerBinding(
    bindings,
    caller.requestUserOpenId,
    caller.requestUserUnionId,
  );
  if (!binding) return caller;
  const identity = await deps.resolveOwnerIdentity(caller.requestLarkAppId, binding.ownerUnionId);
  const email = identity?.email?.trim().toLowerCase();
  if (!identity || !identity.openId.startsWith('ou_')
      || identity.unionId !== binding.ownerUnionId || email !== binding.ownerEmail) return caller;
  return {
    ...caller,
    botOwner: {
      openId: identity.openId,
      unionId: identity.unionId,
      email,
      source: 'bot_config',
    },
  };
}
