import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  routes: new Map<string, (req: any, res: any, params: any) => Promise<unknown>>(),
  request: vi.fn(), create: vi.fn(), reply: vi.fn(), fetchTarget: vi.fn(),
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {
  request = mocks.request;
  im = { v1: { message: { create: mocks.create, reply: mocks.reply } } };
} }));
vi.mock('../src/core/dashboard-ipc-server.js', async () => ({
  ...await vi.importActual<any>('../src/core/dashboard-ipc-server.js'),
  ipcRoute: (method: string, path: string, handler: any) => { mocks.routes.set(method + ' ' + path, handler); },
  isTrustedHostIpcRequest: () => true,
  readJsonBody: async (req: any) => req.body,
  jsonRes: (res: any, status: number, body: unknown) => Object.assign(res, { status, body }),
}));
vi.mock('../src/utils/daemon-discovery.js', async () => ({
  ...await vi.importActual<any>('../src/utils/daemon-discovery.js'),
  findOnlineDaemon: () => ({ ipcPort: 19001 }),
}));
vi.mock('../src/core/daemon-ipc-auth.js', async () => ({
  ...await vi.importActual<any>('../src/core/daemon-ipc-auth.js'),
  fetchDaemonIpc: mocks.fetchTarget,
}));
import { setActiveSessionsRegistry, getActiveSessionsRegistry } from '../src/core/worker-pool.js';
import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { __testOnly_activeSessions as activeSessions, __vcMeetingAgentTest } from '../src/daemon.js';
import { __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';
import { createDispatchReportBinding, dispatchReportBindingSecretPath, DISPATCH_REPORT_REGISTER_ROUTE } from '../src/core/dispatch-report-binding.js';
import { DISPATCH_USER_DELIVERY_ROUTE } from '../src/core/dispatch-user-delegation.js';
import { REPORT_SESSION_RELAY_ROUTE } from '../src/core/report-session-relay.js';
import { loadOrCreateDashboardSecret } from '../src/dashboard/auth.js';

const APP = 'cli_topic_source';
const oldDataDir = config.session.dataDir;
const originalRegistry = getActiveSessionsRegistry();
let root: string;
let fixtureHome: string;
let unavailable: boolean;
let ds: DaemonSession;

beforeEach(() => {
  vi.clearAllMocks(); __testOnly_resetLarkGate();
  vi.stubEnv('BOTMUX_LARK_QPS', '100000');
  vi.stubEnv('BOTMUX_LARK_GATE_RETRY_BASE_MS', '1');
  vi.stubEnv('BOTMUX_MULTI_TOPIC_ENABLED', 'true');
  fixtureHome = mkdtempSync(join(tmpdir(), 'daemon-topic-source-'));
  root = join(fixtureHome, 'data');
  mkdirSync(root, { mode: 0o700 });
  config.session.dataDir = root;
  unavailable = false;
  activeSessions.clear(); setActiveSessionsRegistry(activeSessions);
  __vcMeetingAgentTest.setSelfDaemonLarkAppIdForTest(APP);
  registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code', topicUnavailablePolicy: 'stop' });
  ds = { larkAppId: APP, chatId: 'oc_source', scope: 'thread', chatType: 'group',
    managedTurnOrigin: { turnId: 'turn-source', capability: 'c'.repeat(64), dispatchAttempt: 1 },
    session: { sessionId: 'sid_source', larkAppId: APP, chatId: 'oc_source', scope: 'thread',
      rootMessageId: 'om_source', status: 'active', title: 'source', workingDir: root },
  } as unknown as DaemonSession;
  activeSessions.set(activeSessionKey(ds), ds);
  mocks.request.mockReset().mockImplementation(async ({ method, url }) => {
    if (method !== 'GET' || !url.includes('/im/v1/messages/')) throw new Error('Unexpected provider request');
    const id = url.split('/').at(-1);
    return { code: 0, data: { items: [{ message_id: id, chat_id: id === 'om_target' ? 'oc_target' : 'oc_source',
      deleted: id === 'om_source' && unavailable }] } };
  });
  mocks.create.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_sent' } });
  mocks.reply.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_sent' } });
  mocks.fetchTarget.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
});
afterEach(() => {
  activeSessions.clear(); __vcMeetingAgentTest.setSelfDaemonLarkAppIdForTest(undefined);
  config.session.dataDir = oldDataDir; setActiveSessionsRegistry(originalRegistry);
  rmSync(fixtureHome, { recursive: true, force: true });
  vi.unstubAllEnvs(); __testOnly_resetLarkGate();
});

async function invoke(path: string, body: Record<string, unknown>) {
  const handler = mocks.routes.get('POST ' + path);
  expect(handler).toBeDefined();
  const res = {} as { status: number; body: Record<string, any> };
  await handler!({ body: { sessionId: 'sid_source', ...body } }, res, {});
  return res;
}
function registerBody() { return { targetChatId: 'oc_target', seedText: 'new delegated task', title: 'task' }; }
function seedReportBinding() {
  const secret = loadOrCreateDashboardSecret(dispatchReportBindingSecretPath(root));
  writeFileSync(join(root, 'orchestrate-dispatch.json'), JSON.stringify({ om_source: {
    reportBinding: createDispatchReportBinding(secret, { dispatchRoot: 'om_source', targetLarkAppId: 'cli_target',
      targetSessionId: 'sid_target', targetChatId: 'oc_target', targetScope: 'chat', sourceName: 'task', issuedAt: new Date().toISOString() }),
  } }));
}

describe('daemon dispatch and report source topics', () => {
  it('does not create a dispatch seed or registry entry after the source was withdrawn', async () => {
    unavailable = true;
    const result = await invoke(DISPATCH_REPORT_REGISTER_ROUTE, registerBody());
    expect(result.status).toBe(502);
    expect(result.body.detail).toContain('TOPIC_SEND_BLOCKED');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'orchestrate-dispatch.json'))).toBe(false);
  });
  it('rechecks the frozen source after rate limiting even when session state moves on', async () => {
    mocks.create.mockImplementationOnce(async () => {
      unavailable = true; ds.session.rootMessageId = 'om_new_topic';
      throw { isAxiosError: true, response: { status: 429 } };
    });
    const result = await invoke(DISPATCH_REPORT_REGISTER_ROUTE, registerBody());
    expect(result.body.detail).toContain('TOPIC_SEND_BLOCKED');
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.request.mock.calls.map(([r]) => r.url.split('/').at(-1))).toEqual(['om_source', 'om_source']);
    expect(existsSync(join(root, 'orchestrate-dispatch.json'))).toBe(false);
  });
  it('does not borrow a replacement turn after waiting in the provider queue', async () => {
    mocks.create.mockImplementationOnce(async () => {
      ds.managedTurnOrigin = { turnId: 'turn-next', capability: 'd'.repeat(64), dispatchAttempt: 2 };
      throw { isAxiosError: true, response: { status: 429 } };
    });
    const result = await invoke(DISPATCH_REPORT_REGISTER_ROUTE, registerBody());
    expect(result.status).toBe(502);
    expect(result.body.detail).toContain('dispatch origin changed');
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(existsSync(join(root, 'orchestrate-dispatch.json'))).toBe(false);
  });
  it('checks the same origin again after an awaited topic lookup', async () => {
    mocks.request.mockImplementationOnce(async ({ url }) => {
      ds.managedTurnOrigin = { turnId: 'turn-next', capability: 'd'.repeat(64), dispatchAttempt: 2 };
      return { code: 0, data: { items: [{ message_id: url.split('/').at(-1), deleted: false }] } };
    });
    const result = await invoke(DISPATCH_REPORT_REGISTER_ROUTE, registerBody());
    expect(result.body.detail).toContain('dispatch origin changed');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('retains a folded topic for a trusted host request without managed turn metadata', async () => {
    ds.scope = 'chat'; ds.session.scope = 'chat'; ds.managedTurnOrigin = undefined;
    ds.currentReplyTarget = { turnId: 'turn-source', rootMessageId: 'om_source' };
    unavailable = true;
    const result = await invoke(DISPATCH_REPORT_REGISTER_ROUTE, registerBody());
    expect(result.status).toBe(502);
    expect(result.body.detail).toContain('TOPIC_SEND_BLOCKED');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects a new managed origin introduced while an unscoped request awaits lookup', async () => {
    ds.managedTurnOrigin = undefined;
    mocks.request.mockImplementationOnce(async ({ url }) => {
      ds.managedTurnOrigin = { turnId: 'turn-next', capability: 'd'.repeat(64), dispatchAttempt: 2 };
      return { code: 0, data: { items: [{ message_id: url.split('/').at(-1), deleted: false }] } };
    });
    const result = await invoke(DISPATCH_REPORT_REGISTER_ROUTE, registerBody());
    expect(result.status).toBe(502);
    expect(result.body.detail).toContain('dispatch origin changed');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('uses the exact frozen turn instead of a newer chat reply target', async () => {
    ds.scope = 'chat'; ds.session.scope = 'chat';
    ds.currentReplyTarget = { turnId: 'turn-next', rootMessageId: 'om_new_topic' };
    ds.session.turnReplyContexts = { 'turn-source': { target: { mode: 'thread', rootMessageId: 'om_source' } } };
    unavailable = true;
    const result = await invoke(DISPATCH_REPORT_REGISTER_ROUTE, registerBody());
    expect(result.status).toBe(502);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.map(([r]) => r.url.split('/').at(-1))).toEqual(['om_source']);
  });
  it('does not write after its active session instance is removed during lookup', async () => {
    mocks.request.mockImplementationOnce(async ({ url }) => {
      activeSessions.clear();
      return { code: 0, data: { items: [{ message_id: url.split('/').at(-1), deleted: false }] } };
    });
    const result = await invoke(DISPATCH_REPORT_REGISTER_ROUTE, registerBody());
    expect(result.status).toBe(502);
    expect(result.body.detail).toContain('dispatch origin changed');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects missing topic evidence instead of treating it as a plain chat', async () => {
    ds.session.rootMessageId = undefined;
    const result = await invoke(DISPATCH_REPORT_REGISTER_ROUTE, registerBody());
    expect(result.status).toBe(502);
    expect(result.body.detail).toContain('TOPIC_SEND_CHECK_FAILED');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('allows a live source while preserving its intended dispatch destination', async () => {
    const result = await invoke(DISPATCH_REPORT_REGISTER_ROUTE, registerBody());
    expect(result.status).toBe(201);
    expect(result.body.dispatchRoot).toBe('om_sent');
    expect(mocks.create.mock.calls[0][0].data.receive_id).toBe('oc_target');
  });
  it('does not invent a topic for an unthreaded source', async () => {
    ds.scope = 'chat'; ds.session.scope = 'chat'; unavailable = true;
    const result = await invoke(DISPATCH_REPORT_REGISTER_ROUTE, registerBody());
    expect(result.status).toBe(201);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('protects the source of a dispatch into a different available topic', async () => {
    unavailable = true;
    const result = await invoke(DISPATCH_USER_DELIVERY_ROUTE, { rootId: 'om_target', chatId: 'oc_target', content: 'task', targetAppIds: [] });
    expect(result.status).toBe(502);
    expect(result.body.detail).toContain('TOPIC_SEND_BLOCKED');
    expect(mocks.reply).not.toHaveBeenCalled();
  });
  it('does not relay a report when its authenticated source was withdrawn', async () => {
    seedReportBinding(); unavailable = true;
    const result = await invoke(REPORT_SESSION_RELAY_ROUTE, { dispatchRoot: 'om_source', content: 'result' });
    expect(result.status).toBe(502); expect(result.body.error).toBe('TOPIC_SEND_BLOCKED');
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.fetchTarget).not.toHaveBeenCalled();
  });
  it('does not add source queries under legacy policy', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code', topicUnavailablePolicy: 'legacy' });
    unavailable = true;
    const result = await invoke(DISPATCH_REPORT_REGISTER_ROUTE, registerBody());
    expect(result.status).toBe(201); expect(mocks.request).not.toHaveBeenCalled();
  });
});
