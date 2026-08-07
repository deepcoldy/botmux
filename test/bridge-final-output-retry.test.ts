/**
 * P2: daemon-side retry of `final_output` on transient Lark failures.
 *
 * The worker pops each turn off its queue at emit time and never re-sends
 * the same payload, so the daemon owns retry. We verify:
 *   - transient sessionReply rejections retry up to 3 times with backoff
 *   - dedup marker is committed only after a successful send
 *   - MessageWithdrawnError aborts retries (no point), commits dedup, and
 *     closes the session
 *   - 3 consecutive failures give up and DO NOT commit the dedup marker
 *     (so any retransmit can still deliver)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const updateMessageMock = vi.fn(async () => {});
const addReactionMock = vi.fn(async () => 'reaction_id');
const replyToDocCommentMock = vi.fn(async () => {});
const removeCommentReactionMock = vi.fn(async () => {});
const updateSessionMock = vi.fn();
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: (...args: any[]) => updateMessageMock(...args),
  addReaction: (...args: any[]) => addReactionMock(...args),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/doc-comment.js', () => ({
  replyToDocComment: (...args: any[]) => replyToDocCommentMock(...args),
  chunkCommentText: vi.fn((content: string) => [content]),
  unsubscribeDocFile: vi.fn(async () => {}),
  removeCommentReaction: (...args: any[]) => removeCommentReactionMock(...args),
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  // Reply-card footer usage only renders in 'footer' mode; tests override this
  // per case. Default 'footer' keeps the positive usage-render tests below green.
  resolveUsageDisplay: vi.fn(() => 'footer'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

vi.mock('../src/core/cost-calculator.js', () => ({
  getSessionTokenUsage: vi.fn(() => null),
  getSessionUsageSnapshot: vi.fn(() => ({
    context: { usedTokens: 12_345, windowTokens: 100_000, percentUsed: 12 },
    tokens: { in: 67_890, out: 123 },
  })),
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: (...args: any[]) => updateSessionMock(...args),
  createSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import {
  getDaemonReplyCardUsageSnapshot,
  initWorkerPool,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import { MessageWithdrawnError } from '../src/im/lark/client.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import { EventEmitter } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acceptVcMeetingDelivery,
  applyVcMeetingMemberProjection,
  completeVcMeetingDelivery,
  failVcMeetingDelivery,
  markVcMeetingDeliveryAmbiguous,
  markVcMeetingDeliveryDispatched,
} from '../src/services/vc-meeting-delivery-store.js';
import { listVcMeetingActions } from '../src/services/vc-meeting-action-store.js';
import { listVcMeetingListenerMessageIds } from '../src/services/vc-meeting-listener-message-store.js';
import { getSessionUsageSnapshot } from '../src/core/cost-calculator.js';
import { getBot, resolveUsageDisplay } from '../src/bot-registry.js';
import {
  clearMessageListenerRunPreviewStore,
  createMessageListenerRunPreview,
  getMessageListenerRunPreview,
  markMessageListenerRunPreviewTriggered,
} from '../src/services/message-listener-run-preview-store.js';

// Build a fake worker child process whose IPC `message` event we can fire
// manually, then wire it through setupWorkerHandlers via forkAdoptWorker.
// To keep this test focused on the retry pipeline (and avoid spawning a
// real fork), we exercise the case branch by invoking the registered
// listener directly.

function makeDs(): DaemonSession {
  const fakeWorker = new EventEmitter() as any;
  fakeWorker.killed = false;
  fakeWorker.send = vi.fn();
  fakeWorker.kill = vi.fn();
  fakeWorker.pid = 99999;
  fakeWorker.stdout = new EventEmitter();
  fakeWorker.stderr = new EventEmitter();
  return {
    session: {
      sessionId: 'sid-final-out',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker: fakeWorker,
    workerPort: 0,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: false,
    adoptedFrom: {
      tmuxTarget: '0:1.0',
      originalCliPid: 1234,
      sessionId: 'claude-session-xyz',
      cliId: 'claude-code' as const,
      cwd: '/tmp',
    },
  };
}

function makeHermesDs(): DaemonSession {
  const ds = makeDs();
  ds.session.cliId = 'hermes';
  return ds;
}

function finalOutputMsg(): Extract<WorkerToDaemon, { type: 'final_output' }> {
  return { type: 'final_output', content: 'final answer', lastUuid: 'uuid-1', turnId: 'turn-1' };
}

function listenerFinalOutputMsg(
  content = 'final answer',
): Extract<WorkerToDaemon, { type: 'final_output' }> {
  return {
    ...finalOutputMsg(),
    content: JSON.stringify({ decision: 'publish', content }),
  };
}

function seedReceiverReceipt(responseMode: 'silent' | 'listener_thread'): void {
  const memberKey = {
    listenerAppId: 'listener-app', meetingId: 'meeting-1', memberId: 'member-1', memberEpoch: 1,
  };
  expect(applyVcMeetingMemberProjection('/tmp/test-sessions', {
    ...memberKey,
    ownerBootId: 'owner-boot', ownerEpoch: 1, agentAppId: 'app_test', role: 'minutes',
    membershipGeneration: 1, status: 'active', responseMode, joinedAtIngestSeq: 0,
    capabilities: ['meeting.read', 'listener.output.request'], ownedSinks: [], sinkOwnerGeneration: 1,
    receiverSessionId: 'sid-final-out', outputChatId: 'oc_chat',
  })).toMatchObject({ ok: true });
  expect(acceptVcMeetingDelivery('/tmp/test-sessions', {
    ...memberKey,
    ownerBootId: 'owner-boot', ownerEpoch: 1, membershipGeneration: 1,
    deliveryKey: 'delivery-stable-key', inputHash: 'input-hash', fromSeq: 1, toSeq: 1,
    responseMode,
    listenerOutputProtocol: responseMode === 'listener_thread' ? 'decision_v1' : 'plain',
    receiverBootId: 'receiver-boot',
  })).toMatchObject({ kind: 'accepted' });
  expect(markVcMeetingDeliveryDispatched('/tmp/test-sessions', {
    ...memberKey, deliveryKey: 'delivery-stable-key',
  }, { receiverBootId: 'receiver-boot', workerGeneration: 1 })).toMatchObject({
    ok: true,
    receipt: { status: 'dispatched' },
  });
}

function seedSilentReceiverReceipt(): void {
  seedReceiverReceipt('silent');
}

const SCOPED_DEDUPE_KEY = 'sid-final-out:uuid-1';

describe('Bridge final_output delivery (P2 retry)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(getBot).mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
      resolvedAllowedUsers: [],
      botOpenId: 'ou_bot',
      botName: 'TestBot',
    } as any);
    // clearAllMocks wipes the factory return; re-arm footer mode so the
    // positive usage-render tests see footer usage (individual tests override).
    vi.mocked(resolveUsageDisplay).mockReturnValue('footer');
    rmSync('/tmp/test-sessions', { recursive: true, force: true });
    mkdirSync('/tmp/test-sessions', { recursive: true });
  });

  afterEach(() => {
    rmSync('/tmp/test-sessions', { recursive: true, force: true });
    clearMessageListenerRunPreviewStore();
    vi.useRealTimers();
  });

  it('commits dedup uuid only after a successful sessionReply', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    // Drive the case 'final_output' by invoking the registered handler.
    // setupWorkerHandlers attaches handler when a worker is forked, but we
    // bypass that: invoke the callback by emitting a message to the
    // EventEmitter that the live `worker.on('message')` registers. The
    // simplest path is to fork the worker via forkAdoptWorker — but that
    // spawns a real process. Instead we rely on the case branch's
    // self-contained behavior by importing deliverFinalOutput indirectly
    // via firing the IPC 'message' event after attaching a listener that
    // mirrors the case branch.
    //
    // Implementation detail: setupWorkerHandlers is internal; we exercise
    // it by directly calling the IPC entry. Since deliverFinalOutput is
    // file-private, we reach it through the public IPC dispatch.

    const ds = makeDs();
    // Hand-wired dispatcher that mirrors the relevant case branch in
    // setupWorkerHandlers. Keeping it here keeps the test independent of
    // unrelated card/state plumbing.
    const dispatcher = async (msg: WorkerToDaemon) => {
      if (msg.type !== 'final_output') return;
      if (!msg.content || !msg.content.trim()) return;
      if (msg.lastUuid && ds.lastBridgeEmittedUuid === `${msg.sessionId ?? ds.session.sessionId}:${msg.lastUuid}`) return;
      // Direct call to the public path:
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, msg, 'tag', 0);
    };

    await dispatcher(finalOutputMsg());
    // First attempt is delayed 0ms; flush microtasks + timers
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][4]).toBe('turn-1');
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('routes synthetic Codex App identities through their frozen reply turn and uses dispatch-stable Lark UUIDs', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;

    __testOnly_deliverFinalOutput(ds, {
      type: 'final_output',
      sessionId: ds.session.sessionId,
      content: 'scheduled answer one',
      lastUuid: 'synthetic-1',
      turnId: 'codex-app-dispatch-synthetic-1',
      replyTurnId: 'om_shared_route',
      codexAppSettlement: {
        requestId: 'request-1', generation: 'generation-1', seq: 1, dispatchId: 'dispatch-1',
      },
    }, 'tag', 0);
    __testOnly_deliverFinalOutput(ds, {
      type: 'final_output',
      sessionId: ds.session.sessionId,
      content: 'scheduled answer two',
      lastUuid: 'synthetic-2',
      turnId: 'codex-app-dispatch-synthetic-2',
      replyTurnId: 'om_shared_route',
      codexAppSettlement: {
        requestId: 'request-2', generation: 'generation-1', seq: 2, dispatchId: 'dispatch-2',
      },
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(sessionReply.mock.calls.map(call => call[4])).toEqual([
      'om_shared_route',
      'om_shared_route',
    ]);
    expect(sessionReply.mock.calls.map(call => call[5]?.uuid)).toEqual([
      'ca_dispatch-1',
      'ca_dispatch-2',
    ]);
    expect(sessionReply.mock.calls[0][5]).not.toHaveProperty('suppressHook');
  });

  it('routes sequential Codex App settlements through each ledger-frozen shared-chat root', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.cliId = 'codex-app';
    ds.currentReplyTarget = {
      rootMessageId: 'om_topic_b', turnId: 'turn-b', updatedAt: new Date().toISOString(),
    };
    ds.session.currentReplyTarget = ds.currentReplyTarget;
    ds.session.codexAppDispatchLedger = [
      {
        dispatchId: 'dispatch-a', turnId: 'turn-a', state: 'prepared', content: 'A',
        replyTarget: { mode: 'thread', rootMessageId: 'om_topic_a' },
      },
      {
        dispatchId: 'dispatch-b', turnId: 'turn-b', state: 'accepted', content: 'B',
        replyTarget: { mode: 'thread', rootMessageId: 'om_topic_b' },
      },
    ];
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'answer A', lastUuid: 'uuid-a', turnId: 'turn-a',
      codexAppSettlement: {
        requestId: 'settle-a', generation: 'generation-1', seq: 1, dispatchId: 'dispatch-a',
      },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(sessionReply).toHaveBeenCalledTimes(1));
    expect(sessionReply.mock.calls[0][5]?.replyTarget)
      .toEqual({ mode: 'thread', rootMessageId: 'om_topic_a' });

    (ds.worker as any).emit('message', {
      type: 'codex_app_dispatch_transition',
      sessionId: ds.session.sessionId,
      requestId: 'prepare-b',
      operation: 'submit',
      entries: [{ dispatchId: 'dispatch-b', turnId: 'turn-b' }],
    } satisfies Extract<WorkerToDaemon, { type: 'codex_app_dispatch_transition' }>);
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.[0]?.state).toBe('prepared'));
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'answer B', lastUuid: 'uuid-b', turnId: 'turn-b',
      codexAppSettlement: {
        requestId: 'settle-b', generation: 'generation-1', seq: 2, dispatchId: 'dispatch-b',
      },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(sessionReply).toHaveBeenCalledTimes(2));
    expect(sessionReply.mock.calls[1][5]?.replyTarget)
      .toEqual({ mode: 'thread', rootMessageId: 'om_topic_b' });
  });

  it.each(['doc_comment', 'http_wait', 'http_async', 'suppressed'] as const)(
    'fails closed instead of leaking a recovered %s settlement into Lark',
    async deliverySink => {
      const sessionReply = vi.fn(async () => 'om_forbidden');
      initWorkerPool({
        sessionReply,
        getSessionWorkingDir: () => '/tmp',
        getActiveCount: () => 1,
        closeSession: vi.fn(),
      });
      const ds = makeDs();
      ds.adoptedFrom = undefined;
      ds.scope = 'chat';
      ds.session.scope = 'chat';
      ds.session.cliId = 'codex-app';
      ds.session.codexAppDispatchLedger = [{
        dispatchId: `dispatch-${deliverySink}`,
        turnId: `turn-${deliverySink}`,
        state: 'prepared',
        content: 'recovered payload',
        deliverySink,
      }];
      __testOnly_setupWorkerHandlers(ds, ds.worker as any);

      (ds.worker as any).emit('message', {
        type: 'final_output',
        sessionId: ds.session.sessionId,
        content: 'must not cross channels',
        lastUuid: `uuid-${deliverySink}`,
        turnId: `turn-${deliverySink}`,
        codexAppSettlement: {
          requestId: `settle-${deliverySink}`,
          generation: 'generation-recovered',
          seq: 1,
          dispatchId: `dispatch-${deliverySink}`,
        },
      } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

      await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger).toEqual([]));
      expect(sessionReply).not.toHaveBeenCalled();
      await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'codex_app_dispatch_persisted',
          requestId: `settle-${deliverySink}`,
          ok: true,
        }),
      ));
    },
  );

  it.each([
    { name: 'non-steerable head', steerable: false, sink: 'lark' as const },
    { name: 'steerable but non-lark (http_wait) head', steerable: true, sink: 'http_wait' as const },
    { name: 'steerable but non-lark (doc_comment) head', steerable: true, sink: 'doc_comment' as const },
  ])(
    'R4-B4: rejects a steer_superseded settlement on a $name (ACK false, no pop, no mutation)',
    async ({ steerable, sink }) => {
      const sessionReply = vi.fn(async () => 'om_forbidden');
      initWorkerPool({
        sessionReply,
        getSessionWorkingDir: () => '/tmp',
        getActiveCount: () => 1,
        closeSession: vi.fn(),
      });
      const ds = makeDs();
      ds.adoptedFrom = undefined;
      ds.session.cliId = 'codex-app';
      // Two entries so the head has a successor — isolate the steerable/sink
      // rejection from the "no successor" rule (that is a separate worker check).
      const headEntry: any = {
        dispatchId: 'dispatch-sup-head', turnId: 'turn-sup-head', state: 'prepared',
        content: 'superseded head', deliverySink: sink,
        ...(steerable ? { codexAppSteerable: true } : {}),
      };
      ds.session.codexAppDispatchLedger = [
        headEntry,
        { dispatchId: 'dispatch-sup-next', turnId: 'turn-sup-next', state: 'accepted', content: 'next', deliverySink: 'lark', codexAppSteerable: true },
      ];
      __testOnly_setupWorkerHandlers(ds, ds.worker as any);

      (ds.worker as any).emit('message', {
        type: 'final_output', sessionId: ds.session.sessionId,
        content: '', lastUuid: 'uuid-sup-head', turnId: 'turn-sup-head',
        suppressDelivery: true,
        disposition: 'steer_superseded',
        codexAppSettlement: {
          requestId: 'settle-sup-head', generation: 'gen-sup', seq: 1, dispatchId: 'dispatch-sup-head',
        },
      } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

      // ACK false, no delivery, and the ledger head is NOT popped (no mutation).
      await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'codex_app_dispatch_persisted',
          requestId: 'settle-sup-head',
          ok: false,
        }),
      ));
      expect(sessionReply).not.toHaveBeenCalled();
      expect(ds.session.codexAppDispatchLedger?.[0]?.dispatchId).toBe('dispatch-sup-head');
      expect(ds.session.codexAppDispatchLedger?.length).toBe(2);
    },
  );

  it('R4-B4: commits a steer_superseded settlement on a steerable Lark head with a successor (ACK true, pop, no delivery)', async () => {
    const sessionReply = vi.fn(async () => 'om_forbidden');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.session.cliId = 'codex-app';
    ds.session.codexAppDispatchLedger = [
      { dispatchId: 'dispatch-ok-head', turnId: 'turn-ok-head', state: 'prepared', content: 'superseded', deliverySink: 'lark', codexAppSteerable: true },
      { dispatchId: 'dispatch-ok-next', turnId: 'turn-ok-next', state: 'accepted', content: 'real', deliverySink: 'lark', codexAppSteerable: true },
    ];
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: '', lastUuid: 'uuid-ok-head', turnId: 'turn-ok-head',
      suppressDelivery: true,
      disposition: 'steer_superseded',
      codexAppSettlement: {
        requestId: 'settle-ok-head', generation: 'gen-ok', seq: 1, dispatchId: 'dispatch-ok-head',
      },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

    // ACK true, ledger head popped (durable FIFO advanced), but never delivered.
    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'codex_app_dispatch_persisted',
        requestId: 'settle-ok-head',
        ok: true,
      }),
    ));
    expect(sessionReply).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.length).toBe(1));
    expect(ds.session.codexAppDispatchLedger?.[0]?.dispatchId).toBe('dispatch-ok-next');
  });

  it('R5-B4-2: rejects a steer_superseded on a steerable head with an UNDEFINED sink (legacy/mixed ledger fails closed)', async () => {
    const sessionReply = vi.fn(async () => 'om_forbidden');
    initWorkerPool({
      sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.session.cliId = 'codex-app';
    // steerable=true but deliverySink MISSING — admission always writes both, so
    // this can only be a mixed/corrupt/legacy ledger and must fail closed.
    ds.session.codexAppDispatchLedger = [
      { dispatchId: 'dispatch-nosink-head', turnId: 'turn-nosink-head', state: 'prepared', content: 'x', codexAppSteerable: true },
      { dispatchId: 'dispatch-nosink-next', turnId: 'turn-nosink-next', state: 'accepted', content: 'y', deliverySink: 'lark', codexAppSteerable: true },
    ];
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: '', lastUuid: 'uuid-nosink', turnId: 'turn-nosink-head',
      suppressDelivery: true, disposition: 'steer_superseded',
      codexAppSettlement: { requestId: 'settle-nosink', generation: 'gen-ns', seq: 1, dispatchId: 'dispatch-nosink-head' },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex_app_dispatch_persisted', requestId: 'settle-nosink', ok: false }),
    ));
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.session.codexAppDispatchLedger?.length).toBe(2);
    expect(ds.session.codexAppDispatchLedger?.[0]?.dispatchId).toBe('dispatch-nosink-head');
  });

  it('R5-B4-2: rejects a steer_superseded on the SOLE remaining head (no successor — a lone forged superseded must not commit)', async () => {
    const sessionReply = vi.fn(async () => 'om_forbidden');
    initWorkerPool({
      sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.session.cliId = 'codex-app';
    // A perfectly steerable Lark head — but it is the ONLY entry. A superseded
    // member must have a real successor; the sole head can only settle as a real
    // final. A lone forged superseded would otherwise silently commit it.
    ds.session.codexAppDispatchLedger = [
      { dispatchId: 'dispatch-solo', turnId: 'turn-solo', state: 'prepared', content: 'solo', deliverySink: 'lark', codexAppSteerable: true },
    ];
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: '', lastUuid: 'uuid-solo', turnId: 'turn-solo',
      suppressDelivery: true, disposition: 'steer_superseded',
      codexAppSettlement: { requestId: 'settle-solo', generation: 'gen-solo', seq: 1, dispatchId: 'dispatch-solo' },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex_app_dispatch_persisted', requestId: 'settle-solo', ok: false }),
    ));
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.session.codexAppDispatchLedger?.length).toBe(1);
    expect(ds.session.codexAppDispatchLedger?.[0]?.dispatchId).toBe('dispatch-solo');
  });

  it('R7-B2 daemon half: a two-member steered group settles through the REAL daemon handler — superseded head persisted+suppressed (not delivered), real member delivered, ledger drains', async () => {
    // DAEMON-SIDE of the round-trip: drives the real setupWorkerHandlers ledger
    // preview → store-write → ACK path (not a worker-side fake ACK). Member 1 is
    // steer_superseded (must commit + NOT deliver), member 2 is the real final
    // (must deliver). Proves the daemon accepts the superseded, advances the FIFO,
    // and only delivers the real member — the half the worker integration test
    // stubs with a deterministic ACK.
    const sessionReply = vi.fn(async () => 'om_delivered');
    initWorkerPool({
      sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.session.cliId = 'codex-app';
    ds.session.codexAppDispatchLedger = [
      { dispatchId: 'd-grp-1', turnId: 'turn-grp-1', state: 'prepared', content: '', deliverySink: 'lark', codexAppSteerable: true, replyTarget: { mode: 'thread', rootMessageId: 'om_grp' } },
      { dispatchId: 'd-grp-2', turnId: 'turn-grp-2', state: 'accepted', content: 'real answer', deliverySink: 'lark', codexAppSteerable: true, replyTarget: { mode: 'thread', rootMessageId: 'om_grp' } },
    ];
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // Member 1: superseded — persisted + suppressed (no delivery), pops the head.
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: '', lastUuid: 'uuid-grp-1', turnId: 'turn-grp-1',
      suppressDelivery: true, disposition: 'steer_superseded',
      codexAppSettlement: { requestId: 'settle-grp-1', generation: 'gen-grp', seq: 1, dispatchId: 'd-grp-1' },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex_app_dispatch_persisted', requestId: 'settle-grp-1', ok: true })));
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.length).toBe(1));
    expect(sessionReply).not.toHaveBeenCalled(); // superseded head NOT delivered

    // Member 2 becomes the head; the runner submits it (accepted → prepared)
    // before its final can settle — mirror that transition through the real handler.
    (ds.worker as any).emit('message', {
      type: 'codex_app_dispatch_transition',
      sessionId: ds.session.sessionId,
      requestId: 'prepare-grp-2',
      operation: 'submit',
      entries: [{ dispatchId: 'd-grp-2', turnId: 'turn-grp-2' }],
    } satisfies Extract<WorkerToDaemon, { type: 'codex_app_dispatch_transition' }>);
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.[0]?.state).toBe('prepared'));

    // Member 2: the real final — delivered, ledger fully drains.
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'real answer', lastUuid: 'uuid-grp-2', turnId: 'turn-grp-2',
      codexAppSettlement: { requestId: 'settle-grp-2', generation: 'gen-grp', seq: 2, dispatchId: 'd-grp-2' },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(sessionReply).toHaveBeenCalledTimes(1)); // real member delivered
    // codex R7 delta: assert the daemon returns the REAL final's persistence ACK
    // too (not only the superseded head's settle-grp-1). Without this, a daemon
    // that forgets to ACK the last member would still drain the ledger + deliver
    // to Lark here, but the real worker would hang forever in
    // waitForCodexAppDaemonPersistence — invisible to a delivery-only assertion.
    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex_app_dispatch_persisted', requestId: 'settle-grp-2', ok: true })));
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger ?? []).toEqual([]));
  });

  it('still resolves a live HTTP wait sink without posting to Lark', async () => {
    const sessionReply = vi.fn(async () => 'om_forbidden');
    const resolveWait = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.session.cliId = 'codex-app';
    ds.pendingWaitPromises = new Map([['turn-wait-live', { resolve: resolveWait }]]);
    ds.session.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-wait-live',
      turnId: 'turn-wait-live',
      state: 'prepared',
      content: 'live payload',
      deliverySink: 'http_wait',
    }];
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'HTTP answer', lastUuid: 'uuid-wait-live', turnId: 'turn-wait-live',
      codexAppSettlement: {
        requestId: 'settle-wait-live', generation: 'generation-live', seq: 1,
        dispatchId: 'dispatch-wait-live',
      },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

    await vi.waitFor(() => expect(resolveWait).toHaveBeenCalledWith('HTTP answer'));
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger).toEqual([]));
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('abandons a delayed final before external delivery when worker/session ownership changes', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    let owned = true;
    const complete = vi.fn();

    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0, complete, () => owned);
    owned = false;
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(false);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });

  it('drops final_output whose worker sessionId does not match the daemon session', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: 'sid-other-worker',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });

  it('clears a stuck limited state when a real answer is harvested after recovery', async () => {
    // Regression guard (adopt/bridge sessions): a structured rate-limit emit
    // parks ds in `limited`, but in-terminal recovery has no Lark turn / retry
    // button / kill to clear it. A harvested final_output is a definitive
    // self-heal signal, so it must clear the stale limit + drop 'limited'.
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.workerPort = 4321;
    ds.usageLimit = { limited: true, kind: 'rate', retryAtMs: Date.now() + 5 * 60_000, retryLabel: '5-10 min', retryReady: false };
    ds.lastScreenStatus = 'limited';
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(ds.usageLimit).toBeUndefined();
    expect(ds.lastScreenStatus).not.toBe('limited');
    expect(sessionReply).toHaveBeenCalled();
  });

  it('marks message listener run preview replied when an explicit botmux send is observed', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const run = createMessageListenerRunPreview('app_test', 'oc_chat', ['om_source']);
    const triggerId = 'mlrp_turn_explicit_send';
    markMessageListenerRunPreviewTriggered(run.runId, 'om_source', {
      action: 'queued',
      sessionId: 'sid-final-out',
      triggerId,
    });

    const ds = makeDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'explicit_reply_observed',
      turnId: triggerId,
      messageId: 'om_explicit_reply',
    } as any);

    const updated = getMessageListenerRunPreview(run.runId);
    expect(updated?.results[0]).toMatchObject({
      messageId: 'om_source',
      state: 'replied',
      sessionId: ds.session.sessionId,
      replyMessageId: 'om_explicit_reply',
    });
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('records Hermes source binding and allows matching sourceHermesSessionId', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-A',
    });
    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-A',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(ds.hermesBridgeSourceSessionIds).toEqual(new Set(['hermes-A']));
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('resets Hermes source authorization for a replacement worker and ignores stale bindings', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    const oldWorker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, oldWorker);
    oldWorker.emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-A',
    });
    expect(ds.hermesBridgeSourceSessionIds).toEqual(new Set(['hermes-A']));

    const replacementWorker = new EventEmitter() as any;
    replacementWorker.killed = false;
    replacementWorker.send = vi.fn();
    replacementWorker.kill = vi.fn();
    replacementWorker.pid = 100000;
    __testOnly_setupWorkerHandlers(ds, replacementWorker);
    ds.worker = replacementWorker;

    expect(ds.hermesBridgeSourceSessionIds).toBeUndefined();

    replacementWorker.emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-A',
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).not.toHaveBeenCalled();

    oldWorker.emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-A-late',
    });
    expect(ds.hermesBridgeSourceSessionIds).toBeUndefined();

    replacementWorker.emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-C',
    });
    expect(ds.hermesBridgeSourceSessionIds).toEqual(new Set(['hermes-C']));
  });

  it('keeps old and rebound Hermes sources valid when one drain emits both turns', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // The worker was already bound to A. During one later drain it discovers
    // C's marker and sends that rebind before emitReadyCodexTurns forwards the
    // completed A turn followed by C's turn.
    (ds.worker as any).emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-A',
    });
    (ds.worker as any).emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-C',
    });
    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-A',
      content: 'answer from A',
      lastUuid: 'uuid-A',
      turnId: 'turn-A',
    });
    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-C',
      content: 'answer from C',
      lastUuid: 'uuid-C',
      turnId: 'turn-C',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(ds.hermesBridgeSourceSessionIds).toEqual(new Set(['hermes-A', 'hermes-C']));
    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(sessionReply.mock.calls[0][1]).toContain('answer from A');
    expect(sessionReply.mock.calls[1][1]).toContain('answer from C');
    expect(sessionReply.mock.calls.map(call => call[4])).toEqual(['turn-A', 'turn-C']);
  });

  it('drops Hermes final_output whose sourceHermesSessionId does not match the bound source', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    ds.hermesBridgeSourceSessionIds = new Set(['hermes-A']);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-B',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });

  it('drops Hermes final_output with sourceHermesSessionId before daemon has a binding', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-A',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });

  it('drops Hermes final_output without sourceHermesSessionId after a source is bound', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    ds.hermesBridgeSourceSessionIds = new Set(['hermes-A']);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });

  it('does not apply the Hermes source guard after the session switches to another CLI', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.cliId = 'codex';
    ds.hermesBridgeSourceSessionIds = new Set(['hermes-A']);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('does not address daemon final-output footers to a known bot owner', async () => {
    writeFileSync(
      join('/tmp/test-sessions', 'bot-openids-app_test.json'),
      JSON.stringify({ Claude: 'ou_foreign_bot' }),
    );

    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.ownerOpenId = 'ou_foreign_bot';
    ds.ownerOpenId = 'ou_foreign_bot';

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain('[botmux](');
    expect(cardJson).not.toContain('<at id=ou_foreign_bot></at>');
  });

  it('addresses Mira daemon fallback output back to the bot dispatcher', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.cliId = 'mira';
    ds.session.ownerOpenId = undefined;
    ds.ownerOpenId = undefined;
    ds.session.creatorOpenId = 'ou_dispatcher_bot';
    ds.session.quoteTargetSenderIsBot = true;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain('<at id=ou_dispatcher_bot></at>');
  });

  it('addresses Mira fallback output to a known-bot owner (/repo-primed dispatch)', async () => {
    // `botmux dispatch --repo` primes the thread with "@bot /repo <path>",
    // which records the dispatching bot as ownerOpenId (daemon /repo
    // session-create path) instead of nulling it like @-mention auto-create.
    writeFileSync(
      join('/tmp/test-sessions', 'bot-openids-app_test.json'),
      JSON.stringify({ Orchestrator: 'ou_orch_bot' }),
    );

    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.cliId = 'mira';
    ds.session.ownerOpenId = 'ou_orch_bot';
    ds.ownerOpenId = 'ou_orch_bot';
    ds.session.creatorOpenId = 'ou_orch_bot';
    ds.session.quoteTargetSenderIsBot = true;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain('<at id=ou_orch_bot></at>');
  });

  it('keeps daemon final-output footer addressing for a human owner', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.ownerOpenId = 'ou_human';
    ds.ownerOpenId = 'ou_human';

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain('<at id=ou_human></at>');
  });

  it('uses probe-free lexical link repair for sandboxed bridge fallback output', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.sandbox = true;
    const home = homedir().replace(/\/+$/, '');
    const relativeHome = home.replace(/^\/+/, '');
    const missing = `${relativeHome}/botmux-definitely-missing-${Date.now()}.md`;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      content: `[file](${missing})`,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain(`[file](/${missing})`);
  });

  it('preserves a real home-shaped relative link in a non-isolated bridge fallback', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const cwd = mkdtempSync(join(tmpdir(), 'botmux-bridge-relative-'));
    const relativeHome = homedir().replace(/^\/+|\/+$/g, '');
    const relativeFile = `${relativeHome}/project/a.md`;
    mkdirSync(join(cwd, relativeHome, 'project'), { recursive: true });
    writeFileSync(join(cwd, relativeFile), 'relative');
    try {
      const ds = makeDs();
      ds.workingDir = cwd;
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, {
        ...finalOutputMsg(),
        content: `[file](${relativeFile})`,
      }, 'tag', 0);

      await vi.advanceTimersByTimeAsync(10);

      const cardJson = sessionReply.mock.calls[0][1] as string;
      expect(cardJson).toContain(`[file](${relativeFile})`);
      expect(cardJson).not.toContain(`[file](/${relativeFile})`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('uses probe-free lexical link repair for read-isolated bridge fallback output', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.initConfig = { readIsolation: true } as any;
    const home = homedir().replace(/\/+$/, '');
    const relativeHome = home.replace(/^\/+/, '');
    const missing = `${relativeHome}/botmux-definitely-missing-read-iso-${Date.now()}.md`;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      content: `[file](${missing})`,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain(`[file](/${missing})`);
  });

  it.each([
    ['persisted session backend', (ds: DaemonSession) => { ds.session.backendType = 'riff'; }],
    ['reconciled live backend', (ds: DaemonSession) => {
      ds.session.backendType = 'tmux';
      ds.initConfig = { backendType: 'riff' } as any;
    }],
  ])('uses probe-free lexical link repair for Riff via %s', async (_source, configure) => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    configure(ds);
    const home = homedir().replace(/\/+$/, '');
    const relativeHome = home.replace(/^\/+/, '');
    const missing = `${relativeHome}/botmux-definitely-missing-riff-${Date.now()}.md`;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      content: `[file](${missing})`,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain(`[file](/${missing})`);
  });

  it('uses lexical link repair when sandboxing is forced globally', async () => {
    const previous = process.env.BOTMUX_SANDBOX;
    process.env.BOTMUX_SANDBOX = '1';
    try {
      const sessionReply = vi.fn(async () => 'om_reply');
      initWorkerPool({
        sessionReply,
        getSessionWorkingDir: () => '/tmp',
        getActiveCount: () => 1,
        closeSession: vi.fn(),
      });

      const ds = makeDs();
      const home = homedir().replace(/\/+$/, '');
      const relativeHome = home.replace(/^\/+/, '');
      const missing = `${relativeHome}/botmux-definitely-missing-global-sandbox-${Date.now()}.md`;

      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, {
        ...finalOutputMsg(),
        content: `[file](${missing})`,
      }, 'tag', 0);

      await vi.advanceTimersByTimeAsync(10);

      const cardJson = sessionReply.mock.calls[0][1] as string;
      expect(cardJson).toContain(`[file](/${missing})`);
    } finally {
      if (previous === undefined) delete process.env.BOTMUX_SANDBOX;
      else process.env.BOTMUX_SANDBOX = previous;
    }
  });

  it('uses probe-free lexical link repair for adopt preamble cards', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.sandbox = true;
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    const home = homedir().replace(/\/+$/, '');
    const relativeHome = home.replace(/^\/+/, '');
    const missing = `${relativeHome}/botmux-definitely-missing-adopt-${Date.now()}.md`;

    (ds.worker as any).emit('message', {
      type: 'adopt_preamble',
      userText: 'show file',
      assistantText: `[file](${missing})`,
      turnId: 'turn-adopt',
    });
    await Promise.resolve();

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain(`[file](/${missing})`);
  });

  it('always delivers the answer as a fresh message (never PATCHes a card in place)', async () => {
    // The placeholder pending-card + its PATCH delivery were removed entirely
    // (message.patch is silent — no Feishu notification/unread). The bridge
    // final-output now unconditionally goes out as a brand-new reply.
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.quoteTargetId = 'om_user';

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(updateMessageMock).not.toHaveBeenCalled();
    // Turn reactions are driven off message acceptance (noteTurnReceived) and
    // the idle edge (finishTurnReactions), not the bridge final-output path.
    expect(addReactionMock).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('locks explicit VC IM fallback output and replies to its exact Lark message with one UUID', async () => {
    const sessionReply = vi.fn(async () => 'om_vc_fallback');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-im',
      memberId: 'member-im', memberEpoch: 1,
    };
    const origin = {
      listenerAppId: 'listener-app', meetingId: 'meeting-im', memberId: 'member-im',
      memberEpoch: 1, agentAppId: 'app_test', ownerBootId: 'owner-boot', ownerEpoch: 1,
      membershipGeneration: 1, sinkOwnerGeneration: 1,
      receiverSessionId: ds.session.sessionId, larkMessageId: 'om_human_a',
      replyTargetSenderOpenId: 'ou_human_a',
    };
    expect(applyVcMeetingMemberProjection('/tmp/test-sessions', {
      listenerAppId: origin.listenerAppId,
      meetingId: origin.meetingId,
      memberId: origin.memberId,
      memberEpoch: origin.memberEpoch,
      agentAppId: origin.agentAppId,
      ownerBootId: origin.ownerBootId,
      ownerEpoch: origin.ownerEpoch,
      role: 'minutes',
      membershipGeneration: origin.membershipGeneration,
      status: 'active',
      responseMode: 'silent',
      capabilities: ['meeting.read'],
      ownedSinks: [],
      sinkOwnerGeneration: origin.sinkOwnerGeneration,
      joinedAtIngestSeq: 0,
      receiverSessionId: origin.receiverSessionId,
      outputChatId: ds.chatId,
    })).toMatchObject({ ok: true });
    ds.session.vcMeetingImTurnOrigins = { om_human_a: origin };
    const msg = {
      ...finalOutputMsg(),
      content: 'safe body <at id="ou_injected">Injected</at>',
      turnId: 'om_human_a',
      lastUuid: 'bridge-a',
    };
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;

    __testOnly_deliverFinalOutput(ds, msg, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][4]).toBe('om_human_a');
    expect(sessionReply.mock.calls[0][5]).toMatchObject({
      quoteMessageId: 'om_human_a',
      uuid: expect.stringMatching(/^vcp_[0-9a-f]+$/),
      sourceSessionId: ds.session.sessionId,
      suppressHook: true,
    });
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).not.toContain('ou_human_a');
    expect(cardJson).not.toContain('<at');
    expect(cardJson).toContain('＜at');
    const providerUuid = sessionReply.mock.calls[0][5].uuid;
    expect(listVcMeetingListenerMessageIds('/tmp/test-sessions', {
      listenerAppId: origin.listenerAppId,
      meetingId: origin.meetingId,
      targetChatId: ds.chatId,
    })).toEqual(['om_vc_fallback']);

    // A daemon/worker replay sees the terminal ledger and performs no second
    // provider call. A changed replay is also suppressed: first output wins.
    __testOnly_deliverFinalOutput(ds, { ...msg, lastUuid: 'bridge-replay' }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);

    __testOnly_deliverFinalOutput(ds, {
      ...msg,
      content: 'changed fallback answer',
      lastUuid: 'bridge-changed',
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(providerUuid).toBeTruthy();
  });

  it('blocks the plain fallback when VC IM authority expires during a withdrawn quote request', async () => {
    let plainFallbackCalls = 0;
    const sessionReply = vi.fn(async (...args: any[]) => {
      const opts = args[5] as {
        beforeQuoteFallback?: () => void | Promise<void>;
      } | undefined;
      // Model the exact daemon sequence: the quote RPC was already in flight,
      // then the member was removed before Lark answered "withdrawn".
      expect(applyVcMeetingMemberProjection('/tmp/test-sessions', {
        listenerAppId: 'listener-app', meetingId: 'meeting-im-race',
        memberId: 'member-im-race', memberEpoch: 1,
        agentAppId: 'app_test', ownerBootId: 'owner-boot', ownerEpoch: 1,
        role: 'minutes', membershipGeneration: 2, status: 'removed',
        responseMode: 'silent', capabilities: ['meeting.read'], ownedSinks: [],
        sinkOwnerGeneration: 1, joinedAtIngestSeq: 0,
        receiverSessionId: 'sid-final-out', outputChatId: 'oc_chat',
      })).toMatchObject({ ok: true });
      await opts?.beforeQuoteFallback?.();
      plainFallbackCalls += 1;
      return 'om_forbidden_fallback';
    });
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-im-race',
      memberId: 'member-im-race', memberEpoch: 1,
    };
    const origin = {
      listenerAppId: 'listener-app', meetingId: 'meeting-im-race',
      memberId: 'member-im-race', memberEpoch: 1,
      agentAppId: 'app_test', ownerBootId: 'owner-boot', ownerEpoch: 1,
      membershipGeneration: 1, sinkOwnerGeneration: 1,
      receiverSessionId: ds.session.sessionId, larkMessageId: 'om_human_race',
    };
    expect(applyVcMeetingMemberProjection('/tmp/test-sessions', {
      ...origin,
      role: 'minutes', status: 'active', responseMode: 'silent',
      capabilities: ['meeting.read'], ownedSinks: [], joinedAtIngestSeq: 0,
      outputChatId: ds.chatId,
    })).toMatchObject({ ok: true });
    ds.session.vcMeetingImTurnOrigins = { om_human_race: origin };

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      turnId: 'om_human_race',
      lastUuid: 'bridge-race',
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(plainFallbackCalls).toBe(0);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
    const actions = listVcMeetingActions('/tmp/test-sessions', {
      listenerAppId: origin.listenerAppId,
      meetingId: origin.meetingId,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: 'attempting', attemptCount: 1 });
    expect(actions[0]).not.toHaveProperty('externalRefs.messageId');
  });

  it('indexes a successful ordinary meeting-delivery fallback output', async () => {
    const sessionReply = vi.fn(async () => 'om_meeting_fallback');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
    };
    seedReceiverReceipt('listener_thread');
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...listenerFinalOutputMsg(),
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][1]).toContain('final answer');
    expect(sessionReply.mock.calls[0][1]).not.toContain('decision');
    expect(sessionReply.mock.calls[0][5]).toMatchObject({
      uuid: expect.stringMatching(/^vcp_[0-9a-f]+$/),
      sourceSessionId: ds.session.sessionId,
      suppressHook: true,
    });
    expect(listVcMeetingListenerMessageIds('/tmp/test-sessions', {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      targetChatId: ds.chatId,
    })).toEqual(['om_meeting_fallback']);
  });

  it('treats a valid skip decision as a successful no-message outcome', async () => {
    const sessionReply = vi.fn(async () => 'om_forbidden');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
    };
    seedReceiverReceipt('listener_thread');
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...listenerFinalOutputMsg(),
      content: '{"decision":"skip"}',
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
    expect(listVcMeetingActions('/tmp/test-sessions', {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
    })).toEqual([]);
  });

  it('fails closed on a malformed automatic listener control envelope', async () => {
    const sessionReply = vi.fn(async () => 'om_forbidden');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
    };
    seedReceiverReceipt('listener_thread');
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      content: '暂无重要更新',
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(listVcMeetingListenerMessageIds('/tmp/test-sessions', {
      listenerAppId: 'listener-app', meetingId: 'meeting-1', targetChatId: ds.chatId,
    })).toEqual([]);
  });

  it('reuses one provider UUID when a listener reply is accepted before crash reconciliation', async () => {
    const providerMessages = new Map<string, string>();
    let crashAfterFirstAccept = true;
    const sessionReply = vi.fn(async (...args: any[]) => {
      const uuid = args[5]?.uuid as string;
      expect(uuid).toMatch(/^vcp_[0-9a-f]+$/);
      const messageId = providerMessages.get(uuid) ?? 'om_provider_once';
      providerMessages.set(uuid, messageId);
      if (crashAfterFirstAccept) {
        crashAfterFirstAccept = false;
        throw new Error('simulated daemon crash after provider accepted UUID');
      }
      return messageId;
    });
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
    };
    seedReceiverReceipt('listener_thread');
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    const first = {
      ...listenerFinalOutputMsg(),
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
      lastUuid: 'bridge-attempt-1',
    };
    __testOnly_deliverFinalOutput(ds, first, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);

    const deliveryKey = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
      deliveryKey: 'delivery-stable-key',
    };
    expect(markVcMeetingDeliveryAmbiguous('/tmp/test-sessions', deliveryKey, {
      workerGeneration: 1,
      dispatchAttempt: 1,
    })).toMatchObject({ ok: true, receipt: { status: 'ambiguous' } });
    expect(markVcMeetingDeliveryDispatched('/tmp/test-sessions', deliveryKey, {
      receiverBootId: 'receiver-boot-2',
      workerGeneration: 2,
    })).toMatchObject({ ok: true, receipt: { dispatchAttempt: 2 } });

    __testOnly_deliverFinalOutput(ds, {
      ...first,
      content: JSON.stringify({
        decision: 'publish',
        content: 'changed replay answer must not create another effect',
      }),
      dispatchAttempt: 2,
      lastUuid: 'bridge-attempt-2',
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(2);
    const firstUuid = sessionReply.mock.calls[0][5].uuid;
    expect(sessionReply.mock.calls[1][5].uuid).toBe(firstUuid);
    expect(sessionReply.mock.calls[0][5]).toMatchObject({ suppressHook: true });
    expect(sessionReply.mock.calls[1][5]).toMatchObject({ suppressHook: true });
    expect(providerMessages).toEqual(new Map([[firstUuid, 'om_provider_once']]));
    expect(listVcMeetingActions('/tmp/test-sessions', {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
    })).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        providerKey: firstUuid,
        externalRefs: { messageId: 'om_provider_once' },
      }),
    ]);
  });

  it('does not emit a delayed final output after the delivery failed terminally', async () => {
    const sessionReply = vi.fn(async () => 'om_forbidden_output');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
    };
    seedReceiverReceipt('listener_thread');
    expect(failVcMeetingDelivery('/tmp/test-sessions', {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
      deliveryKey: 'delivery-stable-key',
    }, {
      kind: 'terminal',
      workerGeneration: 1,
      dispatchAttempt: 1,
      errorCode: 'turn_cancelled',
      pauseStream: true,
    })).toMatchObject({ ok: true, receipt: { status: 'failed_terminal' } });

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(listVcMeetingListenerMessageIds('/tmp/test-sessions', {
      listenerAppId: 'listener-app', meetingId: 'meeting-1', targetChatId: ds.chatId,
    })).toEqual([]);
  });

  it('recovers a doc-comment destination from persisted per-turn state after restart', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.scope = 'chat';
    ds.chatId = 'doc:doc-token';
    ds.session.scope = 'chat';
    ds.session.chatId = 'doc:doc-token';
    ds.session.docCommentTargets = {
      'turn-1': {
        fileToken: 'doc-token',
        fileType: 'docx',
        commentId: 'comment-1',
        turnId: 'turn-1',
        replyId: 'reply-1',
        reactionId: 'reaction-1',
      },
    };

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(replyToDocCommentMock).toHaveBeenCalledTimes(1);
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.session.docCommentTargets).toBeUndefined();
    expect(removeCommentReactionMock).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('consumes doc-comment turn state after posting even when reaction cleanup fails', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    removeCommentReactionMock.mockRejectedValueOnce(new Error('reaction already gone'));

    const ds = makeDs();
    const target = {
      fileToken: 'doc-token',
      fileType: 'docx',
      commentId: 'comment-1',
      replyId: 'reply-1',
      reactionId: 'reaction-1',
    };
    ds.docCommentTurns = new Map([['turn-1', target]]);
    ds.session.docCommentTargets = {
      'turn-1': { ...target, turnId: 'turn-1' },
    };

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(replyToDocCommentMock).toHaveBeenCalledTimes(1);
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.docCommentTurns).toBeUndefined();
    expect(ds.session.docCommentTargets).toBeUndefined();
    expect(updateSessionMock).toHaveBeenCalledWith(ds.session);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('never posts a fallback card for a doc-native session without a safe comment target', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.scope = 'chat';
    ds.chatId = 'doc:doc-token';
    ds.session.scope = 'chat';
    ds.session.chatId = 'doc:doc-token';

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(replyToDocCommentMock).not.toHaveBeenCalled();
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('retries on transient failure and commits after success', async () => {
    const sessionReply = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockRejectedValueOnce(new Error('transient 2'))
      .mockResolvedValueOnce('om_reply');
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    // Attempt 1 (delay 0)
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();

    // Attempt 2 (delay 5000)
    await vi.advanceTimersByTimeAsync(5000);
    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();

    // Attempt 3 (delay 15000)
    await vi.advanceTimersByTimeAsync(15000);
    expect(sessionReply).toHaveBeenCalledTimes(3);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
    expect(getSessionUsageSnapshot).toHaveBeenCalledTimes(1);
    expect(getSessionUsageSnapshot).toHaveBeenCalledWith({
      cliId: 'claude-code',
      sessionId: 'sid-final-out',
      cliSessionId: 'claude-session-xyz',
      cwd: '/tmp',
      larkAppId: 'app_test',
      fresh: true,
    });
    const cards = sessionReply.mock.calls.map(call => call[1] as string);
    expect(new Set(cards)).toHaveLength(1);
    expect(cards[0]).toContain('上下文 12.3K/100K (12%)');
    // Reply-card footer is context-only now; the cumulative token line is not
    // rendered here (it lives on the live streaming card).
    expect(cards[0]).not.toContain('Token ↑');
  });

  it('reads a sandboxed Claude transcript through the daemon reply-card boundary', async () => {
    const actualCostCalculator =
      await vi.importActual<typeof import('../src/core/cost-calculator.js')>(
        '../src/core/cost-calculator.js',
      );
    vi.mocked(getSessionUsageSnapshot)
      .mockImplementationOnce(actualCostCalculator.getSessionUsageSnapshot);

    const sandboxRoot = mkdtempSync(join(tmpdir(), 'botmux-card-usage-sandbox-'));
    const previousSessionDataDir = process.env.SESSION_DATA_DIR;
    try {
      process.env.SESSION_DATA_DIR = join(sandboxRoot, 'data');
      const transcriptDir = join(
        sandboxRoot,
        'bots',
        'app_test',
        'claude',
        'projects',
        realpathSync('/tmp').replace(/[^A-Za-z0-9-]/g, '-'),
      );
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(
        join(transcriptDir, 'claude-session-xyz.jsonl'),
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-sonnet-test',
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 5,
            },
          },
        }) + '\n',
      );

      expect(getDaemonReplyCardUsageSnapshot(makeDs())).toMatchObject({
        context: { usedTokens: 115 },
        tokens: { in: 115, out: 20 },
      });
    } finally {
      if (previousSessionDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousSessionDataDir;
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it('reads a sandboxed Codex rollout through the daemon reply-card boundary', async () => {
    const actualCostCalculator =
      await vi.importActual<typeof import('../src/core/cost-calculator.js')>(
        '../src/core/cost-calculator.js',
      );
    vi.mocked(getSessionUsageSnapshot)
      .mockImplementationOnce(actualCostCalculator.getSessionUsageSnapshot);

    const sandboxRoot = mkdtempSync(join(tmpdir(), 'botmux-card-usage-codex-'));
    const previousSessionDataDir = process.env.SESSION_DATA_DIR;
    const codexSid = '019dd80d-d922-7a11-8339-0208d8c5b4ef';
    try {
      process.env.SESSION_DATA_DIR = join(sandboxRoot, 'data');
      const rolloutDir = join(
        sandboxRoot,
        'bots',
        'app_test',
        'codex',
        'sessions',
        '2026',
        '07',
        '29',
      );
      mkdirSync(rolloutDir, { recursive: true });
      writeFileSync(
        join(rolloutDir, `rollout-2026-07-29T12-00-00-${codexSid}.jsonl`),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 1_000,
                cached_input_tokens: 400,
                output_tokens: 50,
              },
              last_token_usage: { total_tokens: 250 },
              model_context_window: 2_000,
            },
          },
        }) + '\n',
      );
      const ds = makeDs();
      ds.session.cliId = 'codex';
      ds.session.cliSessionId = codexSid;

      expect(getDaemonReplyCardUsageSnapshot(ds)).toMatchObject({
        context: { usedTokens: 250, windowTokens: 2_000, percentUsed: 13 },
        tokens: { in: 1_000, out: 50 },
      });
    } finally {
      if (previousSessionDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousSessionDataDir;
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it('does not read or render footer usage when this bot is not in footer mode', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    // Default streaming (or off) → the reply-card footer must not carry usage,
    // and the gate must short-circuit before touching the transcript reader.
    vi.mocked(resolveUsageDisplay).mockReturnValue('off');

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(getSessionUsageSnapshot).not.toHaveBeenCalled();
    const card = sessionReply.mock.calls[0]?.[1] as string;
    expect(card).toContain('[botmux](');
    expect(card).not.toContain('上下文');
    expect(card).not.toContain('Token');
  });

  it('gives up after 3 attempts and does NOT commit dedup', async () => {
    const sessionReply = vi.fn().mockRejectedValue(new Error('persistent'));
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(15000);

    expect(sessionReply).toHaveBeenCalledTimes(3);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('MessageWithdrawnError aborts retries, commits dedup, and closes session', async () => {
    const sessionReply = vi.fn().mockRejectedValue(new MessageWithdrawnError('om_root'));
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const worker = ds.worker as any;
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(0);

    // Single attempt, no further retries
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
    expect(closeSession).toHaveBeenCalledWith(ds);
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'close' });
    expect(worker.kill).not.toHaveBeenCalled();
  });

  it('preserves an unsettled Codex FIFO owner when the root is withdrawn', async () => {
    const sessionReply = vi.fn().mockRejectedValue(new MessageWithdrawnError('om_root'));
    const closeSession = vi.fn();
    const complete = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });
    const ds = makeDs();
    ds.session.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-pending',
      turnId: 'turn-1',
      state: 'prepared',
      content: 'pending answer',
    }];
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0, complete);
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionReply).toHaveBeenCalledOnce();
    expect(closeSession).not.toHaveBeenCalled();
    expect((ds.worker as any).kill).not.toHaveBeenCalled();
    expect(ds.session.codexAppDispatchLedger).toHaveLength(1);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
    expect(complete).toHaveBeenCalledWith(false);
  });

  it('aborts pending retry if the session was closed in the meantime', async () => {
    const sessionReply = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockResolvedValueOnce('om_reply');  // would succeed if a 2nd attempt fired
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    // Attempt 1 fails
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionReply).toHaveBeenCalledTimes(1);

    // User closes the session before the 5s retry fires
    ds.session.status = 'closed' as any;

    // Backoff fires — must NOT call sessionReply again
    await vi.advanceTimersByTimeAsync(5000);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });
});

describe('Worker turn_terminal routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes a matching terminal receipt independently of final_output', async () => {
    const ds = makeDs();
    const onTurnTerminal = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    const terminal: Extract<WorkerToDaemon, { type: 'turn_terminal' }> = {
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'delivery-stable-key',
      status: 'completed',
    };
    (ds.worker as any).emit('message', terminal);
    await Promise.resolve();

    expect(onTurnTerminal).toHaveBeenCalledTimes(1);
    expect(onTurnTerminal).toHaveBeenCalledWith(ds, terminal, { workerGeneration: 1 });
  });

  it('captures silent fallback output and keeps the bounded legacy marker after terminal', async () => {
    const ds = makeDs();
    ds.suppressedFinalOutputTurns = new Map([['delivery-stable-key', 1]]);
    const sessionReply = vi.fn(async () => 'om_reply');
    const onTurnTerminal = vi.fn(async () => {});
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output',
      sessionId: ds.session.sessionId,
      content: 'analysis that must stay silent',
      lastUuid: 'assistant-uuid',
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.suppressedFinalOutputTurns.has('delivery-stable-key')).toBe(true);

    (ds.worker as any).emit('message', {
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
      status: 'completed',
    } satisfies Extract<WorkerToDaemon, { type: 'turn_terminal' }>);
    await Promise.resolve();

    expect(onTurnTerminal).toHaveBeenCalledTimes(1);
    expect(ds.suppressedFinalOutputTurns.has('delivery-stable-key')).toBe(true);
  });

  it('keeps an overlapping silent schedule exact while a queued normal turn stays loud', async () => {
    const ds = makeDs();
    ds.silentScheduledTurns = new Map([['schedule-turn', Date.now()]]);
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'ready', port: 4567, token: 'token', turnId: 'schedule-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'ready' }>);
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'silent progress', status: 'working', turnId: 'schedule-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'screen_update' }>);
    (ds.worker as any).emit('message', {
      type: 'tui_prompt', description: 'silent approval',
      options: [{ text: 'allow', selected: false }], turnId: 'schedule-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'tui_prompt' }>);
    (ds.worker as any).emit('message', {
      type: 'user_notify', message: 'silent warning', turnId: 'schedule-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'user_notify' }>);
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'silent automatic answer', lastUuid: 'silent-uuid', turnId: 'schedule-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    (ds.worker as any).emit('message', {
      type: 'error', message: 'silent startup failure', turnId: 'schedule-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'error' }>);
    await Promise.resolve();
    expect(sessionReply).not.toHaveBeenCalled();

    (ds.worker as any).emit('message', {
      type: 'user_notify', message: 'normal warning', turnId: 'normal-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'user_notify' }>);
    await Promise.resolve();
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][1]).toBe('normal warning');
    expect(sessionReply.mock.calls[0][4]).toBe('normal-turn');

    (ds.worker as any).emit('message', {
      type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'schedule-turn', status: 'completed',
    } satisfies Extract<WorkerToDaemon, { type: 'turn_terminal' }>);
    await Promise.resolve();
    expect(ds.silentScheduledTurns?.has('schedule-turn')).toBe(true);

    // A trailing event after terminal is still tied to the silent turn.
    (ds.worker as any).emit('message', {
      type: 'user_notify', message: 'late silent warning', turnId: 'schedule-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'user_notify' }>);
    await Promise.resolve();
    expect(sessionReply).toHaveBeenCalledTimes(1);
  });

  it('drops only the final_output of a suppressed trigger turn while other turns and its aux UI stay loud', async () => {
    const ds = makeDs();
    // A loud connector opted into suppressFinalOutput; trigger-session armed this
    // exact turn id (parallel to silentScheduledTurns but final-only).
    ds.suppressedTriggerFinalTurns = new Map([['trg_alert', Date.now()]]);
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // The suppressed turn's final_output must be dropped …
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'trigger summary that must not be posted', lastUuid: 'trg-uuid', turnId: 'trg_alert',
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await Promise.resolve();
    expect(sessionReply).not.toHaveBeenCalled();

    // … but its auxiliary UI (user_notify/streaming) is NOT suppressed: unlike
    // schedule-silent, trigger suppression only gates final_output, so the live
    // status/notify channel still reaches the topic.
    (ds.worker as any).emit('message', {
      type: 'user_notify', message: 'trigger warning still shows', turnId: 'trg_alert',
    } satisfies Extract<WorkerToDaemon, { type: 'user_notify' }>);
    await Promise.resolve();
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][1]).toBe('trigger warning still shows');

    // … and an unrelated turn on the same session keeps its final_output loud.
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'human turn answer', lastUuid: 'human-uuid', turnId: 'other-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await new Promise(r => setTimeout(r, 10));
    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(sessionReply.mock.calls[1][1]).toContain('human turn answer');
    expect(sessionReply.mock.calls[1][4]).toBe('other-turn');
  });

  it('keeps a newer silent retry armed when stale output and terminal arrive first', async () => {
    const ds = makeDs();
    ds.suppressedFinalOutputTurns = new Map([['delivery-stable-key', 2]]);
    const sessionReply = vi.fn(async () => 'om_reply');
    const onTurnTerminal = vi.fn(async () => {});
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    const emitFinal = (dispatchAttempt: number, content: string) => {
      (ds.worker as any).emit('message', {
        type: 'final_output',
        sessionId: ds.session.sessionId,
        content,
        lastUuid: `assistant-uuid-${dispatchAttempt}`,
        turnId: 'delivery-stable-key',
        dispatchAttempt,
      } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    };
    const emitTerminal = (dispatchAttempt: number) => {
      (ds.worker as any).emit('message', {
        type: 'turn_terminal',
        sessionId: ds.session.sessionId,
        turnId: 'delivery-stable-key',
        dispatchAttempt,
        status: 'completed',
      } satisfies Extract<WorkerToDaemon, { type: 'turn_terminal' }>);
    };

    emitFinal(1, 'stale attempt output must stay silent');
    emitTerminal(1);
    await Promise.resolve();

    expect(sessionReply).not.toHaveBeenCalled();
    expect(onTurnTerminal).toHaveBeenCalledTimes(1);
    expect(ds.suppressedFinalOutputTurns.get('delivery-stable-key')).toBe(2);

    emitFinal(2, 'current attempt output must stay silent');
    emitTerminal(2);
    await Promise.resolve();

    expect(sessionReply).not.toHaveBeenCalled();
    expect(onTurnTerminal).toHaveBeenCalledTimes(2);
    expect(ds.suppressedFinalOutputTurns.get('delivery-stable-key')).toBe(2);
  });

  it('suppresses non-final streaming, TUI, and diagnostic UI for a listener_thread receiver', async () => {
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      memberId: 'member-1',
      memberEpoch: 1,
    };
    ds.suppressedFinalOutputTurns = new Map([['delivery-stable-key', 1]]);
    seedReceiverReceipt('listener_thread');
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal: (_ds, terminal) => {
        completeVcMeetingDelivery('/tmp/test-sessions', {
          listenerAppId: 'listener-app', meetingId: 'meeting-1', memberId: 'member-1', memberEpoch: 1,
          deliveryKey: terminal.turnId,
        }, { workerGeneration: 1, dispatchAttempt: terminal.dispatchAttempt });
      },
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'ready', port: 4567, token: 'token', turnId: 'delivery-stable-key', dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'ready' }>);
    (ds.worker as any).emit('message', {
      type: 'screen_update',
      content: 'meeting transcript on screen',
      status: 'working',
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'screen_update' }>);
    (ds.worker as any).emit('message', {
      type: 'tui_prompt',
      description: 'permission needed',
      options: [{ text: 'allow', selected: false }],
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'tui_prompt' }>);
    (ds.worker as any).emit('message', {
      type: 'user_notify', message: 'submit failed', turnId: 'delivery-stable-key', dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'user_notify' }>);
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.workerPort).toBe(4567);
    expect(ds.lastScreenStatus).toBe('working');

    (ds.worker as any).emit('message', {
      type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'delivery-stable-key',
      dispatchAttempt: 1, status: 'completed',
    } satisfies Extract<WorkerToDaemon, { type: 'turn_terminal' }>);
    await Promise.resolve();
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'idle after terminal', status: 'idle',
      turnId: 'delivery-stable-key', dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'screen_update' }>);
    await Promise.resolve();
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('drops a terminal receipt from a stale or wrongly-bound worker', async () => {
    const ds = makeDs();
    const onTurnTerminal = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'turn_terminal',
      sessionId: 'sid-stale-worker',
      turnId: 'delivery-stable-key',
      status: 'completed',
    } satisfies Extract<WorkerToDaemon, { type: 'turn_terminal' }>);
    await Promise.resolve();

    expect(onTurnTerminal).not.toHaveBeenCalled();
  });

  it('reports the exact worker generation when the process exits', async () => {
    const ds = makeDs();
    const onWorkerExit = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onWorkerExit,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('exit', 17, 'SIGTERM');
    await Promise.resolve();

    expect(onWorkerExit).toHaveBeenCalledWith(ds, {
      sessionId: ds.session.sessionId,
      workerGeneration: 1,
      code: 17,
      signal: 'SIGTERM',
    });
  });

  it('reports a managed CLI exit even when the Node worker stays alive', async () => {
    const ds = makeDs();
    const onCliExit = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onCliExit,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'managed_turn_origin',
      sessionId: ds.session.sessionId,
      capability: 'live-capability',
      turnId: 'om_live',
    } satisfies Extract<WorkerToDaemon, { type: 'managed_turn_origin' }>);
    expect(ds.managedTurnOrigin).toEqual({
      capability: 'live-capability',
      turnId: 'om_live',
    });

    (ds.worker as any).emit('message', {
      type: 'claude_exit', code: 9, signal: 'SIGKILL',
    } satisfies Extract<WorkerToDaemon, { type: 'claude_exit' }>);
    await Promise.resolve();

    expect(onCliExit).toHaveBeenCalledWith(ds, {
      sessionId: ds.session.sessionId,
      workerGeneration: 1,
      code: 9,
      signal: 'SIGKILL',
    });
    expect(ds.managedTurnOrigin).toBeUndefined();
  });

  it('ignores stale-worker CLI exit authority changes after replacement', async () => {
    const ds = makeDs();
    const oldWorker = ds.worker as any;
    const replacementWorker = makeDs().worker as any;
    const onCliExit = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onCliExit,
    });
    __testOnly_setupWorkerHandlers(ds, oldWorker);
    ds.worker = replacementWorker;
    __testOnly_setupWorkerHandlers(ds, replacementWorker);

    replacementWorker.emit('message', {
      type: 'managed_turn_origin',
      sessionId: ds.session.sessionId,
      capability: 'replacement-capability',
      turnId: 'om_replacement',
    } satisfies Extract<WorkerToDaemon, { type: 'managed_turn_origin' }>);

    oldWorker.emit('message', {
      type: 'claude_exit', code: 9, signal: 'SIGKILL',
    } satisfies Extract<WorkerToDaemon, { type: 'claude_exit' }>);
    await Promise.resolve();

    expect(ds.managedTurnOrigin).toEqual({
      capability: 'replacement-capability',
      turnId: 'om_replacement',
    });
    expect(onCliExit).not.toHaveBeenCalled();
  });
});
