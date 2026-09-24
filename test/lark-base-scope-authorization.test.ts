import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as botRegistry from '../src/bot-registry.js';
import * as identities from '../src/im/lark/identity-cache.js';
import * as tokens from '../src/utils/user-token.js';
import { isKnownLarkUserScope } from '../src/utils/lark-scope-catalog.js';

// Regression for the Base-authorization lockout: `botmux auth request --scope
// 'base:app:create'` (and `bitable:app`) was rejected with `unknown_scopes`
// before any authorize URL could be minted, because both names were absent from
// src/setup/lark-scopes.json. Feishu itself names these two as the candidate
// scopes for a user-token POST /open-apis/bitable/v1/apps (99991679), so a real
// Base scope must pass the gate; a misspelled one must still be rejected; and
// the user/turn binding the gate exists to protect must be unchanged either way.

const CAP = 'ab'.repeat(32);
let ipc: IpcServerHandle;
let session: any;

beforeEach(async () => {
  session = {
    session: { sessionId: 'auth-session', status: 'active' },
    larkAppId: 'cli_test', chatId: 'oc_test',
    worker: { killed: false }, workerGeneration: 4,
    managedTurnOrigin: { capability: CAP, turnId: 'om_turn', callerOpenId: 'ou_sender' },
  };
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 'auth-session' ? session : undefined);
  vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: { larkAppId: 'cli_test', larkAppSecret: 'test-secret', triggerUserAuth: { enabled: true, tools: ['lark-cli'], fallback: 'none' } } } as any);
  vi.spyOn(identities, 'getIdentity').mockReturnValue({ openId: 'ou_sender', type: 'user', source: 'sender', updatedAt: 0 } as any);
  vi.spyOn(identities, 'resolveVerifiedUserIdentity').mockResolvedValue(undefined);
  vi.spyOn(tokens, 'requestUserAuthorization').mockResolvedValue({
    authUrl: 'https://open.feishu.cn/authorize?x', scopes: ['base:app:create'], expiresIn: 600, poll: vi.fn(),
  } as any);
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});

afterEach(async () => {
  await ipc.close();
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

function post(overrides: Record<string, unknown> = {}) {
  const path = '/api/sessions/auth-session/auth-request';
  return fetch(`http://127.0.0.1:${ipc.port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scopes: ['base:app:create'], originCapability: CAP, originTurnId: 'om_turn', ...overrides }),
  });
}

describe('Base user scopes are in the catalog', () => {
  it('accepts the exact names Feishu returns for a user-token Base create', () => {
    expect(isKnownLarkUserScope('base:app:create')).toBe(true);
    expect(isKnownLarkUserScope('bitable:app')).toBe(true);
  });

  it('still rejects a misspelled Base scope', () => {
    expect(isKnownLarkUserScope('base:app:crate')).toBe(false);
    expect(isKnownLarkUserScope('bitable:apps')).toBe(false);
  });
});

describe('auth-request handler — Base scope authorization', () => {
  it('mints an authorize URL for a legal Base scope, bound to the verified caller', async () => {
    const res = await post({ scopes: ['base:app:create', 'bitable:app'] });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.authUrl).toContain('authorize');
    // the authorization is minted for exactly the requested scopes and the
    // verified caller — the binding the gate protects.
    expect(tokens.requestUserAuthorization).toHaveBeenCalledTimes(1);
    const call = vi.mocked(tokens.requestUserAuthorization).mock.calls[0];
    expect(call[3]).toEqual(['base:app:create', 'bitable:app']);
    expect(call[4]).toBe('ou_sender');
  });

  it('rejects a misspelled scope with unknown_scopes naming the typo, before any authorization', async () => {
    const res = await post({ scopes: ['base:app:crate'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'unknown_scopes', scopes: ['base:app:crate'] });
    expect(tokens.requestUserAuthorization).not.toHaveBeenCalled();
  });

  it('keeps user/turn binding: a legal Base scope on a stale turn is still 403, no authorization', async () => {
    const res = await post({ scopes: ['base:app:create'], originTurnId: 'om_earlier' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'current_actor_unverified' });
    expect(tokens.requestUserAuthorization).not.toHaveBeenCalled();
  });
});
