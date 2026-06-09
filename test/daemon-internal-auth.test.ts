import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  BODY_LIMIT_BYTES,
  NONCE_TTL_MS,
  TS_WINDOW_MS,
  checkSig,
  createNonceStore,
  isLoopback,
  readBodyRaw,
  signDaemonRequest,
  verifyDaemonRequest,
  type ClockLike,
} from '../src/dashboard/daemon-internal-auth.js';

const SECRET = 'test-secret-base64url-string';

function fixedClock(initialMs: number): ClockLike & { advance(deltaMs: number): void; nowMs: number } {
  const c = {
    nowMs: initialMs,
    now() { return c.nowMs; },
    advance(deltaMs: number) { c.nowMs += deltaMs; },
  };
  return c;
}

/**
 * Build a fake `IncomingMessage` from a body string + headers map. The body is
 * exposed as an async iterable, so `readBodyRaw` and `verifyDaemonRequest`
 * consume it exactly like a real request stream.
 */
function makeReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  remoteAddr?: string;
}): IncomingMessage {
  const body = opts.body ?? '';
  const stream = Readable.from([Buffer.from(body, 'utf8')]);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
  const req = Object.assign(stream, {
    method: opts.method ?? 'POST',
    url: opts.url ?? '/__daemon/test',
    headers,
    socket: { remoteAddress: opts.remoteAddr ?? '127.0.0.1' } as any,
  }) as unknown as IncomingMessage;
  return req;
}

function signedHeaders(opts: {
  ts: string;
  nonce: string;
  method: string;
  url: string;
  body: string;
  appId?: string;
}): Record<string, string> {
  const { wire } = signDaemonRequest({
    secret: SECRET,
    ts: opts.ts,
    nonce: opts.nonce,
    method: opts.method,
    pathWithQuery: opts.url,
    bodyRaw: opts.body,
  });
  return {
    'x-botmux-daemon-ts': opts.ts,
    'x-botmux-daemon-nonce': opts.nonce,
    'x-botmux-daemon-sig': wire,
    'x-botmux-daemon-appid': opts.appId ?? 'cli_test',
  };
}

describe('signDaemonRequest', () => {
  const baseInput = {
    secret: SECRET,
    ts: '1700000000000',
    nonce: 'nonce-abc',
    method: 'POST',
    pathWithQuery: '/__daemon/sessions/abc/close',
    bodyRaw: '{"hello":"world"}',
  };

  it('produces a deterministic wire+raw pair for fixed input (golden value)', () => {
    const a = signDaemonRequest(baseInput);
    const b = signDaemonRequest(baseInput);
    expect(a.wire).toBe(b.wire);
    expect(a.raw.equals(b.raw)).toBe(true);
    // base64url has no padding and uses URL-safe alphabet.
    expect(a.wire).toMatch(/^[A-Za-z0-9_-]+$/);
    // Frozen expected value — any change to the signing material order or
    // separator will flip this byte string, catching accidental drift.
    expect(a.wire).toBe('NbtzoO3kRO4e1aUWs8PXoNC2s95dPgSC9_DZBJhyzdc');
  });

  it('produces a different wire when the body changes by one byte', () => {
    const tampered = signDaemonRequest({ ...baseInput, bodyRaw: '{"hello":"World"}' });
    const original = signDaemonRequest(baseInput);
    expect(tampered.wire).not.toBe(original.wire);
  });

  it('normalises the method (input case-insensitive on caller side)', () => {
    const lower = signDaemonRequest({ ...baseInput, method: 'post' });
    const upper = signDaemonRequest({ ...baseInput, method: 'POST' });
    expect(lower.wire).toBe(upper.wire);
  });

  it('treats query-string reordering as a different signature (no canonicalisation)', () => {
    const a = signDaemonRequest({ ...baseInput, pathWithQuery: '/__daemon/foo?x=1&y=2' });
    const b = signDaemonRequest({ ...baseInput, pathWithQuery: '/__daemon/foo?y=2&x=1' });
    expect(a.wire).not.toBe(b.wire);
  });

  it('produces a different wire when the nonce changes', () => {
    const a = signDaemonRequest({ ...baseInput, nonce: 'nonce-1' });
    const b = signDaemonRequest({ ...baseInput, nonce: 'nonce-2' });
    expect(a.wire).not.toBe(b.wire);
  });

  it('produces a different wire when the timestamp changes', () => {
    const a = signDaemonRequest({ ...baseInput, ts: '1700000000000' });
    const b = signDaemonRequest({ ...baseInput, ts: '1700000000001' });
    expect(a.wire).not.toBe(b.wire);
  });
});

