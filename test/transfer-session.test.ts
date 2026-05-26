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
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(),
  getAllBots: vi.fn(() => []),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

// transferSession accepts forkWorker/killWorker overrides for testability —
// real forkWorker would actually spawn a child process and attach tmux.
const forkWorkerSpy = vi.fn();
const killWorkerSpy = vi.fn();

import { transferSession, setActiveSessionsRegistry } from '../src/core/worker-pool.js';
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
  // try to spawn a child process / attach tmux during unit testing. waitForIdleMs
  // can still be overridden per-test.
  const callTransfer = (
    sessionId: string,
    targetChatId: string,
    targetRootMessageId: string,
    extra: { waitForIdleMs?: number } = {},
  ) => transferSession(sessionId, targetChatId, targetRootMessageId, {
    forkWorkerImpl: forkWorkerSpy as any,
    killWorkerImpl: killWorkerSpy as any,
    ...extra,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new Map();
    setActiveSessionsRegistry(registry);
  });

  it('returns session_not_active when sessionId not in registry', async () => {
    const r = await callTransfer('does-not-exist', 'oc_target', 'om_target_root');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('session_not_active');
  });

  it('returns same_chat when target chatId equals current chatId', async () => {
    const ds = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);
    const r = await callTransfer(ds.session.sessionId, 'oc_source', 'om_target_root');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('same_chat');
    expect(forkWorkerSpy).not.toHaveBeenCalled();
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

  it('returns worker_busy_timeout when worker stays busy past the idle deadline', async () => {
    // Create a session whose worker exists and never reaches idle. We use a
    // small timeout so the test finishes quickly. ds.worker must be truthy
    // and not killed for the busy check to apply.
    const fakeWorker = { killed: false } as any;
    const ds = makeDs({ worker: fakeWorker, lastScreenStatus: 'working' });
    registry.set(sessionKey('om_source_root', 'cli_app_test'), ds);

    const r = await callTransfer(ds.session.sessionId, 'oc_target', 'om_M1_target', { waitForIdleMs: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('worker_busy_timeout');
    expect(forkWorkerSpy).not.toHaveBeenCalled();
    // Routing fields must be untouched after a busy timeout abort.
    expect(ds.chatId).toBe('oc_source');
    expect(ds.session.scope).toBe('thread');
  });

  it('refuses with target_chat_has_session when target chat already has a chat-scope session for this bot', async () => {
    const movingDs = makeDs();
    registry.set(sessionKey('om_source_root', 'cli_app_test'), movingDs);

    // Pre-existing chat-scope session in the target chat for the same bot.
    // After the rewrite, the moving session's key would collide with this one.
    const existingDs = makeDs({
      session: {
        ...movingDs.session,
        sessionId: 'existing-sess-in-target',
        chatId: 'oc_target',
        rootMessageId: 'om_target_seed',
        scope: 'chat',
      },
      chatId: 'oc_target',
      scope: 'chat',
    });
    registry.set(sessionKey('oc_target', 'cli_app_test'), existingDs);

    const r = await callTransfer(movingDs.session.sessionId, 'oc_target', 'om_M1_target');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('target_chat_has_session');
    expect(forkWorkerSpy).not.toHaveBeenCalled();
    // Moving session must remain untouched — no field rewrites on refusal.
    expect(movingDs.chatId).toBe('oc_source');
    expect(movingDs.session.scope).toBe('thread');
    // Existing target session must still be in the registry.
    expect(registry.get(sessionKey('oc_target', 'cli_app_test'))).toBe(existingDs);
  });

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
