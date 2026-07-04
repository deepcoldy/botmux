/**
 * `/dashboard` command-group admin gate.
 *
 * Single source of truth for verifying that a sender is allowed to use any
 * `/dashboard <module>` subcommand. The entire `/dashboard` group is
 * restricted to the bot's resolved `allowedUsers`, matching `/botconfig`;
 * help / stub / unknown subcommands MUST go through this check before they
 * can produce any output.
 *
 * Why a dedicated helper instead of inlining the lookup in command dispatch:
 *  - Command entry and card-callback paths must share the same admin model.
 *    If one path treats only allowedUsers[0] as privileged while another
 *    accepts all allowedUsers, `/dashboard` drifts away from `/botconfig`.
 *  - Empty allowedUsers deliberately fails closed. Other botmux commands may
 *    have open-mode fallbacks, but dashboard exposes operational controls.
 */

import type { LarkMessage } from '../../types.js';
import {
  resolveDashboardAdminOpenIds,
  type DashboardAdminLookupDeps,
} from '../../dashboard/dashboard-admins.js';

export type DashboardAdminCheck =
  | { ok: true; adminOpenId: string }
  | { ok: false; reason: 'no_dashboard_admin' | 'missing_sender' | 'not_dashboard_admin' };

/** Backward-compatible type alias for older tests/imports. */
export type DashboardOwnerCheck = DashboardAdminCheck;

/** Optional injection seam — tests provide mock admin lookup. */
export interface EnsureDashboardOwnerDeps extends DashboardAdminLookupDeps {}

/**
 * Decide whether `message.senderId` is a per-bot dashboard admin.
 *
 * Per-bot admin gate:
 *  - Each `/dashboard` invocation is scoped to the bot that received it.
 *  - Any resolved `allowedUsers` entry can operate, matching `/botconfig`.
 *  - Empty `allowedUsers` still fails closed; dashboard is never opened by
 *    botmux's generic open-mode `canOperate` fallback.
 */
export async function ensureDashboardOwner(
  message: LarkMessage,
  larkAppId: string | undefined,
  deps: EnsureDashboardOwnerDeps = {},
): Promise<DashboardAdminCheck> {
  if (!larkAppId) return { ok: false, reason: 'no_dashboard_admin' };
  const admins = resolveDashboardAdminOpenIds(larkAppId, deps);
  if (admins.length === 0) return { ok: false, reason: 'no_dashboard_admin' };
  const senderId = message.senderId;
  if (!senderId) return { ok: false, reason: 'missing_sender' };
  if (!admins.includes(senderId)) return { ok: false, reason: 'not_dashboard_admin' };
  return { ok: true, adminOpenId: senderId };
}