describe('checkSig', () => {
  it('returns true for matching wire signature, false otherwise', () => {
    const { wire, raw } = signDaemonRequest({
      secret: SECRET, ts: '1', nonce: 'n', method: 'GET', pathWithQuery: '/', bodyRaw: '',
    });
    expect(checkSig(wire, raw)).toBe(true);
    expect(checkSig(wire, Buffer.alloc(raw.length, 0))).toBe(false);
  });

  it('returns false rather than throwing when the provided wire is malformed', () => {
    expect(() => checkSig('@@not_b64@@', Buffer.alloc(32))).not.toThrow();
    expect(checkSig('@@not_b64@@', Buffer.alloc(32))).toBe(false);
  });

  it('rejects mismatched length without crashing timingSafeEqual', () => {
    const { raw } = signDaemonRequest({
      secret: SECRET, ts: '1', nonce: 'n', method: 'GET', pathWithQuery: '/', bodyRaw: '',
    });
    const tooShort = Buffer.alloc(16, 1).toString('base64url');
    expect(checkSig(tooShort, raw)).toBe(false);
  });
});

describe('isLoopback', () => {
  it('accepts 127.0.0.1, ::1, and IPv4-mapped loopback; rejects everything else', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('192.168.1.1')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
    expect(isLoopback('')).toBe(false);
  });
});

describe('createNonceStore', () => {
  it('records a nonce and rejects re-use until TTL expires', () => {
    const clock = fixedClock(1_000_000);
    const store = createNonceStore(clock);
    expect(store.has('n1')).toBe(false);
    store.add('n1', clock.now() + 1000);
    expect(store.has('n1')).toBe(true);

    clock.advance(1001);
    // Lazy GC on next `has()` evicts the expired entry.
    expect(store.has('n1')).toBe(false);
    expect(store.size()).toBe(0);
  });
});

describe('readBodyRaw', () => {
  it('reads the full body when under the cap', async () => {
    const req = makeReq({ body: 'hello world' });
    const raw = await readBodyRaw(req);
    expect(raw).toBe('hello world');
  });

  it('returns null when the body exceeds the cap', async () => {
    const req = makeReq({ body: 'x'.repeat(1024) });
    const raw = await readBodyRaw(req, { maxBytes: 100 });
    expect(raw).toBeNull();
  });

  it('returns "" when the body is empty', async () => {
    const req = makeReq({ body: '' });
    const raw = await readBodyRaw(req);
    expect(raw).toBe('');
  });
});

describe('verifyDaemonRequest happy path', () => {
  it('accepts a correctly signed request and returns bodyRaw + appId', async () => {
    const clock = fixedClock(2_000_000);
    const ts = String(clock.now());
    const body = '{"foo":"bar"}';
    const headers = signedHeaders({
      ts, nonce: 'n-ok', method: 'POST', url: '/__daemon/sessions/abc/close', body,
    });
    const req = makeReq({ method: 'POST', url: '/__daemon/sessions/abc/close', headers, body });
    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), { clock });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    expect(out.bodyRaw).toBe(body);
    expect(out.appId).toBe('cli_test');
  });
});

