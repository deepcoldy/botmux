/**
 * transfer-session.test.ts
 *
 * Tests for `transferSession()` in worker-pool — verifies routing fields
 * (chatId / rootMessageId / scope) are rewritten in place, activeSessions
 * key rotates from source anchor to target chatId, and forkWorker is
 * invoked with resume=true so the surviving tmux session is re-attached
 * rather than recreated.
 *
 * The CLI process and tmux session are external resources; we stub
 * forkWorker / killWorker so the test exercises the *routing* logic in
 * isolation. ds.worker is set to null to avoid actually killing anything.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/services/session-store.js', () => ({
  updateSession: vi.fn(),
  getSession: vi.fn(),
  getOwnedSession: vi.fn(),
  closeSession: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { cliId: 'claude-code', larkAppId: 'cli_app_test' },
    botName: 'TestBot',
  })),
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
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: (...a: any[]) => updateMessageMock(...a),
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

// transferSession accepts forkWorker/killWorker overrides for testability —
// real forkWorker would actually spawn a child process and attach tmux.
const forkWorkerSpy = vi.fn();
const killWorkerSpy = vi.fn();

import {
  closeSession,
  destroyUnregisteredPersistentBacking,
  forkAdoptWorker,
  forkWorker,
  transferSession,
  setActiveSessionsRegistry,
  setActiveSessionIfActive,
  setActiveSessionSafe,
  rollbackRejectedSessionAndGetWinner,
} from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';

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
    killWorkerImpl: killWorkerSpy as any,
  });

  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(sessionStore.closeSession).toHaveBeenCalledWith('scratch-relay-cmd');
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

  it('aborts without rewriting routing when the source closes during card freeze', async () => {
    const ds = makeDs();
    const sourceKey = sessionKey('om_source_root', 'cli_app_test');
    registry.set(sourceKey, ds);

    let releaseFreeze!: () => void;
    updateMessageMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFreeze = resolve;
    }));

    const moving = callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');
    expect(updateMessageMock).toHaveBeenCalledTimes(1);

    // Simulate dashboard/CLI close while updateMessage is in flight.
    ds.session.status = 'closed';
    registry.delete(sourceKey);
    releaseFreeze();

    const r = await moving;
    expect(r).toEqual({ ok: false, error: 'session_not_active' });
    expect(killWorkerSpy).not.toHaveBeenCalled();
    expect(forkWorkerSpy).not.toHaveBeenCalled();
    expect(ds.chatId).toBe('oc_source');
    expect(registry.has(sessionKey('oc_target', 'cli_app_test'))).toBe(false);
  });

  it('does not evict a target session created while the source card is freezing', async () => {
    const ds = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    let releaseFreeze!: () => void;
    updateMessageMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFreeze = resolve;
    }));
    const moving = callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target');

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
    releaseFreeze();

    const r = await moving;
    expect(r).toEqual({ ok: false, error: 'target_chat_has_session' });
    expect(killWorkerSpy).not.toHaveBeenCalled();
    expect(registry.get(sessionKey('oc_target', 'cli_app_test'))).toBe(target);
    expect(registry.get(sessionKey('om_source_root', 'cli_app_test'))).toBe(ds);
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
    expect(killWorkerSpy).toHaveBeenCalledWith(ds);
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

  it('preserves the current occupant when a different session tries to register', async () => {
    const prevDs = makeSimpleDs('prev-sess');
    const newDs = makeSimpleDs('new-sess');

    const key = sessionKey('oc_c', 'cli_app_test');
    registry.set(key, prevDs);

    expect(await setActiveSessionSafe(registry, key, newDs)).toBe(false);

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
        once: vi.fn(),
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
    expect(sessionStore.closeSession).toHaveBeenCalledWith(ds.session.sessionId);
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
    expect(kill).toHaveBeenCalledWith('zmx', 'bmx-sess-abc');

    kill.mockClear();
    expect(destroyUnregisteredPersistentBacking({ ...zmx, adoptedFrom: {
      source: 'tmux', tmuxTarget: '0:0.0', originalCliPid: 42, cwd: '/tmp',
    } }, kill)).toBe(false);
    expect(destroyUnregisteredPersistentBacking({ ...zmx, queued: true }, kill)).toBe(false);
    expect(destroyUnregisteredPersistentBacking({ ...zmx, backendType: 'pty' }, kill)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
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
    expect(sessionStore.closeSession).toHaveBeenCalledWith(ds.session.sessionId);
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
      alreadyClosed: true,
      known: false,
    });

    expect(sessionStore.getSession).not.toHaveBeenCalled();
    expect(sessionStore.closeSession).not.toHaveBeenCalled();
    expect(dashboardEventBus.publish).not.toHaveBeenCalled();
  });
});
