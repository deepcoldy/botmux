import type { OnlineDaemonInfo } from '../utils/daemon-discovery.js';

export function formatLarkConnectionStatus(
  row: { alive: boolean; pid: number },
  descriptor?: OnlineDaemonInfo,
): string {
  if (!row.alive) return 'offline';
  if (!descriptor || descriptor.pid !== row.pid) return 'unknown';
  const health = descriptor.larkConnection;
  if (health === null) return 'disabled';
  if (!health) return 'unknown';
  const since = health.state === 'reconnecting' || health.state === 'connecting'
    ? ` since ${new Date(health.since).toISOString()}` : '';
  const inbound = health.lastInboundAt === null ? '—' : new Date(health.lastInboundAt).toISOString();
  return `${health.state}${since} attempts=${health.attempts} last-inbound=${inbound}`;
}
