import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import type { DaemonSession } from '../src/core/types.js';

const mockGetMessageChatId = vi.fn();
const mockGetChatMode = vi.fn(async () => 'topic');
const mockSendMessage = vi.fn(async () => 'om_new_topic');
vi.mock('../src/im/lark/client.js', () => ({
  getMessageChatId: (...args: any[]) => mockGetMessageChatId(...args),
  getChatMode: (...args: any[]) => mockGetChatMode(...args),
  sendMessage: (...args: any[]) => mockSendMessage(...args),
  listChatBotMembers: vi.fn(async () => []),
}));

const mockGetBot = vi.fn();
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...args: any[]) => mockGetBot(...args),
  effectiveDefaultWorkingDir: vi.fn(() => '/tmp'),
}));

const mockIsInChat = vi.fn(async () => true);
vi.mock('../src/services/groups-store.js', () => ({
  isInChat: (...args: any[]) => mockIsInChat(...args),
}));

vi.mock('../src/services/oncall-store.js', () => ({
  getOncallStatus: vi.fn(() => undefined),
}));

const mockCreateSession = vi.fn();
const mockUpdateSession = vi.fn();
vi.mock('../src/services/session-store.js', () => ({
  createSession: (...args: any[]) => mockCreateSession(...args),
  updateSession: (...args: any[]) => mockUpdateSession(...args),
}));

vi.mock('../src/services/message-queue.js', () => ({
  ensureQueue: vi.fn(),
}));

const mockForkWorker = vi.fn();
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: (...args: any[]) => mockForkWorker(...args),
  getCurrentCliVersion: vi.fn(() => 'test-cli-version'),
}));

vi.mock('../src/core/session-manager.js', () => ({
  buildFollowUpContent: vi.fn((prompt: string) => `follow:${prompt}`),
  buildNewTopicPrompt: vi.fn((prompt: string) => `new:${prompt}`),
  ensureSessionWhiteboard: vi.fn(),
  getAvailableBots: vi.fn(async () => []),
  rememberLastCliInput: vi.fn(),
}));

import { triggerSessionTurn } from '../src/core/trigger-session.js';
import { sessionKey } from '../src/core/types.js';

const APP = 'app1';
const CHAT = 'oc_root_chat';
const ROOT = 'om_root_msg';

function request(overrides: Partial<TriggerRequest['target']> = {}): TriggerRequest {
  return {
    source: { type: 'webhook', connectorId: 'conn_1', requestId: 'req_1' },
    target: { kind: 'turn', botId: APP, chatId: CHAT, rootMessageId: ROOT, ...overrides },
    envelope: { format: 'botmux.webhook.v1', sourceName: 'alerts', trusted: false, payload: { alert: 'x' } },
  };
}

function session(id: string): any {
  return { sessionId: id, chatId: CHAT, rootMessageId: ROOT, scope: 'thread', status: 'active', createdAt: '2026-06-01T00:00:00.000Z' };
}

function existingDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  const s = session('sess_existing');
  return {
    session: s,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: APP,
    chatId: CHAT,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1,
    cliVersion: 'test-cli-version',
    lastMessageAt: 1,
    hasHistory: true,
    ...overrides,
  } as DaemonSession;
}

describe('triggerSessionTurn rootMessageId target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'claude-code', workingDir: '/tmp' },
      botName: 'Bot',
      botOpenId: 'ou_bot',
    });
    mockGetMessageChatId.mockResolvedValue(CHAT);
    mockCreateSession.mockImplementation((chatId: string, rootMessageId: string, title: string, chatType: 'group' | 'p2p') => ({
      sessionId: 'sess_new',
      chatId,
      rootMessageId,
      title,
      chatType,
      status: 'active',
      createdAt: '2026-06-01T00:00:00.000Z',
    }));
  });

  it('creates a thread-scope session anchored at rootMessageId without opening a new topic', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    const res = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: true, action: 'queued', target: { sessionId: 'sess_new', chatId: CHAT } });
    expect(mockGetMessageChatId).toHaveBeenCalledWith(APP, ROOT);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalledWith(CHAT, ROOT, '[External] alerts', 'group');
    const ds = activeSessions.get(sessionKey(ROOT, APP));
    expect(ds?.scope).toBe('thread');
    expect(ds?.session.rootMessageId).toBe(ROOT);
    expect(mockForkWorker).toHaveBeenCalledWith(ds, expect.stringContaining('new:'));
  });

  it('rejects cross-chat rootMessageId without creating a session', async () => {
    mockGetMessageChatId.mockResolvedValue('oc_other_chat');
    const activeSessions = new Map<string, DaemonSession>();
    const res = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: false, errorCode: 'chat_not_allowed' });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockForkWorker).not.toHaveBeenCalled();
  });

  it('rejects invisible or withdrawn rootMessageId without creating a session', async () => {
    mockGetMessageChatId.mockResolvedValue(null);
    const activeSessions = new Map<string, DaemonSession>();
    const res = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: false, errorCode: 'target_required' });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockForkWorker).not.toHaveBeenCalled();
  });

  it('reuses an existing root session whose worker is live', async () => {
    const send = vi.fn();
    const ds = existingDs({ worker: { killed: false, send } as any });
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);
    const res = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: true, action: 'delivered', target: { sessionId: 'sess_existing', chatId: CHAT } });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockForkWorker).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ type: 'message', content: expect.stringContaining('follow:') });
  });

  it('reuses an existing root session whose worker is not running', async () => {
    const ds = existingDs();
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);
    const res = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: true, action: 'queued', target: { sessionId: 'sess_existing', chatId: CHAT } });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockForkWorker).toHaveBeenCalledWith(ds, expect.stringContaining('follow:'), { resume: true, turnId: expect.stringMatching(/^trg_/) });
  });

  it('reuses an existing root session with asyncReturnSessionId when worker is not running', async () => {
    const ds = existingDs();
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);
    const req = request();
    req.options = { asyncReturnSessionId: true };
    const res = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: true, action: 'queued', async: { status: 'pending', sessionId: 'sess_existing' } });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockForkWorker).toHaveBeenCalledWith(ds, expect.stringContaining('follow:'), { resume: true, turnId: expect.stringMatching(/^trg_/) });
    expect(ds.latestAsyncTriggerId).toMatch(/^trg_/);
  });

  it('reuses an existing root session with waitForFinalOutput when worker is not running', async () => {
    const ds = existingDs();
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);
    const req = request();
    req.options = { waitForFinalOutput: true, timeoutMs: 1000 };
    const promise = triggerSessionTurn(req, { larkAppId: APP, activeSessions });
    await vi.waitFor(() => expect(ds.pendingWaitPromises?.size).toBe(1));
    const [turnId, waiter] = [...ds.pendingWaitPromises!.entries()][0]!;
    expect(mockForkWorker).toHaveBeenCalledWith(ds, expect.stringContaining('follow:'), { resume: true, turnId });
    waiter.resolve('done');
    await expect(promise).resolves.toMatchObject({ ok: true, action: 'completed', output: { content: 'done' } });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('requires chatId when rootMessageId is specified', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    const res = await triggerSessionTurn(request({ chatId: undefined }), { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: false, errorCode: 'target_required' });
    expect(mockGetMessageChatId).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });
});
