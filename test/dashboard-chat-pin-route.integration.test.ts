import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

import { spawnTsScript } from './helpers/ts-runner.js';
import { loadOrCreatePersistedToken } from '../src/dashboard/auth.js';

const DASHBOARD_ENTRY = resolve('src/index-dashboard.ts');

type CapturedRequest = {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
};

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as import('node:net').AddressInfo).port;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  if (!server.listening) return;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return readFileSync(path, 'utf8').trim();
    } catch {
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
  }
  throw new Error(`timeout waiting for file ${path}`);
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  return port;
}

async function waitForDashboard(base: string, child: ChildProcess, logs: () => string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
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

describe('dashboard real HTTP route · PUT /api/groups/:chatId/pin-streaming-card/:appId', () => {
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

  it('decodes params, forwards the JSON body verbatim, preserves upstream status/body, and invalidates the groups cache', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'botmux-dashboard-pin-route-'));
    const homeDir = join(rootDir, 'home');
    const botmuxDir = join(homeDir, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    const dashboardPort = await reservePort();
    const botsConfigPath = join(botmuxDir, 'bots.json');
    const registryDir = join(dataDir, 'dashboard-daemons');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(botmuxDir, '.dashboard-secret'), 'dashboard-secret-for-route-test', { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.data-dir'), `${dataDir}\n`, { mode: 0o600 });
    writeFileSync(botsConfigPath, JSON.stringify([{
      larkAppId: 'cli test-app',
      larkAppSecret: 'secret',
      botName: 'bot A',
      cliId: 'codex',
    }], null, 2));

    const fakeGroupReads: string[] = [];
    const fakePinWrites: CapturedRequest[] = [];
    let groupsReadCount = 0;

    fakeDaemon = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '/';
      if (req.method === 'GET' && url === '/api/groups') {
        groupsReadCount += 1;
        fakeGroupReads.push(url);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          chats: [{
            chatId: 'oc topic/with slash',
            name: `group read ${groupsReadCount}`,
            pinStreamingCardMasterEnabled: true,
            pinStreamingCardChatEnabled: groupsReadCount >= 2 ? false : true,
            pinStreamingCardEffectiveEnabled: groupsReadCount >= 2 ? false : true,
          }],
        }));
        return;
      }
      if (req.method === 'PUT' && url === '/api/chat-pin-streaming-card/oc%20topic%2Fwith%20slash') {
        fakePinWrites.push({
          method: req.method ?? 'GET',
          url,
          body,
          headers: req.headers,
        });
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, enabled: false, changed: true, source: 'fake-daemon' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unexpected_route', method: req.method, url }));
    });
    const fakeDaemonPort = await listen(fakeDaemon);

    writeFileSync(join(registryDir, 'cli test-app.json'), JSON.stringify({
      larkAppId: 'cli test-app',
      botName: 'bot A',
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

    const tokenPath = join(botmuxDir, '.dashboard-token');
    const dashboardToken = loadOrCreatePersistedToken(tokenPath);
    const base = `http://127.0.0.1:${dashboardPort}`;
    await waitForDashboard(base, dashboardChild, () => `${stdout}\n${stderr}`);

    const firstGroups = await fetch(`${base}/api/groups`, {
      headers: { cookie: `botmux_dashboard_token=${dashboardToken}` },
    });
    expect(firstGroups.status, stderr).toBe(200);
    expect(await firstGroups.json()).toMatchObject({
      chats: [{
        chatId: 'oc topic/with slash',
        name: 'group read 1',
        memberBots: [{
          larkAppId: 'cli test-app',
          pinStreamingCardMasterEnabled: true,
          pinStreamingCardChatEnabled: true,
          pinStreamingCardEffectiveEnabled: true,
        }],
      }],
    });

    const writeResponse = await fetch(
      `${base}/api/groups/${encodeURIComponent('oc topic/with slash')}/pin-streaming-card/${encodeURIComponent('cli test-app')}`,
      {
        method: 'PUT',
        headers: {
          cookie: `botmux_dashboard_token=${dashboardToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(writeResponse.status, stderr).toBe(202);
    expect(await writeResponse.json()).toEqual({ ok: true, enabled: false, changed: true, source: 'fake-daemon' });

    expect(fakePinWrites).toHaveLength(1);
    expect(fakePinWrites[0]).toMatchObject({
      method: 'PUT',
      url: '/api/chat-pin-streaming-card/oc%20topic%2Fwith%20slash',
      body: '{"enabled":false}',
    });
    expect(String(fakePinWrites[0].headers['content-type'])).toContain('application/json');

    const secondGroups = await fetch(`${base}/api/groups`, {
      headers: { cookie: `botmux_dashboard_token=${dashboardToken}` },
    });
    expect(secondGroups.status, stderr).toBe(200);
    expect(await secondGroups.json()).toMatchObject({
      chats: [{
        chatId: 'oc topic/with slash',
        name: 'group read 2',
        memberBots: [{
          larkAppId: 'cli test-app',
          pinStreamingCardMasterEnabled: true,
          pinStreamingCardChatEnabled: false,
          pinStreamingCardEffectiveEnabled: false,
        }],
      }],
    });
    expect(fakeGroupReads).toHaveLength(2);
  }, 20_000);
});
