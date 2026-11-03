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
