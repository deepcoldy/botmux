// Must stay the first import: this file writes async-trigger records under
// SESSION_DATA_DIR, so refuse to run outside the data-dir fence instead of
// touching live botmux data (see the helper).
import './helpers/require-fenced-data-dir.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTriggerRequest, type TriggerRequest } from '../src/services/trigger-types.js';
import type { DaemonSession } from '../src/core/types.js';
import { isExternalTriggerTurn, resolveTurnOrigin } from '../src/core/turn-origin.js';

const mockGetMessageChatId = vi.fn();
const mockGetChatMode = vi.fn(async () => 'topic');
const mockSendMessage = vi.fn(async () => 'om_new_topic');
const mockReplyMessage = vi.fn(async () => 'om_reply');
const mockDeleteMessage = vi.fn(async () => true);
vi.mock('../src/im/lark/client.js', () => ({
  getMessageChatId: (...args: any[]) => mockGetMessageChatId(...args),
  getChatMode: (...args: any[]) => mockGetChatMode(...args),
  sendMessage: (...args: any[]) => mockSendMessage(...args),
  replyMessage: (...args: any[]) => mockReplyMessage(...args),
  deleteMessage: (...args: any[]) => mockDeleteMessage(...args),
  listChatBotMembers: vi.fn(async () => []),
}));

const mockGetBot = vi.fn();
vi.mock('../src/bot-registry.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return { ...actual,
    getBot: (id: string) => mockGetBot(id) ?? actual.getBot(id),
    effectiveDefaultWorkingDir: vi.fn(() => '/tmp'),
  };
});

const mockIsInChat = vi.fn(async () => true);
vi.mock('../src/services/groups-store.js', () => ({
  isInChat: (...args: any[]) => mockIsInChat(...args),
}));

vi.mock('../src/services/oncall-store.js', () => ({
  getOncallStatus: vi.fn(() => undefined),
}));

const mockCreateSession = vi.fn();
const mockUpdateSession = vi.fn();
const mockCloseSession = vi.fn();
const assistant = vi.hoisted(() => ({ spawn: { kind: 'off' } as any }));
vi.mock('../src/core/assistant-spawn.js', () => ({ resolveAssistantSpawn: () => assistant.spawn, assistantMultiUserGroupsOff: () => false }));
vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  createSession: (...args: any[]) => mockCreateSession(...args),
  updateSession: (...args: any[]) => mockUpdateSession(...args),
  closeSession: (...args: any[]) => mockCloseSession(...args),
  getSession: vi.fn(() => undefined),
}));

vi.mock('../src/services/message-queue.js', () => ({
  ensureQueue: vi.fn(),
}));

const mockForkWorker = vi.fn();
const mockQueuedTailAdmission = vi.fn();
const activeKeyLocks = vi.hoisted(() => ({
  byMap: new WeakMap<Map<string, any>, Map<string, Promise<void>>>(),
}));
/** Routing keys the registration gate treats as reserved by a quarantined
 *  session (the real gate consults findQuarantinedRoutingConflict). */
const routeQuarantine = vi.hoisted(() => ({ keys: new Set<string>() }));
vi.mock('../src/core/worker-pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/worker-pool.js')>();
  return {
  forkWorker: (...args: any[]) => mockForkWorker(...args),
  sendWorkerInput: (ds: any, payload: any, turnId?: string, opts: any = {}) => {
    if (!ds.worker || ds.worker.killed) return false;
    if (actual.hasQueuedActivationAdmissionGate(ds)) return mockQueuedTailAdmission(ds, payload, turnId, opts);
    ds.worker.send({
      type: 'message',
      content: typeof payload === 'string' ? payload : payload.content,
      ...(typeof payload === 'object' && payload.codexAppInput
        ? { codexAppInput: payload.codexAppInput }
        : {}),
      ...(turnId ? { turnId } : {}),
      ...(payload.trustedCaller ? { trustedCaller: payload.trustedCaller } : {}),
      ...(turnId && ds.session.replyTargets?.[turnId]?.senderOpenId
        ? { turnCallerOpenId: ds.session.replyTargets[turnId].senderOpenId } : {}),
      ...(opts.codexAppSteerable ? { codexAppSteerable: true } : {}),
      ...(opts.queueAfterActiveTurn ? { queueAfterActiveTurn: true } : {}),
      ...(opts.dispatchAttempt !== undefined
        ? { dispatchAttempt: opts.dispatchAttempt }
        : {}),
    });
    return true;
  },
  hasQueuedActivationAdmissionGate: actual.hasQueuedActivationAdmissionGate,
  admitQueuedActivationTail: actual.admitQueuedActivationTail,
  __testOnly_sessionAgentConfig: actual.__testOnly_sessionAgentConfig,
  getCurrentCliVersion: vi.fn(() => 'test-cli-version'),
  withActiveSessionKeyLock: vi.fn(async (map: Map<string, any>, key: string, action: () => any) => {
    let locks = activeKeyLocks.byMap.get(map);
    if (!locks) {
      locks = new Map();
      activeKeyLocks.byMap.set(map, locks);
    }
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => hold);
    locks.set(key, tail);
    await previous.catch(() => {});
    try { return await action(); }
    finally {
      release();
      if (locks.get(key) === tail) locks.delete(key);
    }
  }),
  setActiveSessionIfActive: (map: Map<string, any>, key: string, ds: any) => {
    if (routeQuarantine.keys.has(key)) return false;
    if (map.has(key) && map.get(key) !== ds) return false;
    map.set(key, ds);
    return true;
  },
  closeSession: vi.fn(async () => ({ ok: true, outcome: 'closed', alreadyClosed: false, known: true })),
  getDaemonBootId: () => 'test-boot-id',
  };
});

const mockRememberLastCliInput = vi.fn();
const mockGetAvailableBots = vi.fn(async () => []);
const mockBuildFollowUpCliInput = vi.fn((prompt: string, _sessionId?: string, opts?: any) => ({
  content: `follow:${prompt}`,
  codexAppInput: opts?.cliId === 'codex-app' && opts?.codexAppText ? { text: opts.codexAppText } : undefined,
}));
const mockBuildNewTopicCliInput = vi.fn((prompt: string, ...args: any[]) => ({
  content: `new:${prompt}`,
  codexAppInput: args[1] === 'codex-app' && args[10]?.codexAppText ? { text: args[10].codexAppText } : undefined,
}));
vi.mock('../src/core/session-manager.js', async importOriginal => ({
  buildFollowUpContent: vi.fn((prompt: string) => `follow:${prompt}`),
  buildFollowUpCliInput: ownerAwareFollowUpBuilder(await importOriginal<typeof import('../src/core/session-manager.js')>()),
  buildNewTopicPrompt: vi.fn((prompt: string) => `new:${prompt}`),
  buildNewTopicCliInput: (...args: any[]) => mockBuildNewTopicCliInput(...args),
  ensureSessionWhiteboard: vi.fn(),
  getAvailableBots: (...args: any[]) => mockGetAvailableBots(...args),
  rememberLastCliInput: (...args: any[]) => mockRememberLastCliInput(...args),
}));

function ownerAwareFollowUpBuilder(actual: typeof import('../src/core/session-manager.js')) {
  return (...args: Parameters<typeof actual.buildFollowUpCliInput>) => args[2]?.trustedCaller?.requestUserOpenId
    ? actual.buildFollowUpCliInput(...args)
    : mockBuildFollowUpCliInput(...args);
}

const mockBotAutoWorktreeEnabled = vi.fn(() => false);
vi.mock('../src/services/default-worktree.js', () => ({
  botAutoWorktreeEnabled: (...args: any[]) => mockBotAutoWorktreeEnabled(...args),
}));

const mockRunAutoWorktreeCommit = vi.fn(async () => {});
vi.mock('../src/im/lark/card-handler.js', () => ({
  runAutoWorktreeCommit: (...args: any[]) => mockRunAutoWorktreeCommit(...args),
}));

