/**
 * Every path the native gateway builds from core/native-gateway-contract.ts
 * reaches a route the core's IPC server registered for that method — the
 * general daemon routes as well as the ones introduced for the gateway.
 *
 * Each request carries a stale expected-core-boot header: the server checks it
 * only after a route matched and before that route's handler runs, so a
 * registered route answers 409 `core_boot_changed` without touching any session,
 * and a path no route matches answers 404 `not_found`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import {
  EXPECTED_CORE_BOOT_HEADER,
  NATIVE_GATEWAY_TRIGGER_PATH,
  nativeGatewayAskCallbackPath,
  nativeGatewayAsksPath,
  nativeGatewayCoreProfilePath,
  nativeGatewayInterruptPath,
  nativeGatewayProgressPath,
  nativeGatewayReminderStatePath,
  nativeGatewaySessionActionPath,
  nativeGatewaySlashPath,
  nativeGatewaySourceIdentityPath,
  nativeGatewayTriggerResultPath,
  type NativeGatewaySessionAction,
} from '../src/core/native-gateway-contract.js';

const SECRET = 'native-gateway-contract-routes-secret';
const SESSION = 'session/with?odd#chars';
const TRIGGER = 'trigger&id';
const SESSION_ACTIONS: NativeGatewaySessionAction[] = ['close', 'prune', 'restart', 'wake', 'suspend'];

const GATEWAY_REQUESTS: ReadonlyArray<[method: 'GET' | 'POST', path: string]> = [
  ['POST', NATIVE_GATEWAY_TRIGGER_PATH],
  ['GET', nativeGatewayTriggerResultPath(SESSION, TRIGGER)],
  ['POST', nativeGatewayInterruptPath(SESSION, TRIGGER)],
  ['POST', nativeGatewaySlashPath(SESSION)],
  ...SESSION_ACTIONS.map(action => ['POST', nativeGatewaySessionActionPath(SESSION, action)] as ['POST', string]),
  ['GET', nativeGatewayAsksPath(SESSION, TRIGGER)],
  ['POST', nativeGatewayAskCallbackPath(SESSION)],
  ['GET', nativeGatewayProgressPath(SESSION, TRIGGER)],
  ['GET', nativeGatewayReminderStatePath(SESSION, TRIGGER)],
  ['GET', nativeGatewaySourceIdentityPath()],
  ['GET', nativeGatewaySourceIdentityPath(SESSION)],
  ['POST', nativeGatewayCoreProfilePath()],
];

let server: IpcServerHandle | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  setIpcAuthSecret(null);
  setLarkAppId('');
});

async function staleBootRequest(method: 'GET' | 'POST', path: string): Promise<{ status: number; error: unknown }> {
  if (!server) {
    setLarkAppId('local_contract_routes');
    setIpcAuthSecret(SECRET);
    server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
  }
  const body = method === 'POST' ? '{}' : undefined;
  const headers: Record<string, string> = { [EXPECTED_CORE_BOOT_HEADER]: 'not-this-boot' };
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    ...(body ? { body } : {}),
    headers: daemonIpcAuthHeaders({ secret: SECRET, port: server.port, method, path, headers }),
  });
  const payload = await response.json() as { error?: unknown };
  return { status: response.status, error: payload.error };
}

describe('native gateway contract routes', () => {
  it.each(GATEWAY_REQUESTS)('%s %s reaches a registered core route', async (method, path) => {
    expect(await staleBootRequest(method, path)).toEqual({ status: 409, error: 'core_boot_changed' });
  });

  it('a path no route serves is told apart (probe control)', async () => {
    expect(await staleBootRequest('GET', '/api/sessions/session/native-gateway-unknown'))
      .toEqual({ status: 404, error: 'not_found' });
    // Same path, wrong method: the method is part of what must match.
    expect(await staleBootRequest('GET', nativeGatewaySlashPath(SESSION)))
      .toEqual({ status: 404, error: 'not_found' });
  });
});
