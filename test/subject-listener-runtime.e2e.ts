import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';

const {
  TEST_DATA_DIR,
  sessionReplyMock,
  buildStreamingCardMock,
} = vi.hoisted(() => ({
  TEST_DATA_DIR: '/tmp/botmux-subject-runtime-e2e',
  sessionReplyMock: vi.fn(async () => 'om_unexpected_reply'),
  buildStreamingCardMock: vi.fn(() => '{}'),
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
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
  DEFAULT_SUBJECT_FALLBACK_MESSAGES: 20,
  MAX_SUBJECT_FALLBACK_MESSAGES: 200,
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
  initWorkerPool,
  registerSubjectListenerTurn,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import type { DaemonSession, SubjectListenerTurnOutcome } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import {
  evaluateMessageListener,
  renderMessageListenerPrompt,
} from '../src/services/message-listener.js';
import {
  loadSubjectListenerContext,
  type SubjectListenerMessageScanOptions,
} from '../src/services/subject-listener-context.js';
import { readSubjectListenerCursor } from '../src/services/subject-listener-cursor-store.js';

function message(messageId: string, createTime: number, text: string) {
  return {
    message_id: messageId,
    create_time: String(createTime),
    chat_id: 'oc_subject',
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text }),
  };
}

function scan(newestFirst: any[]) {
  return async (_appId: string, _chatId: string, options: SubjectListenerMessageScanOptions = {}) => {
    const result: any[] = [];
    for (const item of newestFirst) {
      result.push(item);
      if (options.stopAfter?.(item, result.length)) break;
    }
    return result.reverse();
  };
}

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
      sessionId: 'sid-subject-e2e',
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

function bot(): any {
  return {
    botOpenId: 'ou_bot',
    config: {
      larkAppId: 'app_subject',
      messageListeners: {
        oc_subject: {
          enabled: true,
          behavior: 'subject',
          prompt: '只在能推进协作时介入',
          subjectPolicy: { context: { source: 'lark', fallbackMessages: 20 } },
        },
      },
    },
  };
}

beforeEach(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  sessionReplyMock.mockClear();
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

describe('Subject listener main path', () => {
  it('未 @ 消息从飞书增量进入 Subject，静默提交游标，下一条从该游标继续', async () => {
    const firstEvent = message('om_first', 200, '先看一下当前事故上下文');
    const firstMatch = evaluateMessageListener({
      bot: bot(),
      chatId: 'oc_subject',
      message: firstEvent,
      senderOpenId: 'ou_alice',
      senderName: '值班成员',
      senderTypeRaw: 'user',
      explicitlyMentionedThisBot: false,
    });
    expect(firstMatch?.behavior).toBe('subject');

    const firstSnapshot = await loadSubjectListenerContext({
      larkAppId: 'app_subject',
      chatId: 'oc_subject',
      fallbackMessages: firstMatch!.subjectPolicy!.context.fallbackMessages,
      triggerMessage: firstEvent,
      trigger: {
        messageId: firstMatch!.trigger.messageId,
        createTime: firstMatch!.trigger.createTime!,
      },
    }, {
      listChatMessagesUntil: scan([
        message('om_late', 300, '触发后的消息不得读入'),
        message('om_first', 200, 'REST 副本'),
        message('om_seed', 100, '群里的前置事实'),
      ]),
    });
    const firstPrompt = renderMessageListenerPrompt(firstMatch!, {
      chatId: 'oc_subject',
      chatName: '事故协作群',
      chatDescription: '先了解上下文再决定是否介入',
      snapshot: firstSnapshot,
    });
    expect(firstPrompt).toContain('<subject_protocol trusted="true">');
    expect(firstPrompt).toContain('<subject_lark_context trusted="false">');
    expect(firstPrompt).toContain('群里的前置事实');
    expect(firstPrompt).not.toContain('触发后的消息不得读入');

    const ds = makeDs();
    const outcomes: SubjectListenerTurnOutcome[] = [];
    registerSubjectListenerTurn(ds, 'om_first', {
      chatId: 'oc_subject',
      candidateCursor: firstSnapshot.candidateCursor,
      completion: {
        claimed: false,
        settle: outcome => outcomes.push(outcome),
      },
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', {
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'om_first',
      status: 'completed',
      outputDisposition: 'nothing_to_send',
    } satisfies Extract<WorkerToDaemon, { type: 'turn_terminal' }>);

    await vi.waitFor(() => expect(outcomes).toEqual(['succeeded']));
    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(buildStreamingCardMock).not.toHaveBeenCalled();
    const committed = readSubjectListenerCursor(TEST_DATA_DIR, 'app_subject', 'oc_subject');
    expect(committed).toEqual({ messageId: 'om_first', createTime: '200' });

    const secondEvent = message('om_second', 400, '下一条未 @ 消息');
    const secondMatch = evaluateMessageListener({
      bot: bot(),
      chatId: 'oc_subject',
      message: secondEvent,
      senderOpenId: 'ou_bob',
      senderName: '另一位成员',
      senderTypeRaw: 'user',
      explicitlyMentionedThisBot: false,
    });
    const secondSnapshot = await loadSubjectListenerContext({
      larkAppId: 'app_subject',
      chatId: 'oc_subject',
      cursor: committed,
      fallbackMessages: 20,
      triggerMessage: secondEvent,
      trigger: {
        messageId: secondMatch!.trigger.messageId,
        createTime: secondMatch!.trigger.createTime!,
      },
    }, {
      listChatMessagesUntil: scan([
        message('om_second', 400, 'REST 副本'),
        message('om_between', 350, '游标后的新增事实'),
        firstEvent,
        message('om_seed', 100, '已消费的旧事实'),
      ]),
    });

    expect(secondSnapshot.continuity).toBe('continuous');
    expect(secondSnapshot.messages.map(item => item.message_id)).toEqual([
      'om_between', 'om_second',
    ]);
    expect(secondSnapshot.messages.at(-1)).toBe(secondEvent);
  });
});