describe('verifyDaemonRequest rejection matrix', () => {
  const url = '/__daemon/test';

  async function signedRequest(overrides: {
    body?: string;
    ts?: string;
    nonce?: string;
    method?: string;
    url?: string;
    remoteAddr?: string;
    omitHeader?: string;
    signWith?: { method?: string; url?: string; body?: string };
  } = {}): Promise<{ req: IncomingMessage; clock: ClockLike }> {
    const clock = fixedClock(3_000_000);
    const ts = overrides.ts ?? String(clock.now());
    const nonce = overrides.nonce ?? `nonce-${Math.random().toString(36).slice(2)}`;
    const method = overrides.method ?? 'POST';
    const reqUrl = overrides.url ?? url;
    const body = overrides.body ?? '';
    const signOpts = {
      ts,
      nonce,
      method: overrides.signWith?.method ?? method,
      url: overrides.signWith?.url ?? reqUrl,
      body: overrides.signWith?.body ?? body,
    };
    const headers = signedHeaders(signOpts);
    if (overrides.omitHeader) delete headers[overrides.omitHeader];
    const req = makeReq({
      method,
      url: reqUrl,
      headers,
      body,
      remoteAddr: overrides.remoteAddr,
    });
    return { req, clock };
  }

  it('rejects ts more than 60s in the future (ts_window)', async () => {
    const clock = fixedClock(4_000_000);
    const future = String(clock.now() + TS_WINDOW_MS + 1);
    const { req } = await signedRequest({ ts: future });
    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), { clock });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('ts_window');
    expect(out.httpStatus).toBe(401);
  });

  it('rejects ts more than 60s in the past (ts_window)', async () => {
    const clock = fixedClock(4_000_000);
    const past = String(clock.now() - TS_WINDOW_MS - 1);
    const { req } = await signedRequest({ ts: past });
    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), { clock });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('ts_window');
  });

  it('rejects malformed ts (not a number)', async () => {
    const { req, clock } = await signedRequest({ ts: 'not-a-number' });
    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), { clock });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('ts_malformed');
  });

  it('rejects ts with trailing garbage like "3000000abc" (B2)', async () => {
    const { req, clock } = await signedRequest({ ts: '3000000abc' });
    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), { clock });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('ts_malformed');
  });

  it('rejects non-integer ts like "3000000.5" (B2)', async () => {
    const { req, clock } = await signedRequest({ ts: '3000000.5' });
    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), { clock });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('ts_malformed');
  });

  it('rejects empty ts string (B2)', async () => {
    const { req, clock } = await signedRequest({ ts: '' });
    // signedHeaders treats ts='' as missing in some paths; here we reach the
    // typed-string branch and Number('') is 0 which is a valid integer — but
    // the `missing_header` guard fires first because empty strings fail the
    // truthy `!ts || !nonce` check.
    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), { clock });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('missing_header');
  });

  it('rejects a replayed nonce', async () => {
    const clock = fixedClock(5_000_000);
    const store = createNonceStore(clock);
    const ts = String(clock.now());
    const nonce = 'replay-me';

    // First request — accepted, nonce recorded.
    const first = await signedRequest({ ts, nonce });
    const ok = await verifyDaemonRequest(first.req, SECRET, store, { clock });
    expect(ok.ok).toBe(true);

    // Second request with the same (ts, nonce) — rejected.
    const second = await signedRequest({ ts, nonce });
    const replay = await verifyDaemonRequest(second.req, SECRET, store, { clock });
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error('unreachable');
    expect(replay.reason).toBe('replay');
  });

  it('rejects body tampering (sig_mismatch)', async () => {
    const { req, clock } = await signedRequest({
      body: '{"v":1}',
      signWith: { body: '{"v":2}' },
    });
    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), { clock });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('sig_mismatch');
  });

  it('rejects method tampering (sig_mismatch)', async () => {
    const { req, clock } = await signedRequest({
      method: 'POST',
      signWith: { method: 'GET' },
    });
    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), { clock });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('sig_mismatch');
  });

  it('rejects path tampering (sig_mismatch)', async () => {
    const { req, clock } = await signedRequest({
      url: '/__daemon/foo',
      signWith: { url: '/__daemon/bar' },
    });
    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), { clock });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('sig_mismatch');
  });

  it('rejects query reordering (sig_mismatch — no canonicalisation)', async () => {
    const { req, clock } = await signedRequest({
      url: '/__daemon/foo?a=1&b=2',
      signWith: { url: '/__daemon/foo?b=2&a=1' },
    });
    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), { clock });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('sig_mismatch');
  });

  it('rejects missing headers (missing_header)', async () => {
    const { req, clock } = await signedRequest({ omitHeader: 'x-botmux-daemon-sig' });
    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), { clock });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('missing_header');
    expect(out.httpStatus).toBe(400);
  });

  it('rejects non-loopback addresses (remote_not_loopback)', async () => {
    const { req, clock } = await signedRequest({ remoteAddr: '203.0.113.4' });
    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), { clock });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('remote_not_loopback');
    expect(out.httpStatus).toBe(403);
  });

  it('rejects duplicate (array) headers — does not silently take the first (B3)', async () => {
    const clock = fixedClock(9_000_000);
    const ts = String(clock.now());
    const body = '';
    const goodHeaders = signedHeaders({ ts, nonce: 'dup-test', method: 'POST', url: '/__daemon/x', body });
    // Simulate an injected duplicate header by passing an array value for x-botmux-daemon-sig.
    const stream = Readable.from([Buffer.from(body, 'utf8')]);
    const headers: Record<string, string | string[]> = { ...goodHeaders };
    headers['x-botmux-daemon-sig'] = [goodHeaders['x-botmux-daemon-sig'], 'attacker-injected-sig'];
    const req = Object.assign(stream, {
      method: 'POST',
      url: '/__daemon/x',
      headers,
      socket: { remoteAddress: '127.0.0.1' } as any,
    }) as unknown as IncomingMessage;

    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), { clock });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('missing_header');
  });
});

