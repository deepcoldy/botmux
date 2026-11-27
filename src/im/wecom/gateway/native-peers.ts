import { createHash } from 'node:crypto';
import { createDaemonClient } from '../../../dashboard/daemon-internal-client.js';
import { wecomRoot } from '../config/discovery.js';
import { readWecomRuntime } from '../config/runtime.js';
import { readLocalWecomConnection, type WecomPeerOperation } from '../config/peer-trust.js';
import { WECOM_GATEWAY_CONTROL_PATHS } from '../contract/gateway-control.js';

/**
 * One request between two WeCom connections of this host. It names who asks
 * (source connection, its user and conversation as the source saw them) and
 * nothing it trusts: the target judges the request against both connections'
 * current configuration (config/peer-trust.ts) at every step.
 */
export interface NativePeerRequest {
  operation: WecomPeerOperation;
  sourceId: string;
  sourceBotId: string;
  sourceUser: string;
  sourceChat: string;
  chatType: 'single' | 'group';
  requestId: string;
  trace: string[];
  request?: unknown;
  sessionId?: string;
  triggerId?: string;
}

/**
 * The control endpoint of a peer connection's running gateway. Throws
 * `wecom_peer_not_found` when no such connection is configured on this host,
 * `wecom_peer_offline` when its gateway is not running.
 */
export function wecomPeerControl(peerId: string, root = wecomRoot()): { port: number; instanceId: string } {
  const config = readLocalWecomConnection(peerId, root);
  if (!config) {
    throw new Error('wecom_peer_not_found');
  }
  const runtime = readWecomRuntime(config.botId, root);
  if (!runtime?.control || runtime.configId !== peerId || runtime.phase !== 'running') {
    throw new Error('wecom_peer_offline');
  }
  return runtime.control;
}

export async function requestNativePeer(
  peerId: string,
  body: NativePeerRequest,
  root = wecomRoot(),
): Promise<Record<string, unknown>> {
  const control = wecomPeerControl(peerId, root);
  const client = createDaemonClient({
    dashboardUrl: `http://127.0.0.1:${control.port}`,
    appId: 'wecom-native-peer',
    timeoutMs: 15000,
  });
  const response = await client.request({
    method: 'POST',
    path: WECOM_GATEWAY_CONTROL_PATHS.peer,
    body: { ...body, instanceId: control.instanceId },
  });
  if (response.status !== 200) {
    throw new Error('wecom_peer_rejected');
  }
  return response.body as Record<string, unknown>;
}

export const peerRequestHash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
