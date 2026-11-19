/** Real HTTP IPC router, authorization, journal and sessionReply; only the
 * provider and source daemon transport are replaced. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/report-ipc-import-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  return {
    dataDir, reply: vi.fn(async (..._args: unknown[]) => 'om_reply'),
    send: vi.fn(async (..._args: unknown[]) => 'om_top'),
    online: vi.fn(), fetch: vi.fn(),
  };
});
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {} }));
vi.mock('../src/im/lark/client.js', async () => ({
  ...await vi.importActual<any>('../src/im/lark/client.js'),
  replyMessage: mocks.reply, sendMessage: mocks.send,
}));
vi.mock('../src/utils/daemon-discovery.js', async () => ({
  ...await vi.importActual<any>('../src/utils/daemon-discovery.js'), findOnlineDaemon: mocks.online,
}));
vi.mock('../src/core/daemon-ipc-auth.js', async () => ({
  ...await vi.importActual<any>('../src/core/daemon-ipc-auth.js'), fetchDaemonIpc: mocks.fetch,
}));
import { __testOnly_activeSessions as sessions, __testOnly_setDaemonLarkAppId as setApp } from '../src/daemon.js';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { setActiveSessionsRegistry } from '../src/core/worker-pool.js';
import { registerBot, getBot } from '../src/bot-registry.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { config } from '../src/config.js';
import { createDispatchReportBinding, dispatchReportBindingSecretPath } from '../src/core/dispatch-report-binding.js';
import { loadOrCreateDashboardSecret } from '../src/dashboard/auth.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as sessionStore from '../src/services/session-store.js';
import { REPORT_SOURCE_REPLY_ROUTE, buildReportReplyContext } from '../src/core/report-source-reply.js';
import { authorizeReportSessionRelayRequest, deliverReportSessionRelay } from '../src/core/report-session-relay.js';
import {
  UNDELIVERED_REPORT_RELAY_REASON_TEXT,
  type UndeliveredReportRelayReason,
} from '../src/core/report-session-relay.js';

const APP = 'cli_report_ipc';
const CHAT = 'oc_report';
const CAP = 'c'.repeat(64);
let root: string;
let sandbox: string;
let server: IpcServerHandle;
let ds: DaemonSession;
const originalDataDir = config.session.dataDir;
beforeEach(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'report-ipc-'));
  // The report binding secret lives beside dataDir, in a user-owned directory.
  root = join(sandbox, 'data');
  mkdirSync(root);
  config.session.dataDir = root;
  mocks.reply.mockReset().mockResolvedValue('om_reply');
  mocks.send.mockReset().mockResolvedValue('om_top');
  mocks.online.mockReset().mockReturnValue({ ipcPort: 19999 });
  mocks.fetch.mockReset().mockImplementation(async (_port: number, path: string) => new Response(JSON.stringify(
    path === '/api/trigger' ? { ok: true, triggerId: 'trigger-report' } : { ok: true },
  ), { status: 200 }));
  registerBot({ larkAppId: APP, larkAppSecret: 'test', cliId: 'claude-code', allowedUsers: [] });
  setApp(APP); sessions.clear(); setActiveSessionsRegistry(sessions);
  ds = {
    larkAppId: APP, chatId: CHAT, scope: 'thread',
    session: { sessionId: 'source', larkAppId: APP, chatId: CHAT, rootMessageId: 'om_dispatch',
      scope: 'thread', status: 'active', createdAt: new Date().toISOString(), title: 'test' },
    managedTurnOrigin: { capability: CAP, turnId: 'turn-report', dispatchAttempt: 1 },
  } as DaemonSession;
  sessions.set(activeSessionKey(ds), ds);
  const secret = loadOrCreateDashboardSecret(dispatchReportBindingSecretPath(root));
  writeFileSync(join(root, 'orchestrate-dispatch.json'), JSON.stringify({
    om_dispatch: { orchAppId: 'cli_lead', orchSessionId: 'lead', reportBinding: createDispatchReportBinding(secret, {
      dispatchRoot: 'om_dispatch', targetLarkAppId: 'cli_lead', targetSessionId: 'lead', sourceName: 'task',
      issuedAt: new Date().toISOString(),
    }) },
  }));
  setIpcAuthSecret('test-ipc-secret');
  server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});
afterEach(async () => {
  await server?.close(); setApp(undefined); setIpcAuthSecret(null);
  sessions.clear(); setActiveSessionsRegistry(undefined); config.session.dataDir = originalDataDir;
  rmSync(sandbox, { recursive: true, force: true });
});
async function report(overrides: Record<string, unknown> = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/report-relay`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'source', dispatchRoot: 'om_dispatch', content: '## Result\nDone',
      originCapability: CAP, delivery: 'publish', ...overrides }),
  });
  return { status: response.status, body: await response.json() as any };
}
function journals() {
  const dir = join(root, 'report-deliveries');
  return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.json')) : [];
}

describe('source reply IPC', () => {
  beforeEach(() => {
    sessionStore.init(APP);
    ds.session.quoteTargetId = 'om_request';
    ds.session.reportReplyInputId = 'om_request';
    sessionStore.updateSession(ds.session);
  });
  afterEach(() => { sessionStore.init(APP); });
  function request() {
    const secret = loadOrCreateDashboardSecret(dispatchReportBindingSecretPath(root));
    return { dispatchRoot: 'om_child', sourceLarkAppId: 'cli_project', content: '## Result\n\n原文结果',
      binding: createDispatchReportBinding(secret, {
        dispatchRoot: 'om_child', targetLarkAppId: APP, targetSessionId: 'source',
        targetChatId: CHAT, targetScope: 'thread', sourceName: 'Review', issuedAt: new Date().toISOString(),
        reply: { rootMessageId: 'om_dispatch', sourceTurnId: 'om_request', reporterLarkAppId: 'cli_project' },
      }) };
  }
  async function reply(body = request(), trusted = true) {
    const headers = trusted ? daemonIpcAuthHeaders({ secret: 'test-ipc-secret', port: server.port,
      method: 'POST', path: REPORT_SOURCE_REPLY_ROUTE, headers: { 'content-type': 'application/json' } })
      : { 'content-type': 'application/json' };
    const response = await fetch(`http://127.0.0.1:${server.port}${REPORT_SOURCE_REPLY_ROUTE}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  }
  it('requires host authentication before any source-topic write', async () => {
    expect((await reply(request(), false)).status).toBe(401);
    expect(mocks.reply).not.toHaveBeenCalled();
  });
  it('returns to the existing relay path when the saved source session has no live executor', async () => {
    sessions.clear();
    expect(await reply()).toMatchObject({ status: 409, body: { error: 'report_reply_source_changed' } });
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(journals()).toEqual([]);
  });
  it('posts once at the original root, stores context durably, and never triggers a model', async () => {
    const body = request();
    expect(await reply(body)).toMatchObject({ status: 200, body: { delivery: 'reply', publishedMessageId: 'om_reply' } });
    expect((await reply(body)).status).toBe(200);
    expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(mocks.reply.mock.calls[0].slice(0, 2)).toEqual([APP, 'om_dispatch']);
    expect(mocks.fetch).not.toHaveBeenCalled();
    sessionStore.init(APP);
    const persisted = sessionStore.getSession('source');
    expect(persisted?.reportReplyReferences).toEqual([{ messageId: 'om_reply', dispatchRoot: 'om_child' }]);
    expect(buildReportReplyContext(persisted?.reportReplyReferences)).toContain('om_reply');
  });
  it('routes an authenticated completed report through the direct sink', async () => {
    const body = request();
    const decision = authorizeReportSessionRelayRequest({
      trustedHost: true, selfLarkAppId: 'cli_project',
      session: { sessionId: 'project', larkAppId: 'cli_project', chatId: 'oc_project', receiver: false,
        scope: 'thread', rootMessageId: 'om_child', liveOrigin: { capability: CAP, turnId: 'om_work' } },
      raw: { sessionId: 'project', dispatchRoot: 'om_child', content: body.content,
        originCapability: CAP, status: 'completed' },
      registry: { om_child: { reportBinding: body.binding } },
      bindingSecret: loadOrCreateDashboardSecret(dispatchReportBindingSecretPath(root)),
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error(decision.error);
    const paths: string[] = [];
    const postProjectUpdate = vi.fn(async () => ({ projectSynced: true }));
    const result = await deliverReportSessionRelay({ decision,
      triggerMeta: { requestId: 'r1', receivedAt: new Date().toISOString() },
      fetchTarget: async (path, init) => {
        paths.push(path);
        return fetch(`http://127.0.0.1:${server.port}${path}`, { ...init,
          headers: daemonIpcAuthHeaders({ secret: 'test-ipc-secret', port: server.port,
            method: 'POST', path, headers: init.headers }) });
      }, postProjectUpdate,
    });
    expect(result).toMatchObject({ status: 200, body: { delivery: 'reply', projectSynced: true } });
    expect(postProjectUpdate).toHaveBeenCalledWith(decision.target);
    expect(paths).toEqual([REPORT_SOURCE_REPLY_ROUTE]);
    expect(mocks.reply).toHaveBeenCalledTimes(1);
  });
  it('keeps an unknown publication outcome at the direct sink and never falls through to a model trigger', async () => {
    // 结果未知（pending 账本、响应丢失）时禁止切换出口：既不能重发，也不能改走 /api/trigger
    // 再启动一个来源模型回合（那会造成同一结果既直投又回注）。
    const body = request();
    const decide = () => authorizeReportSessionRelayRequest({
      trustedHost: true, selfLarkAppId: 'cli_project',
      session: { sessionId: 'project', larkAppId: 'cli_project', chatId: 'oc_project', receiver: false,
        scope: 'thread', rootMessageId: 'om_child', liveOrigin: { capability: CAP, turnId: 'om_work' } },
      raw: { sessionId: 'project', dispatchRoot: 'om_child', content: body.content,
        originCapability: CAP, status: 'completed' },
      registry: { om_child: { reportBinding: body.binding } },
      bindingSecret: loadOrCreateDashboardSecret(dispatchReportBindingSecretPath(root)),
    });
    const authorized = decide();
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) throw new Error(authorized.error);
    const paths: string[] = [];
    const unknown = await deliverReportSessionRelay({ decision: authorized,
      triggerMeta: { requestId: 'r2', receivedAt: new Date().toISOString() },
      fetchTarget: vi.fn(async (path: string) => {
        paths.push(path);
        return { ok: false, status: 409,
          json: async () => ({ ok: false, error: 'report_publication_unknown', deliveryKey: 'k' }) } as any;
      }),
      postProjectUpdate: vi.fn(async () => ({ projectSynced: false })),
    });
    expect(unknown).toMatchObject({ status: 409, body: { error: 'report_publication_unknown' } });
    expect(paths).toEqual([REPORT_SOURCE_REPLY_ROUTE]);

    // 只有「确定未发送」的 source_changed 409 才回退到原 relay，触发来源模型回合。
    const changedPaths: string[] = [];
    const changed = await deliverReportSessionRelay({ decision: decide() as any,
      triggerMeta: { requestId: 'r3', receivedAt: new Date().toISOString() },
      fetchTarget: vi.fn(async (path: string) => {
        changedPaths.push(path);
        return path === REPORT_SOURCE_REPLY_ROUTE
          ? { ok: false, status: 409, json: async () => ({ ok: false, error: 'report_reply_source_changed' }) } as any
          : { ok: true, status: 200, json: async () => ({ ok: true, triggerId: 't1' }) } as any;
      }),
      postProjectUpdate: vi.fn(async () => ({ projectSynced: false })),
    });
    expect(changed.status).toBe(200);
    expect(changedPaths).toEqual([REPORT_SOURCE_REPLY_ROUTE, '/api/trigger']);
  });
  it('replays a settled direct reply after the source session drifts, never via /api/trigger', async () => {
    // 首投成功且回执已落盘；此后来源会话行消失/漂移（话题关闭、重启恢复期）。
    // 重试必须只凭持久账本重放 200：不重发卡片，也不得回退 /api/trigger 再启
    // 一个来源模型回合（否则同一已投递结果被二次处理）。
    const body = request();
    expect(await reply(body)).toMatchObject({ status: 200, body: { delivery: 'reply' } });
    sessions.clear();
    sessionStore.init(APP);
    const drifted = sessionStore.getSession('source');
    expect(drifted).toBeDefined();
    drifted!.rootMessageId = 'om_other';
    drifted!.quoteTargetId = 'om_followup';
    drifted!.reportReplyInputId = 'om_followup';
    sessionStore.updateSession(drifted!);

    const decision = authorizeReportSessionRelayRequest({
      trustedHost: true, selfLarkAppId: 'cli_project',
      session: { sessionId: 'project', larkAppId: 'cli_project', chatId: 'oc_project', receiver: false,
        scope: 'thread', rootMessageId: 'om_child', liveOrigin: { capability: CAP, turnId: 'om_work' } },
      raw: { sessionId: 'project', dispatchRoot: 'om_child', content: body.content,
        originCapability: CAP, status: 'completed' },
      registry: { om_child: { reportBinding: body.binding } },
      bindingSecret: loadOrCreateDashboardSecret(dispatchReportBindingSecretPath(root)),
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error(decision.error);
    const paths: string[] = [];
    const result = await deliverReportSessionRelay({ decision,
      triggerMeta: { requestId: 'r4', receivedAt: new Date().toISOString() },
      fetchTarget: async (path, init) => {
        paths.push(path);
        return fetch(`http://127.0.0.1:${server.port}${path}`, { ...init,
          headers: daemonIpcAuthHeaders({ secret: 'test-ipc-secret', port: server.port,
            method: 'POST', path, headers: init.headers }) });
      },
      postProjectUpdate: vi.fn(async () => ({ projectSynced: true })),
    });
    expect(result).toMatchObject({ status: 200, body: { delivery: 'reply', publishedMessageId: 'om_reply' } });
    expect(paths).toEqual([REPORT_SOURCE_REPLY_ROUTE]);
    expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('report publication IPC', () => {
  it.each(['thread', 'chat'] as const)('publishes to the dispatch thread from %s scope', async scope => {
    sessions.clear(); ds.scope = scope; ds.session.scope = scope;
    if (scope === 'chat') {
      ds.session.rootMessageId = CHAT;
      ds.session.replyTargets = { 'turn-report': { rootMessageId: 'om_dispatch', updatedAt: new Date().toISOString() } };
    }
    sessions.set(activeSessionKey(ds), ds);
    const result = await report();
    expect(result).toMatchObject({ status: 200, body: { publishedMessageId: 'om_reply',
      publicationTarget: { mode: 'thread', rootMessageId: 'om_dispatch', chatId: CHAT } } });
    expect(mocks.reply).toHaveBeenCalledWith(APP, 'om_dispatch', expect.any(String), 'interactive', true,
      expect.any(String), expect.objectContaining({ sessionId: 'source' }));
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('publishes at the authenticated task chat top level', async () => {
    expect(await report({ publishTo: 'chat' })).toMatchObject({ status: 200, body: {
      publishedMessageId: 'om_top', publicationTarget: { mode: 'top-level', chatId: CHAT },
    } });
    expect(mocks.send).toHaveBeenCalledWith(APP, CHAT, expect.any(String), 'interactive', expect.any(String), expect.any(Object));
    expect(mocks.reply).not.toHaveBeenCalled();
  });
  it.each(['privateCard', 'apiOnly'] as const)('refuses %s before publishing or journaling', async flag => {
    getBot(APP).config[flag] = true;
    expect(await report()).toMatchObject({ status: 403, body: { error: 'report_publication_unavailable' } });
    expect(journals()).toEqual([]); expect(mocks.reply).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });
  it('checks the rendered card size before sending and accepts corrected content', async () => {
    expect(await report({ content: '长'.repeat(11000) })).toMatchObject({ status: 413, body: { error: 'report_publication_too_large' } });
    expect(journals()).toEqual([]); expect(mocks.reply).not.toHaveBeenCalled();
    expect((await report()).status).toBe(200);
  });
  it('retries a withdrawn-root rejection with no unknown journal or fallback send', async () => {
    mocks.reply.mockRejectedValueOnce(Object.assign(new Error('withdrawn'), { name: 'MessageWithdrawnError' }));
    expect(await report()).toMatchObject({ status: 422, body: { error: 'report_publication_rejected' } });
    expect(journals()).toEqual([]); expect(mocks.send).not.toHaveBeenCalled();
    expect((await report()).status).toBe(200);
  });
  it('publishes changed content with a new key instead of replaying the old receipt', async () => {
    mocks.reply.mockResolvedValueOnce('om_first').mockResolvedValueOnce('om_second');
    const first = await report(); const replay = await report();
    const second = await report({ content: 'corrected result' });
    expect(replay.body).toEqual(first.body);
    expect(first.body.publishedMessageId).toBe('om_first');
    expect(second.body.publishedMessageId).toBe('om_second');
    expect(second.body.deliveryKey).not.toBe(first.body.deliveryKey);
    expect(mocks.reply).toHaveBeenCalledTimes(2);
  });
  it('retries only relay when the source daemon comes back online', async () => {
    mocks.online.mockReturnValue(undefined);
    const first = await report({ delivery: 'publish-and-relay' });
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect(first.body.publishedMessageId).toBe('om_reply');
    mocks.online.mockReturnValue({ ipcPort: 19999 });
    const retry = await report({ delivery: 'publish-and-relay' });
    expect(retry.status).toBe(200); expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls.filter(call => call[1] === '/api/trigger')).toHaveLength(1);
    expect((await report({ delivery: 'publish-and-relay' })).body).toEqual(retry.body);
    expect(mocks.fetch.mock.calls.filter(call => call[1] === '/api/trigger')).toHaveLength(1);
  });
});

describe('relay fallback publication (#2262)', () => {
  const relayReport = (overrides: Record<string, unknown> = {}) =>
    report({ delivery: 'relay', relayFallback: 'publish', explicitDispatchRoot: true, ...overrides });
  const triggerCalls = () => mocks.fetch.mock.calls.filter(call => call[1] === '/api/trigger');
  const rewriteBinding = (overrides: Record<string, unknown>) => {
    const secret = loadOrCreateDashboardSecret(dispatchReportBindingSecretPath(root));
    writeFileSync(join(root, 'orchestrate-dispatch.json'), JSON.stringify({
      om_dispatch: { orchAppId: 'cli_lead', orchSessionId: 'lead', reportBinding: createDispatchReportBinding(secret, {
        dispatchRoot: 'om_dispatch', targetLarkAppId: 'cli_lead', targetSessionId: 'lead', sourceName: 'task',
        issuedAt: new Date().toISOString(), ...overrides,
      }) },
    }));
  };
  /** The target daemon answers /api/trigger with this; other paths succeed. */
  const targetAnswers = (status: number, body: Record<string, unknown>, sessions: unknown[] = []) => {
    mocks.fetch.mockImplementation(async (_port: number, path: string) => new Response(JSON.stringify(
      path === '/api/trigger' ? body : path === '/api/sessions' ? { sessions } : { ok: true },
    ), { status: path === '/api/trigger' ? status : 200 }));
  };
  /** Markdown blocks of the published card, in display order. */
  const publishedCardBlocks = (): string[] => {
    const card = JSON.parse(mocks.reply.mock.calls.at(-1)![2] as string);
    return (card.body.elements as Array<{ tag: string; content?: string }>)
      .filter(element => element.tag === 'markdown').map(element => element.content ?? '');
  };
  const expectFallbackPublished = (
    result: Awaited<ReturnType<typeof report>>,
    reason: UndeliveredReportRelayReason,
  ) => {
    expect(result).toMatchObject({ status: 200, body: {
      ok: true, publishedMessageId: 'om_reply',
      publicationTarget: { mode: 'thread', rootMessageId: 'om_dispatch', chatId: CHAT },
      relayFallback: { reason, published: true },
    } });
    expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(mocks.reply).toHaveBeenCalledWith(APP, 'om_dispatch', expect.any(String), 'interactive', true,
      expect.any(String), expect.objectContaining({ sessionId: 'source' }));
    // The notice leads the card; the original report follows it unchanged.
    const [notice, ...rest] = publishedCardBlocks();
    expect(notice).toContain(`未送达主编排：${UNDELIVERED_REPORT_RELAY_REASON_TEXT[reason]}`);
    expect(rest).toEqual(['Result', 'Done']);
  };

  it('publishes visibly when the orchestrator daemon is offline', async () => {
    mocks.online.mockReturnValue(undefined);
    expectFallbackPublished(await relayReport(), 'orchestrator_offline');
    expect(triggerCalls()).toHaveLength(0);
  });

  it('publishes visibly when the listed orchestrator daemon refuses the connection', async () => {
    const closed = createServer();
    await new Promise<void>(done => closed.listen(0, '127.0.0.1', done));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>(done => closed.close(() => done()));
    const actual = await vi.importActual<typeof import('../src/core/daemon-ipc-auth.js')>('../src/core/daemon-ipc-auth.js');
    mocks.fetch.mockImplementation((_port: number, path: string, init: RequestInit) =>
      actual.fetchDaemonIpc(closedPort, path, init, 'test-ipc-secret'));
    expectFallbackPublished(await relayReport(), 'orchestrator_offline');
  });

  it('publishes visibly when the signed thread orchestrator session has closed', async () => {
    rewriteBinding({ targetChatId: 'oc_lead', targetScope: 'thread' });
    targetAnswers(404, { ok: false, errorCode: 'session_not_found', error: 'active session not found: lead' });
    const result = await relayReport();
    expectFallbackPublished(result, 'orchestrator_session_closed');
    expect(result.body.relayFallback).toMatchObject({ relayStatus: 409, relayError: 'fallback_scope_unsupported' });
  });

  it('publishes visibly when a chat orchestrator closed without a unique successor', async () => {
    rewriteBinding({ targetChatId: 'oc_lead', targetScope: 'chat' });
    targetAnswers(404, { ok: false, errorCode: 'session_not_found' }, [
      { sessionId: 'lead', larkAppId: 'cli_lead', chatId: 'oc_lead', scope: 'chat', status: 'closed' },
    ]);
    expectFallbackPublished(await relayReport(), 'orchestrator_session_closed');
  });

  it('publishes visibly when the orchestrator session is still waiting to start', async () => {
    targetAnswers(500, { ok: false, errorCode: 'session_not_runnable',
      error: 'target session lead is not runnable (pending_repo); preserving its opening prompt' });
    expectFallbackPublished(await relayReport(), 'orchestrator_session_not_ready');
  });

  it('publishes visibly for a named dispatch root that is no longer registered, without touching any daemon', async () => {
    writeFileSync(join(root, 'orchestrate-dispatch.json'), '{}');
    expectFallbackPublished(await relayReport(), 'dispatch_target_gone');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('keeps an implicit dispatch root miss as a plain 404 for the CLI to place itself', async () => {
    writeFileSync(join(root, 'orchestrate-dispatch.json'), '{}');
    expect(await relayReport({ explicitDispatchRoot: undefined })).toEqual({
      status: 404, body: { ok: false, error: 'dispatch_target_unavailable' },
    });
    expect(mocks.reply).not.toHaveBeenCalled(); expect(journals()).toEqual([]);
  });

  it('returns the same relay receipt with or without the fallback opt-in when the orchestrator accepts it', async () => {
    const withFallback = await relayReport();
    const without = await report({ delivery: 'relay' });
    expect(withFallback).toEqual(without);
    expect(withFallback).toMatchObject({ status: 200, body: { ok: true, triggerId: 'trigger-report',
      reportTarget: { sessionId: 'lead', larkAppId: 'cli_lead' } } });
    expect(withFallback.body).not.toHaveProperty('relayFallback');
    expect(mocks.reply).not.toHaveBeenCalled(); expect(journals()).toEqual([]);
  });

  it('leaves relay failures unchanged for callers that did not opt in', async () => {
    mocks.online.mockReturnValue(undefined);
    expect(await report({ delivery: 'relay' })).toEqual({
      status: 503, body: { ok: false, error: 'orchestrator_daemon_offline' },
    });
    mocks.online.mockReturnValue({ ipcPort: 19999 });
    targetAnswers(500, { ok: false, errorCode: 'session_not_runnable', error: 'not runnable' });
    const notReady = await report({ delivery: 'relay' });
    expect(notReady.status).toBe(500);
    expect(notReady.body).not.toHaveProperty('relayFallback');
    expect(mocks.reply).not.toHaveBeenCalled(); expect(journals()).toEqual([]);
  });

  it.each([
    { name: 'bot not in chat', status: 403, body: { ok: false, errorCode: 'bot_not_in_chat', error: 'bot left' } },
    { name: 'bad request', status: 400, body: { ok: false, errorCode: 'bad_request', error: 'apiOnly target' } },
    { name: 'generic 500 trigger_failed (possibly post-delivery)', status: 500,
      body: { ok: false, errorCode: 'trigger_failed', error: 'receipt persistence failed after worker acceptance' } },
    { name: 'untyped 404', status: 404, body: { ok: false, error: 'active session not found: lead' } },
  ])('does not publish for a relay failure it cannot prove undelivered: $name', async ({ status, body }) => {
    targetAnswers(status, body);
    const result = await relayReport();
    expect(result.status).toBe(status);
    expect(result.body).toMatchObject({ ok: false });
    expect(result.body).not.toHaveProperty('relayFallback');
    expect(mocks.reply).not.toHaveBeenCalled(); expect(journals()).toEqual([]);
  });

  it.each([
    { blockedBy: 'private_card', setup: () => { getBot(APP).config.privateCard = true; } },
    { blockedBy: 'no_lark_transport', setup: () => { getBot(APP).config.apiOnly = true; } },
    { blockedBy: 'prompt_injection', setup: () => { ds.session.promptInjection = 'none'; } },
  ])('refuses the fallback with an explicit reason for $blockedBy', async ({ blockedBy, setup }) => {
    setup();
    mocks.online.mockReturnValue(undefined);
    expect(await relayReport()).toEqual({ status: 503, body: {
      ok: false, error: 'orchestrator_daemon_offline',
      relayFallback: {
        reason: 'orchestrator_offline', reasonText: UNDELIVERED_REPORT_RELAY_REASON_TEXT.orchestrator_offline,
        relayStatus: 503, relayError: 'orchestrator_daemon_offline',
        published: false, publicationError: 'report_publication_unavailable', blockedBy,
      },
    } });
    expect(mocks.reply).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
    expect(journals()).toEqual([]);
  });

  it('reports a failed fallback publication instead of claiming the report is visible', async () => {
    mocks.online.mockReturnValue(undefined);
    mocks.reply.mockRejectedValueOnce(Object.assign(new Error('withdrawn'), { name: 'MessageWithdrawnError' }));
    expect(await relayReport()).toMatchObject({ status: 503, body: {
      ok: false, error: 'orchestrator_daemon_offline',
      relayFallback: { reason: 'orchestrator_offline', published: false, publicationError: 'report_publication_rejected' },
    } });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not publish when the reporting turn changed while the relay was in flight', async () => {
    mocks.fetch.mockImplementation(async (_port: number, path: string) => {
      if (path === '/api/trigger') {
        ds.managedTurnOrigin = { capability: 'd'.repeat(64), turnId: 'turn-next', dispatchAttempt: 1 };
        return new Response(JSON.stringify({ ok: false, errorCode: 'session_not_runnable', error: 'not runnable' }), { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const result = await relayReport();
    expect(result.status).toBe(500);
    expect(result.body.relayFallback).toMatchObject({ reason: 'orchestrator_session_not_ready', published: false });
    expect(mocks.reply).not.toHaveBeenCalled(); expect(journals()).toEqual([]);
  });

  it('replays the first fallback when the same report is retried in the same turn', async () => {
    mocks.online.mockReturnValue(undefined);
    const first = await relayReport();
    mocks.online.mockReturnValue({ ipcPort: 19999 });
    targetAnswers(500, { ok: false, errorCode: 'session_not_runnable', error: 'not runnable' });
    const retry = await relayReport();
    expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(retry.body.publishedMessageId).toBe(first.body.publishedMessageId);
    expect(retry.body.relayFallback).toMatchObject({ reason: 'orchestrator_session_not_ready', published: true });
  });
});
