// Real Dashboard process and real `/events` routing for the WeCom session hint:
// only the host admin's stream (local management cookie) hears it — not a
// platform co-manager (management rights, but not the host admin), not a
// Workbench-only platform identity, not an anonymous public-read visitor — and
// only the host admin may read `/api/wecom/sessions`. A bare `?t=` request is
// redirected by the Dashboard's gate before any handler runs (it comes back with
// the management cookie, i.e. as the host admin). Without WeCom configuration nobody hears
// anything. HOME is a temp dir; the one WeCom "connection" is a config file the
// session reader cannot use, so no gateway, core or WeCom service is involved.
import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { spawnTsScript } from './helpers/ts-runner.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';
import { loadOrCreatePersistedToken } from '../src/dashboard/auth.js';
import { loopbackFetch } from '../src/core/loopback-fetch.js';
import { WECOM_SESSIONS_HINT_EVENT, WECOM_SESSION_OBSERVER_INTERVAL_MS } from '../src/dashboard/wecom/session-observer.js';

const HINT = `event: ${WECOM_SESSIONS_HINT_EVENT}\n`;

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  timer.unref();
  try { await closed; } finally { clearTimeout(timer); }
}

/** An open `/events` stream that keeps every byte it receives. */
function openStream(url: string, headers: Record<string, string>) {
  const stream = { text: '', status: 0, request: undefined as ClientRequest | undefined };
  const opened = new Promise<void>((done, fail) => {
    stream.request = httpRequest(url, { headers }, res => {
      stream.status = res.statusCode ?? 0;
      res.setEncoding('utf8');
      res.on('data', chunk => { stream.text += chunk; });
      done();
    });
    stream.request.on('error', fail);
    stream.request.end();
  });
  return { stream, opened };
}

const hints = (text: string) => text.split(HINT).length - 1;

async function until(check: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
  return check();
}

