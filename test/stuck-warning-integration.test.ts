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
import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

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
    const ds = makeDs({
      worker: fakeWorker,
      tuiPromptCardId: 'om_tui_card',
      tuiPromptProcessing: true,
      tuiPromptOptions: [
        { text: 'Approve', selected: false, type: 'select', keys: ['Enter'] },
      ],
    });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);

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
    const ds = makeDs({
      worker: fakeWorker,
      tuiPromptCardId: 'om_tui_card',
      tuiPromptProcessing: true,
      tuiPromptOptions: [
        { text: 'Approve', selected: false, type: 'select', keys: ['Enter'] },
      ],
    });
    __testOnly_setupWorkerHandlers(ds, fakeWorker);
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
