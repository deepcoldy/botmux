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
import { isAuthorizedForGlobalSettings } from '../../dashboard/settings-owner-resolver.js';

export type DashboardOwnerCheck =
  | { ok: true; unionId: string }
  | { ok: false; reason: 'missing_union_id' | 'invalid_prefix' | 'not_authorized' };

/** Optional deps — tests inject a mock authoriser; production omits and uses the PR2 helper. */
export interface EnsureDashboardOwnerDeps {
  isAuthorized?: (check: { senderUnionId: string }) => Promise<boolean>;
}

/** Decide whether `message.senderUnionId` is allowed to use `/dashboard *`. */
export async function ensureDashboardOwner(
  message: LarkMessage,
  deps: EnsureDashboardOwnerDeps = {},
): Promise<DashboardOwnerCheck> {
  const senderUnionId = message.senderUnionId;
  if (!senderUnionId) return { ok: false, reason: 'missing_union_id' };
  if (!senderUnionId.startsWith('on_')) return { ok: false, reason: 'invalid_prefix' };
  const authoriser = deps.isAuthorized ?? isAuthorizedForGlobalSettings;
  const allowed = await authoriser({ senderUnionId });
  if (!allowed) return { ok: false, reason: 'not_authorized' };
  return { ok: true, unionId: senderUnionId };
}
