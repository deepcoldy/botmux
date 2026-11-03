import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as botRegistry from '../src/bot-registry.js';
import * as identities from '../src/im/lark/identity-cache.js';
import * as tokens from '../src/utils/user-token.js';
import { isKnownLarkUserScope } from '../src/utils/lark-scope-catalog.js';

// Regressions for valid user scopes being rejected with `unknown_scopes` before
// any authorize URL could be minted because the names were absent from
// src/setup/lark-scopes.json. Feishu itself names these scopes in 99991679
// responses, so real user scopes must pass the gate; misspelled ones must still
// be rejected; and the user/turn binding the gate protects must remain intact.

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
  it('accepts the exact names Feishu returns for a user-token Base create and v3 operations', () => {
    expect(isKnownLarkUserScope('base:app:create')).toBe(true);
    expect(isKnownLarkUserScope('bitable:app')).toBe(true);
    expect(isKnownLarkUserScope('base:app:read')).toBe(true);
    expect(isKnownLarkUserScope('base:table:read')).toBe(true);
    expect(isKnownLarkUserScope('base:field:read')).toBe(true);
    expect(isKnownLarkUserScope('base:record:read')).toBe(true);
    expect(isKnownLarkUserScope('base:view:read')).toBe(true);
    expect(isKnownLarkUserScope('base:record:create')).toBe(true);
    expect(isKnownLarkUserScope('base:record:update')).toBe(true);
    expect(isKnownLarkUserScope('base:record:delete')).toBe(true);
    expect(isKnownLarkUserScope('base:block:read')).toBe(true);
    expect(isKnownLarkUserScope('base:block:create')).toBe(true);
    expect(isKnownLarkUserScope('base:block:delete')).toBe(true);
    expect(isKnownLarkUserScope('base:block:update')).toBe(true);
    expect(isKnownLarkUserScope('base:appmode:read')).toBe(true);
    expect(isKnownLarkUserScope('base:appmode:create')).toBe(true);
    expect(isKnownLarkUserScope('base:appmode_page:read')).toBe(true);
    expect(isKnownLarkUserScope('base:appmode_page:delete')).toBe(true);
    expect(isKnownLarkUserScope('base:appmode_block:read')).toBe(true);
    expect(isKnownLarkUserScope('base:workspace:read')).toBe(true);
    expect(isKnownLarkUserScope('base:workspace:create')).toBe(true);
    expect(isKnownLarkUserScope('base:workspace:update')).toBe(true);
  });

  it('still rejects a misspelled Base scope', () => {
    expect(isKnownLarkUserScope('base:app:crate')).toBe(false);
    expect(isKnownLarkUserScope('base:table:raed')).toBe(false);
    expect(isKnownLarkUserScope('bitable:apps')).toBe(false);
  });

  it('allows uncataloged scopes when allowUnknown or BOTMUX_ALLOW_UNKNOWN_SCOPES is enabled', () => {
    expect(isKnownLarkUserScope('future:service:read')).toBe(false);
    expect(isKnownLarkUserScope('future:service:read', { allowUnknown: true })).toBe(true);
    expect(isKnownLarkUserScope('bad scope syntax', { allowUnknown: true })).toBe(false);

    const prev = process.env.BOTMUX_ALLOW_UNKNOWN_SCOPES;
    try {
      process.env.BOTMUX_ALLOW_UNKNOWN_SCOPES = '1';
      expect(isKnownLarkUserScope('future:service:read')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.BOTMUX_ALLOW_UNKNOWN_SCOPES;
      else process.env.BOTMUX_ALLOW_UNKNOWN_SCOPES = prev;
    }
  });
});

describe('Contact user search scope is in the catalog', () => {
  it('accepts the exact scope Feishu requires for contact +search-user', () => {
    expect(isKnownLarkUserScope('contact:user:search')).toBe(true);
  });

  it('still rejects a misspelled contact search scope', () => {
    expect(isKnownLarkUserScope('contact:user:serach')).toBe(false);
  });
});

describe('auth-request handler — user scope authorization', () => {
  it('mints an authorize URL for legal Base v3 scopes, bound to the verified caller', async () => {
    const scopes = ['base:app:read', 'base:table:read', 'base:field:read', 'base:record:read'];
    const res = await post({ scopes });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.authUrl).toContain('authorize');
    expect(tokens.requestUserAuthorization).toHaveBeenCalledTimes(1);
    const call = vi.mocked(tokens.requestUserAuthorization).mock.calls[0];
    expect(call[3]).toEqual(scopes);
    expect(call[4]).toBe('ou_sender');
  });

  it('rejects a misspelled scope with unknown_scopes naming the typo, before any authorization', async () => {
    const res = await post({ scopes: ['base:app:crate'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'unknown_scopes', scopes: ['base:app:crate'] });
    expect(tokens.requestUserAuthorization).not.toHaveBeenCalled();
  });

  it('mints an authorize URL for uncataloged scope when allowUnknown=true', async () => {
    const res = await post({ scopes: ['future:new:capability'], allowUnknown: true });
    expect(res.status).toBe(200);
    expect(tokens.requestUserAuthorization).toHaveBeenCalledTimes(1);
    const call = vi.mocked(tokens.requestUserAuthorization).mock.calls[0];
    expect(call[3]).toEqual(['future:new:capability']);
  });

  it('mints an authorize URL for uncataloged scope when BOTMUX_ALLOW_UNKNOWN_SCOPES=1 in environment', async () => {
    const prev = process.env.BOTMUX_ALLOW_UNKNOWN_SCOPES;
    try {
      process.env.BOTMUX_ALLOW_UNKNOWN_SCOPES = '1';
      const res = await post({ scopes: ['future:env:capability'] });
      expect(res.status).toBe(200);
      expect(tokens.requestUserAuthorization).toHaveBeenCalledTimes(1);
      const call = vi.mocked(tokens.requestUserAuthorization).mock.calls[0];
      expect(call[3]).toEqual(['future:env:capability']);
    } finally {
      if (prev === undefined) delete process.env.BOTMUX_ALLOW_UNKNOWN_SCOPES;
      else process.env.BOTMUX_ALLOW_UNKNOWN_SCOPES = prev;
    }
  });

  it('rejects malformed scope even when allowUnknown=true', async () => {
    const res = await post({ scopes: ['bad scope syntax'], allowUnknown: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'unknown_scopes', scopes: ['bad scope syntax'] });
    expect(tokens.requestUserAuthorization).not.toHaveBeenCalled();
  });

  it('mints an authorize URL for contact user search instead of rejecting it as unknown', async () => {
    const res = await post({ scopes: ['contact:user:search'] });
    expect(res.status).toBe(200);
    expect(tokens.requestUserAuthorization).toHaveBeenCalledTimes(1);
    const call = vi.mocked(tokens.requestUserAuthorization).mock.calls[0];
    expect(call[3]).toEqual(['contact:user:search']);
    expect(call[4]).toBe('ou_sender');
  });

  it('keeps user/turn binding: a legal Base scope on a stale turn is still 403, no authorization', async () => {
    const res = await post({ scopes: ['base:app:create'], originTurnId: 'om_earlier' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'current_actor_unverified' });
    expect(tokens.requestUserAuthorization).not.toHaveBeenCalled();
  });
});
