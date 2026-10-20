import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

import { spawnTsScript } from './helpers/ts-runner.js';
import { loadOrCreatePersistedToken } from '../src/dashboard/auth.js';
import { loopbackFetch, type LoopbackFetchInit } from '../src/core/loopback-fetch.js';

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

describe('dashboard real HTTP route · PUT /api/groups/:chatId/pin-streaming-card/:appId', () => {
  let rootDir = '';
  let fakeDaemon: Server | undefined;
  let absentBotDaemon: Server | undefined;
  let dashboardChild: ChildProcess | undefined;

  afterEach(async () => {
    await stopChild(dashboardChild);
    dashboardChild = undefined;
    await closeServer(fakeDaemon);
    fakeDaemon = undefined;
    await closeServer(absentBotDaemon);
    absentBotDaemon = undefined;
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    rootDir = '';
  });

  it('decodes params, forwards the JSON body verbatim, preserves upstream status/body, and invalidates the groups cache', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'botmux-dashboard-pin-route-'));
    const homeDir = join(rootDir, 'home');
    const botmuxDir = join(homeDir, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    const botsConfigPath = join(botmuxDir, 'bots.json');
    const registryDir = join(dataDir, 'dashboard-daemons');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(botmuxDir, '.dashboard-secret'), 'dashboard-secret-for-route-test', { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.data-dir'), `${dataDir}\n`, { mode: 0o600 });
    writeFileSync(botsConfigPath, JSON.stringify([
      {
        larkAppId: 'cli test-app',
        larkAppSecret: 'secret',
        botName: 'bot A',
        cliId: 'codex',
      },
      {
        larkAppId: 'cli absent-app',
        larkAppSecret: 'secret',
        botName: 'bot B',
        cliId: 'claude-code',
      },
    ], null, 2));

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
    absentBotDaemon = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url === '/api/groups') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ chats: [] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unexpected_route', method: req.method, url: req.url }));
    });
    const absentBotDaemonPort = await listen(absentBotDaemon);

    writeFileSync(join(registryDir, 'cli test-app.json'), JSON.stringify({
      larkAppId: 'cli test-app',
      botName: 'bot A',
      botIndex: 0,
      ipcPort: fakeDaemonPort,
      pid: process.pid,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    }));
    writeFileSync(join(registryDir, 'cli absent-app.json'), JSON.stringify({
      larkAppId: 'cli absent-app',
      botName: 'bot B',
      botIndex: 1,
      ipcPort: absentBotDaemonPort,
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

    const tokenPath = join(botmuxDir, '.dashboard-token');
    const dashboardToken = loadOrCreatePersistedToken(tokenPath);
    const dashboardPort = await waitForDashboardPort(
      join(botmuxDir, '.dashboard-port'),
      dashboardChild,
      () => `${stdout}\n${stderr}`,
    );
    const base = `http://127.0.0.1:${dashboardPort}`;

    const firstGroups = await requestLoopback(`${base}/api/groups`, {
      headers: { cookie: `botmux_dashboard_token=${dashboardToken}` },
    });
    expect(firstGroups.status, stderr).toBe(200);
    const firstGroupsPayload = JSON.parse(firstGroups.bodyText) as {
      chats: Array<{
        chatId: string;
        name: string;
        memberBots: Array<Record<string, unknown>>;
      }>;
    };
    expect(firstGroupsPayload).toMatchObject({
      chats: [{
        chatId: 'oc topic/with slash',
        name: 'group read 1',
      }],
    });
    const presentBot = firstGroupsPayload.chats[0].memberBots.find(bot => bot.larkAppId === 'cli test-app');
    expect(presentBot).toMatchObject({
      inChat: true,
      pinStreamingCardMasterEnabled: true,
      pinStreamingCardChatEnabled: true,
      pinStreamingCardEffectiveEnabled: true,
    });
    const absentBot = firstGroupsPayload.chats[0].memberBots.find(bot => bot.larkAppId === 'cli absent-app');
    expect(absentBot).toMatchObject({ inChat: false });
    expect(absentBot).not.toHaveProperty('pinStreamingCardMasterEnabled');
    expect(absentBot).not.toHaveProperty('pinStreamingCardChatEnabled');
    expect(absentBot).not.toHaveProperty('pinStreamingCardEffectiveEnabled');

    const writeResponse = await requestLoopback(
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
    expect(JSON.parse(writeResponse.bodyText)).toEqual({
      ok: true,
      enabled: false,
      changed: true,
      source: 'fake-daemon',
    });

    expect(fakePinWrites).toHaveLength(1);
    expect(fakePinWrites[0]).toMatchObject({
      method: 'PUT',
      url: '/api/chat-pin-streaming-card/oc%20topic%2Fwith%20slash',
      body: '{"enabled":false}',
    });
    expect(String(fakePinWrites[0].headers['content-type'])).toContain('application/json');

    const secondGroups = await requestLoopback(`${base}/api/groups`, {
      headers: { cookie: `botmux_dashboard_token=${dashboardToken}` },
    });
    expect(secondGroups.status, stderr).toBe(200);
    const secondGroupsPayload = JSON.parse(secondGroups.bodyText) as {
      chats: Array<{
        chatId: string;
        name: string;
        memberBots: Array<Record<string, unknown>>;
      }>;
    };
    expect(secondGroupsPayload).toMatchObject({
      chats: [{
        chatId: 'oc topic/with slash',
        name: 'group read 2',
      }],
    });
    expect(secondGroupsPayload.chats[0].memberBots.find(bot => bot.larkAppId === 'cli test-app')).toMatchObject({
      inChat: true,
      pinStreamingCardMasterEnabled: true,
      pinStreamingCardChatEnabled: false,
      pinStreamingCardEffectiveEnabled: false,
    });
    expect(fakeGroupReads).toHaveLength(2);
  }, 20_000);
});
