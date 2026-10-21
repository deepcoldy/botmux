import type { TrustedCaller } from '../types.js';
import { resolveVerifiedUserIdentityByUnionId } from '../im/lark/identity-cache.js';
import { resolvePlatformTeamBotOwner } from '../services/platform-team-store.js';

export interface BotOwnerAttributionDeps {
  resolveOwnerUnionId: typeof resolvePlatformTeamBotOwner;
  resolveOwnerIdentity: typeof resolveVerifiedUserIdentityByUnionId;
}

const DEFAULT_DEPS: BotOwnerAttributionDeps = {
  resolveOwnerUnionId: resolvePlatformTeamBotOwner,
  resolveOwnerIdentity: resolveVerifiedUserIdentityByUnionId,
};

/**
 * Attach a human developer only to a positively identified bot turn. The
 * source bot stays the immediate caller; this annotation is a separate,
 * narrowly sourced credential choice for consumers that explicitly implement
 * developer_default.
 */
export async function withPlatformBotOwner(
  caller: TrustedCaller | undefined,
  dataDir: string,
  deps: BotOwnerAttributionDeps = DEFAULT_DEPS,
): Promise<TrustedCaller | undefined> {
  if (caller?.senderType !== 'bot' || !caller.requestLarkAppId || !caller.requestUserUnionId) {
    return caller;
  }
  const owner = deps.resolveOwnerUnionId(
    dataDir,
    caller.requestLarkAppId,
    caller.requestUserUnionId,
  );
  if (owner.status !== 'resolved') return caller;
  const identity = await deps.resolveOwnerIdentity(caller.requestLarkAppId, owner.ownerUnionId);
  const email = identity?.email?.trim().toLowerCase();
  if (!identity || identity.unionId !== owner.ownerUnionId || !email || !email.includes('@')) return caller;
  return {
    ...caller,
    botOwner: {
      openId: identity.openId,
      unionId: identity.unionId,
      email,
      source: 'platform_team',
    },
  };
}
