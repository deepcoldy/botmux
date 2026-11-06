/**
 * Wire-level regression: plain-text notices must reach Feishu wrapped ONCE.
 *
 * `sendMessage` / `replyMessage` wrap `msgType: 'text'` content as
 * `{"text": …}` themselves. The dashboard restart / resume notices and the
 * `/introduce` grant-restricted reply used to pre-`JSON.stringify({ text })`
 * before handing it over, so the group saw a literal `{"text":"🔄 正在重启 …"}`.
 *
 * The real routes and the real Lark client run here; only the Lark SDK object
 * (`getBotClient`) is replaced, so the assertions read the exact `content`
 * string that would be POSTed to Feishu.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lark = vi.hoisted(() => ({
  create: vi.fn(),
  reply: vi.fn(),
  request: vi.fn(),
  /** group_message_type the fake chat-info endpoint reports ('chat' | 'thread'). */
  groupMessageType: 'chat',
}));

vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/bot-registry.js')>(),
  getBotClient: () => ({
    im: { v1: { message: { create: lark.create, reply: lark.reply } } },
    request: lark.request,
  }),
}));

import { setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import { config } from '../src/config.js';
import { __testOnly_resetBotRegistry, registerBot } from '../src/bot-registry.js';
import { tryHandleIntroduceCommand } from '../src/im/lark/event-dispatcher.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const APP_ID = 'app_text_notice_wire';

let handle: IpcServerHandle | null = null;

beforeEach(() => {
  lark.groupMessageType = 'chat';
  lark.create.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_sent', chat_id: 'oc_chat' } });
  lark.reply.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_replied', chat_id: 'oc_chat' } });
  lark.request.mockReset().mockImplementation(async (req: { method?: string; url?: string }) => {
    if (req.method === 'GET' && /\/open-apis\/im\/v1\/chats\//.test(req.url ?? '')) {
      return { code: 0, data: { chat_mode: 'group', group_message_type: lark.groupMessageType } };
    }
    return { code: 0, data: {} };
  });
  workerPool.__testOnly_resetRestartCoordinator();
  workerPool.restartCounts.clear();
  registerBot({ larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'codex' });
  workerPool.initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
    getSessionWorkingDir: () => '/tmp',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  } as any);
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  vi.restoreAllMocks();
  workerPool.setActiveSessionsRegistry(new Map());
  workerPool.__testOnly_resetRestartCoordinator();
  workerPool.restartCounts.clear();
  __testOnly_resetBotRegistry();
});

async function ipc(path: string): Promise<Response> {
  if (!handle) handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  return fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
}

/** Every text message the fake SDK received, in order, as {api, data}. */
function textWrites(): Array<{ api: 'create' | 'reply'; data: any; path?: any }> {
  const out: Array<{ api: 'create' | 'reply'; data: any; path?: any }> = [];
  for (const [arg] of lark.create.mock.calls) {
    if (arg?.data?.msg_type === 'text') out.push({ api: 'create', data: arg.data, path: arg.params });
  }
  for (const [arg] of lark.reply.mock.calls) {
    if (arg?.data?.msg_type === 'text') out.push({ api: 'reply', data: arg.data, path: arg.path });
  }
  return out;
}

/** The content is exactly one `{"text": …}` layer whose text is human-readable. */
function expectSingleWrap(content: string, prefix: string): string {
  const parsed = JSON.parse(content);
  expect(Object.keys(parsed)).toEqual(['text']);
  expect(typeof parsed.text).toBe('string');
  expect(parsed.text.startsWith(prefix)).toBe(true);
  // A second layer would make the inner text itself parse as {"text": …}.
  expect(parsed.text.trimStart().startsWith('{')).toBe(false);
  return parsed.text;
}

function makeFakeWorker() {
  const w = new EventEmitter() as any;
  w.killed = false;
  w.connected = true;
  w.send = vi.fn();
  w.kill = vi.fn();
  w.pid = 12345;
  w.stdout = new EventEmitter();
  w.stderr = new EventEmitter();
  return w;
}

