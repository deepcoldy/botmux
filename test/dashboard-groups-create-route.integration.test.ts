import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

import {
  __testOnly_resetBotRegistry,
  registerBot,
} from '../src/bot-registry.js';
import {
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { loopbackFetch, type LoopbackFetchInit } from '../src/core/loopback-fetch.js';
import { loadOrCreateDashboardSecret, loadOrCreatePersistedToken } from '../src/dashboard/auth.js';
import * as larkClient from '../src/im/lark/client.js';
import * as groupsStore from '../src/services/groups-store.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const DASHBOARD_ENTRY = resolve('src/index-dashboard.ts');

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as import('node:net').AddressInfo).port;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server || !server.listening) return;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
}

async function requestLoopback(url: string, init: LoopbackFetchInit = {}): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  timeout.unref();
  try {
    const response = await loopbackFetch(url, { ...init, signal: controller.signal });
    return { status: response.status, text: await response.text() };
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
        const res = await requestLoopback(`http://127.0.0.1:${port}/__health`);
        if (res.status === 200) return port;
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

describe('dashboard real HTTP route · POST /api/groups/create', () => {
  let rootDir = '';
  let kickoffSentinel: Server | undefined;
  let creatorIpc: IpcServerHandle | undefined;
  let dashboardChild: ChildProcess | undefined;

  afterEach(async () => {
    await stopChild(dashboardChild);
    dashboardChild = undefined;
    await closeServer(kickoffSentinel);
    kickoffSentinel = undefined;
    if (creatorIpc) {
      await creatorIpc.close();
      creatorIpc = undefined;
    }
    setIpcAuthSecret(null);
    setLarkAppId('');
    __testOnly_resetBotRegistry();
    vi.restoreAllMocks();
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = '';
    }
  });

  it('validates new options, routes around kickoffBotLarkAppId, authenticates over HMAC IPC, and returns full CreateGroupResult', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'dashboard-groups-create-'));
    const botmuxDir = join(rootDir, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    const daemonsDir = join(dataDir, 'dashboard-daemons');
    mkdirSync(daemonsDir, { recursive: true, mode: 0o700 });
    chmodSync(rootDir, 0o700);
    chmodSync(botmuxDir, 0o700);

    const token = loadOrCreatePersistedToken(join(botmuxDir, '.dashboard-token'));
    const secret = loadOrCreateDashboardSecret(join(botmuxDir, '.dashboard-secret'));

    const kickoffBot = 'cli_kickoff_first';
    const creatorBot = 'cli_creator_second';
    const apiOnlyBot = 'cli_api_only_bot';
    const deadBot = 'cli_dead_creator';

    writeFileSync(join(botmuxDir, 'bots.json'), JSON.stringify([
      { larkAppId: kickoffBot, larkAppSecret: 'sec_k', cliId: 'codex', workingDir: rootDir },
      { larkAppId: creatorBot, larkAppSecret: 'sec_c', cliId: 'claude-code', workingDir: rootDir },
      { larkAppId: apiOnlyBot, larkAppSecret: '', cliId: 'claude-code', apiOnly: true, workingDir: rootDir },
      { larkAppId: deadBot, larkAppSecret: 'sec_d', cliId: 'codex', workingDir: rootDir },
    ], null, 2));

    // Sentinel server for kickoffBot — MUST NEVER receive /api/groups/create when kickoffBot is the kickoff target.
    const kickoffSentinelHits: string[] = [];
    kickoffSentinel = createServer((req, res) => {
      if (req.url?.startsWith('/api/groups/create')) {
        kickoffSentinelHits.push(`${req.method} ${req.url}`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const kickoffPort = await listen(kickoffSentinel);

    // Live authenticated Daemon IPC server for creatorBot.
    registerBot({ larkAppId: creatorBot, larkAppSecret: 'sec_c', cliId: 'claude-code', workingDir: rootDir });
    setLarkAppId(creatorBot);
    setIpcAuthSecret(secret);

    let ownerTransferred = false;
    vi.spyOn(groupsStore, 'createChat').mockResolvedValue({
      chatId: 'oc_dash_live_1',
      invalidBotIds: [],
      invalidUserIds: [],
    });
    vi.spyOn(groupsStore, 'addBotToChat').mockResolvedValue([{ id: kickoffBot, ok: true }]);
    const shareLinkSpy = vi.spyOn(groupsStore, 'getChatShareLink').mockResolvedValue({
      ok: true,
      shareLink: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=tok_live',
    });
    vi.spyOn(groupsStore, 'transferChatOwner').mockImplementation(async () => {
      ownerTransferred = true;
      return { ok: true };
    });
    const managersSpy = vi.spyOn(groupsStore, 'addChatManagers').mockImplementation(async (_app, _chat, ids) => {
      // Enforce real Feishu invariant: creator bot cannot add managers after ownership transfer!
      if (ownerTransferred) return { ok: false, error: 'only owner can add managers (code: 232025)' };
      return { ok: true, addedManagers: ids };
    });
    vi.spyOn(larkClient, 'listChatBotMembers').mockResolvedValue([
      {
        larkAppId: kickoffBot,
        openId: 'ou_kickoff_obs',
        name: 'Kickoff Bot',
        displayName: 'Kickoff Bot',
        source: 'configured',
        hasTeamRole: false,
        mentionable: true,
        mentionSource: 'cross-ref',
      },
    ]);
    const sendSpy = vi.spyOn(larkClient, 'sendMessage').mockResolvedValue('om_dash_kickoff_live');

    creatorIpc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });

    // Reserve an unused closed port to verify 502 group_create_proxy_failed when creator daemon dies.
    const deadServer = createServer();
    const deadPort = await listen(deadServer);
    await closeServer(deadServer);

    const now = Date.now();
    const writeDescriptor = (larkAppId: string, ipcPort: number, resolvedAllowedUsers: string[]) => {
      writeFileSync(join(daemonsDir, `${larkAppId}.json`), JSON.stringify({
        larkAppId,
        ipcPort,
        pid: process.pid,
        botName: larkAppId,
        cliId: 'claude-code',
        resolvedAllowedUsers,
        lastHeartbeat: now,
      }));
    };
    writeDescriptor(kickoffBot, kickoffPort, ['ou_k_owner']);
    writeDescriptor(creatorBot, creatorIpc.port, ['ou_c_owner']);
    writeDescriptor(apiOnlyBot, kickoffPort, ['ou_api_owner']);
    writeDescriptor(deadBot, deadPort, ['ou_dead_owner']);

    const portPath = join(botmuxDir, '.dashboard-port');
    let stdout = '';
    let stderr = '';
    dashboardChild = spawnTsScript(DASHBOARD_ENTRY, [], {
      env: {
        ...process.env,
        HOME: rootDir,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: join(botmuxDir, 'bots.json'),
        BOTMUX_DASHBOARD_PORT: '0',
        BOTMUX_DASHBOARD_HOST: '127.0.0.1',
        BOTMUX_DASHBOARD_PORT_FILE: portPath,
        BOTMUX_NO_OPEN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    dashboardChild.stdout?.on('data', d => { stdout += String(d); });
    dashboardChild.stderr?.on('data', d => { stderr += String(d); });

    const dashPort = await waitForDashboardPort(portPath, dashboardChild, () => `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    const authHeaders = {
      'content-type': 'application/json',
      cookie: `botmux_dashboard_token=${token}`,
    };

    // 1. Invalid inputs fail closed with 400 before touching either daemon.
    for (const [body, expectedError] of [
      ['null', 'bad_json'],
      [JSON.stringify({ larkAppIds: [kickoffBot, creatorBot], kickoffBotLarkAppId: kickoffBot }), 'kickoff_args_must_be_paired'],
      [JSON.stringify({ larkAppIds: [kickoffBot, creatorBot], ownerNotice: 'false' }), 'invalid_owner_notice'],
      [JSON.stringify({ larkAppIds: [kickoffBot, creatorBot], managerUserIds: ['on_not_open_id'] }), 'invalid_manager_user_ids'],
      [JSON.stringify({ larkAppIds: [apiOnlyBot, creatorBot], kickoffBotLarkAppId: apiOnlyBot, kickoffPrompt: 'hi' }), 'lark_transport_disabled'],
    ] as const) {
      const bad = await requestLoopback(`http://127.0.0.1:${dashPort}/api/groups/create`, {
        method: 'POST',
        headers: authHeaders,
        body,
      });
      expect(bad.status).toBe(400);
      expect(JSON.parse(bad.text)).toEqual({ ok: false, error: expectedError });
    }
    expect(kickoffSentinelHits).toEqual([]);

    // 2. Full create with kickoffBot listed first + apiOnly bot also listed:
    //    Dashboard skips both kickoffBot and apiOnlyBot, routes to creatorBot over HMAC IPC,
    //    suppresses owner notice, promotes managerUserIds BEFORE owner transfer, and returns full CreateGroupResult.
    const okRes = await requestLoopback(`http://127.0.0.1:${dashPort}/api/groups/create`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Dashboard Live Collab',
        larkAppIds: [kickoffBot, apiOnlyBot, creatorBot],
        chatMode: 'topic',
        ownerNotice: false,
        managerUserIds: ['ou_mgr_live'],
        kickoffBotLarkAppId: kickoffBot,
        kickoffPrompt: '请开始协作任务',
      }),
    });
    expect(okRes.status, okRes.text).toBe(200);
    expect(JSON.parse(okRes.text)).toMatchObject({
      ok: true,
      chatId: 'oc_dash_live_1',
      creator: creatorBot,
      autoInvitedOpenId: 'ou_c_owner',
      shareLink: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=tok_live',
      shareLinkError: null,
      ownerTransferredTo: 'ou_c_owner',
      managersAdded: ['ou_mgr_live'],
      managerError: null,
      notifyMessageId: null,
      notifyError: null,
      kickoffMessageId: 'om_dash_kickoff_live',
      kickoffError: null,
    });
    expect(kickoffSentinelHits).toEqual([]);
    expect(managersSpy).toHaveBeenCalledWith(creatorBot, 'oc_dash_live_1', ['ou_mgr_live']);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // 3. Partial-failure response (`shareLinkError`) is preserved verbatim.
    ownerTransferred = false;
    shareLinkSpy.mockResolvedValueOnce({ ok: false, error: 'link_denied (code: 99991672)' });
    const partialRes = await requestLoopback(`http://127.0.0.1:${dashPort}/api/groups/create`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ larkAppIds: [creatorBot], ownerNotice: false }),
    });
    expect(partialRes.status).toBe(200);
    expect(JSON.parse(partialRes.text)).toMatchObject({
      ok: true,
      chatId: 'oc_dash_live_1',
      shareLink: null,
      shareLinkError: 'link_denied (code: 99991672)',
    });

    // 4. Dead creator daemon returns clean 502 { ok: false, error: 'group_create_proxy_failed' } instead of 500.
    const deadRes = await requestLoopback(`http://127.0.0.1:${dashPort}/api/groups/create`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ larkAppIds: [deadBot] }),
    });
    expect(deadRes.status).toBe(502);
    expect(JSON.parse(deadRes.text)).toEqual({ ok: false, error: 'group_create_proxy_failed' });

    // 5. Malformed percent-encoding in Dashboard members-display proxy returns 400 invalid_url_encoding instead of 500.
    const badEncoding = await requestLoopback(`http://127.0.0.1:${dashPort}/api/groups/${creatorBot}/%ZZ/members-display`, {
      method: 'GET',
      headers: { cookie: `botmux_dashboard_token=${token}` },
    });
    expect(badEncoding.status).toBe(400);
    expect(JSON.parse(badEncoding.text)).toEqual({ ok: false, error: 'invalid_url_encoding' });
  }, 30_000);
});
