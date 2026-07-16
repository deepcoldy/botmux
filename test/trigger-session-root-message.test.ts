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
  sendWorkerInput: (ds: any, payload: any, turnId?: string, opts: any = {}) => {
    if (!ds.worker || ds.worker.killed) return false;
    ds.worker.send({
      type: 'message',
      content: typeof payload === 'string' ? payload : payload.content,
      ...(typeof payload === 'object' && payload.codexAppInput
        ? { codexAppInput: payload.codexAppInput }
        : {}),
      ...(turnId ? { turnId } : {}),
      ...(opts.dispatchAttempt !== undefined
        ? { dispatchAttempt: opts.dispatchAttempt }
        : {}),
    });
    return true;
  },
  getCurrentCliVersion: vi.fn(() => 'test-cli-version'),
}));

const mockRememberLastCliInput = vi.fn();
const mockBuildFollowUpCliInput = vi.fn((prompt: string, _sessionId?: string, opts?: any) => ({
  content: `follow:${prompt}`,
  codexAppInput: opts?.cliId === 'codex-app' && opts?.codexAppText ? { text: opts.codexAppText } : undefined,
}));
const mockBuildNewTopicCliInput = vi.fn((prompt: string, ...args: any[]) => ({
  content: `new:${prompt}`,
  codexAppInput: args[1] === 'codex-app' && args[10]?.codexAppText ? { text: args[10].codexAppText } : undefined,
}));
vi.mock('../src/core/session-manager.js', () => ({
  buildFollowUpContent: vi.fn((prompt: string) => `follow:${prompt}`),
  buildFollowUpCliInput: (...args: any[]) => mockBuildFollowUpCliInput(...args),
  buildNewTopicPrompt: vi.fn((prompt: string) => `new:${prompt}`),
  buildNewTopicCliInput: (...args: any[]) => mockBuildNewTopicCliInput(...args),
  ensureSessionWhiteboard: vi.fn(),
  getAvailableBots: vi.fn(async () => []),
  rememberLastCliInput: (...args: any[]) => mockRememberLastCliInput(...args),
}));

const mockBotAutoWorktreeEnabled = vi.fn(() => false);
vi.mock('../src/services/default-worktree.js', () => ({
  botAutoWorktreeEnabled: (...args: any[]) => mockBotAutoWorktreeEnabled(...args),
}));

