import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

import { spawnTsScript } from './helpers/ts-runner.js';
import { loadOrCreatePersistedToken } from '../src/dashboard/auth.js';
import { loopbackFetch, type LoopbackFetchInit } from '../src/core/loopback-fetch.js';

const DASHBOARD_ENTRY = resolve('src/index-dashboard.ts');

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as import('node:net').AddressInfo).port;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
}

type LoopbackResponse = {
  status: number;
  bodyText: string;
};

async function requestLoopback(
  url: string,
  init: LoopbackFetchInit = {},
): Promise<LoopbackResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  timeout.unref();
  try {
    const response = await loopbackFetch(url, { ...init, signal: controller.signal });
    return { status: response.status, bodyText: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForDashboardPort(
  portPath: string,
  child: ChildProcess,
  logs: () => string,
  timeoutMs = 15_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`dashboard exited early\n${logs()}`);
    }
    try {
      const port = Number(readFileSync(portPath, 'utf8').trim());
      if (Number.isInteger(port) && port > 0 && port <= 65_535) {
        const response = await requestLoopback(`http://127.0.0.1:${port}/__health`);
        if (response.status === 200) return port;
      }
    } catch {
      // still booting
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
  throw new Error(`timeout waiting for dashboard port/health\n${logs()}`);
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closePromise = once(child, 'close');
  child.kill('SIGTERM');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      closePromise.then(() => 'closed' as const),
      new Promise<'timeout'>(resolveTimeout => {
        timeout = setTimeout(() => resolveTimeout('timeout'), 10_000);
        timeout.unref();
      }),
    ]);
    if (outcome === 'timeout' && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await closePromise;
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe('dashboard group mutation route auth', () => {
  let rootDir = '';
  let fakeDaemon: Server | undefined;
  let dashboardChild: ChildProcess | undefined;

  afterEach(async () => {
    await stopChild(dashboardChild);
    dashboardChild = undefined;
    await closeServer(fakeDaemon);
    fakeDaemon = undefined;
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    rootDir = '';
  });

  it('returns 401 before reaching the daemon for anonymous PUTs, including publicReadOnly mode', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'botmux-dashboard-pin-auth-'));
    const homeDir = join(rootDir, 'home');
    const botmuxDir = join(homeDir, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    const registryDir = join(dataDir, 'dashboard-daemons');
    const botsConfigPath = join(botmuxDir, 'bots.json');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(botmuxDir, '.dashboard-secret'), 'dashboard-secret-for-pin-auth-test', { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.data-dir'), `${dataDir}\n`, { mode: 0o600 });
    writeFileSync(botsConfigPath, JSON.stringify([{
      larkAppId: 'cli auth-test-app',
      larkAppSecret: 'secret',
      botName: 'auth test bot',
      cliId: 'codex',
    }], null, 2));
    const dashboardToken = loadOrCreatePersistedToken(join(botmuxDir, '.dashboard-token'));

    const daemonWrites: Array<{ method: string; url: string; body: string }> = [];
    fakeDaemon = createServer(async (req, res) => {
      const url = req.url ?? '/';
      const bodyChunks: Buffer[] = [];
      for await (const chunk of req) bodyChunks.push(chunk as Buffer);
      const body = Buffer.concat(bodyChunks).toString('utf8');
      if (req.method === 'PUT' && (
        url === '/api/chat-pin-streaming-card/oc%20auth%2Ftopic'
        || url === '/api/groups/oc%20auth%2Ftopic/name'
      )) {
        daemonWrites.push({ method: req.method, url, body });
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, changed: true }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unexpected_route' }));
    });
    const fakeDaemonPort = await listen(fakeDaemon);

    writeFileSync(join(registryDir, 'cli auth-test-app.json'), JSON.stringify({
      larkAppId: 'cli auth-test-app',
      botName: 'auth test bot',
      botIndex: 0,
      ipcPort: fakeDaemonPort,
      pid: process.pid,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    }));

    dashboardChild = spawnTsScript(DASHBOARD_ENTRY, [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: botsConfigPath,
        // Let the dashboard's real listenWithProbe own selection and publish
        // the exact bound port to the isolated HOME; no reserve/release race.
        BOTMUX_DASHBOARD_PORT: '7891',
        BOTMUX_DASHBOARD_HOST: '127.0.0.1',
        BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    dashboardChild.stdout?.on('data', chunk => { stdout += String(chunk); });
    let stderr = '';
    dashboardChild.stderr?.on('data', chunk => { stderr += String(chunk); });

    const dashboardPort = await waitForDashboardPort(
      join(botmuxDir, '.dashboard-port'),
      dashboardChild,
      () => `${stdout}\n${stderr}`,
    );
    const base = `http://127.0.0.1:${dashboardPort}`;
    const pinRoute = `${base}/api/groups/${encodeURIComponent('oc auth/topic')}`
      + `/pin-streaming-card/${encodeURIComponent('cli auth-test-app')}`;
    const renameRoute = `${base}/api/groups/${encodeURIComponent('oc auth/topic')}`
      + `/name/${encodeURIComponent('cli auth-test-app')}`;
    const anonymousPin = () => requestLoopback(pinRoute, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const authenticatedPin = await requestLoopback(pinRoute, {
      method: 'PUT',
      headers: {
        cookie: `botmux_dashboard_token=${dashboardToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect({ status: authenticatedPin.status, daemonWrites }, stderr).toEqual({
      status: 202,
      daemonWrites: [{
        method: 'PUT',
        url: '/api/chat-pin-streaming-card/oc%20auth%2Ftopic',
        body: '{"enabled":false}',
      }],
    });
    daemonWrites.length = 0;

    const authenticatedRename = await requestLoopback(renameRoute, {
      method: 'PUT',
      headers: {
        cookie: `botmux_dashboard_token=${dashboardToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'New name' }),
    });
    expect({ status: authenticatedRename.status, daemonWrites }, stderr).toEqual({
      status: 202,
      daemonWrites: [{
        method: 'PUT',
        url: '/api/groups/oc%20auth%2Ftopic/name',
        body: '{"name":"New name"}',
      }],
    });
    daemonWrites.length = 0;

    const oversizedRename = await requestLoopback(renameRoute, {
      method: 'PUT',
      headers: {
        cookie: `botmux_dashboard_token=${dashboardToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'x'.repeat(4_096) }),
    });
    expect(JSON.parse(oversizedRename.bodyText)).toEqual({ ok: false, error: 'body_too_large' });
    expect({ status: oversizedRename.status, daemonWrites }, stderr).toEqual({ status: 413, daemonWrites: [] });

    const privateModeDenied = await anonymousPin();
    expect({ status: privateModeDenied.status, daemonWrites }, stderr).toEqual({
      status: 401,
      daemonWrites: [],
    });
    const privateRenameDenied = await requestLoopback(renameRoute, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Denied' }),
    });
    expect({ status: privateRenameDenied.status, daemonWrites }, stderr).toEqual({ status: 401, daemonWrites: [] });

    const enablePublicReadOnly = await requestLoopback(`${base}/api/settings`, {
      method: 'PUT',
      headers: {
        cookie: `botmux_dashboard_token=${dashboardToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ publicReadOnly: true }),
    });
    expect(enablePublicReadOnly.status, stderr).toBe(200);

    const anonymousSettings = await requestLoopback(`${base}/api/settings`);
    expect(anonymousSettings.status, stderr).toBe(200);
    expect(JSON.parse(anonymousSettings.bodyText)).toMatchObject({
      authed: false,
      settings: { publicReadOnly: true },
    });

    const publicModeDenied = await anonymousPin();
    expect({ status: publicModeDenied.status, daemonWrites }, stderr).toEqual({
      status: 401,
      daemonWrites: [],
    });
    const publicRenameDenied = await requestLoopback(renameRoute, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Denied' }),
    });
    expect({ status: publicRenameDenied.status, daemonWrites }, stderr).toEqual({ status: 401, daemonWrites: [] });
  }, 20_000);
});
