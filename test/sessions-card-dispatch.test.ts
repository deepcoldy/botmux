/**
 * PR3 `/dashboard sessions` slice 1 — production dispatch path test.
 *
 * Exercises the public `handleCardAction(...)` entry and verifies that the
 * `dash_sessions_*` arm:
 *  - hits `handleSessionsCardAction`,
 *  - returns `{ card }` only on the fast path (no toast, no out-of-band
 *    updateMessage — that's the stale-render fix carried over from settings).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/im/lark/client.js')>(
    '../src/im/lark/client.js',
  );
  return {
    ...actual,
    updateMessage: vi.fn(async () => {}),
    resolveUserUnionId: vi.fn(async () => ({})),
  };
});

vi.mock('../src/daemon-internal-client-wrapper.js', () => ({
  createDaemonClientFor: vi.fn(),
}));

vi.mock('../src/bot-registry.js', async () => {
  const actual = await vi.importActual<typeof import('../src/bot-registry.js')>('../src/bot-registry.js');
  return {
    ...actual,
    getOwnerOpenId: vi.fn(() => 'ou_alice'),
    getDashboardAdminOpenIds: vi.fn(() => ['ou_alice']),
  };
});

import { updateMessage } from '../src/im/lark/client.js';
import { createDaemonClientFor } from '../src/daemon-internal-client-wrapper.js';
import { handleCardAction, type CardActionData } from '../src/im/lark/card-handler.js';

const mockedUpdateMessage = vi.mocked(updateMessage);
const mockedCreateClient = vi.mocked(createDaemonClientFor);

const LARK_APP_ID = 'cli_test';
const INVOKER = 'ou_alice';

beforeEach(() => {
  mockedUpdateMessage.mockClear();
  mockedCreateClient.mockReset();
});

function makeDeps(): any {
  return {
    activeSessions: new Map(),
    sessionReply: vi.fn(async () => 'om_reply'),
    getActiveCount: () => 0,
    lastRepoScan: new Map(),
  };
}

describe('handleCardAction → sessions dispatch returns { card } only on success', () => {
  it('refresh: result.card is the rebuilt list card; updateMessage NOT called on fast path', async () => {
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/sessions-list') {
        return {
          status: 200, raw: '',
          body: { sessions: [
            { sessionId: 's1', rootMessageId: 'om', chatId: 'oc', chatType: 'group', title: 'one', cliId: 'claude-code', workingDir: '~/x', status: 'working', lastMessageAt: 1_000_000, cliVersion: 'v', webPort: 7891, scope: 'thread', spawnedAt: 0, larkAppId: LARK_APP_ID, isOncall: false, hasHistory: true },
          ] },
        };
      }
      throw new Error('unexpected: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_sessions_refresh', invoker_open_id: INVOKER } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.toast).toBeUndefined();
    expect(result.card).toBeDefined();
    expect(result.card?.type).toBe('raw');
    const cardJson = JSON.stringify(result.card?.data);
    expect(cardJson).toContain('Dashboard 会话');
    expect(cardJson).toContain('one');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  it('page: result.card reflects the requested page', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      sessionId: `s_${i}`, rootMessageId: 'om', chatId: 'oc', chatType: 'group',
      title: `t-${i}`, cliId: 'claude-code', workingDir: '~/x', status: 'idle',
      lastMessageAt: 1_000_000, cliVersion: 'v', webPort: 7891, scope: 'thread',
      spawnedAt: 0, larkAppId: LARK_APP_ID, isOncall: false, hasHistory: true,
    }));
    const requestSpy = vi.fn(async () => ({ status: 200, raw: '', body: { sessions: rows } }));
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_sessions_page', invoker_open_id: INVOKER, page: '2' } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.card).toBeDefined();
    const cardJson = JSON.stringify(result.card?.data);
    // PAGE_SIZE=5 (unified 2026-06-10). 25 / 5 = 5 pages.
    expect(cardJson).toContain('第 2/5 页');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  // ─── Slice 2a: detail / close dispatch ──────────────────────────────
  it('detail: fast path returns { card } with detail body; updateMessage NOT called', async () => {
    const sessions = [
      { sessionId: 'sess_a', rootMessageId: 'om', chatId: 'oc', chatType: 'group',
        title: 'visible', cliId: 'claude-code', workingDir: '~/x', status: 'idle',
        lastMessageAt: 1_000_000, cliVersion: 'v', webPort: 7891, scope: 'thread',
        spawnedAt: 0, larkAppId: LARK_APP_ID, isOncall: false, hasHistory: true },
    ];
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/sessions-list') {
        return { status: 200, raw: '', body: { sessions } };
      }
      throw new Error('unexpected: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_sessions_detail', invoker_open_id: INVOKER, session_id: 'sess_a' } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.toast).toBeUndefined();
    expect(result.card).toBeDefined();
    const cardJson = JSON.stringify(result.card?.data);
    // Detail card header rendered + close button action embedded.
    expect(cardJson).toContain('会话详情');
    expect(cardJson).toContain('dash_sessions_close');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  it('close (happy): returns { card } with closed-state detail; updateMessage NOT called', async () => {
    const sessions = [
      { sessionId: 'sess_close', rootMessageId: 'om', chatId: 'oc', chatType: 'group',
        title: 'close me', cliId: 'claude-code', workingDir: '~/x', status: 'idle',
        lastMessageAt: 1_000_000, cliVersion: 'v', webPort: 7891, scope: 'thread',
        spawnedAt: 0, larkAppId: LARK_APP_ID, isOncall: false, hasHistory: true },
    ];
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/sessions-list') {
        return { status: 200, raw: '', body: { sessions } };
      }
      if (req.method === 'POST' && req.path === '/__daemon/sessions/sess_close/close') {
        return { status: 200, raw: '', body: { ok: true, alreadyClosed: false } };
      }
      throw new Error('unexpected: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_sessions_close', invoker_open_id: INVOKER, session_id: 'sess_close' } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    // Single-pass: card returned, NO toast (per the slice 2a contract).
    expect(result.toast).toBeUndefined();
    expect(result.card).toBeDefined();
    const cardJson = JSON.stringify(result.card?.data);
    // Closed-state synth (slice 2b): close button replaced by resume.
    expect(cardJson).toContain('dash_sessions_resume');
    expect(cardJson).not.toContain('"action":"dash_sessions_close"');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  it('close (non-200): toast close_failed only; NO card returned', async () => {
    const sessions = [
      { sessionId: 'sess_close', rootMessageId: 'om', chatId: 'oc', chatType: 'group',
        title: 'close me', cliId: 'claude-code', workingDir: '~/x', status: 'idle',
        lastMessageAt: 1_000_000, cliVersion: 'v', webPort: 7891, scope: 'thread',
        spawnedAt: 0, larkAppId: LARK_APP_ID, isOncall: false, hasHistory: true },
    ];
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/sessions-list') {
        return { status: 200, raw: '', body: { sessions } };
      }
      if (req.method === 'POST' && req.path === '/__daemon/sessions/sess_close/close') {
        return { status: 500, raw: '', body: { error: 'internal' } };
      }
      throw new Error('unexpected: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_sessions_close', invoker_open_id: INVOKER, session_id: 'sess_close' } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.toast?.content).toContain('关闭失败');
    expect(result.card).toBeUndefined();

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });
});
