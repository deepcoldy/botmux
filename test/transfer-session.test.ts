/**
 * transfer-session.test.ts
 *
 * Tests for `transferSession()` in worker-pool — verifies routing fields
 * (chatId / rootMessageId / scope) are rewritten in place, activeSessions
 * key rotates from source anchor to target chatId, and forkWorker is
 * invoked with resume=true so the surviving tmux session is re-attached
 * rather than recreated.
 *
 * The CLI process and tmux session are external resources; most tests stub
 * forkWorker / detachWorker so they exercise the *routing* logic in isolation.
 * Dedicated lifecycle cases below use a fake child process to cover the real
 * daemon-side detach fence.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  updateSession: vi.fn(),
  updateSessionPid: vi.fn(),
  getSession: vi.fn(),
  getOwnedSession: vi.fn(),
  listSessions: vi.fn(() => []),
  closeSession: vi.fn(),
}));

const getBotMock = vi.hoisted(() => vi.fn(() => ({
    config: { cliId: 'claude-code', larkAppId: 'cli_app_test', pinStreamingCard: false },
    botName: 'TestBot',
  })));
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...args: any[]) => getBotMock(...args),
  getAllBots: vi.fn(() => []),
  getBotBrand: vi.fn(() => 'feishu'),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

// updateMessage is used by transferSession to freeze the source-chat card
// (replace the live streaming card with an inert "已搬迁" snapshot before
// clearing streamCardId). Mock it so tests don't try real Lark API calls.
const updateMessageMock = vi.fn(async () => undefined);
const pinMessageMock = vi.fn(async () => true);
const unpinMessageMock = vi.fn(async () => true);
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: (...a: any[]) => updateMessageMock(...a),
  pinMessage: (...a: any[]) => pinMessageMock(...a),
  unpinMessage: (...a: any[]) => unpinMessageMock(...a),
  deleteMessage: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));

const unsubscribeDocFileMock = vi.fn();
const removeCommentReactionMock = vi.fn();
vi.mock('../src/im/lark/doc-comment.js', () => ({
  replyToDocComment: vi.fn(),
  chunkCommentText: vi.fn(() => []),
  unsubscribeDocFile: (...a: any[]) => unsubscribeDocFileMock(...a),
  removeCommentReaction: (...a: any[]) => removeCommentReactionMock(...a),
}));

const listDocSubscriptionsMock = vi.fn(() => [] as Array<{ fileToken: string; fileType: string }>);
const removeDocSubscriptionMock = vi.fn();
vi.mock('../src/services/doc-subs-store.js', () => ({
  listDocSubscriptionsForSession: (...a: any[]) => listDocSubscriptionsMock(...a),
  removeDocSubscription: (...a: any[]) => removeDocSubscriptionMock(...a),
}));

// transferSession accepts forkWorker/detachWorker overrides for testability —
// real forkWorker would actually spawn a child process and attach tmux.
const forkWorkerSpy = vi.fn();
const detachWorkerSpy = vi.fn();

import {
  closeSession,
  detachWorkerForTransfer,
  destroyUnregisteredPersistentBacking,
  forkAdoptWorker,
  forkWorker,
  initWorkerPool,
  isSessionTransferring,
  requestSessionRestart,
  suspendWorker,
  transferSession,
  __testOnly_setupWorkerHandlers,
  __testOnly_waitForPinStreamingCardIdle,
  pinStreamingCardIfEnabled,
  setActiveSessionsRegistry,
  setActiveSessionIfActive,
  setActiveSessionSafe,
  rollbackRejectedSessionAndGetWinner,
  sendWorkerInput,
  sendWorkerSessionInput,
} from '../src/core/worker-pool.js';
import {
  acquireDeviceIsolationFreeze,
  releaseDeviceIsolationFreeze,
  resetDeviceIsolationActivationForTest,
} from '../src/core/device-isolation-activation.js';
import * as sessionStore from '../src/services/session-store.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';
import {
  __testOnly_resetBotTurnMutationGates,
  withBotTurnAdmission,
} from '../src/core/bot-turn-mutation-gate.js';

function makeDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  const session: Session = {
    sessionId: 'sess-abc-123',
    chatId: 'oc_source',
    rootMessageId: 'om_source_root',
    title: 'test session',
    status: 'active',
    createdAt: new Date().toISOString(),
    scope: 'thread',
    chatType: 'group',
    larkAppId: 'cli_app_test',
    ownerOpenId: 'ou_user',
    workingDir: '/tmp/project',
    cliId: 'claude-code',
    streamCardId: 'om_old_card',
    streamCardNonce: 'old_nonce',
    currentImageKey: 'old_image_key',
  };
  return {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'cli_app_test',
    chatId: 'oc_source',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    workingDir: '/tmp/project',
    lastScreenStatus: 'idle',
    streamCardId: 'om_old_card',
    streamCardNonce: 'old_nonce',
    currentImageKey: 'old_image_key',
    ...overrides,
  } as DaemonSession;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('transferSession', () => {
  let registry: Map<string, DaemonSession>;

  // Helper: always inject spy implementations so the real forkWorker doesn't
  // try to spawn a child process / attach tmux during unit testing.
  const callTransfer = (
    sessionId: string,
    targetChatId: string,
    targetRootMessageId: string,
    targetChatType: 'group' | 'p2p' = 'group',
    targetScope: 'thread' | 'chat' = 'chat',
  ) => transferSession(sessionId, targetChatId, targetRootMessageId, targetChatType, targetScope, {
    forkWorkerImpl: forkWorkerSpy as any,
    detachWorkerImpl: detachWorkerSpy as any,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getBotMock.mockReturnValue({
      config: { cliId: 'claude-code', larkAppId: 'cli_app_test', pinStreamingCard: false },
      botName: 'TestBot',
    });
    __testOnly_resetBotTurnMutationGates();
    vi.mocked(sessionStore.listSessions).mockReturnValue([]);
    resetDeviceIsolationActivationForTest();
    registry = new Map();
    setActiveSessionsRegistry(registry);
  });

  it('refuses with target_chat_type_unsupported when target chat type is neither group nor p2p (depth defense)', async () => {
    // TS narrows targetChatType to 'group' | 'p2p' for normal callers — this
    // case simulates a bypass (e.g. peer HTTP endpoint feeding a body field
    // through, or a future caller passing through a raw chatType string).
    // The runtime check inside transferSession must catch it.
    const ds = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    const r = await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target', 'channel' as any);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('target_chat_type_unsupported');
    expect(forkWorkerSpy).not.toHaveBeenCalled();
    // Source ds must not have been mutated.
    expect(ds.chatId).toBe('oc_source');
  });

  it('DM flat target (p2p, chat scope): rewrites chatType to p2p and anchors on the DM chatId', async () => {
    const ds = makeDs();  // thread-scope source in oc_source
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    const r = await callTransfer(ds.session.sessionId, 'oc_dm', 'om_M1_dm', 'p2p', 'chat');
    expect(r.ok).toBe(true);
    expect(ds.session.chatType).toBe('p2p');
    expect(ds.chatType).toBe('p2p');
    expect(ds.session.scope).toBe('chat');
    expect(ds.chatId).toBe('oc_dm');
    // chat-scope anchors on chatId; rootMessageId keeps the M1 id (audit-only).
    expect(ds.session.rootMessageId).toBe('om_M1_dm');
    expect(registry.has(sessionKey('oc_dm', 'cli_app_test'))).toBe(true);
    expect(registry.has(sessionKey('om_source_root', 'cli_app_test'))).toBe(false);
  });

  it('DM topic target (p2p, thread scope): rewrites chatType to p2p and anchors on the DM 话题 root', async () => {
    const ds = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    const r = await callTransfer(ds.session.sessionId, 'oc_dm', 'om_dm_topic_root', 'p2p', 'thread');
    expect(r.ok).toBe(true);
    expect(ds.session.chatType).toBe('p2p');
    expect(ds.chatType).toBe('p2p');
    expect(ds.session.scope).toBe('thread');
    expect(ds.session.rootMessageId).toBe('om_dm_topic_root');
    expect(registry.has(sessionKey('om_dm_topic_root', 'cli_app_test'))).toBe(true);
  });

  it('re-homes buffered reply metadata so the resumed worker cannot route back to the source topic', async () => {
    const ds = makeDs({
      currentReplyTarget: {
        rootMessageId: 'om_source_reply',
        turnId: 'turn-source',
        updatedAt: new Date().toISOString(),
      },
      replyThreadAliases: {
        om_source_reply: {
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
        },
      },
      streamCardReplyTargetKey: 'thread:om_source_reply',
    });
    ds.session.currentReplyTarget = ds.currentReplyTarget;
    ds.session.replyThreadAliases = ds.replyThreadAliases;
    ds.session.streamCardReplyTargetKey = 'thread:om_source_reply';
    ds.session.turnReplyContexts = {
      'turn-source': {
        target: { mode: 'thread', rootMessageId: 'om_source_reply' },
        quoteTargetId: 'om_source_message',
        replyTargetSenderOpenId: 'ou_user',
      },
    };
    ds.session.replyTargets = {
      'turn-source': {
        rootMessageId: 'om_source_reply',
        quoteOnly: true,
        substitute: true,
        updatedAt: new Date().toISOString(),
        senderOpenId: 'ou_user',
      },
    };
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    const result = await callTransfer(
      ds.session.sessionId,
      'oc_target',
      'om_target_topic',
      'group',
      'thread',
    );

    expect(result.ok).toBe(true);
    expect(ds.currentReplyTarget).toBeUndefined();
    expect(ds.replyThreadAliases).toBeUndefined();
    expect(ds.streamCardReplyTargetKey).toBeUndefined();
    expect(ds.session.currentReplyTarget).toBeUndefined();
    expect(ds.session.replyThreadAliases).toBeUndefined();
    expect(ds.session.streamCardReplyTargetKey).toBeUndefined();
    expect(ds.session.turnReplyContexts?.['turn-source']).toEqual({
      target: { mode: 'thread', rootMessageId: 'om_target_topic' },
      replyTargetSenderOpenId: 'ou_user',
    });
    expect(ds.session.replyTargets?.['turn-source']).toEqual({
      updatedAt: expect.any(String),
      senderOpenId: 'ou_user',
    });
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('returns session_not_active when sessionId not in registry', async () => {
    const r = await callTransfer('does-not-exist', 'oc_target', 'om_target_root');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('session_not_active');
  });

  it('returns adopt_not_relayable when source session was attached via /adopt', async () => {
    const adoptDs = makeDs();
    adoptDs.session.adoptedFrom = { tmuxTarget: '0:2.0', originalCliPid: 12345, cwd: '/tmp/proj' };
    registry.set(sessionKey('om_source_root', 'cli_app_test'), adoptDs);

    const r = await callTransfer(adoptDs.session.sessionId, 'oc_target', 'om_M1_target');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('adopt_not_relayable');
    expect(forkWorkerSpy).not.toHaveBeenCalled();
    // Adopt session must remain in source chat untouched.
    expect(adoptDs.chatId).toBe('oc_source');
  });

  it('refuses transfer while the durable Codex App dispatch ledger is non-empty', async () => {
    const ds = makeDs();
    ds.session.codexAppDispatchLedger = [
      { dispatchId: 'd-1', turnId: 't-1', state: 'prepared', content: 'owned' },
    ];
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    const result = await callTransfer(ds.session.sessionId, 'oc_target', 'om_target_root');

    expect(result).toEqual({ ok: false, error: 'codex_app_dispatch_pending' });
    expect(forkWorkerSpy).not.toHaveBeenCalled();
    expect(detachWorkerSpy).not.toHaveBeenCalled();
    expect(sessionStore.updateSession).not.toHaveBeenCalled();
    expect(ds.chatId).toBe('oc_source');
    expect(ds.session.rootMessageId).toBe('om_source_root');
    expect(registry.get(sessionKey('om_source_root', 'cli_app_test'))).toBe(ds);
  });

  it('drains a pre-accept turn and rechecks durable ownership before transfer', async () => {
    const ds = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    let release!: () => void;
    let markStarted!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const inbound = withBotTurnAdmission(ds.larkAppId, async () => {
      markStarted();
      await paused;
      ds.session.codexAppDispatchLedger = [{
        dispatchId: 'd-raced',
        turnId: 't-raced',
        state: 'accepted',
        content: 'accepted before transfer',
      }];
    });
    await started;

    const transfer = callTransfer(ds.session.sessionId, 'oc_target', 'om_target_root');
    await Promise.resolve();
    expect(detachWorkerSpy).not.toHaveBeenCalled();
    release();
    await inbound;

    expect(await transfer).toEqual({ ok: false, error: 'codex_app_dispatch_pending' });
    expect(detachWorkerSpy).not.toHaveBeenCalled();
    expect(forkWorkerSpy).not.toHaveBeenCalled();
    expect(registry.get(sessionKey('om_source_root', ds.larkAppId))).toBe(ds);
  });

  it('does not kill or overwrite a source successor discovered after cleanup awaits', async () => {
    const ds = makeDs();
    const sourceKey = sessionKey('om_source_root', 'cli_app_test');
    registry.set(sourceKey, ds);
    const successor = makeDs({
      session: { ...ds.session, sessionId: 'source-successor' },
    });
    vi.mocked(sessionStore.listSessions).mockImplementationOnce(() => {
      ds.session.status = 'closed';
      registry.set(sourceKey, successor);
      return [];
    });

    const result = await callTransfer(ds.session.sessionId, 'oc_target', 'om_target_root');

    expect(result).toEqual({ ok: false, error: 'session_not_active' });
    expect(registry.get(sourceKey)).toBe(successor);
    expect(detachWorkerSpy).not.toHaveBeenCalled();
    expect(forkWorkerSpy).not.toHaveBeenCalled();
    expect(ds.chatId).toBe('oc_source');
  });

  it('returns same_anchor when a chat-scope source targets its own chat (chat→chat)', async () => {
    const ds = makeDs({ scope: 'chat' });
    ds.session.scope = 'chat';
    // chat-scope source anchors on chatId
    registry.set(sessionKey('oc_source', 'cli_app_test'), ds);
    const r = await callTransfer(ds.session.sessionId, 'oc_source', 'om_target_root', 'group', 'chat');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('same_anchor');
    expect(forkWorkerSpy).not.toHaveBeenCalled();
  });

  it('returns same_anchor when relaying a thread session onto its own root', async () => {
    const ds = makeDs();  // thread-scope anchored at om_source_root
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    const r = await callTransfer(ds.session.sessionId, 'oc_source', 'om_source_root', 'group', 'thread');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('same_anchor');
    expect(forkWorkerSpy).not.toHaveBeenCalled();
  });

  it('allows same-chat cross-topic move (thread source → a different thread anchor)', async () => {
    const ds = makeDs();  // thread-scope anchored at om_source_root in oc_source
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    const r = await callTransfer(ds.session.sessionId, 'oc_source', 'om_other_root', 'group', 'thread');
    expect(r.ok).toBe(true);
    expect(ds.session.scope).toBe('thread');
    expect(ds.session.rootMessageId).toBe('om_other_root');
    expect(ds.chatId).toBe('oc_source');
    expect(registry.has(sessionKey('om_other_root', 'cli_app_test'))).toBe(true);
    expect(registry.has(sessionKey('om_source_root', 'cli_app_test'))).toBe(false);
  });

  it('thread-scope target rewrites scope/rootMessageId and rekeys by anchor', async () => {
    const ds = makeDs();  // thread-scope source, chat oc_source
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    const r = await callTransfer(ds.session.sessionId, 'oc_target', 'om_topic_root', 'group', 'thread');
    expect(r.ok).toBe(true);
    expect(ds.session.scope).toBe('thread');
    expect(ds.scope).toBe('thread');
    expect(ds.session.rootMessageId).toBe('om_topic_root');
    expect(ds.chatId).toBe('oc_target');
    expect(registry.has(sessionKey('om_topic_root', 'cli_app_test'))).toBe(true);
    expect(registry.has(sessionKey('om_source_root', 'cli_app_test'))).toBe(false);
  });

  it('refuses with not_started_yet when source is a daemon-command scratch (no worker + no persisted CLI markers)', async () => {
    // Codex review: transferSession had no depth defense against scratch
    // sessions. pendingRepo / adopt / busy checks all let `worker:null +
    // !cliId + !lastCliInput` records through, and the body would then
    // forkWorker(resume=true) into a non-existent tmux. Picker filter +
    // card-handler preflight + --create leader guard upstream are the
    // primary protection, but this is the catch-all for any caller that
    // bypassed all three (HTTP migrate-to-chat from a future buggy
    // leader, direct registry pokes in tests, etc.).
    //
    // Also: restoreActiveSessions sets hasHistory:true unconditionally on
    // restart, so a scratch that survived a restart would defeat any
    // hasHistory-based guard — that's why the helper reads persisted
    // markers (cliId / lastCliInput) instead.
    const scratch = makeDs({
      worker: null,
      hasHistory: true,  // simulate post-restart state (hasHistory clobbered to true)
      session: {
        ...makeDs().session,
        cliId: undefined as any,
        lastCliInput: undefined as any,
      },
    });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), scratch);

    const r = await callTransfer(scratch.session.sessionId, 'oc_target', 'om_M1_target');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_started_yet');
    // Routing untouched, no fork attempted.
    expect(forkWorkerSpy).not.toHaveBeenCalled();
    expect(scratch.chatId).toBe('oc_source');
  });

  it('rewrites chatId, rootMessageId, scope, chatType in both ds and session', async () => {
    const ds = makeDs();
    // thread-scope source: key is rootMessageId-based
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    const r = await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');
    expect(r.ok).toBe(true);

    expect(ds.session.chatId).toBe('oc_target');
    expect(ds.session.rootMessageId).toBe('om_M1_target');
    expect(ds.session.scope).toBe('chat');
    expect(ds.session.chatType).toBe('group');

    expect(ds.chatId).toBe('oc_target');
    expect(ds.scope).toBe('chat');
    expect(ds.chatType).toBe('group');
  });

  it('clears card state pinned to the source chat', async () => {
    const ds = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');

    expect(ds.session.streamCardId).toBeUndefined();
    expect(ds.session.streamCardNonce).toBeUndefined();
    expect(ds.session.currentImageKey).toBeUndefined();
    expect(ds.streamCardId).toBeUndefined();
    expect(ds.streamCardNonce).toBeUndefined();
    expect(ds.currentImageKey).toBeUndefined();
  });

  it('rotates activeSessions key from old anchor to new chatId', async () => {
    const ds = makeDs();
    const oldKey = sessionKey('om_source_root', 'cli_app_test');
    registry.set(oldKey, ds);

    await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');

    expect(registry.has(oldKey)).toBe(false);
    // New scope is 'chat' so anchor is chatId.
    const newKey = sessionKey('oc_target', 'cli_app_test');
    expect(registry.get(newKey)).toBe(ds);
  });

  it('persists session record via sessionStore.updateSession', async () => {
    const ds = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');

    expect(sessionStore.updateSession).toHaveBeenCalled();
    const saved = vi.mocked(sessionStore.updateSession).mock.calls[0][0] as Session;
    expect(saved.chatId).toBe('oc_target');
    expect(saved.scope).toBe('chat');
  });

  it('publishes a dashboard session.update event reflecting the transfer', async () => {
    const ds = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');

    expect(dashboardEventBus.publish).toHaveBeenCalledWith({
      type: 'session.update',
      body: {
        sessionId: ds.session.sessionId,
        patch: {
          chatId: 'oc_target',
          rootMessageId: 'om_M1_target',
          scope: 'chat',
          chatType: 'group',
        },
      },
    });
  });

  it('calls forkWorker with empty prompt + resume=true to re-attach tmux', async () => {
    const ds = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');

    expect(forkWorkerSpy).toHaveBeenCalledTimes(1);
    const [forkDs, prompt, resume] = forkWorkerSpy.mock.calls[0];
    expect(forkDs).toBe(ds);
    expect(prompt).toBe('');
    expect(resume).toBe(true);
  });

  it('waits for detach ACK+exit and buffers new input for the replacement worker', async () => {
    const lifecycle: string[] = [];
    let detachMessage: { type: string; requestId?: string } | undefined;
    const send = vi.fn((
      message: { type: string; requestId?: string },
      callback?: (error: Error | null) => void,
    ) => {
      if (message.type === 'detach_for_transfer') detachMessage = message;
      lifecycle.push(`old:${message.type}`);
      callback?.(null);
    });
    const oldWorker = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
      send,
      kill: vi.fn(),
    }) as any;
    const ds = makeDs({
      worker: oldWorker,
      lastScreenStatus: 'idle',
      session: {
        ...makeDs().session,
        backendType: 'zmx',
        persistentBackendTarget: {
          backendType: 'zmx',
          sessionName: 'bmx-sess-abc',
        },
      },
    });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    const replacementSend = vi.fn((message: { type: string }) => {
      lifecycle.push(`replacement:${message.type}`);
    });
    const replacementWorker = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
      send: replacementSend,
      kill: vi.fn(),
    }) as any;
    const replacementFork = vi.fn((...args: Parameters<typeof forkWorker>) => {
      lifecycle.push('replacement:fork');
      ds.worker = replacementWorker;
      ds.workerGeneration = 2;
      ds.session.workerGeneration = 2;
      return forkWorkerSpy(...args);
    });
    const moving = transferSession(
      ds.session.sessionId,
      'oc_target',
      'om_M1_target',
      'group',
      'chat',
      { forkWorkerImpl: replacementFork as typeof forkWorker },
    );

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(detachMessage).toMatchObject({
      type: 'detach_for_transfer',
      requestId: expect.any(String),
    });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'close' }));
    // The replacement must not install its observer while the old worker can
    // still run a late name-scoped tmux pipe-pane detach.
    expect(replacementFork).not.toHaveBeenCalled();

    expect(sendWorkerInput(
      ds,
      'arrived during transfer',
      'turn-late',
      { dispatchAttempt: 7 },
    )).toBe(true);
    expect(sendWorkerInput(
      ds,
      'ordinary message during transfer',
      'om_transfer_late',
    )).toBe(true);
    const rawDuringTransfer = {
      type: 'raw_input' as const,
      content: '/model opus',
      turnId: 'turn-raw',
      followUpContent: 'follow-up payload',
      followUpTurnId: 'turn-follow-up',
      followUpCodexAppInput: {
        text: 'clean follow-up',
        additionalContext: {
          quoted: { kind: 'untrusted' as const, value: 'quoted context' },
        },
      },
    };
    expect(sendWorkerSessionInput(ds, rawDuringTransfer)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(replacementSend).not.toHaveBeenCalled();

    lifecycle.push('old:transfer_detached');
    oldWorker.emit('message', {
      type: 'transfer_detached',
      requestId: detachMessage!.requestId,
    });
    await Promise.resolve();
    expect(replacementFork).not.toHaveBeenCalled();

    lifecycle.push('old:exit');
    oldWorker.exitCode = 0;
    oldWorker.emit('exit', 0, null);
    const result = await moving;

    expect(result).toEqual({ ok: true });
    expect(lifecycle).toEqual([
      'old:detach_for_transfer',
      'old:transfer_detached',
      'old:exit',
      'replacement:fork',
      'replacement:message',
      'replacement:message',
      'replacement:raw_input',
    ]);
    expect(replacementFork).toHaveBeenCalledWith(ds, '', true);
    expect(replacementSend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      content: 'arrived during transfer',
      turnId: 'turn-late',
      dispatchAttempt: 7,
    }));
    expect(replacementSend).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'message',
        content: 'ordinary message during transfer',
        turnId: 'om_transfer_late',
      }),
      expect.any(Function),
    );
    expect(replacementSend).toHaveBeenNthCalledWith(3, rawDuringTransfer);
  });

  it('fails safe on detach timeout using hard retirement without ordinary close cleanup', async () => {
    const send = vi.fn((
      _message: { type: string; requestId?: string },
      callback?: (error: Error | null) => void,
    ) => callback?.(null));
    let oldWorker: any;
    const kill = vi.fn((signal: NodeJS.Signals) => {
      oldWorker.signalCode = signal;
      oldWorker.emit('exit', null, signal);
      return true;
    });
    oldWorker = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
      send,
      kill,
    }) as any;
    const ds = makeDs({ worker: oldWorker, lastScreenStatus: 'idle' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    const completed = await detachWorkerForTransfer(ds, { timeoutMs: 1 });

    expect(completed).toBe(false);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'detach_for_transfer',
        requestId: expect.any(String),
      }),
      expect.any(Function),
    );
    expect(oldWorker.kill).toHaveBeenCalledWith('SIGKILL');
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'close' }),
      expect.anything(),
    );
    expect(ds.worker).toBeNull();
    expect(ds.chatId).toBe('oc_source');
    expect(ds.session.rootMessageId).toBe('om_source_root');
  });

  it('force-kills a worker that ACKs the detach but never self-exits (node-pty exit wedge), completing the transfer', async () => {
    // The production bug: the worker runs killCli + sends transfer_detached in
    // ~9ms, then process.exit(0) wedges in node-pty's native teardown (an open
    // web-terminal client PTY blocks the reader-thread join; the JS loop is
    // already stopped so the worker cannot self-kill). The daemon must not sit
    // out the whole fence waiting for an exit that never comes on its own — once
    // the ACK proves the observer detached, it force-kills the disposable
    // process. Here the worker ACKs but ONLY exits when SIGKILLed by the daemon.
    let oldWorker: any;
    const send = vi.fn((
      message: { type: string; requestId?: string },
      callback?: (error: Error | null) => void,
    ) => {
      callback?.(null);
      // ACK the detach on the next tick, but deliberately do NOT emit 'exit' —
      // simulate the wedged process.exit(0). Only the daemon's SIGKILL ends it.
      if (message.type === 'detach_for_transfer') {
        queueMicrotask(() => oldWorker.emit('message', {
          type: 'transfer_detached',
          requestId: message.requestId,
        }));
      }
    });
    const kill = vi.fn((signal: NodeJS.Signals) => {
      oldWorker.signalCode = signal;
      oldWorker.emit('exit', null, signal);
      return true;
    });
    oldWorker = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
      send,
      kill,
    }) as any;
    const ds = makeDs({ worker: oldWorker, lastScreenStatus: 'idle' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    // No manual exit emission — the daemon's post-ACK kill is the ONLY thing
    // that can end this worker. If the fix regressed, this would hang until the
    // full fence and return false.
    const completed = await detachWorkerForTransfer(ds);

    expect(completed).toBe(true);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(ds.worker).toBeNull();
    // Source routing untouched by the detach itself (transferSession rewrites it).
    expect(ds.chatId).toBe('oc_source');
    expect(ds.session.rootMessageId).toBe('om_source_root');
  });

  it('keeps detach timeout bounded when the child IPC send callback never fires', async () => {
    const send = vi.fn(() => undefined);
    let oldWorker: any;
    const kill = vi.fn((signal: NodeJS.Signals) => {
      oldWorker.signalCode = signal;
      oldWorker.emit('exit', null, signal);
      return true;
    });
    oldWorker = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
      send,
      kill,
    }) as any;
    const ds = makeDs({ worker: oldWorker, lastScreenStatus: 'idle' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    const outcome = await Promise.race([
      detachWorkerForTransfer(ds, { timeoutMs: 1 }).then(result => ({
        kind: 'returned' as const,
        result,
      })),
      new Promise<{ kind: 'hung' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'hung' }), 50);
      }),
    ]);

    expect(outcome).toEqual({ kind: 'returned', result: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(oldWorker.kill).toHaveBeenCalledWith('SIGKILL');
    expect(ds.worker).toBeNull();
    expect(ds.chatId).toBe('oc_source');
    expect(ds.session.rootMessageId).toBe('om_source_root');
  });

  it('cold-reattaches the unchanged source after a real detach timeout with no buffered input', async () => {
    const send = vi.fn((
      _message: { type: string; requestId?: string },
      callback?: (error: Error | null) => void,
    ) => callback?.(null));
    let oldWorker: any;
    const kill = vi.fn((signal: NodeJS.Signals) => {
      oldWorker.signalCode = signal;
      oldWorker.emit('exit', null, signal);
      return true;
    });
    oldWorker = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
      send,
      kill,
    });
    const ds = makeDs({ worker: oldWorker, lastScreenStatus: 'idle' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    const sourceFork = vi.fn();

    const result = await transferSession(
      ds.session.sessionId,
      'oc_target',
      'om_M1_target',
      'group',
      'chat',
      {
        forkWorkerImpl: sourceFork as any,
        detachWorkerImpl: current => detachWorkerForTransfer(current, { timeoutMs: 1 }),
      },
    );

    expect(result).toEqual({ ok: false, error: 'worker_detach_timeout' });
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(sourceFork).toHaveBeenCalledWith(ds, '', true);
    expect(ds.chatId).toBe('oc_source');
    expect(registry.get(sessionKey('om_source_root', 'cli_app_test'))).toBe(ds);
  });

  it('keeps source routing and cold-reattaches when the transfer detach fence fails', async () => {
    const ds = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    updateMessageMock.mockClear();

    const result = await transferSession(
      ds.session.sessionId,
      'oc_target',
      'om_M1_target',
      'group',
      'chat',
      {
        forkWorkerImpl: forkWorkerSpy as any,
        detachWorkerImpl: vi.fn(() => false),
      },
    );

    expect(result).toEqual({ ok: false, error: 'worker_detach_timeout' });
    expect(forkWorkerSpy).toHaveBeenCalledWith(ds, '', true);
    expect(ds.chatId).toBe('oc_source');
    expect(ds.session.rootMessageId).toBe('om_source_root');
    expect(registry.get(sessionKey('om_source_root', 'cli_app_test'))).toBe(ds);
    expect(registry.has(sessionKey('oc_target', 'cli_app_test'))).toBe(false);
    expect(updateMessageMock).not.toHaveBeenCalled();
  });

  it('restarts on the source route and replays buffered input after detach timeout', async () => {
    let oldWorker: any;
    const send = vi.fn((
      _message: { type: string; requestId?: string },
      callback?: (error: Error | null) => void,
    ) => callback?.(null));
    const kill = vi.fn((signal: NodeJS.Signals) => {
      oldWorker.signalCode = signal;
      oldWorker.emit('exit', null, signal);
      return true;
    });
    oldWorker = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
      send,
      kill,
    });
    const ds = makeDs({ worker: oldWorker, lastScreenStatus: 'idle' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    const replacementSend = vi.fn();
    const replacementWorker = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
      send: replacementSend,
      kill: vi.fn(),
    }) as any;
    const sourceFork = vi.fn(() => {
      ds.worker = replacementWorker;
    });
    const moving = transferSession(
      ds.session.sessionId,
      'oc_target',
      'om_M1_target',
      'group',
      'chat',
      {
        forkWorkerImpl: sourceFork as any,
        detachWorkerImpl: current => detachWorkerForTransfer(current, { timeoutMs: 1 }),
      },
    );

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const rawDuringTimeout = {
      type: 'raw_input' as const,
      content: '/effort high',
      turnId: 'turn-timeout-raw',
      followUpContent: 'source follow-up',
      followUpTurnId: 'turn-timeout-follow-up',
      followUpCodexAppInput: {
        text: 'source clean follow-up',
        additionalContext: {
          attachment: { kind: 'untrusted' as const, value: '/tmp/a.png' },
        },
      },
    };
    expect(sendWorkerSessionInput(ds, rawDuringTimeout)).toBe(true);
    expect(sendWorkerInput(ds, 'keep this turn', 'turn-timeout')).toBe(true);
    const result = await moving;

    expect(result).toEqual({ ok: false, error: 'worker_detach_timeout' });
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(ds.chatId).toBe('oc_source');
    expect(ds.session.rootMessageId).toBe('om_source_root');
    expect(sourceFork).toHaveBeenCalledWith(ds, '', true);
    expect(replacementSend).toHaveBeenNthCalledWith(1, rawDuringTimeout);
    expect(replacementSend).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'message',
      content: 'keep this turn',
      turnId: 'turn-timeout',
    }));
    expect(updateMessageMock).not.toHaveBeenCalled();
  });

  it('refuses transfer while a live worker generation has not reached ready', async () => {
    const worker = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
      send: vi.fn(),
      kill: vi.fn(),
    }) as any;
    const ds = makeDs({
      worker,
      workerReady: false,
      lastScreenStatus: 'idle',
    });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    const result = await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');

    expect(result).toEqual({ ok: false, error: 'worker_busy' });
    expect(detachWorkerSpy).not.toHaveBeenCalled();
    expect(forkWorkerSpy).not.toHaveBeenCalled();
  });

  it('refuses transfer until a previously suspended worker actually exits', async () => {
    const worker = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
      send: vi.fn(),
      kill: vi.fn(),
    }) as any;
    const ds = makeDs({
      worker,
      workerReady: true,
      lastScreenStatus: 'idle',
      initConfig: { backendType: 'tmux' } as any,
    });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    expect(suspendWorker(ds, 'test')).toBe(true);
    expect(ds.worker).toBeNull();
    const result = await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');

    expect(result).toEqual({ ok: false, error: 'worker_busy' });
    expect(detachWorkerSpy).not.toHaveBeenCalled();

    worker.exitCode = 0;
    worker.emit('exit', 0, null);
  });

  it('blocks restart and suspend requests while the transfer gate is active', async () => {
    const worker = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
      send: vi.fn(),
      kill: vi.fn(),
    }) as any;
    const ds = makeDs({
      worker,
      workerReady: true,
      lastScreenStatus: 'idle',
      initConfig: { backendType: 'tmux' } as any,
    });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    let releaseDetach!: (completed: boolean) => void;
    const detach = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseDetach = resolve;
    }));
    const moving = transferSession(
      ds.session.sessionId,
      'oc_target',
      'om_M1_target',
      'group',
      'chat',
      {
        detachWorkerImpl: detach,
        forkWorkerImpl: forkWorkerSpy as any,
      },
    );
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
    expect(isSessionTransferring(ds)).toBe(true);

    expect(requestSessionRestart(ds, {
      source: 'slash',
      notify: vi.fn(),
    })).toBeUndefined();
    expect(suspendWorker(ds, 'test')).toBe(false);
    expect(worker.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'restart' }));
    expect(worker.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'suspend' }));

    releaseDetach(true);
    await moving;
  });

  it('defers source reattach behind a device-isolation freeze that arrives during detach', async () => {
    const ds = makeDs({ worker: null, lastScreenStatus: 'idle' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    updateMessageMock.mockClear();

    let releaseDetach!: (completed: boolean) => void;
    const detach = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseDetach = resolve;
    }));
    const sourceFork = vi.fn();
    const moving = transferSession(
      ds.session.sessionId,
      'oc_target',
      'om_M1_target',
      'group',
      'chat',
      {
        detachWorkerImpl: detach,
        forkWorkerImpl: sourceFork as any,
      },
    );
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());

    const acquired = acquireDeviceIsolationFreeze({
      nonce: 'transfer-freeze',
      inventoryGeneration: 'generation-1',
      leaseIdFactory: () => 'lease-transfer',
    });
    expect(acquired.ok).toBe(true);
    releaseDetach(true);

    const result = await moving;
    expect(result).toEqual({ ok: false, error: 'worker_busy' });
    expect(sourceFork).not.toHaveBeenCalled();
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(ds.chatId).toBe('oc_source');

    if (!acquired.ok) throw new Error('freeze acquisition unexpectedly failed');
    expect(releaseDeviceIsolationFreeze({
      nonce: acquired.lease.nonce,
      leaseId: acquired.lease.leaseId,
    })).toBe(true);
    await vi.waitFor(() => expect(sourceFork).toHaveBeenCalledWith(ds, '', true));
  });

  it('lets explicit close win while detach is in flight and never revives the source', async () => {
    const ds = makeDs({
      worker: null,
      lastScreenStatus: 'idle',
      session: {
        ...makeDs().session,
        backendType: 'pty',
      },
    });
    const sourceKey = sessionKey('om_source_root', 'cli_app_test');
    registry.set(sourceKey, ds);

    let releaseDetach!: (completed: boolean) => void;
    const detach = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseDetach = resolve;
    }));
    const replacementFork = vi.fn();
    const moving = transferSession(
      ds.session.sessionId,
      'oc_target',
      'om_M1_target',
      'group',
      'chat',
      {
        detachWorkerImpl: detach,
        forkWorkerImpl: replacementFork as any,
      },
    );
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());

    await closeSession(ds.session.sessionId);
    releaseDetach(true);
    const result = await moving;

    expect(result).toEqual({ ok: false, error: 'session_not_active' });
    expect(ds.session.status).toBe('closed');
    expect(registry.has(sourceKey)).toBe(false);
    expect(replacementFork).not.toHaveBeenCalled();
    expect(updateMessageMock).not.toHaveBeenCalled();
  });

  it('keeps a committed transfer successful when replacement fork and replay throw', async () => {
    const ds = makeDs({ worker: null, lastScreenStatus: 'idle' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    let releaseDetach!: (completed: boolean) => void;
    const detach = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseDetach = resolve;
    }));
    const throwingFork = vi.fn(() => {
      throw new Error('fork exploded');
    });
    const moving = transferSession(
      ds.session.sessionId,
      'oc_target',
      'om_M1_target',
      'group',
      'chat',
      {
        detachWorkerImpl: detach,
        forkWorkerImpl: throwingFork as any,
      },
    );
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
    expect(sendWorkerInput(ds, 'preserve me', 'turn-preserve')).toBe(true);
    releaseDetach(true);

    await expect(moving).resolves.toEqual({ ok: true });
    expect(ds.chatId).toBe('oc_target');
    expect(throwingFork).toHaveBeenCalled();
    expect(isSessionTransferring(ds)).toBe(true);
  });

  it('preserves pending raw input through an empty refork requested during transfer', async () => {
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp/project',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs({
      worker: null,
      lastScreenStatus: 'idle',
      pendingRawInput: '/goal ship it',
      pendingRawTurnId: 'turn-goal',
      streamCardId: undefined,
      session: {
        ...makeDs().session,
        streamCardId: undefined,
      },
    });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    let releaseDetach!: (completed: boolean) => void;
    const detach = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseDetach = resolve;
    }));
    const replacement = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
      send: vi.fn(),
      kill: vi.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    }) as any;
    const replacementFork = vi.fn(() => {
      ds.worker = replacement;
    });
    const moving = transferSession(
      ds.session.sessionId,
      'oc_target',
      'om_M1_target',
      'group',
      'chat',
      {
        detachWorkerImpl: detach,
        forkWorkerImpl: replacementFork as any,
      },
    );
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());

    forkWorker(ds, '', true);
    expect(replacementFork).not.toHaveBeenCalled();
    releaseDetach(true);
    await expect(moving).resolves.toEqual({ ok: true });
    expect(replacementFork).toHaveBeenCalledTimes(1);

    __testOnly_setupWorkerHandlers(ds, replacement);
    replacement.emit('message', { type: 'prompt_ready' });
    await Promise.resolve();

    expect(replacement.send).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/goal ship it',
      turnId: 'turn-goal',
    });
    expect(ds.pendingRawInput).toBeUndefined();
    expect(ds.pendingRawTurnId).toBeUndefined();
  });

  it('returns worker_busy immediately when worker is mid-turn (no idle-wait loop)', async () => {
    // Source worker is alive and not in idle/limited → refuse on first check.
    // This is the design contract change: previously transferSession waited
    // up to 60s for the worker to settle; now it refuses on first miss so
    // leader / peer reports stay consistent under the 5s HTTP timeout used
    // by /relay --create's peer coordinator.
    const fakeWorker = { killed: false } as any;
    const ds = makeDs({ worker: fakeWorker, lastScreenStatus: 'working' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    const r = await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('worker_busy');
    expect(forkWorkerSpy).not.toHaveBeenCalled();
    // Routing fields must be untouched after a busy abort.
    expect(ds.chatId).toBe('oc_source');
    expect(ds.session.scope).toBe('thread');
  });

  it('returns not_started_yet when source session is in pendingRepo state', async () => {
    // pendingRepo session: worker never started, no CLI memory to relay.
    // Refuse so the user finishes setup in the source chat first instead
    // of producing an empty new-chat session.
    const ds = makeDs({ pendingRepo: true });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    const r = await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_started_yet');
    expect(forkWorkerSpy).not.toHaveBeenCalled();
    expect(ds.chatId).toBe('oc_source');
  });

  it('refuses with target_chat_has_session when target chat already has a chat-scope session for this bot', async () => {
    const movingDs = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), movingDs);

    // Pre-existing chat-scope session in the target chat for the same bot
    // with a real worker — this is what should trigger the conflict.
    const existingDs = makeDs({
      session: {
        ...movingDs.session,
        sessionId: 'existing-sess-in-target',
        chatId: 'oc_target',
        rootMessageId: 'om_target_seed',
        scope: 'chat',
      },
      worker: { killed: false } as any, // real running session
      chatId: 'oc_target',
      scope: 'chat',
    });
    registry.set(sessionKey('oc_target', 'cli_app_test'), existingDs);

    const r = await callTransfer(movingDs.session.sessionId, 'oc_target', 'om_M1_target');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('target_chat_has_session');
    expect(forkWorkerSpy).not.toHaveBeenCalled();
    expect(movingDs.chatId).toBe('oc_source');
    expect(movingDs.session.scope).toBe('thread');
    expect(registry.get(sessionKey('oc_target', 'cli_app_test'))).toBe(existingDs);
  });

  it('refuses a disk-only legacy target owner with an unsettled Codex App dispatch', async () => {
    const movingDs = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), movingDs);
    const legacyConflict: Session = {
      ...movingDs.session,
      sessionId: 'legacy-disk-only-owner',
      chatId: 'oc_target',
      rootMessageId: 'om_legacy_target',
      scope: 'chat',
      larkAppId: undefined,
      codexAppDispatchLedger: [{
        dispatchId: 'legacy-dispatch',
        turnId: 'legacy-turn',
        state: 'prepared',
        content: 'owned output',
        deliverySink: 'lark',
      }],
    };
    vi.mocked(sessionStore.listSessions).mockReturnValue([legacyConflict]);

    const result = await callTransfer(
      movingDs.session.sessionId,
      'oc_target',
      'om_M1_target',
    );

    expect(result).toEqual({ ok: false, error: 'target_chat_has_session' });
    expect(sessionStore.closeSession).not.toHaveBeenCalled();
    expect(detachWorkerSpy).not.toHaveBeenCalled();
    expect(forkWorkerSpy).not.toHaveBeenCalled();
    expect(movingDs.chatId).toBe('oc_source');
    expect(registry.get(sessionKey('om_source_root', 'cli_app_test'))).toBe(movingDs);
  });

  it('retires a disk-only legacy scratch before claiming the target anchor', async () => {
    const movingDs = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), movingDs);
    const legacyScratch: Session = {
      ...movingDs.session,
      sessionId: 'legacy-disk-only-scratch',
      chatId: 'oc_target',
      rootMessageId: 'om_legacy_scratch',
      scope: 'chat',
      larkAppId: undefined,
      cliId: undefined,
      lastCliInput: undefined,
      queued: false,
      codexAppDispatchLedger: [],
    };
    vi.mocked(sessionStore.listSessions).mockReturnValue([legacyScratch]);
    // closeSession() consults getOwnedSession (owner-scoped) to decide whether
    // to persist the close — getSession's cross-file read-only fallback must
    // never authorize a close, so the merged worker-pool uses getOwnedSession.
    vi.mocked(sessionStore.getOwnedSession).mockImplementation((sid: string) =>
      sid === legacyScratch.sessionId ? legacyScratch : undefined,
    );

    const result = await callTransfer(
      movingDs.session.sessionId,
      'oc_target',
      'om_M1_target',
    );

    expect(result).toEqual({ ok: true });
    // Disk-only scratch has no live worker, so closeSession cleans up bridge
    // markers on the persisted close.
    expect(sessionStore.closeSession).toHaveBeenCalledWith(legacyScratch.sessionId, { cleanupBridgeMarkers: true });
    expect(registry.get(sessionKey('oc_target', 'cli_app_test'))).toBe(movingDs);
    expect(forkWorkerSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the daemon-command scratch session occupying the target chat slot', async () => {
    // Regression: a /relay command in the target chat creates a placeholder
    // session record with `worker: null`. Previously the pre-flight scan
    // `continue`d past it as not-a-conflict, then the post-transfer
    // activeSessions.set silently overwrote the scratch's Map entry while
    // leaving its sessionStore row as status='active' — a ghost-active
    // that resurfaced on next daemon restart (王皓's "占用者：e833de5e"
    // toast). The fix: close the scratch in-line so the slot is properly
    // freed before we set the relayed session at the same key.
    const movingDs = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), movingDs);

    const scratchDs = makeDs({
      session: {
        ...movingDs.session,
        sessionId: 'scratch-relay-cmd',
        chatId: 'oc_target',
        rootMessageId: 'om_relay_cmd_msg',
        scope: 'chat',
        title: '/relay',
        cliId: undefined,
        lastCliInput: undefined,
      },
      worker: null, // command-time placeholder, no real worker
      chatId: 'oc_target',
      scope: 'chat',
    });
    registry.set(sessionKey('oc_target', 'cli_app_test'), scratchDs);
    // getOwnedSession is consulted by closeSession to decide whether to mark
    // the store row closed — return a status='active' record so the store
    // close path fires.
    vi.mocked(sessionStore.getOwnedSession).mockImplementation((sid: string) =>
      sid === 'scratch-relay-cmd' ? ({ ...scratchDs.session, status: 'active' }) as any : undefined,
    );

    const r = await callTransfer(movingDs.session.sessionId, 'oc_target', 'om_M1_target');
    expect(r.ok).toBe(true);
    // Scratch must be marked closed in the store, not silently orphaned.
    expect(sessionStore.closeSession).toHaveBeenCalledWith('scratch-relay-cmd', { cleanupBridgeMarkers: true });
    // The target-chat Map slot now holds the relayed session, not the scratch.
    expect(registry.get(sessionKey('oc_target', 'cli_app_test'))).toBe(movingDs);
  });

  it.each(['dormant-real', 'pending-repo', 'queued', 'deferred-prompt'] as const)(
    'never evicts a worker-less %s target as disposable scratch',
    async (kind) => {
      const movingDs = makeDs();
      registry.set(sessionKey('om_source_root', 'cli_app_test'), movingDs);

      const target = makeDs({
        worker: null,
        pendingRepo: kind === 'pending-repo',
        pendingPrompt: kind === 'deferred-prompt' ? '' : undefined,
        session: {
          ...movingDs.session,
          sessionId: `protected-${kind}`,
          chatId: 'oc_target',
          rootMessageId: 'om_target_protected',
          scope: 'chat',
          cliId: kind === 'dormant-real' ? 'claude-code' : undefined,
          lastCliInput: undefined,
          queued: kind === 'queued',
        },
        chatId: 'oc_target',
        scope: 'chat',
      });
      registry.set(sessionKey('oc_target', 'cli_app_test'), target);

      expect(await callTransfer(movingDs.session.sessionId, 'oc_target', 'om_M1_target')).toEqual({
        ok: false,
        error: 'target_chat_has_session',
      });
      expect(sessionStore.closeSession).not.toHaveBeenCalled();
      expect(registry.get(sessionKey('oc_target', 'cli_app_test'))).toBe(target);
    },
  );

  it('allows transfer when target chat has only thread-scope sessions (no chat-scope collision)', async () => {
    const movingDs = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), movingDs);

    // Same chat as target, but rooted at a different thread — anchor is
    // rootMessageId, so sessionKey doesn't collide.
    const otherThreadDs = makeDs({
      session: {
        ...movingDs.session,
        sessionId: 'thread-sess-in-target',
        chatId: 'oc_target',
        rootMessageId: 'om_other_thread_root',
        scope: 'thread',
      },
      chatId: 'oc_target',
      scope: 'thread',
    });
    registry.set(sessionKey('om_other_thread_root', 'cli_app_test'), otherThreadDs);

    const r = await callTransfer(movingDs.session.sessionId, 'oc_target', 'om_M1_target');
    expect(r.ok).toBe(true);
  });

  it('freezes the source-chat streaming card before clearing streamCardId', async () => {
    // After /relay, the source-chat card's action buttons (close / toggle /
    // get write link) carried `session_id` and would still reach the now-
    // relocated session — clicking ❌关闭 on the source-chat card would close
    // the (now-live in target chat) session. Fix: PATCH the source card to
    // an inert snapshot before the transfer proceeds. This test pins that
    // patch invocation so a refactor can't silently drop it.
    const ds = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    updateMessageMock.mockClear();

    const r = await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');
    expect(r.ok).toBe(true);

    // updateMessage was called once, targeting the OLD card with a JSON body
    // that contains the "已搬迁" status string (i18n key card.status.relay_frozen).
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    const [appId, cardId, body] = updateMessageMock.mock.calls[0];
    expect(appId).toBe('cli_app_test');
    expect(cardId).toBe('om_old_card');
    expect(body).toMatch(/已搬迁|Relayed away/);
    // Freeze card has NO action elements — buttons removed.
    expect(body).not.toMatch(/"tag":\s*"action"/);
    // ds.currentImageKey is 'old_image_key' in makeDs → frozen card should
    // embed an img element referencing it (preferred over the text fallback).
    expect(body).toMatch(/"tag":\s*"img"/);
    expect(body).toMatch(/"img_key":\s*"old_image_key"/);
  });

  it('leaves manual source Pins untouched when streaming-card Pin was never enabled', async () => {
    const ds = makeDs({ frozenCards: new Map([
      ['prior', { messageId: 'om_frozen_card', content: '', title: '', displayMode: 'hidden' }],
    ]) });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    const r = await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');
    expect(r.ok).toBe(true);
    expect(registry.get(sessionKey('oc_target', 'cli_app_test'))).toBe(ds);
    expect(unpinMessageMock).not.toHaveBeenCalled();
  });

  it('makes zero Pin or Unpin calls for an enabled transfer on an apiOnly transport', async () => {
    const ds = makeDs({ frozenCards: new Map([
      ['prior', { messageId: 'om_frozen_card', content: '', title: '', displayMode: 'hidden' }],
    ]) });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    getBotMock.mockReturnValue({
      config: { cliId: 'claude-code', larkAppId: 'cli_app_test', pinStreamingCard: true, apiOnly: true },
      botName: 'TestBot',
    });

    await expect(callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target')).resolves.toEqual({ ok: true });
    await __testOnly_waitForPinStreamingCardIdle();

    expect(pinMessageMock).not.toHaveBeenCalled();
    expect(unpinMessageMock).not.toHaveBeenCalled();
  });

  it('returns committed transfer success before a slow feature-owned source Unpin settles', async () => {
    const ds = makeDs({ frozenCards: new Map([
      ['prior', { messageId: 'om_frozen_card', content: '', title: '', displayMode: 'hidden' }],
    ]) });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    getBotMock.mockReturnValue({
      config: { cliId: 'claude-code', larkAppId: 'cli_app_test', pinStreamingCard: true },
      botName: 'TestBot',
    });
    await expect(pinStreamingCardIfEnabled(ds, 'om_old_card')).resolves.toBe(true);

    const unpinStarted = deferred<void>();
    const releaseUnpin = deferred<boolean>();
    unpinMessageMock.mockImplementationOnce(() => {
      unpinStarted.resolve();
      return releaseUnpin.promise;
    });

    await expect(callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target')).resolves.toEqual({ ok: true });
    await unpinStarted.promise;
    expect(unpinMessageMock).toHaveBeenCalledWith('cli_app_test', 'om_old_card');

    releaseUnpin.resolve(false);
    await __testOnly_waitForPinStreamingCardIdle();
  });

  it('does not start source Pin cleanup when an enabled transfer is refused', async () => {
    const ds = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    registry.set(sessionKey('oc_target', 'cli_app_test'), makeDs({
      session: { ...ds.session, sessionId: 'target-existing', chatId: 'oc_target', rootMessageId: 'om_M1_target', scope: 'chat' },
      chatId: 'oc_target',
      scope: 'chat',
    }));
    getBotMock.mockReturnValue({
      config: { cliId: 'claude-code', larkAppId: 'cli_app_test', pinStreamingCard: true },
      botName: 'TestBot',
    });

    await expect(callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target')).resolves.toEqual({
      ok: false, error: 'target_chat_has_session',
    });
    expect(unpinMessageMock).not.toHaveBeenCalled();
  });

  it('reattaches at the routing commit before awaiting the source-card patch', async () => {
    const ds = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    const patch = deferred<void>();
    updateMessageMock.mockImplementationOnce(() => patch.promise);

    const transferring = callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');
    await vi.waitFor(() => expect(updateMessageMock).toHaveBeenCalledTimes(1));

    // The target owner is already runnable before the best-effort Lark PATCH.
    // A close that wins during that await must not be followed by a stale fork.
    expect(forkWorkerSpy).toHaveBeenCalledTimes(1);
    expect(registry.get(sessionKey('oc_target', 'cli_app_test'))).toBe(ds);
    registry.delete(sessionKey('oc_target', 'cli_app_test'));
    ds.session.status = 'closed';

    patch.resolve();
    await expect(transferring).resolves.toEqual({ ok: true });
    expect(forkWorkerSpy).toHaveBeenCalledTimes(1);
    expect(registry.has(sessionKey('oc_target', 'cli_app_test'))).toBe(false);
  });

  it('frozen card renders no extra element when no currentImageKey is set (hidden mode)', async () => {
    // Sessions in hidden / collapsed display mode never produced a server-
    // rendered screenshot, so currentImageKey is undefined. We deliberately
    // do NOT fall back to a raw-tmux-pane code block — that text is long,
    // noisy, and not useful as a historical snapshot (王皓 caught this).
    // The frozen card stays minimal: header + "已搬迁" notice text only.
    const ds = makeDs({ currentImageKey: undefined, lastScreenContent: 'hello from tmux\n$ idle' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    updateMessageMock.mockClear();

    const r = await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');
    expect(r.ok).toBe(true);

    const body = updateMessageMock.mock.calls[0][2];
    expect(body).not.toMatch(/"tag":\s*"img"/);
    // No code block, no echoing of cached pane content.
    expect(body).not.toContain('hello from tmux');
    expect(body).not.toContain('```');
    // Still has the body notice + header.
    expect(body).toMatch(/已搬迁|Relayed away/);
  });

  it('still succeeds when freezing the source-chat card fails (best-effort)', async () => {
    // Freeze is best-effort — Lark may reject the patch (card withdrawn,
    // expired). The transfer itself must not depend on it.
    const ds = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    updateMessageMock.mockRejectedValueOnce(new Error('card withdrawn'));

    const r = await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');
    expect(r.ok).toBe(true);
    expect(ds.session.chatId).toBe('oc_target');
  });

  it('does not hold the committed move or replacement startup behind the source-card PATCH', async () => {
    const ds = makeDs();
    const sourceKey = sessionKey('om_source_root', 'cli_app_test');
    registry.set(sourceKey, ds);

    let releaseFreeze!: () => void;
    updateMessageMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFreeze = resolve;
    }));

    const moving = callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');
    await vi.waitFor(() => expect(updateMessageMock).toHaveBeenCalledTimes(1));

    const r = await moving;
    expect(r).toEqual({ ok: true });
    expect(detachWorkerSpy).toHaveBeenCalledWith(ds);
    expect(forkWorkerSpy).toHaveBeenCalledWith(ds, '', true);
    expect(ds.chatId).toBe('oc_target');
    expect(registry.get(sessionKey('oc_target', 'cli_app_test'))).toBe(ds);
    expect(registry.has(sourceKey)).toBe(false);

    // Settle the deliberately slow best-effort PATCH so the test leaves no
    // unresolved work behind.
    releaseFreeze();
  });

  it('reattaches on the source and leaves its card live when a target appears during detach', async () => {
    const ds = makeDs();
    const sourceKey = sessionKey('om_source_root', 'cli_app_test');
    registry.set(sourceKey, ds);

    let releaseDetach!: (completed: boolean) => void;
    const detach = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseDetach = resolve;
    }));
    const sourceFork = vi.fn();
    const moving = transferSession(
      ds.session.sessionId,
      'oc_target',
      'om_M1_target',
      'group',
      'chat',
      {
        detachWorkerImpl: detach,
        forkWorkerImpl: sourceFork as any,
      },
    );
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());

    const target = makeDs({
      worker: { killed: false } as any,
      session: {
        ...makeDs().session,
        sessionId: 'target-created-during-freeze',
        chatId: 'oc_target',
        rootMessageId: 'om_target_existing',
        scope: 'chat',
      },
      chatId: 'oc_target',
      scope: 'chat',
    });
    registry.set(sessionKey('oc_target', 'cli_app_test'), target);
    releaseDetach(true);

    const r = await moving;
    expect(r).toEqual({ ok: false, error: 'target_chat_has_session' });
    expect(sourceFork).toHaveBeenCalledWith(ds, '', true);
    expect(registry.get(sessionKey('oc_target', 'cli_app_test'))).toBe(target);
    expect(registry.get(sourceKey)).toBe(ds);
    expect(ds.chatId).toBe('oc_source');
    expect(updateMessageMock).not.toHaveBeenCalled();
  });

  it('defers a worker-null refork that arrives while detach is pending', async () => {
    const ds = makeDs({ worker: null, lastScreenStatus: 'idle' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    let releaseDetach!: (completed: boolean) => void;
    const detach = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseDetach = resolve;
    }));
    const replacementSend = vi.fn();
    const replacementWorker = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
      send: replacementSend,
      kill: vi.fn(),
    }) as any;
    const replacementFork = vi.fn(() => {
      ds.worker = replacementWorker;
    });
    const moving = transferSession(
      ds.session.sessionId,
      'oc_target',
      'om_M1_target',
      'group',
      'chat',
      {
        forkWorkerImpl: replacementFork as any,
        detachWorkerImpl: detach,
      },
    );
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());

    forkWorker(
      ds,
      { content: 'arrived while detach was pending' },
      { resume: true, turnId: 'turn-detach', dispatchAttempt: 11 },
    );
    expect(replacementFork).not.toHaveBeenCalled();

    releaseDetach(true);
    const result = await moving;

    expect(result).toEqual({ ok: true });
    expect(replacementFork).toHaveBeenCalledTimes(1);
    expect(replacementFork).toHaveBeenCalledWith(ds, '', true);
    expect(replacementSend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      content: 'arrived while detach was pending',
      turnId: 'turn-detach',
      dispatchAttempt: 11,
    }));
  });

  it('does not call updateMessage when there is no source-chat card to freeze', async () => {
    const ds = makeDs({ streamCardId: undefined, session: {
      ...makeDs().session, streamCardId: undefined,
    }});
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    updateMessageMock.mockClear();

    const r = await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');
    expect(r.ok).toBe(true);
    expect(updateMessageMock).not.toHaveBeenCalled();
  });

  it('proceeds when worker is in limited state (parked on usage-limit prompt)', async () => {
    const fakeWorker = { killed: false } as any;
    const ds = makeDs({ worker: fakeWorker, lastScreenStatus: 'limited' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    const r = await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');
    expect(r.ok).toBe(true);
    expect(detachWorkerSpy).toHaveBeenCalledWith(ds);
    expect(forkWorkerSpy).toHaveBeenCalledTimes(1);
  });
});

describe('setActiveSessionSafe', () => {
  let registry: Map<string, DaemonSession>;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new Map();
    setActiveSessionsRegistry(registry);
  });

  function makeSimpleDs(sessionId: string, chatId = 'oc_c'): DaemonSession {
    const session: Session = {
      sessionId,
      chatId,
      rootMessageId: `om_${sessionId}`,
      title: 't',
      status: 'active',
      createdAt: new Date().toISOString(),
      scope: 'chat',
      chatType: 'group',
      larkAppId: 'cli_app_test',
      ownerOpenId: 'ou_u',
      workingDir: '/tmp',
      cliId: 'claude-code',
    };
    return {
      session,
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId: 'cli_app_test',
      chatId,
      chatType: 'group',
      scope: 'chat',
      spawnedAt: Date.now(),
      cliVersion: '1.0.0',
      lastMessageAt: Date.now(),
      hasHistory: true,
      workingDir: '/tmp',
    } as DaemonSession;
  }

  it('closes the prior occupant when the key is already held by a different session', async () => {
    // Same-key collision: this is the second half of the scratch-ghost fix.
    // restoreActiveSessions iterates two on-disk active sessions resolving
    // to the same chat-scope key. Bare Map.set silently drops the loser;
    // setActiveSessionSafe closes it instead so its store row doesn't stay
    // status='active' as a ghost. (setActiveSessionSafe = PR #597's
    // object-returning registrar; the take-over path closes a ledger-empty
    // occupant. The boolean preserve-occupant CAS lives in
    // setActiveSessionIfActive — covered separately below.)
    const prevDs = makeSimpleDs('prev-sess');
    const newDs = makeSimpleDs('new-sess');
    vi.mocked(sessionStore.getSession).mockImplementation((sid: string) =>
      sid === 'prev-sess' ? ({ ...prevDs.session, status: 'active' }) as any : undefined,
    );

    const key = sessionKey('oc_c', 'cli_app_test');
    registry.set(key, prevDs);

    const result = await setActiveSessionSafe(registry, key, newDs);

    expect(result).toEqual({ accepted: true, closedSessionId: 'prev-sess' });
    expect(registry.get(key)).toBe(newDs);
    expect(sessionStore.closeSession).toHaveBeenCalledWith('prev-sess');
  });

  it('preserves the current occupant when a different session tries to register (setActiveSessionIfActive CAS)', () => {
    // Master's compare-and-set gate: setActiveSessionIfActive refuses to
    // overwrite a live routing occupant and returns false (no close). The
    // merge relocated this preserve-occupant semantics from setActiveSessionSafe
    // to setActiveSessionIfActive, so assert it against the function that owns
    // the behavior now.
    const prevDs = makeSimpleDs('prev-sess');
    const newDs = makeSimpleDs('new-sess');

    const key = sessionKey('oc_c', 'cli_app_test');
    registry.set(key, prevDs);

    expect(setActiveSessionIfActive(registry, key, newDs)).toBe(false);

    expect(registry.get(key)).toBe(prevDs);
    expect(sessionStore.closeSession).not.toHaveBeenCalled();
  });

  it('is a no-op when the key already holds the same session instance', async () => {
    const ds = makeSimpleDs('only-sess');
    const key = sessionKey('oc_c', 'cli_app_test');
    registry.set(key, ds);

    await setActiveSessionSafe(registry, key, ds);

    expect(registry.get(key)).toBe(ds);
    expect(sessionStore.closeSession).not.toHaveBeenCalled();
  });

  it('sets the entry on an empty key without calling closeSession', async () => {
    const ds = makeSimpleDs('fresh-sess');
    const key = sessionKey('oc_c', 'cli_app_test');

    await setActiveSessionSafe(registry, key, ds);

    expect(registry.get(key)).toBe(ds);
    expect(sessionStore.closeSession).not.toHaveBeenCalled();
  });

  it('keeps an unsettled incumbent and closes a ledger-empty incoming collision', async () => {
    const incumbent = makeSimpleDs('pending-incumbent');
    incumbent.session.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-incumbent',
      turnId: 'turn-incumbent',
      state: 'prepared',
      content: 'owned',
      deliverySink: 'lark',
    }];
    const incoming = makeSimpleDs('ledger-empty-incoming');
    vi.mocked(sessionStore.getSession).mockImplementation((sid: string) =>
      sid === incoming.session.sessionId ? incoming.session : undefined,
    );
    const key = sessionKey('oc_c', 'cli_app_test');
    registry.set(key, incumbent);

    const result = await setActiveSessionSafe(registry, key, incoming);

    expect(result).toEqual({
      accepted: false,
      reason: 'kept_pending_owner',
      keptSessionId: incumbent.session.sessionId,
      closedIncomingSessionId: incoming.session.sessionId,
    });
    expect(registry.get(key)).toBe(incumbent);
    expect(sessionStore.closeSession).toHaveBeenCalledWith(incoming.session.sessionId);
  });

  it('fails closed and preserves both rows when both colliding owners are unsettled', async () => {
    const incumbent = makeSimpleDs('pending-incumbent');
    incumbent.session.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-incumbent',
      turnId: 'turn-incumbent',
      state: 'prepared',
      content: 'owned incumbent',
      deliverySink: 'lark',
    }];
    const incoming = makeSimpleDs('pending-incoming');
    incoming.session.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-incoming',
      turnId: 'turn-incoming',
      state: 'prepared',
      content: 'owned incoming',
      deliverySink: 'lark',
    }];
    const key = sessionKey('oc_c', 'cli_app_test');
    registry.set(key, incumbent);

    const result = await setActiveSessionSafe(registry, key, incoming);

    expect(result).toEqual({
      accepted: false,
      reason: 'both_pending',
      keptSessionId: incumbent.session.sessionId,
      preservedIncomingSessionId: incoming.session.sessionId,
    });
    expect(registry.get(key)).toBe(incumbent);
    expect(sessionStore.closeSession).not.toHaveBeenCalled();
  });

  it('reserves an empty runtime key for a quarantined active persisted row', () => {
    const quarantined = makeSimpleDs('quarantined-sess');
    quarantined.session.restoreQuarantinedAt = '2026-07-31T00:00:00.000Z';
    const fresh = makeSimpleDs('fresh-sess');
    const key = sessionKey('oc_c', 'cli_app_test');
    vi.mocked(sessionStore.listSessions).mockReturnValueOnce([quarantined.session]);

    expect(setActiveSessionIfActive(registry, key, fresh)).toBe(false);
    expect(registry.has(key)).toBe(false);
  });

  it('lets the quarantined row itself reclaim the route and clears its marker', () => {
    const quarantined = makeSimpleDs('quarantined-sess');
    quarantined.session.restoreQuarantinedAt = '2026-07-31T00:00:00.000Z';
    const key = sessionKey('oc_c', 'cli_app_test');
    vi.mocked(sessionStore.listSessions).mockReturnValueOnce([quarantined.session]);

    expect(setActiveSessionIfActive(registry, key, quarantined)).toBe(true);
    expect(registry.get(key)).toBe(quarantined);
    expect(quarantined.session.restoreQuarantinedAt).toBeUndefined();
    expect(sessionStore.updateSession).toHaveBeenCalledWith(quarantined.session);
  });

  it('refuses to register a session closed while its creator was awaiting', () => {
    const ds = makeSimpleDs('closed-before-register');
    ds.session.status = 'closed';
    const key = sessionKey('oc_c', 'cli_app_test');

    expect(setActiveSessionIfActive(registry, key, ds)).toBe(false);
    expect(registry.has(key)).toBe(false);
  });

  it('rolls back a rejected row before returning the latest active routing winner', async () => {
    const rejected = makeSimpleDs('rejected-sess');
    const staleWinner = makeSimpleDs('stale-winner');
    const latestWinner = makeSimpleDs('latest-winner');
    const key = sessionKey('oc_c', 'cli_app_test');
    registry.set(key, staleWinner);
    const rollback = vi.fn(async (sessionId: string) => {
      expect(sessionId).toBe(rejected.session.sessionId);
      // Simulate another creator replacing the key while close cleanup yields.
      registry.set(key, latestWinner);
    });

    await expect(
      rollbackRejectedSessionAndGetWinner(registry, key, rejected, rollback),
    ).resolves.toBe(latestWinner);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('does not reroute an inbound event to a winner that closed during rollback', async () => {
    const rejected = makeSimpleDs('rejected-sess');
    const closedWinner = makeSimpleDs('closed-winner');
    const key = sessionKey('oc_c', 'cli_app_test');
    registry.set(key, closedWinner);

    const winner = await rollbackRejectedSessionAndGetWinner(
      registry,
      key,
      rejected,
      async () => { closedWinner.session.status = 'closed'; },
    );

    expect(winner).toBeUndefined();
  });

});

describe('closeSession concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDocSubscriptionsMock.mockReturnValue([]);
    unsubscribeDocFileMock.mockResolvedValue(undefined);
    removeCommentReactionMock.mockResolvedValue(undefined);
  });

  it('commits closed state before a slow document unsubscribe can yield', async () => {
    const registry = new Map<string, DaemonSession>();
    const ds = makeDs({
      worker: {
        killed: false,
        exitCode: null,
        signalCode: null,
        send: vi.fn(),
        once: vi.fn((_event: string, listener: () => void) => {
          queueMicrotask(listener);
        }),
        off: vi.fn(),
        kill: vi.fn(),
      } as any,
    });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    setActiveSessionsRegistry(registry);

    let stored = { ...ds.session } as Session;
    vi.mocked(sessionStore.getOwnedSession).mockImplementation((sid: string) =>
      sid === ds.session.sessionId ? stored : undefined,
    );
    vi.mocked(sessionStore.closeSession).mockImplementation(() => {
      stored = { ...stored, status: 'closed', closedAt: new Date().toISOString() };
    });
    listDocSubscriptionsMock.mockReturnValue([{ fileToken: 'doc-token', fileType: 'docx' }]);

    let releaseUnsubscribe!: () => void;
    unsubscribeDocFileMock.mockImplementation(() => new Promise<void>((resolve) => {
      releaseUnsubscribe = resolve;
    }));

    const closing = closeSession(ds.session.sessionId);

    // closeSession has reached its first await, but all authoritative state is
    // already closed. A continuation that captured `ds` cannot resurrect it.
    expect(ds.session.status).toBe('closed');
    expect(registry.has(sessionKey('om_source_root', 'cli_app_test'))).toBe(false);
    expect(sessionStore.closeSession).toHaveBeenCalledWith(ds.session.sessionId, {
      cleanupBridgeMarkers: false,
    });
    const key = sessionKey('om_source_root', 'cli_app_test');
    registry.set(key, ds); // stale async continuation re-published the same object
    expect(() => forkWorker(ds, 'late message')).not.toThrow();
    expect(registry.has(key)).toBe(false);

    ds.adoptedFrom = {
      source: 'tmux',
      tmuxTarget: '0:0.0',
      originalCliPid: 42,
      cwd: '/tmp/project',
    };
    registry.set(key, ds);
    expect(() => forkAdoptWorker(ds)).not.toThrow();
    expect(registry.has(key)).toBe(false);

    await vi.waitFor(() => expect(unsubscribeDocFileMock).toHaveBeenCalledTimes(1));
    releaseUnsubscribe();
    await closing;
    expect(removeDocSubscriptionMock).toHaveBeenCalledWith(
      expect.any(String),
      'cli_app_test',
      'doc-token',
    );
  });

  it('tears down only explicitly stamped bot-owned persistent backings', () => {
    const kill = vi.fn();
    const base = makeDs().session;
    const zmx = { ...base, backendType: 'zmx' as const };
    expect(destroyUnregisteredPersistentBacking(zmx, kill)).toBe(true);
    expect(kill).toHaveBeenCalledWith(
      { backendType: 'zmx', sessionName: 'bmx-sess-abc' },
      'sess-abc-123',
    );

    kill.mockClear();
    expect(destroyUnregisteredPersistentBacking({ ...zmx, adoptedFrom: {
      source: 'tmux', tmuxTarget: '0:0.0', originalCliPid: 42, cwd: '/tmp',
    } }, kill)).toBe(false);
    expect(destroyUnregisteredPersistentBacking({ ...zmx, queued: true }, kill)).toBe(false);
    expect(destroyUnregisteredPersistentBacking({ ...zmx, backendType: 'pty' }, kill)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('tears down an unregistered backing through its exact persisted target', () => {
    const killTarget = vi.fn();
    const base = makeDs().session;
    const herdr = {
      ...base,
      backendType: 'herdr' as const,
      persistentBackendTarget: {
        backendType: 'herdr' as const,
        sessionName: 'botmux',
        agentName: 'botmux-sess-abc',
      },
    };

    expect(destroyUnregisteredPersistentBacking(herdr, killTarget)).toBe(true);
    expect(killTarget).toHaveBeenCalledWith(
      herdr.persistentBackendTarget,
      herdr.sessionId,
    );
  });

  it('removes every binding while only remotely unsubscribing legacy/API-managed records', async () => {
    const registry = new Map<string, DaemonSession>();
    const ds = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    setActiveSessionsRegistry(registry);
    vi.mocked(sessionStore.getOwnedSession).mockReturnValue(ds.session);
    listDocSubscriptionsMock.mockReturnValue([
      { fileToken: 'legacy-doc', fileType: 'docx' },
      { fileToken: 'api-doc', fileType: 'docx', managedBy: 'subscribe-lark-doc' },
      { fileToken: 'watch-doc', fileType: 'docx', managedBy: 'watch-comment' },
    ] as any);
    // A remote API failure must not retain the local binding or stop cleanup
    // of the other records.
    unsubscribeDocFileMock.mockRejectedValueOnce(new Error('remote unavailable'));

    await closeSession(ds.session.sessionId);

    expect(unsubscribeDocFileMock.mock.calls.map(call => call[1].fileToken)).toEqual([
      'legacy-doc',
      'api-doc',
    ]);
    expect(removeDocSubscriptionMock.mock.calls.map(call => call[2])).toEqual([
      'legacy-doc',
      'api-doc',
      'watch-doc',
    ]);
  });

  it('clears every per-turn doc target before awaiting reaction cleanup', async () => {
    const registry = new Map<string, DaemonSession>();
    const ds = makeDs();
    const target = {
      fileToken: 'doc-token',
      fileType: 'docx',
      commentId: 'comment-1',
      turnId: 'turn-1',
      replyId: 'reply-1',
      reactionId: 'reaction-1',
    };
    ds.docCommentTurns = new Map([['turn-1', target]]);
    ds.session.docCommentTargets = { 'turn-1': target };
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    setActiveSessionsRegistry(registry);
    vi.mocked(sessionStore.getOwnedSession).mockReturnValue(ds.session);

    let releaseReaction!: () => void;
    removeCommentReactionMock.mockImplementation(() => new Promise<void>((resolve) => {
      releaseReaction = resolve;
    }));

    const closing = closeSession(ds.session.sessionId);

    expect(ds.session.status).toBe('closed');
    expect(registry.size).toBe(0);
    expect(ds.docCommentTurns).toBeUndefined();
    expect(ds.session.docCommentTargets).toBeUndefined();
    expect(sessionStore.closeSession).toHaveBeenCalledWith(ds.session.sessionId, {
      cleanupBridgeMarkers: true,
    });
    expect(dashboardEventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.update',
    }));

    releaseReaction();
    await closing;
    expect(removeCommentReactionMock).toHaveBeenCalledWith(
      'cli_app_test',
      { fileToken: 'doc-token', fileType: 'docx' },
      'comment-1',
      'reply-1',
      'reaction-1',
    );
  });

  it('persists stale per-turn cleanup when re-closing an already-closed owned row', async () => {
    setActiveSessionsRegistry(new Map());
    const stored = makeDs().session;
    stored.status = 'closed';
    stored.docCommentTargets = {
      'turn-stale': {
        fileToken: 'doc-token',
        fileType: 'docx',
        commentId: 'comment-1',
        turnId: 'turn-stale',
        replyId: 'reply-1',
        reactionId: 'reaction-1',
      },
    };
    vi.mocked(sessionStore.getOwnedSession).mockReturnValue(stored);

    await closeSession(stored.sessionId);

    expect(stored.docCommentTargets).toBeUndefined();
    expect(sessionStore.updateSession).toHaveBeenCalledWith(stored);
    expect(sessionStore.closeSession).not.toHaveBeenCalled();
    expect(removeCommentReactionMock).toHaveBeenCalledTimes(1);
  });

  it('does not treat another bot file found by read-only lookup as owned close state', async () => {
    setActiveSessionsRegistry(new Map());
    vi.mocked(sessionStore.getOwnedSession).mockReturnValue(undefined);
    vi.mocked(sessionStore.getSession).mockReturnValue({
      ...makeDs().session,
      sessionId: 'foreign-session',
      larkAppId: 'other_app',
    });

    await expect(closeSession('foreign-session')).resolves.toEqual({
      ok: true,
      outcome: 'closed',
      alreadyClosed: true,
      known: false,
    });

    expect(sessionStore.getSession).not.toHaveBeenCalled();
    expect(sessionStore.closeSession).not.toHaveBeenCalled();
    expect(dashboardEventBus.publish).not.toHaveBeenCalled();
  });
});
