/**
 * Who a scheduled task created or edited in the Dashboard is recorded as.
 *
 * Two ways into the Dashboard:
 *   - The local token link. It proves possession of the token, not a person,
 *     so these writes keep the historical attribution (the bot owner).
 *   - Through the central platform, which signs people in with Feishu SSO and
 *     injects `X-Botmux-Actor` = that person's union_id after stripping any
 *     client-supplied copy. Writes arriving that way are recorded as that
 *     person, so the task later runs with their identity rather than the bot
 *     owner's — provided they can operate the bot, re-checked like any creator.
 *
 * The platform's header is only believed on a connection the platform tunnel
 * opened (platform/tunnel-peers): a token holder talking to the Dashboard
 * directly can send the same header. The Dashboard forwards the verified
 * union_id to the owning daemon in its own header over its signed host
 * channel; the daemon resolves the bot-scoped open_id itself (open_id is
 * app-scoped, the platform only knows the union_id) and checks `canOperate`.
 */

import { isPlatformTunnelPeer } from '../platform/tunnel-peers.js';
import { logger } from '../utils/logger.js';

/** Dashboard → daemon request header carrying the verified union_id. */
export const DASHBOARD_SCHEDULE_CREATOR_HEADER = 'x-botmux-schedule-creator-union-id';

const UNION_ID = /^on_[A-Za-z0-9_-]{1,64}$/;

function singleUnionId(raw: unknown): string | undefined {
  // A repeated header arrives as an array: treat it as absent, like the
  // dashboard's other platform headers.
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return UNION_ID.test(value) ? value : undefined;
}

/**
 * Dashboard side: the person a schedule write is attributed to, or undefined
 * for a token-only write. `fromPlatformTunnel` must come from the connection
 * itself (isPlatformTunnelPeer), never from anything the request says.
 */
export function dashboardScheduleCreatorUnionId(input: {
  platformBound: boolean;
  fromPlatformTunnel: boolean;
  actorHeader: unknown;
}): string | undefined {
  if (!input.platformBound || !input.fromPlatformTunnel) return undefined;
  return singleUnionId(input.actorHeader);
}

/** Headers for a schedule create/edit the Dashboard forwards to its daemon:
 *  the Feishu-login person rides along only when the platform tunnel delivered
 *  this very connection. A token-only request — including one that sets
 *  X-Botmux-Actor itself — carries nobody. */
export function dashboardScheduleWriteHeaders(
  req: { socket?: { remoteAddress?: string | null; remotePort?: number | null }; headers: Record<string, unknown> },
  platformBound: boolean,
): Record<string, string> {
  const fromPlatformTunnel = isPlatformTunnelPeer(req.socket);
  const unionId = dashboardScheduleCreatorUnionId({
    platformBound,
    fromPlatformTunnel,
    actorHeader: req.headers['x-botmux-actor'],
  });
  // The platform can also reach a machine directly on its LAN dashboard port
  // (the `directHosts` it learns from heartbeats), bypassing the tunnel. That
  // path cannot be told apart from any other LAN client, so its actor header
  // is not believed either. Say so, or "sometimes it records me, sometimes
  // the owner" has no explanation anywhere.
  if (platformBound && !fromPlatformTunnel && req.headers['x-botmux-actor'] !== undefined) {
    logger.info(
      `[schedule-creator] X-Botmux-Actor ignored: not a platform tunnel connection `
      + `(peer=${req.socket?.remoteAddress ?? '?'}:${req.socket?.remotePort ?? '?'}); this write keeps the token-login attribution`,
    );
  }
  return {
    'content-type': 'application/json',
    ...(unionId ? { [DASHBOARD_SCHEDULE_CREATOR_HEADER]: unionId } : {}),
  };
}

/** Daemon side: the union_id the Dashboard vouched for. Only meaningful on a
 *  request that passed the trusted-host signature check. */
export function dashboardCreatorFromRequest(trustedHost: boolean, headerValue: unknown): string | undefined {
  return trustedHost ? singleUnionId(headerValue) : undefined;
}

export type DashboardScheduleCreator =
  | { ok: true; openId: string; unionId: string }
  | { ok: false; reason: 'open_id_unresolved' | 'cannot_operate' };

/** Resolve the person on the task's own bot and require that they can operate
 *  it — the same check every scheduled run applies to its creator. */
export async function resolveDashboardScheduleCreator(input: {
  appId: string;
  chatId: string;
  unionId: string;
  resolveOpenId: (appId: string, unionId: string) => Promise<string | undefined>;
  canOperate: (appId: string, chatId: string, openId: string, unionId: string) => boolean;
}): Promise<DashboardScheduleCreator> {
  const openId = await input.resolveOpenId(input.appId, input.unionId);
  if (!openId || !openId.startsWith('ou_')) return { ok: false, reason: 'open_id_unresolved' };
  if (!input.canOperate(input.appId, input.chatId, openId, input.unionId)) {
    return { ok: false, reason: 'cannot_operate' };
  }
  return { ok: true, openId, unionId: input.unionId };
}