let seq = 0;

function armSession(scope: 'chat' | 'thread'): { ds: DaemonSession; sessionId: string; rootMessageId: string } {
  const sessionId = `sid-text-notice-${++seq}`;
  const rootMessageId = `om_root_${seq}`;
  const worker = makeFakeWorker();
  const ds = {
    session: {
      sessionId,
      rootMessageId,
      chatId: 'oc_chat',
      title: 'Text notice',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: 'codex',
      scope,
    },
    scope,
    worker,
    workerPort: 9999,
    workerToken: 'tok',
    workerReady: true,
    cliReady: true,
    larkAppId: APP_ID,
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    displayMode: 'hidden',
    lastScreenContent: '',
    lastScreenStatus: 'idle',
  } as unknown as DaemonSession;
  workerPool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
  workerPool.__testOnly_setupWorkerHandlers(ds, worker);
  return { ds, sessionId, rootMessageId };
}

describe('dashboard restart notice reaches Feishu wrapped once', () => {
  beforeEach(() => {
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
  });

  it('chat-scope session in a flat group: chat message, single {"text"} layer', async () => {
    const { sessionId } = armSession('chat');
    lark.groupMessageType = 'chat';

    const res = await ipc(`/api/sessions/${sessionId}/restart`);
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(textWrites()).toHaveLength(1));
    const [w] = textWrites();
    expect(w.api).toBe('create');
    expect(w.data.receive_id).toBe('oc_chat');
    expect(expectSingleWrap(w.data.content, '🔄')).toContain('Codex');
  });

  it('chat-scope session in a topic group: threaded reply to the root, single layer', async () => {
    const { sessionId, rootMessageId } = armSession('chat');
    lark.groupMessageType = 'thread';

    const res = await ipc(`/api/sessions/${sessionId}/restart`);
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(textWrites()).toHaveLength(1));
    const [w] = textWrites();
    expect(w.api).toBe('reply');
    expect(w.path).toMatchObject({ message_id: rootMessageId });
    expect(w.data.reply_in_thread).toBe(true);
    expect(expectSingleWrap(w.data.content, '🔄')).toContain('Codex');
  });

  it('thread-scope session: reply into the thread root, single layer', async () => {
    const { sessionId, rootMessageId } = armSession('thread');

    const res = await ipc(`/api/sessions/${sessionId}/restart`);
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(textWrites()).toHaveLength(1));
    const [w] = textWrites();
    expect(w.api).toBe('reply');
    expect(w.path).toMatchObject({ message_id: rootMessageId });
    expect(w.data.reply_in_thread).toBe(true);
    expect(expectSingleWrap(w.data.content, '🔄')).toContain('Codex');
  });

  it('revive branch (worker gone) uses the same single-layer notice', async () => {
    const { ds, sessionId } = armSession('thread');
    ds.worker = null;
    const forkSpy = vi.spyOn(workerPool, 'forkWorker').mockImplementation(() => {});

    const res = await ipc(`/api/sessions/${sessionId}/restart`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revived: true });
    expect(forkSpy).toHaveBeenCalled();

    await vi.waitFor(() => expect(textWrites()).toHaveLength(1));
    expectSingleWrap(textWrites()[0].data.content, '🔄');
  });
});

