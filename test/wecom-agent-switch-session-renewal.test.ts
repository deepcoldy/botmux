/**
 * Switching a WeCom bot's agent while it runs, end to end: the gateway hands the
 * new core profile to its dedicated core, the core closes the sessions frozen on
 * the previous CLI (core/dashboard-ipc-server.ts closeSessionsOfReplacedAgent),
 * and the gateway moves a conversation whose session is gone to a new session
 * (gateway/bridge/tick.ts renewSession) instead of refusing the user's message.
 *
 * Real `WecomBridge`, `WecomHttpCore` and `WecomCoreProfileSync` against the real
 * core IPC server (profile route with the agent sweep, trigger to a session the
 * core no longer has, trigger-result, progress, slash) in this process, on the
 * real session store and registry. Only the creation of a NEW session is
 * emulated — a real core would fork a worker and a real CLI — the way the core
 * records it (store row and registry entry on the bot's current CLI, a pending
 * async result) and honouring the fresh-session idempotency key the way the
 * core's trigger contract does. The clock (Date) is fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __testOnly_resetBotRegistry, getBot, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS, nativeGatewayCoreProfilePath } from '../src/core/native-gateway-contract.js';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { findActiveBySessionId, setActiveSessionsRegistry } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import * as asyncTriggerStore from '../src/services/async-trigger-store.js';
import type { DaemonSession } from '../src/core/types.js';
import { WecomBridge, type WecomCore, type WecomBridgePolicy } from '../src/im/wecom/gateway/bridge.js';
import { WecomHttpCore } from '../src/im/wecom/gateway/core-client.js';
import { createWecomCoreProfileSync, WECOM_CORE_PROFILE_PUSH_TIMEOUT_MS } from '../src/im/wecom/gateway/core-profile-sync.js';
import { parseWecomConfig } from '../src/im/wecom/config/config.js';
import { wecomManagedCoreProfileEnvironment } from '../src/im/wecom/config/managed-core-env.js';
import { nativeGrantKey } from '../src/im/wecom/gateway/native-core.js';
import type { WecomInboundMessage } from '../src/im/wecom/protocol/types.js';
import type { TriggerRequest, TriggerResponse } from '../src/services/trigger-types.js';

const BOT = 'local_agent_switch';
const SECRET = 'agent-switch-fixture-secret';
const MODE_KEYS = ['BOTMUX_CORE_ONLY', 'BOTMUX_NATIVE_GATEWAY_CORE', 'BOTMUX_API_ONLY_BOT', 'BOTS_CONFIG'];
const TOUCHED = [...MODE_KEYS, ...NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS];
const saved = new Map<string, string | undefined>();
const cleanup: Array<() => unknown> = [];
let server: IpcServerHandle | undefined;

beforeEach(() => {
  for (const key of TOUCHED) saved.set(key, process.env[key]);
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-26T09:00:00Z') });
});
afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  server = undefined;
  for (const step of cleanup.splice(0).reverse()) await step();
  setActiveSessionsRegistry(undefined);
  setIpcAuthSecret(null);
  setLarkAppId('');
  __testOnly_resetBotRegistry();
  for (const key of TOUCHED) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A worker process as the core's close sees one: it exits when asked to close. */
class FakeWorker extends EventEmitter {
  readonly pid = 2_147_000_003;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;
  send(message: { type?: string }): boolean {
    if (message?.type === 'close') queueMicrotask(() => {
      this.exitCode = 0;
      this.connected = false;
      this.emit('exit', 0, null);
    });
    return true;
  }
  kill(): boolean {
    return true;
  }
}

function dm(id: string, userId: string, text = `question ${id}`): WecomInboundMessage {
  return { messageId: id, userId, conversationId: userId, chatType: 'single', text, attachments: [], replyContext: { requestId: `req-${id}` } };
}
function inGroup(id: string, userId: string, text = `question ${id}`): WecomInboundMessage {
  return { messageId: id, userId, conversationId: 'room', chatType: 'group', text, attachments: [], replyContext: { requestId: `req-${id}` } };
}

