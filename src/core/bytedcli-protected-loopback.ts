import type { IncomingMessage } from 'node:http';
import { isLoopbackPeer } from '../utils/loopback-peers.js';
import { BYTEDCLI_EXEC_ROUTE, BYTEDCLI_EXEC_LIMITS } from '../cli/bytedcli-exec-protocol.js';
import { CURRENT_EXECUTION_ROUTE, CURRENT_EXECUTION_IDENTITY_ROUTE } from '../cli/current-execution.js';
import { CURRENT_ACTOR_ROUTE } from '../cli/current-actor.js';
import { GRANT_ROUTE_CLIENT_TIMEOUT_MS } from '../platform/credential-grant-budget.js';
import { resolveLoopbackPeerProcesses, type LoopbackPeerResolution } from './current-actor-attestation.js';
import { PROTECTED_LOOPBACK_ATTESTATION_HEADER, verifyProtectedLoopbackProxyAttestation } from './protected-loopback-attestation.js';
import type { ProtectedLoopbackService } from './protected-http-egress-host.js';
import type { DaemonSession } from './types.js';

export function bytedcliLoopbackServices(port: number): ProtectedLoopbackService[] {
  const routes: Array<[string, string, number]> = [
    ['bytedcli-exec', BYTEDCLI_EXEC_ROUTE, 180_000],
    ['current-execution', CURRENT_EXECUTION_ROUTE, 30_000],
    ['current-execution-identity', CURRENT_EXECUTION_IDENTITY_ROUTE, GRANT_ROUTE_CLIENT_TIMEOUT_MS],
    ['current-actor', CURRENT_ACTOR_ROUTE, GRANT_ROUTE_CLIENT_TIMEOUT_MS],
  ];
  return routes.map(([id, path, timeout]) => ({
    id, path, upstreamTimeoutMs: timeout,
    method: 'POST', listenPort: port, upstreamPort: port,
    forwardHeaders: ['content-type'], attestProcessPeer: true,
    ...(id === 'bytedcli-exec' ? { responseLimitBytes: 4 * Math.ceil(BYTEDCLI_EXEC_LIMITS.outputBytes / 3) + 4096 } : {}),
  }));
}

/** An invalid/retired relay signature must never fall back to proxy lineage. */
export async function resolveProtectedExecutionPeer(
  req: IncomingMessage, rawBody: Buffer, sessionId: string, serviceId: string,
  findSession: (id: string) => DaemonSession | undefined,
): Promise<LoopbackPeerResolution & { current?: () => boolean }> {
  const token = req.headers[PROTECTED_LOOPBACK_ATTESTATION_HEADER];
  if (token === undefined) return resolveLoopbackPeerProcesses({
    remoteAddress: req.socket.remoteAddress, remotePort: req.socket.remotePort, localPort: req.socket.localPort,
  });
  if (!isLoopbackPeer(req.socket.remoteAddress)) return { ok: false, reason: 'not_loopback' };
  const ds = findSession(sessionId), key = ds?.protectedLoopbackProxyAttestation;
  const contentType = req.headers['content-type'];
  if (typeof token !== 'string' || typeof contentType !== 'string' || !key
    || !ds?.worker || ds.worker.killed || ds.workerGeneration !== key.workerGeneration) {
    return { ok: false, reason: 'peer_unresolved' };
  }
  const worker = ds.worker;
  const turnId = ds.managedTurnOrigin?.turnId, dispatchAttempt = ds.managedTurnOrigin?.dispatchAttempt;
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  const expected = {
    sessionId, serviceId, workerGeneration: key.workerGeneration,
    ...(turnId ? { turnId } : {}),
    ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
    method: req.method ?? '', path, headers: { 'content-type': contentType }, body: rawBody,
  };
  const peer = verifyProtectedLoopbackProxyAttestation(key.secret, token, expected);
  const current = () => findSession(sessionId) === ds && ds.worker === worker && !worker.killed
    && ds.protectedLoopbackProxyAttestation === key && ds.workerGeneration === key.workerGeneration
    && ds.managedTurnOrigin?.turnId === turnId && ds.managedTurnOrigin?.dispatchAttempt === dispatchAttempt
    && verifyProtectedLoopbackProxyAttestation(key.secret, token, expected) !== null;
  return peer ? { ok: true, peer, current } : { ok: false, reason: 'peer_unresolved' };
}