import { buildExternalEventTopicMessage, triggerSessionTurn } from '../src/core/trigger-session.js';
import { parseBotConfigsFromText, registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { sessionKey } from '../src/core/types.js';
import { admitQueuedActivationTail, withActiveSessionKeyLock, __testOnly_sessionAgentConfig } from '../src/core/worker-pool.js';
import { frozenReplyContextForTurn, resolveSessionReplyTarget } from '../src/core/reply-target.js';
import { hasPendingTriggerStreamingCard } from '../src/core/trigger-streaming-card.js';
import { isTriggerFinalSuppressed } from '../src/core/trigger-final-suppression.js';
import { authorizeReportSessionRelayRequest } from '../src/core/report-session-relay.js';
import { createDispatchReportBinding } from '../src/core/dispatch-report-binding.js';
import { resolveSender } from '../src/im/lark/identity-cache.js';
import { config } from '../src/config.js';
import { readSessionTurns, recordSessionTurnInput } from '../src/services/session-turns.js';
import { mergeQueuedCliInput, type PendingCliInput } from '../src/utils/pending-input-queue.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';

vi.mock('../src/im/lark/identity-cache.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/im/lark/identity-cache.js')>(),
  resolveSender: vi.fn(),
}));

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
    __testOnly_resetBotRegistry();
    routeQuarantine.keys.clear();
    mockGetChatMode.mockReset().mockResolvedValue('topic');
    mockSendMessage.mockReset().mockResolvedValue('om_new_topic');
    mockReplyMessage.mockReset().mockResolvedValue('om_reply');
    mockDeleteMessage.mockReset().mockResolvedValue(true);
    mockUpdateSession.mockReset();
    mockBotAutoWorktreeEnabled.mockReturnValue(false);
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'claude-code', workingDir: '/tmp' },
      botName: 'Bot',
      botOpenId: 'ou_bot',
    });
    mockGetMessageChatId.mockResolvedValue(CHAT);
    mockQueuedTailAdmission.mockImplementation((ds: any, payload: any, turnId?: string, opts: any = {}) => {
      admitQueuedActivationTail(ds, {
        userPrompt: typeof payload === 'string' ? payload : payload.content,
        cliInput: typeof payload === 'string' ? { content: payload } : payload,
        turnId: turnId ?? `tail-turn-${(ds.session.queuedActivationTail?.length ?? 0) + 1}`,
        ...(opts.dispatchAttempt !== undefined
          ? { dispatchAttempt: opts.dispatchAttempt }
          : {}),
      });
      return true;
    });
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

  function ownerRequest(): TriggerRequest {
    return {
      actor: 'owner',
      source: { type: 'webhook', connectorId: 'fixture-connector' },
      target: { kind: 'turn', botId: APP, sessionId: 'sess_existing' },
      instruction: 'Continue testing',
      envelope: { format: 'text', sourceName: 'Example client', trusted: false },
    };
  }

  it.each([undefined, 'ou_removed'])('refuses to fall back to the first allowed user for configured owner %s', async ownerOpenId => {
    registerBot(parseBotConfigsFromText(JSON.stringify([{
      larkAppId: APP, larkAppSecret: 'fixture', cliId: 'codex', allowedUsers: ['ou_other'], ownerOpenId,
    }]))[0]!);
    const ds = existingDs();
    const result = await triggerSessionTurn(ownerRequest(), {
      larkAppId: APP, activeSessions: new Map([[sessionKey(ROOT, APP), ds]]),
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'owner_unresolved' });
    expect(mockForkWorker).not.toHaveBeenCalled();
  });

  it('rejects the owner if allowlist access is revoked during contact resolution', async () => {
    const owner = 'ou_fixture_owner';
    const bot = registerBot(parseBotConfigsFromText(JSON.stringify([{
      larkAppId: APP, larkAppSecret: 'fixture', cliId: 'codex',
      allowedUsers: [owner], ownerOpenId: owner,
    }]))[0]!);
    vi.mocked(resolveSender).mockImplementationOnce(async () => {
      await Promise.resolve();
      bot.resolvedAllowedUsers = ['ou_other'];
      return { openId: owner, type: 'user' };
    });
    const send = vi.fn();
    const ds = existingDs({ worker: { send } as any });
    const response = await triggerSessionTurn(ownerRequest(), {
      larkAppId: APP, activeSessions: new Map([[sessionKey(ROOT, APP), ds]]),
    });
    expect(response).toMatchObject({ ok: false, errorCode: 'owner_unresolved' });
    expect(send).not.toHaveBeenCalled();
    expect(ds.session.replyTargets).toBeUndefined();
  });

  it.each([
    ['claude-code', 'thread', true],
    ['codex', 'chat', false],
    ['codex-app', 'thread', true],
  ] as const)('uses the %s continuation for a %s session (senderTag=%s)', async (cliId, scope, senderTag) => {
    const bot = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: APP, larkAppSecret: 'fixture', workingDir: '/tmp', cliId, senderTag,
      allowedUsers: ['ou_other', 'ou_fixture_owner'], ownerOpenId: 'ou_fixture_owner',
    }]))[0]!;
    registerBot(bot);
    mockGetBot.mockReturnValue(undefined);
    vi.mocked(resolveSender).mockRejectedValueOnce(new Error('contact unavailable'));
    const send = vi.fn();
    const ds = existingDs({ worker: { send } as any, scope });
    const request = ownerRequest();
    request.target.chatId = 'oc_unrelated';
    request.target.rootMessageId = 'om_unrelated';
    request.options = { steer: true };
    const result = await triggerSessionTurn(request, {
      larkAppId: APP, activeSessions: new Map([[sessionKey(scope === 'thread' ? ROOT : CHAT, APP), ds]]),
    });
    expect(result).toMatchObject({ ok: true, actor: 'owner', steer: true, target: { chatId: CHAT } });
    const turn = send.mock.calls[0]![0] as PendingCliInput;
    expect(turn.turnCallerOpenId).toBe('ou_fixture_owner');
    expect(resolveSender).toHaveBeenCalledWith(APP, 'ou_fixture_owner', 'user');
    const location = scope === 'thread'
      ? `<message_location placement="thread" root_message_id="${ROOT}" />`
      : '<message_location placement="chat" />';
    expect(turn.content).toContain(location);
    expect(turn.content.includes('<sender type="user" open_id="ou_fixture_owner" />')).toBe(senderTag);
    expect(turn.content).not.toMatch(/<botmux_(task|external_event)>|om_unrelated/);
    expect(resolveSessionReplyTarget(ds, result.triggerId)).toEqual(scope === 'thread'
      ? { mode: 'thread', rootMessageId: ROOT } : { mode: 'plain', chatId: CHAT });
    if (cliId === 'codex-app') {
      expect(turn.codexAppSteerable).toBe(true);
      expect(turn.codexAppInput?.text).toBe(request.instruction);
      expect(JSON.stringify(turn.codexAppInput)).toContain('message_location');
    }
    if (cliId === 'claude-code') {
      const ownerLarkInput: PendingCliInput = {
        content: 'From chat', turnId: 'om_fixture_owner', trustedCaller: turn.trustedCaller,
        turnCallerOpenId: turn.turnCallerOpenId,
      };
      const queue = [ownerLarkInput];
      expect(mergeQueuedCliInput(queue, turn)).toBe(true);
      expect(queue[0]?.structuredSourceTurnIds).toEqual(['om_fixture_owner', result.triggerId]);
      expect(queue[0]?.turnCallerOpenId).toBe('ou_fixture_owner');
      const reverseQueue = [{ ...turn }];
      expect(mergeQueuedCliInput(reverseQueue, {
        ...ownerLarkInput, turnId: 'om_fixture_later', structuredSourceTurnIds: undefined,
      })).toBe(true);
      expect(reverseQueue[0]?.turnId).toBe(turn.turnId);
      expect(reverseQueue[0]?.structuredSourceTurnIds).toEqual([turn.turnId, 'om_fixture_later']);
      recordSessionTurnInput({
        dataDir: config.session.dataDir, sessionId: ds.session.sessionId, turnId: turn.turnId!,
        sourceTurnIds: queue[0]?.structuredSourceTurnIds, input: queue[0]!.content, cliId,
      });
      expect(readSessionTurns(config.session.dataDir, ds.session.sessionId, 0, 100).turns
        .find(entry => entry.turnId === turn.turnId)?.inbound).toEqual([{
        messageId: turn.turnId, text: request.instruction, via: 'owner_actor',
        sender: { type: 'user', openId: 'ou_fixture_owner' },
        placement: { kind: 'thread', rootMessageId: ROOT },
      }]);
    }
    const authority = new ActiveTurnAuthority();
    const chat = { turnId: 'om_fixture_human', caller: {
      senderType: 'user' as const, requestUserOpenId: 'ou_fixture_human', requestLarkAppId: APP,
    } };
    expect(authority.reserve(chat)).toBe(true);
    authority.markStarted(chat);
    expect(authority.adoptEnvelopePreservingPrincipal({ turnId: turn.turnId, caller: turn.trustedCaller })).toBe(true);
    expect(authority.speakers()).toEqual([
      { openId: 'ou_fixture_human', turnId: chat.turnId }, { openId: 'ou_fixture_owner', turnId: turn.turnId },
    ]);
    expect(authority.identity().caller).toEqual(chat.caller);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('zero injection forwards caller instruction and event data without the generated external envelope', async () => {
    mockGetBot.mockReturnValue({ config: { larkAppId: APP, cliId: 'codex', promptInjection: 'none', workingDir: '/tmp' } });
    const req = request();
    req.instruction = '检查这个错误';
    req.envelope.rawText = '原始日志 <user_message>';
    await triggerSessionTurn(req, { larkAppId: APP, activeSessions: new Map() });
    expect(mockBuildNewTopicCliInput.mock.calls.at(-1)?.[0]).toBe('检查这个错误\n\n原始日志 <user_message>');
  });

  // 11-16: a connector's bare "继续" (no rawText, no payload) reached the CLI as
  // "继续\n\n{}" — the missing payload was rendered as an empty object.
  it.each([
    ['absent', undefined],
    ['an empty object', {}],
    ['null', null],
  ])('zero injection sends the instruction alone when the payload is %s', async (_label, payload) => {
    mockGetBot.mockReturnValue({ config: { larkAppId: APP, cliId: 'codex', promptInjection: 'none', workingDir: '/tmp' } });
    const req = request();
    req.instruction = '继续';
    if (payload === undefined) delete req.envelope.payload;
    else req.envelope.payload = payload;
    await triggerSessionTurn(req, { larkAppId: APP, activeSessions: new Map() });
    expect(mockBuildNewTopicCliInput.mock.calls.at(-1)?.[0]).toBe('继续');
  });

  it('zero injection with neither instruction nor data still sends a non-empty input', async () => {
    mockGetBot.mockReturnValue({ config: { larkAppId: APP, cliId: 'codex', promptInjection: 'none', workingDir: '/tmp' } });
    const req = request();
    delete req.envelope.payload;
    await triggerSessionTurn(req, { larkAppId: APP, activeSessions: new Map() });
    expect(mockBuildNewTopicCliInput.mock.calls.at(-1)?.[0]).toBe('{}');
  });

  it('zero injection keeps a non-empty payload after the instruction', async () => {
    mockGetBot.mockReturnValue({ config: { larkAppId: APP, cliId: 'codex', promptInjection: 'none', workingDir: '/tmp' } });
    const req = request();
    req.instruction = '继续';
    await triggerSessionTurn(req, { larkAppId: APP, activeSessions: new Map() });
    expect(mockBuildNewTopicCliInput.mock.calls.at(-1)?.[0]).toBe('继续\n\n{"alert":"x"}');
  });

  it('creates a thread-scope session anchored at rootMessageId without opening a new topic', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    const res = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: true, action: 'queued', target: { sessionId: 'sess_new', chatId: CHAT } });
    expect(mockGetMessageChatId).toHaveBeenCalledWith(APP, ROOT);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalledWith(CHAT, ROOT, '[External] alerts', 'group', undefined, { source: 'http' });
    const ds = activeSessions.get(sessionKey(ROOT, APP));
    expect(ds?.scope).toBe('thread');
    expect(ds?.session.rootMessageId).toBe(ROOT);
    expect(mockForkWorker).toHaveBeenCalledWith(ds, { content: expect.stringContaining('new:') }, mockRememberLastCliInput.mock.calls.at(-1)?.[3]);
    expect(mockRememberLastCliInput.mock.calls.at(-1)?.[3]).toEqual(expect.any(String));
  });

  it('assistant mode: the trigger session belongs to the chat owner in the owner work dir; an unclaimed chat is refused', async () => {
    try {
      assistant.spawn = { kind: 'owner', openId: 'ou_owner_a', workDir: '/home/u/ou_owner_a/work' };
      const activeSessions = new Map<string, DaemonSession>();
      const res = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions });
      expect(res).toMatchObject({ ok: true });
      const ds = activeSessions.get(sessionKey(ROOT, APP));
      expect(ds?.session.assistantOwnerOpenId).toBe('ou_owner_a');
      expect(ds?.session.workingDir).toBe('/home/u/ou_owner_a/work');

      mockForkWorker.mockClear();
      assistant.spawn = { kind: 'unclaimed' };
      const empty = new Map<string, DaemonSession>();
      const refused = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions: empty });
      expect(refused).toMatchObject({ ok: false });
      expect(empty.size).toBe(0);
      expect(mockForkWorker).not.toHaveBeenCalled();
    } finally {
      assistant.spawn = { kind: 'off' };
    }
  });

  it('runs a new session in options.workingDir instead of the bot default and never auto-worktrees it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trigger-workdir-'));
    try {
      mockBotAutoWorktreeEnabled.mockReturnValue(true);
      const req = request();
      req.options = { workingDir: dir };
      const activeSessions = new Map<string, DaemonSession>();
      const res = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });
      expect(res).toMatchObject({ ok: true });
      const ds = activeSessions.get(sessionKey(ROOT, APP));
      expect(ds?.session.workingDir).toBe(dir);
      expect(ds?.pendingRepo).toBeFalsy();
      expect(mockRunAutoWorktreeCommit).not.toHaveBeenCalled();
      expect(mockForkWorker).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a missing options.workingDir as a bad request without creating a session', async () => {
    const req = request();
    req.options = { workingDir: join(tmpdir(), 'trigger-workdir-missing-dir') };
    const activeSessions = new Map<string, DaemonSession>();
    const res = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });
    expect(res).toMatchObject({ ok: false, errorCode: 'bad_request' });
    expect(activeSessions.size).toBe(0);
    expect(mockForkWorker).not.toHaveBeenCalled();
  });

  it('assistant mode refuses options.workingDir instead of silently running in the owner work dir', async () => {
    try {
      assistant.spawn = { kind: 'owner', openId: 'ou_owner_a', workDir: '/home/u/ou_owner_a/work' };
      const req = request();
      req.options = { workingDir: tmpdir() };
      const activeSessions = new Map<string, DaemonSession>();
      const res = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });
      expect(res).toMatchObject({ ok: false, errorCode: 'bad_request' });
      expect(activeSessions.size).toBe(0);
      expect(mockForkWorker).not.toHaveBeenCalled();
    } finally {
      assistant.spawn = { kind: 'off' };
    }
  });

  describe('runAs', () => {
    const PERSON = 'ou_runas_person';
    const admit = vi.fn(async (_chatId: string, _runAs: string): Promise<any> => ({ ok: true, openId: PERSON, unionId: 'on_runas_person' }));

    function runAsRequest(target: Partial<TriggerRequest['target']> = {}, options: TriggerRequest['options'] = {}): TriggerRequest {
      return {
        runAs: 'person@example.com',
        source: { type: 'webhook', connectorId: 'platform' },
        target: { kind: 'turn', botId: APP, chatId: CHAT, ...target },
        instruction: 'Check the build',
        envelope: { format: 'text', sourceName: 'platform', trusted: false },
        presentation: { topicMessage: 'Build check', title: 'Build' },
        options,
      };
    }
    const deps = (activeSessions: Map<string, DaemonSession>) => ({ larkAppId: APP, activeSessions, resolveRunAs: admit });

    beforeEach(() => {
      admit.mockClear();
      admit.mockResolvedValue({ ok: true, openId: PERSON, unionId: 'on_runas_person' });
      vi.mocked(resolveSender).mockResolvedValue({ openId: PERSON, type: 'user', name: 'Runner' } as any);
    });

    it('opens a new topic whose first turn belongs to the named person, in the requested directory', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'trigger-runas-'));
      try {
        const activeSessions = new Map<string, DaemonSession>();
        const res = await triggerSessionTurn(runAsRequest({}, { workingDir: dir }), deps(activeSessions));
        expect(res).toMatchObject({ ok: true, action: 'queued' });
        expect(admit).toHaveBeenCalledWith(CHAT, 'person@example.com');
        const ds = activeSessions.get(sessionKey('om_new_topic', APP))!;
        const turnId = res.triggerId!;
        expect(turnId).toMatch(/^trg_runas_/);
        expect(ds.session.workingDir).toBe(dir);
        expect(ds.session.replyTargets?.[turnId]?.senderOpenId).toBe(PERSON);
        expect(Object.keys(ds.session.replyTargets ?? {})).toEqual([turnId]);
        expect(mockBuildNewTopicCliInput.mock.calls.at(-1)?.[0]).toBe('Check the build');
        const [, input, forkTurn] = mockForkWorker.mock.calls.at(-1)!;
        expect(forkTurn).toBe(turnId);
        expect(input.trustedCaller).toEqual({ requestLarkAppId: APP, requestUserOpenId: PERSON, senderType: 'user' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('starts the person turn of a rootMessageId that has no session yet', async () => {
      const activeSessions = new Map<string, DaemonSession>();
      const res = await triggerSessionTurn(runAsRequest({ rootMessageId: ROOT }), deps(activeSessions));
      expect(res).toMatchObject({ ok: true });
      const ds = activeSessions.get(sessionKey(ROOT, APP))!;
      expect(res.triggerId).toMatch(/^trg_runas_/);
      expect(ds.session.replyTargets?.[res.triggerId!]?.senderOpenId).toBe(PERSON);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('supports the asyncReturnSessionId mode on a new topic', async () => {
      const activeSessions = new Map<string, DaemonSession>();
      const res = await triggerSessionTurn(runAsRequest({}, { asyncReturnSessionId: true }), deps(activeSessions));
      expect(res).toMatchObject({ ok: true, async: { status: 'pending', sessionId: 'sess_new' } });
      const [, input, forkTurn] = mockForkWorker.mock.calls.at(-1)!;
      expect(forkTurn).toBe(res.triggerId);
      expect(res.triggerId).toMatch(/^trg_runas_/);
      expect(input.trustedCaller.requestUserOpenId).toBe(PERSON);
    });

    it('runs a follow-up in an existing session as the person for that turn only', async () => {
      const send = vi.fn();
      const ds = existingDs({ worker: { send } as any });
      ds.session.replyTargets = { om_human_before: { senderOpenId: 'ou_someone_else' } } as any;
      const res = await triggerSessionTurn(
        runAsRequest({ chatId: undefined, sessionId: 'sess_existing' }, { asyncReturnSessionId: true }),
        deps(new Map([[sessionKey(ROOT, APP), ds]])),
      );
      expect(res).toMatchObject({ ok: true });
      const turn = send.mock.calls[0]![0] as PendingCliInput;
      expect(turn.turnId).toMatch(/^trg_runas_/);
      expect(turn.turnCallerOpenId).toBe(PERSON);
      expect(turn.trustedCaller?.requestUserOpenId).toBe(PERSON);
      expect(turn.queueAfterActiveTurn).toBe(true);
      expect(Object.keys(ds.session.replyTargets!).sort()).toEqual(['om_human_before', turn.turnId].sort());
      expect(ds.session.replyTargets!.om_human_before!.senderOpenId).toBe('ou_someone_else');
      const queue = [{ ...turn }];
      expect(mergeQueuedCliInput(queue, {
        content: 'From chat', turnId: 'om_same_person', trustedCaller: turn.trustedCaller, turnCallerOpenId: PERSON,
      })).toBe(false);
      expect(queue[0]?.turnId).toBe(turn.turnId);
      expect(queue[0]?.content).not.toContain('From chat');
    });

    it('marks an ordinary live-worker runAs follow-up as an independent serial turn', async () => {
      const send = vi.fn();
      const ds = existingDs({ worker: { send } as any });
      const res = await triggerSessionTurn(
        runAsRequest({ chatId: undefined, sessionId: 'sess_existing' }),
        deps(new Map([[sessionKey(ROOT, APP), ds]])),
      );
      expect(res).toMatchObject({ ok: true });
      const turn = send.mock.calls[0]![0] as PendingCliInput;
      expect(turn.queueAfterActiveTurn).toBe(true);
      expect(turn.trustedCaller?.requestUserOpenId).toBe(PERSON);
    });

    it('admits the person against the chat of the addressed session, not a caller-supplied chat', async () => {
      const ds = existingDs({ worker: { send: vi.fn() } as any });
      await triggerSessionTurn(
        runAsRequest({ chatId: 'oc_other_chat', sessionId: 'sess_existing' }),
        deps(new Map([[sessionKey(ROOT, APP), ds]])),
      );
      expect(admit).toHaveBeenCalledWith(CHAT, 'person@example.com');
    });

    it.each([
      ['unresolved', 'run_as_unresolved'],
      ['not_allowed', 'run_as_not_allowed'],
      ['invalid', 'bad_request'],
    ] as const)('refuses a %s person before any chat side effect', async (reason, errorCode) => {
      admit.mockResolvedValue({ ok: false, reason });
      const activeSessions = new Map<string, DaemonSession>();
      const res = await triggerSessionTurn(runAsRequest(), deps(activeSessions));
      expect(res).toMatchObject({ ok: false, errorCode });
      expect(activeSessions.size).toBe(0);
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(mockForkWorker).not.toHaveBeenCalled();
    });

    it('refuses runAs when the caller supplied no admission (untrusted route)', async () => {
      const res = await triggerSessionTurn(runAsRequest(), { larkAppId: APP, activeSessions: new Map() });
      expect(res).toMatchObject({ ok: false, errorCode: 'bad_request' });
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockForkWorker).not.toHaveBeenCalled();
    });

    it('refuses runAs on a virtual (no real chat) session', async () => {
      const activeSessions = new Map<string, DaemonSession>();
      const res = await triggerSessionTurn(
        runAsRequest({ chatId: undefined }, { asyncReturnSessionId: true }), deps(activeSessions),
      );
      expect(res).toMatchObject({ ok: false, errorCode: 'bad_request' });
      expect(admit).not.toHaveBeenCalled();
      expect(activeSessions.size).toBe(0);
      expect(mockForkWorker).not.toHaveBeenCalled();
    });

    it.each([
      ['a synchronous turnIdempotencyKey', { turnIdempotencyKey: 'k1' }],
      ['a waiting turnIdempotencyKey', { turnIdempotencyKey: 'k1', waitForFinalOutput: true }],
    ] as const)('refuses runAs with %s without asyncReturnSessionId', async (_label, options) => {
      const ds = existingDs({ worker: { send: vi.fn() } as any });
      const res = await triggerSessionTurn(
        runAsRequest({ chatId: undefined, sessionId: 'sess_existing' }, options),
        deps(new Map([[sessionKey(ROOT, APP), ds]])),
      );
      expect(res).toMatchObject({ ok: false, errorCode: 'bad_request' });
      expect(ds.session.replyTargets).toBeUndefined();
    });

    it('does not turn a runAs session into an auto-worktree', async () => {
      mockBotAutoWorktreeEnabled.mockReturnValue(true);
      const activeSessions = new Map<string, DaemonSession>();
      await triggerSessionTurn(runAsRequest({ rootMessageId: ROOT }), deps(activeSessions));
      expect(mockRunAutoWorktreeCommit).not.toHaveBeenCalled();
      expect(mockForkWorker).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['sessionId', { chatId: undefined, sessionId: 'sess_existing' }],
      ['rootMessageId', { rootMessageId: ROOT }],
    ] as const)('assistant mode refuses runAs on an existing session addressed by %s', async (_label, target) => {
      const send = vi.fn();
      const ds = existingDs({ worker: { send } as any });
      ds.session.assistantOwnerOpenId = 'ou_owner_a';
      ds.session.replyTargets = { om_before: { senderOpenId: 'ou_owner_a' } } as any;
      const res = await triggerSessionTurn(
        runAsRequest(target),
        deps(new Map([[sessionKey(ROOT, APP), ds]])),
      );
      expect(res).toMatchObject({ ok: false, errorCode: 'bad_request' });
      expect(send).not.toHaveBeenCalled();
      expect(ds.session.replyTargets).toEqual({ om_before: { senderOpenId: 'ou_owner_a' } });
    });

    it('assistant mode rejects runAs on a legacy existing session without an owner marker', async () => {
      mockGetBot.mockReturnValue({
        config: { larkAppId: APP, cliId: 'codex', workingDir: '/tmp', assistantMode: true },
        botName: 'Bot', botOpenId: 'ou_bot',
      });
      const send = vi.fn();
      const ds = existingDs({ worker: { send } as any });
      const res = await triggerSessionTurn(
        runAsRequest({ chatId: undefined, sessionId: 'sess_existing' }),
        deps(new Map([[sessionKey(ROOT, APP), ds]])),
      );
      expect(res).toMatchObject({ ok: false, errorCode: 'bad_request' });
      expect(send).not.toHaveBeenCalled();
    });

    it('assistant mode refuses runAs without creating a session', async () => {
      try {
        assistant.spawn = { kind: 'owner', openId: 'ou_owner_a', workDir: '/home/u/ou_owner_a/work' };
        const activeSessions = new Map<string, DaemonSession>();
        const res = await triggerSessionTurn(runAsRequest({ rootMessageId: ROOT }), deps(activeSessions));
        expect(res).toMatchObject({ ok: false, errorCode: 'bad_request' });
        expect(activeSessions.size).toBe(0);
        expect(mockForkWorker).not.toHaveBeenCalled();
      } finally {
        assistant.spawn = { kind: 'off' };
      }
    });
  });

  it('registers the minted turn as a trigger turn of its connector kind (execution current origin)', async () => {
    const res = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions: new Map() });
    const triggerId = (res as { triggerId?: string }).triggerId!;
    expect(triggerId).toMatch(/^trg_/);
    expect(resolveTurnOrigin({ session: {} } as any, triggerId)).toEqual({ origin: 'trigger', triggerSource: 'webhook' });
    expect(resolveTurnOrigin({ session: {} } as any, 'trg_never_admitted')).toEqual({ origin: 'unknown' });
  });

  it('records a turn as submitted from outside only when the public entry says so', async () => {
    const internal = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions: new Map() });
    const internalId = (internal as { triggerId?: string }).triggerId!;
    expect(resolveTurnOrigin({ session: {} } as any, internalId)).toMatchObject({ origin: 'trigger' });
    expect(isExternalTriggerTurn(internalId)).toBe(false);
    const external = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions: new Map(), externalRequest: true });
    expect(isExternalTriggerTurn((external as { triggerId?: string }).triggerId!)).toBe(true);
  });

  it('keeps the localized topic seed by default', () => {
    expect(buildExternalEventTopicMessage(request(), APP)).toBe('外部事件触发：alerts');
  });

  it.each([
    { model: 'minimax/MiniMax-M3' },
    { reasoningEffort: 'max' as const },
    { model: 'minimax/MiniMax-M3.1-Flash', reasoningEffort: 'ultra' as const },
  ])('keeps MiniMax trigger overrides inactive while inheriting bot effort: %j', async options => {
    // Capability at bot level must not activate previously ignored task intent.
    const botCfg = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: APP, larkAppSecret: 'fixture', cliId: 'minimax', workingDir: '/tmp',
      model: 'minimax/MiniMax-M3.1-Flash', reasoningEffort: 'high',
    }]))[0]!;
    registerBot(botCfg);
    mockGetBot.mockReturnValue(undefined);
    const req = request();
    req.options = options;
    const activeSessions = new Map<string, DaemonSession>();
    const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });
    expect(result).toMatchObject({ ok: true, action: 'queued' });
    expect(mockForkWorker).toHaveBeenCalledOnce();
    const ds = activeSessions.get(sessionKey(ROOT, APP))!;
    expect(ds.spawnModelOverride).toBeUndefined();
    expect(ds.session.model).toBeUndefined();
    expect(ds.session.reasoningEffort).toBeUndefined();
    expect(__testOnly_sessionAgentConfig(ds, botCfg)).toMatchObject({
      cliId: 'minimax', model: botCfg.model, reasoningEffort: 'high',
    });
  });

  it('stamps per-turn model + reasoningEffort onto a grok session', async () => {
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'grok', workingDir: '/tmp' },
      botName: 'Grok', botOpenId: 'ou_bot',
    });
    const req = request();
    (req.options as any) = { model: 'grok-4.6', reasoningEffort: 'xhigh' };
    const activeSessions = new Map<string, DaemonSession>();
    await triggerSessionTurn(req, { larkAppId: APP, activeSessions });
    const ds = activeSessions.get(sessionKey(ROOT, APP));
    // 与 codex 那条同理：per-trigger 的 model 只落内存态运行时会话，不落盘。
    expect(ds?.spawnModelOverride).toBe('grok-4.6');
    expect(ds?.session.model).toBeUndefined();
    expect(ds?.session.reasoningEffort).toBe('xhigh');
  });

  it('stamps per-turn reasoningEffort onto a claude-code session', async () => {
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'claude-code', workingDir: '/tmp' },
      botName: 'Claude', botOpenId: 'ou_bot',
    });
    const req = request();
    (req.options as any) = { model: 'claude-opus-5', reasoningEffort: 'max' };
    const activeSessions = new Map<string, DaemonSession>();
    await triggerSessionTurn(req, { larkAppId: APP, activeSessions });
    const ds = activeSessions.get(sessionKey(ROOT, APP));
    expect(ds?.spawnModelOverride).toBe('claude-opus-5');
    expect(ds?.session.model).toBeUndefined();
    // max is claude-only (codex tops out the same list but grok/traex do not);
    // it must survive the trigger gate verbatim.
    expect(ds?.session.reasoningEffort).toBe('max');
  });

  it('stamps per-turn model + reasoningEffort onto a codex-family session', async () => {
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'codex-app', workingDir: '/tmp' },
      botName: 'Bot', botOpenId: 'ou_bot',
    });
    const req = request();
    (req.options as any) = { model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' };
    const activeSessions = new Map<string, DaemonSession>();
    await triggerSessionTurn(req, { larkAppId: APP, activeSessions });
    const ds = activeSessions.get(sessionKey(ROOT, APP));
    // The model override is PER TRIGGER, so it lands on the in-memory runtime
    // session only. Persisting it (the old behavior) made a one-shot caller
    // choice outrank the bot's configured model on every later resume, forever.
    expect(ds?.spawnModelOverride).toBe('gpt-5.6-terra');
    expect(ds?.session.model).toBeUndefined();
    // xhigh preserved verbatim (no downgrade — codex 0.145 accepts it)
    expect(ds?.session.reasoningEffort).toBe('xhigh');
  });

  it('stamps per-turn model + reasoningEffort onto a TraeX session', async () => {
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'traex', workingDir: '/tmp' },
      botName: 'TraeX', botOpenId: 'ou_bot',
    });
    const req = request();
    (req.options as any) = { model: 'DeepSeek-V4-Pro', reasoningEffort: 'medium' };
    const activeSessions = new Map<string, DaemonSession>();
    await triggerSessionTurn(req, { larkAppId: APP, activeSessions });
    const ds = activeSessions.get(sessionKey(ROOT, APP));
    expect(ds?.spawnModelOverride).toBe('DeepSeek-V4-Pro');
    expect(ds?.session.model).toBeUndefined();
    expect(ds?.session.reasoningEffort).toBe('medium');
  });

  it('preserves a syntactically valid TraeX reasoning effort override', async () => {
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'traex', workingDir: '/tmp', model: 'DeepSeek-V4-Pro' },
      botName: 'TraeX', botOpenId: 'ou_bot',
    });
    const req = request();
    (req.options as any) = { reasoningEffort: 'xhigh' };
    const activeSessions = new Map<string, DaemonSession>();

    const res = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: true, action: 'queued' });
    expect(mockCreateSession).toHaveBeenCalledOnce();
    expect(activeSessions.get(sessionKey(ROOT, APP))?.session.reasoningEffort).toBe('xhigh');
  });

  it('lets a Codex trigger inherit the bot\'s saved catalogue-only pair and still rejects a refuted override', async () => {
    // gpt-6.3-sol stands for a model the static table has no row for: config
    // load keeps its catalogue-verified max, so the trigger must not reject it.
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'codex', workingDir: '/tmp', model: 'gpt-6.3-sol', reasoningEffort: 'max' },
      botName: 'Bot', botOpenId: 'ou_bot',
    });
    const inherited = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions: new Map() });
    expect(inherited).toMatchObject({ ok: true });

    const overridden = request();
    (overridden.options as any) = { model: 'gpt-5.5' };
    await expect(triggerSessionTurn(overridden, { larkAppId: APP, activeSessions: new Map() }))
      .resolves.toMatchObject({ ok: false, errorCode: 'bad_request' });
  });

  it.each([
    { model: 'DeepSeek-V4-Pro', reasoningEffort: 'xhigh' },
    { model: 'auto', reasoningEffort: 'ultra', traexAutoModel: { enabled: true, models: ['DeepSeek-V4-Pro'] } },
  ])('creates a new turn with parse-loaded TraeX $model and inherited $reasoningEffort', async config => {
    const parsed = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: APP, larkAppSecret: 'fixture', cliId: 'traex', workingDir: '/tmp', ...config,
    }]))[0]!;
    registerBot(parsed);
    mockGetBot.mockReturnValue(undefined); // Use the actual registered config in triggerSessionTurn.
    expect(parsed.reasoningEffort).toBe(config.reasoningEffort);
    const activeSessions = new Map<string, DaemonSession>();
    const req = request();
    req.options = {};
    const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });
    expect(result).toMatchObject({ ok: true, action: 'queued' });
    expect(mockCreateSession).toHaveBeenCalledOnce();
    expect(mockForkWorker).toHaveBeenCalledOnce();
    expect(activeSessions.get(sessionKey(ROOT, APP))?.session.sessionId).toBe('sess_new');
  });

  it('rejects malformed TraeX effort before creating a session', async () => {
    const parsed = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: APP, larkAppSecret: 'fixture', cliId: 'traex', workingDir: '/tmp', model: 'DeepSeek-V4-Pro', reasoningEffort: 'xhigh',
    }]))[0]!;
    registerBot(parsed);
    mockGetBot.mockReturnValue(undefined);
    const req = request();
    req.options = { reasoningEffort: 'extreme' as any };
    const activeSessions = new Map<string, DaemonSession>();
    const validated = validateTriggerRequest(req);
    expect(validated).toMatchObject({ ok: false, status: 400,
      body: { errorCode: 'bad_request', error: expect.stringContaining('options.reasoningEffort') } });
    if (validated.ok) await triggerSessionTurn(validated.request, { larkAppId: APP, activeSessions });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(0);
  });

  it('rejects a model-only override that forms an unsupported effective pair', async () => {
    mockGetBot.mockReturnValue({
      config: {
        larkAppId: APP,
        cliId: 'codex',
        workingDir: '/tmp',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'ultra',
      },
      botName: 'Bot',
      botOpenId: 'ou_bot',
    });
    const req = request();
    (req.options as any) = { model: 'gpt-5.4' };
    const activeSessions = new Map<string, DaemonSession>();

    const res = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: false, errorCode: 'bad_request' });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(0);
  });

  it('rejects an effort-only override that forms an unsupported effective pair', async () => {
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'codex', workingDir: '/tmp', model: 'gpt-5.4', reasoningEffort: 'xhigh' },
      botName: 'Bot', botOpenId: 'ou_bot',
    });
    const req = request();
    (req.options as any) = { reasoningEffort: 'ultra' };
    const activeSessions = new Map<string, DaemonSession>();

    const res = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: false, errorCode: 'bad_request' });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(0);
  });

  it('does NOT stamp model/effort onto a CLI without reasoning support', async () => {
    // opencode has no configurable reasoning effort (claude-code now does), so the
    // gate must keep the override from silently changing such a bot's model.
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'opencode', workingDir: '/tmp' },
      botName: 'OpenCode', botOpenId: 'ou_bot',
    });
    const req = request();
    (req.options as any) = { model: 'anthropic/claude-sonnet-4', reasoningEffort: 'high' };
    const activeSessions = new Map<string, DaemonSession>();
    await triggerSessionTurn(req, { larkAppId: APP, activeSessions });
    const ds = activeSessions.get(sessionKey(ROOT, APP));
    expect(ds?.spawnModelOverride).toBeUndefined();
    expect(ds?.session.model).toBeUndefined();
    expect(ds?.session.reasoningEffort).toBeUndefined();
  });

  it('uses a connector-owned custom topic seed when opening a new topic', async () => {
    const req = request({ rootMessageId: undefined });
    req.presentation = { topicMessage: 'CI 构建失败，请检查发布流水线' };
    const activeSessions = new Map<string, DaemonSession>();

    await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    expect(mockSendMessage).toHaveBeenCalledWith(APP, CHAT, 'CI 构建失败，请检查发布流水线');
    expect(mockCreateSession).toHaveBeenCalledWith(CHAT, 'om_new_topic', '[External] alerts', 'group', undefined, { source: 'http' });
    expect(activeSessions.get(sessionKey('om_new_topic', APP))?.scope).toBe('thread');
  });

  it('forces an explicit topic seed into its own thread in a regular chat-mode group', async () => {
    mockGetChatMode.mockResolvedValueOnce('group');
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'claude-code', workingDir: '/tmp', regularGroupReplyMode: 'chat' },
      botName: 'Bot', botOpenId: 'ou_bot',
    });
    const incumbent = existingDs({ scope: 'chat' });
    incumbent.session.rootMessageId = CHAT;
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(CHAT, APP), incumbent]]);
    const req = request({ rootMessageId: undefined });
    req.presentation = { topicMessage: 'Background job' };

    const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    expect(result).toMatchObject({ ok: true, target: { sessionId: 'sess_new' } });
    expect(mockSendMessage).toHaveBeenCalledWith(APP, CHAT, 'Background job');
    expect(mockCreateSession).toHaveBeenCalledWith(CHAT, 'om_new_topic', '[External] alerts', 'group', undefined, { source: 'http' });
    expect(activeSessions.get(sessionKey(CHAT, APP))).toBe(incumbent);
    expect(activeSessions.get(sessionKey('om_new_topic', APP))?.scope).toBe('thread');
  });

  it.each(['shared', 'chat', 'chat-topic', 'new-topic'].flatMap(mode => [false, true].map(existing => ({ mode, existing }))))(
    'explicit topic seed respects $mode with existing shared session=$existing', async ({ mode, existing }) => {
      mockGetChatMode.mockResolvedValue('group');
      mockGetBot.mockReturnValue({ config: { larkAppId: APP, cliId: 'claude-code', workingDir: '/tmp', regularGroupReplyMode: mode }, botName: 'Bot', botOpenId: 'ou_bot' });
      const worker = { killed: false, send: vi.fn() };
      const incumbent = existingDs({ scope: 'chat', worker: worker as any, workingDir: '/tmp/shared-cwd' });
      incumbent.session.rootMessageId = CHAT;
      const activeSessions = new Map<string, DaemonSession>(existing ? [[sessionKey(CHAT, APP), incumbent]] : []);
      const req = request({ rootMessageId: undefined }); req.presentation = { topicMessage: 'Explicit event' };
      const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });
      expect(result.ok).toBe(true);
      if (mode === 'shared') {
        expect(mockSendMessage).toHaveBeenCalledWith(APP, CHAT, 'Explicit event');
        const sharedDs = activeSessions.get(sessionKey(CHAT, APP))!;
        expect(sharedDs.scope).toBe('chat');
        expect(activeSessions.has(sessionKey('om_new_topic', APP))).toBe(false);
        expect(frozenReplyContextForTurn(sharedDs, result.triggerId).target).toEqual({
          mode: 'thread', rootMessageId: 'om_new_topic',
        });
        expect(resolveSessionReplyTarget(sharedDs, result.triggerId)).toEqual({
          mode: 'thread', rootMessageId: 'om_new_topic',
        });
        expect(sharedDs.session.replyThreadAliases?.om_new_topic).toBeDefined();
        expect(sharedDs.currentReplyTarget).toMatchObject({ rootMessageId: 'om_new_topic', turnId: result.triggerId });
        if (existing) {
          expect(sharedDs).toBe(incumbent);
          expect(incumbent.worker).toBe(worker);
          expect(incumbent.workingDir).toBe('/tmp/shared-cwd');
          expect(mockCreateSession).not.toHaveBeenCalled();
        }
      } else {
        expect(mockSendMessage).toHaveBeenCalledWith(APP, CHAT, 'Explicit event');
        expect(activeSessions.get(sessionKey('om_new_topic', APP))?.scope).toBe('thread');
        if (existing) expect(activeSessions.get(sessionKey(CHAT, APP))).toBe(incumbent);
      }
    },
  );
  it('still opens an explicit topic in a topic group with shared configured', async () => {
    mockGetBot.mockReturnValue({ config: { larkAppId: APP, cliId: 'claude-code', workingDir: '/tmp', regularGroupReplyMode: 'shared' }, botName: 'Bot', botOpenId: 'ou_bot' });
    const req = request({ rootMessageId: undefined }); req.presentation = { topicMessage: 'Topic group event' };
    await triggerSessionTurn(req, { larkAppId: APP, activeSessions: new Map() });
    expect(mockSendMessage).toHaveBeenCalledWith(APP, CHAT, 'Topic group event');
  });
  it.each(['root', 'session'] as const)('keeps an explicit %s target when topic text is supplied', async target => {
    const incumbent = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const activeSessions = new Map([[sessionKey(ROOT, APP), incumbent]]);
    const req = request(target === 'session' ? { rootMessageId: undefined, sessionId: incumbent.session.sessionId } : {});
    req.presentation = { topicMessage: 'Do not reroute this target' };
    await triggerSessionTurn(req, { larkAppId: APP, activeSessions });
    expect(mockGetChatMode).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('splits an explicit seed in a shared-mode topic group even with an incumbent chat session', async () => {
    mockGetChatMode.mockResolvedValue('topic');
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'claude-code', workingDir: '/tmp', regularGroupReplyMode: 'shared' },
      botName: 'Bot', botOpenId: 'ou_bot',
    });
    const incumbent = existingDs({ scope: 'chat' });
    incumbent.session.rootMessageId = CHAT;
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(CHAT, APP), incumbent]]);
    const req = request({ rootMessageId: undefined });
    req.presentation = { topicMessage: 'Topic group event' };

    const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    expect(result).toMatchObject({ ok: true, target: { sessionId: 'sess_new' } });
    expect(mockSendMessage).toHaveBeenCalledWith(APP, CHAT, 'Topic group event');
    expect(activeSessions.get(sessionKey(CHAT, APP))).toBe(incumbent);
    expect(activeSessions.get(sessionKey('om_new_topic', APP))?.scope).toBe('thread');
  });

  it('folds an explicit seed into a shared incumbent past the new-session model gate', async () => {
    // traex + xhigh is rejected for a FRESH session; the shared fold must reach
    // deliverToExisting before that gate instead of bouncing the turn.
    mockGetChatMode.mockResolvedValue('group');
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'traex', workingDir: '/tmp', model: 'DeepSeek-V4-Pro', regularGroupReplyMode: 'shared' },
      botName: 'TraeX', botOpenId: 'ou_bot',
    });
    const send = vi.fn();
    const incumbent = existingDs({ scope: 'chat', worker: { killed: false, send } as any });
    incumbent.session.rootMessageId = CHAT;
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(CHAT, APP), incumbent]]);
    const req = request({ rootMessageId: undefined });
    req.presentation = { topicMessage: 'Shared group event' };
    req.options = { reasoningEffort: 'xhigh' };

    const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    expect(result).toMatchObject({ ok: true, target: { sessionId: 'sess_existing' } });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(APP, CHAT, 'Shared group event');
    expect(frozenReplyContextForTurn(incumbent, result.triggerId).target).toEqual({
      mode: 'thread', rootMessageId: 'om_new_topic',
    });
    expect(incumbent.session.replyThreadAliases?.om_new_topic).toBeDefined();
  });

  describe('shared regular group explicit topicMessage anchoring', () => {
    const setupSharedGroup = (extraConfig: Record<string, unknown> = {}) => {
      mockGetChatMode.mockResolvedValue('group');
      mockGetBot.mockReturnValue({
        config: { larkAppId: APP, cliId: 'claude-code', workingDir: '/tmp', regularGroupReplyMode: 'shared', ...extraConfig },
        botName: 'Bot',
        botOpenId: 'ou_bot',
      });
    };

    it('creates a chat-scope session and anchors turn replies, aliases, and structured placement to the seed topic', async () => {
      setupSharedGroup();
      mockSendMessage.mockResolvedValueOnce('om_shared_seed_1');
      const activeSessions = new Map<string, DaemonSession>();
      const req = request({ rootMessageId: undefined });
      req.instruction = '排查 Bug';
      req.presentation = { topicMessage: '我来看看这个问题' };

      const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

      expect(result).toMatchObject({ ok: true, action: 'queued', target: { sessionId: 'sess_new', chatId: CHAT } });
      expect(mockSendMessage).toHaveBeenCalledWith(APP, CHAT, '我来看看这个问题');
      expect(mockCreateSession).toHaveBeenCalledWith(CHAT, CHAT, '[External] alerts', 'group', undefined, { source: 'http' });
      const ds = activeSessions.get(sessionKey(CHAT, APP))!;
      expect(ds.scope).toBe('chat');
      expect(activeSessions.has(sessionKey('om_shared_seed_1', APP))).toBe(false);
      expect(frozenReplyContextForTurn(ds, result.triggerId).target).toEqual({
        mode: 'thread', rootMessageId: 'om_shared_seed_1',
      });
      expect(resolveSessionReplyTarget(ds, result.triggerId)).toEqual({
        mode: 'thread', rootMessageId: 'om_shared_seed_1',
      });
      expect(ds.session.replyThreadAliases?.om_shared_seed_1).toBeDefined();
      expect(ds.replyThreadAliases?.om_shared_seed_1).toBeDefined();
      expect(ds.currentReplyTarget).toMatchObject({ rootMessageId: 'om_shared_seed_1', turnId: result.triggerId });
      expect(mockUpdateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_new',
        currentReplyTarget: expect.objectContaining({ rootMessageId: 'om_shared_seed_1', turnId: result.triggerId }),
        replyThreadAliases: expect.objectContaining({ om_shared_seed_1: expect.any(Object) }),
        turnReplyContexts: expect.objectContaining({
          [result.triggerId!]: expect.objectContaining({
            target: { mode: 'thread', rootMessageId: 'om_shared_seed_1' },
          }),
        }),
      }));
      expect(mockForkWorker).toHaveBeenCalledWith(ds, expect.objectContaining({ content: expect.stringContaining('new:') }), result.triggerId);
      recordSessionTurnInput({
        dataDir: config.session.dataDir,
        sessionId: ds.session.sessionId,
        turnId: result.triggerId!,
        input: 'fallback',
        cliId: 'claude-code',
      });
      expect(readSessionTurns(config.session.dataDir, ds.session.sessionId, 0, 50).turns
        .find(entry => entry.turnId === result.triggerId)?.inbound).toEqual([
        expect.objectContaining({
          messageId: result.triggerId,
          via: 'trigger',
          placement: { kind: 'thread', rootMessageId: 'om_shared_seed_1' },
        }),
      ]);
    });

    it('reuses a live chat-scope session and isolates the new seed topic from an earlier turn topic', async () => {
      setupSharedGroup();
      mockSendMessage.mockResolvedValueOnce('om_topic_b');
      const send = vi.fn();
      const incumbent = existingDs({
        scope: 'chat',
        worker: { killed: false, send } as any,
        currentReplyTarget: { rootMessageId: 'om_topic_a', turnId: 'om_prev_human', updatedAt: '2026-06-01T00:00:00.000Z' },
        replyThreadAliases: { om_topic_a: { createdAt: '2026-06-01T00:00:00.000Z', lastUsedAt: '2026-06-01T00:00:00.000Z' } },
      });
      incumbent.session.scope = 'chat';
      incumbent.session.rootMessageId = CHAT;
      incumbent.session.currentReplyTarget = incumbent.currentReplyTarget;
      incumbent.session.replyThreadAliases = incumbent.replyThreadAliases;
      incumbent.session.turnReplyContexts = {
        om_prev_human: { target: { mode: 'thread', rootMessageId: 'om_topic_a' } },
      };
      incumbent.session.replyTargets = {
        om_prev_human: { rootMessageId: 'om_topic_a', updatedAt: '2026-06-01T00:00:00.000Z' },
      };
      const activeSessions = new Map<string, DaemonSession>([[sessionKey(CHAT, APP), incumbent]]);
      const req = request({ rootMessageId: undefined });
      req.instruction = '处理第二个告警';
      req.presentation = { topicMessage: '开始处理告警 B' };

      const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

      expect(result).toMatchObject({ ok: true, action: 'delivered', target: { sessionId: 'sess_existing', chatId: CHAT } });
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledWith(APP, CHAT, '开始处理告警 B');
      // Previous turn stays pinned to topic A; new trigger turn is pinned to topic B.
      expect(frozenReplyContextForTurn(incumbent, 'om_prev_human').target).toEqual({
        mode: 'thread', rootMessageId: 'om_topic_a',
      });
      expect(resolveSessionReplyTarget(incumbent, 'om_prev_human')).toEqual({
        mode: 'thread', rootMessageId: 'om_topic_a',
      });
      expect(frozenReplyContextForTurn(incumbent, result.triggerId).target).toEqual({
        mode: 'thread', rootMessageId: 'om_topic_b',
      });
      expect(resolveSessionReplyTarget(incumbent, result.triggerId)).toEqual({
        mode: 'thread', rootMessageId: 'om_topic_b',
      });
      expect(incumbent.session.replyThreadAliases?.om_topic_a).toBeDefined();
      expect(incumbent.session.replyThreadAliases?.om_topic_b).toBeDefined();
      expect(incumbent.currentReplyTarget).toMatchObject({ rootMessageId: 'om_topic_b', turnId: result.triggerId });
      expect(mockUpdateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_existing',
        currentReplyTarget: expect.objectContaining({ rootMessageId: 'om_topic_b', turnId: result.triggerId }),
        replyThreadAliases: expect.objectContaining({ om_topic_b: expect.any(Object) }),
        turnReplyContexts: expect.objectContaining({
          [result.triggerId!]: expect.objectContaining({
            target: { mode: 'thread', rootMessageId: 'om_topic_b' },
          }),
        }),
      }));
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ turnId: result.triggerId }));
      recordSessionTurnInput({
        dataDir: config.session.dataDir,
        sessionId: incumbent.session.sessionId,
        turnId: result.triggerId!,
        input: 'fallback',
        cliId: 'claude-code',
      });
      expect(readSessionTurns(config.session.dataDir, incumbent.session.sessionId, 0, 50).turns
        .find(entry => entry.turnId === result.triggerId)?.inbound).toEqual([
        expect.objectContaining({
          messageId: result.triggerId,
          via: 'trigger',
          placement: { kind: 'thread', rootMessageId: 'om_topic_b' },
        }),
      ]);
    });

    it('cold-resumes a suspended chat-scope session and anchors the new turn to its seed topic', async () => {
      setupSharedGroup();
      mockSendMessage.mockResolvedValueOnce('om_resumed_seed');
      const suspended = existingDs({ scope: 'chat', worker: null, hasHistory: true });
      suspended.session.scope = 'chat';
      suspended.session.rootMessageId = CHAT;
      suspended.session.suspendedColdResume = true;
      const activeSessions = new Map<string, DaemonSession>([[sessionKey(CHAT, APP), suspended]]);
      const req = request({ rootMessageId: undefined });
      req.presentation = { topicMessage: '唤醒挂起会话排查' };

      const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

      expect(result).toMatchObject({ ok: true, action: 'queued', target: { sessionId: 'sess_existing', chatId: CHAT } });
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledWith(APP, CHAT, '唤醒挂起会话排查');
      expect(frozenReplyContextForTurn(suspended, result.triggerId).target).toEqual({
        mode: 'thread', rootMessageId: 'om_resumed_seed',
      });
      expect(suspended.session.replyThreadAliases?.om_resumed_seed).toBeDefined();
      expect(mockForkWorker).toHaveBeenCalledWith(
        suspended,
        expect.anything(),
        expect.objectContaining({ resume: true, turnId: result.triggerId }),
      );
    });

    it.each([undefined, null])('keeps flat chat-scope reply without sending a seed when topicMessage is %s', async topicMessage => {
      setupSharedGroup();
      const activeSessions = new Map<string, DaemonSession>();
      const req = request({ rootMessageId: undefined });
      if (topicMessage !== undefined) req.presentation = { topicMessage };

      const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

      expect(result.ok).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
      const ds = activeSessions.get(sessionKey(CHAT, APP))!;
      expect(ds.scope).toBe('chat');
      expect(frozenReplyContextForTurn(ds, result.triggerId).target).toEqual({ mode: 'plain', chatId: CHAT });
    });

    it('honors per-chat shared override even when bot default mode is chat', async () => {
      mockGetChatMode.mockResolvedValue('group');
      mockGetBot.mockReturnValue({
        config: {
          larkAppId: APP,
          cliId: 'claude-code',
          workingDir: '/tmp',
          regularGroupReplyMode: 'chat',
          chatReplyModes: { [CHAT]: 'shared' },
        },
        botName: 'Bot',
        botOpenId: 'ou_bot',
      });
      mockSendMessage.mockResolvedValueOnce('om_override_seed');
      const activeSessions = new Map<string, DaemonSession>();
      const req = request({ rootMessageId: undefined });
      req.presentation = { topicMessage: '按群覆盖 shared 话题' };

      const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

      expect(result.ok).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(APP, CHAT, '按群覆盖 shared 话题');
      const ds = activeSessions.get(sessionKey(CHAT, APP))!;
      expect(ds.scope).toBe('chat');
      expect(frozenReplyContextForTurn(ds, result.triggerId).target).toEqual({
        mode: 'thread', rootMessageId: 'om_override_seed',
      });
    });

    it('anchors auto-worktree notices and deferred turn into the shared seed topic', async () => {
      setupSharedGroup();
      mockBotAutoWorktreeEnabled.mockReturnValue(true);
      mockSendMessage.mockResolvedValueOnce('om_wt_seed');
      const activeSessions = new Map<string, DaemonSession>();
      const req = request({ rootMessageId: undefined });
      req.presentation = { topicMessage: '自动创建 worktree 处理' };

      const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

      expect(result).toMatchObject({ ok: true, action: 'queued', target: { sessionId: 'sess_new', chatId: CHAT } });
      expect(mockSendMessage).toHaveBeenCalledWith(APP, CHAT, '自动创建 worktree 处理');
      const ds = activeSessions.get(sessionKey(CHAT, APP))!;
      expect(ds.scope).toBe('chat');
      expect(ds.pendingRepo).toBe(true);
      expect(ds.pendingTurnId).toBe(result.triggerId);
      expect(frozenReplyContextForTurn(ds, result.triggerId).target).toEqual({
        mode: 'thread', rootMessageId: 'om_wt_seed',
      });
      expect(ds.session.replyThreadAliases?.om_wt_seed).toBeDefined();
      expect(mockUpdateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_new',
        currentReplyTarget: expect.objectContaining({ rootMessageId: 'om_wt_seed', turnId: result.triggerId }),
        replyThreadAliases: expect.objectContaining({ om_wt_seed: expect.any(Object) }),
      }));
      expect(mockRunAutoWorktreeCommit).toHaveBeenCalledTimes(1);
      const notify = mockRunAutoWorktreeCommit.mock.calls[0][0].notify as (msg: string) => Promise<unknown>;
      await notify('正在准备 worktree');
      expect(mockReplyMessage).toHaveBeenCalledWith(APP, 'om_wt_seed', '正在准备 worktree', 'text', true);
    });

    it('anchors runAs trigger on an existing shared chat session to the new seed topic and registers alias', async () => {
      setupSharedGroup();
      mockSendMessage.mockResolvedValueOnce('om_runas_seed');
      vi.mocked(resolveSender).mockResolvedValueOnce({ openId: 'ou_person', name: 'Alice', type: 'user' });
      const send = vi.fn();
      const incumbent = existingDs({
        scope: 'chat',
        worker: { killed: false, send } as any,
        currentReplyTarget: { rootMessageId: 'om_old_topic', turnId: 'om_prev', updatedAt: '2026-06-01T00:00:00.000Z', quoteOnly: true },
      });
      incumbent.session.scope = 'chat';
      incumbent.session.rootMessageId = CHAT;
      incumbent.session.currentReplyTarget = incumbent.currentReplyTarget;
      const activeSessions = new Map<string, DaemonSession>([[sessionKey(CHAT, APP), incumbent]]);
      const req: TriggerRequest = {
        runAs: 'ou_person',
        source: { type: 'webhook', connectorId: 'conn_1', requestId: 'req_runas' },
        target: { kind: 'turn', botId: APP, chatId: CHAT },
        instruction: '按指定身份排查',
        presentation: { topicMessage: '新话题排查' },
        envelope: { format: 'text', sourceName: 'alerts', trusted: false },
      };

      const result = await triggerSessionTurn(req, {
        larkAppId: APP,
        activeSessions,
        resolveRunAs: async () => ({ ok: true, openId: 'ou_person' }),
      });

      expect(result.ok).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(APP, CHAT, '新话题排查');
      expect(frozenReplyContextForTurn(incumbent, result.triggerId).target).toEqual({
        mode: 'thread', rootMessageId: 'om_runas_seed',
      });
      expect(incumbent.session.replyThreadAliases?.om_runas_seed).toBeDefined();
      expect(incumbent.currentReplyTarget).toMatchObject({ rootMessageId: 'om_runas_seed', turnId: result.triggerId });
      expect(send.mock.calls[0][0].content).toContain('root_message_id="om_runas_seed"');
    });

    it('never sends a seed when dryRun is true or pre-flight fails', async () => {
      setupSharedGroup();
      const req = request({ rootMessageId: undefined });
      req.presentation = { topicMessage: '不应发送' };
      req.options = { dryRun: true };
      const dryRes = await triggerSessionTurn(req, { larkAppId: APP, activeSessions: new Map() });
      expect(dryRes).toMatchObject({ ok: true, action: 'dry_run' });
      expect(mockSendMessage).not.toHaveBeenCalled();

      // Pre-flight rejection on a non-runnable incumbent must not send a seed.
      const pendingIncumbent = existingDs({ scope: 'chat', worker: null, pendingRepo: true });
      pendingIncumbent.session.rootMessageId = CHAT;
      const pendingReq = request({ rootMessageId: undefined });
      pendingReq.presentation = { topicMessage: '不应发送' };
      const pendingRes = await triggerSessionTurn(pendingReq, {
        larkAppId: APP,
        activeSessions: new Map([[sessionKey(CHAT, APP), pendingIncumbent]]),
      });
      expect(pendingRes).toMatchObject({ ok: false, errorCode: 'session_not_runnable' });
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('rolls back reply state and withdraws the seed if dispatch fails after sending', async () => {
      setupSharedGroup();
      mockSendMessage.mockResolvedValueOnce('om_orphan_seed');
      const prevAnchor = { rootMessageId: 'om_prev_topic', turnId: 'om_prev_turn', updatedAt: '2026-06-01T00:00:00.000Z' };
      const incumbent = existingDs({
        scope: 'chat',
        worker: null,
        hasHistory: true,
        currentReplyTarget: prevAnchor,
        replyThreadAliases: { om_prev_topic: { createdAt: '2026-06-01T00:00:00.000Z', lastUsedAt: '2026-06-01T00:00:00.000Z' } },
      });
      incumbent.session.scope = 'chat';
      incumbent.session.rootMessageId = CHAT;
      incumbent.session.currentReplyTarget = prevAnchor;
      incumbent.session.replyThreadAliases = incumbent.replyThreadAliases;
      incumbent.session.turnReplyContexts = { om_prev_turn: { target: { mode: 'thread', rootMessageId: 'om_prev_topic' } } };
      incumbent.session.replyTargets = { om_prev_turn: { rootMessageId: 'om_prev_topic', updatedAt: '2026-06-01T00:00:00.000Z' } };
      mockForkWorker.mockImplementationOnce(() => { throw new Error('spawn failed'); });
      const activeSessions = new Map<string, DaemonSession>([[sessionKey(CHAT, APP), incumbent]]);
      const req = request({ rootMessageId: undefined });
      req.presentation = { topicMessage: '失败应回滚' };

      await expect(triggerSessionTurn(req, { larkAppId: APP, activeSessions })).rejects.toThrow('spawn failed');

      expect(incumbent.currentReplyTarget).toEqual(prevAnchor);
      expect(incumbent.session.currentReplyTarget).toEqual(prevAnchor);
      expect(incumbent.session.replyThreadAliases?.om_orphan_seed).toBeUndefined();
      expect(incumbent.session.replyThreadAliases?.om_prev_topic).toBeDefined();
      expect(Object.keys(incumbent.session.turnReplyContexts ?? {})).toEqual(['om_prev_turn']);
      await vi.waitFor(() => expect(mockDeleteMessage).toHaveBeenCalledWith(APP, 'om_orphan_seed'));
    });

    it('cleans up the new-session reservation if sending the shared seed fails', async () => {
      setupSharedGroup();
      mockSendMessage.mockRejectedValueOnce(new Error('lark unavailable'));
      const activeSessions = new Map<string, DaemonSession>();
      const req = request({ rootMessageId: undefined });
      req.presentation = { topicMessage: '发送失败' };

      await expect(triggerSessionTurn(req, { larkAppId: APP, activeSessions })).rejects.toThrow('lark unavailable');

      expect(activeSessions.has(sessionKey(CHAT, APP))).toBe(false);
      expect(mockCloseSession).toHaveBeenCalledWith('sess_new');
      expect(mockForkWorker).not.toHaveBeenCalled();
    });

    it('withdraws the seed and refuses dispatch if the incumbent session closes while sendMessage is in flight', async () => {
      setupSharedGroup();
      const send = vi.fn();
      const incumbent = existingDs({ scope: 'chat', worker: { killed: false, send } as any });
      incumbent.session.scope = 'chat';
      incumbent.session.rootMessageId = CHAT;
      const activeSessions = new Map<string, DaemonSession>([[sessionKey(CHAT, APP), incumbent]]);
      mockSendMessage.mockImplementationOnce(async () => {
        incumbent.session.status = 'closed';
        activeSessions.delete(sessionKey(CHAT, APP));
        return 'om_closed_midflight';
      });
      const req = request({ rootMessageId: undefined });
      req.presentation = { topicMessage: '中途关闭' };

      const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

      expect(result).toMatchObject({ ok: false, errorCode: 'session_not_found' });
      expect(send).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(mockDeleteMessage).toHaveBeenCalledWith(APP, 'om_closed_midflight'));
    });

    it('does not open a shared group seed for p2p chats even when regularGroupReplyMode is shared', async () => {
      mockGetChatMode.mockResolvedValue('p2p');
      mockGetBot.mockReturnValue({
        config: { larkAppId: APP, cliId: 'claude-code', workingDir: '/tmp', regularGroupReplyMode: 'shared' },
        botName: 'Bot',
        botOpenId: 'ou_bot',
      });
      const activeSessions = new Map<string, DaemonSession>();
      const req = request({ rootMessageId: undefined });
      req.presentation = { topicMessage: '私聊事件' };

      const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

      expect(result.ok).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(activeSessions.get(sessionKey(CHAT, APP))?.scope).toBe('chat');
    });

    it('never leaks prior human quoteTarget/sender metadata into shared-topic turnReplyContexts (ordinary or runAs)', async () => {
      setupSharedGroup();
      const send = vi.fn();
      const incumbent = existingDs({ scope: 'chat', worker: { killed: false, send } as any });
      incumbent.session.scope = 'chat';
      incumbent.session.rootMessageId = CHAT;
      incumbent.session.quoteTargetId = 'om_bob_msg';
      incumbent.session.quoteTargetSenderOpenId = 'ou_bob';
      incumbent.session.quoteTargetSenderIsBot = false;
      const activeSessions = new Map<string, DaemonSession>([[sessionKey(CHAT, APP), incumbent]]);

      mockSendMessage.mockResolvedValueOnce('om_webhook_seed');
      const webhookReq = request({ rootMessageId: undefined });
      webhookReq.presentation = { topicMessage: 'Webhook 排查' };
      const webhookRes = await triggerSessionTurn(webhookReq, { larkAppId: APP, activeSessions });
      expect(webhookRes.ok).toBe(true);
      expect(incumbent.session.turnReplyContexts?.[webhookRes.triggerId!]).toEqual({
        target: { mode: 'thread', rootMessageId: 'om_webhook_seed' },
      });
      expect(incumbent.session.replyThreadAliases?.om_webhook_seed).toBeDefined();

      mockSendMessage.mockResolvedValueOnce('om_runas_seed_clean');
      vi.mocked(resolveSender).mockResolvedValueOnce({ openId: 'ou_alice', name: 'Alice', type: 'user' });
      const runAsReq: TriggerRequest = {
        runAs: 'ou_alice',
        source: { type: 'webhook', connectorId: 'conn_1', requestId: 'req_runas_clean' },
        target: { kind: 'turn', botId: APP, chatId: CHAT },
        instruction: '按 Alice 身份执行',
        presentation: { topicMessage: 'Alice 话题' },
        envelope: { format: 'text', sourceName: 'alerts', trusted: false },
      };
      const runAsRes = await triggerSessionTurn(runAsReq, {
        larkAppId: APP,
        activeSessions,
        resolveRunAs: async () => ({ ok: true, openId: 'ou_alice' }),
      });
      expect(runAsRes.ok).toBe(true);
      const runAsCtx = incumbent.session.turnReplyContexts?.[runAsRes.triggerId!];
      expect(runAsCtx?.target).toEqual({ mode: 'thread', rootMessageId: 'om_runas_seed_clean' });
      expect(runAsCtx?.quoteTargetId).toBeUndefined();
      expect(runAsCtx?.replyTargetSenderOpenId).toBeUndefined();
      expect(runAsCtx?.replyTargetSenderIsBot).toBeUndefined();
      expect(incumbent.session.replyTargets?.[runAsRes.triggerId!]?.senderOpenId).toBe('ou_alice');
      expect(incumbent.session.replyThreadAliases?.om_runas_seed_clean).toBeDefined();
    });

    it('retires the new-session reservation and withdraws the seed when forkWorker or updateSession throws', async () => {
      setupSharedGroup();
      const activeSessions = new Map<string, DaemonSession>();

      // 1) forkWorker throws on fresh shared session
      mockSendMessage.mockResolvedValueOnce('om_wedged_seed');
      mockForkWorker.mockImplementationOnce(() => { throw new Error('fork boom'); });
      const req1 = request({ rootMessageId: undefined });
      req1.presentation = { topicMessage: '首轮失败' };
      await expect(triggerSessionTurn(req1, { larkAppId: APP, activeSessions })).rejects.toThrow('fork boom');
      expect(activeSessions.has(sessionKey(CHAT, APP))).toBe(false);
      expect(mockCloseSession).toHaveBeenCalledWith('sess_new');
      await vi.waitFor(() => expect(mockDeleteMessage).toHaveBeenCalledWith(APP, 'om_wedged_seed'));

      // Subsequent trigger on the same group must NOT be wedged by a ghost session.
      mockSendMessage.mockResolvedValueOnce('om_recovered_seed');
      const req2 = request({ rootMessageId: undefined });
      req2.presentation = { topicMessage: '重试成功' };
      const retryRes = await triggerSessionTurn(req2, { larkAppId: APP, activeSessions });
      expect(retryRes).toMatchObject({ ok: true, action: 'queued', target: { sessionId: 'sess_new', chatId: CHAT } });

      // 2) useAutoWt updateSession throws after sendMessage + beginReplyTargetTurn
      const wtSessions = new Map<string, DaemonSession>();
      mockBotAutoWorktreeEnabled.mockReturnValue(true);
      mockSendMessage.mockResolvedValueOnce('om_wt_orphan');
      let threwWtPersist = false;
      mockUpdateSession.mockImplementation((s: any) => {
        if (!threwWtPersist && s?.replyThreadAliases?.om_wt_orphan) {
          threwWtPersist = true;
          throw new Error('disk full');
        }
      });
      const wtReq = request({ rootMessageId: undefined });
      wtReq.presentation = { topicMessage: 'wt 落盘失败' };
      await expect(triggerSessionTurn(wtReq, { larkAppId: APP, activeSessions: wtSessions })).rejects.toThrow('disk full');
      expect(threwWtPersist).toBe(true);
      expect(wtSessions.has(sessionKey(CHAT, APP))).toBe(false);
      expect(mockRunAutoWorktreeCommit).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(mockDeleteMessage).toHaveBeenCalledWith(APP, 'om_wt_orphan'));
    });

    it('preserves an in-place taken-over session or admitted human follower during mid-flight sendMessage', async () => {
      setupSharedGroup();

      // 1) In-place takeover starts a live worker during sendMessage: withdraw seed, do NOT close the live session.
      const takeoverSessions = new Map<string, DaemonSession>();
      mockSendMessage.mockImplementationOnce(async () => {
        const ds = takeoverSessions.get(sessionKey(CHAT, APP))!;
        ds.initialStartPending = false;
        ds.worker = { killed: false, send: vi.fn() } as any;
        return 'om_takeover_seed';
      });
      const req1 = request({ rootMessageId: undefined });
      req1.presentation = { topicMessage: '中途接管' };
      const res1 = await triggerSessionTurn(req1, { larkAppId: APP, activeSessions: takeoverSessions });
      expect(res1).toMatchObject({ ok: false, errorCode: 'trigger_failed' });
      expect(takeoverSessions.get(sessionKey(CHAT, APP))?.session.status).toBe('active');
      expect(mockCloseSession).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(mockDeleteMessage).toHaveBeenCalledWith(APP, 'om_takeover_seed'));

      // 2) Admitted human follower arrives while sendMessage fails: do NOT destroy the queued follower's session.
      const followerSessions = new Map<string, DaemonSession>();
      mockSendMessage.mockImplementationOnce(async () => {
        const ds = followerSessions.get(sessionKey(CHAT, APP))!;
        ds.session.queuedActivationTail = [{ id: 'q1', order: 1, turnId: 'om_human', userPrompt: 'hi', cliInput: { content: 'hi' } }] as any;
        throw new Error('lark timeout');
      });
      const req2 = request({ rootMessageId: undefined });
      req2.presentation = { topicMessage: '发送超时' };
      await expect(triggerSessionTurn(req2, { larkAppId: APP, activeSessions: followerSessions })).rejects.toThrow('lark timeout');
      expect(followerSessions.has(sessionKey(CHAT, APP))).toBe(true);
      expect(mockCloseSession).not.toHaveBeenCalled();
    });

    it('cleans up liveCard, hiddenThinkingTurns, suppressFinalOutput, reply state, and seed on live-worker send throw', async () => {
      setupSharedGroup();
      mockSendMessage.mockResolvedValueOnce('om_live_throw_seed');
      const prevAnchor = { rootMessageId: 'om_prev', turnId: 'om_prev_t', updatedAt: '2026-06-01T00:00:00.000Z' };
      const incumbent = existingDs({
        scope: 'chat',
        worker: { killed: false, send: vi.fn(() => { throw new Error('ipc broken'); }) } as any,
        currentReplyTarget: prevAnchor,
        replyThreadAliases: { om_prev: { createdAt: '2026-06-01T00:00:00.000Z', lastUsedAt: '2026-06-01T00:00:00.000Z' } },
      });
      incumbent.session.scope = 'chat';
      incumbent.session.rootMessageId = CHAT;
      incumbent.session.currentReplyTarget = prevAnchor;
      incumbent.session.replyThreadAliases = incumbent.replyThreadAliases;
      incumbent.session.hiddenThinkingTurns = ['om_prev_t'];
      const activeSessions = new Map<string, DaemonSession>([[sessionKey(CHAT, APP), incumbent]]);
      const req = request({ rootMessageId: undefined });
      req.presentation = { topicMessage: '发送异常回滚', liveCard: 'on-start', thinking: 'hidden' };
      req.options = { suppressFinalOutput: true };

      await expect(triggerSessionTurn(req, { larkAppId: APP, activeSessions })).rejects.toThrow('ipc broken');

      const failedTurnId = mockBuildFollowUpCliInput.mock.calls.at(-1)?.[2]?.turnId as string;
      expect(failedTurnId).toMatch(/^trg_/);
      expect(incumbent.currentReplyTarget).toEqual(prevAnchor);
      expect(incumbent.session.replyThreadAliases?.om_live_throw_seed).toBeUndefined();
      expect(incumbent.session.hiddenThinkingTurns).toEqual(['om_prev_t']);
      expect(incumbent.suppressedTriggerFinalTurns).toBeUndefined();
      expect(isTriggerFinalSuppressed(incumbent, failedTurnId)).toBe(false);
      expect(hasPendingTriggerStreamingCard(incumbent, failedTurnId)).toBe(false);
      await vi.waitFor(() => expect(mockDeleteMessage).toHaveBeenCalledWith(APP, 'om_live_throw_seed'));
    });
  });

  it('anchors an explicit seed in a p2p chat to its own seed message', async () => {
    // Explicit seed = explicit isolation intent regardless of group topology:
    // a p2p trigger is anchored under its seed thread instead of the flat chat.
    mockGetChatMode.mockResolvedValue('p2p');
    const req = request({ rootMessageId: undefined });
    req.presentation = { topicMessage: 'P2P event' };
    const activeSessions = new Map<string, DaemonSession>();

    await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    expect(mockSendMessage).toHaveBeenCalledWith(APP, CHAT, 'P2P event');
    expect(activeSessions.get(sessionKey('om_new_topic', APP))?.scope).toBe('thread');
  });

  it('skips the chat lookup for an explicit-seed dryRun outside shared mode', async () => {
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'claude-code', workingDir: '/tmp', regularGroupReplyMode: 'chat' },
      botName: 'Bot', botOpenId: 'ou_bot',
    });
    const incumbent = existingDs({ scope: 'chat' });
    incumbent.session.rootMessageId = CHAT;
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(CHAT, APP), incumbent]]);
    const req = request({ rootMessageId: undefined });
    req.presentation = { topicMessage: 'Preview event' };
    req.options = { dryRun: true };

    const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    expect(result).toMatchObject({ ok: true, action: 'dry_run' });
    expect(mockGetChatMode).not.toHaveBeenCalled();
  });

  it('still resolves the shared fold for an explicit-seed dryRun via one chat lookup', async () => {
    mockGetChatMode.mockResolvedValue('group');
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'claude-code', workingDir: '/tmp', regularGroupReplyMode: 'shared' },
      botName: 'Bot', botOpenId: 'ou_bot',
    });
    const incumbent = existingDs({ scope: 'chat' });
    incumbent.session.rootMessageId = CHAT;
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(CHAT, APP), incumbent]]);
    const req = request({ rootMessageId: undefined });
    req.presentation = { topicMessage: 'Preview event' };
    req.options = { dryRun: true };

    const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    expect(result).toMatchObject({ ok: true, action: 'dry_run', target: { sessionId: 'sess_existing' } });
    expect(mockGetChatMode).toHaveBeenCalledTimes(1);
  });

  it('suppresses the topic seed and keeps a topicless automation session chat-scoped', async () => {
    const req = request({ rootMessageId: undefined });
    req.presentation = { topicMessage: null };
    const activeSessions = new Map<string, DaemonSession>();

    await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalledWith(CHAT, CHAT, '[External] alerts', 'group', undefined, { source: 'http' });
    const ds = activeSessions.get(sessionKey(CHAT, APP));
    expect(ds?.scope).toBe('chat');
    expect(ds?.session.externalTriggerTopicless).toBe(true);
    expect(mockForkWorker).toHaveBeenCalledWith(ds, { content: expect.stringContaining('new:') }, mockRememberLastCliInput.mock.calls.at(-1)?.[3]);
    expect(mockRememberLastCliInput.mock.calls.at(-1)?.[3]).toEqual(expect.any(String));
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

  it('refuses to start a second runtime on a route reserved by a quarantined session', async () => {
    // Regression: #597 replaced the setActiveSessionIfActive registration with a
    // bare Map.set, silently dropping the quarantine routing check every other
    // creation path still applies.
    routeQuarantine.keys.add(sessionKey(ROOT, APP));
    const activeSessions = new Map<string, DaemonSession>();
    const res = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: false, errorCode: 'trigger_failed' });
    expect(activeSessions.has(sessionKey(ROOT, APP))).toBe(false);
    expect(mockCloseSession).toHaveBeenCalledWith('sess_new');
    expect(mockForkWorker).not.toHaveBeenCalled();
  });

  it.each(['codex', 'claude-code'])('keeps a default report trigger reportable on a live %s worker', async (cliId) => {
    mockGetBot.mockReturnValue({ config: { larkAppId: APP, cliId, workingDir: '/tmp' } });
    const send = vi.fn();
    const ds = existingDs({ worker: { killed: false, send } as any });
    const req = request({ sessionId: ds.session.sessionId });
    req.source = { type: 'ui', connectorId: 'botmux-report', requestId: 'report-mock' };
    req.envelope = { format: 'botmux-report/v1', sourceName: 'dependency', trusted: false, rawText: 'dependency verified' };
    const result = await triggerSessionTurn(req, {
      larkAppId: APP, activeSessions: new Map([[sessionKey(ROOT, APP), ds]]),
    });
    const turnId = send.mock.calls[0][0].turnId;
    expect(turnId).toBe(result.triggerId);
    const secret = 'test-binding-secret';
    const capability = 'a'.repeat(64);
    const relay = authorizeReportSessionRelayRequest({
      raw: { sessionId: ds.session.sessionId, dispatchRoot: ROOT, content: 'verified result', originCapability: capability },
      trustedHost: false,
      session: { sessionId: ds.session.sessionId, larkAppId: APP, chatId: CHAT,
        receiver: false, scope: 'thread', rootMessageId: ROOT,
        liveOrigin: { capability, turnId } },
      selfLarkAppId: APP,
      registry: { [ROOT]: { reportBinding: createDispatchReportBinding(secret, {
        dispatchRoot: ROOT, targetLarkAppId: 'app_parent', targetSessionId: 'parent',
        sourceName: 'task', issuedAt: new Date().toISOString(),
      }) } },
      bindingSecret: secret,
    });
    expect(relay).toMatchObject({ ok: true, target: { sessionId: 'parent' } });
    expect(ds.suppressedTriggerFinalTurns?.size ?? 0).toBe(0);
  });

  it('preserves the shared topic anchor for a default external trigger with its own turn id', async () => {
    const send = vi.fn();
    const ds = existingDs({ scope: 'chat', worker: { killed: false, send } as any,
      currentReplyTarget: { turnId: 'om_previous', rootMessageId: ROOT } });
    ds.session.scope = 'chat';
    ds.session.rootMessageId = CHAT;
    const result = await triggerSessionTurn(request({ sessionId: ds.session.sessionId }), {
      larkAppId: APP, activeSessions: new Map([[sessionKey(CHAT, APP), ds]]),
    });
    expect(send.mock.calls[0][0].turnId).toBe(result.triggerId);
    expect(resolveSessionReplyTarget(ds, result.triggerId)).toMatchObject({ mode: 'thread', rootMessageId: ROOT });
  });

  describe('trusted webhook payload (payloadTrusted)', () => {
    const trustedFollowUp = (target: Partial<TriggerRequest['target']>, trusted = true): TriggerRequest => ({
      source: { type: 'webhook', connectorId: 'conn_agent', requestId: 'req_t' },
      target: { kind: 'turn', botId: APP, ...target },
      envelope: { format: 'botmux.webhook.v1', sourceName: 'agent-platform', trusted: false, payload: { task: 'TASK_BODY <botmux_task>' } },
      instruction: 'OWNER_INSTRUCTION',
      ...(trusted ? { payloadTrusted: true as const } : {}),
      options: { asyncReturnSessionId: true },
    });
    const liveDs = (chatId: string) => {
      const send = vi.fn();
      const ds = existingDs({ chatId, worker: { killed: false, send } as any });
      ds.session.chatId = chatId;
      return { ds, send };
    };

    it('wires the trusted rendering and codex-app contexts into the existing-session dispatch', async () => {
      const { ds, send } = liveDs(CHAT);
      const res = await triggerSessionTurn(
        trustedFollowUp({ chatId: CHAT, sessionId: 'sess_existing' }),
        { larkAppId: APP, activeSessions: new Map([[sessionKey(ROOT, APP), ds]]) },
      );
      expect(res).toMatchObject({ ok: true, target: { sessionId: 'sess_existing' } });
      expect(send).toHaveBeenCalled();
      const [prompt, , opts] = mockBuildFollowUpCliInput.mock.calls.at(-1)!;
      expect(prompt).toContain('<botmux_external_event trusted="true">');
      expect(prompt).not.toContain('strictly as untrusted');
      expect(prompt.indexOf('OWNER_INSTRUCTION')).toBeLessThan(prompt.indexOf('TASK_BODY'));
      expect(prompt).not.toContain('TASK_BODY <botmux_task>');
      expect(opts.codexAppMessageContext).toBe('');
      expect(opts.codexAppApplicationContext).toBe(prompt);
    });

    it('default request keeps event data in the untrusted codex-app channel', async () => {
      const { ds } = liveDs(CHAT);
      await triggerSessionTurn(
        trustedFollowUp({ chatId: CHAT, sessionId: 'sess_existing' }, false),
        { larkAppId: APP, activeSessions: new Map([[sessionKey(ROOT, APP), ds]]) },
      );
      const [prompt, , opts] = mockBuildFollowUpCliInput.mock.calls.at(-1)!;
      expect(prompt).toContain('<botmux_external_event trusted="false">');
      expect(opts.codexAppMessageContext).toContain('TASK_BODY');
      expect(opts.codexAppApplicationContext).not.toContain('TASK_BODY');
    });

    it('refuses a trusted payload aimed at a session in another chat', async () => {
      const { ds, send } = liveDs('oc_other_chat');
      const res = await triggerSessionTurn(
        trustedFollowUp({ chatId: CHAT, sessionId: 'sess_existing' }),
        { larkAppId: APP, activeSessions: new Map([[sessionKey(ROOT, APP), ds]]) },
      );
      expect(res).toMatchObject({ ok: false, errorCode: 'chat_not_allowed' });
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses a trusted payload aimed by sessionId alone at a real group or headless session', async () => {
      for (const chatId of [CHAT, 'headless_abc']) {
        const { ds, send } = liveDs(chatId);
        const res = await triggerSessionTurn(
          trustedFollowUp({ sessionId: 'sess_existing' }),
          { larkAppId: APP, activeSessions: new Map([[sessionKey(ROOT, APP), ds]]) },
        );
        expect(res, chatId).toMatchObject({ ok: false, errorCode: 'chat_not_allowed' });
        expect(send).not.toHaveBeenCalled();
      }
    });

    it('lets a trusted caller continue its own HTTP async session by sessionId', async () => {
      const { ds, send } = liveDs('http_async_x1');
      const res = await triggerSessionTurn(
        trustedFollowUp({ sessionId: 'sess_existing' }),
        { larkAppId: APP, activeSessions: new Map([[sessionKey(ROOT, APP), ds]]) },
      );
      expect(res.ok).toBe(true);
      expect(send).toHaveBeenCalled();
    });

    it('leaves untrusted cross-chat sessionId delivery as before', async () => {
      const { ds, send } = liveDs('oc_other_chat');
      const res = await triggerSessionTurn(
        trustedFollowUp({ chatId: CHAT, sessionId: 'sess_existing' }, false),
        { larkAppId: APP, activeSessions: new Map([[sessionKey(ROOT, APP), ds]]) },
      );
      expect(res.ok).toBe(true);
      expect(send).toHaveBeenCalled();
    });
  });

  it('reuses an existing root session whose worker is live', async () => {
    const send = vi.fn();
    const ds = existingDs({ worker: { killed: false, send } as any });
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);
    const res = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: true, action: 'delivered', target: { sessionId: 'sess_existing', chatId: CHAT } });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockForkWorker).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ type: 'message', content: expect.stringContaining('follow:'), turnId: res.triggerId });
  });

  it.each([
    ['normal opening', undefined],
    ['raw text-to-Enter opening', '/goal OPENING_RAW_N'],
  ])('durably queues an external trigger behind a live %s activation', async (_label, pendingRawInput) => {
    const send = vi.fn();
    const ds = existingDs({
      worker: { killed: false, send } as any,
      initialStartPending: true,
      ...(pendingRawInput ? { pendingRawInput } : {}),
    });
    Object.assign(ds.session, {
      cliId: 'claude-code',
      queuedActivationPending: true,
      queuedActivationToken: 'opening-token',
      queuedActivationInput: { content: pendingRawInput ? '' : 'OPENING_N' },
      queuedActivationTurnId: 'turn-opening',
    });
    const beforeDispatch = vi.fn(() => ({ dispatchAttempt: 4 }));

    const res = await triggerSessionTurn(
      request(),
      { larkAppId: APP, activeSessions: new Map([[sessionKey(ROOT, APP), ds]]) },
      { stableTurnId: 'external-follower-n1', beforeDispatch },
    );

    expect(res).toMatchObject({
      ok: true,
      triggerId: 'external-follower-n1',
      action: 'queued',
    });
    expect(send).not.toHaveBeenCalled();
    expect(mockQueuedTailAdmission).toHaveBeenCalledWith(
      ds,
      expect.objectContaining({ content: expect.stringContaining('follow:') }),
      'external-follower-n1',
      { dispatchAttempt: 4 },
    );
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        turnId: 'external-follower-n1',
        dispatchAttempt: 4,
        cliInput: expect.objectContaining({ content: expect.stringContaining('follow:') }),
      }),
    ]);
    expect(mockRememberLastCliInput).toHaveBeenCalled();
  });

  it('reports failure and does not send or persist input history when gated tail admission fails', async () => {
    const send = vi.fn();
    const ds = existingDs({
      worker: { killed: false, send } as any,
      initialStartPending: true,
    });
    Object.assign(ds.session, {
      cliId: 'claude-code',
      queuedActivationPending: true,
      queuedActivationToken: 'opening-token',
      queuedActivationInput: { content: 'OPENING_N' },
    });
    mockQueuedTailAdmission.mockReturnValueOnce(false);

    const res = await triggerSessionTurn(request(), {
      larkAppId: APP,
      activeSessions: new Map([[sessionKey(ROOT, APP), ds]]),
    });

    expect(res).toMatchObject({ ok: false, errorCode: 'trigger_failed' });
    expect(send).not.toHaveBeenCalled();
    expect(ds.session.queuedActivationTail).toBeUndefined();
    expect(mockRememberLastCliInput).not.toHaveBeenCalled();
  });

  it('fold-in to a live session does NOT overwrite its frozen model/effort', async () => {
    // A per-turn override only applies to a freshly-created session. Folding into
    // an existing worker must never rewrite the session's frozen model/effort
    // (the existing-worker branch returns before the stamp; this locks that in).
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'codex-app', workingDir: '/tmp' },
      botName: 'Bot', botOpenId: 'ou_bot',
    });
    const send = vi.fn();
    const ds = existingDs({ worker: { killed: false, send } as any });
    ds.session.model = 'frozen-model';
    ds.session.reasoningEffort = 'low';
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);
    const req = request();
    (req.options as any) = { model: 'new-model', reasoningEffort: 'xhigh' };
    await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    expect(mockCreateSession).not.toHaveBeenCalled(); // folded in, not new
    expect(ds.session.model).toBe('frozen-model');
    expect(ds.spawnModelOverride).toBeUndefined();   // no per-trigger override either
    expect(ds.session.reasoningEffort).toBe('low');
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

  it('keeps an existing session in its own directory when the request carries options.workingDir', async () => {
    const ds = existingDs();
    ds.session.workingDir = '/repo/original';
    ds.workingDir = '/repo/original';
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);
    const req = request();
    req.options = { workingDir: tmpdir() };
    const res = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: true, target: { sessionId: 'sess_existing' } });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(ds.session.workingDir).toBe('/repo/original');
    expect(ds.workingDir).toBe('/repo/original');
  });

  it('fails closed for a dormant ledger-only owner instead of reforking over it', async () => {
    const ds = existingDs();
    ds.session.cliId = 'codex-app';
    ds.session.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-owned',
      turnId: 'turn-owned',
      state: 'prepared',
      content: 'durable existing turn',
      deliverySink: 'lark',
    }];

    const res = await triggerSessionTurn(request(), {
      larkAppId: APP,
      activeSessions: new Map([[sessionKey(ROOT, APP), ds]]),
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'session_not_runnable',
      error: expect.stringContaining('durable_owner'),
    });
    expect(mockForkWorker).not.toHaveBeenCalled();
    expect(mockRememberLastCliInput).not.toHaveBeenCalled();
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

  it('closes the unpublished trigger row when auto-worktree setup persistence fails', async () => {
    mockBotAutoWorktreeEnabled.mockReturnValue(true);
    mockUpdateSession
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('setup store unavailable'); });
    const activeSessions = new Map<string, DaemonSession>();

    await expect(triggerSessionTurn(request(), { larkAppId: APP, activeSessions }))
      .rejects.toThrow('setup store unavailable');

    expect(activeSessions.has(sessionKey(ROOT, APP))).toBe(false);
    expect(mockCloseSession).toHaveBeenCalledTimes(1);
    expect(mockCloseSession).toHaveBeenCalledWith('sess_new');
    expect(mockRunAutoWorktreeCommit).not.toHaveBeenCalled();
    expect(mockForkWorker).not.toHaveBeenCalled();
  });

  it('never closes an incumbent when the trigger creation path loses the key claim', async () => {
    mockBotAutoWorktreeEnabled.mockReturnValue(true);
    const send = vi.fn();
    const incumbent = existingDs({ worker: { killed: false, send } as any });
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), incumbent]]);

    const result = await triggerSessionTurn(request(), { larkAppId: APP, activeSessions });

    expect(result).toMatchObject({ ok: true, target: { sessionId: incumbent.session.sessionId } });
    expect(activeSessions.get(sessionKey(ROOT, APP))).toBe(incumbent);
    expect(mockCloseSession).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
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
      mockRememberLastCliInput.mock.calls.at(-1)?.[3],
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

  it('uses the persisted generation when a daemon-restored dormant session reforks', async () => {
    const ds = existingDs({ scope: 'chat', workerGeneration: undefined });
    ds.session.rootMessageId = CHAT;
    ds.session.workerGeneration = 8;
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(CHAT, APP), ds]]);
    const req = request({ sessionId: ds.session.sessionId, rootMessageId: undefined });
    const beforeDispatch = vi.fn(() => ({ dispatchAttempt: 6 }));

    await triggerSessionTurn(
      req,
      { larkAppId: APP, activeSessions },
      { stableTurnId: 'vcd_restored_generation_delivery', beforeDispatch },
    );

    expect(beforeDispatch).toHaveBeenCalledWith({
      sessionId: ds.session.sessionId,
      workerGeneration: 9,
    });
    expect(mockForkWorker).toHaveBeenCalledWith(
      ds,
      expect.objectContaining({ content: expect.stringContaining('follow:') }),
      {
        resume: true,
        turnId: 'vcd_restored_generation_delivery',
        dispatchAttempt: 6,
      },
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

  it('shares first-owner locking with a paused resume claim and reuses the resume winner', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    const key = sessionKey(ROOT, APP);
    const resumed = existingDs();
    resumed.session.cliId = 'claude-code';
    let resumeEntered!: () => void;
    let releaseResume!: () => void;
    const entered = new Promise<void>(resolve => { resumeEntered = resolve; });
    const paused = new Promise<void>(resolve => { releaseResume = resolve; });

    const resumeClaim = withActiveSessionKeyLock(activeSessions, key, async () => {
      expect(activeSessions.has(key)).toBe(false);
      resumeEntered();
      await paused;
      activeSessions.set(key, resumed);
    });
    await entered;

    const triggering = triggerSessionTurn(request(), { larkAppId: APP, activeSessions });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockCreateSession).not.toHaveBeenCalled();

    releaseResume();
    await resumeClaim;
    const result = await triggering;

    expect(result).toMatchObject({ ok: true, target: { sessionId: 'sess_existing' } });
    expect(activeSessions.get(key)).toBe(resumed);
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockForkWorker).toHaveBeenCalledWith(resumed, expect.anything(), expect.objectContaining({ resume: true }));
  });

  it('keeps the opening reservation and buffers when new-session fork pre-accept throws', async () => {
    mockForkWorker.mockImplementationOnce(() => { throw new Error('fork preaccept failed'); });
    const activeSessions = new Map<string, DaemonSession>();

    await expect(triggerSessionTurn(request(), { larkAppId: APP, activeSessions }))
      .rejects.toThrow('fork preaccept failed');

    const ds = activeSessions.get(sessionKey(ROOT, APP));
    expect(ds?.initialStartPending).toBe(true);
    expect(ds?.pendingPrompt).toContain('<botmux_external_event trusted="false">');
    expect(ds?.pendingCodexAppText).toBe('外部事件触发');
  });

  it('cleans the wait registry but retains the opening reservation when write-ahead throws', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    const req = request();
    req.options = { waitForFinalOutput: true, timeoutMs: 1000 };

    const result = await triggerSessionTurn(
      req,
      { larkAppId: APP, activeSessions },
      {
        stableTurnId: 'stable_write_ahead_failure',
        beforeDispatch: () => { throw new Error('write-ahead failed'); },
      },
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'trigger_failed', error: 'write-ahead failed' });
    const ds = activeSessions.get(sessionKey(ROOT, APP));
    expect(ds?.initialStartPending).toBe(true);
    expect(ds?.pendingWaitPromises?.size ?? 0).toBe(0);
    expect(mockForkWorker).not.toHaveBeenCalled();
  });

  it('requires chatId when rootMessageId is specified', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    const res = await triggerSessionTurn(request({ chatId: undefined }), { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: false, errorCode: 'target_required' });
    expect(mockGetMessageChatId).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });
});

