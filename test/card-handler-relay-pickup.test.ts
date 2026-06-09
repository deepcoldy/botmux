/**
 * Tests for the `relay_confirm` card action: target-chat picker confirm
 * button (stage 2 of the two-stage picker).
 *
 * Picker flow:
 *   stage 1 — initial picker, each session = interactive_container that
 *             fires `relay_select` on click.
 *   stage 2 — clicking a card re-renders the picker with that card
 *             highlighted + a confirm button; the button fires
 *             `relay_confirm` with the chosen sessionId.
 *
 * These tests cover the `relay_confirm` handler (the actual transfer
 * trigger). The `relay_select` re-render handler is tested separately
 * since it only updates card content, no side effects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks must come BEFORE the import of card-handler ----------------------

vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {} }));

const sendMessageMock = vi.fn(async () => 'om_M1');
const deleteMessageMock = vi.fn(async () => true);
const getChatNameMock = vi.fn(async (): Promise<string | null> => 'Friendly Source Chat Name');
const replyMessageMock = vi.fn(async () => 'om_M1_thread');
vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return {
    ...actual,
    sendMessage: (...a: any[]) => sendMessageMock(...a),
    deleteMessage: (...a: any[]) => deleteMessageMock(...a),
    getChatName: (...a: any[]) => getChatNameMock(...a),
    replyMessage: (...a: any[]) => replyMessageMock(...a),
    sendUserMessage: vi.fn(),
    updateMessage: vi.fn(),
  };
});

const transferSessionMock = vi.fn(async () => ({ ok: true as const }));
vi.mock('../src/core/worker-pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/worker-pool.js')>();
  return {
    ...actual,
    transferSession: (...a: any[]) => transferSessionMock(...a),
  };
});

// --- Now imports ------------------------------------------------------------

import { handleCardAction } from '../src/im/lark/card-handler.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';

const LARK_APP_ID = 'cli_app_1';
const OWNER = 'ou_owner_user';

function makeDs(overrides: Partial<Session> & { chatId?: string } = {}): DaemonSession {
  const session: Session = {
    sessionId: 'sess-source-1',
    chatId: overrides.chatId ?? 'oc_source',
    rootMessageId: 'om_source_root',
    title: 't',
    status: 'active',
    createdAt: new Date().toISOString(),
    scope: 'thread',
    chatType: 'group',
    larkAppId: LARK_APP_ID,
    ownerOpenId: OWNER,
    workingDir: '/tmp/proj',
    cliId: 'claude-code',
    ...overrides,
  };
  return {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: LARK_APP_ID,
    chatId: session.chatId,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    workingDir: session.workingDir,
  } as DaemonSession;
}

// Confirm button click shape — value carries full context after selection.
function actionData(opts: { sessionId?: string; target_chat_id?: string; root_id?: string; operator?: string; target_scope?: 'thread' | 'chat' } = {}) {
  return {
    operator: { open_id: opts.operator ?? OWNER },
    action: {
      value: {
        action: 'relay_confirm',
        session_id: opts.sessionId ?? 'sess-source-1',
        target_chat_id: opts.target_chat_id ?? 'oc_target',
        root_id: opts.root_id ?? 'om_target_root',
        ...(opts.target_scope ? { target_scope: opts.target_scope } : {}),
      },
    },
  };
}

function deps(activeSessions: Map<string, DaemonSession>) {
  return {
    activeSessions,
    sessionReply: vi.fn(async () => 'mid'),
    lastRepoScan: new Map(),
  } as any;
}

beforeEach(() => {
  sendMessageMock.mockClear();
  deleteMessageMock.mockClear();
  getChatNameMock.mockClear();
  getChatNameMock.mockResolvedValue('Friendly Source Chat Name');
  replyMessageMock.mockClear();
  replyMessageMock.mockResolvedValue('om_M1_thread');
  transferSessionMock.mockClear();
  transferSessionMock.mockResolvedValue({ ok: true });
});

describe('relay_confirm button click', () => {
  it('rejects when required value fields are missing', async () => {
    const r = await handleCardAction({
      operator: { open_id: OWNER },
      action: { value: { action: 'relay_confirm' /* nothing else */ } },
    } as any, deps(new Map()), LARK_APP_ID);
    expect(r?.toast?.type).toBe('error');
    expect(transferSessionMock).not.toHaveBeenCalled();
  });

  it('returns not_found when the picked sessionId is not in active registry', async () => {
    const r = await handleCardAction(actionData({ sessionId: 'missing-sess' }), deps(new Map()), LARK_APP_ID);
    expect(r?.toast?.type).toBe('error');
    expect(transferSessionMock).not.toHaveBeenCalled();
  });

  it('refuses confirm when invoker_open_id is present and the clicker is not the invoker', async () => {
    // Owner-only invocations: the picker carries invoker_open_id so a passer-by
    // can't hijack someone else's summoned card. The pre-flight rejects the
    // mismatched operator before touching transferSession.
    const ds = makeDs();
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    const r = await handleCardAction({
      operator: { open_id: 'ou_passerby' },
      action: {
        value: {
          action: 'relay_confirm',
          session_id: 'sess-source-1',
          target_chat_id: 'oc_target',
          root_id: 'om_target_root',
          invoker_open_id: OWNER, // original invoker — different from operator above
        },
      },
    } as any, deps(map), LARK_APP_ID);

    expect(r?.toast?.type).toBe('error');
    expect(transferSessionMock).not.toHaveBeenCalled();
  });

  it('returns not_owner when operator differs from session.ownerOpenId', async () => {
    const ds = makeDs();
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    const r = await handleCardAction(actionData(
      { sessionId: 'sess-source-1', operator: 'ou_someone_else' },
    ), deps(map), LARK_APP_ID);

    expect(r?.toast?.type).toBe('error');
    expect(transferSessionMock).not.toHaveBeenCalled();
  });

  it('refuses to relay a session onto its own anchor (same_anchor)', async () => {
    // Thread-scope source anchored at om_source_root; targeting that same 话题
    // root → same anchor → refuse (relaying onto itself). A different chat /
    // different 话题 would be allowed (anchor-based, enables 同群话题间搬运).
    const ds = makeDs();  // scope 'thread', anchor om_source_root
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    const r = await handleCardAction(
      actionData({ sessionId: 'sess-source-1', target_chat_id: 'oc_source', root_id: 'om_source_root', target_scope: 'thread' }),
      deps(map),
      LARK_APP_ID,
    );

    expect(r?.toast?.type).toBe('error');
    expect(transferSessionMock).not.toHaveBeenCalled();
  });

  it('happy path: sends M1 with friendly chat name, calls transferSession with the M1 id, returns success toast', async () => {
    const ds = makeDs();
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    const r = await handleCardAction({
      operator: { open_id: OWNER },
      action: {
        value: { action: 'relay_confirm', session_id: 'sess-source-1', target_chat_id: 'oc_target', root_id: 'om_target_root' },
      },
      context: { open_message_id: 'om_picker_card' },
    } as any, deps(map), LARK_APP_ID);

    expect(getChatNameMock).toHaveBeenCalledWith(LARK_APP_ID, 'oc_source');
    // M1 sent to the target chat, payload references the friendly name (not oc_xxx).
    expect(sendMessageMock).toHaveBeenCalled();
    expect(sendMessageMock.mock.calls[0][1]).toBe('oc_target');
    const m1Payload = sendMessageMock.mock.calls[0][2];
    expect(m1Payload).toContain('Friendly Source Chat Name');
    expect(m1Payload).not.toContain('oc_source');

    expect(transferSessionMock).toHaveBeenCalledWith('sess-source-1', 'oc_target', 'om_M1', 'group', 'chat');
    expect(deleteMessageMock).toHaveBeenCalledWith(LARK_APP_ID, 'om_picker_card');
    expect(r?.toast?.type).toBe('success');
  });

  it('thread-scope target: M1 sent reply_in_thread to the 话题 root, transferSession gets (group, thread) anchored at root_id', async () => {
    const ds = makeDs();  // source in oc_source, thread anchor om_source_root
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    const r = await handleCardAction(
      actionData({ sessionId: 'sess-source-1', target_chat_id: 'oc_target', root_id: 'om_topic_root', target_scope: 'thread' }),
      deps(map),
      LARK_APP_ID,
    );

    // M1 goes via replyMessage(reply_in_thread=true) into the 话题 root, NOT
    // sendMessage; sendMessage must not be used for the announcement.
    expect(replyMessageMock).toHaveBeenCalledWith(LARK_APP_ID, 'om_topic_root', expect.any(String), 'text', true);
    expect(sendMessageMock).not.toHaveBeenCalled();
    // Session anchors on the 话题 root (NOT the M1 id), scope 'thread'.
    expect(transferSessionMock).toHaveBeenCalledWith('sess-source-1', 'oc_target', 'om_topic_root', 'group', 'thread');
    expect(r?.toast?.type).toBe('success');
  });

  it('falls back to chatId in the M1 body when getChatName returns null', async () => {
    getChatNameMock.mockResolvedValueOnce(null);
    const ds = makeDs();
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    await handleCardAction(actionData({ sessionId: 'sess-source-1' }), deps(map), LARK_APP_ID);

    const m1Payload = sendMessageMock.mock.calls[0][2];
    expect(m1Payload).toContain('oc_source');
  });

  it('returns a friendly toast when transferSession reports adopt_not_relayable', async () => {
    const ds = makeDs();
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    transferSessionMock.mockResolvedValueOnce({ ok: false, error: 'adopt_not_relayable' });

    const r = await handleCardAction(actionData({ sessionId: 'sess-source-1' }), deps(map), LARK_APP_ID);

    expect(r?.toast?.type).toBe('error');
    expect(r?.toast?.content).toContain('/adopt');
    expect(r?.toast?.content).not.toMatch(/adopt_not_relayable/);
  });

  // Helper to construct a DaemonSession with explicit chatId / scope / worker —
  // makeDs only spreads overrides into `session`, not into the DS shell.
  function makeDsInChat(opts: { sessionId: string; chatId: string; scope: 'chat' | 'thread'; worker: any; title?: string }): DaemonSession {
    return {
      session: {
        sessionId: opts.sessionId,
        chatId: opts.chatId,
        rootMessageId: `om_root_${opts.sessionId}`,
        title: opts.title ?? 't',
        status: 'active',
        createdAt: new Date().toISOString(),
        scope: opts.scope,
        chatType: 'group',
        larkAppId: LARK_APP_ID,
        ownerOpenId: OWNER,
      } as any,
      worker: opts.worker,
      workerPort: null,
      workerToken: null,
      larkAppId: LARK_APP_ID,
      chatId: opts.chatId,
      chatType: 'group',
      scope: opts.scope,
      spawnedAt: Date.now(),
      cliVersion: '1.0.0',
      lastMessageAt: Date.now(),
      hasHistory: true,
    } as DaemonSession;
  }

  it('pre-flight: refuses with a target-chat message when an active session is already there (NO M1 sent, NO transferSession called)', async () => {
    const sourceDs = makeDs();
    const existingDs = makeDsInChat({
      sessionId: 'sess-existing',
      chatId: 'oc_target',
      scope: 'chat',
      worker: { killed: false } as any, // real running session
      title: 'an existing chat',
    });
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), sourceDs);
    map.set(sessionKey('oc_target', LARK_APP_ID), existingDs);

    const r = await handleCardAction(actionData({ sessionId: 'sess-source-1' }), deps(map), LARK_APP_ID);

    // No toast — user gets a chat message in the target chat instead.
    expect(r).toBeUndefined();
    // Single sendMessage call = the error message to the target chat, not M1.
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [, sentChatId, sentBody] = sendMessageMock.mock.calls[0];
    expect(sentChatId).toBe('oc_target');
    expect(sentBody).toContain('已有');
    expect(sentBody).toContain('an existing chat');
    // transferSession was never invoked — fail-fast at the pre-flight.
    expect(transferSessionMock).not.toHaveBeenCalled();
  });

  it('pre-flight ignores daemon-command scratch sessions (no worker) in the target chat', async () => {
    // Regression for王皓's "我选择 ggbone relay 它也显示我在这个群里有
    // 活跃群聊" bug — the /relay command's own placeholder session should
    // NOT count as a conflict, only real running sessions do.
    const sourceDs = makeDs();
    const scratchDs = makeDsInChat({
      sessionId: 'sess-scratch-relay',
      chatId: 'oc_target',
      scope: 'chat',
      worker: null, // scratch placeholder, no real worker
      title: '/relay',
    });
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), sourceDs);
    map.set(sessionKey('oc_target', LARK_APP_ID), scratchDs);

    const r = await handleCardAction(actionData({ sessionId: 'sess-source-1' }), deps(map), LARK_APP_ID);
    // Transfer proceeded: M1 sent + transferSession invoked + success toast.
    expect(transferSessionMock).toHaveBeenCalledTimes(1);
    expect(r?.toast?.type).toBe('success');
  });

  it('cleans up the orphan M1 when transferSession fails after the M1 was sent (race fallback)', async () => {
    const ds = makeDs();
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    transferSessionMock.mockResolvedValueOnce({ ok: false, error: 'target_chat_has_session' });

    const r = await handleCardAction(actionData({ sessionId: 'sess-source-1' }), deps(map), LARK_APP_ID);

    // No toast — chat message instead.
    expect(r).toBeUndefined();
    // M1 was sent (M1 message id is om_M1), then deleted as orphan cleanup.
    expect(sendMessageMock).toHaveBeenCalled();
    expect(deleteMessageMock).toHaveBeenCalledWith(LARK_APP_ID, 'om_M1');
  });

  it('returns a friendly toast when transferSession reports worker_busy', async () => {
    const ds = makeDs();
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    transferSessionMock.mockResolvedValueOnce({ ok: false, error: 'worker_busy' as any });

    const r = await handleCardAction(actionData({ sessionId: 'sess-source-1' }), deps(map), LARK_APP_ID);

    expect(r?.toast?.type).toBe('error');
    // Specific toast string, not the raw error code via toast_failed.
    expect(r?.toast?.content).not.toMatch(/worker_busy/);
    expect(r?.toast?.content).toMatch(/正在处理|mid-turn|wait/i);
  });

  it('returns a friendly toast when transferSession reports not_started_yet', async () => {
    const ds = makeDs();
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    transferSessionMock.mockResolvedValueOnce({ ok: false, error: 'not_started_yet' as any });

    const r = await handleCardAction(actionData({ sessionId: 'sess-source-1' }), deps(map), LARK_APP_ID);

    expect(r?.toast?.type).toBe('error');
    expect(r?.toast?.content).not.toMatch(/not_started_yet/);
    expect(r?.toast?.content).toMatch(/选仓库|pick a repo/i);
  });
});
