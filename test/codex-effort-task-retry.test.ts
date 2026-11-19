import {
  __testOnly_durablePrimaryWorkerAdmission,
  __testOnly_handleDocComment,
  __testOnly_recordDurablePrimaryInputCommit,
} from '../src/daemon.js';
import { putDocSubscription, type DocSubscription } from '../src/services/doc-subs-store.js';
/**
 * 普通消息处理链终态失败的可行动提示（ingress failure notice）。
 *
 * transport 已 ACK（用户看到消息发出去了）之后，异常把 handleThreadReply /
 * handleNewTopic 整条投递链掀翻时，此前只剩 event-dispatcher 的 log-only
 * catch——用户视角就是机器人吞消息。本文件驱动真实路由入口断言：
 *   - 投递链异常 → 话题里收到一条可行动提示，且原错误原样重抛（dispatcher
 *     既有日志语义不变）；
 *   - 提示本身发送失败 → 只降级为 warn，原错误仍然重抛，不被通知错误顶掉；
 *   - 正常投递 → 不发提示（无误报）。
 *
 * 提示文案按接纳阶段区分（PR #846 review）：本轮 inbound 已被真正接纳后
 *（durable tail、pendingRepo staging、live worker 收下、fork 成功——注意
 * messageQueue append 不算接纳，queues/*.jsonl 仅供 dashboard 预览），失败
 * 只可能出在接纳之后的状态回复支路——此时绝不能提示「请重发」（重发会让同一
 * 任务再次入队、CLI 重复执行），改回「已接收勿重发」的澄清，且失败处理本身
 * 不得产生第二个队列项。反向约束同样被钉住：refork 抛错、/vc-auth 纯拒绝等
 * 未接纳失败必须保持「请重发」。
 *
 * Run:  pnpm vitest run test/daemon-ordinary-ingress-failure-notice.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-ingress-notice-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  const sessions = new Map<string, any>();
  return {
    dataDir,
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_top'),
    getMessageDetail: vi.fn(),
    addReaction: vi.fn(async () => 'reaction_received'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveTargetAppOpenId: vi.fn(async (_appId: string, unionId: string) => ({
      status: 'resolved' as const,
      openId: `ou_target_${unionId.slice(3)}`,
    })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined, senderType: string | undefined) => (
      openId
        ? { openId, type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const }
        : undefined
    )),
    sessions,
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') => {
      const session = {
        sessionId: `sess-fake-${++seq}`,
        chatId,
        rootMessageId,
        title,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        chatType,
      };
      sessions.set(session.sessionId, session);
      return session;
    }),
    createSessionWithOwnedMutation: vi.fn((input: any, mutate: (fresh: Map<string, any>, draft: any) => unknown) => {
      const draft = {
        sessionId: `sess-fake-${++seq}`,
        chatId: input.chatId,
        rootMessageId: input.rootMessageId,
        title: input.title,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        chatType: input.chatType,
      };
      const rows = new Map(input.ownedSessionIds.map((id: string) => [id, structuredClone(sessions.get(id))]));
      const result = mutate(rows, draft);
      for (const [id, session] of rows) sessions.set(id, session);
      sessions.set(draft.sessionId, draft);
      return { session: draft, result, rows };
    }),
    updateSession: vi.fn((session: any) => { sessions.set(session.sessionId, session); }),
    getSession: vi.fn((sessionId: string) => sessions.get(sessionId)),
    listSessionsStrict: vi.fn(() => [...sessions.values()]),
    mutateOwnedSessionsAtomically: vi.fn((ids: string[], mutate: (fresh: Map<string, any>) => unknown) => {
      const fresh = new Map(ids.map(id => [id, structuredClone(sessions.get(id))]));
      const result = mutate(fresh);
      for (const [id, session] of fresh) sessions.set(id, session);
      return { result, rows: fresh };
    }),
    closeSession: vi.fn((sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) session.status = 'closed';
    }),
    forkWorker: vi.fn((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    }),
    sendWorkerInput: vi.fn(() => true),
    updateCodexCliEffort: vi.fn(async () => ({ status: 'future_only', reason: 'cli_next_turn' })),
    scanMultipleProjects: vi.fn(() => [] as any[]),
    getAvailableBots: vi.fn(async () => [] as any[]),
    downloadResources: vi.fn(async () => ({ attachments: [], needLogin: false })),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
    getMessageDetail: mocks.getMessageDetail,
    addReaction: mocks.addReaction,
    getChatMode: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
    resolveTargetAppOpenId: mocks.resolveTargetAppOpenId,
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return {
    ...actual,
    createSession: mocks.createSession,
    createSessionWithOwnedMutation: mocks.createSessionWithOwnedMutation,
    updateSession: mocks.updateSession,
    getSession: mocks.getSession,
    getOwnedSession: mocks.getSession,
    listSessionsStrict: mocks.listSessionsStrict,
    mutateOwnedSessionsAtomically: mocks.mutateOwnedSessionsAtomically,
    closeSession: mocks.closeSession,
  };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return { ...actual, forkWorker: mocks.forkWorker,
    sendWorkerInput: (...args: any[]) => String(args[2] ?? '').startsWith('om_effort')
      ? mocks.sendWorkerInput(...args) : actual.sendWorkerInput(...args),
    updateCodexCliEffort: mocks.updateCodexCliEffort };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return {
    ...actual,
    getAvailableBots: mocks.getAvailableBots,
    downloadResources: mocks.downloadResources,
  };
});

vi.mock('../src/services/project-scanner.js', async () => {
  const actual = await vi.importActual<any>('../src/services/project-scanner.js');
  return { ...actual, scanMultipleProjects: mocks.scanMultipleProjects };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

import { mkdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import { createDurableSessionFacade } from '../src/services/durable-session-facade.js';
import { admitDurableLarkSession, parseDurablePrimarySessionRecord } from '../src/services/durable-session-primary.js';
import { createDurableLarkCanonicalDispatch } from '../src/services/durable-lark-canonical-dispatch.js';
import { durableLarkMessageEvent, parseDurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';

import { getBot, registerBot } from '../src/bot-registry.js';
import { sessionKey } from '../src/core/types.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_completedTurnHasCrossPrincipalFollower as completedTurnHasCrossPrincipalFollower,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
  __testOnly_driveCrossPrincipalInterruptions as driveCrossPrincipalInterruptions,
  __testOnly_forkReservedInitialSession as forkReservedInitialSession,
  __testOnly_notifyCrossPrincipalTerminal as notifyCrossPrincipalTerminal,
  __testOnly_notifyOrdinaryIngressFailure as notifyOrdinaryIngressFailure,
  __testOnly_resolveXpiHumanOpenId as resolveXpiHumanOpenId,
  __testOnly_restoreSessionsAndScheduleStartupRecovery as restoreSessionsAndScheduleStartupRecovery,
} from '../src/daemon.js';
import { getActiveSessionsRegistry, setActiveSessionsRegistry } from '../src/core/worker-pool.js';
import { XpiSharedCwdQueueFullError } from '../src/core/xpi-shared-cwd-admission.js';
import { MissingWorkingDirError } from '../src/core/working-dir-recovery.js';
import {
  findPendingAskByAnchor,
  setCardDispatcher,
  setCanTalkChecker,
  tryResolveAsk,
} from '../src/core/ask-broker.js';
import { createLarkAskCardDispatcher } from '../src/im/lark/ask-card.js';
import { t as tr, localeForBot } from '../src/i18n/index.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'cli_effort_retry';
const CHAT = 'oc_ingress_notice_chat';
const OWNER = 'ou_owner';
const NOW = new Date().toISOString();

function makeEventData(messageId: string, text: string, rootId?: string): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: messageId,
      root_id: rootId,
      chat_id: CHAT,
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  };
}

function makeBotEventData(messageId: string, text: string, rootId: string): any {
  return {
    sender: {
      sender_id: { open_id: 'ou_proposer_bot', union_id: 'on_proposer_bot' },
      sender_type: 'app',
    },
    message: {
      message_id: messageId,
      root_id: rootId,
      chat_id: CHAT,
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  };
}

function makeCtx(anchor: string, messageId: string): any {
  return {
    chatId: CHAT,
    messageId,
    chatType: 'group' as const,
    scope: 'thread' as const,
    anchor,
    larkAppId: APP,
  };
}

function seedThreadSession(anchor: string, title: string): DaemonSession {
  const ds = {
    scope: 'thread',
    chatId: CHAT,
    chatType: 'group',
    larkAppId: APP,
    worker: null,
    workerPort: null,
    workerToken: null,
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    ownerOpenId: OWNER,
    session: {
      sessionId: 'sess-seeded-' + Math.random().toString(36).slice(2),
      chatId: CHAT,
      rootMessageId: anchor,
      title,
      status: 'active',
      createdAt: NOW,
      larkAppId: APP,
    },
  } as unknown as DaemonSession;
  activeSessions.set(sessionKey(anchor, APP), ds);
  return ds;
}

/** All text replied through the mocked Lark client in this test, joined. */
function repliedText(): string {
  return [...mocks.replyMessage.mock.calls, ...mocks.sendMessage.mock.calls]
    .map(call => String(call[2] ?? ''))
    .join('\n');
}

