/**
 * Tests for the `relay_pickup` card action: target-chat picker button.
 *
 * The picker card is posted in the *target* chat and lists the operator's
 * own sessions in other chats. Clicking a button triggers transferSession
 * to move that session into the current (target) chat.
 *
 * We test:
 *   - operator must match the source session's ownerOpenId
 *   - source session must be active and known to this bot
 *   - same-chat short-circuit
 *   - happy path → sends M1, calls transferSession with the new M1 id,
 *     returns success toast
 *   - transferSession failure → error toast carries the error
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks must come BEFORE the import of card-handler ----------------------

vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {} }));

const sendMessageMock = vi.fn(async () => 'om_M1');
const deleteMessageMock = vi.fn(async () => true);
vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return {
    ...actual,
    sendMessage: (...a: any[]) => sendMessageMock(...a),
    deleteMessage: (...a: any[]) => deleteMessageMock(...a),
    replyMessage: vi.fn(),
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

function actionData(value: Record<string, string>, operator = OWNER) {
  return {
    operator: { open_id: operator },
    action: { value },
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
  transferSessionMock.mockClear();
  transferSessionMock.mockResolvedValue({ ok: true });
});

describe('relay_pickup action', () => {
  it('rejects when required values are missing', async () => {
    const r = await handleCardAction(actionData({ action: 'relay_pickup', session_id: 's' }), deps(new Map()), LARK_APP_ID);
    expect(r?.toast?.type).toBe('error');
    expect(transferSessionMock).not.toHaveBeenCalled();
  });

  it('returns not_found when the source session is not in active registry', async () => {
    const r = await handleCardAction(actionData({
      action: 'relay_pickup',
      session_id: 'missing-sess',
      target_chat_id: 'oc_target',
      root_id: 'om_target_root',
    }), deps(new Map()), LARK_APP_ID);
    expect(r?.toast?.type).toBe('error');
    expect(transferSessionMock).not.toHaveBeenCalled();
  });

  it('returns not_owner when operator differs from session.ownerOpenId', async () => {
    const ds = makeDs();
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    const r = await handleCardAction(actionData(
      { action: 'relay_pickup', session_id: 'sess-source-1', target_chat_id: 'oc_target', root_id: 'om_root' },
      'ou_someone_else',
    ), deps(map), LARK_APP_ID);

    expect(r?.toast?.type).toBe('error');
    expect(transferSessionMock).not.toHaveBeenCalled();
  });

  it('refuses to relay into the same chat the session is already in', async () => {
    const ds = makeDs({ chatId: 'oc_target' }); // same as the picker's target
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    const r = await handleCardAction(actionData(
      { action: 'relay_pickup', session_id: 'sess-source-1', target_chat_id: 'oc_target', root_id: 'om_root' },
    ), deps(map), LARK_APP_ID);

    expect(r?.toast?.type).toBe('error');
    expect(transferSessionMock).not.toHaveBeenCalled();
  });

  it('happy path: sends M1, calls transferSession with the M1 id, deletes the picker card, returns success toast', async () => {
    const ds = makeDs();
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    const r = await handleCardAction({
      operator: { open_id: OWNER },
      action: { value: { action: 'relay_pickup', session_id: 'sess-source-1', target_chat_id: 'oc_target', root_id: 'om_target_root' } },
      context: { open_message_id: 'om_picker_card' },
    } as any, deps(map), LARK_APP_ID);

    // M1 sent to the target chat.
    expect(sendMessageMock).toHaveBeenCalled();
    expect(sendMessageMock.mock.calls[0][1]).toBe('oc_target');

    // transferSession called with the M1 message id as the new rootMessageId.
    expect(transferSessionMock).toHaveBeenCalledWith('sess-source-1', 'oc_target', 'om_M1');

    // Picker card got cleaned up (best-effort delete).
    expect(deleteMessageMock).toHaveBeenCalledWith(LARK_APP_ID, 'om_picker_card');

    // Success toast returned.
    expect(r?.toast?.type).toBe('success');
  });

  it('returns a friendly toast when transferSession reports target_chat_has_session', async () => {
    const ds = makeDs();
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    transferSessionMock.mockResolvedValueOnce({ ok: false, error: 'target_chat_has_session' });

    const r = await handleCardAction(actionData(
      { action: 'relay_pickup', session_id: 'sess-source-1', target_chat_id: 'oc_target', root_id: 'om_root' },
    ), deps(map), LARK_APP_ID);

    expect(r?.toast?.type).toBe('error');
    // Specific message, not the generic "Relay failed: target_chat_has_session" passthrough.
    expect(r?.toast?.content).toContain('已有');
    expect(r?.toast?.content).not.toMatch(/target_chat_has_session/);
  });

  it('returns the transferSession error as a toast when transfer fails', async () => {
    const ds = makeDs();
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    transferSessionMock.mockResolvedValueOnce({ ok: false, error: 'worker_busy_timeout' });

    const r = await handleCardAction(actionData(
      { action: 'relay_pickup', session_id: 'sess-source-1', target_chat_id: 'oc_target', root_id: 'om_root' },
    ), deps(map), LARK_APP_ID);

    expect(r?.toast?.type).toBe('error');
    expect(r?.toast?.content).toContain('worker_busy_timeout');
  });
});
