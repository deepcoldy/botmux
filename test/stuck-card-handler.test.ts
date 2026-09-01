/**
 * Card-handler tests for stuck-warning tui_keys clicks.
 *
 * Covers (PR #559 review round 5):
 *   1. Valid click → worker.send called with allowlisted key (not value.keys)
 *   2. Duplicate click (processing=true) → worker.send NOT called again
 *   3. Missing selected_index → no worker.send (fail-closed, no default to trust)
 *   4. Out-of-range index → no worker.send
 *   5. Non-integer index → no worker.send
 *
 * Run:  pnpm vitest run test/stuck-card-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'bun:test';
import { handleCardAction, type CardHandlerDeps } from '../src/im/lark/card-handler.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';

const APP_ID = 'cli_test';
const ROOT_ID = 'om_root';
const CARD_ID = 'om_stuck_card';

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  replyMessage: vi.fn(async () => {}),
  getMessageDetail: vi.fn(async () => ({ body: { content: '' } })),
  deleteMessage: vi.fn(async () => {}),
  MessageWithdrawnError: class extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn((text: string) => JSON.stringify({ text })),
  buildTuiPromptProcessingCard: vi.fn((text: string) => JSON.stringify({ text })),
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Codex'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'codex' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'codex' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(),
}));

vi.mock('../src/im/lark/l10n.js', () => ({
  localeForBot: vi.fn(() => 'zh'),
  tr: vi.fn((key: string) => key),
}));

vi.mock('../src/im/lark/event-dispatcher.js', () => ({
  canOperate: vi.fn(() => true),
  canTalk: vi.fn(() => true),
}));

vi.mock('../src/core/session-activity.js', () => ({
  publishAttentionPatch: vi.fn(),
  publishClosedSessionPatch: vi.fn(),
  announcePendingRepoSession: vi.fn(),
}));

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeDs(overrides?: Partial<DaemonSession>): DaemonSession {
  return {
    session: {
      sessionId: 'sid-card-test',
      rootMessageId: ROOT_ID,
      chatId: 'oc_chat',
      title: 'Test',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    workerGeneration: 1,
    larkAppId: APP_ID,
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    ...overrides,
  } as DaemonSession;
}

function makeDeps(sessions: Map<string, DaemonSession>): CardHandlerDeps {
  return {
    activeSessions: sessions,
    sessionReply: vi.fn(async () => 'om_reply'),
    lastRepoScan: new Map(),
  };
}

function makeTuiKeysEvent(value: Record<string, any>, clickedMessageId = CARD_ID) {
  return {
    action: { value: { action: 'tui_keys', root_id: ROOT_ID, ...value } },
    operator: { open_id: 'ou_user' },
    context: { open_message_id: clickedMessageId },
  };
}

function makeTuiTextEvent(text: string, inputKeys = '["Down","Enter"]') {
  return {
    action: {
      value: {
        action: 'tui_text_input',
        root_id: ROOT_ID,
        input_keys: inputKeys,
      },
      form_value: { tui_custom_input: text },
    },
    operator: { open_id: 'ou_user' },
    context: { open_message_id: CARD_ID },
  };
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('stuck-warning card tui_keys handler', () => {
  let workerSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    workerSend = vi.fn((_message, callback?: (error: Error | null) => void) => {
      callback?.(null);
      return true;
    });
  });

  it('sends allowlisted key derived from pageType+index (ignores value.keys)', async () => {
    const ds = makeDs({
      worker: { killed: false, send: workerSend } as any,
      stuckWarningCardId: CARD_ID,
      stuckWarningNonce: 1,
      stuckWarningNonceCounter: 1,
      stuckWarningPageType: 'hook review level 1',
      stuckWarningCliLifetime: 1,
    });
    const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
    const deps = makeDeps(sessions);

    // Card sends keys=["rm","-rf","/"] (malicious) but index=2 (Esc)
    await handleCardAction(makeTuiKeysEvent({ keys: '["rm","-rf","/"]', selected_index: '2', is_final: '1' }) as any, deps, APP_ID);
    await flush();

    // Worker should receive only the allowlisted Escape key, not the malicious keys
    expect(workerSend).toHaveBeenCalledTimes(1);
    const sent = workerSend.mock.calls[0][0];
    expect(sent.type).toBe('tui_keys');
    expect(sent.keys).toEqual(['Escape']);
    expect(sent.stuckNonce).toBe(1);
    expect(sent.stuckCliLifetime).toBe(1);
  });

  it('duplicate click (processing=true) does NOT send keys again', async () => {
    const ds = makeDs({
      worker: { killed: false, send: workerSend } as any,
      stuckWarningCardId: CARD_ID,
      stuckWarningNonce: 1,
      stuckWarningNonceCounter: 1,
      stuckWarningPageType: 'hook review level 1',
      stuckWarningCliLifetime: 1,
      stuckWarningProcessing: true, // already processing
    });
    const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
    const deps = makeDeps(sessions);

    await handleCardAction(makeTuiKeysEvent({ selected_index: '0', is_final: '1' }) as any, deps, APP_ID);
    await flush();

    expect(workerSend).not.toHaveBeenCalled();
  });

  it('missing selected_index → no keys sent (fail-closed, no default to trust)', async () => {
    const ds = makeDs({
      worker: { killed: false, send: workerSend } as any,
      stuckWarningCardId: CARD_ID,
      stuckWarningNonce: 1,
      stuckWarningNonceCounter: 1,
      stuckWarningPageType: 'hook review level 1',
      stuckWarningCliLifetime: 1,
    });
    const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
    const deps = makeDeps(sessions);

    // No selected_index in the event
    await handleCardAction(makeTuiKeysEvent({ is_final: '1' }) as any, deps, APP_ID);
    await flush();

    expect(workerSend).not.toHaveBeenCalled();
  });

  it('out-of-range index → no keys sent', async () => {
    const ds = makeDs({
      worker: { killed: false, send: workerSend } as any,
      stuckWarningCardId: CARD_ID,
      stuckWarningNonce: 1,
      stuckWarningNonceCounter: 1,
      stuckWarningPageType: 'hook review level 1', // has 3 options (0,1,2)
      stuckWarningCliLifetime: 1,
    });
    const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
    const deps = makeDeps(sessions);

    await handleCardAction(makeTuiKeysEvent({ selected_index: '5', is_final: '1' }) as any, deps, APP_ID);
    await flush();

    expect(workerSend).not.toHaveBeenCalled();
  });

  it('non-integer index → no keys sent', async () => {
    const ds = makeDs({
      worker: { killed: false, send: workerSend } as any,
      stuckWarningCardId: CARD_ID,
      stuckWarningNonce: 1,
      stuckWarningNonceCounter: 1,
      stuckWarningPageType: 'hook review level 1',
      stuckWarningCliLifetime: 1,
    });
    const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
    const deps = makeDeps(sessions);

    await handleCardAction(makeTuiKeysEvent({ selected_index: 'abc', is_final: '1' }) as any, deps, APP_ID);
    await flush();

    expect(workerSend).not.toHaveBeenCalled();
  });

  it('level 2 page type maps index 0=t, 1=Esc', async () => {
    const ds = makeDs({
      worker: { killed: false, send: workerSend } as any,
      stuckWarningCardId: CARD_ID,
      stuckWarningNonce: 1,
      stuckWarningNonceCounter: 1,
      stuckWarningPageType: 'hook review level 2',
      stuckWarningCliLifetime: 1,
    });
    const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
    const deps = makeDeps(sessions);

    await handleCardAction(makeTuiKeysEvent({ selected_index: '1', is_final: '1' }) as any, deps, APP_ID);
    await flush();

    expect(workerSend).toHaveBeenCalledTimes(1);
    expect(workerSend.mock.calls[0][0].keys).toEqual(['Escape']);
  });

  it('releases the stuck-card processing claim when IPC delivery fails', async () => {
    workerSend.mockImplementation((_message, callback?: (error: Error | null) => void) => {
      callback?.(new Error('channel closed'));
      return false;
    });
    const ds = makeDs({
      worker: { killed: false, connected: true, send: workerSend } as any,
      stuckWarningCardId: CARD_ID,
      stuckWarningNonce: 1,
      stuckWarningNonceCounter: 1,
      stuckWarningPageType: 'hook review level 1',
      stuckWarningCliLifetime: 1,
    });
    const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);

    const result = await handleCardAction(
      makeTuiKeysEvent({ selected_index: '0', is_final: '1' }) as any,
      makeDeps(sessions),
      APP_ID,
    );

    expect(result).toMatchObject({ toast: { type: 'warning' } });
    expect(ds.stuckWarningProcessing).toBe(false);
  });

  it('keeps a normal TUI card active until the worker/backend ACK arrives', async () => {
    const ds = makeDs({
      worker: { killed: false, connected: true, send: workerSend } as any,
      tuiPromptCardId: CARD_ID,
      tuiPromptOptions: [
        { text: 'Approve', selected: false, type: 'select', keys: ['Enter'] },
      ],
    });
    const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);

    const result = await handleCardAction(
      makeTuiKeysEvent({
        keys: '["Enter"]',
        selected_index: '0',
        selected_text: 'Approve',
        option_type: 'select',
        is_final: '1',
      }) as any,
      makeDeps(sessions),
      APP_ID,
    );

    expect(result).toEqual({ text: 'Approve' });
    expect(ds.tuiPromptCardId).toBe(CARD_ID);
    expect(workerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tui_keys',
        cardMessageId: CARD_ID,
        selectedText: 'Approve',
      }),
      expect.any(Function),
    );
  });

  it('claims a normal TUI card synchronously so a second final click cannot inject keys twice', async () => {
    const ds = makeDs({
      worker: { killed: false, connected: true, send: workerSend } as any,
      tuiPromptCardId: CARD_ID,
      tuiPromptOptions: [
        { text: 'Approve', selected: false, type: 'select', keys: ['1', 'Enter'] },
        { text: 'Reject', selected: false, type: 'select', keys: ['3', 'Enter'] },
      ],
    });
    const deps = makeDeps(new Map([[sessionKey(ROOT_ID, APP_ID), ds]]));

    await handleCardAction(
      makeTuiKeysEvent({
        keys: '["1","Enter"]',
        selected_index: '0',
        selected_text: 'Approve',
        option_type: 'select',
        is_final: '1',
      }) as any,
      deps,
      APP_ID,
    );
    await handleCardAction(
      makeTuiKeysEvent({
        keys: '["3","Enter"]',
        selected_index: '1',
        selected_text: 'Reject',
        option_type: 'select',
        is_final: '1',
      }) as any,
      deps,
      APP_ID,
    );

    expect(workerSend).toHaveBeenCalledTimes(1);
    expect(ds.tuiPromptProcessing).toBe(true);
  });

  it('releases the normal TUI key claim when daemon-to-worker IPC delivery fails', async () => {
    workerSend.mockImplementation((_message, callback?: (error: Error | null) => void) => {
      callback?.(new Error('channel closed'));
      return false;
    });
    const ds = makeDs({
      worker: { killed: false, connected: true, send: workerSend } as any,
      tuiPromptCardId: CARD_ID,
      tuiPromptOptions: [
        { text: 'Approve', selected: false, type: 'select', keys: ['Enter'] },
      ],
    });

    const result = await handleCardAction(
      makeTuiKeysEvent({
        keys: '["Enter"]',
        selected_index: '0',
        selected_text: 'Approve',
        option_type: 'select',
        is_final: '1',
      }) as any,
      makeDeps(new Map([[sessionKey(ROOT_ID, APP_ID), ds]])),
      APP_ID,
    );

    expect(result).toMatchObject({ toast: { type: 'warning' } });
    expect(ds.tuiPromptProcessing).toBe(false);
  });

  it('keeps text-input cards active while awaiting the worker/backend ACK', async () => {
    const ds = makeDs({
      worker: { killed: false, connected: true, send: workerSend } as any,
      tuiPromptCardId: CARD_ID,
    });
    const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);

    const result = await handleCardAction(
      makeTuiTextEvent('custom answer') as any,
      makeDeps(sessions),
      APP_ID,
    );

    expect(result).toEqual({ text: 'custom answer' });
    expect(ds.tuiPromptCardId).toBe(CARD_ID);
    expect(workerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tui_text_input',
        cardMessageId: CARD_ID,
        text: 'custom answer',
      }),
      expect.any(Function),
    );
  });

  it('claims a normal TUI text-input card until the worker/backend ACK arrives', async () => {
    const ds = makeDs({
      worker: { killed: false, connected: true, send: workerSend } as any,
      tuiPromptCardId: CARD_ID,
    });
    const deps = makeDeps(new Map([[sessionKey(ROOT_ID, APP_ID), ds]]));

    await handleCardAction(makeTuiTextEvent('first answer') as any, deps, APP_ID);
    await handleCardAction(makeTuiTextEvent('second answer') as any, deps, APP_ID);

    expect(workerSend).toHaveBeenCalledTimes(1);
    expect(ds.tuiPromptProcessing).toBe(true);
  });

  it('releases the normal TUI text-input claim when daemon-to-worker IPC delivery fails', async () => {
    workerSend.mockImplementation((_message, callback?: (error: Error | null) => void) => {
      callback?.(new Error('channel closed'));
      return false;
    });
    const ds = makeDs({
      worker: { killed: false, connected: true, send: workerSend } as any,
      tuiPromptCardId: CARD_ID,
    });

    const result = await handleCardAction(
      makeTuiTextEvent('retryable answer') as any,
      makeDeps(new Map([[sessionKey(ROOT_ID, APP_ID), ds]])),
      APP_ID,
    );

    expect(result).toMatchObject({ toast: { type: 'warning' } });
    expect(ds.tuiPromptProcessing).toBe(false);
  });

  it('does not render text input as processing when nothing was dispatched', async () => {
    const ds = makeDs({
      worker: null,
      tuiPromptCardId: CARD_ID,
    });
    const sessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);

    const result = await handleCardAction(
      makeTuiTextEvent('custom answer') as any,
      makeDeps(sessions),
      APP_ID,
    );

    expect(result).toMatchObject({ toast: { type: 'warning' } });
    expect(ds.tuiPromptCardId).toBe(CARD_ID);
  });
});
