/**
 * Wire-level regression: plain-text notices must reach Feishu wrapped ONCE.
 *
 * `sendMessage` / `replyMessage` wrap `msgType: 'text'` content as
 * `{"text": …}` themselves. The dashboard resume notice and the `/introduce`
 * grant-restricted reply used to pre-`JSON.stringify({ text })` before handing
 * it over, so the group saw a literal `{"text":"🔄 …"}`. (The dashboard restart
 * notice had the same bug; it is now a status card — see
 * restart-status-card.test.ts.)
 *
 * The real routes and the real Lark client run here; only the Lark SDK object
 * (`getBotClient`) is replaced, so the assertions read the exact `content`
 * string that would be POSTed to Feishu.
 */
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

describe('dashboard resume notice reaches Feishu wrapped once', () => {
  // Each scenario runs under BOTH bot locales: hardcoding either locale at the
  // call site (instead of resolving localeForBot) must turn one direction red.
  const LOCALES = [
    { lang: 'en' as const, hasCjk: false },
    { lang: 'zh' as const, hasCjk: true },
  ];

  /** Create+close a session, POST /resume, and return the single text write. */
  async function resumeOnce(
    lang: 'en' | 'zh',
    opts: { root: string; cliId: string; backendType?: string },
  ): Promise<{ api: string; data: any; path: any; status: number; body: any }> {
    const dataDir = mkdtempSync(join(tmpdir(), 'text-notice-resume-'));
    const prevDataDir = config.session.dataDir;
    const registry = new Map<string, any>();
    const forkSpy = opts.backendType === 'remote-runner'
      ? vi.spyOn(workerPool, 'forkWorker').mockImplementation((ds: any, _prompt, _resume, o: any) => {
        ds.worker = { killed: false };
        o?.onAdmission?.('accepted');
        return true;
      })
      : undefined;
    try {
      __testOnly_resetBotRegistry();
      registerBot({ larkAppId: APP_ID, larkAppSecret: 'secret', cliId: opts.cliId, lang });
      config.session.dataDir = dataDir;
      setLarkAppId(APP_ID);
      sessionStore.init(APP_ID);
      workerPool.setActiveSessionsRegistry(registry);
      const session = sessionStore.createSession('oc_chat', opts.root, 'resume notice', 'group');
      Object.assign(session, {
        larkAppId: APP_ID,
        scope: 'thread',
        cliId: opts.cliId,
        workingDir: '/tmp',
        ...(opts.backendType ? { backendType: opts.backendType } : {}),
      });
      sessionStore.updateSession(session);
      sessionStore.closeSession(session.sessionId);

      const res = await ipc(`/api/sessions/${session.sessionId}/resume`);
      const body = await res.json();
      expect(res.status).toBe(200);

      await vi.waitFor(() => expect(textWrites()).toHaveLength(1));
      const [w] = textWrites();
      return { ...w, status: res.status, body };
    } finally {
      forkSpy?.mockRestore();
      workerPool.setActiveSessionsRegistry(new Map());
      setLarkAppId('');
      sessionStore.init('test-app');
      config.session.dataDir = prevDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  // The route also serves the Dashboard session row's resume button.
  it.each(LOCALES)('ordinary resume ($lang) resolves the bot locale, keeps the CLI name and names no caller', async ({ lang, hasCjk }) => {
    const fragment = lang === 'en' ? 'Session resumed' : '会话已恢复';
    const otherFragment = lang === 'en' ? '会话已恢复' : 'Session resumed';
    const w = await resumeOnce(lang, { root: 'om_resume_root', cliId: 'codex' });
    expect(w.api).toBe('reply');
    expect(w.path).toMatchObject({ message_id: 'om_resume_root' });
    const notice = expectSingleWrap(w.data.content, '✅');
    expect(notice).toContain(fragment);
    expect(notice).not.toContain(otherFragment);
    expect(notice).not.toMatch(/command line|命令行/i);
    expect(notice).toContain('Codex');
    expect(/[一-鿿]/u.test(notice)).toBe(hasCjk);
  });

  it.each(LOCALES)('remote recovery ($lang) reuses the localized in-progress notice', async ({ lang, hasCjk }) => {
    const fragment = lang === 'en' ? 'Remote recovery for Codex has started' : '远程恢复已启动';
    const w = await resumeOnce(lang, { root: 'om_remote_resume_root', cliId: 'codex', backendType: 'remote-runner' });
    expect(w.body).toMatchObject({ recoveryPending: true });
    const notice = expectSingleWrap(w.data.content, '🔄');
    expect(notice).toContain(fragment);
    expect(notice).toContain('Codex');
    expect(/[一-鿿]/u.test(notice)).toBe(hasCjk);
  });

  it.each(LOCALES)('fresh-only resume ($lang) warns the next message starts a fresh session', async ({ lang, hasCjk }) => {
    // cursor can only resume a precise cliSessionId and none was persisted.
    const fragment = lang === 'en' ? 'fresh session' : '新起干净会话';
    const w = await resumeOnce(lang, { root: 'om_fresh_resume_root', cliId: 'cursor' });
    expect(w.body).toMatchObject({ recoveryPending: false });
    const notice = expectSingleWrap(w.data.content, '✅');
    expect(notice).toContain(fragment);
    expect(notice).toContain('Cursor');
    expect(/[一-鿿]/u.test(notice)).toBe(hasCjk);
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
