import { afterEach, describe, expect, it, vi } from 'vitest';
import { startIpcServer, setIpcAuthSecret, setLarkAppId, routeHasNarrowUntrustedAuth,
  type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as recovery from '../src/core/failed-turn-recovery.js';
import * as pool from '../src/core/worker-pool.js';

const SECRET = 'isolated-recovery-ipc-test';
const PATH = '/api/sessions/test-session/failure-recovery';
let ipc: IpcServerHandle | undefined;
afterEach(async () => { await ipc?.close(); ipc = undefined; setIpcAuthSecret(null); vi.restoreAllMocks(); });
async function call(method: string, signed: boolean, body?: unknown) {
  if (!ipc) { setIpcAuthSecret(SECRET); setLarkAppId('cli_fixture'); ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true }); }
  const headers = signed ? daemonIpcAuthHeaders({ secret: SECRET, port: ipc.port, method, path: PATH,
    headers: { 'content-type': 'application/json' } }) : { 'content-type': 'application/json' };
  return fetch(`http://127.0.0.1:${ipc.port}${PATH}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
}
describe('privileged recovery HTTP boundary', () => {
  it('rejects unauthenticated calls and worker origin-capability claims', async () => {
    expect(routeHasNarrowUntrustedAuth('POST', PATH)).toBe(false);
    const execute = vi.spyOn(recovery, 'recoverFailedTurn');
    for (const body of [{}, { originCapability: 'ab'.repeat(32), originTurnId: 'om_actor' }]) {
      expect((await call('POST', false, body)).status).toBe(401);
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it('accepts a host-authenticated exact failure reference and rejects actor/input overrides', async () => {
    const execute = vi.spyOn(recovery, 'recoverFailedTurn').mockResolvedValue({ ok: true, state: 'accepted', sessionId: 'new', turnId: 'recovery', originalTurnId: 'om_original' });
    const body = { requestId: 'request-1', turnId: 'om_failed', failedAt: '2026-10-16T00:00:00.000Z', mode: 'fresh' };
    const response = await call('POST', true, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'accepted', sessionId: 'new' });
    expect(execute).toHaveBeenCalledWith('test-session', body);
    for (const extra of [{ callerOpenId: 'ou_other' }, { instruction: 'replacement' }]) {
      expect((await call('POST', true, { ...body, ...extra })).status).toBe(400);
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('returns a credential-free status projection for reconciliation', async () => {
    vi.spyOn(pool, 'findActiveBySessionId').mockReturnValue({ session: { lastFailedTurn: {
      turnId: 'om_failed', failedAt: '2026-10-16T00:00:00.000Z', userPrompt: 'private task',
      cliInput: 'private wrapped task', trustedCaller: { requestUserOpenId: 'ou_person' },
      recovery: { requestId: 'request', state: 'attempting', turnId: 'retry', sessionId: 'new', mode: 'fresh' },
    } } } as any);
    const response = await call('GET', true);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ failure: { actorBound: true, recovery: { state: 'attempting' } } });
    expect(text).not.toContain('private'); expect(text).not.toContain('ou_person'); expect(text).not.toContain('trustedCaller');
  });
});
