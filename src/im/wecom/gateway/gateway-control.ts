import { createServer } from 'node:http';
import { createNonceStore, verifyDaemonRequest } from '../../../dashboard/daemon-internal-auth.js';
import { loadDashboardSecret } from '../../../dashboard/auth.js';
import { dashboardSecretPath } from '../../../core/dashboard-secret.js';
import {
  WECOM_GATEWAY_CONTROL_PATHS,
  type WecomSessionControlRequest,
  type WecomTerminalAuthorization,
  type WecomTerminalAuthorizeRequest,
} from '../contract/gateway-control.js';
import type { WecomBridge, WecomSessionActionResult, WecomSessionOperation } from './bridge.js';

const operations = new Set(['interrupt', 'close', 'archive', 'delete', 'restart', 'resume', 'suspend']);
export async function startWecomGatewayControl(options: {
  bridge: WecomBridge;
  instanceId: string;
  coreIdentity: string;
  secret?: string;
  verifyCoreBoot?: (bootId: string) => Promise<boolean>;
  coreAction: (sessionId: string, operation: WecomSessionOperation, expectedCoreBootId?: string) => Promise<WecomSessionActionResult>;
}): Promise<{
  port: number;
  stop(): Promise<void>;
  /** Drop requests still in flight; for when a bounded stop wait has run out. */
  terminate(): void;
}> {
  const secret = options.secret ?? loadDashboardSecret(dashboardSecretPath());
  if (!secret) {
    throw new Error('dashboard_secret_missing');
  }
  const nonces = createNonceStore();
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method !== 'POST' || ![
        WECOM_GATEWAY_CONTROL_PATHS.sessionControl,
        WECOM_GATEWAY_CONTROL_PATHS.peer,
        WECOM_GATEWAY_CONTROL_PATHS.terminalAuthorize,
      ].includes(req.url ?? '')) {
        return reply(404, { ok: false });
      }
      // Bind only literal loopback even if the shared auth permits configured peer addresses.
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
        return reply(403, { ok: false });
      }
      const verified = await verifyDaemonRequest(req, secret, nonces, { maxBodyBytes: 8192 });
      if (!verified.ok) {
        return reply(verified.httpStatus, { ok: false, error: 'unauthorized' });
      }
      let body: WecomSessionControlRequest;
      try {
        body = JSON.parse(verified.bodyRaw);
      } catch {
        return reply(400, { ok: false, error: 'invalid_request' });
      }
      if (body?.instanceId !== options.instanceId
        || (![WECOM_GATEWAY_CONTROL_PATHS.peer, WECOM_GATEWAY_CONTROL_PATHS.terminalAuthorize].includes(req.url ?? '')
          && body.coreIdentity !== options.coreIdentity)) {
        return reply(409, { ok: false, error: 'stale_instance' });
      }
      if (req.url === WECOM_GATEWAY_CONTROL_PATHS.terminalAuthorize) {
        // Unvalidated wire input: terminalAuthorization allows only an exact match with a live task.
        const authorization: WecomTerminalAuthorization = options.bridge.terminalAuthorization(
          body as unknown as WecomTerminalAuthorizeRequest,
        );
        return reply(200, authorization);
      }
      if (req.url === WECOM_GATEWAY_CONTROL_PATHS.peer) {
        return reply(200, await options.bridge.receivePeer(body as any));
      }
      if (!operations.has(body.operation) || typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 256
        || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.requestId)
        || (body.expectedGeneration !== undefined && typeof body.expectedGeneration !== 'string')) {
        return reply(400, { ok: false, error: 'invalid_request' });
      }
      if (options.verifyCoreBoot && (typeof body.expectedCoreBootId !== 'string' || !await options.verifyCoreBoot(body.expectedCoreBootId))) {
        return reply(409, { ok: false, error: 'stale_core_boot' });
      }
      const result = await options.bridge.controlSession(body, (sid, operation) => options.coreAction(sid, operation, body.expectedCoreBootId));
      reply(result.ok ? 200 : 409, result);
    } catch {
      // Core errors can include user material. The wire exposes only a fixed diagnostic.
      reply(409, { ok: false, status: 'uncertain', error: 'session_control_rejected' });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('gateway_control_unavailable');
  }
  return {
    port: address.port,
    stop: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
    terminate: () => {
      server.closeAllConnections();
    },
  };
}
