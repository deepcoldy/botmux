/**
 * `botmux dashboard` / start-restart-hint loopback client.
 *
 * Two regressions guarded here:
 *  1. Any HTTP 404 used to be reported as `no-active-token` — including the
 *     daemon IPC server's `{ error: 'not_found' }` when `.dashboard-port` went
 *     stale and pointed at it. That produced the misleading
 *     `Rotation failed: no-active-token`.
 *  2. A stale `.dashboard-port` is now self-healed: when the recorded port
 *     answers as the wrong service, we HMAC-probe the range to find the real
 *     dashboard and rewrite the port file.
 *
 * Run: pnpm vitest run test/dashboard-endpoint.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import {
  classifyDashboard404,
  classifyDashboard401,
  callDashboard,
  type DashboardEndpoint,
} from '../src/cli/dashboard-endpoint.js';
import { verifyHmac, cliAuthBind, signCliAuth } from '../src/dashboard/auth.js';

const SECRET = Buffer.from('test-secret').toString('base64url');

// A fake fetch routing by port number to one of three behaviours.
type PortBehaviour =
  | { kind: 'dashboard'; hasToken: boolean }
  | { kind: 'ipc' }            // daemon IPC: unknown-route 404 { error:'not_found' }
  | { kind: 'auth-fail' }      // loopback shadow / stale dashboard: 401 sig_mismatch
  | { kind: 'down' };          // nothing listening → fetch throws

function makeFetch(ports: Record<number, PortBehaviour>): typeof fetch {
  return (async (input: string) => {
    const u = new URL(input);
    const port = Number(u.port);
    const path = u.pathname as DashboardEndpoint;
    const b = ports[port] ?? { kind: 'down' as const };
    if (b.kind === 'down') throw new Error('ECONNREFUSED');
    if (b.kind === 'ipc') {
      return new Response(JSON.stringify({ error: 'not_found', path }), { status: 404 });
    }
    if (b.kind === 'auth-fail') {
      return new Response(JSON.stringify({ error: 'unauthorized', reason: 'sig_mismatch' }), { status: 401 });
    }
    // dashboard
    if (path === '/__cli/rotate') {
      return new Response(JSON.stringify({ url: `http://host:${port}/?t=fresh` }), { status: 200 });
    }
    // /__cli/current
    if (!b.hasToken) return new Response(JSON.stringify({ error: 'no_active_token' }), { status: 404 });
    return new Response(JSON.stringify({ url: `http://host:${port}/?t=current` }), { status: 200 });
  }) as unknown as typeof fetch;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bmx-dash-'));
  writeFileSync(join(dir, '.dashboard-secret'), SECRET);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setPort(p: number) { writeFileSync(join(dir, '.dashboard-port'), String(p)); }

describe('classifyDashboard404', () => {
  it('treats /__cli/current no_active_token as no-active-token', () => {
    const r = classifyDashboard404('/__cli/current', JSON.stringify({ error: 'no_active_token' }));
    expect(r).toEqual({ ok: false, reason: 'no-active-token' });
  });

  it('treats daemon IPC not_found as wrong-service (not no-active-token)', () => {
    const r = classifyDashboard404('/__cli/rotate', JSON.stringify({ error: 'not_found', path: '/__cli/rotate' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong-service');
  });

  it('treats no_active_token on the ROTATE path as wrong-service (rotate never lacks a token)', () => {
    const r = classifyDashboard404('/__cli/rotate', JSON.stringify({ error: 'no_active_token' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong-service');
  });

  it('treats a non-JSON 404 body as wrong-service', () => {
    const r = classifyDashboard404('/__cli/current', 'Not Found');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong-service');
  });
});

describe('classifyDashboard401', () => {
  it('treats sig_mismatch as rediscoverable auth-failed', () => {
    const r = classifyDashboard401(JSON.stringify({ error: 'unauthorized', reason: 'sig_mismatch' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('auth-failed');
  });

  it('keeps other 401s as plain http-error', () => {
    const r = classifyDashboard401(JSON.stringify({ error: 'unauthorized', reason: 'remote_not_loopback' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('http-error');
  });
});

describe('callDashboard', () => {
  it('returns no-secret when the secret file is missing', async () => {
    rmSync(join(dir, '.dashboard-secret'));
    const r = await callDashboard({ configDir: dir, defaultPort: 7891, path: '/__cli/rotate', fetchImpl: makeFetch({}) });
    expect(r).toEqual({ ok: false, reason: 'no-secret' });
  });

  it('returns no-secret when the secret file is whitespace-only', async () => {
    writeFileSync(join(dir, '.dashboard-secret'), ' \n');
    const r = await callDashboard({ configDir: dir, defaultPort: 7891, path: '/__cli/rotate', fetchImpl: makeFetch({}) });
    expect(r).toEqual({ ok: false, reason: 'no-secret' });
  });

  it('rotates against the recorded port when it IS the dashboard', async () => {
    setPort(7891);
    const r = await callDashboard({
      configDir: dir, defaultPort: 7891, path: '/__cli/rotate',
      fetchImpl: makeFetch({ 7891: { kind: 'dashboard', hasToken: false } }),
    });
    expect(r).toEqual({ ok: true, url: 'http://host:7891/?t=fresh' });
  });

  it('surfaces the dashboard-provided localUrl fallback (platform link case)', async () => {
    setPort(7891);
    // Dashboard returns both a platform primary URL and a local ip:port fallback.
    const fetchImpl = (async () => new Response(
      JSON.stringify({ url: 'https://m-x.example/?t=fresh', localUrl: 'http://10.0.0.1:7891/?t=fresh' }),
      { status: 200 },
    )) as unknown as typeof fetch;
    const r = await callDashboard({ configDir: dir, defaultPort: 7891, path: '/__cli/rotate', fetchImpl });
    expect(r).toEqual({ ok: true, url: 'https://m-x.example/?t=fresh', localUrl: 'http://10.0.0.1:7891/?t=fresh' });
  });

  it('does NOT mislabel a daemon-IPC 404 as no-active-token; self-heals to the real dashboard', async () => {
    // Recorded port points at daemon IPC (the reported bug); real dashboard is 7901.
    setPort(7893);
    const r = await callDashboard({
      configDir: dir, defaultPort: 7891, path: '/__cli/rotate',
      fetchImpl: makeFetch({
        7893: { kind: 'ipc' },
        7901: { kind: 'dashboard', hasToken: true },
      }),
    });
    expect(r).toEqual({ ok: true, url: 'http://host:7901/?t=fresh' });
    // Port file healed to the discovered dashboard port.
    expect(readFileSync(join(dir, '.dashboard-port'), 'utf8').trim()).toBe('7901');
  });

  it('self-heals when the recorded loopback port returns sig_mismatch', async () => {
    setPort(7891);
    const r = await callDashboard({
      configDir: dir, defaultPort: 7891, path: '/__cli/rotate',
      fetchImpl: makeFetch({
        7891: { kind: 'auth-fail' },
        7897: { kind: 'dashboard', hasToken: true },
      }),
    });
    expect(r).toEqual({ ok: true, url: 'http://host:7897/?t=fresh' });
    expect(readFileSync(join(dir, '.dashboard-port'), 'utf8').trim()).toBe('7897');
  });

  it('reports wrong-service when the recorded port is IPC and no dashboard is found in range', async () => {
    setPort(7893);
    const r = await callDashboard({
      configDir: dir, defaultPort: 7891, path: '/__cli/rotate',
      fetchImpl: makeFetch({ 7893: { kind: 'ipc' } }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong-service');
  });

  it('does NOT scan when the recorded port is simply unreachable (dashboard still booting)', async () => {
    setPort(7891);
    let calls = 0;
    const base = makeFetch({ 7901: { kind: 'dashboard', hasToken: true } });
    const counting = (async (...a: Parameters<typeof fetch>) => { calls++; return base(...a); }) as typeof fetch;
    const r = await callDashboard({
      configDir: dir, defaultPort: 7891, path: '/__cli/current', fetchImpl: counting,
    });
    expect(r).toEqual({ ok: false, reason: 'unreachable' });
    expect(calls).toBe(1); // only the recorded port — no range scan on unreachable
  });

  it('does not mint a token during discovery (probes /__cli/current, not rotate)', async () => {
    setPort(7893);
    const seen: string[] = [];
    const base = makeFetch({ 7893: { kind: 'ipc' }, 7901: { kind: 'dashboard', hasToken: true } });
    const spy = (async (input: string, init?: RequestInit) => {
      seen.push(`${new URL(input).port} ${new URL(input).pathname}`);
      return base(input, init);
    }) as unknown as typeof fetch;
    await callDashboard({ configDir: dir, defaultPort: 7891, path: '/__cli/rotate', fetchImpl: spy });
    // The dashboard port (7901) is first identified via /__cli/current, and only
    // then issued the requested /__cli/rotate.
    const dashHits = seen.filter(s => s.startsWith('7901 '));
    expect(dashHits[0]).toBe('7901 /__cli/current');
    expect(dashHits).toContain('7901 /__cli/rotate');
  });

  it('current path returns no-active-token from a genuine dashboard with no token', async () => {
    setPort(7891);
    const r = await callDashboard({
      configDir: dir, defaultPort: 7891, path: '/__cli/current',
      fetchImpl: makeFetch({ 7891: { kind: 'dashboard', hasToken: false } }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-active-token');
  });
});

// Sanity: HMAC headers are well-formed and bound to method + path + port (the
// real dashboard reconstructs the same bind to verify them).
describe('requestDashboardAt HMAC headers', () => {
  it('signs ts:nonce bound to method+path+port with the secret', async () => {
    setPort(7891);
    let headers: Record<string, string> = {};
    const spy = (async (_i: string, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ url: 'http://host:7891/?t=x' }), { status: 200 });
    }) as unknown as typeof fetch;
    await callDashboard({ configDir: dir, defaultPort: 7891, path: '/__cli/rotate', fetchImpl: spy });
    const ts = headers['X-Botmux-Cli-Ts'];
    const nonce = headers['X-Botmux-Cli-Nonce'];
    const bind = cliAuthBind('POST', '/__cli/rotate', 7891);
    const expected = createHmac('sha256', SECRET).update(`${ts}:${nonce}:${bind}`).digest('base64url');
    expect(headers['X-Botmux-Cli-Auth']).toBe(expected);
  });
});

/**
 * Security regression (Codex review of #216): the discovery scan signs an HMAC
 * with token-grade headers and hands them to UNCONFIRMED candidate ports. A
 * malicious local server in the probe range must not be able to forward those
 * captured headers to the real dashboard to read or mint a token. Binding the
 * signature to method + path + the dialed port makes the credential
 * single-purpose, so every forward mismatches the verifier's own bind.
 */