describe('verifyDaemonRequest body single-read contract', () => {
  it('drains the request stream — a second read returns 0 bytes (B1)', async () => {
    const clock = fixedClock(6_000_000);
    const body = '{"once":"only"}';
    const ts = String(clock.now());
    const headers = signedHeaders({ ts, nonce: 'single', method: 'POST', url: '/__daemon/x', body });
    const req = makeReq({ method: 'POST', url: '/__daemon/x', headers, body });
    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), { clock });
    expect(out.ok).toBe(true);
    // Attempting to read the stream again yields no further bytes.
    const remaining = await readBodyRaw(req);
    expect(remaining).toBe('');
  });

  it('returns body_too_large (413) when body exceeds the cap', async () => {
    const clock = fixedClock(7_000_000);
    const big = 'x'.repeat(50);
    const ts = String(clock.now());
    const headers = signedHeaders({ ts, nonce: 'big', method: 'POST', url: '/__daemon/x', body: big });
    const req = makeReq({ method: 'POST', url: '/__daemon/x', headers, body: big });
    const out = await verifyDaemonRequest(req, SECRET, createNonceStore(clock), {
      clock,
      maxBodyBytes: 10,
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toBe('body_too_large');
    expect(out.httpStatus).toBe(413);
  });

  it('concurrent requests with the same nonce — exactly one is accepted, the other is replay (B1)', async () => {
    const clock = fixedClock(9_500_000);
    const store = createNonceStore(clock);
    const ts = String(clock.now());
    const body = '{"shared":"nonce"}';
    const headers = signedHeaders({ ts, nonce: 'race', method: 'POST', url: '/__daemon/race', body });

    // Two structurally identical requests fire concurrently. With the
    // has → sign → checkSig → add synchronous block, exactly one succeeds.
    const req1 = makeReq({ method: 'POST', url: '/__daemon/race', headers, body });
    const req2 = makeReq({ method: 'POST', url: '/__daemon/race', headers, body });
    const [a, b] = await Promise.all([
      verifyDaemonRequest(req1, SECRET, store, { clock }),
      verifyDaemonRequest(req2, SECRET, store, { clock }),
    ]);

    const oks = [a, b].filter(r => r.ok).length;
    const replays = [a, b].filter(r => !r.ok && (r as any).reason === 'replay').length;
    expect(oks).toBe(1);
    expect(replays).toBe(1);
  });

  it('allows the same nonce after the TTL window has elapsed', async () => {
    const clock = fixedClock(8_000_000);
    const store = createNonceStore(clock);
    const ts1 = String(clock.now());
    const first = makeReq({
      method: 'POST', url: '/__daemon/x',
      headers: signedHeaders({ ts: ts1, nonce: 'reuse', method: 'POST', url: '/__daemon/x', body: '' }),
      body: '',
    });
    const ok = await verifyDaemonRequest(first, SECRET, store, { clock });
    expect(ok.ok).toBe(true);

    // Advance past NONCE_TTL — the nonce is GC'd before the next .has() call.
    clock.advance(NONCE_TTL_MS + 1);
    const ts2 = String(clock.now());
    const second = makeReq({
      method: 'POST', url: '/__daemon/x',
      headers: signedHeaders({ ts: ts2, nonce: 'reuse', method: 'POST', url: '/__daemon/x', body: '' }),
      body: '',
    });
    const ok2 = await verifyDaemonRequest(second, SECRET, store, { clock });
    expect(ok2.ok).toBe(true);
  });
});

describe('module constants', () => {
  it('exports the spec-mandated windows and limit', () => {
    expect(TS_WINDOW_MS).toBe(60_000);
    expect(NONCE_TTL_MS).toBe(10 * 60_000);
    expect(BODY_LIMIT_BYTES).toBe(1024 * 1024);
  });
});
