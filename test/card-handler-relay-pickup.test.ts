/**
 * Tests for the `relay_pick_select` card action: target-chat picker dropdown.
 *
 * The picker card renders a single `select_static` dropdown. When the user
 * picks an option, Lark fires the callback with `action.value.key =
 * 'relay_pick_select'` and `action.option = <sessionId>`. card-handler
 * resolves the source session, owner-checks, sends M1, then transferSession.
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
const getChatNameMock = vi.fn(async () => 'Friendly Source Chat Name');
vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return {
    ...actual,
    sendMessage: (...a: any[]) => sendMessageMock(...a),
    deleteMessage: (...a: any[]) => deleteMessageMock(...a),
    getChatName: (...a: any[]) => getChatNameMock(...a),
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

// New action shape: dropdown selection. action.value carries the per-card
// context (target chat / root), action.option carries the picked sessionId.
function actionData(opts: { sessionId?: string; target_chat_id?: string; root_id?: string; operator?: string } = {}) {
  return {
    operator: { open_id: opts.operator ?? OWNER },
    action: {
      value: {
        key: 'relay_pick_select',
        target_chat_id: opts.target_chat_id ?? 'oc_target',
        root_id: opts.root_id ?? 'om_target_root',
      },
      option: opts.sessionId,
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
  transferSessionMock.mockClear();
  transferSessionMock.mockResolvedValue({ ok: true });
});

describe('relay_pick_select dropdown action', () => {
  it('rejects when no option was selected (e.g. action.option missing)', async () => {
    const r = await handleCardAction({
      operator: { open_id: OWNER },
      action: { value: { key: 'relay_pick_select', target_chat_id: 'oc_target', root_id: 'om_root' } /* no option */ },
    } as any, deps(new Map()), LARK_APP_ID);
    // Dropdown without option → handler falls through (key check requires option).
    // Result is undefined or a non-relay toast — either way, no transfer.
    expect(transferSessionMock).not.toHaveBeenCalled();
    if (r) expect(r.toast?.content).not.toContain('Friendly Source');
  });

  it('returns not_found when the selected sessionId is not in active registry', async () => {
    const r = await handleCardAction(actionData({ sessionId: 'missing-sess' }), deps(new Map()), LARK_APP_ID);
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

  it('refuses to relay into the same chat the session is already in', async () => {
    const ds = makeDs({ chatId: 'oc_target' });
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    const r = await handleCardAction(actionData({ sessionId: 'sess-source-1' }), deps(map), LARK_APP_ID);

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
        value: { key: 'relay_pick_select', target_chat_id: 'oc_target', root_id: 'om_target_root' },
        option: 'sess-source-1',
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

    expect(transferSessionMock).toHaveBeenCalledWith('sess-source-1', 'oc_target', 'om_M1');
    expect(deleteMessageMock).toHaveBeenCalledWith(LARK_APP_ID, 'om_picker_card');
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

  it('returns a friendly toast when transferSession reports target_chat_has_session', async () => {
    const ds = makeDs();
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    transferSessionMock.mockResolvedValueOnce({ ok: false, error: 'target_chat_has_session' });

    const r = await handleCardAction(actionData({ sessionId: 'sess-source-1' }), deps(map), LARK_APP_ID);

    expect(r?.toast?.type).toBe('error');
    expect(r?.toast?.content).toContain('已有');
    expect(r?.toast?.content).not.toMatch(/target_chat_has_session/);
  });

  it('returns the transferSession error as a toast when transfer fails', async () => {
    const ds = makeDs();
    const map = new Map<string, DaemonSession>();
    map.set(sessionKey('om_source_root', LARK_APP_ID), ds);

    transferSessionMock.mockResolvedValueOnce({ ok: false, error: 'worker_busy_timeout' });

    const r = await handleCardAction(actionData({ sessionId: 'sess-source-1' }), deps(map), LARK_APP_ID);

    expect(r?.toast?.type).toBe('error');
    expect(r?.toast?.content).toContain('worker_busy_timeout');
  });
});