describe('discovery credential binding (anti-forward)', () => {
  const LOOPBACK = '127.0.0.1';
  const MALICIOUS_PORT = 7905;   // what the CLI dialed (and the attacker captured on)
  const REAL_PORT = 7901;        // where the real dashboard actually bound

  it('a /__cli/current probe captured on the malicious port cannot be forwarded anywhere useful', () => {
    // CLI signs a read-only discovery probe addressed to the malicious port.
    const captured = signCliAuth(SECRET, cliAuthBind('POST', '/__cli/current', MALICIOUS_PORT));

    // Attacker forwards the SAME headers to the real dashboard (which verifies
    // against the port IT bound, not the Host header):
    // → same route, real port: rejected (port differs).
    expect(verifyHmac(SECRET, captured, LOOPBACK,
      cliAuthBind('POST', '/__cli/current', REAL_PORT)).ok).toBe(false);
    // → escalate to the token-minting route: rejected (path + port differ).
    expect(verifyHmac(SECRET, captured, LOOPBACK,
      cliAuthBind('POST', '/__cli/rotate', REAL_PORT)).ok).toBe(false);
  });

  it('a current-route credential cannot be replayed onto the rotate route (same port)', () => {
    const cur = signCliAuth(SECRET, cliAuthBind('POST', '/__cli/current', REAL_PORT));
    expect(verifyHmac(SECRET, cur, LOOPBACK,
      cliAuthBind('POST', '/__cli/rotate', REAL_PORT)).ok).toBe(false);
  });

  it('a correctly-addressed request still verifies (positive control)', () => {
    const ok = signCliAuth(SECRET, cliAuthBind('POST', '/__cli/rotate', REAL_PORT));
    expect(verifyHmac(SECRET, ok, LOOPBACK,
      cliAuthBind('POST', '/__cli/rotate', REAL_PORT)).ok).toBe(true);
  });

  it('legacy unbound IPC-style signature is rejected by a bound (/__cli) verifier', () => {
    // Daemon-IPC headers are signed over bare ts:nonce; they must not satisfy a
    // bound /__cli verifier (prevents cross-scheme replay between the two servers).
    const unbound = signCliAuth(SECRET); // no bind
    expect(verifyHmac(SECRET, unbound, LOOPBACK,
      cliAuthBind('POST', '/__cli/current', REAL_PORT)).ok).toBe(false);
  });
});

// Guard against `existsSync` import being tree-shaken in refactors.
void existsSync;
