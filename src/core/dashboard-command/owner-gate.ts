/**
 * `/dashboard` command-group owner gate (PR3 C1).
 *
 * Single source of truth for verifying that a sender is allowed to use any
 * `/dashboard <module>` subcommand. The entire `/dashboard` group is
 * owner-only; help / stub / unknown subcommands MUST go through this check
 * before they can produce any output.
 *
 * Why a dedicated helper instead of inlining the union_id walk in the
 * command dispatch:
 *  - The same owner predicate will be needed by card-callback paths later
 *    (PR4+) and by the settings flow (PR3 C4). One helper guarantees they
 *    can't drift apart.
 *  - The PR2 helper `isAuthorizedForGlobalSettings` already swallows resolver
 *    exceptions and returns `false` (`settings-owner-resolver.ts:50-56`), so
 *    `not_authorized` covers BOTH "candidate set returned but unionId absent"
 *    and "resolver threw". We do not surface a `resolver_error` reason —
 *    callers can't act on it and the fail-closed behaviour is identical.
 */

import type { LarkMessage } from '../../types.js';
import { getOwnerOpenId as defaultGetOwnerOpenId } from '../../bot-registry.js';

export type DashboardOwnerCheck =
  | { ok: true; ownerOpenId: string }
  | { ok: false; reason: 'no_bot_owner' | 'missing_sender' | 'not_bot_owner' };

/** Optional injection seam — tests provide a mock `getOwnerOpenId`. */
export interface EnsureDashboardOwnerDeps {
  getOwnerOpenId?: (larkAppId: string) => string | undefined;
}

/**
 * Decide whether `message.senderId` is the per-bot owner of `larkAppId`.
 *
 * Per-bot owner gate (PR3 revision):
 *  - We do NOT use the global union_id owner set anymore. Each `/dashboard`
 *    invocation is scoped to the bot that received it; only THAT bot's
 *    owner (the first `ou_`-prefixed entry in `allowedUsers`) can operate.
 *  - Aligns with `/card` / `/botconfig` idiom (`command-handler.ts:737-740`).
 *  - A user who is the owner of bot A but not bot B will be rejected when
 *    @-ing bot B with `/dashboard *` — fail closed, no cross-bot escalation.
 */
export async function ensureDashboardOwner(
  message: LarkMessage,
  larkAppId: string | undefined,
  deps: EnsureDashboardOwnerDeps = {},
): Promise<DashboardOwnerCheck> {
  if (!larkAppId) return { ok: false, reason: 'no_bot_owner' };
  const getOwnerOpenId = deps.getOwnerOpenId ?? defaultGetOwnerOpenId;
  const ownerOpenId = getOwnerOpenId(larkAppId);
  if (!ownerOpenId) return { ok: false, reason: 'no_bot_owner' };
  const senderId = message.senderId;
  if (!senderId) return { ok: false, reason: 'missing_sender' };
  if (senderId !== ownerOpenId) return { ok: false, reason: 'not_bot_owner' };
  return { ok: true, ownerOpenId };
}
