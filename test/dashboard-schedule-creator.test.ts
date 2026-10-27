/**
 * Dashboard schedule writes are recorded as the Feishu-login person, and only
 * when that person really came through the platform.
 *
 * Three layers, each against production code:
 *   1. the platform tunnel bridge marks the loopback connections it opens
 *      (real sockets, the production `bridgeDataChannel`);
 *   2. the Dashboard only forwards a creator for such a connection;
 *   3. the daemon only accepts it over its signed host channel, resolves the
 *      bot-scoped open_id, requires canOperate, and writes it to the schedule
 *      authority (real SQLite store and scheduler).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { bridgeDataChannel } from '../src/platform/tunnel-client.js';
import { isPlatformTunnelPeer, registerPlatformTunnelBridge } from '../src/platform/tunnel-peers.js';
import { createServer as createHttpServer } from 'node:http';
import {
  DASHBOARD_SCHEDULE_CREATOR_HEADER,
  dashboardScheduleCreatorUnionId,
  dashboardScheduleWriteHeaders,
} from '../src/core/dashboard-schedule-creator.js';
import { startIpcServer, setIpcAuthSecret, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import * as larkClient from '../src/im/lark/client.js';
import * as scheduler from '../src/core/scheduler.js';
import * as scheduleStore from '../src/services/schedule-store.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import { registerBot } from '../src/bot-registry.js';
import { setDeploymentOwner } from '../src/services/deployment-identity.js';
import { redactSchedulesForPublic } from '../src/dashboard/public-redact.js';
import { createTaskWithOptionalPrecondition, updateTaskWithOptionalPrecondition } from '../src/core/schedule-precondition-config.js';
import { schedulePreconditionPath } from '../src/services/schedule-precondition-store.js';
import { config } from '../src/config.js';

describe('platform tunnel peers', () => {
  const closers: Array<() => void> = [];
  afterEach(() => { for (const close of closers.splice(0)) close(); });

  async function dashboardStandIn(): Promise<{ port: number; peers: boolean[] }> {
    const peers: boolean[] = [];
    const server: NetServer = createServer(socket => {
      socket.once('data', () => peers.push(isPlatformTunnelPeer(socket)));
      socket.on('error', () => {});
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    closers.push(() => server.close());
    return { port: (server.address() as { port: number }).port, peers };
  }

  it('marks the connections the bridge opens, not a direct local client', async () => {
    const dashboard = await dashboardStandIn();
    const wss = new WebSocketServer({ port: 0, perMessageDeflate: false });
    closers.push(() => wss.close());
    await new Promise<void>(resolve => wss.on('listening', () => resolve()));
    wss.on('connection', socket => bridgeDataChannel(socket, dashboard.port));
    const platform = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
    closers.push(() => platform.terminate());
    await new Promise<void>(resolve => platform.once('open', () => resolve()));
    platform.send(Buffer.from('GET / HTTP/1.1\r\n\r\n'));
    await vi.waitFor(() => expect(dashboard.peers).toEqual([true]));

    const direct: Socket = connect(dashboard.port, '127.0.0.1');
    closers.push(() => direct.destroy());
    await new Promise<void>(resolve => direct.once('connect', () => resolve()));
    direct.write('GET / HTTP/1.1\r\n\r\n');
    await vi.waitFor(() => expect(dashboard.peers).toEqual([true, false]));
  });

  it('forgets a bridge once its connection closes', async () => {
    const seen: Array<{ remoteAddress?: string; remotePort?: number }> = [];
    const server: NetServer = createServer(socket => {
      seen.push({ remoteAddress: socket.remoteAddress, remotePort: socket.remotePort });
      socket.on('error', () => {});
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    closers.push(() => server.close());
    const wss = new WebSocketServer({ port: 0, perMessageDeflate: false });
    closers.push(() => wss.close());
    await new Promise<void>(resolve => wss.on('listening', () => resolve()));
    wss.on('connection', socket => bridgeDataChannel(socket, (server.address() as { port: number }).port));
    const platform = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
    await new Promise<void>(resolve => platform.once('open', () => resolve()));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await vi.waitFor(() => expect(isPlatformTunnelPeer(seen[0])).toBe(true));
    platform.terminate();
    await vi.waitFor(() => expect(isPlatformTunnelPeer(seen[0])).toBe(false));
  });

  it('never trusts a non-loopback peer, even on a bridged port number', () => {
    const forget = registerPlatformTunnelBridge(54321);
    closers.push(forget);
    expect(isPlatformTunnelPeer({ remoteAddress: '127.0.0.1', remotePort: 54321 })).toBe(true);
    expect(isPlatformTunnelPeer({ remoteAddress: '10.0.0.8', remotePort: 54321 })).toBe(false);
    expect(isPlatformTunnelPeer(undefined)).toBe(false);
  });
});

describe('dashboardScheduleWriteHeaders over real connections', () => {
  const closers: Array<() => void> = [];
  afterEach(() => { for (const close of closers.splice(0)) close(); });

  it('forwards the person only for a request the platform tunnel delivered', async () => {
    // Stand-in dashboard: answers with the headers it would forward.
    const server = createHttpServer((req, res) => {
      const body = JSON.stringify(dashboardScheduleWriteHeaders(req, true));
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' });
      res.end(body);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    closers.push(() => server.close());
    const port = (server.address() as { port: number }).port;
    const request = 'POST /api/schedules HTTP/1.1\r\nHost: x\r\nX-Botmux-Actor: on_alice\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
    const forwardedBy = (body: string) => JSON.parse(body.slice(body.indexOf('\r\n\r\n') + 4));

    const wss = new WebSocketServer({ port: 0, perMessageDeflate: false });
    closers.push(() => wss.close());
    await new Promise<void>(resolve => wss.on('listening', () => resolve()));
    wss.on('connection', socket => bridgeDataChannel(socket, port));
    const platform = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
    closers.push(() => platform.terminate());
    await new Promise<void>(resolve => platform.once('open', () => resolve()));
    let viaTunnel = '';
    platform.on('message', data => { viaTunnel += data.toString(); });
    platform.send(Buffer.from(request));
    await vi.waitFor(() => expect(viaTunnel).toContain('}'));
    expect(forwardedBy(viaTunnel)).toEqual({ 'content-type': 'application/json', [DASHBOARD_SCHEDULE_CREATOR_HEADER]: 'on_alice' });

    // The same bytes sent straight to the dashboard (a token holder on this
    // machine) carry nobody.
    const direct: Socket = connect(port, '127.0.0.1');
    closers.push(() => direct.destroy());
    let viaDirect = '';
    direct.on('data', chunk => { viaDirect += chunk.toString(); });
    direct.write(request);
    await vi.waitFor(() => expect(viaDirect).toContain('}'));
    expect(forwardedBy(viaDirect)).toEqual({ 'content-type': 'application/json' });
  });
});

describe('dashboardScheduleCreatorUnionId', () => {
  it('names the platform-signed-in person only for a bound machine and a tunnel connection', () => {
    const base = { platformBound: true, fromPlatformTunnel: true, actorHeader: 'on_alice' };
    expect(dashboardScheduleCreatorUnionId(base)).toBe('on_alice');
    // A token holder talking to the Dashboard directly can set the same header.
    expect(dashboardScheduleCreatorUnionId({ ...base, fromPlatformTunnel: false })).toBeUndefined();
    expect(dashboardScheduleCreatorUnionId({ ...base, platformBound: false })).toBeUndefined();
    expect(dashboardScheduleCreatorUnionId({ ...base, actorHeader: ['on_alice', 'on_bob'] })).toBeUndefined();
    for (const bad of ['ou_alice', 'on_a:b', 'on_' + 'x'.repeat(65), '', undefined]) {
      expect(dashboardScheduleCreatorUnionId({ ...base, actorHeader: bad })).toBeUndefined();
    }
  });
});

describe('daemon records the Dashboard Feishu-login person as creator', () => {
  const APP = 'cli_dash_creator';
  const SECRET = 'dash-creator-host-key';
  const OWNER = 'ou_bot_owner';
  const ALICE = { open: 'ou_alice_here', union: 'on_alice' };
  let dir: string;
  let previousDataDir: string;
  let store: ScheduleAuthorityStore;
  let ipc: IpcServerHandle | undefined;
  let lightweight: IpcServerHandle | undefined;
  let allowed: string[];
  let resolveOpenId: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dash-schedule-creator-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = join(dir, 'data');
    mkdirSync(config.session.dataDir, { recursive: true });
    scheduleStore.setScheduleScope(APP);
    store = ScheduleAuthorityStore.open(config.session.dataDir);
    store.initializeApp(APP, []);
    scheduler.setScheduleAuthorityStore(store);
    scheduler.setOwnerFilter(APP, true);
    setDeploymentOwner(config.session.dataDir, { unionId: 'on_bot_owner', name: 'Owner' });
    allowed = [OWNER, ALICE.open];
    const bot = registerBot({
      larkAppId: APP, larkAppSecret: '', cliId: 'codex', apiOnly: true, allowedUsers: [...allowed],
    });
    Object.defineProperty(bot, 'resolvedAllowedUsers', { get: () => allowed, configurable: true });
    bot.rawAllowedUserResolution.set('on_bot_owner', OWNER);
    setLarkAppId(APP);
    resolveOpenId = vi.spyOn(larkClient, 'resolveTargetAppOpenId')
      .mockImplementation(async (_app, union) => union === ALICE.union
        ? { status: 'resolved', openId: ALICE.open }
        : { status: 'definitive' });
    setIpcAuthSecret(SECRET);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ipc?.close(); ipc = undefined;
    await lightweight?.close(); lightweight = undefined;
    setIpcAuthSecret(null);
    scheduler.stopScheduler();
    scheduler.setScheduleAuthorityStore(null);
    store.close();
    config.session.dataDir = previousDataDir;
    scheduleStore.setScheduleScope('cli_ipc_test_bot001');
    rmSync(dir, { recursive: true, force: true });
  });

  function signed(method: string, path: string, body: unknown, creator?: string, port = ipc!.port) {
    const headers = daemonIpcAuthHeaders({
      secret: SECRET, port, method, path,
      headers: {
        'content-type': 'application/json',
        ...(creator ? { [DASHBOARD_SCHEDULE_CREATOR_HEADER]: creator } : {}),
      },
    });
    return fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: JSON.stringify(body) });
  }

  async function create(creator?: string): Promise<string> {
    const response = await signed('POST', '/api/schedules', {
      name: '日报', schedule: 'every 1h', prompt: '汇总告警', chatId: 'oc_target',
    }, creator);
    expect(response.status).toBe(200);
    return (await response.json()).task.id;
  }

  const record = (id: string) => store.getRecord(APP, id)!;

  it('creates the task as the platform-signed-in person, in the authority record', async () => {
    const id = await create(ALICE.union);
    expect(record(id).task).toMatchObject({ ownerOpenId: ALICE.open, ownerUnionId: ALICE.union });
    expect(record(id)).toMatchObject({ controlOpenId: ALICE.open, controlUnionId: ALICE.union });
    // The open_id comes from the task's own bot, never from the platform.
    expect(resolveOpenId).toHaveBeenCalledWith(APP, ALICE.union);
  });

  it('keeps the token-login attribution when there is no Feishu-login person', async () => {
    const id = await create();
    expect(record(id).task).toMatchObject({ ownerOpenId: OWNER, ownerUnionId: 'on_bot_owner' });
    expect(resolveOpenId).not.toHaveBeenCalled();
  });

  it.each([
    ['cannot operate the bot', () => { allowed = [OWNER]; }],
    ['has no open_id under this bot', () => { resolveOpenId.mockResolvedValue({ status: 'definitive' }); }],
  ])('does not record a person who %s', async (_label, arrange) => {
    arrange();
    const id = await create(ALICE.union);
    expect(record(id).task).toMatchObject({ ownerOpenId: OWNER, ownerUnionId: 'on_bot_owner' });
  });

  it('ignores the header on a request that did not pass the host signature', async () => {
    lightweight = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const response = await fetch(`http://127.0.0.1:${lightweight.port}/api/schedules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [DASHBOARD_SCHEDULE_CREATOR_HEADER]: ALICE.union },
      body: JSON.stringify({ name: '日报', schedule: 'every 1h', prompt: '汇总告警', chatId: 'oc_target' }),
    });
    expect(response.status).toBe(200);
    const id = (await response.json()).task.id;
    expect(record(id).task.ownerOpenId).toBe(OWNER);
    expect(resolveOpenId).not.toHaveBeenCalled();
  });

  it('an edit by the signed-in person makes them the creator and drops an earlier claim', async () => {
    const id = await create();
    const claim = { openId: 'ou_claimant', unionId: 'on_claimant', larkAppId: APP, claimedAt: '2026-10-27T02:00:00.000Z' };
    const events: unknown[] = [];
    const off = dashboardEventBus.subscribe(event => { if (event.type === 'schedule.updated') events.push(event.body); });
    try {
      expect(scheduler.claimTaskRunAs(id, APP, claim, null)).toMatchObject({ ok: true });
      const response = await signed('PATCH', `/api/schedules/${id}`, { prompt: '汇总告警并发周报' }, ALICE.union);
      expect(response.status).toBe(200);
    } finally { off(); }
    expect(record(id).task).toMatchObject({ prompt: '汇总告警并发周报', ownerOpenId: ALICE.open, ownerUnionId: ALICE.union });
    expect(record(id).task.runAsClaim).toBeUndefined();
    expect(record(id)).toMatchObject({ controlOpenId: ALICE.open, controlUnionId: ALICE.union });
    // The dashboard event also reaches anonymous viewers: no identities in it.
    expect(JSON.stringify(events)).not.toMatch(/ou_alice|on_alice|ou_claimant|on_claimant|ou_bot_owner/);
  });

  it('an edit without a Feishu-login person leaves creator and claim alone', async () => {
    const id = await create();
    const claim = { openId: 'ou_claimant', unionId: 'on_claimant', larkAppId: APP, claimedAt: '2026-10-27T02:00:00.000Z' };
    scheduler.claimTaskRunAs(id, APP, claim, null);
    const response = await signed('PATCH', `/api/schedules/${id}`, { prompt: '改了提示词' });
    expect(response.status).toBe(200);
    expect(record(id).task).toMatchObject({ ownerOpenId: OWNER, runAsClaim: claim });
  });

  it('keeps a creator captured under another app, while still applying the edit', async () => {
    const id = await create();
    scheduler.updateRuntimeTaskState(id, { creatorLarkAppId: 'cli_other_app', ownerOpenId: 'ou_other_scope' }, APP);
    const response = await signed('PATCH', `/api/schedules/${id}`, { prompt: '跨应用任务的编辑' }, ALICE.union);
    expect(response.status).toBe(200);
    expect(record(id).task).toMatchObject({ prompt: '跨应用任务的编辑', ownerOpenId: 'ou_other_scope' });
    expect(resolveOpenId).not.toHaveBeenCalled();
  });
});

describe('taskAcceptsRecordedCreator', () => {
  const APP = 'cli_accepts_creator';
  let dir: string;
  let store: ScheduleAuthorityStore;
  let previousDataDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'accepts-creator-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = join(dir, 'data');
    scheduleStore.setScheduleScope(APP);
    store = ScheduleAuthorityStore.open(config.session.dataDir);
    store.initializeApp(APP, []);
    scheduler.setScheduleAuthorityStore(store);
    scheduler.setOwnerFilter(APP, true);
  });
  afterEach(() => {
    scheduler.stopScheduler();
    scheduler.setScheduleAuthorityStore(null);
    store.close();
    config.session.dataDir = previousDataDir;
    scheduleStore.setScheduleScope('cli_ipc_test_bot001');
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves delegated tasks to their delegation', () => {
    scheduler.commitDelegatedTask({
      params: { id: 'd1d2d3d4', name: 'poll', schedule: 'every 30m', prompt: 'check', workingDir: '/repo',
        chatId: 'oc_chat', executionPosition: 'top-level', larkAppId: APP },
      grantId: 'grant-d1', requestHash: 'hash-d1',
      control: { openId: 'ou_delegate', unionId: 'on_delegate', runScopes: [], selfManage: false },
      sourceMessageId: 'om_kickoff', sourceSessionId: 'source-session', targetTurnId: 'om_kickoff',
      targetGeneration: 1, maxTasksPerTurn: 64,
    });
    scheduler.addTask({ id: 'a1b2c3d4', name: 'n', schedule: 'every 1h', prompt: 'p', workingDir: '/repo',
      chatId: 'oc_chat', larkAppId: APP });
    expect(scheduler.taskAcceptsRecordedCreator('d1d2d3d4', APP)).toBe(false);
    expect(scheduler.taskAcceptsRecordedCreator('a1b2c3d4', APP)).toBe(true);
    // And the scheduler refuses it outright if a caller tries anyway.
    expect(scheduler.updateTask('d1d2d3d4', { prompt: 'x', creator: { openId: 'ou_x', unionId: 'on_x' } }))
      .toEqual({ ok: false, error: 'creator_not_recordable' });
    expect(store.getRecord(APP, 'd1d2d3d4')).toMatchObject({ controlOpenId: 'ou_delegate' });
  });

  it('keeps control columns as the creator for direct tasks, and as the delegation for delegated ones', () => {
    scheduler.commitDelegatedTask({
      params: { id: 'd1d2d3d4', name: 'poll', schedule: 'every 30m', prompt: 'check', workingDir: '/repo',
        chatId: 'oc_chat', executionPosition: 'top-level', larkAppId: APP },
      grantId: 'grant-d1', requestHash: 'hash-d1',
      control: { openId: 'ou_delegate', unionId: 'on_delegate', runScopes: [], selfManage: false },
      sourceMessageId: 'om_kickoff', sourceSessionId: 'source-session', targetTurnId: 'om_kickoff',
      targetGeneration: 1, maxTasksPerTurn: 64,
    });
    scheduler.addTask({ id: 'a1b2c3d4', name: 'n', schedule: 'every 1h', prompt: 'p', workingDir: '/repo',
      chatId: 'oc_chat', larkAppId: APP, ownerOpenId: 'ou_first', ownerUnionId: 'on_first' });
    const reown = (task: any) => ({ ...task, ownerOpenId: 'ou_next', ownerUnionId: 'on_next' });
    store.updateTask(APP, 'a1b2c3d4', reown);
    store.updateTask(APP, 'd1d2d3d4', reown);
    expect(store.getRecord(APP, 'a1b2c3d4')).toMatchObject({ controlOpenId: 'ou_next', controlUnionId: 'on_next' });
    expect(store.getRecord(APP, 'd1d2d3d4')).toMatchObject({ controlOpenId: 'ou_delegate', controlUnionId: 'on_delegate' });
  });
});

describe('a failed edit does not keep the new creator', () => {
  const APP = 'cli_creator_rollback';
  let dir: string;
  let store: ScheduleAuthorityStore;
  let previousDataDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'creator-rollback-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = join(dir, 'data');
    scheduleStore.setScheduleScope(APP);
    store = ScheduleAuthorityStore.open(config.session.dataDir);
    store.initializeApp(APP, []);
    scheduler.setScheduleAuthorityStore(store);
    scheduler.setOwnerFilter(APP, true);
  });
  afterEach(() => {
    scheduleStore.__setScheduleStoreBeforeRenameTestHook(undefined);
    scheduler.stopScheduler();
    scheduler.setScheduleAuthorityStore(null);
    store.close();
    config.session.dataDir = previousDataDir;
    scheduleStore.setScheduleScope('cli_ipc_test_bot001');
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores who the task runs as, its claim and control columns when the precondition step fails', () => {
    const created = createTaskWithOptionalPrecondition({
      name: 'guarded', schedule: 'every 1h', prompt: 'p', workingDir: dir, chatId: 'oc_chat', larkAppId: APP,
      ownerOpenId: 'ou_first', ownerUnionId: 'on_first',
    }, APP, 'printf 1');
    const claim = { openId: 'ou_claimant', unionId: 'on_claimant', larkAppId: APP, claimedAt: '2026-10-27T02:00:00.000Z' };
    expect(scheduler.claimTaskRunAs(created.id, APP, claim, null)).toMatchObject({ ok: true });
    // Fail the protected-sidecar step after the task row has been written.
    scheduleStore.__setScheduleStoreBeforeRenameTestHook(() => {
      scheduleStore.__setScheduleStoreBeforeRenameTestHook(undefined);
      rmSync(schedulePreconditionPath(APP, created.id), { force: true });
    });
    expect(() => updateTaskWithOptionalPrecondition(
      created.id,
      { prompt: 'edited', creator: { openId: 'ou_editor', unionId: 'on_editor' } },
      APP,
      { action: 'replace', source: { kind: 'inline', script: 'printf 0' } },
    )).toThrow('staged protected record is missing');
    const record = store.getRecord(APP, created.id)!;
    expect(record.task).toMatchObject({ prompt: 'p', ownerOpenId: 'ou_first', ownerUnionId: 'on_first', runAsClaim: claim });
    expect(record).toMatchObject({ controlOpenId: 'ou_first', controlUnionId: 'on_first' });
  });

  it('restores from the authority record even when the JSON projection lags behind it', () => {
    const created = createTaskWithOptionalPrecondition({
      name: 'guarded', schedule: 'every 1h', prompt: 'p', workingDir: dir, chatId: 'oc_chat', larkAppId: APP,
    }, APP, 'printf 1');
    const claim = { openId: 'ou_claimant', unionId: 'on_claimant', larkAppId: APP, claimedAt: '2026-10-27T02:00:00.000Z' };
    scheduler.claimTaskRunAs(created.id, APP, claim, null);
    // A projection refresh that failed: the claim exists only in the authority.
    scheduleStore.projectAuthoritativeTask({ ...store.getRecord(APP, created.id)!.task, runAsClaim: undefined }, APP);
    scheduleStore.__setScheduleStoreBeforeRenameTestHook(() => {
      scheduleStore.__setScheduleStoreBeforeRenameTestHook(undefined);
      rmSync(schedulePreconditionPath(APP, created.id), { force: true });
    });
    expect(() => updateTaskWithOptionalPrecondition(
      created.id,
      { prompt: 'edited', creator: { openId: 'ou_editor', unionId: 'on_editor' } },
      APP,
      { action: 'replace', source: { kind: 'inline', script: 'printf 0' } },
    )).toThrow('staged protected record is missing');
    expect(store.getRecord(APP, created.id)!.task.runAsClaim).toEqual(claim);
  });
});

describe('public schedule redaction', () => {
  it('strips run-as identity fields from rows and event patches', () => {
    const [row] = redactSchedulesForPublic([{
      id: 't1', name: 'n', prompt: 'p', ownerOpenId: 'ou_x', ownerUnionId: 'on_x',
      runAsClaim: { openId: 'ou_y', unionId: 'on_y', larkAppId: 'cli', claimedAt: 'now' },
    }]) as Array<Record<string, unknown>>;
    expect(row).toEqual({ id: 't1', name: 'n' });
  });
});