describe('Dashboard WeCom session hint on /events', () => {
  let root = '';
  let child: ChildProcess | undefined;
  const streams: Array<{ request?: ClientRequest }> = [];

  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.request?.destroy();
    await stopChild(child); child = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
    await releaseWecomCorePorts();
  });

  it('reaches only the host admin\'s stream, only while WeCom connections exist, and the read stays host-admin only', async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-wecom-hint-'));
    const home = join(root, 'home');
    const botmuxDir = join(home, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    const botsPath = join(botmuxDir, 'bots.json');
    mkdirSync(join(dataDir, 'dashboard-daemons'), { recursive: true });
    writeFileSync(join(botmuxDir, '.dashboard-secret'), 'isolated-wecom-hint-secret', { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.data-dir'), `${dataDir}\n`, { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.env'), '', { mode: 0o600 });
    writeFileSync(botsPath, '[]');
    const token = loadOrCreatePersistedToken(join(botmuxDir, '.dashboard-token'));

    child = spawnTsScript(resolve('src/index-dashboard.ts'), [], {
      cwd: resolve('.'),
      env: { ...process.env, HOME: home, USERPROFILE: home, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: botsPath,
        BOTMUX_DASHBOARD_PORT: String(await reserveWecomCorePort()), BOTMUX_DASHBOARD_HOST: '127.0.0.1', BOTMUX_DASHBOARD_PUBLIC_READONLY: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout?.on('data', chunk => { logs += String(chunk); });
    child.stderr?.on('data', chunk => { logs += String(chunk); });
    let origin = '';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !origin) {
      if (child.exitCode !== null || child.signalCode !== null) throw Error(`Dashboard exited early\n${logs}`);
      try {
        const candidate = `http://127.0.0.1:${Number(readFileSync(join(botmuxDir, '.dashboard-port'), 'utf8').trim())}`;
        if ((await loopbackFetch(`${candidate}/api/settings`, { signal: AbortSignal.timeout(2_000) })).ok) origin = candidate;
      } catch { /* the real process is still starting */ }
      if (!origin) await new Promise(done => setTimeout(done, 50));
    }
    expect(origin, logs).not.toBe('');

    // A bound platform with an unreachable URL: identities the platform proxy injects are accepted.
    writeFileSync(join(botmuxDir, 'platform.json'), JSON.stringify({ platformUrl: 'http://127.0.0.1:1', machineId: 'isolated-machine', machineToken: 'isolated-token' }), { mode: 0o600 });
    const cookie = `botmux_dashboard_token=${token}`;
    const tokenOnly = { query: `?t=${encodeURIComponent(token)}`, headers: {} as Record<string, string> };
    const identities: Record<string, { query?: string; headers: Record<string, string> }> = {
      hostAdmin: { headers: { cookie } },
      platformCoManager: { headers: { cookie, 'x-botmux-role': 'owner', 'x-botmux-actor': 'on_isolated_manager', 'x-botmux-scopes': 'dashboard:manage' } },
      workbench: { headers: { cookie, 'x-botmux-role': 'guest', 'x-botmux-actor': 'on_isolated_viewer' } },
      anonymous: { headers: {} },
    };
    const open = Object.fromEntries(Object.entries(identities).map(([name, who]) => {
      const { stream, opened } = openStream(`${origin}/events${who.query ?? ''}`, who.headers);
      streams.push(stream);
      return [name, { stream, opened }];
    }));
    await Promise.all(Object.values(open).map(entry => entry.opened));
    for (const [name, entry] of Object.entries(open)) expect(entry.stream.status, name).toBe(200);
    const tokenStream = await loopbackFetch(`${origin}/events${tokenOnly.query}`, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
    expect(tokenStream.status).toBe(302);
    expect(await tokenStream.text()).not.toContain(WECOM_SESSIONS_HINT_EVENT);
    const text = (name: string) => open[name].stream.text;
    const board = () => loopbackFetch(`${origin}/api/sessions?view=board`, { headers: identities.hostAdmin.headers, signal: AbortSignal.timeout(5_000) });

    // Feishu only (no WeCom configuration): the board request counts nothing; no stream hears a hint.
    expect((await board()).status).toBe(200);
    await new Promise(done => setTimeout(done, WECOM_SESSION_OBSERVER_INTERVAL_MS + 1_500));
    for (const name of Object.keys(open)) expect(hints(text(name)), name).toBe(0);

    // One WeCom connection: the next board request tells the observer, whose first collection hints.
    mkdirSync(join(botmuxDir, 'wecom'), { recursive: true });
    writeFileSync(join(botmuxDir, 'wecom', 'config.json'), '{}');
    expect((await (await board()).json()).wecomConnectionCount).toBe(1);
    expect(await until(() => hints(text('hostAdmin')) === 1, WECOM_SESSION_OBSERVER_INTERVAL_MS * 2), logs).toBe(true);
    for (const name of ['platformCoManager', 'workbench', 'anonymous']) expect(hints(text(name)), name).toBe(0);

    const read = (who: { query?: string; headers: Record<string, string> }) => loopbackFetch(
      `${origin}/api/wecom/sessions${who.query ?? ''}`, { headers: who.headers, redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    const admin = await read(identities.hostAdmin);
    expect(admin.status).toBe(200);
    expect(await admin.json()).toEqual({ sessions: [], wecomSessionIds: [], wecomConnectionCount: 1 });
    expect((await read(identities.platformCoManager)).status).toBe(403);
    expect((await read(tokenOnly)).status).toBe(302);
    // Workbench-only and anonymous never get past the Dashboard's own gate (as for /api/wecom/connections).
    for (const name of ['workbench', 'anonymous']) expect((await read(identities[name])).status, name).toBe(401);

    // The host admin closes its only page. With no host-admin stream left the observer stops and
    // forgets its last read, so the next host-admin stream hears the first collection again —
    // without a board request: the observer still knows a connection exists. Had the closed
    // stream stayed subscribed, the observer would have kept collecting unchanged rows and the
    // new stream would hear nothing.
    open.hostAdmin.stream.request?.destroy();
    await new Promise(done => setTimeout(done, 500));
    const reopened = openStream(`${origin}/events`, identities.hostAdmin.headers);
    streams.push(reopened.stream);
    await reopened.opened;
    expect(reopened.stream.status).toBe(200);
    expect(await until(() => hints(reopened.stream.text) === 1, WECOM_SESSION_OBSERVER_INTERVAL_MS * 2), logs).toBe(true);
    expect(hints(text('hostAdmin'))).toBe(1);

    // The connection goes away: one last hint, then nothing more.
    rmSync(join(botmuxDir, 'wecom', 'config.json'));
    expect(await until(() => hints(reopened.stream.text) === 2, WECOM_SESSION_OBSERVER_INTERVAL_MS * 2), logs).toBe(true);
    await new Promise(done => setTimeout(done, WECOM_SESSION_OBSERVER_INTERVAL_MS + 1_500));
    expect(hints(reopened.stream.text)).toBe(2);
    for (const name of ['platformCoManager', 'workbench', 'anonymous']) expect(hints(text(name)), name).toBe(0);
    // Every stream still got the Dashboard's ordinary frames.
    for (const name of Object.keys(open)) expect(text(name), name).toContain('event: bots.roster');
    expect(reopened.stream.text).toContain('event: bots.roster');
  }, 90_000);
});
