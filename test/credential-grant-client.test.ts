/**
 * Platform credential-grant client: request shape, response validation and
 * failure classification, with the platform faked at the http seam.
 *
 * Run:  npx vitest run --project unit test/credential-grant-client.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import {
  requestCredentialGrant,
  platformCredentialsUrl,
  CREDENTIAL_GRANT_PATH,
  type CredentialGrantClientOptions,
} from '../src/platform/credential-grant-client.js';

const BINDING = { platformUrl: 'https://platform.example.test/', machineToken: 'mt-secret', machineId: 'm-1' };

function fakeHttp(responses: Array<{ status: number; json: unknown } | Error>) {
  const calls: Array<{ url: string; body: unknown; opts: any }> = [];
  const http: NonNullable<CredentialGrantClientOptions['http']> = {
    post: async (url, body, opts) => {
      calls.push({ url, body, opts });
      const next = responses.shift();
      if (!next) throw new Error('no scripted response');
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { calls, http };
}

const REQ = { tool: 'lark-cli' as const, unionId: 'on_alice', appId: 'cli_bot', sessionId: 'sess-1', turnId: 'om_turn' };
const future = () => Date.now() + 3_600_000;

describe('requestCredentialGrant', () => {
  it('is unbound without a platform binding and never calls out', async () => {
    const { calls, http } = fakeHttp([]);
    const r = await requestCredentialGrant(REQ, { binding: null, http });
    expect(r).toEqual({ ok: false, reason: 'unbound' });
    expect(calls).toHaveLength(0);
    expect(platformCredentialsUrl({ binding: null })).toBeNull();
  });

  it('posts the turn sender, tool and machine with the machine token', async () => {
    const { calls, http } = fakeHttp([{ status: 200, json: {
      ok: true, tool: 'lark-cli', unionId: 'on_alice', expiresAt: future(),
      variables: { LARKSUITE_CLI_APP_ID: 'cli_platform', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'u-at' },
    } }]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.variables).toEqual({ LARKSUITE_CLI_APP_ID: 'cli_platform', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'u-at' });
    expect(calls[0]!.url).toBe(`https://platform.example.test${CREDENTIAL_GRANT_PATH}`);
    expect(calls[0]!.opts.headers.authorization).toBe('Bearer mt-secret');
    expect(calls[0]!.body).toEqual({
      unionId: 'on_alice', tool: 'lark-cli', appId: 'cli_bot', sessionId: 'sess-1', turnId: 'om_turn', machineId: 'm-1',
    });
    expect(platformCredentialsUrl({ binding: BINDING })).toBe('https://platform.example.test/credentials');
  });

  it('accepts the optional Codebase JWT for bytedcli', async () => {
    const { http } = fakeHttp([{ status: 200, json: {
      ok: true, tool: 'bytedcli', unionId: 'on_alice', expiresAt: future(),
      variables: { BYTEDCLI_USER_CLOUD_JWT: 'cloud', BYTEDCLI_USER_CODE_JWT: 'code' },
    } }]);
    const r = await requestCredentialGrant({ ...REQ, tool: 'bytedcli' }, { binding: BINDING, http });
    expect(r.ok && r.value.variables).toEqual({ BYTEDCLI_USER_CLOUD_JWT: 'cloud', BYTEDCLI_USER_CODE_JWT: 'code' });
  });

  it.each([
    ['extra variables', { LARKSUITE_CLI_APP_ID: 'a', LARKSUITE_CLI_USER_ACCESS_TOKEN: 't', PATH: '/evil' }],
    ['missing required', { LARKSUITE_CLI_APP_ID: 'a' }],
    ['newline in value', { LARKSUITE_CLI_APP_ID: 'a', LARKSUITE_CLI_USER_ACCESS_TOKEN: 't\nexport X=1' }],
  ])('rejects a lark-cli grant with %s — the platform cannot inject arbitrary env', async (_label, variables) => {
    const { http } = fakeHttp([{ status: 200, json: { ok: true, tool: 'lark-cli', unionId: 'on_alice', expiresAt: future(), variables } }]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('invalid_response');
  });

  it.each([
    ['missing cloud JWT', { BYTEDCLI_USER_CODE_JWT: 'code' }],
    ['lark keys smuggled into a bytedcli grant', { BYTEDCLI_USER_CLOUD_JWT: 'c', LARKSUITE_CLI_USER_ACCESS_TOKEN: 't' }],
    ['empty required value', { BYTEDCLI_USER_CLOUD_JWT: '' }],
  ])('rejects a bytedcli grant with %s', async (_label, variables) => {
    const { http } = fakeHttp([{ status: 200, json: { ok: true, tool: 'bytedcli', unionId: 'on_alice', expiresAt: future(), variables } }]);
    const r = await requestCredentialGrant({ ...REQ, tool: 'bytedcli' }, { binding: BINDING, http });
    expect(!r.ok && r.reason).toBe('invalid_response');
  });

  it('accepts a bytedcli grant with only the cloud JWT (Codebase JWT is optional)', async () => {
    const { http } = fakeHttp([{ status: 200, json: { ok: true, tool: 'bytedcli', unionId: 'on_alice', expiresAt: future(), variables: { BYTEDCLI_USER_CLOUD_JWT: 'cloud' } } }]);
    const r = await requestCredentialGrant({ ...REQ, tool: 'bytedcli' }, { binding: BINDING, http });
    expect(r.ok && r.value.variables).toEqual({ BYTEDCLI_USER_CLOUD_JWT: 'cloud' });
  });

  it('passes retryAfterMs through on 429 so callers can back off', async () => {
    const { http } = fakeHttp([{ status: 429, json: { error: 'rate_limited', retryAfterMs: 750 } }]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(!r.ok && r.reason === 'rate_limited' && r.retryAfterMs).toBe(750);
  });

  it.each([
    ['tool mismatch', { ok: true, tool: 'bytedcli', unionId: 'on_alice', expiresAt: future(), variables: {} }],
    ['unionId mismatch', { ok: true, tool: 'lark-cli', unionId: 'on_mallory', expiresAt: future(), variables: {} }],
    ['already expired', { ok: true, tool: 'lark-cli', unionId: 'on_alice', expiresAt: Date.now() - 1, variables: { LARKSUITE_CLI_APP_ID: 'a', LARKSUITE_CLI_USER_ACCESS_TOKEN: 't' } }],
    ['ok flag missing', { tool: 'lark-cli', unionId: 'on_alice', expiresAt: future(), variables: {} }],
  ])('rejects a 200 with %s', async (_label, json) => {
    const { http } = fakeHttp([{ status: 200, json }]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(!r.ok && r.reason).toBe('invalid_response');
  });

  it.each([
    [404, { error: 'credential_not_found', authorizeUrl: 'https://platform.example.test/credentials' }, 'not_authorized'],
    [409, { error: 'credential_reauth_required' }, 'not_authorized'],
    [403, { error: 'consent_missing', authorizeUrl: 'https://platform.example.test/credentials' }, 'consent_missing'],
    [403, { error: 'not_teammate' }, 'not_teammate'],
    [403, { error: 'machine_ownership_mismatch' }, 'forbidden'],
    [401, { error: 'invalid_machine_token' }, 'forbidden'],
    [404, {}, 'not_deployed'],
    [429, { error: 'rate_limited', retryAfterMs: 500 }, 'rate_limited'],
    [503, { error: 'store_unavailable' }, 'unavailable'],
    [502, { error: 'provider_unavailable' }, 'unavailable'],
    [400, { error: 'invalid' }, 'client'],
  ])('classifies %s %j as %s', async (status, json, reason) => {
    const { http } = fakeHttp([{ status, json }]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe(reason);
    if (!r.ok && (r.reason === 'not_authorized' || r.reason === 'consent_missing') && (json as any).authorizeUrl) {
      expect(r.authorizeUrl).toBe((json as any).authorizeUrl);
    }
  });

  it('classifies any other 404 (older platform, generic router body) as not_deployed', async () => {
    const { http } = fakeHttp([{ status: 404, json: { error: 'Not Found', message: 'Route POST:/v1/machine/credential-grant not found' } }]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(!r.ok && r.reason).toBe('not_deployed');
  });

  it('relays authorizeUrl only when it is an https link on the bound platform', async () => {
    const { http } = fakeHttp([
      { status: 404, json: { error: 'credential_not_found', authorizeUrl: 'https://evil.example.test/phish' } },
      { status: 404, json: { error: 'credential_not_found', authorizeUrl: 'https://platform.example.test/credentials' } },
    ]);
    const r1 = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(!r1.ok && r1.reason === 'not_authorized' && r1.authorizeUrl).toBeUndefined();
    const r2 = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(!r2.ok && r2.reason === 'not_authorized' && r2.authorizeUrl).toBe('https://platform.example.test/credentials');
  });

  it('caps an absurd expiresAt at 24h and refuses an invalid union id before calling out', async () => {
    const { calls, http } = fakeHttp([{ status: 200, json: {
      ok: true, tool: 'lark-cli', unionId: 'on_alice', expiresAt: Date.now() + 365 * 24 * 3_600_000,
      variables: { LARKSUITE_CLI_APP_ID: 'a', LARKSUITE_CLI_USER_ACCESS_TOKEN: 't' },
    } }]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(r.ok && r.value.expiresAt <= Date.now() + 24 * 3_600_000 + 1000).toBe(true);
    const bad = await requestCredentialGrant({ ...REQ, unionId: '' }, { binding: BINDING, http });
    expect(!bad.ok && bad.reason).toBe('client');
    expect(calls).toHaveLength(1);
  });

  it('turns a thrown transport error into network, not an exception', async () => {
    const { calls, http } = fakeHttp([new Error('ECONNREFUSED'), new Error('ECONNREFUSED')]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(r).toEqual({ ok: false, reason: 'network', error: 'ECONNREFUSED (after retry)' });
    expect(calls).toHaveLength(2);
  });
});

const GRANT_200 = { status: 200, json: {
  ok: true, tool: 'lark-cli', unionId: 'on_alice', expiresAt: future(),
  variables: { LARKSUITE_CLI_APP_ID: 'cli_platform', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'u-at' },
} };

describe('requestCredentialGrant transport failures', () => {
  it('retries once on a new connection after a reset, and every attempt asks for its own connection', async () => {
    const { calls, http } = fakeHttp([Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), GRANT_200]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.every(c => c.opts.freshConnection === true)).toBe(true);
    expect(calls[1]!.body).toEqual(calls[0]!.body);
  });

  it.each([
    [403, { error: 'forbidden' }, 'forbidden'],
    [403, { error: 'not_teammate' }, 'not_teammate'],
    [404, { error: 'credential_not_found' }, 'not_authorized'],
    [503, { error: 'store_unavailable' }, 'unavailable'],
    [429, { error: 'rate_limited' }, 'rate_limited'],
  ])('an HTTP %s answer is the platform\'s verdict and is not retried', async (status, json, reason) => {
    const { calls, http } = fakeHttp([{ status, json }, GRANT_200]);
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http });
    expect(!r.ok && r.reason).toBe(reason);
    expect(calls).toHaveLength(1);
  });

  it('caps the whole call, retry included, at the total budget even when the transport never settles', async () => {
    const calls: number[] = [];
    const http = { post: (_u: string, _b: unknown, opts: any) => { calls.push(opts.timeoutMs); return new Promise<never>(() => {}); } };
    const t0 = Date.now();
    const r = await requestCredentialGrant(REQ, { binding: BINDING, http: http as any, timeoutMs: 200, totalBudgetMs: 1_400 });
    const elapsed = Date.now() - t0;
    expect(!r.ok && r.reason).toBe('network');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(200);
    expect(calls[0]! + calls[1]!).toBeLessThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(1_400 + 300);
  });

  // A transport may throw BEFORE returning its promise: `postJson` parses the
  // URL and serializes the body ahead of its own `new Promise`, so a malformed
  // binding (`platform.json` hand-edited or from an older build) throws
  // synchronously. The retry itself was never the defect — the throw reaches
  // the attempt's catch either way, so `calls` is 2 before and after the fix;
  // that assertion is documentary. What the fix buys is the second half: with
  // `run` raced directly, the race is never built, so the attempt's timeout
  // promise has no consumer and its timer fires as an unhandledRejection. The
  // unhandledRejection check below is the guard that actually bites.
  it.each([
    ['through the real postJson with an unusable platform URL', undefined],
    ['through an injected transport that throws synchronously', 'sync'],
  ] as const)('leaves no unhandled timeout rejection when the transport throws synchronously %s', async (_label, mode) => {
    const unhandled: string[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason instanceof Error ? reason.message : String(reason)); };
    process.on('unhandledRejection', onUnhandled);
    try {
      let calls = 0;
      const http = mode === 'sync'
        ? { post: (() => { calls++; throw new Error('sync-throw'); }) as any }
        : undefined;
      const binding = mode === 'sync'
        ? { platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' }
        : { platformUrl: 'not-a-url', machineToken: 'mt', machineId: 'm-1' };
      const r = await requestCredentialGrant(REQ, { binding, ...(http ? { http } : {}), timeoutMs: 200, totalBudgetMs: 3_000 });
      expect(!r.ok && r.reason).toBe('network');
      // Documentary: the retry happens with or without the fix (the throw is
      // caught by the attempt loop). The unhandledRejection assertion is the guard.
      if (http) expect(calls).toBe(2);
      // Give the abandoned attempt's timer a chance to fire (timeoutMs is 200).
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 10_000);
});

describe('requestCredentialGrant against a real server (postJson transport)', () => {
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(r))));
  });

  async function platform(handler: (n: number, res: ServerResponse, remotePort: number) => void) {
    let n = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => handler(++n, res, req.socket.remotePort ?? 0));
    });
    server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.keepAliveTimeout = 60_000;
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return { platformUrl: `http://127.0.0.1:${port}`, machineToken: 'mt', machineId: 'm-1' };
  }
  const answer = (res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(GRANT_200.json));
  };

  it('first request gets no response at all, the retry on a new connection succeeds', async () => {
    const ports: number[] = [];
    const binding = await platform((n, res, port) => {
      ports.push(port);
      if (n === 1) return; // silent: never answers
      answer(res);
    });
    const t0 = Date.now();
    const r = await requestCredentialGrant(REQ, { binding, timeoutMs: 300, totalBudgetMs: 2_000 });
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(ports).toHaveLength(2);
    expect(ports[1]).not.toBe(ports[0]);
  });

  it('does not ride the previous grant\'s keep-alive connection', async () => {
    const ports: number[] = [];
    const binding = await platform((_n, res, port) => { ports.push(port); answer(res); });
    expect((await requestCredentialGrant(REQ, { binding })).ok).toBe(true);
    expect((await requestCredentialGrant(REQ, { binding })).ok).toBe(true);
    expect(ports).toHaveLength(2);
    expect(ports[1]).not.toBe(ports[0]);
  });

  it('a peer that trickles bytes is cut at the hard timeout: the first request does not linger', async () => {
    const closedAt: number[] = [];
    let first: ServerResponse | undefined;
    const binding = await platform((n, res) => {
      if (n === 1) {
        first = res;
        res.socket?.on('close', () => closedAt.push(Date.now()));
        res.writeHead(200, { 'content-type': 'application/json' });
        const tick = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(' '); else clearInterval(tick); }, 50);
        res.on('close', () => clearInterval(tick));
        return;
      }
      answer(res);
    });
    const t0 = Date.now();
    const r = await requestCredentialGrant(REQ, { binding, timeoutMs: 300, totalBudgetMs: 2_000 });
    expect(r.ok).toBe(true);
    // Idle timeout alone never fires on a trickle; the abort must have closed it.
    await new Promise(res => setTimeout(res, 100));
    expect(first).toBeDefined();
    expect(closedAt).toHaveLength(1);
    expect(closedAt[0]! - t0).toBeLessThan(1_000);
  });

  it('a real 403 is returned after one request', async () => {
    let hits = 0;
    const binding = await platform((_n, res) => {
      hits++;
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'machine_ownership_mismatch' }));
    });
    const r = await requestCredentialGrant(REQ, { binding });
    expect(!r.ok && r.reason).toBe('forbidden');
    expect(hits).toBe(1);
  });
});