type Created = { sessionId: string; triggerId: string; cli: string; request: TriggerRequest };

async function world(options: { policy?: Partial<WecomBridgePolicy> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wecom-agent-switch-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const raw = (port: number, cli: string, model?: string) => ({
    botId: 'wecom-switch', secretEnv: 'FAKE_WECOM_SECRET', coreUrl: `http://127.0.0.1:${port}`, allowedUsers: ['alice', 'bob'], stateDir: root,
    managedCore: { botId: BOT, cli, backend: 'pty', port, workingDirectory: root, stateDir: join(root, 'core-state'), ...(model ? { model } : {}) },
  });
  // The dedicated core, started on the codex configuration.
  __testOnly_resetBotRegistry();
  for (const key of TOUCHED) delete process.env[key];
  Object.assign(process.env, { BOTMUX_CORE_ONLY: '1', BOTMUX_NATIVE_GATEWAY_CORE: '1', BOTMUX_API_ONLY_BOT: BOT },
    wecomManagedCoreProfileEnvironment(parseWecomConfig(raw(1, 'codex'))));
  registerBot(loadBotConfigs()[0]!);
  sessionStore.init(BOT);
  const registry = new Map<string, DaemonSession>();
  setActiveSessionsRegistry(registry);
  setIpcAuthSecret(SECRET);
  setLarkAppId(BOT);
  server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
  const port = server.port;
  const configFile = join(root, 'config.json');
  writeFileSync(configFile, JSON.stringify(raw(port, 'codex')));
  const coreUrl = `http://127.0.0.1:${port}`;
  // As the gateway signs its core requests (command.ts coreRequest).
  const signed = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    return fetchDaemonIpc(port, url.pathname + url.search, init ?? {}, SECRET);
  }) as typeof fetch;
  const profileSync = createWecomCoreProfileSync({
    configFile,
    started: parseWecomConfig(JSON.parse(readFileSync(configFile, 'utf8'))),
    push: async profile => {
      const response = await signed(`${coreUrl}${nativeGatewayCoreProfilePath()}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ env: profile }), signal: AbortSignal.timeout(WECOM_CORE_PROFILE_PUSH_TIMEOUT_MS),
      });
      const body = response.ok ? await response.json() as { ok?: boolean } : undefined;
      if (body?.ok !== true) throw new Error(`core_profile_rejected_${response.status}`);
    },
  })!;
  const http = new WecomHttpCore(coreUrl, signed, { beforeTrigger: () => profileSync.sync() });
  const created: Created[] = [];
  const byKey = new Map<string, Created>();
  const triggers: TriggerRequest[] = [];
  const hooks: { beforeCreate?: (request: TriggerRequest) => void; afterCreate?: (created: Created) => void } = {};
  let n = 0;
  const core: Required<Pick<WecomCore, 'trigger' | 'result' | 'progress' | 'interrupt' | 'slash'>> = {
    async trigger(request) {
      triggers.push(structuredClone(request));
      await profileSync.sync();
      const target = request.target.sessionId;
      // A session the core no longer has: the real core answers.
      if (target && !findActiveBySessionId(target)) return http.trigger(request);
      if (target) throw new Error('fixture: continuing a live session is not emulated');
      hooks.beforeCreate?.(request);
      const key = request.options?.idempotencyKey;
      const prior = key ? byKey.get(key) : undefined;
      if (prior) {
        return { ok: true, triggerId: prior.triggerId, action: 'queued', target: { kind: 'turn', sessionId: prior.sessionId }, idempotent: true };
      }
      const chatId = `http_async_switch_${++n}`;
      const session = sessionStore.createSession(chatId, chatId, `switch ${n}`, 'p2p', 'chat');
      session.larkAppId = BOT;
      session.cliId = getBot(BOT).config.cliId;
      sessionStore.updateSession(session);
      const triggerId = `trigger-${n}`;
      registry.set(chatId, {
        session, larkAppId: BOT, chatId, chatType: 'p2p', worker: new FakeWorker(), workerPort: null, workerToken: null,
        spawnedAt: Date.now(), lastMessageAt: Date.now(), hasHistory: true,
        asyncTriggerResults: new Map([[triggerId, { status: 'pending', createdAt: Date.now() }]]), latestAsyncTriggerId: triggerId,
      } as unknown as DaemonSession);
      asyncTriggerStore.recordPending(session.sessionId, triggerId, Date.now(), BOT);
      const record = { sessionId: session.sessionId, triggerId, cli: String(session.cliId), request: structuredClone(request) };
      created.push(record);
      if (key) byKey.set(key, record);
      hooks.afterCreate?.(record);
      return { ok: true, triggerId, action: 'queued', target: { kind: 'turn', sessionId: session.sessionId, chatId } };
    },
    result: (sessionId, triggerId) => http.result(sessionId, triggerId),
    progress: (sessionId, triggerId) => http.progress(sessionId, triggerId),
    interrupt: (sessionId, triggerId) => http.interrupt(sessionId, triggerId),
    slash: (sessionId, command) => http.slash(sessionId, command),
  };
  /** The created session's turn completes with `content`. */
  const finish = (record: Created, content: string) => {
    const ds = findActiveBySessionId(record.sessionId)!;
    ds.asyncTriggerResults!.set(record.triggerId, { status: 'completed', content, completedAt: Date.now() } as never);
    asyncTriggerStore.recordCompleted(record.sessionId, record.triggerId, content, Date.now(), BOT);
  };
  const transport = {
    reply: vi.fn(async (_message: WecomInboundMessage, _text: string, _options?: { streamId?: string; finish?: boolean }) => {}),
    send: vi.fn(async (_to: string, _text: string) => {}),
  };
  const stateFile = join(root, 'state.json');
  const policy = (): WecomBridgePolicy => {
    const core = profileSync.effective();
    return { allowedUsers: ['alice', 'bob'], cli: core.cli, model: core.model, workingDirectory: core.workingDirectory, ...options.policy };
  };
  const bridge = () => new WecomBridge({ botId: 'wecom-switch', stateFile, allowedUsers: ['alice', 'bob'], transport, core, policy });
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const task = (messageId: string) => Object.values(state().tasks as Record<string, any>).find(t => t.message.messageId === messageId);
  const route = (message: WecomInboundMessage) => JSON.stringify([message.chatType, message.conversationId, message.userId]);
  /** Save a configuration that runs claude-code (and `model`); the gateway pushes it on its next sync. */
  const saveAgent = (cli: string, model?: string) => writeFileSync(configFile, JSON.stringify(raw(port, cli, model)));
  const finals = (messageId: string) => transport.reply.mock.calls.filter(call => call[0].messageId === messageId && call[2]?.finish === true);
  return { root, bridge, profileSync, created, triggers, hooks, finish, transport, state, task, route, saveAgent, finals, policy };
}

describe('a conversation whose session the agent switch closed', () => {
  for (const restart of [false, true]) {
    const label = restart ? ' (gateway restarted from state.json)' : '';

    it(`(i) idle: the next message runs on a new session of the new agent${label}`, async () => {
      const w = await world();
      let b = w.bridge();
      const first = dm('m1', 'alice');
      await b.receive(first);
      await b.tick();
      const old = w.created[0]!;
      w.finish(old, 'answer-1');
      await b.tick();
      expect(w.state().routes[w.route(first)]).toBe(old.sessionId);

      // Saved in the Dashboard; the gateway hands it over before the next turn.
      w.saveAgent('claude-code', 'opus');
      if (restart) {
        await w.profileSync.sync();
        b = w.bridge();
      }
      await b.receive(dm('m2', 'alice'));
      await b.tick();
      expect(findActiveBySessionId(old.sessionId)).toBeUndefined();
      expect(w.created).toHaveLength(2);
      const renewed = w.created[1]!;
      expect(renewed.cli).toBe('claude-code');
      expect(renewed.request.target.sessionId).toBeUndefined();
      w.finish(renewed, 'answer-2');
      await b.tick();

      const second = w.task('m2');
      expect(second).toMatchObject({ sessionId: renewed.sessionId, triggerId: renewed.triggerId, result: 'answer-2', delivered: true, model: 'opus', workingDirectory: w.root });
      expect(w.state().routes[w.route(first)]).toBe(renewed.sessionId);
      // One final reply, carrying the new session's answer.
      expect(w.finals('m2').map(call => call[1])).toEqual(['answer-2']);
      // The stream card admission opened was told once that the conversation moved.
      expect(w.transport.reply.mock.calls.filter(call => call[0].messageId === 'm2' && call[2]?.finish === false)).toHaveLength(2);
    });

    it(`(ii) running: the turn ends once, and the next message runs on a new session${label}`, async () => {
      const w = await world();
      let b = w.bridge();
      await b.receive(dm('m3', 'bob'));
      await b.tick();
      await b.tick();
      const running = w.created[0]!;
      expect(w.task('m3').result).toBeUndefined();

      w.saveAgent('claude-code');
      await w.profileSync.sync();
      expect(findActiveBySessionId(running.sessionId)).toBeUndefined();
      if (restart) b = w.bridge();
      await b.tick();
      await b.tick();
      await b.tick();
      expect(w.task('m3')).toMatchObject({ delivered: true });
      expect(w.task('m3').result).toEqual(expect.any(String));
      expect(w.finals('m3')).toHaveLength(1);

      await b.receive(dm('m4', 'bob'));
      await b.tick();
      const renewed = w.created[1]!;
      expect(renewed.cli).toBe('claude-code');
      w.finish(renewed, 'answer-4');
      await b.tick();
      expect(w.task('m4')).toMatchObject({ sessionId: renewed.sessionId, result: 'answer-4', delivered: true });
      expect(w.state().routes[w.route(dm('m4', 'bob'))]).toBe(renewed.sessionId);
      expect(w.created).toHaveLength(2);
    });
  }

  it('(iv) a crash between the saved rewrite and its dispatch: the next start sends it, and the core makes one session', async () => {
    const w = await world();
    let b = w.bridge();
    const first = dm('m1', 'alice');
    await b.receive(first);
    await b.tick();
    w.finish(w.created[0]!, 'answer-1');
    await b.tick();
    w.saveAgent('claude-code');
    await b.receive(dm('m2', 'alice'));
    const key = Object.keys(w.state().tasks).find(k => w.state().tasks[k].message.messageId === 'm2')!;

    // The rewritten request is on disk before it is sent; the process dies there.
    let onDisk: any;
    w.hooks.beforeCreate = () => {
      onDisk = { request: w.task('m2').request, route: w.state().routes[w.route(first)] };
      w.hooks.beforeCreate = undefined;
      throw new Error('gateway process died');
    };
    await b.tick();
    expect(w.created).toHaveLength(1);
    expect(onDisk.route).toBeUndefined();
    expect(onDisk.request.target.sessionId).toBeUndefined();
    expect(onDisk.request.options).toMatchObject({ idempotencyKey: key });
    expect(onDisk.request.options.turnIdempotencyKey).toBeUndefined();

    // The core took it, but the answer was lost: the next start sends the same request again.
    b = w.bridge();
    w.hooks.afterCreate = () => {
      w.hooks.afterCreate = undefined;
      throw new Error('answer lost');
    };
    await b.tick();
    b = w.bridge();
    await b.tick();
    const fresh = w.triggers.filter(request => !request.target.sessionId && request.source.requestId === 'm2');
    expect(fresh.length).toBeGreaterThanOrEqual(2);
    expect(new Set(fresh.map(request => request.options?.idempotencyKey))).toEqual(new Set([key]));
    expect(w.created).toHaveLength(2);
    expect(w.task('m2').sessionId).toBe(w.created[1]!.sessionId);
  });

  it('(v) a granted user: the move takes no second quota and keeps the receipt', async () => {
    const w = await world();
    const b = w.bridge();
    await b.receive(inGroup('g0', 'alice', '/grant guest talk'));
    await b.receive(inGroup('g1', 'guest'));
    await b.tick();
    w.finish(w.created[0]!, 'answer-1');
    await b.tick();
    const grant = () => w.state().native.grants[nativeGrantKey('guest', 'group:room')];
    expect(grant().used).toBe(1);

    w.saveAgent('claude-code');
    await b.receive(inGroup('g2', 'guest'));
    const key = Object.keys(w.state().tasks).find(k => w.state().tasks[k].message.messageId === 'g2')!;
    expect(grant().used).toBe(2);
    await b.tick();
    w.finish(w.created[1]!, 'answer-2');
    await b.tick();
    expect(w.task('g2')).toMatchObject({ result: 'answer-2', delivered: true, sessionId: w.created[1]!.sessionId });
    expect(grant().used).toBe(2);
    expect(w.state().native.receipts[key]).toEqual({ grant: nativeGrantKey('guest', 'group:room'), revision: grant().revision });
  });

  it('a default role injected once per session is sent again with the request moved to the new session', async () => {
    const role = 'fixture role: answer as the switch desk';
    const w = await world({ policy: { role: { content: role, injectMode: 'once' } } });
    const b = w.bridge();
    const first = dm('m1', 'alice');
    await b.receive(first);
    await b.tick();
    const old = w.created[0]!;
    expect(old.request.instruction).toContain(role);
    w.finish(old, 'answer-1');
    await b.tick();

    w.saveAgent('claude-code');
    await b.receive(dm('m2', 'alice'));
    await b.tick();
    // The follow-up first went to the session that had already had its role, so without it...
    const toOld = w.triggers.find(request => request.source.requestId === 'm2' && request.target.sessionId === old.sessionId);
    expect(toOld?.instruction).not.toContain(role);
    // ...and the request moved to the new session carries the role again: it is that session's first turn.
    const renewed = w.created[1]!;
    expect(renewed.request.target.sessionId).toBeUndefined();
    expect(renewed.request.instruction).toContain(role);
    expect(w.task('m2').request.instruction).toContain(role);
  });

  it('(vi) a selected repository that is no longer usable: the selection is dropped and no session is created', async () => {
    const w = await world();
    const repo = join(w.root, 'project');
    mkdirSync(repo);
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, env, stdio: 'ignore' });
    const b = w.bridge();
    const first = dm('m1', 'alice');
    await b.receive(dm('r0', 'alice', '/repo'));
    await b.receive(dm('r1', 'alice', '/repo 1'));
    expect(w.state().native.selectedRepos[w.route(first)]).toMatchObject({ directory: repo });
    await b.receive(first);
    await b.tick();
    expect(w.created[0]!.request.options?.connectorWorkingDirectory).toBe(repo);
    w.finish(w.created[0]!, 'answer-1');
    await b.tick();

    w.saveAgent('claude-code');
    rmSync(repo, { recursive: true, force: true });
    await b.receive(dm('m2', 'alice'));
    await b.tick();
    await b.tick();
    expect(w.created).toHaveLength(1);
    expect(w.triggers.filter(request => request.source.requestId === 'm2' && !request.target.sessionId)).toEqual([]);
    expect(w.task('m2')).toMatchObject({ delivered: true });
    expect(w.task('m2').result).toEqual(expect.any(String));
    expect(w.task('m2').sessionId).toBeUndefined();
    expect(w.state().native.selectedRepos[w.route(first)]).toBeUndefined();
    expect(w.state().routes[w.route(first)]).toBeUndefined();
  });

  it('(vii) a passthrough command for a session the core closed: the stale route is dropped; any other refusal keeps it', async () => {
    const w = await world({ policy: { customPassthroughCommands: ['/model'] } });
    const b = w.bridge();
    const first = dm('m1', 'alice');
    await b.receive(first);
    await b.tick();
    w.finish(w.created[0]!, 'answer-1');
    await b.tick();
    const old = w.created[0]!.sessionId;

    // Refused for another reason (the core does not let it into the CLI): the route stays.
    const before = w.transport.reply.mock.calls.length;
    await b.receive(dm('c1', 'alice', '/model fast'));
    expect(w.transport.reply.mock.calls.length).toBe(before + 1);
    expect(w.state().routes[w.route(first)]).toBe(old);

    w.saveAgent('claude-code');
    await w.profileSync.sync();
    await b.receive(dm('c2', 'alice', '/model fast'));
    expect(w.transport.reply.mock.calls.length).toBe(before + 2);
    expect(w.state().routes[w.route(first)]).toBeUndefined();
    // The next message starts a new session right away.
    await b.receive(dm('m2', 'alice'));
    await b.tick();
    expect(w.triggers.filter(request => request.source.requestId === 'm2').map(request => request.target.sessionId)).toEqual([undefined]);
    expect(w.created).toHaveLength(2);
  });
});

describe('what a turn refusal moves to a new session', () => {
  /** A core that refuses every turn of an existing session with `refusal`, and creates new sessions. */
  async function refusingCore(refusal: { status: number; body: string }) {
    const turns: TriggerRequest[] = [];
    const http: Server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method === 'POST' && url.pathname === '/api/trigger') {
          const request = JSON.parse(body) as TriggerRequest;
          turns.push(request);
          if (request.target.sessionId) {
            res.writeHead(refusal.status, { 'content-type': 'application/json' });
            return res.end(refusal.body);
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, triggerId: `t${turns.length}`, target: { kind: 'turn', sessionId: `s${turns.length}` } }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: 'completed', output: { content: 'answer' } }));
      });
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    cleanup.push(() => new Promise(done => http.close(done)));
    const root = mkdtempSync(join(tmpdir(), 'wecom-turn-refusal-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const core = new WecomHttpCore(`http://127.0.0.1:${(http.address() as { port: number }).port}`);
    const bridge = new WecomBridge({
      botId: 'refusal', stateFile: join(root, 'state.json'), allowedUsers: ['alice'], core,
      transport: { reply: async () => {}, send: async () => {} },
    });
    const state = () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    return { bridge, turns, state };
  }

  it.each([
    ['another errorCode on 404', 404, JSON.stringify({ ok: false, errorCode: 'bot_not_found' })],
    ['a 404 without a readable body', 404, 'not json'],
    ['a 409 conflict', 409, JSON.stringify({ ok: false, errorCode: 'idempotency_conflict' })],
    ['a 400 request error', 400, JSON.stringify({ ok: false, errorCode: 'bad_request' })],
    ['a 403 refusal', 403, JSON.stringify({ ok: false, errorCode: 'session_not_found' })],
  ])('%s ends the task as before, on the same route, without a new session', async (_label, status, body) => {
    const f = await refusingCore({ status, body });
    await f.bridge.receive(dm('m1', 'alice'));
    await f.bridge.tick();
    await f.bridge.tick();
    await f.bridge.receive(dm('m2', 'alice'));
    await f.bridge.tick();
    expect(f.turns.map(turn => turn.target.sessionId ?? null)).toEqual([null, 's1']);
    const task = Object.values(f.state().tasks as Record<string, any>).find(t => t.message.messageId === 'm2');
    expect(task.result).toEqual(expect.any(String));
    expect(task.sessionId).toBeUndefined();
    expect(Object.values(f.state().routes)).toEqual(['s1']);
  });

  it('404 session_not_found moves it to a new session', async () => {
    const f = await refusingCore({ status: 404, body: JSON.stringify({ ok: false, errorCode: 'session_not_found' }) });
    await f.bridge.receive(dm('m1', 'alice'));
    await f.bridge.tick();
    await f.bridge.tick();
    await f.bridge.receive(dm('m2', 'alice'));
    await f.bridge.tick();
    expect(f.turns.map(turn => turn.target.sessionId ?? null)).toEqual([null, 's1', null]);
    expect(Object.values(f.state().routes)).toEqual(['s3']);
  });
});
