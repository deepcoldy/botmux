import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

import { spawnTsScript } from './helpers/ts-runner.js';
import { loadOrCreatePersistedToken } from '../src/dashboard/auth.js';

const DASHBOARD_ENTRY = resolve('src/index-dashboard.ts');

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as import('node:net').AddressInfo).port;
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  return port;
}

async function waitForDashboard(base: string, child: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`dashboard exited early\n${logs()}`);
    }
    try {
      const response = await fetch(`${base}/__health`);
      if (response.ok) return;
    } catch {
      // still booting
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
  throw new Error(`timeout waiting for dashboard health\n${logs()}`);
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'close'),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 10_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'close');
  }
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
}

describe('dashboard real HTTP route · Bot agent defaults round trip', () => {
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

  it('keeps TraeX modelBackendVariant after saving and reloading /api/bots', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'botmux-dashboard-agent-roundtrip-'));
    const homeDir = join(rootDir, 'home');
    const botmuxDir = join(homeDir, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    const registryDir = join(dataDir, 'dashboard-daemons');
    const botsConfigPath = join(botmuxDir, 'bots.json');
    const dashboardPort = await reservePort();
    const appId = 'cli_traex_roundtrip';
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(botmuxDir, '.dashboard-secret'), 'dashboard-secret-for-agent-roundtrip', { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.data-dir'), `${dataDir}\n`, { mode: 0o600 });
    writeFileSync(botsConfigPath, JSON.stringify([{
      larkAppId: appId,
      larkAppSecret: 'secret',
      botName: 'TraeX Bot',
      cliId: 'traex',
      model: 'GPT-5.6-Sol',
      modelBackendVariant: 'standard',
    }], null, 2));

    // Start as an old daemon response (field omitted): /api/bots must fall back
    // to bots.json. Later writes exercise new-daemon max and explicit-null data.
    let modelBackendVariant: 'standard' | 'max' | null | undefined;
    fakeDaemon = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';
      if (req.method === 'GET' && url === '/api/bot-default-oncall') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          larkAppId: appId,
          botName: 'TraeX Bot',
          cliId: 'traex',
          model: 'GPT-5.6-Sol',
          modelBackendVariant,
        }));
        return;
      }
      if (req.method === 'PUT' && url === '/api/bot-agent') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (Object.prototype.hasOwnProperty.call(body, 'modelBackendVariant')) {
          modelBackendVariant = body.modelBackendVariant === 'standard' || body.modelBackendVariant === 'max'
            ? body.modelBackendVariant
            : null;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          cliId: 'traex',
          model: 'GPT-5.6-Sol',
          modelBackendVariant,
        }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unexpected_route', method: req.method, url }));
    });
    const fakeDaemonPort = await listen(fakeDaemon);

    writeFileSync(join(registryDir, `${appId}.json`), JSON.stringify({
      larkAppId: appId,
      botName: 'TraeX Bot',
      cliId: 'traex',
      botIndex: 0,
      ipcPort: fakeDaemonPort,
      pid: process.pid,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    }));

    const dashboardToken = loadOrCreatePersistedToken(join(botmuxDir, '.dashboard-token'));
    dashboardChild = spawnTsScript(DASHBOARD_ENTRY, [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: botsConfigPath,
        BOTMUX_DASHBOARD_PORT: String(dashboardPort),
        BOTMUX_DASHBOARD_HOST: '127.0.0.1',
        BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    dashboardChild.stdout?.on('data', chunk => { stdout += String(chunk); });
    let stderr = '';
    dashboardChild.stderr?.on('data', chunk => { stderr += String(chunk); });
    const logs = () => `${stdout}\n${stderr}`;
    const base = `http://127.0.0.1:${dashboardPort}`;
    const headers = { cookie: `botmux_dashboard_token=${dashboardToken}` };
    await waitForDashboard(base, dashboardChild, logs);

    const initial = await fetch(`${base}/api/bots`, { headers });
    expect(initial.status, logs()).toBe(200);
    expect(await initial.json()).toMatchObject({
      bots: [{ larkAppId: appId, modelBackendVariant: 'standard' }],
    });

    const saved = await fetch(`${base}/api/bots/${encodeURIComponent(appId)}/agent`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        cliId: 'traex',
        model: 'GPT-5.6-Sol',
        modelBackendVariant: 'max',
      }),
    });
    expect(saved.status, logs()).toBe(200);
    expect(await saved.json()).toMatchObject({ modelBackendVariant: 'max' });

    const reloaded = await fetch(`${base}/api/bots`, { headers });
    expect(reloaded.status, logs()).toBe(200);
    expect(await reloaded.json()).toMatchObject({
      bots: [{ larkAppId: appId, modelBackendVariant: 'max' }],
    });

    const cleared = await fetch(`${base}/api/bots/${encodeURIComponent(appId)}/agent`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        cliId: 'traex',
        model: 'GPT-5.6-Sol',
        modelBackendVariant: '',
      }),
    });
    expect(cleared.status, logs()).toBe(200);
    expect(await cleared.json()).toMatchObject({ modelBackendVariant: null });

    const afterClear = await fetch(`${base}/api/bots`, { headers });
    expect(afterClear.status, logs()).toBe(200);
    const afterClearBody = await afterClear.json() as { bots: Array<Record<string, unknown>> };
    expect(afterClearBody.bots).toHaveLength(1);
    expect(afterClearBody.bots[0]).not.toHaveProperty('modelBackendVariant');
  }, 20_000);
});
