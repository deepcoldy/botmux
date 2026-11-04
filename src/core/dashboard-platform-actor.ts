/**
 * The Feishu-login person behind a Dashboard request, as the central platform
 * vouches for it.
 *
 * On a machine bound to the platform, people reach the Dashboard through the
 * platform (m- domain): it signs them in with Feishu SSO and injects
 * `X-Botmux-Actor` = that person's union_id after stripping any copy the
 * client sent. That header is only believed on a connection the platform
 * tunnel opened (platform/tunnel-peers): a token holder talking to the
 * Dashboard directly can send the same header, and so can the platform's own
 * direct LAN path (`directHosts`), which is indistinguishable from any other
 * LAN client.
 *
 * Shared by every Dashboard write that records a person: scheduled task
 * creators (core/dashboard-schedule-creator) and workflow initiators
 * (core/workflow-initiator). Each caller decides what an unidentified request
 * means for it — schedules keep the token-login attribution, workflows refuse.
 */

import { isPlatformTunnelPeer } from '../platform/tunnel-peers.js';

const UNION_ID = /^on_[A-Za-z0-9_-]{1,64}$/;

/** A well-formed single union_id, or undefined. A repeated header arrives as
 *  an array: treat it as absent, like the dashboard's other platform headers. */
export function singleUnionId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return UNION_ID.test(value) ? value : undefined;
}

/**
 * The union_id the platform injected, or undefined. `fromPlatformTunnel` must
 * come from the connection itself (isPlatformTunnelPeer), never from anything
 * the request says.
 */
export function trustedPlatformActorUnionId(input: {
  platformBound: boolean;
  fromPlatformTunnel: boolean;
  actorHeader: unknown;
}): string | undefined {
  if (!input.platformBound || !input.fromPlatformTunnel) return undefined;
  return singleUnionId(input.actorHeader);
}

export interface DashboardPlatformActor {
  /** The platform tunnel delivered this connection on a bound machine. */
  viaPlatformTunnel: boolean;
  /** The person the platform vouches for (only when viaPlatformTunnel). */
  unionId?: string;
  /** The request carried `X-Botmux-Actor` that is NOT believed (bound machine,
   *  not a tunnel connection). Callers log it so "sometimes it records me,
   *  sometimes the owner" has an explanation. */
  ignoredActorHeader: boolean;
}

export function readDashboardPlatformActor(
  req: { socket?: { remoteAddress?: string | null; remotePort?: number | null }; headers: Record<string, unknown> },
  platformBound: boolean,
): DashboardPlatformActor {
  const fromPlatformTunnel = isPlatformTunnelPeer(req.socket);
  const actorHeader = req.headers['x-botmux-actor'];
  const unionId = trustedPlatformActorUnionId({ platformBound, fromPlatformTunnel, actorHeader });
  return {
    viaPlatformTunnel: platformBound && fromPlatformTunnel,
    ...(unionId ? { unionId } : {}),
    ignoredActorHeader: platformBound && !fromPlatformTunnel && actorHeader !== undefined,
  };
}