describe('triggerSessionTurn suppressFinalOutput (loud connector opt-in)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testOnly_resetBotRegistry();
    mockBotAutoWorktreeEnabled.mockReturnValue(false);
    mockGetBot.mockReturnValue({
      config: { larkAppId: APP, cliId: 'claude-code', workingDir: '/tmp' },
      botName: 'Bot',
      botOpenId: 'ou_bot',
    });
    mockGetMessageChatId.mockResolvedValue(CHAT);
    mockCreateSession.mockImplementation((chatId: string, rootMessageId: string, title: string, chatType: 'group' | 'p2p') => ({
      sessionId: 'sess_new', chatId, rootMessageId, title, chatType,
      status: 'active', createdAt: '2026-06-01T00:00:00.000Z',
    }));
  });

  function loudReq(): TriggerRequest {
    const req = request();
    req.options = { suppressFinalOutput: true };
    return req;
  }

  // Reads the single armed turn id off the session, proving the connector opt-in
  // actually stamped THIS trigger turn (and only it) into the suppression map.
  function armedTurnId(ds: DaemonSession): string {
    const keys = [...(ds.suppressedTriggerFinalTurns?.keys() ?? [])];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^trg_/);
    return keys[0]!;
  }

  it('path 1 (live worker): arms the trigger turn and stamps it onto sendWorkerInput', async () => {
    const send = vi.fn();
    const ds = existingDs({ worker: { killed: false, send } as any });
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);

    const res = await triggerSessionTurn(loudReq(), { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: true, action: 'delivered' });
    const turnId = armedTurnId(ds);
    expect(res.triggerId).toBe(turnId);
    // The turnId must ride the worker input so the worker echoes it on final_output
    // and the daemon gate can match it.
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', turnId }));
  });

  it('path 2 (dormant existing): arms the trigger turn and forks with it as turnId', async () => {
    const ds = existingDs();
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);

    const res = await triggerSessionTurn(loudReq(), { larkAppId: APP, activeSessions });

    expect(res).toMatchObject({ ok: true, action: 'queued' });
    const turnId = armedTurnId(ds);
    expect(mockForkWorker).toHaveBeenCalledWith(
      ds,
      expect.objectContaining({ content: expect.stringContaining('follow:') }),
      expect.objectContaining({ resume: true, turnId }),
    );
  });

  it('path 3 (auto-worktree staging): arms the trigger turn and defers it via pendingTurnId', async () => {
    mockBotAutoWorktreeEnabled.mockReturnValue(true);
    const activeSessions = new Map<string, DaemonSession>();

    await triggerSessionTurn(loudReq(), { larkAppId: APP, activeSessions });

    const ds = activeSessions.get(sessionKey(ROOT, APP))!;
    const turnId = armedTurnId(ds);
    // The deferred fork in commitRepoSelection carries pendingTurnId, so the armed
    // suppression and the eventual fork agree on the turn id.
    expect(ds.pendingTurnId).toBe(turnId);
    expect(ds.pendingRepo).toBe(true);
    expect(mockRunAutoWorktreeCommit).toHaveBeenCalledWith(expect.objectContaining({ ds }));
  });

  it('path 4 (fresh new session): arms the trigger turn and forks with it as turnId', async () => {
    const activeSessions = new Map<string, DaemonSession>();

    const res = await triggerSessionTurn(loudReq(), { larkAppId: APP, activeSessions });

    const ds = activeSessions.get(sessionKey(ROOT, APP))!;
    const turnId = armedTurnId(ds);
    expect(res.triggerId).toBe(turnId);
    expect(mockForkWorker).toHaveBeenCalledWith(
      ds,
      expect.objectContaining({ content: expect.stringContaining('new:') }),
      turnId,
    );
  });

  it('does not arm suppression and forks loud when the connector opt-in is absent', async () => {
    const activeSessions = new Map<string, DaemonSession>();

    await triggerSessionTurn(request(), { larkAppId: APP, activeSessions });

    const ds = activeSessions.get(sessionKey(ROOT, APP))!;
    expect(ds.suppressedTriggerFinalTurns).toBeUndefined();
    // Loud delivery carries the same input owner without enabling suppression.
    expect(mockForkWorker).toHaveBeenCalledWith(ds, { content: expect.stringContaining('new:') }, mockRememberLastCliInput.mock.calls.at(-1)?.[3]);
    expect(mockRememberLastCliInput.mock.calls.at(-1)?.[3]).toEqual(expect.any(String));
  });

  it('N1: waitForFinalOutput never arms suppression even when the option is set', async () => {
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);
    const req = loudReq();
    req.options = { suppressFinalOutput: true, waitForFinalOutput: true, timeoutMs: 1000 };

    const promise = triggerSessionTurn(req, { larkAppId: APP, activeSessions });
    await vi.waitFor(() => expect(ds.pendingWaitPromises?.size).toBe(1));
    // Arming here would starve the HTTP caller: deliverFinalOutput resolves the
    // wait promise AFTER the suppression gate, so a suppressed final never returns.
    expect(ds.suppressedTriggerFinalTurns).toBeUndefined();
    [...ds.pendingWaitPromises!.values()][0]!.resolve('done');
    await expect(promise).resolves.toMatchObject({ ok: true, action: 'completed' });
  });

  it('N1: asyncReturnSessionId never arms suppression even when the option is set', async () => {
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);
    const req = loudReq();
    req.options = { suppressFinalOutput: true, asyncReturnSessionId: true };

    await triggerSessionTurn(req, { larkAppId: APP, activeSessions });
    expect(ds.suppressedTriggerFinalTurns).toBeUndefined();
  });

  it('P2: a chat-scope session with a fold-back anchor grants the trigger turn that same anchor', async () => {
    const anchor = { rootMessageId: 'om_shared_topic', turnId: 'om_human', updatedAt: 'x' };
    const ds = existingDs({
      scope: 'chat',
      worker: { killed: false, send: vi.fn() } as any,
      currentReplyTarget: anchor as any,
    });
    ds.session.scope = 'chat';
    ds.session.currentReplyTarget = anchor as any;
    ds.session.replyTargets = { om_human: { rootMessageId: 'om_shared_topic', updatedAt: 'x' } };
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT, APP), ds]]);

    await triggerSessionTurn(loudReq(), { larkAppId: APP, activeSessions });

    const turnId = armedTurnId(ds);
    // The synthetic trigger turn inherited the shared-topic anchor, so its
    // daemon-side sends (streaming card etc.) thread into the topic instead of
    // leaking to the group top level.
    expect(ds.session.replyTargets![turnId]).toMatchObject({ rootMessageId: 'om_shared_topic' });
    expect(resolveSessionReplyTarget(ds, turnId)).toEqual({ mode: 'thread', rootMessageId: 'om_shared_topic' });
  });
});
