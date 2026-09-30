/** Real HTTP IPC router, authorization, journal and sessionReply; only the
 * provider and source daemon transport are replaced. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const APP = 'cli_report_ipc';
const CHAT = 'oc_report';
const CAP = 'c'.repeat(64);
let root: string;
let server: IpcServerHandle;
let ds: DaemonSession;
const originalDataDir = config.session.dataDir;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'report-ipc-'));
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
  rmSync(root, { recursive: true, force: true });
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