function expectedNotice(): string {
  return tr('daemon.ordinary_ingress_failed', undefined, localeForBot(APP));
}

describe('ordinary ingress terminal failure → actionable notice', () => {
  it('clears the retry reason when provider proof arrives after acceptance while the wait is pending', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      getBot(APP).config.cliId = 'codex';
      const anchor = 'om_effort_delayed_proof';
      const messageId = 'om_effort_delayed_proof_task';
      const ds = seedThreadSession(anchor, 'seeded');
      ds.session.cliId = 'codex';
      ds.session.backendType = 'tmux';
      ds.session.workerGeneration = 1;
      ds.workerGeneration = 1;
      ds.session.cliSessionId = 'native';
      ds.worker = { killed: false, send: vi.fn() } as any;
      ds.cliReady = true;
      ds.hasHistory = true;
      let accepted!: () => void;
      const acceptance = new Promise<void>(resolve => { accepted = resolve; });
      mocks.sendWorkerInput.mockImplementationOnce(() => {
        setTimeout(() => __testOnly_recordDurablePrimaryInputCommit(ds, {
          type: 'turn_input_committed', turnId: messageId, durablePrimaryInbox: true,
        } as any, 1), 10);
        accepted();
        return true;
      });
      const ctx = { ...makeCtx(anchor, messageId), checkpointPreAdmissionSession: async () => {},
        durablePrimaryDispatch: { attempt: 1, signal: controller.signal } };
      let settled = false;
      const handling = handleThreadReply(makeEventData(messageId, '/effort ultra check', anchor), ctx)
        .then(() => { settled = true; });
      await acceptance;
      expect(settled).toBe(false);
      expect(ds.session.durablePrimaryInputCommits).toBeUndefined();
      await vi.advanceTimersByTimeAsync(10);
      await handling;
      expect(ctx.ingressAdmission.admitted).toBe(true);
      expect(ctx.ingressAdmission.retryReason).toBeUndefined();
      expect(ds.session.durablePrimaryInputCommits).toEqual([expect.objectContaining({ turnId: messageId })]);
      expect(mocks.sendWorkerInput).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      vi.useRealTimers();
    }
  });

  it('retries the confirmed attached task without reopening the effort menu', async () => {
    getBot(APP).config.cliId = 'codex';
    const anchor = 'om_effort_review_primary';
    const ds = seedThreadSession(anchor, 'seeded');
    ds.session.cliId = 'codex';
    ds.session.backendType = 'tmux';
    ds.session.reasoningEffort = 'high';
    ds.session.cliLaunchSnapshot = { cliId: 'codex', reasoningEffort: 'high' } as any;
    ds.initConfig = { cliId: 'codex', backendType: 'tmux', reasoningEffort: 'high' } as any;
    ds.session.workerGeneration = 1;
    ds.workerGeneration = 1;
    ds.session.cliSessionId = 'native-1';
    const worker = Object.assign(new EventEmitter(), { killed: false, connected: true, send: vi.fn() });
    ds.worker = worker as any;
    ds.workerReady = true;
    ds.cliReady = true;
    ds.hasHistory = true;
    const actualPool = await vi.importActual<any>('../src/core/worker-pool.js');
    worker.send.mockImplementation((request: any) => {
      if (request.type === 'codex_cli_effort') queueMicrotask(() => {
        worker.emit('message', { type: 'codex_cli_effort_result', requestId: request.requestId,
          status: 'future_only', reason: 'cli_next_turn' });
        // claude_exit clears cliReady before awaiting lifecycle reconciliation.
        // The same live worker, generation and native session remain current.
        ds.cliReady = false;
      });
      return true;
    });
    mocks.updateCodexCliEffort.mockImplementation((target: any, effort: string) =>
      actualPool.updateCodexCliEffort(target, effort));
    const messageId = 'om_effort_review_primary_task';
    const checkpoint = vi.fn(async (session: any) => {
      expect(session.reasoningEffort).toBe('ultra');
      expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    });
    const first = { ...makeCtx(anchor, messageId),
      checkpointPreAdmissionSession: checkpoint,
      durablePrimaryDispatch: { attempt: 1, signal: new AbortController().signal } };
    await handleThreadReply(makeEventData(messageId, '/effort ultra 检查投递', anchor), first);
    expect(first.ingressAdmission.retryReason).toBe('session has an unfinished turn');
    expect(first.ingressAdmission.admitted).toBe(false);
    expect(ds.session.reasoningEffort).toBe('ultra');
    expect(ds.initConfig.reasoningEffort).toBe('ultra');
    expect(worker.send.mock.calls.filter(([request]) => request.type === 'codex_cli_effort')).toHaveLength(1);
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    // A reconstructed local Session object retains the proof loaded from storage.
    ds.session = structuredClone(ds.session);
    const second = { ...makeCtx(anchor, messageId),
      checkpointPreAdmissionSession: checkpoint,
      durablePrimaryDispatch: { attempt: 2, signal: new AbortController().signal } };
    await handleThreadReply(makeEventData(messageId, '/effort ultra 检查投递', anchor), second);
    expect(mocks.updateCodexCliEffort).toHaveBeenCalledTimes(1);
    expect(worker.send.mock.calls.filter(([request]) => request.type === 'codex_cli_effort')).toHaveLength(1);
    expect(second.ingressAdmission.admitted).toBe(false);
    expect(second.ingressAdmission.retryReason).toBe('session has an unfinished turn');
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    expect(checkpoint).toHaveBeenCalled();
    ds.cliReady = true;
    mocks.sendWorkerInput.mockImplementationOnce(() => {
      __testOnly_recordDurablePrimaryInputCommit(ds, {
        type: 'turn_input_committed', turnId: messageId, durablePrimaryInbox: true,
      } as any, 1);
      return true;
    });
    const third = { ...makeCtx(anchor, messageId),
      checkpointPreAdmissionSession: async () => {},
      durablePrimaryDispatch: { attempt: 3, signal: new AbortController().signal } };
    await handleThreadReply(makeEventData(messageId, '/effort ultra 检查投递', anchor), third);
    expect(third.ingressAdmission.admitted).toBe(true);
    expect(third.ingressAdmission.retryReason).toBeUndefined();
    expect(mocks.sendWorkerInput).toHaveBeenCalledOnce();
    expect(worker.send.mock.calls.filter(([request]) => request.type === 'codex_cli_effort')).toHaveLength(1);
    ds.workerGeneration = 2;
    ds.session.workerGeneration = 2;
    ds.worker = null;
    const fourth = { ...makeCtx(anchor, messageId),
      checkpointPreAdmissionSession: async () => {},
      durablePrimaryDispatch: { attempt: 4, signal: new AbortController().signal } };
    await handleThreadReply(makeEventData(messageId, '/effort ultra 检查投递', anchor), fourth);
    expect(fourth.ingressAdmission.admitted).toBe(true);
    expect(mocks.sendWorkerInput).toHaveBeenCalledOnce();
    expect(mocks.updateCodexCliEffort).toHaveBeenCalledOnce();
  });

  it('keeps a confirmed task retryable while its canonical checkpoint is unavailable', async () => {
    getBot(APP).config.cliId = 'codex';
    const anchor = 'om_effort_checkpoint';
    const ds = seedThreadSession(anchor, 'seeded');
    ds.session.cliId = 'codex';
    ds.worker = { killed: false, send: vi.fn() } as any;
    ds.session.workerGeneration = 1;
    ds.workerGeneration = 1;
    ds.session.cliSessionId = 'native';
    const checkpoint = vi.fn(async () => { throw new Error('provider unavailable'); });
    const input = makeEventData('om_effort_checkpoint_task', '/effort ultra check', anchor);
    for (const attempt of [1, 2]) {
      const ctx = { ...makeCtx(anchor, 'om_effort_checkpoint_task'), checkpointPreAdmissionSession: checkpoint,
        durablePrimaryDispatch: { attempt, signal: new AbortController().signal } };
      await handleThreadReply(input, ctx);
      expect(ctx.ingressAdmission.retryReason).toBeTruthy();
      expect(ctx.ingressAdmission.admitted).toBe(false);
    }
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(mocks.updateCodexCliEffort).toHaveBeenCalledOnce();
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
  });

  it('completes a canonical terminal task restored during checkpoint without input replay', async () => {
    getBot(APP).config.cliId = 'codex';
    const anchor = 'om_effort_terminal_sync';
    const ds = seedThreadSession(anchor, 'seeded');
    ds.session.cliId = 'codex';
    ds.worker = { killed: false, send: vi.fn() } as any;
    ds.cliReady = true;
    const ctx = { ...makeCtx(anchor, 'om_effort_terminal_sync_task'),
      checkpointPreAdmissionSession: async (session: any) => {
        session.codexEffortTaskConfirmations = session.codexEffortTaskConfirmations.map((item: any) => ({ ...item, terminal: 'admitted' }));
      }, durablePrimaryDispatch: { attempt: 1, signal: new AbortController().signal } };
    await handleThreadReply(makeEventData(ctx.messageId, '/effort ultra check', anchor), ctx);
    expect(ctx.ingressAdmission.admitted).toBe(true);
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
  });

  it('does not checkpoint an old runtime while the canonical write is waiting', async () => {
    getBot(APP).config.cliId = 'codex';
    const anchor = 'om_effort_checkpoint_race';
    const ds = seedThreadSession(anchor, 'seeded');
    ds.session.cliId = 'codex';
    ds.worker = { killed: false, send: vi.fn() } as any;
    ds.session.workerGeneration = 1;
    ds.workerGeneration = 1;
    const ctx = { ...makeCtx(anchor, 'om_effort_checkpoint_race_task'),
      checkpointPreAdmissionSession: async (_session: unknown, current: () => boolean) => {
        ds.workerGeneration = 2;
        expect(current()).toBe(false);
        throw new Error('runtime replaced before canonical checkpoint');
      }, durablePrimaryDispatch: { attempt: 1, signal: new AbortController().signal } };
    await handleThreadReply(makeEventData(ctx.messageId, '/effort ultra check', anchor), ctx);
    expect(ctx.ingressAdmission.retryReason).toBeTruthy();
    expect(ctx.ingressAdmission.admitted).toBe(false);
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
  });

  it('does not send an attached task after its Inbox claim aborts during resource preparation', async () => {
    getBot(APP).config.cliId = 'codex';
    const anchor = 'om_effort_claim_abort';
    const ds = seedThreadSession(anchor, 'seeded');
    ds.session.cliId = 'codex';
    ds.worker = { killed: false, send: vi.fn() } as any;
    ds.session.workerGeneration = 1;
    ds.workerGeneration = 1;
    ds.cliReady = true;
    ds.hasHistory = true;
    const controller = new AbortController();
    mocks.downloadResources.mockImplementationOnce(async () => {
      controller.abort(new Error('Inbox ownership lost'));
      return { attachments: [], needLogin: false };
    });
    const ctx = { ...makeCtx(anchor, 'om_effort_claim_abort_task'), checkpointPreAdmissionSession: async () => {},
      durablePrimaryDispatch: { attempt: 1, signal: controller.signal } };
    await handleThreadReply(makeEventData(ctx.messageId, '/effort ultra check', anchor), ctx);
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    expect(ctx.ingressAdmission.admitted).toBe(false);
  });

  it('waits for provider commit after a post-IPC persistence failure without resubmitting', async () => {
    getBot(APP).config.cliId = 'codex';
    const anchor = 'om_effort_post_ipc';
    const ds = seedThreadSession(anchor, 'seeded');
    ds.session.cliId = 'codex';
    ds.worker = { killed: false, send: vi.fn() } as any;
    ds.session.workerGeneration = 1;
    ds.workerGeneration = 1;
    ds.cliReady = true;
    ds.hasHistory = true;
    mocks.sendWorkerInput.mockImplementationOnce(() => {
      mocks.updateSession.mockImplementationOnce(() => { throw new Error('post IPC persistence'); });
      return true;
    });
    const messageId = 'om_effort_post_ipc_task';
    const context = () => ({ ...makeCtx(anchor, messageId), checkpointPreAdmissionSession: async () => {},
      durablePrimaryDispatch: { attempt: 1, signal: new AbortController().signal } });
    const first = context();
    await handleThreadReply(makeEventData(messageId, '/effort ultra check', anchor), first);
    expect(first.ingressAdmission.retryReason).toBeTruthy();
    expect(mocks.sendWorkerInput).toHaveBeenCalledOnce();
    __testOnly_recordDurablePrimaryInputCommit(ds, { type: 'turn_input_committed', turnId: messageId,
      durablePrimaryInbox: true } as any, 1);
    const second = context();
    await handleThreadReply(makeEventData(messageId, '/effort ultra check', anchor), second);
    expect(second.ingressAdmission.admitted).toBe(true);
    expect(second.ingressAdmission.retryReason).toBeUndefined();
    expect(mocks.sendWorkerInput).toHaveBeenCalledOnce();
  });

  it('persists confirmed settings through real SQLite Inbox retries and commits the task once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'effort-primary-'));
    const store = new SqliteDurableCoordinationStore(join(directory, 'coordination.db'));
    const facade = createDurableSessionFacade({ store, ownerId: 'effort-test' });
    try {
      getBot(APP).config.cliId = 'codex';
      const anchor = 'om_effort_sqlite';
      const messageId = 'om_effort_sqlite_task';
      const ds = seedThreadSession(anchor, 'seeded');
      ds.session.cliId = 'codex';
      ds.session.backendType = 'tmux';
      ds.session.scope = 'thread';
      ds.session.workerGeneration = 1;
      ds.workerGeneration = 1;
      ds.session.cliSessionId = 'native';
      ds.worker = { killed: false, send: vi.fn() } as any;
      ds.hasHistory = true;
      const event = durableLarkMessageEvent({ larkAppId: APP,
        eventId: 'im.message.receive_v1:' + APP + ':' + messageId,
        partitionKey: 'lark-message-routing:' + APP + ':' + CHAT,
        data: makeEventData(messageId, '/effort ultra check', anchor) });
      await store.enqueueInbox(event);
      const claim = async () => {
        const claimed = await store.claimNextInbox({ workerId: 'effort-test', leaseDurationMs: 10_000 });
        expect(claimed).toBeDefined();
        return claimed!;
      };
      const initial = await claim();
      const pending = parseDurableLarkMessageClaim(initial);
      await admitDurableLarkSession({ facade, message: { ...pending, messageId: 'om_existing',
        eventId: 'im.message.receive_v1:' + APP + ':om_existing' }, session: ds.session });
      const dispatch = createDurableLarkCanonicalDispatch({ facade, store, handle: async (message, context) => {
        const ctx = { ...makeCtx(anchor, messageId), checkpointPreAdmissionSession: context.checkpointPreAdmissionSession,
          durablePrimaryDispatch: { attempt: context.claim.attempts, signal: context.signal } };
        await handleThreadReply(message.data, ctx);
        return ctx.ingressAdmission?.retryReason
          ? { kind: 'retry', reason: ctx.ingressAdmission.retryReason }
          : ctx.ingressAdmission?.admitted ? { kind: 'admitted', session: ds.session }
          : { kind: 'ignored', reason: 'no task admission' };
      } });
      const signal = new AbortController().signal;
      expect(await dispatch(pending, { claim: initial, signal })).toMatchObject({ kind: 'retry' });
      const stored = parseDurablePrimarySessionRecord((await store.readSession(sessionKey(anchor, APP)))!);
      expect(stored.admissions.map(item => item.messageId)).toEqual(['om_existing']);
      expect(stored.session.codexEffortTaskConfirmations).toHaveLength(1);
      expect(await store.retryInboxClaim({ claim: initial, visibleAt: Date.now() })).toMatchObject({ kind: 'applied' });
      // Restore the Session snapshot from the canonical store before retrying.
      ds.session = stored.session;
      const second = await claim();
      expect(await dispatch(parseDurableLarkMessageClaim(second), { claim: second, signal })).toMatchObject({ kind: 'retry' });
      await store.retryInboxClaim({ claim: second, visibleAt: Date.now() });
      ds.cliReady = true;
      mocks.sendWorkerInput.mockImplementationOnce(() => {
        __testOnly_recordDurablePrimaryInputCommit(ds, { type: 'turn_input_committed', turnId: messageId,
          durablePrimaryInbox: true } as any, 1);
        return true;
      });
      const third = await claim();
      expect(await dispatch(parseDurableLarkMessageClaim(third), { claim: third, signal })).toMatchObject({ kind: 'committed' });
      await store.completeInboxClaim(third);
      expect(await store.claimNextInbox({ workerId: 'effort-test', leaseDurationMs: 10_000 })).toBeUndefined();
      expect(mocks.updateCodexCliEffort).toHaveBeenCalledOnce();
      expect(mocks.sendWorkerInput).toHaveBeenCalledOnce();
      expect(parseDurablePrimarySessionRecord((await store.readSession(sessionKey(anchor, APP)))!).admissions
        .map(item => item.messageId)).toEqual(['om_existing', messageId]);
      expect(ds.session.codexEffortTaskConfirmations![0]!.terminal).toBe('admitted');
      const replay = { ...makeCtx(anchor, messageId), checkpointPreAdmissionSession: async () => {},
        durablePrimaryDispatch: { attempt: 4, signal } };
      await handleThreadReply(makeEventData(messageId, '/effort ultra check', anchor), replay);
      expect(replay.ingressAdmission.admitted).toBe(true);
      expect(mocks.updateCodexCliEffort).toHaveBeenCalledOnce();
      expect(mocks.sendWorkerInput).toHaveBeenCalledOnce();
    } finally {
      await facade.stop();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['body', 'worker', 'native', 'sender', 'resource'])(
    'persists an ignored confirmation and not-submitted receipt after the %s identity changes', async change => {
      getBot(APP).config.cliId = 'codex';
      const anchor = 'om_effort_identity';
      const ds = seedThreadSession(anchor, 'seeded');
      ds.session.cliId = 'codex';
      ds.worker = { killed: false, send: vi.fn() } as any;
      ds.session.workerGeneration = 1;
      ds.workerGeneration = 1;
      ds.session.cliSessionId = 'native';
      const messageId = 'om_effort_identity_task';
      const data = makeEventData(messageId, '/effort ultra check', anchor);
      const checkpoints: any[] = [];
      const checkpoint = vi.fn(async (session: any) => { checkpoints.push(structuredClone(session)); });
      const context = () => ({ ...makeCtx(anchor, messageId), checkpointPreAdmissionSession: checkpoint,
        durablePrimaryDispatch: { attempt: 1, signal: new AbortController().signal } });
      const first = context();
      await handleThreadReply(data, first);
      expect(first.ingressAdmission.retryReason).toBe('session has an unfinished turn');
      expect(ds.session.codexEffortTaskConfirmations).toHaveLength(1);
      expect(ds.session.codexEffortTaskConfirmations![0]!.terminal).toBeUndefined();
      expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
      if (change === 'body') data.message.content = JSON.stringify({ text: '/effort ultra changed' });
      if (change === 'worker') { ds.worker = { killed: false, send: vi.fn() } as any; ds.workerGeneration = 2; }
      if (change === 'native') ds.session.cliSessionId = 'replacement';
      if (change === 'sender') {
        data.sender.sender_id.open_id = 'ou_other';
        getBot(APP).resolvedAllowedUsers = [OWNER, 'ou_other'];
      }
      if (change === 'resource') {
        data.message.message_type = 'post';
        data.message.content = JSON.stringify({ zh_cn: { title: '', content: [[
          { tag: 'text', text: '/effort ultra check' }, { tag: 'img', image_key: 'changed' },
        ]] } });
      }
      // Let the resumed worker accept a turn so worker/native changes reach
      // identity retirement rather than the earlier unfinished-turn retry.
      ds.cliReady = true;
      checkpoints.length = 0;
      checkpoint.mockClear();
      mocks.updateSession.mockClear();
      mocks.replyMessage.mockClear();
      mocks.sendMessage.mockClear();
      // Refuse an unexpected delivery so a missing retirement guard fails
      // on state assertions instead of waiting for a provider receipt timeout.
      mocks.sendWorkerInput.mockReturnValue(false);
      const retry = context();
      await handleThreadReply(data, retry);
      expect(retry.ingressAdmission.admitted).toBe(false);
      expect(retry.ingressAdmission.retryReason).toBeUndefined();
      expect(ds.session.codexEffortTaskConfirmations![0]!.terminal).toBe('ignored');
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(checkpoints[0].codexEffortTaskConfirmations).toEqual([
        expect.objectContaining({ messageId, terminal: 'ignored' }),
      ]);
      expect(mocks.updateSession).toHaveBeenCalledWith(expect.objectContaining({
        codexEffortTaskConfirmations: [expect.objectContaining({ messageId, terminal: 'ignored' })],
      }));
      const task = change === 'body' ? 'changed' : 'check';
      expect(repliedText()).toContain(tr('cmd.effort.task_not_submitted', { task }, localeForBot(APP)));
      expect(mocks.updateCodexCliEffort).toHaveBeenCalledOnce();
      expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    },
  );

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.getChatMode.mockResolvedValue('group');
    mocks.getChatNameAndMode.mockResolvedValue({ name: null, mode: 'group' });
    mocks.resolveTargetAppOpenId.mockImplementation(async (_appId: string, unionId: string) => ({
      status: 'resolved' as const,
      openId: `ou_target_${unionId.slice(3)}`,
    }));
    mocks.sessions.clear();
    mocks.forkWorker.mockImplementation((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    });
    mocks.scanMultipleProjects.mockReturnValue([]);
    mocks.getAvailableBots.mockResolvedValue([]);
    mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
    mocks.sendWorkerInput.mockReset().mockReturnValue(true);
    mocks.updateCodexCliEffort.mockReset().mockResolvedValue({ status: 'future_only', reason: 'cli_next_turn' });
    activeSessions.clear();
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
    });
    bot.resolvedAllowedUsers = [OWNER];
  });

});
