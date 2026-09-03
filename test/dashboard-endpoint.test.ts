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
  type DashboardResult,
} from '../src/cli/dashboard-endpoint.js';
import { executeDashboardCommand, executeDashboardCliCommand } from '../src/cli/dashboard-command.js';
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
    if (path === '/__cli/ensure') {
      const token = b.hasToken ? 'current' : 'created';
      return new Response(JSON.stringify({ url: `http://host:${port}/?t=${token}` }), { status: 200 });
    }
    // /__cli/current
    if (!b.hasToken) return new Response(JSON.stringify({ error: 'no_active_token' }), { status: 404 });
    return new Response(JSON.stringify({ url: `http://host:${port}/?t=current` }), { status: 200 });
  }) as unknown as typeof fetch;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bmx-dash-'));
  // 生产环境 secret 始终以 0600 落盘；fixture 必须匹配，否则安全读取会 fail-closed。
  writeFileSync(join(dir, '.dashboard-secret'), SECRET, { mode: 0o600 });
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
    writeFileSync(join(dir, '.dashboard-secret'), ' \n', { mode: 0o600 });
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

  it.each([
    { hasToken: false, token: 'created' },
    { hasToken: true, token: 'current' },
  ])('ensure gets a usable URL without replacing an existing token: $hasToken', async ({ hasToken, token }) => {
    setPort(7891);
    const r = await callDashboard({
      configDir: dir, defaultPort: 7891, path: '/__cli/ensure',
      fetchImpl: makeFetch({ 7891: { kind: 'dashboard', hasToken } }),
    });
    expect(r).toEqual({ ok: true, url: `http://host:7891/?t=${token}` });
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

  it('rescans an unreachable recorded port ONLY when the caller opts in, and heals the file', async () => {
    // MEASURED on a live box: `.dashboard-port` held 7893 while the dashboard was
    // on 7891 with NOTHING listening on 7893. Nobody answering means `unreachable`,
    // which the default path deliberately does not scan (see the test above), so
    // the file stayed wrong forever and every `botmux dashboard` failed. The
    // one-shot CLI command opts in unconditionally; the 500ms poll never does.
    setPort(7893);
    const r = await callDashboard({
      configDir: dir, defaultPort: 7891, path: '/__cli/current',
      rescanWhenUnreachable: true,
      fetchImpl: makeFetch({ 7891: { kind: 'dashboard', hasToken: true } }),
    });
    expect(r).toEqual({ ok: true, url: 'http://host:7891/?t=current' });
    // ...and the dead recorded port is healed, so the next call needs no rescan.
    expect(readFileSync(join(dir, '.dashboard-port'), 'utf8').trim()).toBe('7891');
  });

  it('opting in still reports unreachable when no dashboard exists in the range', async () => {
    // Fail-closed: an opt-in rescan that finds nothing must surface the ORIGINAL
    // unreachable, not invent a different reason — and must not corrupt the file.
    setPort(7893);
    const r = await callDashboard({
      configDir: dir, defaultPort: 7891, path: '/__cli/current',
      rescanWhenUnreachable: true,
      fetchImpl: makeFetch({}),   // nothing listening anywhere
    });
    expect(r).toEqual({ ok: false, reason: 'unreachable' });
    expect(readFileSync(join(dir, '.dashboard-port'), 'utf8').trim()).toBe('7893');
  });

  it('the opt-in flag does not change wrong-service behaviour (already scanned before)', async () => {
    // Guards against the flag accidentally becoming the ONLY path to a rescan.
    setPort(7893);
    const r = await callDashboard({
      configDir: dir, defaultPort: 7891, path: '/__cli/current',
      fetchImpl: makeFetch({ 7893: { kind: 'ipc' }, 7901: { kind: 'dashboard', hasToken: true } }),
    });
    expect(r).toEqual({ ok: true, url: 'http://host:7901/?t=current' });
    expect(readFileSync(join(dir, '.dashboard-port'), 'utf8').trim()).toBe('7901');
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
    expect(verifyHmac(SECRET, captured, LOOPBACK,
      cliAuthBind('POST', '/__cli/ensure', REAL_PORT)).ok).toBe(false);
  });

  it('a current-route credential cannot be replayed onto a token-writing route (same port)', () => {
    const cur = signCliAuth(SECRET, cliAuthBind('POST', '/__cli/current', REAL_PORT));
    expect(verifyHmac(SECRET, cur, LOOPBACK,
      cliAuthBind('POST', '/__cli/rotate', REAL_PORT)).ok).toBe(false);
    expect(verifyHmac(SECRET, cur, LOOPBACK,
      cliAuthBind('POST', '/__cli/ensure', REAL_PORT)).ok).toBe(false);
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


/**
 * The loopback client must not honour `$http_proxy` — regression guard for
 * `Dashboard lookup failed: 403 <html>… 403 Forbidden …`.
 *
 * ⚠️⚠️ WHY NOT JUST "call callDashboard with proxy env set and assert it worked":
 * measured — that test is BORN TOOTHLESS. Vitest executes test bodies under
 * **Node even when launched via `bun x vitest`** (probed: `runtime=node v22.21.1`,
 * `execPath=…/node`), and Node's `fetch` ignores proxy env anyway. So reverting
 * the production default back to the global `fetch` keeps such a test green:
 * verified, 25/25 passed under BOTH `npx vitest` and `bun x vitest` with the fix
 * reverted. The defect only exists in Bun's `fetch`, which no in-process vitest
 * assertion can reach.
 *
 * Hence two guards that CAN bite:
 *  1. A shape guard on the source — no runtime needed, so it holds in CI.
 *  2. A real Bun child process (skipped when no bun binary is around), which is
 *     the only way to observe the actual proxying behaviour.
 */
describe('loopback client ignores $http_proxy (403 nginx regression)', () => {
  /**
   * Locate a bun binary the way CI actually provides one: `oven-sh/setup-bun`
   * only prepends it to PATH (it sets no BUN_PATH), so PATH is the source of
   * truth. $BUN_PATH stays supported as an explicit override.
   */
  function resolveBun(): string | undefined {
    if (process.env.BUN_PATH && existsSync(process.env.BUN_PATH)) return process.env.BUN_PATH;
    for (const dir of (process.env.PATH ?? '').split(':')) {
      if (!dir) continue;
      const candidate = join(dir, 'bun');
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  const ENDPOINT_SRC = join(__dirname, '..', 'src', 'cli', 'dashboard-endpoint.ts');

  it('never falls back to the global fetch for the default client (shape guard)', () => {
    const src = readFileSync(ENDPOINT_SRC, 'utf8');
    // Both defaulting sites (requestDashboardAt + callDashboard) must resolve to
    // the node:http client. `?? fetch` is exactly the regression: on Bun that
    // routes a 127.0.0.1 request through $http_proxy when no_proxy is a CIDR.
    const globalFetchFallbacks = src.match(/fetchImpl\s*\?\?\s*fetch\b/g) ?? [];
    expect(globalFetchFallbacks).toEqual([]);
    const loopbackDefaults = src.match(/fetchImpl\s*\?\?\s*loopbackFetchImpl\b/g) ?? [];
    expect(loopbackDefaults).toHaveLength(2);
    // …and the client it defaults to must itself be built on node:http.
    const client = readFileSync(join(__dirname, '..', 'src', 'core', 'loopback-fetch.ts'), 'utf8');
    expect(client).toMatch(/from 'node:buffer'|requestLiteralLoopback/);
    expect(client).not.toMatch(/\bawait fetch\(|=\s*fetch\(/);
  });

  it('the daemon-IPC wrapper does not use the global fetch either', () => {
    // Same defect, different wrapper: fetchDaemonIpc is the loopback client for
    // 30+ call sites (resume/suspend/lang/term-link/dashboard→daemon). Verified
    // with a real Bun process against a stand-in proxy: the global fetch returned
    // the proxy's 403, loopbackFetch reached the daemon.
    const ipc = readFileSync(join(__dirname, '..', 'src', 'core', 'daemon-ipc-auth.ts'), 'utf8');
    expect(ipc).toContain('loopbackFetch(');
    expect(ipc).not.toMatch(/return fetch\(|await fetch\(/);
  });

  it('a real Bun process reaches the dashboard directly with a CIDR no_proxy', async () => {
    const bun = resolveBun();
    if (!bun) {
      // ⚠️ Never silently pass in CI. This lookup used to check only $BUN_PATH,
      // $HOME/.bun/bin/bun and a hardcoded /root/.bun/bin/bun — and
      // test/unit-setup.ts rewrites process.env.HOME to an isolated temp dir
      // before test modules load, so on a non-root GitHub runner all three miss
      // and the real proxy assertion never ran while the suite stayed green
      // (measured: found=NONE under the isolated HOME). setup-bun only puts bun
      // on PATH, so PATH is what we resolve; if CI still cannot find it that is a
      // broken workflow, not a reason to skip.
      if (process.env.CI) throw new Error('bun not found on PATH; this test must not be skipped in CI');
      return;
    }

    const { createServer } = await import('node:http');
    const servers: import('node:http').Server[] = [];
    const listen = async (h: import('node:http').RequestListener) => {
      const s = createServer(h); servers.push(s);
      await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
      return (s.address() as { port: number }).port;
    };
    try {
      let proxyHits = 0, directHits = 0;
      const proxyPort = await listen((_q, s) => {
        proxyHits++;
        s.writeHead(403, { 'content-type': 'text/html' });
        s.end('<html><head><title>403 Forbidden</title></head></html>');
      });
      const dashPort = await listen((_q, s) => {
        directHits++;
        s.writeHead(200, { 'content-type': 'application/json' });
        s.end(JSON.stringify({ url: 'http://dash.local/?t=direct' }));
      });
      setPort(dashPort);

      const snippet = `
        const { callDashboard } = await import(${JSON.stringify(join(__dirname, '..', 'src', 'cli', 'dashboard-endpoint.ts'))});
        const r = await callDashboard({ configDir: ${JSON.stringify(dir)}, defaultPort: ${dashPort}, path: '/__cli/current', probeSpan: 0 });
        process.stdout.write(JSON.stringify({ runtime: typeof Bun !== 'undefined' ? 'bun' : 'node', r }));
      `;
      // ⚠️ MUST be async spawn, not spawnSync: spawnSync blocks this process's
      // event loop, so the two servers above would never accept the child's
      // connection — the child then times out and the test fails for a reason
      // that has nothing to do with proxying. (Measured: spawnSync → 30s
      // timeout, empty stdout.)
      const { spawn } = await import('node:child_process');
      const proxyUrl = `http://127.0.0.1:${proxyPort}`;
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(bun, ['-e', snippet], {
          env: {
            ...process.env,
            http_proxy: proxyUrl, HTTP_PROXY: proxyUrl,
            https_proxy: proxyUrl, HTTPS_PROXY: proxyUrl,
            // The CIDR form real shell rc files use — the one Bun's fetch ignores.
            no_proxy: '127.0.0.0/8', NO_PROXY: '127.0.0.0/8',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '', err = '';
        child.stdout.on('data', d => { out += String(d); });
        child.stderr.on('data', d => { err += String(d); });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('bun child timed out')); }, 25_000);
        child.on('error', e => { clearTimeout(timer); reject(e); });
        child.on('close', code => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error(`bun child exited ${code}: ${err.slice(0, 500)}`));
          else resolve(out);
        });
      });
      const parsed = JSON.parse(stdout || '{}');
      // Prove the child really was Bun; otherwise this assertion means nothing.
      expect(parsed.runtime).toBe('bun');
      expect(proxyHits).toBe(0);
      expect(directHits).toBe(1);
      expect(parsed.r).toEqual({ ok: true, url: 'http://dash.local/?t=direct' });
    } finally {
      await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
    }
  }, 40_000);
});

/**
 * The CLI's dead-port recovery re-runs the WHOLE `dashboard` command through a
 * rescan-enabled caller (rather than guessing which endpoint the action maps to,
 * since `current` has a /__cli/current → /__cli/ensure → legacy-rotate ladder).
 *
 * That raises a fair objection: does re-running `rotate` mint the token TWICE?
 * It cannot, and the reason is the gate itself — recovery only fires when the
 * first attempt returned `unreachable`, i.e. nothing answered on the recorded
 * port, so no dashboard performed any rotation. This pins that property, because
 * widening the gate to a reason that DID reach a dashboard would silently start
 * invalidating a freshly-issued link.
 */
describe('PRODUCTION WIRING: `botmux dashboard` recovers the measured failure', () => {
  /**
   * THE EXACT FAILURE THIS PR EXISTS FOR, driven through the shape the CLI uses.
   *
   * MEASURED on a live box:
   *   - fleet state: dashboard member `online` with a LIVE pid
   *     ⟹ "is a dashboard coming up?" answers TRUE
   *   - `.dashboard-port` = 7893, with NOTHING listening there ⟹ `unreachable`
   *   - the real dashboard was serving on 7891
   *
   * An earlier version of this fix gated the rescan on `stillComingUp === false`.
   * That predicate is TRUE here (online + live pid), so the rescan would never
   * have fired on the very input it was written for — the lower layer had the
   * capability and the production path never enabled it. `botmux dashboard` is a
   * one-shot human command, so it opts in from the first call; only the 500ms
   * readiness poll keeps the default (no per-tick scanning).
   */
  it('opts in from the first call, so online+live-pid + dead recorded port still heals', async () => {
    setPort(7893);
    const cliCaller = (path: DashboardEndpoint) => callDashboard({
      configDir: dir, defaultPort: 7891, path,
      rescanWhenUnreachable: true,          // what cmdDashboard passes
      fetchImpl: makeFetch({ 7891: { kind: 'dashboard', hasToken: true } }),
    });
    const execution = await executeDashboardCommand([], cliCaller);
    expect(execution.kind).toBe('endpoint');
    if (execution.kind === 'endpoint') {
      expect(execution.result).toEqual({ ok: true, url: 'http://host:7891/?t=current' });
    }
    // The dead port is healed, so subsequent calls need no scan at all.
    expect(readFileSync(join(dir, '.dashboard-port'), 'utf8').trim()).toBe('7891');
  });

  it('the CLI wrapper itself passes the opt-in (behavioural, no source regex)', async () => {
    // Directly exercise the unit `cmdDashboard` calls. Two earlier source-text
    // guards were both wrong: one false-RED on extract-to-local, the other stayed
    // GREEN when a flag-carrying call was disconnected from the caller passed down.
    const seen: Array<{ path: string; opts: { rescanWhenUnreachable: boolean } }> = [];
    const execution = await executeDashboardCliCommand([], async (path, opts) => {
      seen.push({ path, opts });
      return { ok: true, url: 'http://host:7891/?t=current' };
    });
    expect(execution.kind).toBe('endpoint');
    expect(seen.length).toBeGreaterThan(0);
    // EVERY endpoint call the wrapper makes must carry the opt-in — not just one.
    for (const c of seen) expect(c.opts).toEqual({ rescanWhenUnreachable: true });
  });

  it('the wrapper opts in on the rotate path too', async () => {
    const seen: Array<{ rescanWhenUnreachable: boolean }> = [];
    await executeDashboardCliCommand(['rotate'], async (_path, opts) => {
      seen.push(opts);
      return { ok: true, url: 'http://host:7891/?t=fresh' };
    });
    expect(seen).toEqual([{ rescanWhenUnreachable: true }]);
  });

  it('the wrapper opts in across the current → ensure fallback ladder', async () => {
    // `current` can walk /__cli/current → /__cli/ensure; a wrapper that only
    // opted in on the first hop would leave the ladder unhealed.
    const paths: string[] = [];
    await executeDashboardCliCommand(['current'], async (path, opts) => {
      paths.push(path);
      expect(opts).toEqual({ rescanWhenUnreachable: true });
      if (path === '/__cli/current') return { ok: false, reason: 'no-active-token' };
      return { ok: true, url: 'http://host:7891/?t=created' };
    });
    expect(paths).toContain('/__cli/current');
    expect(paths).toContain('/__cli/ensure');
  });

  it('cmdDashboard goes through the wrapper (minimal source pin, no nested parsing)', () => {
    // The behavioural tests above prove the WRAPPER opts in; they cannot see
    // cli.ts choosing the raw helper instead (VERIFIED: that swap left them all
    // green). cli.ts exports no cmdDashboard, so pin exactly one fact — which
    // function it calls — rather than parsing a nested callback's options object.
    // That earlier, more ambitious regex was wrong twice; this asserts one name.
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
    const start = src.indexOf('async function cmdDashboard(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end)
      .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');   // strip comments: they name both fns
    expect(body).toContain('executeDashboardCliCommand(');
    // ...and must NOT reach past the wrapper to the un-opted-in helper.
    expect(body).not.toMatch(/[^i]executeDashboardCommand\(/);
  });

  it('printDashboardHintWithRetry bounds its request (its own budget cannot interrupt a hung await)', () => {
    // Its 90s budget is only consulted AFTER `await callDashboardEndpoint(...)`
    // returns, so a recorded port that accepts and never answers hangs the first
    // iteration forever — the outer budget and the retry loop are both unreachable.
    // Bounding the request is the ONLY thing that can interrupt it. Source-pinned
    // because cli.ts exports nothing here; the value itself is checked behaviourally
    // by `requestTimeoutMs` tests above.
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
    const start = src.indexOf('async function printDashboardHintWithRetry(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end)
      .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    expect(body).toMatch(/callDashboardEndpoint\([^)]*\{[^}]*requestTimeoutMs/);
  });

  it('printDashboardHintWithRetry does NOT opt in (minimal source pin)', () => {
    // The behavioural tests below only show that the RAW helper passes one
    // argument; they cannot see the production poll adding the flag itself
    // (VERIFIED: adding `{ rescanWhenUnreachable: true }` to the poll's own call
    // left all 179 tests green). A 500ms poll that scanned the probe range every
    // tick would turn every boot into repeated port scans, so pin it directly.
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
    const start = src.indexOf('async function printDashboardHintWithRetry(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end)
      .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');   // its comments name the flag
    expect(body).toContain('callDashboardEndpoint(');
    expect(body).not.toContain('rescanWhenUnreachable');
    // ...and it must not route through the CLI wrapper, which always opts in.
    expect(body).not.toContain('executeDashboardCliCommand');
  });

  it('the raw command helper does NOT opt in (the readiness poll shape)', async () => {
    // executeDashboardCommand takes a single-arg caller: the poll passes
    // callDashboardEndpoint directly, so no options object reaches callDashboard
    // and the default (no scanning on unreachable) applies.
    const argCounts: number[] = [];
    await executeDashboardCommand([], async function (...received: unknown[]) {
      argCounts.push(received.length);
      return { ok: true, url: 'http://host:7891/?t=current' };
    });
    // Exactly one argument (the path) — no options object, hence no opt-in.
    expect(argCounts.length).toBeGreaterThan(0);
    for (const n of argCounts) expect(n).toBe(1);
  });

  it('the readiness poll shape (opt-in OFF) still does NOT scan', async () => {
    // Same inputs, minus the opt-in: proves the flag is what makes the difference,
    // and that the boot poll keeps its no-scan behaviour.
    setPort(7893);
    let calls = 0;
    const base = makeFetch({ 7891: { kind: 'dashboard', hasToken: true } });
    const counting = (async (...a: Parameters<typeof fetch>) => { calls++; return base(...a); }) as typeof fetch;
    const r = await callDashboard({
      configDir: dir, defaultPort: 7891, path: '/__cli/current', fetchImpl: counting,
    });
    expect(r).toEqual({ ok: false, reason: 'unreachable' });
    expect(calls).toBe(1);
    expect(readFileSync(join(dir, '.dashboard-port'), 'utf8').trim()).toBe('7893');
  });
});

describe('dead-port recovery has no duplicate token side effect', () => {
  it('rotate is served exactly once — the recovery is a single opt-in call', async () => {
    // Production makes ONE opt-in call (an earlier draft ran a default call then
    // re-ran the whole command; that gate is gone). So the guarantee is simply
    // that the wrapper does not multiply rotations: the dead recorded port is
    // skipped inside callDashboard's rescan, and only the real dashboard serves.
    setPort(7893);
    let servedRotations = 0;
    const fetchImpl = makeFetch({ 7891: { kind: 'dashboard', hasToken: true } });
    const counting = (async (input: string, init?: RequestInit) => {
      const u = new URL(input);
      // Count only rotations a LIVE dashboard serves. The first attempt targets
      // the dead recorded port 7893 and throws ECONNREFUSED — it reaches nothing,
      // so it mints nothing. Counting attempts instead of served requests would
      // report 2 and wrongly look like a double rotation.
      if (u.pathname === '/__cli/rotate' && u.port === '7891') servedRotations++;
      return fetchImpl(input, init);
    }) as unknown as typeof fetch;

    const execution = await executeDashboardCliCommand(['rotate'], (path, opts) => callDashboard({
      configDir: dir, defaultPort: 7891, path, fetchImpl: counting,
      rescanWhenUnreachable: opts.rescanWhenUnreachable,
    }));
    expect(execution.kind).toBe('endpoint');
    if (execution.kind === 'endpoint') expect(execution.result.ok).toBe(true);
    // Exactly one rotation reached a real dashboard, and the port file is healed.
    expect(servedRotations).toBe(1);
    expect(readFileSync(join(dir, '.dashboard-port'), 'utf8').trim()).toBe('7891');
  });

  it('discovery probes read-only, so a rescan never mints a token on a stranger', async () => {
    // The rescan identifies candidates via /__cli/current (read-only) before
    // issuing the requested op, so scanning cannot rotate someone else's token.
    setPort(7893);
    const seen: string[] = [];
    const base = makeFetch({ 7891: { kind: 'dashboard', hasToken: true } });
    const spy = (async (input: string, init?: RequestInit) => {
      const u = new URL(input);
      seen.push(`${u.port} ${u.pathname}`);
      return base(input, init);
    }) as unknown as typeof fetch;
    await callDashboard({
      configDir: dir, defaultPort: 7891, path: '/__cli/rotate',
      rescanWhenUnreachable: true, fetchImpl: spy,
    });
    const hits = seen.filter(x => x.startsWith('7891 '));
    expect(hits[0]).toBe('7891 /__cli/current');
    expect(hits).toContain('7891 /__cli/rotate');
  });
});

/**
 * REAL TRANSPORT: discovery must be bounded.
 *
 * `loopbackFetch` sets no request timeout, and the probe loop is serial, so a
 * local service that accepts the TCP connection and never sends HTTP headers used
 * to hang `callDashboard` FOREVER (MEASURED: outer `timeout` returned rc=124 with
 * no result). This PR is what feeds ordinary `unreachable` human commands into
 * that scan, so an input that used to fail fast could instead wedge permanently.
 * These use real sockets — a mocked fetch cannot express "accepts and stalls".
 */
describe('discovery is bounded (real sockets)', () => {
  const stalls: import('node:net').Server[] = [];
  const httpServers: import('node:http').Server[] = [];
  const liveSockets: import('node:net').Socket[] = [];
  afterEach(async () => {
    // `close()` only stops accepting; it RESOLVES ONLY AFTER existing connections
    // end — and a stalled socket never ends on its own, so the hook would hang
    // (observed: "Hook timed out in 10000ms"). Destroy held sockets first.
    for (const sock of liveSockets.splice(0)) sock.destroy();
    await Promise.all(stalls.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
    await Promise.all(httpServers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
  });

  /** A socket that accepts and never replies — the pathological case. */
  async function stalledPort(): Promise<number> {
    const { createServer } = await import('node:net');
    const s = createServer((sock) => { liveSockets.push(sock); });  // accept, say nothing
    stalls.push(s);
    await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
    return (s.address() as import('node:net').AddressInfo).port;
  }

  it('skips a stalled candidate within budget and still finds the real dashboard', async () => {
    // Ordering must be deterministic AND race-free. Earlier attempts (retrying
    // random OS ports; binding realPort-1) both flaked — one leaked listeners and
    // shifted the scan span, the other raced for a specific port. Instead: claim
    // TWO adjacent ports up front by probing pairs, so the stall is provably the
    // first candidate and the dashboard the second.
    const { createServer: netServer } = await import('node:net');
    const { createServer: httpServer } = await import('node:http');

    let stalled = -1, realPort = -1;
    for (let attempt = 0; attempt < 12 && realPort < 0; attempt++) {
      const probe = netServer();
      await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
      const lo = (probe.address() as import('node:net').AddressInfo).port;
      await new Promise<void>(r => probe.close(() => r()));

      const stall = netServer((sock) => { liveSockets.push(sock); });
      const real = httpServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ url: 'http://127.0.0.1/?t=found' }));
      });
      try {
        await new Promise<void>((res, rej) => {
          stall.once('error', rej); stall.listen(lo, '127.0.0.1', () => res());
        });
        await new Promise<void>((res, rej) => {
          real.once('error', rej); real.listen(lo + 1, '127.0.0.1', () => res());
        });
        stalls.push(stall); httpServers.push(real);
        stalled = lo; realPort = lo + 1;
      } catch {
        // One of the pair was taken — release both and try another pair.
        await new Promise<void>(r => stall.close(() => r())).catch(() => {});
        await new Promise<void>(r => real.close(() => r())).catch(() => {});
      }
    }
    // FAIL LOUD. A bare `return` here reports as PASSED in vitest (verified), so a
    // CI port race would silently count this as green with zero behaviour checked.
    expect(realPort, 'fixture could not claim an adjacent port pair after 12 tries').toBeGreaterThan(0);

    setPort(realPort + 1_000);                 // recorded port: nobody listening
    const t0 = Date.now();
    const r = await callDashboard({
      configDir: dir, defaultPort: stalled, probeSpan: 1, path: '/__cli/current',
      rescanWhenUnreachable: true, probeTimeoutMs: 300, discoveryBudgetMs: 5_000,
    });
    const elapsed = Date.now() - t0;
    expect(r.ok).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
    // ...and the port file is healed to the dashboard actually found.
    expect(readFileSync(join(dir, '.dashboard-port'), 'utf8').trim()).toBe(String(realPort));
  }, 40_000);

  it('bounds a server that sends headers then stalls MID-BODY, and still finds the dashboard', async () => {
    // A fetch resolves its Response as soon as HEADERS arrive, so clearing the
    // timeout right after the fetch leaves `.text()`/`.json()` unbounded. MEASURED
    // against that shape: rc=124, permanently wedged — per-probe AND total budget
    // both bypassed. "Sends no headers at all" does NOT cover this.
    const { createServer: netServer } = await import('node:net');
    const { createServer: httpServer } = await import('node:http');

    let stalledPortNum = -1, realPort = -1;
    for (let attempt = 0; attempt < 12 && realPort < 0; attempt++) {
      const probe = netServer();
      await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
      const lo = (probe.address() as import('node:net').AddressInfo).port;
      await new Promise<void>(r => probe.close(() => r()));

      // Full 200 JSON headers, then one '{' and silence forever.
      const stall = netServer((sock) => {
        liveSockets.push(sock);
        sock.on('data', () => {
          sock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
        });
      });
      const real = httpServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ url: 'http://127.0.0.1/?t=found' }));
      });
      try {
        await new Promise<void>((res, rej) => { stall.once('error', rej); stall.listen(lo, '127.0.0.1', () => res()); });
        await new Promise<void>((res, rej) => { real.once('error', rej); real.listen(lo + 1, '127.0.0.1', () => res()); });
        stalls.push(stall); httpServers.push(real);
        stalledPortNum = lo; realPort = lo + 1;
      } catch {
        await new Promise<void>(r => stall.close(() => r()));
        await new Promise<void>(r => real.close(() => r()));
      }
    }
    expect(realPort, 'fixture could not claim an adjacent port pair').toBeGreaterThan(0);
    expect(stalledPortNum).toBeLessThan(realPort);   // stall must be probed first

    setPort(realPort + 1_000);                       // recorded port: nobody there
    const t0 = Date.now();
    const r = await callDashboard({
      configDir: dir, defaultPort: stalledPortNum, probeSpan: 1, path: '/__cli/current',
      rescanWhenUnreachable: true, probeTimeoutMs: 300, discoveryBudgetMs: 3_000,
    });
    const elapsed = Date.now() - t0;
    expect(r.ok).toBe(true);                         // moved past the body-stall
    expect(elapsed).toBeLessThan(3_000);
    expect(readFileSync(join(dir, '.dashboard-port'), 'utf8').trim()).toBe(String(realPort));
  }, 40_000);

  it('bounds the FIRST recorded-port request too (opted-in callers only)', async () => {
    // If `.dashboard-port` itself points at an accept-and-stall service, an
    // unbounded first request hangs before discovery even begins — so a
    // "bounded command" must include this hop, not just the scan.
    const stalled = await stalledPort();
    setPort(stalled);                                // recorded port IS the stall
    const t0 = Date.now();
    const r = await callDashboard({
      configDir: dir, defaultPort: stalled + 500, probeSpan: 0, path: '/__cli/current',
      rescanWhenUnreachable: true, probeTimeoutMs: 300, discoveryBudgetMs: 1_000,
    });
    const elapsed = Date.now() - t0;
    expect(r).toEqual({ ok: false, reason: 'unreachable' });
    expect(elapsed).toBeLessThan(2_000);
  }, 40_000);

  it('a 500 with an ABORTED body does not block self-heal (abort must not read as http-error)', async () => {
    // Every status branch used to do `.text().catch(() => '')`, turning an aborted
    // body into an empty one. So `500 headers` + a body that never completes was
    // classified `http-error` — and `reachedDashboard(http-error)` is TRUE, so
    // rediscovery STOPPED and the stale port file survived. MEASURED before the
    // fix: `{reason:'http-error', detail:'500 '}` in 305ms, port file unchanged,
    // real dashboard never probed. A one-line label bug that silently defeats the
    // whole feature.
    const { createServer: netServer } = await import('node:net');
    const { createServer: httpServer } = await import('node:http');
    const stall = netServer((sock) => {
      liveSockets.push(sock);
      sock.on('data', () => {
        sock.write('HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\nhalf');
      });
    });
    stalls.push(stall);
    await new Promise<void>(r => stall.listen(0, '127.0.0.1', () => r()));
    const stallPort = (stall.address() as import('node:net').AddressInfo).port;

    const real = httpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: 'http://127.0.0.1/?t=found' }));
    });
    httpServers.push(real);
    await new Promise<void>(r => real.listen(0, '127.0.0.1', () => r()));
    const realPort = (real.address() as import('node:net').AddressInfo).port;

    setPort(stallPort);                       // recorded port IS the 500-staller
    const r = await callDashboard({
      configDir: dir, defaultPort: realPort, probeSpan: 0, path: '/__cli/current',
      rescanWhenUnreachable: true, probeTimeoutMs: 300, discoveryBudgetMs: 2_000,
    });
    expect(r.ok).toBe(true);                  // rediscovery ran and succeeded
    expect(readFileSync(join(dir, '.dashboard-port'), 'utf8').trim()).toBe(String(realPort));
  }, 40_000);

  it('a COMPLETE malformed body still classifies normally (abort fix must not over-reach)', async () => {
    // The counterpart: only an aborted read may become `unreachable`. A body that
    // finishes but is not valid JSON must remain http-error, as before.
    setPort(7891);
    const fetchImpl = (async () => new Response('not json at all', { status: 200 })) as unknown as typeof fetch;
    const r = await callDashboard({
      configDir: dir, defaultPort: 7891, path: '/__cli/current', fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('http-error');
  });

  it('the deadline STOPS issuing probes (clamp alone would still connect)', async () => {
    // Separable from the clamp, using CALL COUNT rather than wall clock: after the
    // budget expires the loop must issue no further requests. With `break` removed
    // but the clamp kept, the loop keeps calling fetchImpl with a ~0ms timeout —
    // elapsed time looks fine, but budgeted-out connections are still attempted.
    setPort(7893);
    let calls = 0;
    const slow = (async (input: string) => {
      calls++;
      await new Promise(r => setTimeout(r, 250));   // each probe eats the budget
      void input;
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await callDashboard({
      configDir: dir, defaultPort: 7891, probeSpan: 20, path: '/__cli/current',
      rescanWhenUnreachable: true, fetchImpl: slow,
      probeTimeoutMs: 5_000, discoveryBudgetMs: 600,
    });
    // 1 recorded-port attempt + ~2-3 probes inside a 600ms budget. Far below the
    // 21 the loop would attempt if the deadline never stopped it.
    expect(calls).toBeLessThan(8);
    expect(calls).toBeGreaterThan(1);
  }, 30_000);

  it('the clamp caps the LAST probe so the budget is not overrun by a full timeout', async () => {
    // Separable from the break, per codex's construction: pick
    // `budget < probeTimeout`, so the deadline expires DURING the first probe. With
    // the clamp the probe is cut at `remaining`; without it, that probe runs the
    // full probeTimeoutMs and the total overruns by nearly a whole timeout.
    const stalled = await stalledPort();
    setPort(stalled + 700);                    // recorded port: nobody listening
    const t0 = Date.now();
    const r = await callDashboard({
      configDir: dir, defaultPort: stalled, probeSpan: 1, path: '/__cli/current',
      rescanWhenUnreachable: true,
      probeTimeoutMs: 3_000,                   // >> budget on purpose
      discoveryBudgetMs: 400,
    });
    const elapsed = Date.now() - t0;
    expect(r).toEqual({ ok: false, reason: 'unreachable' });
    // Clamped: ~400ms. Unclamped: ~3s (the stall runs the full probe timeout).
    expect(elapsed).toBeLessThan(1_500);
  }, 30_000);

  it('the TOTAL budget bounds a span of many stalled ports, not just each probe', async () => {
    // Per-probe alone degrades to `stalled_count × probeTimeout` because the loop
    // is serial. A single stalled port cannot show this (the other candidates are
    // dead and fail instantly, so the deadline never binds — an earlier version of
    // this test made exactly that mistake and the mutation survived). Fill MANY
    // adjacent ports with stalled listeners so the serial cost is real.
    const { createServer: netServer } = await import('node:net');
    const probe = netServer();
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
    const lo = (probe.address() as import('node:net').AddressInfo).port;
    await new Promise<void>(r => probe.close(() => r()));

    let bound = 0;
    for (let i = 0; i < 10; i++) {
      const st = netServer((sock) => { liveSockets.push(sock); });
      try {
        await new Promise<void>((res, rej) => {
          st.once('error', rej); st.listen(lo + i, '127.0.0.1', () => res());
        });
        stalls.push(st); bound++;
      } catch { /* that port was taken; keep going */ }
    }
    // FAIL LOUD (see above): silently passing would make the deadline mutation
    // toothless in CI, which is the one place it most needs teeth.
    expect(bound, `fixture bound only ${bound} stalled ports; need >= 6 for the serial cost to show`).toBeGreaterThanOrEqual(6);

    setPort(lo + 900);                          // recorded port: nobody listening
    const t0 = Date.now();
    const r = await callDashboard({
      configDir: dir, defaultPort: lo, probeSpan: 10, path: '/__cli/current',
      rescanWhenUnreachable: true, probeTimeoutMs: 300, discoveryBudgetMs: 900,
    });
    const elapsed = Date.now() - t0;
    expect(r).toEqual({ ok: false, reason: 'unreachable' });
    // The budget is a HARD cap: the loop stops issuing probes at the deadline AND
    // clamps the last probe to the time remaining. This wall-clock threshold catches
    // the two bounds together (with 10 stalled ports and budget=900ms: ~910ms with
    // either in place, ~3.0s with both gone). Each bound ALSO has its own test with
    // a criterion that discriminates it individually — call-count for the deadline
    // break, `budget < probeTimeoutMs` for the clamp — so a single-bound regression
    // is caught there, not here.
    expect(elapsed).toBeLessThan(1_400);
    expect(readFileSync(join(dir, '.dashboard-port'), 'utf8').trim()).toBe(String(lo + 900));
  }, 40_000);

  it('returns the original unreachable within budget with one stall and the rest down', async () => {
    const a = await stalledPort();
    setPort(a + 5);                  // recorded port: nobody listening
    const t0 = Date.now();
    const r = await callDashboard({
      configDir: dir, defaultPort: a, probeSpan: 3, path: '/__cli/current',
      rescanWhenUnreachable: true, probeTimeoutMs: 300, discoveryBudgetMs: 2_000,
    });
    const elapsed = Date.now() - t0;
    expect(r).toEqual({ ok: false, reason: 'unreachable' });
    expect(elapsed).toBeLessThan(4_000);
    // fail-closed: a fruitless scan must not rewrite the port file.
    expect(readFileSync(join(dir, '.dashboard-port'), 'utf8').trim()).toBe(String(a + 5));
  }, 30_000);
});
