/**
 * Integration tests for the stuck-warning state machine in worker-pool.ts.
 *
 * Exercises the REAL message handlers (stuck_warning / tui_keys_delivered /
 * stuck_warning_expired / tui_prompt_submit_failed) via
 * __testOnly_setupWorkerHandlers, with a deferred
 * sessionReply to simulate in-flight card POSTs.
 *
 * Covers (PR #559 review rounds 3-5):
 *   1. stuck_warning → POST → card registered with daemon nonce
 *   2. Old POST race: prompt_ready clears authority while POST in flight →
 *      late POST result does NOT register the card
 *   3. tui_keys_delivered (matching nonce) → card resolved + authority cleared
 *   4. stuck_warning_expired (matching nonce) → card resolved + authority cleared
 *   5. Old ACK (nonce=1) after new warning (nonce=2) → no effect on new authority
 *   6. delivered/expired each only PATCH the card once
 *   7. Nonce is monotonic: counter never resets after clear
 *
 * Run:  pnpm vitest run test/stuck-warning-integration.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  initWorkerPool,
  __testOnly_reserveWorkerGeneration,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { botLocale, localeForBot, t as tr } from '../src/i18n/index.js';
import { stuckCardFallbackText, stuckKeyResultText } from '../src/core/stuck-warning-card.js';
import { config } from '../src/config.js';
import { getBot } from '../src/bot-registry.js';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const updateMessageMock = vi.fn(async () => {});

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: (...args: any[]) => updateMessageMock(...args),
  deleteMessage: vi.fn(async () => {}),
  MessageWithdrawnError: class extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildTuiPromptCard: vi.fn(() => '{"type":"tui_prompt"}'),
  buildTuiPromptResolvedCard: vi.fn((text: string) => JSON.stringify({ type: 'resolved', text })),
  buildTuiPromptFailedCard: vi.fn((text: string) => JSON.stringify({ type: 'failed', text })),
  buildTuiPromptProcessingCard: vi.fn((text: string) => JSON.stringify({ type: 'processing', text })),
  buildStuckPageCard: vi.fn((o: Record<string, unknown>) => JSON.stringify({ type: 'stuck_page', ...o })),
  buildStuckKeyResultCard: vi.fn((text: string, tail: string | undefined, stillBlocked: boolean) =>
    JSON.stringify({ type: 'stuck_result', text, tail, stillBlocked })),
  buildInputNotSubmittedCard: vi.fn((message: string, tail: string) =>
    JSON.stringify({ type: 'input_not_submitted', message, tail })),
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Codex'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'codex' },
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
  isLocalCliOpenEnabled: vi.fn(() => false),
  isLocalCliOpenReady: vi.fn(() => false),
}));

vi.mock('../src/im/lark/l10n.js', () => ({
  localeForBot: vi.fn(() => 'zh'),
  tr: vi.fn((key: string) => key),
}));

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
      sessionId: 'sid-stuck-test',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'Test Session',
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
    larkAppId: 'app_test',
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

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('stuck-warning state machine (integration)', () => {
  let sessionReplyMock: ReturnType<typeof vi.fn>;
  let sessionReplyDeferred: { resolve: (id: string) => void; promise: Promise<string> };

  beforeEach(() => {
    vi.clearAllMocks();
    updateMessageMock.mockClear();
    // Deferred sessionReply: tests control when the card POST resolves,
    // simulating in-flight async POSTs.
    sessionReplyDeferred = {} as any;
    sessionReplyDeferred.promise = new Promise(resolve => {
      sessionReplyDeferred.resolve = resolve;
    });
    sessionReplyMock = vi.fn(() => sessionReplyDeferred.promise);
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
  });

  it('registers card with daemon nonce after stuck_warning POST resolves', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);

    fakeWorker.emit('message', {
      type: 'stuck_warning',
      elapsedMs: 15000,
      snapshot: '...',
      matchedPattern: 'hook review level 1',
      turnId: 'turn_1',
      cliLifetime: 1,
    });
    await flush();

    // sessionReply (card POST) was called
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    // Nonce allocated before POST
    expect(ds.stuckWarningNonce).toBe(1);
    expect(ds.stuckWarningNonceCounter).toBe(1);

    // Resolve the POST
    sessionReplyDeferred.resolve('om_card_1');
    await flush();

    // Card registered as active
    expect(ds.stuckWarningCardId).toBe('om_card_1');
  });

  it('old POST race: prompt_ready clears authority before POST resolves → card NOT registered', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);

    // Emit stuck_warning — POST goes in flight
    fakeWorker.emit('message', {
      type: 'stuck_warning',
      elapsedMs: 15000,
      snapshot: '...',
      matchedPattern: 'hook review level 1',
      turnId: 'turn_1',
      cliLifetime: 1,
    });
    await flush();
    expect(ds.stuckWarningNonce).toBe(1);

    // CLI recovers (prompt_ready) while POST is still in flight → clears authority
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(ds.stuckWarningNonce).toBeUndefined();
    expect(ds.stuckWarningCardId).toBeUndefined();

    // Late POST resolves — must NOT register the card
    sessionReplyDeferred.resolve('om_card_late');
    await flush();
    expect(ds.stuckWarningCardId).toBeUndefined();
    expect(ds.stuckWarningNonce).toBeUndefined();
  });

  it('tui_keys_delivered with matching nonce resolves card and clears authority', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);

    fakeWorker.emit('message', {
      type: 'stuck_warning',
      elapsedMs: 15000,
      snapshot: '...',
      matchedPattern: 'hook review level 1',
      turnId: 'turn_1',
      cliLifetime: 1,
    });
    await flush();
    sessionReplyDeferred.resolve('om_card_1');
    await flush();
    expect(ds.stuckWarningCardId).toBe('om_card_1');

    // Worker confirms keys delivered
    fakeWorker.emit('message', {
      type: 'tui_keys_delivered',
      nonce: 1,
      turnId: 'turn_1',
    });
    await flush();

    // Card resolved (PATCH called) and authority cleared
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(ds.stuckWarningCardId).toBeUndefined();
    expect(ds.stuckWarningNonce).toBeUndefined();
    // Counter preserved
    expect(ds.stuckWarningNonceCounter).toBe(1);
  });

  it('stuck_warning_expired with matching nonce resolves card and clears authority', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);

    fakeWorker.emit('message', {
      type: 'stuck_warning',
      elapsedMs: 15000,
      snapshot: '...',
      matchedPattern: 'hook review level 1',
      turnId: 'turn_1',
      cliLifetime: 1,
    });
    await flush();
    sessionReplyDeferred.resolve('om_card_1');
    await flush();

    // Worker says page changed (expired)
    fakeWorker.emit('message', {
      type: 'stuck_warning_expired',
      nonce: 1,
      turnId: 'turn_1',
    });
    await flush();

    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(ds.stuckWarningCardId).toBeUndefined();
    expect(ds.stuckWarningNonce).toBeUndefined();
  });

  it('backend delivery failure renders a failure state and clears stuck-card authority', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);

    fakeWorker.emit('message', {
      type: 'stuck_warning',
      elapsedMs: 15000,
      snapshot: '...',
      matchedPattern: 'hook review level 1',
      turnId: 'turn_1',
      cliLifetime: 1,
    });
    await flush();
    sessionReplyDeferred.resolve('om_card_1');
    await flush();

    fakeWorker.emit('message', {
      type: 'tui_prompt_submit_failed',
      stuckNonce: 1,
      turnId: 'turn_1',
    });
    await flush();

    expect(updateMessageMock).toHaveBeenCalledWith(
      'app_test',
      'om_card_1',
      expect.stringContaining('"type":"failed"'),
    );
    expect(ds.stuckWarningCardId).toBeUndefined();
    expect(ds.stuckWarningNonce).toBeUndefined();
  });

  it('normal TUI cards resolve only from a matching worker ACK', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    ds.tuiPromptCardId = 'om_tui_card';
    ds.tuiPromptProcessing = true;
    ds.tuiPromptOptions = [
      { text: 'Approve', selected: false, type: 'select', keys: ['Enter'] },
    ];

    fakeWorker.emit('message', {
      type: 'tui_prompt_resolved',
      cardMessageId: 'om_old_card',
      selectedText: 'stale',
    });
    await flush();
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(ds.tuiPromptCardId).toBe('om_tui_card');
    expect(ds.tuiPromptProcessing).toBe(true);

    fakeWorker.emit('message', {
      type: 'tui_prompt_resolved',
      cardMessageId: 'om_tui_card',
      selectedText: 'Approve',
    });
    await flush();
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(ds.tuiPromptCardId).toBeUndefined();
    expect(ds.tuiPromptProcessing).toBe(false);
  });

  it('normal TUI backend failure renders failed instead of selected', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    ds.tuiPromptCardId = 'om_tui_card';
    ds.tuiPromptProcessing = true;
    ds.tuiPromptOptions = [
      { text: 'Approve', selected: false, type: 'select', keys: ['Enter'] },
    ];
    sessionReplyDeferred.resolve('om_failure_notice');

    fakeWorker.emit('message', {
      type: 'tui_prompt_submit_failed',
      cardMessageId: 'om_tui_card',
    });
    await flush();

    expect(updateMessageMock).toHaveBeenCalledWith(
      'app_test',
      'om_tui_card',
      expect.stringContaining('"type":"failed"'),
    );
    expect(ds.tuiPromptCardId).toBeUndefined();
    expect(ds.tuiPromptProcessing).toBe(false);
  });

  it('stale worker generation cannot resolve the replacement TUI card', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    ds.tuiPromptCardId = 'om_replacement_card';
    ds.tuiPromptProcessing = true;
    ds.tuiPromptOptions = [
      { text: 'Keep', selected: false, type: 'select', keys: ['Enter'] },
    ];
    ds.tuiPromptMultiSelect = true;
    ds.tuiToggledIndices = [0];

    const replacementGeneration = (ds.workerGeneration ?? 0) + 1;
    ds.workerGeneration = replacementGeneration;
    ds.session.workerGeneration = replacementGeneration;

    fakeWorker.emit('message', {
      type: 'tui_prompt_resolved',
      cardMessageId: 'om_replacement_card',
      selectedText: 'stale worker',
    });
    await flush();

    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(ds.tuiPromptCardId).toBe('om_replacement_card');
    expect(ds.tuiPromptProcessing).toBe(true);
    expect(ds.tuiPromptOptions).toHaveLength(1);
    expect(ds.tuiPromptMultiSelect).toBe(true);
    expect(ds.tuiToggledIndices).toEqual([0]);
  });

  it('worker exit fails the active TUI card and clears its full dedupe state', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker });
    __testOnly_setupWorkerHandlers(
      ds,
      fakeWorker,
      { ready: true, failureNotified: false },
    );
    ds.tuiPromptCardId = 'om_tui_card';
    ds.tuiPromptProcessing = true;
    ds.tuiPromptOptions = [
      { text: 'Approve', selected: false, type: 'select', keys: ['Enter'] },
    ];
    ds.tuiPromptMultiSelect = true;
    ds.tuiToggledIndices = [0];

    fakeWorker.emit('exit', 1, null);
    await flush();

    expect(updateMessageMock).toHaveBeenCalledWith(
      'app_test',
      'om_tui_card',
      expect.stringContaining('"type":"failed"'),
    );
    expect(ds.tuiPromptCardId).toBeUndefined();
    expect(ds.tuiPromptOptions).toBeUndefined();
    expect(ds.tuiPromptMultiSelect).toBeUndefined();
    expect(ds.tuiToggledIndices).toBeUndefined();
    expect(ds.tuiPromptProcessing).toBe(false);
  });

  it('prompt_ready resolves an active TUI card after the CLI actually recovers', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    ds.tuiPromptCardId = 'om_tui_card';
    ds.tuiPromptProcessing = true;
    ds.tuiPromptOptions = [
      { text: 'Approve', selected: false, type: 'select', keys: ['Enter'] },
    ];
    ds.tuiPromptMultiSelect = false;
    ds.tuiToggledIndices = [];

    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();

    expect(updateMessageMock).toHaveBeenCalledWith(
      'app_test',
      'om_tui_card',
      expect.stringContaining('"type":"resolved"'),
    );
    expect(ds.tuiPromptCardId).toBeUndefined();
    expect(ds.tuiPromptOptions).toBeUndefined();
    expect(ds.tuiPromptMultiSelect).toBeUndefined();
    expect(ds.tuiToggledIndices).toBeUndefined();
    expect(ds.tuiPromptProcessing).toBe(false);
  });

  it('generation reservation fails stale TUI authority before replacement setup can throw', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    ds.tuiPromptCardId = 'om_tui_card';
    ds.tuiPromptProcessing = true;
    ds.tuiPromptOptions = [
      { text: 'Approve', selected: false, type: 'select', keys: ['Enter'] },
    ];
    ds.tuiPromptMultiSelect = false;
    ds.tuiToggledIndices = [];

    __testOnly_reserveWorkerGeneration(ds);
    await flush();

    expect(updateMessageMock).toHaveBeenCalledWith(
      'app_test',
      'om_tui_card',
      expect.stringContaining('"type":"failed"'),
    );
    expect(ds.tuiPromptCardId).toBeUndefined();
    expect(ds.tuiPromptOptions).toBeUndefined();
    expect(ds.tuiPromptMultiSelect).toBeUndefined();
    expect(ds.tuiToggledIndices).toBeUndefined();
    expect(ds.tuiPromptProcessing).toBe(false);
  });

  it('old ACK (nonce=1) after new warning (nonce=2) does not affect new authority', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);

    // Warning 1: nonce=1, card posted
    fakeWorker.emit('message', {
      type: 'stuck_warning',
      elapsedMs: 15000,
      snapshot: '...',
      matchedPattern: 'hook review level 1',
      turnId: 'turn_1',
      cliLifetime: 1,
    });
    await flush();
    sessionReplyDeferred.resolve('om_card_1');
    await flush();
    expect(ds.stuckWarningNonce).toBe(1);

    // CLI recovers, authority clears (counter preserved at 1)
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(ds.stuckWarningNonce).toBeUndefined();
    expect(ds.stuckWarningNonceCounter).toBe(1);

    // Warning 2: nonce=2 (counter incremented, NOT reused from 1)
    // Need a new deferred for the second POST
    const deferred2 = {} as any;
    deferred2.promise = new Promise(resolve => { deferred2.resolve = resolve; });
    sessionReplyMock.mockImplementationOnce(() => deferred2.promise);

    fakeWorker.emit('message', {
      type: 'stuck_warning',
      elapsedMs: 15000,
      snapshot: '...',
      matchedPattern: 'hook review level 2',
      turnId: 'turn_2',
      cliLifetime: 1,
    });
    await flush();
    expect(ds.stuckWarningNonce).toBe(2);
    expect(ds.stuckWarningNonceCounter).toBe(2);

    deferred2.resolve('om_card_2');
    await flush();
    expect(ds.stuckWarningCardId).toBe('om_card_2');

    // Old ACK (nonce=1) arrives — must NOT clear the new card (nonce=2)
    updateMessageMock.mockClear();
    fakeWorker.emit('message', {
      type: 'tui_keys_delivered',
      nonce: 1,
      turnId: 'turn_1',
    });
    await flush();

    // No PATCH, new card still active
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(ds.stuckWarningCardId).toBe('om_card_2');
    expect(ds.stuckWarningNonce).toBe(2);
  });

  it('delivered and expired each only PATCH once (no double resolve)', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);

    fakeWorker.emit('message', {
      type: 'stuck_warning',
      elapsedMs: 15000,
      snapshot: '...',
      matchedPattern: 'hook review level 1',
      turnId: 'turn_1',
      cliLifetime: 1,
    });
    await flush();
    sessionReplyDeferred.resolve('om_card_1');
    await flush();

    // Send delivered twice — only first should PATCH
    fakeWorker.emit('message', { type: 'tui_keys_delivered', nonce: 1 });
    await flush();
    fakeWorker.emit('message', { type: 'tui_keys_delivered', nonce: 1 });
    await flush();

    expect(updateMessageMock).toHaveBeenCalledTimes(1);
  });

  it('nonce is monotonic across multiple warnings (counter never resets)', async () => {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);

    const nonces: number[] = [];

    // Warning 1
    const d1 = {} as any;
    d1.promise = new Promise(r => { d1.resolve = r; });
    sessionReplyMock.mockImplementationOnce(() => d1.promise);
    fakeWorker.emit('message', { type: 'stuck_warning', elapsedMs: 15000, snapshot: '...', matchedPattern: 'hook review level 1', turnId: 't1', cliLifetime: 1 });
    await flush();
    nonces.push(ds.stuckWarningNonce!);
    d1.resolve('om_1');
    await flush();

    // Clear (simulate recovery)
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();

    // Warning 2
    const d2 = {} as any;
    d2.promise = new Promise(r => { d2.resolve = r; });
    sessionReplyMock.mockImplementationOnce(() => d2.promise);
    fakeWorker.emit('message', { type: 'stuck_warning', elapsedMs: 15000, snapshot: '...', matchedPattern: 'hook review level 1', turnId: 't2', cliLifetime: 1 });
    await flush();
    nonces.push(ds.stuckWarningNonce!);
    d2.resolve('om_2');
    await flush();

    // Clear again
    fakeWorker.emit('message', { type: 'prompt_ready' });
    await flush();

    // Warning 3
    const d3 = {} as any;
    d3.promise = new Promise(r => { d3.resolve = r; });
    sessionReplyMock.mockImplementationOnce(() => d3.promise);
    fakeWorker.emit('message', { type: 'stuck_warning', elapsedMs: 15000, snapshot: '...', matchedPattern: 'hook review level 1', turnId: 't3', cliLifetime: 1 });
    await flush();
    nonces.push(ds.stuckWarningNonce!);

    // Nonces must be strictly increasing: 1, 2, 3 (never reuse)
    expect(nonces).toEqual([1, 2, 3]);
    expect(ds.stuckWarningNonceCounter).toBe(3);
  });
});

describe('stuck-page card content and result reporting (integration)', () => {
  let sessionReplyMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    updateMessageMock.mockClear();
    sessionReplyMock = vi.fn(async () => 'om_card_1');
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
  });

  function setup(overrides?: Partial<DaemonSession>) {
    const fakeWorker = makeFakeWorker();
    const ds = makeDs({ worker: fakeWorker, ...overrides });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);
    return { ds, fakeWorker };
  }

  /** The object the card builder mock received for the posted card. */
  function postedCard(call = 0): Record<string, any> {
    return JSON.parse(sessionReplyMock.mock.calls[call][1] as string);
  }

  it('posts the keyed card for the classified page with notice, screen tail and nonce', async () => {
    const { ds, fakeWorker } = setup();
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 4000, snapshot: '', matchedPattern: 'hook review startup',
      turnId: 'turn_1', cliLifetime: 3, reason: 'input_held',
      screenTail: 'Hooks need review\nPress enter to confirm or esc to go back', noticeText: 'held message',
    });
    await flush();

    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(sessionReplyMock.mock.calls[0][2]).toBe('interactive');
    const card = postedCard();
    expect(card).toMatchObject({
      type: 'stuck_page',
      pageType: 'hook review startup',
      nonce: 1,
      noticeText: 'held message',
      screenTail: 'Hooks need review\nPress enter to confirm or esc to go back',
    });
    // A held message did not stall a written turn: no "unfinished after Ns".
    expect(card.stalledSecs).toBeUndefined();
    expect(ds.stuckWarningPageType).toBe('hook review startup');
    expect(ds.stuckWarningCardId).toBe('om_card_1');
  });

  it('a stalled turn (no reason) reports how long it stalled', async () => {
    const { fakeWorker } = setup();
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 15_400, snapshot: '', matchedPattern: 'hook review level 1', turnId: 'turn_1', cliLifetime: 1,
    });
    await flush();
    expect(postedCard().stalledSecs).toBe(15);
  });

  it('freezes the initiator from the active turn caller of the same turn', async () => {
    const { ds, fakeWorker } = setup({
      activeInteractiveTurn: {
        turnId: 'turn_1',
        caller: { requestUserOpenId: 'ou_alice', requestLarkAppId: 'app_test', senderType: 'user' },
      },
    });
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 15000, snapshot: '', matchedPattern: 'hook review level 1', turnId: 'turn_1', cliLifetime: 1,
    });
    await flush();
    expect(ds.stuckWarningInitiatorOpenId).toBe('ou_alice');
    expect(postedCard().hasInitiator).toBe(true);
    // The in-memory caller going away later does not change who may press.
    ds.activeInteractiveTurn = undefined;
    expect(ds.stuckWarningInitiatorOpenId).toBe('ou_alice');
  });

  it('falls back to the turn reply registry only when it proves a human sender', async () => {
    const { ds, fakeWorker } = setup({
      activeInteractiveTurn: {
        turnId: 'other_turn',
        caller: { requestUserOpenId: 'ou_mallory', requestLarkAppId: 'app_test', senderType: 'user' },
      },
    });
    ds.session.replyTargets = {
      turn_1: { senderOpenId: 'ou_bob', participants: [{ openId: 'ou_bob', isBot: false }] } as any,
    };
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 15000, snapshot: '', matchedPattern: 'hook review level 1', turnId: 'turn_1', cliLifetime: 1,
    });
    await flush();
    expect(ds.stuckWarningInitiatorOpenId).toBe('ou_bob');
  });

  it('a bot or foreign-app caller, or a warning without turn id, freezes no initiator', async () => {
    for (const caller of [
      { requestUserOpenId: 'ou_bot_peer', requestLarkAppId: 'app_test', senderType: 'bot' as const },
      { requestUserOpenId: 'ou_other_app', requestLarkAppId: 'app_other', senderType: 'user' as const },
    ]) {
      sessionReplyMock.mockClear();
      const { ds, fakeWorker } = setup({ activeInteractiveTurn: { turnId: 'turn_1', caller } });
      fakeWorker.emit('message', {
        type: 'stuck_warning', elapsedMs: 15000, snapshot: '', matchedPattern: 'hook review level 1', turnId: 'turn_1', cliLifetime: 1,
      });
      await flush();
      expect(ds.stuckWarningCardId).toBe('om_card_1');
      expect(ds.stuckWarningInitiatorOpenId).toBeUndefined();
      expect(postedCard().hasInitiator).toBe(false);
    }
    sessionReplyMock.mockClear();
    const { ds, fakeWorker } = setup({
      activeInteractiveTurn: {
        turnId: 'turn_1',
        caller: { requestUserOpenId: 'ou_alice', requestLarkAppId: 'app_test', senderType: 'user' },
      },
    });
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 15000, snapshot: '', matchedPattern: 'hook review level 1', cliLifetime: 1,
    });
    await flush();
    expect(ds.stuckWarningCardId).toBe('om_card_1');
    expect(ds.stuckWarningInitiatorOpenId).toBeUndefined();
  });

  it('an unrecognised page posts the screen text without keys and registers no key authority', async () => {
    const { ds, fakeWorker } = setup();
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 0, snapshot: '', matchedPattern: 'something new', turnId: 'turn_1',
      cliLifetime: 1, reason: 'submit_unconfirmed', screenTail: 'Some menu', noticeText: 'not submitted',
    });
    await flush();
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(postedCard()).toMatchObject({ type: 'stuck_page', screenTail: 'Some menu', noticeText: 'not submitted' });
    expect(postedCard().pageType).toBeUndefined();
    expect(ds.stuckWarningNonce).toBeUndefined();
    expect(ds.stuckWarningNonceCounter).toBeUndefined();
    expect(ds.stuckWarningCardId).toBeUndefined();
    expect(ds.stuckWarningPageType).toBeUndefined();
  });

  it('an unrecognised page with nothing to show posts nothing', async () => {
    const { ds, fakeWorker } = setup();
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 15000, snapshot: '', turnId: 'turn_1', cliLifetime: 1,
    });
    await flush();
    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(ds.stuckWarningNonce).toBeUndefined();
  });

  async function postKeyedCard() {
    const ctx = setup();
    ctx.fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 15000, snapshot: '', matchedPattern: 'hook review level 1', turnId: 'turn_1', cliLifetime: 1,
    });
    await flush();
    expect(ctx.ds.stuckWarningCardId).toBe('om_card_1');
    return ctx;
  }

  function patchedCard(): Record<string, any> {
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    const [, cardId, json] = updateMessageMock.mock.calls[0] as unknown as [string, string, string];
    expect(cardId).toBe('om_card_1');
    return JSON.parse(json);
  }

  it('delivered + still on a blocking page: reports the key, the page and the new screen', async () => {
    const { ds, fakeWorker } = await postKeyedCard();
    const ack = {
      type: 'tui_keys_delivered', nonce: 1, key: 'Enter',
      afterPageType: 'hook review level 2', afterScreenTail: 'PreToolUse hooks', afterObserved: true,
    } as const;
    fakeWorker.emit('message', ack);
    await flush();
    expect(patchedCard()).toEqual({
      type: 'stuck_result',
      text: stuckKeyResultText(ack, localeForBot('app_test')),
      tail: 'PreToolUse hooks',
      stillBlocked: true,
    });
    expect(ds.stuckWarningCardId).toBeUndefined();
    expect(ds.stuckWarningInitiatorOpenId).toBeUndefined();
  });

  it('delivered + left the page: reports success with the new screen', async () => {
    const { fakeWorker } = await postKeyedCard();
    const ack = { type: 'tui_keys_delivered', nonce: 1, key: 'Escape', afterScreenTail: '› ', afterObserved: true } as const;
    fakeWorker.emit('message', ack);
    await flush();
    expect(patchedCard()).toEqual({
      type: 'stuck_result',
      text: stuckKeyResultText(ack, localeForBot('app_test')),
      tail: '› ',
      stillBlocked: false,
    });
  });

  it('delivered but the post-key screen could not be read: says so and shows no screen', async () => {
    const { fakeWorker } = await postKeyedCard();
    const ack = { type: 'tui_keys_delivered', nonce: 1, key: 'Escape', afterObserved: false, afterScreenTail: 'stale' } as const;
    fakeWorker.emit('message', ack);
    await flush();
    const card = patchedCard();
    expect(card.text).toBe(stuckKeyResultText(ack, localeForBot('app_test')));
    expect(card.tail).toBeUndefined();
  });

  it('an older worker ACK without key keeps the generic resolved card', async () => {
    const { fakeWorker } = await postKeyedCard();
    fakeWorker.emit('message', { type: 'tui_keys_delivered', nonce: 1 });
    await flush();
    expect(patchedCard()).toEqual({ type: 'resolved', text: tr('card.action.tui_done', undefined, localeForBot('app_test')) });
  });

  it('expired renders the localised "page changed, no key sent" state', async () => {
    const { ds, fakeWorker } = await postKeyedCard();
    fakeWorker.emit('message', { type: 'stuck_warning_expired', nonce: 1 });
    await flush();
    expect(patchedCard()).toEqual({ type: 'resolved', text: tr('card.stuck.expired', undefined, localeForBot('app_test')) });
    expect(ds.stuckWarningNonce).toBeUndefined();
  });

  it('user_notify input_not_submitted with a screen tail is posted as a card', async () => {
    const { fakeWorker } = setup();
    fakeWorker.emit('message', {
      type: 'user_notify', message: 'not confirmed', kind: 'input_not_submitted', screenTail: 'Hooks need review', turnId: 'turn_1',
    });
    await flush();
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(sessionReplyMock.mock.calls[0][2]).toBe('interactive');
    expect(JSON.parse(sessionReplyMock.mock.calls[0][1] as string)).toEqual({
      type: 'input_not_submitted', message: 'not confirmed', tail: 'Hooks need review',
    });
  });

  it('a refused input_not_submitted card falls back to the plain-text notice', async () => {
    const { fakeWorker } = setup();
    sessionReplyMock.mockImplementationOnce(async () => { throw new Error('Request failed (code: 230028)'); });
    fakeWorker.emit('message', {
      type: 'user_notify', message: 'not confirmed', kind: 'input_not_submitted', screenTail: 'Hooks need review', turnId: 'turn_1',
    });
    await flush();
    expect(sessionReplyMock.mock.calls.map(c => c[2])).toEqual(['interactive', 'text']);
    expect(sessionReplyMock.mock.calls[1][1]).toBe('not confirmed');
  });

  it('a refused submit_unconfirmed stuck card still delivers its notice as text', async () => {
    const { ds, fakeWorker } = setup();
    sessionReplyMock.mockImplementationOnce(async () => { throw new Error('Request failed (code: 230028)'); });
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 0, snapshot: '', matchedPattern: 'hook review level 1',
      turnId: 'turn_1', cliLifetime: 1, reason: 'submit_unconfirmed', screenTail: 'Hooks', noticeText: 'not submitted',
    });
    await flush();
    expect(sessionReplyMock.mock.calls.map(c => c[2])).toEqual(['interactive', 'text']);
    expect(sessionReplyMock.mock.calls[1][1]).toBe('not submitted');
    expect(ds.stuckWarningNonce).toBeUndefined();
  });

  // ─── keyed card refused / in flight / global initiator switch ───────────

  /** What the worker-pool would send as text for this warning (same locale). */
  function expectedFallback(m: Parameters<typeof stuckCardFallbackText>[0], cliName: string): string {
    return stuckCardFallbackText(m, cliName, botLocale(getBot('app_test').config))!;
  }

  it.each([
    { reason: 'input_held' as const, matchedPattern: 'cli migration menu' },
    { reason: undefined, matchedPattern: 'hook review level 1' },
  ])('a refused keyed card ($reason) still tells the chat as plain text, without the screen', async (m) => {
    const { ds, fakeWorker } = setup();
    sessionReplyMock.mockImplementationOnce(async () => { throw new Error('Request failed (code: 230028)'); });
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 15000, snapshot: '', turnId: 'turn_1', cliLifetime: 1,
      screenTail: 'SECRET-SCREEN', ...m, ...(m.reason ? { reason: m.reason } : {}),
    });
    await flush();
    expect(sessionReplyMock.mock.calls.map(c => c[2])).toEqual(['interactive', 'text']);
    const text = sessionReplyMock.mock.calls[1][1] as string;
    expect(text).toBe(expectedFallback(m, postedCard().cliName));
    expect(text).not.toContain('SECRET-SCREEN');
    expect(ds.stuckWarningNonce).toBeUndefined();
  });

  it('a refused card for an unrecognised page still delivers the worker notice as text', async () => {
    const { fakeWorker } = setup();
    sessionReplyMock.mockImplementationOnce(async () => { throw new Error('Request failed (code: 230028)'); });
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 0, snapshot: '', matchedPattern: 'something new', turnId: 'turn_1',
      cliLifetime: 1, reason: 'submit_unconfirmed', screenTail: 'Some menu', noticeText: 'not submitted',
    });
    await flush();
    expect(sessionReplyMock.mock.calls.map(c => [c[2], c[2] === 'text' ? c[1] : undefined])).toEqual([
      ['interactive', undefined],
      ['text', 'not submitted'],
    ]);
  });

  it('a card POST that failed after the card was sent gets no duplicate text', async () => {
    const { fakeWorker } = setup();
    sessionReplyMock.mockImplementationOnce(async () => { throw new Error('principal-lane outbound lost turn ownership'); });
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 0, snapshot: '', matchedPattern: 'hook review level 1',
      turnId: 'turn_1', cliLifetime: 1, reason: 'submit_unconfirmed', screenTail: 'Hooks', noticeText: 'not submitted',
    });
    await flush();
    expect(sessionReplyMock.mock.calls.map(c => c[2])).toEqual(['interactive']);
  });

  it('a second warning for the same page while the first card POST is in flight posts no second card', async () => {
    let resolvePost!: (id: string) => void;
    sessionReplyMock.mockImplementationOnce(() => new Promise<string>(r => { resolvePost = r; }));
    const { ds, fakeWorker } = setup();
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 0, snapshot: '', matchedPattern: 'hook review startup',
      turnId: 'turn_1', cliLifetime: 1, reason: 'input_held',
    });
    await flush();
    // Another turn (and a warning without turn id) hit the same page meanwhile.
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 0, snapshot: '', matchedPattern: 'hook review startup',
      turnId: 'turn_2', cliLifetime: 1, reason: 'input_held',
    });
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 15000, snapshot: '', matchedPattern: 'hook review startup', cliLifetime: 1,
    });
    await flush();
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(ds.stuckWarningNonce).toBe(1);
    // An unconfirmed submit during the POST is still news: its notice goes out as text.
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 0, snapshot: '', matchedPattern: 'hook review startup',
      turnId: 'turn_3', cliLifetime: 1, reason: 'submit_unconfirmed', noticeText: 'not submitted',
    });
    await flush();
    expect(sessionReplyMock.mock.calls.slice(1).map(c => [c[1], c[2]])).toEqual([['not submitted', 'text']]);
    resolvePost('om_card_1');
    await flush();
    expect(ds.stuckWarningCardId).toBe('om_card_1');
    expect(ds.stuckWarningNonce).toBe(1);
  });

  it('a warning folded into an in-flight card that is then refused still gets its own text notice', async () => {
    let rejectPost!: (err: Error) => void;
    sessionReplyMock.mockImplementationOnce(() => new Promise<string>((_r, rej) => { rejectPost = rej; }));
    const { fakeWorker } = setup();
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 15000, snapshot: '', matchedPattern: 'hook review level 1',
      turnId: 'turn_1', cliLifetime: 1,
    });
    await flush();
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 0, snapshot: '', matchedPattern: 'hook review level 1',
      turnId: 'turn_2', cliLifetime: 1, reason: 'input_held',
    });
    await flush();
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    rejectPost(new Error('Request failed (code: 230028)'));
    await flush();
    // One text notice for the refused card itself (turn_stalled) and one for
    // the folded input_held warning — neither is lost.
    const texts = sessionReplyMock.mock.calls.slice(1);
    expect(texts.map(c => c[2])).toEqual(['text', 'text']);
    expect(new Set(texts.map(c => c[1] as string)).size).toBe(2);
  });

  it('once the in-flight card is gone, a later warning for the page posts again', async () => {
    sessionReplyMock.mockImplementationOnce(async () => { throw new Error('Request failed (code: 230028)'); });
    const { ds, fakeWorker } = setup();
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 15000, snapshot: '', matchedPattern: 'hook review level 1', turnId: 'turn_1', cliLifetime: 1,
    });
    await flush();
    fakeWorker.emit('message', {
      type: 'stuck_warning', elapsedMs: 15000, snapshot: '', matchedPattern: 'hook review level 1', turnId: 'turn_2', cliLifetime: 1,
    });
    await flush();
    expect(sessionReplyMock.mock.calls.map(c => c[2])).toEqual(['interactive', 'text', 'interactive']);
    expect(ds.stuckWarningCardId).toBe('om_card_1');
  });

  it('the who-may-press hint follows the global initiator switch at build time', async () => {
    try {
      (config as any).stuckCardInitiatorKeys = false;
      const off = setup();
      off.fakeWorker.emit('message', {
        type: 'stuck_warning', elapsedMs: 15000, snapshot: '', matchedPattern: 'hook review level 1', turnId: 'turn_1', cliLifetime: 1,
      });
      await flush();
      expect(postedCard(0).initiatorKeysEnabled).toBe(false);
      delete (config as any).stuckCardInitiatorKeys;
      const on = setup();
      on.fakeWorker.emit('message', {
        type: 'stuck_warning', elapsedMs: 15000, snapshot: '', matchedPattern: 'hook review level 1', turnId: 'turn_1', cliLifetime: 1,
      });
      await flush();
      expect(postedCard(1).initiatorKeysEnabled).toBe(true);
    } finally {
      delete (config as any).stuckCardInitiatorKeys;
    }
  });

  it('user_notify without a screen tail stays plain text', async () => {
    const { fakeWorker } = setup();
    fakeWorker.emit('message', { type: 'user_notify', message: 'not confirmed', kind: 'input_not_submitted', turnId: 'turn_1' });
    fakeWorker.emit('message', { type: 'user_notify', message: 'other notice', screenTail: 'ignored', turnId: 'turn_1' });
    await flush();
    expect(sessionReplyMock.mock.calls.map(c => [c[1], c[2]])).toEqual([
      ['not confirmed', 'text'],
      ['other notice', 'text'],
    ]);
  });
});
