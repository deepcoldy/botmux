import { afterEach, describe, expect, it, vi } from 'bun:test';

vi.mock('../src/im/lark/identity-cache.js', () => ({
  resolveVerifiedUserIdentity: vi.fn(async (_app: string, openId: string) => ({
    openId, type: 'user', email: 'current.user@example.com',
  })),
}));

import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import * as workerPool from '../src/core/worker-pool.js';

let ipc: IpcServerHandle | null = null;

afterEach(async () => {
  if (ipc) await ipc.close();
  ipc = null;
  vi.restoreAllMocks();
});

function activeSession(): any {
  return {
    session: { sessionId: 's-actor', status: 'active' },
    chatId: 'oc_chat',
    larkAppId: 'cli_app',
    workerGeneration: 7,
    worker: { pid: process.pid, killed: false },
    localProcessAttestation: {
      backendType: 'pty',
      credentialIsolated: false,
      cliPid: process.pid,
      cliProcStart: readProcessStartIdentity(process.pid),
      workerGeneration: 7,
    },
    managedTurnOrigin: {
      capability: 'ca'.repeat(32),
      turnId: 'om_turn',
      callerOpenId: 'ou_current',
      preexistingProcessIdentities: [`${process.pid}:${readProcessStartIdentity(process.pid)}`],
    },
    initConfig: { apiOnly: false },
  };
}

describe('POST /api/current-actor', () => {
  it.skipIf(process.platform !== 'linux')('returns only the daemon-resolved actor for a live CLI descendant', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(activeSession());
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const response = await fetch(`http://127.0.0.1:${ipc.port}/api/current-actor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-actor', callerOpenId: 'ou_forged' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schema: 'botmux.current-actor.v2',
      status: 'verified',
      actor: { email: 'current.user@example.com' },
    });
  });

  it('fails closed when daemon live-turn state has no human caller', async () => {
    const ds = activeSession();
    delete ds.managedTurnOrigin.callerOpenId;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const response = await fetch(`http://127.0.0.1:${ipc.port}/api/current-actor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-actor' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      schema: 'botmux.current-actor.v2',
      status: 'blocked',
      error: 'current_actor_unverified',
    });
  });
});