describe('dashboard resume notice reaches Feishu wrapped once', () => {
  it('thread-scope resume uses the bot locale and preserves the CLI name', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'text-notice-resume-'));
    const prevDataDir = config.session.dataDir;
    const registry = new Map<string, any>();
    try {
      __testOnly_resetBotRegistry();
      registerBot({ larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'codex', lang: 'en' });
      config.session.dataDir = dataDir;
      setLarkAppId(APP_ID);
      sessionStore.init(APP_ID);
      workerPool.setActiveSessionsRegistry(registry);
      const session = sessionStore.createSession('oc_chat', 'om_resume_root', 'resume notice', 'group');
      Object.assign(session, { larkAppId: APP_ID, scope: 'thread', cliId: 'codex', workingDir: '/tmp' });
      sessionStore.updateSession(session);
      sessionStore.closeSession(session.sessionId);

      const res = await ipc(`/api/sessions/${session.sessionId}/resume`);
      expect(res.status).toBe(200);

      await vi.waitFor(() => expect(textWrites()).toHaveLength(1));
      const [w] = textWrites();
      expect(w.api).toBe('reply');
      expect(w.path).toMatchObject({ message_id: 'om_resume_root' });
      const notice = expectSingleWrap(w.data.content, '🔄');
      expect(notice).toContain('Session resumed through the command line');
      expect(notice).toContain('Codex');
      expect(notice).not.toMatch(/[一-鿿]/u);
    } finally {
      workerPool.setActiveSessionsRegistry(new Map());
      setLarkAppId('');
      sessionStore.init('test-app');
      config.session.dataDir = prevDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('remote recovery uses the existing localized in-progress notice', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'text-notice-remote-resume-'));
    const prevDataDir = config.session.dataDir;
    const registry = new Map<string, any>();
    const forkSpy = vi.spyOn(workerPool, 'forkWorker').mockImplementation((ds: any, _prompt, _resume, opts: any) => {
      ds.worker = { killed: false };
      opts?.onAdmission?.('accepted');
      return true;
    });
    try {
      __testOnly_resetBotRegistry();
      registerBot({ larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'codex', lang: 'en' });
      config.session.dataDir = dataDir;
      setLarkAppId(APP_ID);
      sessionStore.init(APP_ID);
      workerPool.setActiveSessionsRegistry(registry);
      const session = sessionStore.createSession('oc_chat', 'om_remote_resume_root', 'remote resume notice', 'group');
      Object.assign(session, {
        larkAppId: APP_ID,
        scope: 'thread',
        cliId: 'codex',
        backendType: 'remote-runner',
        workingDir: '/tmp',
      });
      sessionStore.updateSession(session);
      sessionStore.closeSession(session.sessionId);

      const res = await ipc(`/api/sessions/${session.sessionId}/resume`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ recoveryPending: true });

      await vi.waitFor(() => expect(textWrites()).toHaveLength(1));
      const notice = expectSingleWrap(textWrites()[0].data.content, '🔄');
      expect(notice).toContain('Remote recovery for Codex has started');
      expect(notice).not.toMatch(/[一-鿿]/u);
    } finally {
      forkSpy.mockRestore();
      workerPool.setActiveSessionsRegistry(new Map());
      setLarkAppId('');
      sessionStore.init('test-app');
      config.session.dataDir = prevDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('/introduce grant-restricted reply reaches Feishu wrapped once', () => {
  it('a global-grant visitor gets a single {"text"} layer refusal', async () => {
    __testOnly_resetBotRegistry();
    registerBot({
      larkAppId: APP_ID,
      larkAppSecret: 'secret',
      cliId: 'codex',
      restrictGrantCommands: true,
      globalGrants: ['ou_visitor'],
    } as any);

    const handled = await tryHandleIntroduceCommand(APP_ID, {
      message_id: 'om_introduce',
      chat_id: 'oc_chat',
      message_type: 'text',
      content: JSON.stringify({ text: '/introduce' }),
      mentions: [],
    }, 'ou_visitor');

    expect(handled).toBe(true);
    const writes = textWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].api).toBe('reply');
    expect(writes[0].path).toMatchObject({ message_id: 'om_introduce' });
    const text = JSON.parse(writes[0].data.content).text;
    expect(typeof text).toBe('string');
    expect(text.trimStart().startsWith('{')).toBe(false);
    expect(text).toContain('/introduce');
  });
});