const mockRunAutoWorktreeCommit = vi.fn(async () => {});
vi.mock('../src/im/lark/card-handler.js', () => ({
  runAutoWorktreeCommit: (...args: any[]) => mockRunAutoWorktreeCommit(...args),
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
    mockBotAutoWorktreeEnabled.mockReturnValue(false);
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
    expect(mockForkWorker).toHaveBeenCalledWith(ds, { content: expect.stringContaining('new:') });
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

  it('uses an internal stable turn id without changing the public trigger schema', async () => {
    const send = vi.fn();
    const ds = existingDs({ worker: { killed: false, send } as any, workerGeneration: 7 });
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);
    const beforeDispatch = vi.fn(() => ({ dispatchAttempt: 2 }));
    const res = await triggerSessionTurn(
      request(),
      { larkAppId: APP, activeSessions },
      { stableTurnId: 'vcd_stable_delivery_key', beforeDispatch, suppressFinalOutput: true },
    );

    expect(res).toMatchObject({ ok: true, triggerId: 'vcd_stable_delivery_key', action: 'delivered' });
    expect(beforeDispatch).toHaveBeenCalledWith({ sessionId: ds.session.sessionId, workerGeneration: 7 });
    expect(beforeDispatch.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(ds.suppressedFinalOutputTurns?.has('vcd_stable_delivery_key')).toBe(true);
    expect(send).toHaveBeenCalledWith({
      type: 'message',
      content: expect.stringContaining('vcd_stable_delivery_key'),
      turnId: 'vcd_stable_delivery_key',
      dispatchAttempt: 2,
    });
  });

  it('keeps clean input and a stable durable attempt on the same live IPC', async () => {
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'codex-app', codexAppCleanInput: true, workingDir: '/tmp' },
      botName: 'Bot',
      botOpenId: 'ou_bot',
    });
    const send = vi.fn();
    const ds = existingDs({ worker: { killed: false, send } as any, workerGeneration: 8 });
    const beforeDispatch = vi.fn(() => ({ dispatchAttempt: 3 }));

    await triggerSessionTurn(
      request(),
      { larkAppId: APP, activeSessions: new Map([[sessionKey(ROOT, APP), ds]]) },
      { stableTurnId: 'vcd_clean_delivery', beforeDispatch },
    );

    expect(beforeDispatch.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(send).toHaveBeenCalledWith({
      type: 'message',
      content: expect.stringContaining('follow:'),
      codexAppInput: { text: '外部事件触发' },
      turnId: 'vcd_clean_delivery',
      dispatchAttempt: 3,
    });
  });

  it('does not persist durable delivery input as the user resume prompt', async () => {
    const send = vi.fn();
    const ds = existingDs({ worker: { killed: false, send } as any, workerGeneration: 7 });
    ds.session.lastUserPrompt = 'previous user prompt';
    ds.session.lastCliInput = 'previous rendered input';
    ds.session.lastCodexAppInput = { text: 'previous clean input' };
    ds.lastCodexAppInput = { text: 'previous live clean input' };
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);

    const res = await triggerSessionTurn(
      request(),
      { larkAppId: APP, activeSessions },
      {
        stableTurnId: 'vcd_delivery_without_resume_history',
        beforeDispatch: () => ({ dispatchAttempt: 1 }),
        persistInputHistory: false,
      },
    );

    expect(res).toMatchObject({ ok: true, action: 'delivered' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(mockRememberLastCliInput).not.toHaveBeenCalled();
    expect(ds.session.lastUserPrompt).toBe('previous user prompt');
    expect(ds.session.lastCliInput).toBe('previous rendered input');
    expect(ds.session.lastCodexAppInput).toEqual({ text: 'previous clean input' });
    expect(ds.lastCodexAppInput).toEqual({ text: 'previous live clean input' });
  });

  it('keeps external-event wrappers hidden on a live clean Codex App turn', async () => {
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'codex-app', codexAppCleanInput: true, workingDir: '/tmp' },
      botName: 'Bot',
      botOpenId: 'ou_bot',
    });
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const req = request();
    req.instruction = 'Summarize the alert for the operator.';

    await triggerSessionTurn(req, {
      larkAppId: APP,
      activeSessions: new Map([[sessionKey(ROOT, APP), ds]]),
    });

    const opts = mockBuildFollowUpCliInput.mock.calls.at(-1)?.[2];
    expect(opts.codexAppText).toBe('外部事件触发');
    expect(opts.codexAppApplicationContext).toContain('Summarize the alert for the operator.');
    expect(opts.codexAppMessageContext).toContain('<botmux_external_event trusted="false">');
    expect(opts.codexAppMessageContext).toContain('"alert": "x"');
    expect(opts.codexAppMessageContext).not.toContain('Summarize the alert for the operator.');
  });

  it('reuses an existing root session whose worker is not running', async () => {
    const ds = existingDs();
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);
    const res = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: true, action: 'queued', target: { sessionId: 'sess_existing', chatId: CHAT } });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockForkWorker).toHaveBeenCalledWith(ds, { content: expect.stringContaining('follow:') }, { resume: true, turnId: expect.stringMatching(/^trg_/) });
  });

  it('preserves the clean split when an external event reforks a stopped Codex App session', async () => {
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'codex-app', codexAppCleanInput: true, workingDir: '/tmp' },
      botName: 'Bot',
      botOpenId: 'ou_bot',
    });
    const ds = existingDs();

    await triggerSessionTurn(request(), {
      larkAppId: APP,
      activeSessions: new Map([[sessionKey(ROOT, APP), ds]]),
    });

    const opts = mockBuildFollowUpCliInput.mock.calls.at(-1)?.[2];
    expect(opts.codexAppText).toBe('外部事件触发');
    expect(opts.codexAppMessageContext).toContain('External event received.');
    expect(mockForkWorker).toHaveBeenCalledWith(
      ds,
      expect.objectContaining({ codexAppInput: { text: '外部事件触发' } }),
      expect.objectContaining({ resume: true }),
    );
  });

  it('retains the clean first turn through external-event auto-worktree staging', async () => {
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'codex-app', codexAppCleanInput: true, workingDir: '/tmp' },
      botName: 'Bot',
      botOpenId: 'ou_bot',
    });
    mockBotAutoWorktreeEnabled.mockReturnValue(true);
    const req = request();
    req.instruction = 'Inspect the alert.';
    const activeSessions = new Map<string, DaemonSession>();

    await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    const ds = activeSessions.get(sessionKey(ROOT, APP));
    expect(ds?.pendingRepo).toBe(true);
    expect(ds?.pendingCodexAppText).toBe('外部事件触发');
    expect(ds?.pendingCodexAppApplicationContext).toContain('Inspect the alert.');
    expect(ds?.pendingCodexAppMessageContext).toContain('<botmux_external_event trusted="false">');
    expect(ds?.pendingCodexAppMessageContext).not.toContain('Inspect the alert.');
    expect(mockRunAutoWorktreeCommit).toHaveBeenCalledWith(expect.objectContaining({ ds }));
  });

  it('passes the clean split into a new Codex App session without worktree staging', async () => {
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'codex-app', codexAppCleanInput: true, workingDir: '/tmp' },
      botName: 'Bot',
      botOpenId: 'ou_bot',
    });
    const activeSessions = new Map<string, DaemonSession>();

    await triggerSessionTurn(request(), { larkAppId: APP, activeSessions });

    const opts = mockBuildNewTopicCliInput.mock.calls.at(-1)?.[11];
    expect(opts.codexAppText).toBe('外部事件触发');
    expect(opts.codexAppMessageContext).toContain('"alert": "x"');
    expect(mockForkWorker).toHaveBeenCalledWith(
      activeSessions.get(sessionKey(ROOT, APP)),
      expect.objectContaining({ codexAppInput: { text: '外部事件触发' } }),
    );
  });

  it('reforks an explicitly targeted dormant chat-scope session with the stable turn id', async () => {
    const ds = existingDs({ scope: 'chat', workerGeneration: 3 });
    ds.session.rootMessageId = CHAT;
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(CHAT, APP), ds]]);
    const req = request({ sessionId: ds.session.sessionId, rootMessageId: undefined });
    const beforeDispatch = vi.fn(() => ({ dispatchAttempt: 5 }));
    const res = await triggerSessionTurn(
      req,
      { larkAppId: APP, activeSessions },
      { stableTurnId: 'vcd_dormant_session_delivery', beforeDispatch },
    );

    expect(res).toMatchObject({ ok: true, triggerId: 'vcd_dormant_session_delivery', action: 'queued' });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(beforeDispatch).toHaveBeenCalledWith({ sessionId: ds.session.sessionId, workerGeneration: 4 });
    expect(beforeDispatch.mock.invocationCallOrder[0]).toBeLessThan(mockForkWorker.mock.invocationCallOrder[0]!);
    expect(mockForkWorker).toHaveBeenCalledWith(
      ds,
      expect.objectContaining({ content: expect.stringContaining('follow:') }),
      { resume: true, turnId: 'vcd_dormant_session_delivery', dispatchAttempt: 5 },
    );
  });

  it('keeps clean input and a stable durable attempt on the same dormant fork', async () => {
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'codex-app', codexAppCleanInput: true, workingDir: '/tmp' },
      botName: 'Bot',
      botOpenId: 'ou_bot',
    });
    const ds = existingDs({ scope: 'chat', workerGeneration: 4 });
    ds.session.rootMessageId = CHAT;
    const req = request({ sessionId: ds.session.sessionId, rootMessageId: undefined });
    const beforeDispatch = vi.fn(() => ({ dispatchAttempt: 6 }));

    await triggerSessionTurn(
      req,
      { larkAppId: APP, activeSessions: new Map([[sessionKey(CHAT, APP), ds]]) },
      { stableTurnId: 'vcd_clean_dormant_delivery', beforeDispatch },
    );

    expect(beforeDispatch.mock.invocationCallOrder[0])
      .toBeLessThan(mockForkWorker.mock.invocationCallOrder[0]!);
    expect(mockForkWorker).toHaveBeenCalledWith(
      ds,
      expect.objectContaining({
        content: expect.stringContaining('follow:'),
        codexAppInput: { text: '外部事件触发' },
      }),
      { resume: true, turnId: 'vcd_clean_dormant_delivery', dispatchAttempt: 6 },
    );
  });

  it('reuses an existing root session with asyncReturnSessionId when worker is not running', async () => {
    const ds = existingDs();
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);
    const req = request();
    req.options = { asyncReturnSessionId: true };
    const res = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: true, action: 'queued', async: { status: 'pending', sessionId: 'sess_existing' } });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockForkWorker).toHaveBeenCalledWith(ds, { content: expect.stringContaining('follow:') }, { resume: true, turnId: expect.stringMatching(/^trg_/) });
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
    expect(mockForkWorker).toHaveBeenCalledWith(ds, { content: expect.stringContaining('follow:') }, { resume: true, turnId });
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
