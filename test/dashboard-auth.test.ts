import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyHmac, generateToken, parseCookie, decideDashboardAuth,
} from '../src/dashboard/auth.js';

const SECRET = 'a'.repeat(43); // base64url 32 bytes

function sign(ts: string, nonce: string): string {
  return createHmac('sha256', SECRET).update(`${ts}:${nonce}`).digest('base64url');
}

describe('verifyHmac', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(0)); });
  afterEach(() => { vi.useRealTimers(); });

  it('accepts valid signature', () => {
    const ts = '0', nonce = 'n1';
    const r = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce) }, '127.0.0.1');
    expect(r.ok).toBe(true);
  });

  it('rejects wrong secret', () => {
    const ts = '0', nonce = 'n2';
    const r = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce).replace(/^./, 'X') }, '127.0.0.1');
    expect(r.ok).toBe(false);
  });

  it('rejects expired ts (>30s)', () => {
    vi.setSystemTime(new Date(60_000));
    const ts = '0', nonce = 'n3';
    const r = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce) }, '127.0.0.1');
    expect(r.ok).toBe(false);
  });

  it('rejects non-loopback IP', () => {
    const ts = '0', nonce = 'n4';
    const r = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce) }, '192.168.1.5');
    expect(r.ok).toBe(false);
  });

  it('rejects replayed nonce within window', () => {
    const ts = '0', nonce = 'n5';
    const a = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce) }, '127.0.0.1');
    expect(a.ok).toBe(true);
    const b = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce) }, '127.0.0.1');
    expect(b.ok).toBe(false);
  });
});

describe('generateToken', () => {
  it('returns 43-char base64url (32 bytes)', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('parseCookie', () => {
  it('extracts botmux_dashboard_token value', () => {
    const v = parseCookie('foo=bar; botmux_dashboard_token=tk_abc; x=1');
    expect(v).toBe('tk_abc');
  });
  it('returns undefined when absent', () => {
    expect(parseCookie('foo=bar')).toBeUndefined();
  });
});

// ─── decideDashboardAuth ─────────────────────────────────────────────────────
//
// Locks the per-request public-vs-protected matrix added in canary.3
// (src/dashboard.ts public-read split for workflow run links from Lark
// approval cards).  If anyone narrows or widens the public surface by
// accident, these matrix tests fail and CI catches it.
// codex's HTTP integration smoke covers the same routes end-to-end; this
// pure-function layer is the cheap unit safety net.

describe('decideDashboardAuth — public surface', () => {
  const TOK = 'active-token-xyz';

  it('GET /api/workflows/* — allow without any token', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/workflows/run-123/snapshot',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('GET / — static SPA shell allow without any token', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('GET /assets/app.js — static asset allow without any token', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/assets/app.js',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });
});

describe('decideDashboardAuth — protected surface', () => {
  const TOK = 'active-token-xyz';

  it('POST /api/workflows/<id>/cancel without token → deny401', () => {
    const d = decideDashboardAuth({
      method: 'POST',
      pathname: '/api/workflows/run-123/cancel',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('deny401');
  });

  it('GET /api/sessions without token → deny401 (non-workflow API)', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/sessions',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('deny401');
  });

  it('GET /api/schedules without token → deny401', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/schedules',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('deny401');
  });

  it('POST / static-looking path is NOT public (only GET is)', () => {
    const d = decideDashboardAuth({
      method: 'POST',
      pathname: '/',
      hasTokenParam: false,
      presentedToken: undefined,
      activeToken: TOK,
    });
    expect(d.kind).toBe('deny401');
  });

  it('GET protected with valid cookie → allow', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/sessions',
      hasTokenParam: false,
      presentedToken: TOK,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('POST protected with valid cookie → allow', () => {
    const d = decideDashboardAuth({
      method: 'POST',
      pathname: '/api/workflows/run-123/cancel',
      hasTokenParam: false,
      presentedToken: TOK,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('GET protected with wrong token → deny401', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/sessions',
      hasTokenParam: false,
      presentedToken: 'wrong-token',
      activeToken: TOK,
    });
    expect(d.kind).toBe('deny401');
  });
});

describe('decideDashboardAuth — ?t=<token> cookie set redirect', () => {
  const TOK = 'active-token-xyz';

  it('?t=<correct> on / → set-cookie + redirect to /', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/',
      hasTokenParam: true,
      presentedToken: TOK,
      activeToken: TOK,
    });
    expect(d).toEqual({ kind: 'allow+set-cookie', token: TOK, redirectTo: '/' });
  });

  it('?t=<correct> on deep path → set-cookie + redirect preserves path', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/workflows/run-99/snapshot',
      hasTokenParam: true,
      presentedToken: TOK,
      activeToken: TOK,
    });
    expect(d).toEqual({
      kind: 'allow+set-cookie',
      token: TOK,
      redirectTo: '/api/workflows/run-99/snapshot',
    });
  });

  it('?t=<wrong> on protected route → deny401 (no cookie minted)', () => {
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/sessions',
      hasTokenParam: true,
      presentedToken: 'wrong-token',
      activeToken: TOK,
    });
    expect(d.kind).toBe('deny401');
  });

  it('?t=<wrong> on public route → allow but no set-cookie (no auth granted)', () => {
    // Public workflow GET works regardless of token, but the cookie must
    // NOT be minted to the wrong value — otherwise the cookie would override
    // a legit later cookie.
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/workflows/run-1/snapshot',
      hasTokenParam: true,
      presentedToken: 'wrong-token',
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('?t=<correct> via cookie (no query) → plain allow, no redirect', () => {
    // Cookie path means the browser already has the token; don't bounce.
    const d = decideDashboardAuth({
      method: 'GET',
      pathname: '/api/sessions',
      hasTokenParam: false,
      presentedToken: TOK,
      activeToken: TOK,
    });
    expect(d.kind).toBe('allow');
  });

  it('empty active token never authenticates (server not yet rotated)', () => {
    const d = decideDashboardAuth({
      method: 'POST',
      pathname: '/api/workflows/run-1/cancel',
      hasTokenParam: false,
      presentedToken: '',
      activeToken: '',
    });
    expect(d.kind).toBe('deny401');
  });
});
