/**
 * Verifies that the `case 'ready'` handler in worker-pool.ts sends
 * `set_display_mode` to the worker after POSTing a new streaming card.
 *
 * Regression test for: worker 重启走 POST 路径时未补发 set_display_mode，
 * 导致截图循环静默失效。
 *
 * Scenarios:
 *   1. POST path + displayMode='screenshot' → worker.send called
 *   2. POST path + displayMode='hidden' → worker.send NOT called
 *   3. PATCH path + displayMode='screenshot' → worker.send called (symmetry)
 *
 * Run:  pnpm vitest run test/worker-ready-display-mode.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const updateMessageMock = vi.fn(async () => {});
const { loggerInfoMock } = vi.hoisted(() => ({ loggerInfoMock: vi.fn() }));

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return {
    updateMessage: (...args: any[]) => updateMessageMock(...args),
    deleteMessage: vi.fn(async () => {}),
    MessageWithdrawnError,
  };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn((...args: any[]) => JSON.stringify({
    type: 'streaming',
    readUrl: args[2],
    localCliReady: args[15] === true,
  })),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
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
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  closeSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  persistStreamCardState: vi.fn(),
  ensureSessionWhiteboard: vi.fn(),
  rememberLastCliInput: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(),
}));

vi.mock('../src/skills/installer.js', () => ({
  ensureSkills: vi.fn(),
}));

vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: vi.fn(),
}));

vi.mock('../src/services/local-cli-opener.js', () => ({
  isLocalCliOpenEnabled: vi.fn(() => true),
  isLocalCliOpenReady: vi.fn((ds: DaemonSession, opts?: { cliId?: string }) => {
    if (!ds.adoptedFrom && !ds.session.adoptedFrom && (ds.session.backendType === 'tmux' || ds.session.backendType === 'herdr')) {
      return true;
    }
    const cliId = opts?.cliId ?? ds.session.cliId;
    if (cliId === 'oh-my-pi') return true;
    return !!(ds.adoptedFrom?.sessionId ?? ds.session.adoptedFrom?.sessionId ?? ds.session.cliSessionId);
  }),
}));

vi.mock('../src/adapters/cli/claude-code.js', () => ({
  claudeJsonlPathForSession: vi.fn(),
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: class {},
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: loggerInfoMock, warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

// ─── Imports under test ────────────────────────────────────────────────────

import { CARD_POSTING_SENTINEL, initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { getBot } from '../src/bot-registry.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeFakeWorker() {
  const w = new EventEmitter() as any;
  w.killed = false;
  w.send = vi.fn();
  w.kill = vi.fn();
  w.pid = 12345;
  w.stdout = new EventEmitter();
  w.stderr = new EventEmitter();
  return w;
}

function makeDs(overrides?: Partial<DaemonSession>): DaemonSession {
  return {
    session: {
      sessionId: 'sid-ready-test',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'Test Session',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker: makeFakeWorker(),
    workerPort: null,
    workerToken: null,
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    displayMode: 'hidden',
    streamCardNonce: undefined,
    lastScreenContent: '',
    lastScreenStatus: 'working',
    currentTurnTitle: 'Test task',
    ...overrides,
  } as DaemonSession;
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Worker ready: set_display_mode re-sync', () => {
  let sessionReplyMock: ReturnType<typeof vi.fn>;
  let closeSessionMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionReplyMock = vi.fn(async () => 'om_new_card');
    closeSessionMock = vi.fn();
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: closeSessionMock,
    });
  });

  it('POST path forwards ready.turnId to sessionReply for initial alias cards', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ streamCardPending: true, streamCardId: undefined, worker: fakeWorker });

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', {
      type: 'ready',
      port: 9999,
      token: 'tok_abc',
      viewToken: 'view_cap',
      turnId: 'om_turn_ready',
    });
    await flush();

    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(sessionReplyMock.mock.calls[0][4]).toBe('om_turn_ready');
    expect(ds.workerViewToken).toBe('view_cap');
    expect(JSON.stringify(sessionReplyMock.mock.calls[0][1])).toContain('viewToken=view_cap');
    const logs = loggerInfoMock.mock.calls.flat().join('\n');
    expect(logs).toContain('viewToken=[redacted]');
    expect(logs).not.toContain('view_cap');
  });

  it('doc-native session never posts a streaming card to the virtual doc: chat id', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      scope: 'chat',
      chatId: 'doc:doc_token_123',
      session: {
        ...makeDs().session,
        chatId: 'doc:doc_token_123',
        rootMessageId: 'doc:doc_token_123',
      },
      streamCardPending: true,
      streamCardId: undefined,
      worker: fakeWorker,
    });

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_doc' });
    await flush();

    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('POST path sends set_display_mode when displayMode is screenshot', async () => {
    const fakeWorker = makeFakeWorker();
    // streamCardPending = true forces POST path (no existing card to PATCH)
    const ds = makeDs({
      displayMode: 'screenshot',
      streamCardPending: true,
      streamCardId: undefined,
      worker: fakeWorker,
    });

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();

    // sessionReply should have been called (POST new card)
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    // worker.send should be called with set_display_mode
    expect(fakeWorker.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set_display_mode', mode: 'screenshot' }),
    );
  });

  it('POST path does NOT send set_display_mode when displayMode is hidden', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      displayMode: 'hidden',
      streamCardPending: true,
      streamCardId: undefined,
      worker: fakeWorker,
    });

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();

    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    // worker.send should NOT be called with set_display_mode
    const sendCalls = fakeWorker.send.mock.calls;
    const displayModeCalls = sendCalls.filter(
      (args: any[]) => args[0]?.type === 'set_display_mode',
    );
    expect(displayModeCalls).toHaveLength(0);
  });

  it('PATCH path sends set_display_mode when displayMode is screenshot', async () => {
    const fakeWorker = makeFakeWorker();
    // Existing card + streamCardPending=false → PATCH path
    const ds = makeDs({
      displayMode: 'screenshot',
      streamCardPending: false,
      streamCardId: 'om_existing_card',
      worker: fakeWorker,
    });

    updateMessageMock.mockResolvedValueOnce(undefined);

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();

    // updateMessage should have been called (PATCH existing card)
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    // sessionReply should NOT be called (didn't fall through to POST)
    expect(sessionReplyMock).not.toHaveBeenCalled();
    // worker.send should be called with set_display_mode
    expect(fakeWorker.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set_display_mode', mode: 'screenshot' }),
    );
  });

  it('re-applies readiness when cli_session_id races a restored-card PATCH', async () => {
    let resolveRestorePatch!: () => void;
    updateMessageMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveRestorePatch = resolve;
    }));
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      streamCardPending: false,
      streamCardId: 'om_existing_card',
      workingDir: '/tmp',
    });
    ds.session.cliId = 'traex';
    ds.session.cliSessionId = undefined;
    ds.session.workingDir = '/tmp';

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(updateMessageMock.mock.calls[0][2])).toMatchObject({ localCliReady: false });

    fakeWorker.emit('message', { type: 'cli_session_id', cliSessionId: 'trae-native-ready' });
    await flush();
    expect(updateMessageMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(updateMessageMock.mock.calls[1][2])).toMatchObject({ localCliReady: true });

    resolveRestorePatch();
    await flush();
    await flush();

    expect(updateMessageMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(updateMessageMock.mock.calls.at(-1)![2])).toMatchObject({ localCliReady: true });
  });

  it('does not require cli_session_id for mode-aware managed tmux local attach readiness', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      streamCardPending: false,
      streamCardId: 'om_existing_card',
      workingDir: '/tmp',
    });
    ds.session.cliId = 'gemini' as any;
    ds.session.backendType = 'tmux';
    ds.session.cliSessionId = undefined;
    ds.session.workingDir = '/tmp';

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();

    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(updateMessageMock.mock.calls[0][2])).toMatchObject({ localCliReady: true });
  });

  // Regression: a re-fork that happens while streamCardPending is true (new turn
  // + worker had exited, e.g. resume) used to POST the "starting" card via the
  // ready path but leave streamCardPending=true. The next screen_update then took
  // the new-card POST branch and emitted a SECOND card ("working"), orphaning the
  // "starting" card (never frozen → recallFrozenCards can't withdraw it). The
  // ready POST path must clear streamCardPending so subsequent screen_updates
  // PATCH this card in place instead.
  it('POST path clears streamCardPending so the next screen_update PATCHes (no duplicate card)', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      displayMode: 'hidden',
      streamCardPending: true,
      streamCardId: undefined,
      worker: fakeWorker,
    });

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();

    // POSTed exactly one card and committed its id.
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(ds.streamCardId).toBe('om_new_card');
    // Flag cleared → a later screen_update will PATCH, not POST a 2nd card.
    expect(ds.streamCardPending).toBe(false);
  });

  it('patches the active card when cli_session_id makes local resume ready', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      workerPort: 9999,
      streamCardId: 'om_existing_card',
      workingDir: '/tmp',
    });
    ds.session.cliId = 'traex';
    ds.session.cliSessionId = undefined;
    ds.session.workingDir = '/tmp';
    ds.adoptedFrom = { source: 'tmux', tmuxTarget: 'dev:1.2', cliId: 'traex', cwd: '/tmp' };
    ds.session.adoptedFrom = { source: 'tmux', tmuxTarget: 'dev:1.2', cliId: 'traex', cwd: '/tmp' };

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'cli_session_id', cliSessionId: 'trae-native-ready' });
    await flush();

    expect(ds.session.cliSessionId).toBe('trae-native-ready');
    expect(ds.adoptedFrom.sessionId).toBe('trae-native-ready');
    expect(ds.session.adoptedFrom.sessionId).toBe('trae-native-ready');
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(updateMessageMock.mock.calls[0][1]).toBe('om_existing_card');
    expect(JSON.parse(updateMessageMock.mock.calls[0][2])).toMatchObject({ localCliReady: true });
  });

  it('defers the readiness patch until an in-flight card POST has a message id', async () => {
    let resolveReply!: (messageId: string) => void;
    sessionReplyMock.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveReply = resolve;
    }));
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      streamCardPending: true,
      streamCardId: undefined,
      workingDir: '/tmp',
    });
    ds.session.cliId = 'traex';
    ds.session.cliSessionId = undefined;
    ds.session.workingDir = '/tmp';

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();
    expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);

    fakeWorker.emit('message', { type: 'cli_session_id', cliSessionId: 'trae-native-ready' });
    await flush();
    expect(ds.pendingLocalCliButtonRefresh).toBe(true);
    expect(updateMessageMock).not.toHaveBeenCalled();

    resolveReply('om_new_card');
    await flush();
    await flush();

    expect(ds.streamCardId).toBe('om_new_card');
    expect(ds.pendingLocalCliButtonRefresh).toBeUndefined();
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(updateMessageMock.mock.calls[0][1]).toBe('om_new_card');
    expect(JSON.parse(updateMessageMock.mock.calls[0][2])).toMatchObject({ localCliReady: true });
  });

  it('keeps a delivered fallback card/session alive when its readiness patch fails', async () => {
    let resolveFallbackReply!: (messageId: string) => void;
    sessionReplyMock
      .mockRejectedValueOnce(new Error('streaming POST failed'))
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        resolveFallbackReply = resolve;
      }));
    updateMessageMock.mockRejectedValueOnce(new Error('fallback PATCH failed'));
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker, workingDir: '/tmp' });
    ds.session.cliId = 'traex';
    ds.session.cliSessionId = undefined;
    ds.session.workingDir = '/tmp';

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'ready', port: 9999, token: 'tok_abc' });
    await flush();
    expect(sessionReplyMock).toHaveBeenCalledTimes(2);

    fakeWorker.emit('message', { type: 'cli_session_id', cliSessionId: 'trae-native-ready' });
    await flush();
    resolveFallbackReply('om_fallback_card');
    await flush();
    await flush();

    expect(updateMessageMock).toHaveBeenCalledWith(
      'app_test',
      'om_fallback_card',
      expect.any(String),
    );
    expect(closeSessionMock).not.toHaveBeenCalled();
  });

  it('prompt_ready sends a pending raw slash command once', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      pendingRawInput: '/goal ship the onboarding flow',
    } as Partial<DaemonSession>);

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();

    expect(fakeWorker.send).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/goal ship the onboarding flow',
    });
    expect(ds.pendingRawInput).toBeUndefined();

    fakeWorker.send.mockClear();
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();

    expect(fakeWorker.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'raw_input' }),
    );
  });

  it('prompt_ready bundles the buffered follow-up ONTO the raw_input IPC (single atomic message)', async () => {
    // Two separate IPCs would race inside the worker: its async message
    // handlers don't serialize, and raw_input awaits 200ms between sendText
    // and Enter — a separate `message` IPC could write into that window. The
    // follow-up must therefore ride on the raw_input message itself.
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      pendingRawInput: '/goal ship the onboarding flow',
      pendingFollowUpInput: {
        userPrompt: '另外帮我顺手看下 CI',
        cliInput: '<user_message>另外帮我顺手看下 CI</user_message>',
      },
    } as Partial<DaemonSession>);

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();

    // Exactly ONE outbound IPC carrying both payloads — never a separate
    // `message` IPC that could race the raw_input handler.
    expect(fakeWorker.send).toHaveBeenCalledTimes(1);
    expect(fakeWorker.send).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/goal ship the onboarding flow',
      followUpContent: '<user_message>另外帮我顺手看下 CI</user_message>',
    });
    expect(ds.pendingRawInput).toBeUndefined();
    expect(ds.pendingFollowUpInput).toBeUndefined();

    fakeWorker.send.mockClear();
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(fakeWorker.send).not.toHaveBeenCalled();
  });

  it('prompt_ready preserves a clean sidecar whose gate was frozen on when staged', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      pendingRawInput: '/goal ship',
      pendingFollowUpInput: {
        userPrompt: 'clean',
        cliInput: '<user_message>legacy</user_message>',
        codexAppInput: { text: 'clean' },
        codexAppInputGateFrozen: true,
      },
    } as Partial<DaemonSession>);

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();

    expect(fakeWorker.send).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/goal ship',
      followUpContent: '<user_message>legacy</user_message>',
      followUpCodexAppInput: { text: 'clean' },
    });
  });

  it('prompt_ready keeps a staged-off follow-up legacy even if config is now on', async () => {
    vi.mocked(getBot).mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'codex-app', codexAppCleanInput: true },
      resolvedAllowedUsers: [],
      botOpenId: 'ou_bot',
      botName: 'TestBot',
    } as any);
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({
      worker: fakeWorker,
      pendingRawInput: '/goal ship',
      pendingFollowUpInput: {
        userPrompt: 'legacy',
        cliInput: '<user_message>legacy</user_message>',
        codexAppInputGateFrozen: true,
      },
    } as Partial<DaemonSession>);
    ds.session.cliId = 'codex-app' as any;

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();

    expect(fakeWorker.send).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/goal ship',
      followUpContent: '<user_message>legacy</user_message>',
    });
  });

  it('prompt_ready without pending raw input never emits the buffered follow-up alone', async () => {
    const fakeWorker = makeFakeWorker();
    // Follow-up input only exists alongside pendingRawInput (built at the same
    // fork site); if state drifts, it must not fire without the raw command.
    const ds = makeDs({
      worker: fakeWorker,
      pendingFollowUpInput: { userPrompt: 'x', cliInput: '<user_message>x</user_message>' },
    } as Partial<DaemonSession>);

    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(fakeWorker.send).not.toHaveBeenCalled();
  });
});
