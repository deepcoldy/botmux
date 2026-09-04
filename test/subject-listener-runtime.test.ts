import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';

const {
  TEST_DATA_DIR,
  sessionReplyMock,
  addReactionMock,
  buildStreamingCardMock,
} = vi.hoisted(() => ({
  TEST_DATA_DIR: '/tmp/botmux-subject-runtime-test',
  sessionReplyMock: vi.fn(async () => 'om_visible_reply'),
  addReactionMock: vi.fn(async () => 'reaction_id'),
  buildStreamingCardMock: vi.fn(() => '{}'),
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  addReaction: (...args: any[]) => addReactionMock(...args),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  resolveCurrentChatBotOpenIdsByLarkAppIds: vi.fn(async () => ({
    ok: false, error: 'not_needed', message: 'not_needed',
  })),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: (...args: any[]) => buildStreamingCardMock(...args),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Codex'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_subject', larkAppSecret: 'secret', cliId: 'codex' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'Subject Bot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  getOwnerOpenId: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveUsageDisplay: vi.fn(() => 'footer'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: TEST_DATA_DIR },
    daemon: { backendType: 'pty', cliId: 'codex' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import {
  auxUiSuppressedFor,
  initWorkerPool,
  isSubjectListenerTurn,
  recordTurnExplicitMention,
  registerSubjectListenerTurn,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import type { DaemonSession, SubjectListenerTurnOutcome } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import {
  evaluateMessageListener,
  renderMessageListenerPrompt,
} from '../src/services/message-listener.js';
import { readSubjectListenerCursor } from '../src/services/subject-listener-cursor-store.js';

function makeDs(): DaemonSession {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.pid = 99999;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return {
    session: {
      sessionId: 'sid-subject-runtime',
      rootMessageId: 'om_root',
      chatId: 'oc_subject',
      title: 'fixture',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: 'codex',
    },
    worker,
    workerPort: 0,
    workerToken: 'token',
    larkAppId: 'app_subject',
    chatId: 'oc_subject',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: false,
  } as any;
}

function terminal(
  turnId: string,
  status: 'completed' | 'failed' | 'cancelled' | 'ambiguous',
  outputDisposition?: 'nothing_to_send',
): Extract<WorkerToDaemon, { type: 'turn_terminal' }> {
  return {
    type: 'turn_terminal',
    sessionId: 'sid-subject-runtime',
    turnId,
    status,
    ...(outputDisposition ? { outputDisposition } : {}),
  } as Extract<WorkerToDaemon, { type: 'turn_terminal' }>;
}

function armSubject(ds: DaemonSession, turnId: string, createTime: string) {
  const outcomes: SubjectListenerTurnOutcome[] = [];
  const completion = {
    claimed: false,
    settle: (outcome: SubjectListenerTurnOutcome) => outcomes.push(outcome),
  };
  registerSubjectListenerTurn(ds, turnId, {
    chatId: 'oc_subject',
    candidateCursor: { messageId: turnId, createTime },
    completion,
  });
  return { completion, outcomes };
}

function subjectBot(): any {
  return {
    botOpenId: 'ou_bot',
    config: {
      larkAppId: 'app_subject',
      messageListeners: {
        oc_subject: {
          enabled: true,
          behavior: 'subject',
          prompt: '只关注需要协作的工作',
          subjectPolicy: { context: { source: 'lark', fallbackMessages: 20 } },
        },
      },
    },
  };
}

function inbound(messageId: string, createTime: string) {
  return {
    message_id: messageId,
    create_time: createTime,
    chat_id: 'oc_subject',
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text: '这条需要处理吗？' }),
  };
}

beforeEach(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  sessionReplyMock.mockReset().mockResolvedValue('om_visible_reply');
  addReactionMock.mockClear();
  buildStreamingCardMock.mockClear();
  initWorkerPool({
    sessionReply: sessionReplyMock,
    getSessionWorkingDir: () => '/tmp',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  } as any);
});

afterEach(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('Subject listener runtime lifecycle', () => {
  it('静默成功：nothing_to_send 不产生回复/处理卡/状态 reaction，并提交触发游标', async () => {
    const ds = makeDs();
    const turnId = 'om_subject_silent';
    const { completion, outcomes } = armSubject(ds, turnId, '1000');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    expect(completion.claimed).toBe(true);
    expect(isSubjectListenerTurn(ds, turnId)).toBe(true);
    expect(auxUiSuppressedFor(ds, turnId)).toBe(true);

    (ds.worker as any).emit('message', terminal(turnId, 'completed', 'nothing_to_send'));

    await vi.waitFor(() => expect(outcomes).toEqual(['succeeded']));
    expect(readSubjectListenerCursor(TEST_DATA_DIR, 'app_subject', 'oc_subject')).toEqual({
      messageId: turnId,
      createTime: '1000',
    });
    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(buildStreamingCardMock).not.toHaveBeenCalled();
    expect(addReactionMock).not.toHaveBeenCalled();
  });

  it('可见回复只有在飞书发送成功后才提交游标并释放 Subject lane', async () => {
    const ds = makeDs();
    const turnId = 'om_subject_reply';
    const { outcomes } = armSubject(ds, turnId, '1100');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output',
      sessionId: ds.session.sessionId,
      turnId,
      content: '需要介入，这是可见回复',
      lastUuid: 'subject-visible-1',
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

    expect(readSubjectListenerCursor(TEST_DATA_DIR, 'app_subject', 'oc_subject')).toBeUndefined();
    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(outcomes).toEqual(['succeeded']));
    expect(readSubjectListenerCursor(TEST_DATA_DIR, 'app_subject', 'oc_subject')).toEqual({
      messageId: turnId,
      createTime: '1100',
    });
  });

  it.each(['failed', 'cancelled', 'ambiguous'] as const)(
    '执行失败：%s 终态不推进游标且不泄漏失败卡',
    async status => {
      const ds = makeDs();
      const turnId = `om_subject_${status}`;
      const { outcomes } = armSubject(ds, turnId, '1200');
      __testOnly_setupWorkerHandlers(ds, ds.worker as any);

      (ds.worker as any).emit('message', terminal(turnId, status));

      await vi.waitFor(() => expect(outcomes).toEqual(['failed']));
      expect(readSubjectListenerCursor(TEST_DATA_DIR, 'app_subject', 'oc_subject')).toBeUndefined();
      expect(sessionReplyMock).not.toHaveBeenCalled();
      expect(buildStreamingCardMock).not.toHaveBeenCalled();
    },
  );
});

describe('Subject routing and deterministic prompt', () => {
  it('明确 @：subject matcher 必须绕过，普通路径的 nothing_to_send 仍产生可见静默回执', async () => {
    const explicitlyMentioned = evaluateMessageListener({
      bot: subjectBot(),
      chatId: 'oc_subject',
      message: inbound('om_explicit_at', '1300'),
      senderOpenId: 'ou_user',
      senderTypeRaw: 'user',
      explicitlyMentionedThisBot: true,
    });
    expect(explicitlyMentioned).toBeUndefined();

    const ds = makeDs();
    expect(isSubjectListenerTurn(ds, 'om_explicit_at')).toBe(false);
    expect(auxUiSuppressedFor(ds, 'om_explicit_at')).toBe(false);
    recordTurnExplicitMention(ds, 'om_explicit_at', true);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', terminal('om_explicit_at', 'completed', 'nothing_to_send'));

    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));
    expect(String(sessionReplyMock.mock.calls[0]?.[1])).toContain('自动回执');
  });

  it('未 @ 的 Subject 允许空 prompt，并确定性注入可信协议与飞书群/发送者/历史', () => {
    const bot = subjectBot();
    bot.config.messageListeners.oc_subject.prompt = '';
    const match = evaluateMessageListener({
      bot,
      chatId: 'oc_subject',
      message: inbound('om_subject', '1400'),
      senderOpenId: 'ou_user',
      senderName: '群成员',
      senderTypeRaw: 'user',
      explicitlyMentionedThisBot: false,
    });

    expect(match).toMatchObject({
      behavior: 'subject',
      prompt: '',
      trigger: { messageId: 'om_subject', createTime: '1400' },
    });
    const rendered = renderMessageListenerPrompt(match!, {
      chatId: 'oc_subject',
      chatName: '事故协作群',
      chatDescription: '这里的内容均来自飞书',
      snapshot: {
        source: 'lark',
        continuity: 'cold_start',
        messages: [inbound('om_subject', '1400')],
        candidateCursor: { messageId: 'om_subject', createTime: '1400' },
      },
    });
    expect(rendered).toContain('<subject_protocol trusted="true">');
    expect(rendered).toContain('BOTMUX_NOTHING_TO_SEND');
    expect(rendered).toContain('<subject_lark_context trusted="false">');
    expect(rendered).toContain('name="事故协作群"');
    expect(rendered).toContain('sender_name="群成员"');
    expect(rendered).toContain('continuity="cold_start"');
    expect(rendered).not.toContain('<message_listener>');
  });

  it('behavior 缺省仍是 legacy prompt listener，不注入 Subject 协议', () => {
    const bot: any = subjectBot();
    bot.config.messageListeners.oc_subject = {
      enabled: true,
      prompt: '旧监听器提示词',
    };
    const match = evaluateMessageListener({
      bot,
      chatId: 'oc_subject',
      message: inbound('om_legacy', '1500'),
      senderOpenId: 'ou_user',
      senderTypeRaw: 'user',
      explicitlyMentionedThisBot: false,
    });

    expect(match?.behavior).toBe('prompt');
    const rendered = renderMessageListenerPrompt(match!);
    expect(rendered).toContain('<message_listener>');
    expect(rendered).toContain('<instruction>');
    expect(rendered).toContain('旧监听器提示词');
    expect(rendered).toContain('</instruction>');
    expect(rendered).not.toContain('<subject_protocol');
  });
});
