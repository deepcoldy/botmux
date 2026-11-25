/**
 * A streaming card leaves 「启动中/工作中」 on a worker `prompt_ready` /
 * `screen_update` edge. Some adapters finish a turn without ever publishing
 * prompt-ready, and once the screen stops moving no `screen_update` follows,
 * so the card used to stay 「工作中」 until the NEXT turn recalled it.
 *
 * `turn_terminal` already tells the daemon the turn is over. These tests drive
 * the REAL worker IPC handler (`__testOnly_setupWorkerHandlers`) and the real
 * periodic registry sweep to prove that edge now settles display state, while
 * live worker evidence (screen_update, a new turn, background work, usage
 * limits) still wins and no turn-reaction / ledger side effects are triggered.
 *
 * Run:  bun x vitest run test/post-terminal-status-settle.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  updateMessageMock,
  deleteMessageMock,
  loggerWarnMock,
  loggerInfoMock,
  loggerDebugMock,
  recordUsageMock,
} = vi.hoisted(() => ({
  updateMessageMock: vi.fn(async (..._args: any[]) => {}),
  deleteMessageMock: vi.fn(async (..._args: any[]) => true),
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  recordUsageMock: vi.fn(),
}));

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  class MessageUpdateExpiredError extends Error {
    constructor(id: string) { super(`expired: ${id}`); this.name = 'MessageUpdateExpiredError'; }
  }
  return {
    updateMessage: (...args: any[]) => updateMessageMock(...args),
    deleteMessage: (...args: any[]) => deleteMessageMock(...args),
    getMessageDetail: vi.fn(async () => ({})),
    addReaction: vi.fn(async () => 'reaction_id'),
    removeReaction: vi.fn(async () => {}),
    sendUserMessage: vi.fn(async () => {}),
    sendEphemeralCard: vi.fn(async () => 'om_eph'),
    getChatInfo: vi.fn(),
    MessageWithdrawnError,
    MessageUpdateExpiredError,
  };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn((...args: any[]) => JSON.stringify({ type: 'streaming', status: args[5] })),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Pi'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'pi' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => 'feishu'),
  normalizeUsageDisplay: vi.fn(() => 'off'),
  resolveUsageDisplay: vi.fn(() => 'off'),
  resolveBrandLabel: vi.fn(() => 'Feishu'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/post-terminal-settle-inert' },
    daemon: { backendType: 'pty', cliId: 'pi' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  getOwnedSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(() => []),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  persistStreamCardState: vi.fn(),
  ensureSessionWhiteboard: vi.fn(),
  rememberLastCliInput: vi.fn(),
  getSessionWorkingDir: vi.fn(() => '/tmp'),
}));

vi.mock('../src/services/usage-ledger.js', () => ({
  anchorUsageForDaemonSession: vi.fn(), recordOwnershipForDaemonSession: vi.fn(),
  recordUsageForDaemonSession: recordUsageMock, reconcileUsageForDaemonSession: vi.fn(),
}));
vi.mock('../src/core/dashboard-events.js', () => ({ dashboardEventBus: { publish: vi.fn() } }));
vi.mock('../src/core/dashboard-rows.js', () => ({ composeRowFromActive: vi.fn(() => ({ tokenUsage: undefined })) }));
vi.mock('../src/skills/installer.js', () => ({ ensureSkills: vi.fn() }));
vi.mock('../src/adapters/cli/registry.js', () => ({ createCliAdapterSync: vi.fn() }));
vi.mock('../src/services/local-cli-opener.js', () => ({
  isLocalCliOpenEnabled: vi.fn(() => false),
  isLocalCliOpenReady: vi.fn(() => false),
}));
vi.mock('../src/adapters/cli/claude-code.js', () => ({ claudeJsonlPathForSession: vi.fn() }));
vi.mock('../src/adapters/backend/tmux-backend.js', () => ({ TmuxBackend: class {} }));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: loggerInfoMock, warn: loggerWarnMock, debug: loggerDebugMock, error: vi.fn() },
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import { config } from '../src/config.js';
import { persistStreamCardState } from '../src/core/session-manager.js';
import {
  buildStreamingCardJson,
  cachedStreamingCardStatus,
  CARD_POSTING_SENTINEL,
  initWorkerPool,
  killWorker,
  postFreshStreamingCard,
  retireWorkerProcessOnly,
  scheduleActiveRuntimePatch,
  setActiveSessionsRegistry,
  sweepStaleLiveCardStatuses,
  scheduleCardPatch,
  noteTurnDispatchAttempt,
  syncUsageRefreshTimer,
  postTurnStartingCard,
  turnStartingCardStatus,
  unifiedReplyTurnNotCapturing,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import {
  STARTING_CARD_HEALTH_DELAY_MS,
  startingCardAcceptsHostTurn,
} from '../src/core/starting-card-health.js';
import { armTriggerStreamingCard } from '../src/core/trigger-streaming-card.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';

const APP = 'app_test';
const SESSION = 'sid-post-terminal-settle';
const TURN = 'turn-live-0001';
const CARD = 'om_card_live';

let dataDir: string;
let previousDataDir: string;

function makeFakeWorker() {
  const w = new EventEmitter() as any;
  w.killed = false;
  w.send = vi.fn(() => true);
  w.kill = vi.fn();
  w.pid = 12345;
  w.stdout = new EventEmitter();
  w.stderr = new EventEmitter();
  return w;
}

function makeDs(overrides?: Partial<DaemonSession>): DaemonSession {
  return {
    session: {
      sessionId: SESSION,
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'Test Session',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: 'pi',
    },
    worker: makeFakeWorker(),
    workerPort: 9999,
    workerToken: 'tok',
    larkAppId: APP,
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    displayMode: 'hidden',
    streamCardNonce: 'n1',
    currentTurnTitle: 'Test task',
    streamCardId: CARD,
    lastScreenStatus: 'working',
    currentTurnId: TURN,
    ...overrides,
  } as DaemonSession;
}

function activate(...sessions: DaemonSession[]): void {
  setActiveSessionsRegistry(new Map(sessions.map(ds => [activeSessionKey(ds), ds])));
}

type TerminalMsg = Extract<WorkerToDaemon, { type: 'turn_terminal' }>;

function terminalMsg(turnId: string, status: TerminalMsg['status'] = 'completed'): TerminalMsg {
  return { type: 'turn_terminal', sessionId: SESSION, turnId, status };
}

function lastPatchedStatus(): unknown {
  return JSON.parse(String(updateMessageMock.mock.calls.at(-1)?.[2])).status;
}

function idlePatchCount(): number {
  return updateMessageMock.mock.calls.filter(call => {
    try { return JSON.parse(String(call[2])).status === 'idle'; } catch { return false; }
  }).length;
}

function settleWarnings(): string[] {
  return loggerWarnMock.mock.calls
    .map(call => String(call[0]))
    .filter(line => line.includes('status settle') || line.includes('self-heal'));
}

beforeEach(() => {
  vi.useFakeTimers();
  dataDir = mkdtempSync(join(tmpdir(), 'post-terminal-settle-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  updateMessageMock.mockClear();
  updateMessageMock.mockResolvedValue(undefined);
  deleteMessageMock.mockClear();
  loggerWarnMock.mockClear();
  loggerInfoMock.mockClear();
  loggerDebugMock.mockClear();
  initWorkerPool({
    sessionReply: vi.fn(async () => 'om_new_card') as any,
    getSessionWorkingDir: () => '/tmp',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  } as any);
  setActiveSessionsRegistry(new Map());
});

afterEach(() => {
  setActiveSessionsRegistry(undefined as any);
  config.session.dataDir = previousDataDir;
  vi.useRealTimers();
  vi.clearAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('turn_terminal status settle (daemon turn_terminal handler)', () => {
  it('PATCHes a card still claiming work to idle once the terminal settles', async () => {
    const ds = makeDs();
    activate(ds);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg(TURN));
    // Armed, not yet applied: the fallback waits for a possible live frame.
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(idlePatchCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(updateMessageMock.mock.calls[0][1]).toBe(CARD);
    expect(lastPatchedStatus()).toBe('idle');
    expect(ds.lastScreenStatus).toBe('working');
    expect(ds.idleSinceAt).toBeUndefined();
    const warnings = settleWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('card was still working');
    expect(warnings[0]).toContain('source=prompt-ready-missing');
    expect(warnings[0]).toContain(TURN.substring(0, 8));
  });

  it('treats a busy frame inside the settle window as stale and still corrects the card', async () => {
    const ds = makeDs();
    activate(ds);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg(TURN));
    // A busy frame from the just-completed turn (no newer turn admitted) is
    // stale viewport evidence: it must not cancel the post-terminal correction.
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'still drawing', status: 'working', turnId: TURN,
    });

    await vi.advanceTimersByTimeAsync(2_000);

    // turn_terminal is the card-display authority: the fallback still fires
    // exactly once despite the stale busy frame.
    expect(idlePatchCount()).toBe(1);
    // The in-memory execution status is untouched (real idle edge still owns
    // usage settlement); only the card was corrected.
    expect(ds.lastScreenStatus).toBe('working');
  });

  it('does not settle a turn that is not the session current turn any more', async () => {
    const ds = makeDs();
    activate(ds);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg(TURN));
    // A new turn was admitted after the terminal: currentTurnId moved on.
    ds.currentTurnId = 'turn-live-0002';

    await vi.advanceTimersByTimeAsync(2_000);

    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(ds.lastScreenStatus).toBe('working');
  });

  it('does not settle while background tasks are still running', async () => {
    const ds = makeDs({ backgroundTaskCount: 2 });
    activate(ds);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(ds.lastScreenStatus).toBe('working');
  });

  it('does not settle a usage-limited turn (the limited card owns that state)', async () => {
    const ds = makeDs();
    ds.usageLimit = {
      limited: true,
      kind: 'usage',
      retryAtMs: Date.now() + 60_000,
      retryLabel: 'later',
      retryReady: false,
    };
    activate(ds);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(ds.lastScreenStatus).toBe('working');
  });

  it('ignores a non-completed terminal', async () => {
    const ds = makeDs();
    activate(ds);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg(TURN, 'failed'));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(ds.lastScreenStatus).toBe('working');
  });

  it('applies at most one corrective patch for duplicate terminals of the same turn', async () => {
    const ds = makeDs();
    activate(ds);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg(TURN));
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(idlePatchCount()).toBe(1);
    expect(settleWarnings()).toHaveLength(1);
  });

  it('retries a failed status PATCH on the periodic sweep without manufacturing idle', async () => {
    const ds = makeDs(); activate(ds); __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    updateMessageMock.mockRejectedValueOnce(new Error('503'));
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(ds.lastScreenStatus).toBe('working');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(idlePatchCount()).toBe(2);
    expect(ds.lastScreenStatus).toBe('working');
    expect(recordUsageMock).not.toHaveBeenCalled();
  });

  it('needs no repeat sweep patch: a stale busy frame cannot invalidate the delivered correction', async () => {
    const ds = makeDs(); activate(ds); __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(idlePatchCount()).toBe(1); // first correction delivered
    // The post-terminal busy frame no longer bumps the revision, so the
    // delivered receipt keeps matching and the self-heal sweep never repaints.
    (ds.worker as any).emit('message', { type: 'screen_update', content: 'stale busy footer', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(idlePatchCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(idlePatchCount()).toBe(1);
  });

  it('keeps the real delayed idle edge responsible for usage settlement', async () => {
    const ds = makeDs(); activate(ds); __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(recordUsageMock).not.toHaveBeenCalled();
    (ds.worker as any).emit('message', { type: 'screen_update', content: 'real composer', status: 'idle' });
    await vi.advanceTimersByTimeAsync(0);
    expect(recordUsageMock).toHaveBeenCalledTimes(1);
    expect(ds.lastScreenStatus).toBe('idle');
  });

  it('does not deliver an enqueued correction after a new retry takes ownership', async () => {
    const ds = makeDs(); activate(ds); __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    let finish!: () => void;
    updateMessageMock.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    scheduleCardPatch(ds, '{"status":"working"}');
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    // Correction queued behind the older PATCH; retry arrives before flush.
    noteTurnDispatchAttempt(ds, TURN, 2);
    updateMessageMock.mockImplementationOnce(async (...args) => { await args[3].beforeWrite(); });
    finish(); await vi.advanceTimersByTimeAsync(0);
    await expect(updateMessageMock.mock.results.at(-1)?.value).rejects.toThrow();
    expect(ds.lastScreenStatus).toBe('working');
  });

  it('does not let an old dispatch attempt terminal settle the running retry', async () => {
    const ds = makeDs({ turnDispatchAttemptHighWater: { turnId: TURN, dispatchAttempt: 2 } });
    activate(ds); __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', { ...terminalMsg(TURN), dispatchAttempt: 1 });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(ds.lastTurnTerminalAt).toBeUndefined();
  });

  it('cancels a pending completed correction when the same attempt is subsequently cancelled', async () => {
    const ds = makeDs(); activate(ds); __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(1_000);
    (ds.worker as any).emit('message', terminalMsg(TURN, 'cancelled'));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(idlePatchCount()).toBe(0);
  });

  it('a cancelled terminal also fences a correction already queued behind a long PATCH', async () => {
    const ds = makeDs(); activate(ds); __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    let finish!: () => void;
    updateMessageMock.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    scheduleCardPatch(ds, '{"status":"working"}');
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    (ds.worker as any).emit('message', terminalMsg(TURN, 'cancelled'));
    updateMessageMock.mockImplementationOnce(async (...args) => { await args[3].beforeWrite(); });
    finish(); await vi.advanceTimersByTimeAsync(0);
    await expect(updateMessageMock.mock.results.at(-1)?.value).rejects.toThrow();
  });

  it('a runtime-sweep correction loses write ownership if a cancellation arrives while queued', async () => {
    const ds = makeDs({ lastTurnTerminalAt: Date.now() - 121_000,
      lastTurnTerminalTurnId: TURN, lastTurnTerminalStatus: 'completed' });
    activate(ds); __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    let finish!: () => void;
    updateMessageMock.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    scheduleCardPatch(ds, '{"status":"working"}');
    expect(sweepStaleLiveCardStatuses(APP)).toBe(1);
    (ds.worker as any).emit('message', terminalMsg(TURN, 'cancelled'));
    updateMessageMock.mockImplementationOnce(async (...args) => { await args[3].beforeWrite(); });
    finish(); await vi.advanceTimersByTimeAsync(0);
    await expect(updateMessageMock.mock.results.at(-1)?.value).rejects.toThrow();
  });

  it('periodic usage refresh does not overwrite the acknowledged terminal display correction', async () => {
    const ds = makeDs({ workerReady: true });
    ds.session.cliId = 'claude-code';
    activate(ds); __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    // Streaming usage mode enables the native-usage timer before terminal.
    const { resolveUsageDisplay } = await import('../src/bot-registry.js');
    vi.mocked(resolveUsageDisplay).mockReturnValue('streaming');
    syncUsageRefreshTimer(ds);
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(lastPatchedStatus()).toBe('idle');
    expect(ds.lastScreenStatus).toBe('working');
    vi.mocked(resolveUsageDisplay).mockReturnValue('off');
  });

  it('does not paint failed terminals as idle on a later sweep', async () => {
    const ds = makeDs(); activate(ds); __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', terminalMsg(TURN, 'failed'));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(idlePatchCount()).toBe(0);
  });
});

describe('sweepStaleLiveCardStatuses (runtime self-heal)', () => {
  it('heals a card still working long after its terminal and records the marker', () => {
    const ds = makeDs({
      worker: null,
      currentTurnId: undefined,
      lastScreenStatus: 'working',
      lastTurnTerminalAt: Date.now() - 121_000,
      lastTurnTerminalTurnId: TURN,
      lastTurnTerminalStatus: 'completed',
    });
    activate(ds);

    expect(sweepStaleLiveCardStatuses(APP)).toBe(1);

    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    expect(updateMessageMock.mock.calls[0][1]).toBe(CARD);
    expect(lastPatchedStatus()).toBe('idle');
    expect(ds.lastScreenStatus).toBe('working');
    expect(settleWarnings().some(line => line.includes('runtime stale-card self-heal'))).toBe(true);

    const marker = join(dataDir, 'card-sweeps', `${APP}.stale-working-runtime-v1`);
    expect(existsSync(marker)).toBe(true);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ healed: 1, at: expect.any(String) });
  });

  it.each([
    ['a live turn is running', (ds: DaemonSession) => { ds.currentTurnId = 'turn-live-0002'; }],
    ['background work is outstanding', (ds: DaemonSession) => { ds.backgroundTaskCount = 1; }],
    ['the session is usage-limited', (ds: DaemonSession) => {
      ds.usageLimit = { limited: true, kind: 'usage', retryAtMs: Date.now() + 60_000, retryLabel: 'later', retryReady: false };
    }],
    ['the terminal is still fresh', (ds: DaemonSession) => {
      ds.lastTurnTerminalAt = Date.now() - 5_000;
    }],
    ['the card is not busy', (ds: DaemonSession) => { ds.lastScreenStatus = 'idle'; }],
    ['there is no real card', (ds: DaemonSession) => { ds.streamCardId = undefined; }],
    ['the session is closed', (ds: DaemonSession) => { ds.session.status = 'closed'; }],
    ['recovery cards are suppressed', (ds: DaemonSession) => { ds.suppressRecoveryCard = true; }],
  ])('leaves the card alone when %s', (_label, mutate) => {
    const ds = makeDs({ worker: null, currentTurnId: undefined });
    ds.lastScreenStatus = 'working';
    ds.lastTurnTerminalAt = Date.now() - 121_000;
    ds.lastTurnTerminalTurnId = TURN;
    ds.lastTurnTerminalStatus = 'completed';
    mutate(ds);
    activate(ds);

    expect(sweepStaleLiveCardStatuses(APP)).toBe(0);
    expect(updateMessageMock).not.toHaveBeenCalled();
  });

  it('only scans sessions of the requested bot', () => {
    const other = makeDs({
      larkAppId: 'app_other',
      worker: null,
      currentTurnId: undefined,
      lastScreenStatus: 'working',
      lastTurnTerminalAt: Date.now() - 121_000,
      lastTurnTerminalTurnId: TURN,
    }, );
    (other.session as any).sessionId = 'sid-other';
    (other.session as any).rootMessageId = 'om_root_other';
    activate(other);

    expect(sweepStaleLiveCardStatuses(APP)).toBe(0);
    expect(updateMessageMock).not.toHaveBeenCalled();
  });
});

describe('stale post-terminal busy frame gate (screen_update)', () => {
  function setupTerminalDs(overrides?: Partial<DaemonSession>) {
    const ds = makeDs(overrides);
    activate(ds);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    return ds;
  }
  // A residual frame from the terminalized turn: the worker tags normal
  // screen_update frames with the current turn id (only direct-submit frames
  // are untagged), so a stale frame carries the SAME turn id as the terminal.
  function staleTaggedFrame(ds: DaemonSession, extra: Record<string, unknown> = {}) {
    return (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'stale busy', status: 'working', turnId: TURN, ...extra,
    });
  }
  // Web Terminal / sandbox direct-submit: worker publishes with clearTurnId
  // AND the explicit directSubmit provenance marker — real new work.
  function directSubmitFrame(ds: DaemonSession) {
    return (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'direct work', status: 'working', directSubmit: true,
    });
  }
  // Prompt-cache keep-alive also clears the turn id but carries NO directSubmit
  // marker: it belongs to no turn and must never flip a settled card.
  function keepaliveFrame(ds: DaemonSession) {
    return (ds.worker as any).emit('message', { type: 'screen_update', content: 'keepalive', status: 'working' });
  }

  it('does not bump revision or patch the card for a stale tagged busy frame, but keeps non-card state', async () => {
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000); // settle idle PATCH queued
    const revAfterSettle = ds.streamCardStatusRevision ?? 0;
    const callsAfterSettle = updateMessageMock.mock.calls.length;

    staleTaggedFrame(ds);
    await vi.advanceTimersByTimeAsync(0);

    expect(ds.streamCardStatusRevision ?? 0).toBe(revAfterSettle);
    expect(updateMessageMock.mock.calls.length).toBe(callsAfterSettle);
    // Non-card execution state is still refreshed.
    expect(ds.lastScreenContent).toBe('stale busy');
    expect(ds.lastScreenStatus).toBe('working');
  });

  it('still bumps revision on a real idle frame after the terminal', async () => {
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    const rev = ds.streamCardStatusRevision ?? 0;

    (ds.worker as any).emit('message', { type: 'screen_update', content: 'composer', status: 'idle', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);

    expect(ds.streamCardStatusRevision ?? 0).toBe(rev + 1);
    expect(ds.lastScreenStatus).toBe('idle');
  });

  it('resumes card driving (revision bump) once a new turn starts', async () => {
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    const rev = ds.streamCardStatusRevision ?? 0;

    ds.currentTurnId = 'turn-live-0002'; // beginNewTurn: newer turn admitted
    staleTaggedFrame(ds, { turnId: 'turn-live-0002', content: 'new turn work' });
    await vi.advanceTimersByTimeAsync(0);

    expect(ds.streamCardStatusRevision ?? 0).toBe(rev + 1);
  });

  it('does not gate busy frames after a failed terminal', async () => {
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', terminalMsg(TURN, 'failed'));
    await vi.advanceTimersByTimeAsync(0);
    const rev = ds.streamCardStatusRevision ?? 0;

    staleTaggedFrame(ds);
    await vi.advanceTimersByTimeAsync(0);

    expect(ds.streamCardStatusRevision ?? 0).toBe(rev + 1);
  });

  it('keeps the idle correction deliverable when stale busy frames race an in-flight PATCH (real beforeWrite fence)', async () => {
    let releaseFirst!: () => void;
    updateMessageMock.mockImplementation((...args: any[]) => {
      const opts = args[3];
      const run = async () => { if (opts && typeof opts.beforeWrite === 'function') await opts.beforeWrite(); };
      if (!releaseFirst) return new Promise<void>(resolve => { releaseFirst = resolve; }).then(run);
      return run();
    });
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000); // settle idle PATCH held in flight

    for (let i = 0; i < 3; i++) {
      staleTaggedFrame(ds, {}, );
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(ds.streamCardStatusRevision ?? 0).toBe(0); // stale frames never bumped it

    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);

    expect(lastPatchedStatus()).toBe('idle'); // fence passed, correction delivered
  });

  it('P1: a direct-submit busy frame is live work, bumps revision and repaints the card', async () => {
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(lastPatchedStatus()).toBe('idle'); // display-only correction delivered
    const rev = ds.streamCardStatusRevision ?? 0;

    directSubmitFrame(ds); // explicit provenance: real new work, no managed turn
    await vi.advanceTimersByTimeAsync(0);

    expect(ds.streamCardStatusRevision ?? 0).toBe(rev + 1);
    expect(ds.lastScreenStatus).toBe('working');
    // The visible card must come back to working, not stay on the idle correction.
    expect(lastPatchedStatus()).toBe('working');
  });

  it('P1 keepalive: an untagged busy frame WITHOUT directSubmit does not reopen the card', async () => {
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(lastPatchedStatus()).toBe('idle');
    const rev = ds.streamCardStatusRevision ?? 0;
    const calls = updateMessageMock.mock.calls.length;

    keepaliveFrame(ds); // same untagged shape as keepalive, no directSubmit marker
    await vi.advanceTimersByTimeAsync(0);

    expect(ds.streamCardStatusRevision ?? 0).toBe(rev); // no revision bump
    expect(updateMessageMock.mock.calls.length).toBe(calls); // no card repaint
    expect(lastPatchedStatus()).toBe('idle'); // card stays on the correction
  });

  it('P3: a newer dispatch attempt of the same terminalized turn is live work and repaints the card', async () => {
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', { ...terminalMsg(TURN), dispatchAttempt: 1 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(lastPatchedStatus()).toBe('idle');
    expect(ds.lastTurnTerminalDispatchAttempt).toBe(1);
    const rev = ds.streamCardStatusRevision ?? 0;

    // The turn is retried: a fresh attempt is admitted and starts working.
    noteTurnDispatchAttempt(ds, TURN, 2);
    staleTaggedFrame(ds, { dispatchAttempt: 2 });
    await vi.advanceTimersByTimeAsync(0);

    expect(ds.streamCardStatusRevision ?? 0).toBe(rev + 1);
    expect(lastPatchedStatus()).toBe('working');
  });

  it('forces only one busy repaint: subsequent same-value working ticks do not re-patch', async () => {
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);

    directSubmitFrame(ds); // first live busy frame after correction: forced repaint
    await vi.advanceTimersByTimeAsync(0);
    const patchesAfterFirstRepaint = updateMessageMock.mock.calls.length;
    expect(lastPatchedStatus()).toBe('working');

    // More working→working frames with no status edge must not repaint again.
    directSubmitFrame(ds);
    directSubmitFrame(ds);
    await vi.advanceTimersByTimeAsync(0);
    expect(updateMessageMock.mock.calls.length).toBe(patchesAfterFirstRepaint);
  });

  it('P2: a stale tagged screenshot_uploaded frame neither bumps revision nor touches the card image', async () => {
    const ds = setupTerminalDs({ displayMode: 'screenshot' });
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    const rev = ds.streamCardStatusRevision ?? 0;
    const calls = updateMessageMock.mock.calls.length;

    (ds.worker as any).emit('message', {
      type: 'screenshot_uploaded', imageKey: 'img-stale', status: 'working', turnId: TURN,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(ds.streamCardStatusRevision ?? 0).toBe(rev);
    expect(ds.currentImageKey).not.toBe('img-stale');
    expect(updateMessageMock.mock.calls.length).toBe(calls);
    // Non-card execution state still moves.
    expect(ds.lastScreenStatus).toBe('working');
  });

  it('P2 keepalive: an untagged screenshot_uploaded frame is gated like a keep-alive', async () => {
    const ds = setupTerminalDs({ displayMode: 'screenshot' });
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    const rev = ds.streamCardStatusRevision ?? 0;
    const calls = updateMessageMock.mock.calls.length;

    // Untagged (cleared capture identity) without a newer turn = keep-alive.
    (ds.worker as any).emit('message', {
      type: 'screenshot_uploaded', imageKey: 'img-keepalive', status: 'working',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(ds.streamCardStatusRevision ?? 0).toBe(rev);
    expect(ds.currentImageKey).not.toBe('img-keepalive');
    expect(updateMessageMock.mock.calls.length).toBe(calls);
  });

  it('P2 control: a newer-turn screenshot_uploaded live-work frame is not gated', async () => {
    const ds = setupTerminalDs({ displayMode: 'screenshot' });
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    const rev = ds.streamCardStatusRevision ?? 0;

    // A newer managed turn owns this screenshot, so it is genuine live work.
    ds.currentTurnId = 'turn-live-0002';
    (ds.worker as any).emit('message', {
      type: 'screenshot_uploaded', imageKey: 'img-direct', status: 'working', turnId: 'turn-live-0002',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(ds.streamCardStatusRevision ?? 0).toBe(rev + 1);
    expect(ds.currentImageKey).toBe('img-direct');
  });

  it('P2 sweep: a direct-submit episode prevents the self-heal from re-idling the card', async () => {
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    // Direct-submit opens a live-work epoch after the terminal.
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'direct', status: 'working', directSubmit: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.postTerminalLiveWorkAt).not.toBeUndefined();
    // Backdate the terminal past the 120s sweep age while keeping the epoch open.
    ds.lastTurnTerminalAt = Date.now() - 121_000;

    // The self-heal must not idle-correct a card held by a live-work episode.
    expect(sweepStaleLiveCardStatuses(APP)).toBe(0);
    expect(updateMessageMock.mock.calls.filter((c: any[]) => {
      try { return JSON.parse(String(c[2])).status === 'idle'; } catch { return false; }
    })).toHaveLength(1); // only the original 2s correction, no sweep re-idle
  });

  it('P3 handoff: live work arriving while the idle PATCH is in flight repaints once it settles', async () => {
    let releaseFirst!: () => void;
    updateMessageMock.mockImplementation((...args: any[]) => {
      const opts = args[3];
      const run = async () => { if (opts && typeof opts.beforeWrite === 'function') await opts.beforeWrite(); };
      if (!releaseFirst) return new Promise<void>(resolve => { releaseFirst = resolve; }).then(run);
      return run();
    });
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000); // idle correction PATCH held in flight (receipt pending)

    // Direct-submit live work lands BEFORE the idle response returns.
    directSubmitFrame(ds);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchedStatus()).toBe('idle'); // idle not yet settled, still showing idle

    releaseFirst();
    await vi.advanceTimersByTimeAsync(0); // settle callback honors the repaint request

    expect(lastPatchedStatus()).toBe('working'); // handoff applied after settle
  });

  it('R4-P1: a local-* completed terminal clears the direct-submit live-work epoch', async () => {
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    directSubmitFrame(ds);
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.postTerminalLiveWorkAt).not.toBeUndefined();

    // The Web Terminal typed turn completes with a local-* id; currentTurnId
    // still points at the IM turn, so the managed gate would skip it.
    (ds.worker as any).emit('message', {
      type: 'turn_terminal', sessionId: SESSION, turnId: 'local-typed-abc', status: 'completed',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(ds.postTerminalLiveWorkAt).toBeUndefined();
    // With the epoch closed, a later stale busy frame is gated again (self-heal live).
    keepaliveFrame(ds);
    await vi.advanceTimersByTimeAsync(0);
    const rev = ds.streamCardStatusRevision ?? 0;
    keepaliveFrame(ds);
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.streamCardStatusRevision ?? 0).toBe(rev);
  });

  it('R4-P2: a newer-turn working frame opens liveness before beginNewTurn, so sweep does not idle it', async () => {
    const ds = setupTerminalDs(); // currentTurnId stays TURN (no beginNewTurn yet)
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    ds.lastTurnTerminalAt = Date.now() - 121_000; // past the sweep age

    // First frame of a newer turn arrives while currentTurnId still equals TURN.
    staleTaggedFrame(ds, { turnId: 'turn-live-0002', content: 'new turn first frame' });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.postTerminalLiveWorkAt).not.toBeUndefined();

    // The self-heal must recognize the open episode and not idle-correct it.
    expect(sweepStaleLiveCardStatuses(APP)).toBe(0);
  });

  it('R4-P3: follow-up screenshots inherit the open direct-submit episode despite an old capture tag', async () => {
    const ds = setupTerminalDs({ displayMode: 'screenshot' });
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    directSubmitFrame(ds); // opens the live-work episode
    await vi.advanceTimersByTimeAsync(0);
    const rev = ds.streamCardStatusRevision ?? 0;

    // A later screenshot still carries the old terminalized turn/attempt tag.
    (ds.worker as any).emit('message', {
      type: 'screenshot_uploaded', imageKey: 'img-episode', status: 'working',
      turnId: TURN,
    });
    await vi.advanceTimersByTimeAsync(0);

    // It belongs to the open episode, so it is not treated as stale residue.
    expect(ds.streamCardStatusRevision ?? 0).toBe(rev + 1);
    expect(ds.currentImageKey).toBe('img-episode');
  });

  it('R5: a real idle frame closes the episode so a later keepalive cannot re-open the card', async () => {
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    directSubmitFrame(ds); // opens the live-work episode
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.postTerminalLiveWorkAt).not.toBeUndefined();

    // The direct-submit work ends with a real idle frame (no local terminal).
    (ds.worker as any).emit('message', { type: 'screen_update', content: 'composer', status: 'idle' });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.postTerminalLiveWorkAt).toBeUndefined(); // episode closed

    // A keepalive busy frame must now be treated as stale, not episode continuation.
    const rev = ds.streamCardStatusRevision ?? 0;
    const calls = updateMessageMock.mock.calls.length;
    keepaliveFrame(ds);
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.streamCardStatusRevision ?? 0).toBe(rev);
    expect(updateMessageMock.mock.calls.length).toBe(calls);
    expect(lastPatchedStatus()).not.toBe('working');
  });

  it('R5: a local-* failed/cancelled terminal closes the episode even without a completed one', async () => {
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    directSubmitFrame(ds);
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.postTerminalLiveWorkAt).not.toBeUndefined();

    // Local failure: the worker suppresses the failure terminal to a notice, but
    // when it does arrive (any non-completed status) the epoch must still close.
    (ds.worker as any).emit('message', {
      type: 'turn_terminal', sessionId: SESSION, turnId: 'local-typed-fail', status: 'failed',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.postTerminalLiveWorkAt).toBeUndefined();

    // Self-heal is live again: a residual busy frame is gated.
    const rev = ds.streamCardStatusRevision ?? 0;
    keepaliveFrame(ds);
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.streamCardStatusRevision ?? 0).toBe(rev);
  });

  it('R6: direct_submit_started opens the episode with no prompt_ready, then a normal working frame repaints', async () => {
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(lastPatchedStatus()).toBe('idle'); // correction delivered
    const revAfterIdle = ds.streamCardStatusRevision ?? 0;

    // Stuck-after-terminal: prompt_ready never fires. The hook still signals a
    // real direct-submit, but no working screen frame accompanies it yet.
    (ds.worker as any).emit('message', { type: 'direct_submit_started' });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.postTerminalLiveWorkAt).not.toBeUndefined(); // episode opened without a frame

    // The PTY stream later produces an ordinary working frame (still tagged with
    // the old terminalized turn, no directSubmit marker). The open episode must
    // let it through and repaint the card back to working.
    staleTaggedFrame(ds, { content: 'late working from pty' });
    await vi.advanceTimersByTimeAsync(0);

    expect(ds.streamCardStatusRevision ?? 0).toBe(revAfterIdle + 1);
    expect(lastPatchedStatus()).toBe('working');
  });

  it('R6: direct_submit_started is a no-op outside a completed terminal', async () => {
    const ds = setupTerminalDs();
    // No terminal yet: the signal must not open a spurious epoch.
    (ds.worker as any).emit('message', { type: 'direct_submit_started' });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.postTerminalLiveWorkAt).toBeUndefined();
  });

  it('R6: a stale-generation direct_submit_started is ignored', async () => {
    const ds = setupTerminalDs();
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    // The handler closure is bound to the original worker/generation; advance
    // only the session's recorded generation so the bound worker is now stale.
    const originalWorker = ds.worker;
    ds.workerGeneration = (ds.workerGeneration ?? 0) + 1;
    ds.session.workerGeneration = ds.workerGeneration;

    (originalWorker as any).emit('message', { type: 'direct_submit_started' });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.postTerminalLiveWorkAt).toBeUndefined();
  });
});

describe('starting card health watchdog', () => {
  function setupStartingDs(turnId = TURN) {
    const ds = makeDs({
      streamCardPending: true,
      streamCardPendingTurnId: turnId,
      streamCardTurnGeneration: 1,
      currentTurnId: turnId,
      workerGeneration: 1,
    });
    activate(ds);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    return ds;
  }
  async function post(ds: DaemonSession, turnId: string) {
    expect(await postTurnStartingCard(ds, vi.fn(async () => `om_start_${turnId}`), turnId)).toBe(true);
    updateMessageMock.mockClear();
  }
  function patchedStatuses(): unknown[] {
    return updateMessageMock.mock.calls.map(call => {
      try { return JSON.parse(String(call[2])).status; } catch { return undefined; }
    });
  }

  it('degrades a turn still stuck at starting after 45s without changing execution status', async () => {
    const ds = setupStartingDs();
    await post(ds, TURN);
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
    expect(ds.lastScreenStatus).toBe('working');
  });

  it('does not treat a same-value starting frame as healthy progress', async () => {
    const ds = setupStartingDs();
    await post(ds, TURN);
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'still starting', status: 'starting', turnId: TURN,
    });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
  });

  it('cancels the degradation on a real working frame from the same turn', async () => {
    const ds = setupStartingDs();
    await post(ds, TURN);
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'running', status: 'working', turnId: TURN,
    });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual([]);
  });

  it('does not let prompt_ready hide a stuck capture pipeline', async () => {
    const ds = setupStartingDs();
    await post(ds, TURN);
    (ds.worker as any).emit('message', { type: 'prompt_ready', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
  });

  it('does not let another turn prove health for the armed turn', async () => {
    const ds = setupStartingDs();
    await post(ds, TURN);
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'other turn output', status: 'working', turnId: 'turn-other',
    });
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
    expect(updateMessageMock.mock.calls[0][1]).toBe(`om_start_${TURN}`);
  });

  it('does not let an old timer patch a newer turn card', async () => {
    const ds = setupStartingDs();
    await post(ds, TURN);
    ds.currentTurnId = 'turn-live-0002';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'turn-live-0002';
    ds.streamCardTurnGeneration = 2;
    await post(ds, 'turn-live-0002');
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);

    expect(patchedStatuses()).toEqual(['stalled']);
    expect(updateMessageMock.mock.calls[0][1]).toBe('om_start_turn-live-0002');
    expect(ds.lastScreenStatus).toBe('working');
  });

  it('does not degrade after the worker generation changes', async () => {
    const ds = setupStartingDs();
    await post(ds, TURN);
    ds.workerGeneration = 3;
    ds.session.workerGeneration = 3;
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual([]);
  });

  it('retries a transient health PATCH failure with the same identity', async () => {
    const ds = setupStartingDs();
    updateMessageMock.mockImplementationOnce(async () => { throw new Error('transient PATCH failure'); });
    await post(ds, TURN);
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(updateMessageMock).toHaveBeenCalledTimes(2);
    expect(lastPatchedStatus()).toBe('stalled');
    expect(ds.lastScreenStatus).toBe('working');
  });

  it('rejects a stale stalled write and repaints working when health arrives in flight', async () => {
    const delivered: string[] = [];
    let releaseFirst!: () => void;
    updateMessageMock.mockImplementation((...args: any[]) => {
      const opts = args[3];
      const status = JSON.parse(String(args[2])).status;
      const run = async () => {
        if (opts?.beforeWrite) await opts.beforeWrite();
        delivered.push(status);
      };
      if (!releaseFirst) return new Promise<void>(resolve => { releaseFirst = resolve; }).then(run);
      return run();
    });
    const ds = setupStartingDs();
    await post(ds, TURN);
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);

    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'running', status: 'working', turnId: TURN,
    });
    await vi.advanceTimersByTimeAsync(0);
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);

    expect(delivered).toEqual(['working']);
  });

  it('activates a queued watchdog when capture first supplies a numeric attempt', async () => {
    const queuedTurn = 'turn-live-0002';
    const ds = setupStartingDs(queuedTurn);
    ds.captureIdentity = {
      workerGeneration: ds.workerGeneration!, revision: 1, turnId: TURN, dispatchAttempt: 4,
    };
    noteTurnDispatchAttempt(ds, TURN, 4);
    await post(ds, queuedTurn);

    (ds.worker as any).emit('message', {
      type: 'capture_identity', revision: 2, turnId: queuedTurn, dispatchAttempt: 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.turnDispatchAttemptHighWater).toEqual({ turnId: queuedTurn, dispatchAttempt: 0 });
    updateMessageMock.mockClear();

    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
  });

  it('does not adopt a different attempt when a queued retry activates', async () => {
    const queuedTurn = 'turn-live-0002';
    const ds = setupStartingDs(queuedTurn);
    ds.captureIdentity = { workerGeneration: ds.workerGeneration!, revision: 1, turnId: TURN };
    noteTurnDispatchAttempt(ds, queuedTurn, 0);
    await post(ds, queuedTurn);

    (ds.worker as any).emit('message', {
      type: 'capture_identity', revision: 2, turnId: queuedTurn, dispatchAttempt: 1,
    });
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).not.toContain('stalled');
  });

  it('defers a queued turn watchdog until its capture identity activates', async () => {
    const queuedTurn = 'turn-live-0002';
    const ds = setupStartingDs(queuedTurn);
    ds.captureIdentity = { workerGeneration: ds.workerGeneration!, revision: 1, turnId: TURN };
    expect(unifiedReplyTurnNotCapturing(ds, queuedTurn)).toBe(true);
    await post(ds, queuedTurn);
    expect(unifiedReplyTurnNotCapturing(ds, queuedTurn)).toBe(true);

    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'predecessor still running', status: 'working', turnId: TURN,
    });
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual([]);

    (ds.worker as any).emit('message', { type: 'capture_identity', revision: 2, turnId: queuedTurn });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchedStatus()).toBe('working');
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS - 1);
    expect(patchedStatuses()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(patchedStatuses()).toEqual(['stalled']);
  });

  it('does not let unattributed evidence disarm a queued turn watchdog', async () => {
    const queuedTurn = 'turn-live-0002';
    const ds = setupStartingDs(queuedTurn);
    ds.captureIdentity = { workerGeneration: ds.workerGeneration!, revision: 1, turnId: TURN };
    expect(unifiedReplyTurnNotCapturing(ds, queuedTurn)).toBe(true);
    await post(ds, queuedTurn);
    (ds.worker as any).emit('message', { type: 'screen_update', content: 'legacy predecessor', status: 'working' });
    (ds.worker as any).emit('message', { type: 'prompt_ready' });
    (ds.worker as any).emit('message', { type: 'capture_identity', revision: 2, turnId: queuedTurn });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();

    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
  });

  it('does not degrade after a working frame arrived during the starting POST', async () => {
    const ds = setupStartingDs();
    let resolvePost!: (messageId: string) => void;
    const posting = postTurnStartingCard(ds, vi.fn(() => new Promise<string>(resolve => { resolvePost = resolve; })), TURN);
    await vi.advanceTimersByTimeAsync(0);
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'running before POST lands', status: 'working', turnId: TURN,
    });
    await vi.advanceTimersByTimeAsync(1);
    resolvePost('om_start_slow');
    await posting;
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchedStatus()).toBe('working');
    updateMessageMock.mockClear();

    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual([]);
  });

  it('keeps stalled through usage and routine renders until healthy evidence arrives', async () => {
    const ds = setupStartingDs();
    ds.workerReady = true;
    ds.session.cliId = 'claude-code';
    const { resolveUsageDisplay } = await import('../src/bot-registry.js');
    vi.mocked(resolveUsageDisplay).mockReturnValue('streaming');
    try {
      await post(ds, TURN);
      await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
      expect(lastPatchedStatus()).toBe('stalled');
      expect(ds.usageRefreshTimer).toBeUndefined();
      updateMessageMock.mockClear();

      // Keep streaming enabled through this tick: the old implementation would
      // now redraw working, while the degraded gate must suppress the refresh.
      await vi.advanceTimersByTimeAsync(12_000);
      expect(patchedStatuses()).toEqual([]);
      scheduleCardPatch(ds, JSON.stringify({ status: 'working' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(lastPatchedStatus()).toBe('stalled');
    } finally {
      vi.mocked(resolveUsageDisplay).mockReturnValue('off');
    }
  });

  it('repaints a delivered stalled card on the first same-value working frame', async () => {
    const ds = setupStartingDs();
    await post(ds, TURN);
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
    updateMessageMock.mockClear();

    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'recovered', status: 'working', turnId: TURN,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['working']);
  });

  it('closes health for an attempt-less compatibility terminal with a numeric high-water', async () => {
    const ds = setupStartingDs();
    noteTurnDispatchAttempt(ds, TURN, 1);
    await post(ds, TURN);
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).not.toContain('stalled');
  });

  it('does not re-arm health for an attempt-less terminal that arrived during the starting POST', async () => {
    const ds = setupStartingDs();
    noteTurnDispatchAttempt(ds, TURN, 1);
    let resolvePost!: (messageId: string) => void;
    const posting = postTurnStartingCard(ds, vi.fn(() => new Promise<string>(resolve => { resolvePost = resolve; })), TURN);
    await vi.advanceTimersByTimeAsync(0);

    (ds.worker as any).emit('message', terminalMsg(TURN));
    resolvePost('om_start_slow_legacy_terminal');
    await posting;
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);

    expect(patchedStatuses()).not.toContain('stalled');
    expect(lastPatchedStatus()).toBe('idle');
  });

  it('does not let an older-attempt terminal close the active retry watchdog', async () => {
    const ds = setupStartingDs();
    noteTurnDispatchAttempt(ds, TURN, 2);
    await post(ds, TURN);
    (ds.worker as any).emit('message', { ...terminalMsg(TURN), dispatchAttempt: 1 });
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
  });

  it('arms health monitoring for a starting card published by worker ready', async () => {
    const ds = setupStartingDs();
    ds.streamCardId = undefined;
    ds.lastScreenStatus = undefined;
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.streamCardId).toBe('om_new_card');
    updateMessageMock.mockClear();

    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
  });

  it('arms health monitoring when worker ready restores a starting card', async () => {
    const ds = setupStartingDs();
    ds.streamCardPending = false;
    ds.streamCardPendingTurnId = undefined;
    ds.lastScreenStatus = undefined;
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok' });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchedStatus()).toBe('starting');
    updateMessageMock.mockClear();

    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
  });

  it('arms restored health when the first numeric attempt arrives during the starting PATCH', async () => {
    let releaseRestore!: () => void;
    updateMessageMock.mockImplementationOnce(() => new Promise<void>(resolve => { releaseRestore = resolve; }));
    const ds = setupStartingDs();
    ds.streamCardPending = false;
    ds.streamCardPendingTurnId = undefined;
    ds.lastScreenStatus = undefined;
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);

    (ds.worker as any).emit('message', {
      type: 'capture_identity', revision: 1, turnId: TURN, dispatchAttempt: 0,
    });
    releaseRestore();
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();

    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
  });

  it('does not arm restored health when a known attempt advances during the starting PATCH', async () => {
    let releaseRestore!: () => void;
    updateMessageMock.mockImplementationOnce(() => new Promise<void>(resolve => { releaseRestore = resolve; }));
    const ds = setupStartingDs();
    ds.streamCardPending = false;
    ds.streamCardPendingTurnId = undefined;
    ds.lastScreenStatus = undefined;
    noteTurnDispatchAttempt(ds, TURN, 0);
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);

    (ds.worker as any).emit('message', {
      type: 'capture_identity', revision: 1, turnId: TURN, dispatchAttempt: 1,
    });
    releaseRestore();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).not.toContain('stalled');
  });

  it.each([
    ['completed', 'idle'],
    ['failed', 'idle'],
    ['cancelled', 'interrupted'],
    ['ambiguous', 'idle'],
  ] as const)('settles restored ready publication after a %s terminal without re-arming', async (terminalStatus, expectedStatus) => {
    let releaseRestore!: () => void;
    updateMessageMock.mockImplementationOnce(() => new Promise<void>(resolve => { releaseRestore = resolve; }));
    const ds = setupStartingDs();
    ds.streamCardPending = false;
    ds.streamCardPendingTurnId = undefined;
    ds.lastScreenStatus = undefined;
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok' });
    await vi.advanceTimersByTimeAsync(0);
    expect(updateMessageMock).toHaveBeenCalledTimes(1);

    (ds.worker as any).emit('message', terminalMsg(TURN, terminalStatus));
    await vi.advanceTimersByTimeAsync(0);
    releaseRestore();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);

    expect(patchedStatuses()).not.toContain('stalled');
    expect(lastPatchedStatus()).toBe(expectedStatus);
    if (terminalStatus === 'failed' || terminalStatus === 'ambiguous') {
      expect(ds.failedIdleTurnId).toBe(TURN);
    }
  });

  it.each([
    { label: 'missing high-water', highWater: undefined, expected: 'idle' },
    { label: 'matching high-water', highWater: 1, expected: 'idle' },
    { label: 'newer high-water', highWater: 2, expected: 'stalled' },
  ])('accepts restored terminal attempt identity: $label', async ({ highWater, expected }) => {
    let releaseRestore!: () => void;
    updateMessageMock.mockImplementationOnce(() => new Promise<void>(resolve => { releaseRestore = resolve; }));
    const ds = setupStartingDs();
    ds.streamCardPending = false;
    ds.streamCardPendingTurnId = undefined;
    ds.lastScreenStatus = undefined;
    if (highWater !== undefined) noteTurnDispatchAttempt(ds, TURN, highWater);
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok' });
    await vi.advanceTimersByTimeAsync(0);

    (ds.worker as any).emit('message', { ...terminalMsg(TURN), dispatchAttempt: 1 });
    await vi.advanceTimersByTimeAsync(0);
    releaseRestore();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);

    expect(lastPatchedStatus()).toBe(expected);
  });

  it('reasserts idle when a late completed starting publication follows cached idle', async () => {
    const ds = setupStartingDs();
    ds.lastScreenStatus = 'idle';
    let resolvePost!: (messageId: string) => void;
    const posting = postTurnStartingCard(ds, vi.fn(() => new Promise<string>(resolve => { resolvePost = resolve; })), TURN);
    await vi.advanceTimersByTimeAsync(0);

    (ds.worker as any).emit('message', terminalMsg(TURN));
    resolvePost('om_start_slow_cached_idle');
    await posting;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(patchedStatuses()).toContain('idle');
  });

  it('reasserts idle after a restored starting PATCH completes behind terminal and an idle frame', async () => {
    const delivered: string[] = [];
    let releaseRestore!: () => void;
    updateMessageMock.mockImplementation((...args: any[]) => {
      const status = JSON.parse(String(args[2])).status;
      if (!releaseRestore) {
        return new Promise<void>(resolve => {
          releaseRestore = () => { delivered.push(status); resolve(); };
        });
      }
      return Promise.resolve().then(() => { delivered.push(status); });
    });
    const ds = setupStartingDs();
    ds.streamCardPending = false;
    ds.streamCardPendingTurnId = undefined;
    ds.lastScreenStatus = undefined;
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok' });
    await vi.advanceTimersByTimeAsync(0);

    (ds.worker as any).emit('message', terminalMsg(TURN));
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'idle after terminal', status: 'idle', turnId: TURN,
    });
    await vi.advanceTimersByTimeAsync(0);
    releaseRestore();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);

    expect(delivered.at(-1)).toBe('idle');
  });

  it('reconciles a working frame that landed before the restored starting PATCH completed', async () => {
    const delivered: string[] = [];
    let releaseRestore!: () => void;
    updateMessageMock.mockImplementation((...args: any[]) => {
      const status = JSON.parse(String(args[2])).status;
      if (!releaseRestore) {
        return new Promise<void>(resolve => {
          releaseRestore = () => { delivered.push(status); resolve(); };
        });
      }
      return Promise.resolve().then(() => { delivered.push(status); });
    });
    const ds = setupStartingDs();
    ds.streamCardPending = false;
    ds.streamCardPendingTurnId = undefined;
    ds.lastScreenStatus = undefined;
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok' });
    await vi.advanceTimersByTimeAsync(0);

    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'working during restore', status: 'working', turnId: TURN,
    });
    await vi.advanceTimersByTimeAsync(0);
    releaseRestore();
    await vi.advanceTimersByTimeAsync(0);

    expect(delivered.at(-1)).toBe('working');
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(delivered.at(-1)).toBe('working');
  });

  it('lets an adopted CLI exit replace stalled with the explicit idle freeze', async () => {
    const ds = setupStartingDs();
    ds.adoptedFrom = {} as any;
    await post(ds, TURN);
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(lastPatchedStatus()).toBe('stalled');
    updateMessageMock.mockClear();

    (ds.worker as any).emit('message', { type: 'claude_exit', code: 0, signal: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchedStatus()).toBe('idle');
  });

  it('lets a permanent CLI exit replace stalled with the explicit idle freeze', async () => {
    const ds = setupStartingDs();
    ds.session.cliId = 'claude-code';
    ds.workerReady = true;
    await post(ds, TURN);
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(lastPatchedStatus()).toBe('stalled');
    updateMessageMock.mockClear();

    (ds.worker as any).emit('message', { type: 'claude_exit', code: 127, signal: null, canParkDiagnostic: false });
    await vi.advanceTimersByTimeAsync(0);
    ds.workerReady = true;
    (ds.worker as any).emit('message', { type: 'claude_exit', code: 127, signal: null, canParkDiagnostic: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchedStatus()).toBe('idle');
  });

  it.each(['working', 'limited'] as const)('repaints a stalled card once on a hidden screenshot (%s)', async status => {
    const ds = setupStartingDs();
    ds.displayMode = 'screenshot';
    await post(ds, TURN);
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(lastPatchedStatus()).toBe('stalled');
    ds.displayMode = 'hidden';
    updateMessageMock.mockClear();

    const frame = {
      type: 'screenshot_uploaded', imageKey: 'img-recovered', status, turnId: TURN,
      usageLimit: status === 'limited' ? {
        limited: true, kind: 'usage', retryAtMs: Date.now() + 3_600_000, retryLabel: '1h', retryReady: false,
      } : undefined,
    };
    (ds.worker as any).emit('message', frame);
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual([status]);
    (ds.worker as any).emit('message', frame);
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual([status]);
  });

  it('restores the authorized usage refresh when a screenshot proves health', async () => {
    const ds = setupStartingDs();
    ds.displayMode = 'screenshot';
    ds.workerReady = true;
    ds.session.cliId = 'claude-code';
    const { resolveUsageDisplay } = await import('../src/bot-registry.js');
    vi.mocked(resolveUsageDisplay).mockReturnValue('streaming');
    try {
      await post(ds, TURN);
      await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
      expect(ds.usageRefreshTimer).toBeUndefined();
      updateMessageMock.mockClear();

      (ds.worker as any).emit('message', {
        type: 'screenshot_uploaded', imageKey: 'img-usage-recovered', status: 'working', turnId: TURN,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(lastPatchedStatus()).toBe('working');
      expect(ds.usageRefreshTimer).toBeDefined();
    } finally {
      vi.mocked(resolveUsageDisplay).mockReturnValue('off');
    }
  });

  it('cancels degradation on a working screenshot from the same turn', async () => {
    const ds = setupStartingDs();
    await post(ds, TURN);
    (ds.worker as any).emit('message', {
      type: 'screenshot_uploaded', imageKey: 'img-healthy', status: 'working', turnId: TURN,
    });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();

    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual([]);
  });

  it('does not replace a cold-suspended idle card with a delivered stalled state', async () => {
    const ds = setupStartingDs();
    await post(ds, TURN);
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(lastPatchedStatus()).toBe('stalled');

    ds.lastScreenStatus = 'idle';
    ds.session.suspendedColdResume = true;
    ds.worker = null;
    scheduleCardPatch(ds, JSON.stringify({ type: 'streaming', status: 'idle' }), TURN);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchedStatus()).toBe('idle');
  });

  it('settles a completed terminal that arrives while a fresh-ready POST is pending', async () => {
    let resolvePost!: (messageId: string) => void;
    initWorkerPool({
      sessionReply: vi.fn(() => new Promise<string>(resolve => { resolvePost = resolve; })),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
    const ds = setupStartingDs();
    ds.streamCardId = undefined;
    ds.lastScreenStatus = 'idle';
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);

    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(0);
    resolvePost('om_start_pending_completed');
    await vi.advanceTimersByTimeAsync(47_000);
    expect(patchedStatuses()).toContain('idle');
  });

  it('does not re-arm a terminalized starting publication when new live work rejects the idle correction', async () => {
    let resolvePost!: (messageId: string) => void;
    initWorkerPool({
      sessionReply: vi.fn(() => new Promise<string>(resolve => { resolvePost = resolve; })),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
    const ds = setupStartingDs();
    ds.streamCardId = undefined;
    ds.lastScreenStatus = 'idle';
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);

    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(0);
    // Direct user work after the terminal is still live work, so the correction
    // is rejected. It must not cause the old publication to re-arm its watchdog.
    (ds.worker as any).emit('message', { type: 'direct_submit_started' });
    await vi.advanceTimersByTimeAsync(0);
    resolvePost('om_start_pending_completed_with_live_work');
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).not.toContain('stalled');
  });

  it('rejects the restored starting write after a second same-turn attempt transition', async () => {
    let releaseRestore!: () => void;
    let beforeWrite!: () => Promise<void>;
    updateMessageMock.mockImplementationOnce((...args: any[]) => {
      beforeWrite = args[3].beforeWrite;
      return new Promise<void>(resolve => { releaseRestore = resolve; });
    });
    const ds = setupStartingDs();
    ds.streamCardPending = false;
    ds.streamCardPendingTurnId = undefined;
    ds.lastScreenStatus = undefined;
    noteTurnDispatchAttempt(ds, 'turn-previous', 7);
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok' });
    await vi.advanceTimersByTimeAsync(0);

    (ds.worker as any).emit('message', {
      type: 'capture_identity', revision: 1, turnId: TURN, dispatchAttempt: 0,
    });
    releaseRestore();
    await vi.advanceTimersByTimeAsync(0);
    (ds.worker as any).emit('message', {
      type: 'capture_identity', revision: 2, turnId: TURN, dispatchAttempt: 1,
    });
    await expect(async () => { await beforeWrite(); }).rejects.toThrow();
  });

  it('rejects restored starting when attempts advance twice before write admission', async () => {
    let beforeWrite!: () => Promise<void>;
    let releaseRestore!: () => void;
    updateMessageMock.mockImplementationOnce((...args: any[]) => {
      beforeWrite = args[3].beforeWrite;
      return new Promise<void>(resolve => { releaseRestore = resolve; });
    });
    const ds = setupStartingDs();
    ds.streamCardPending = false;
    ds.streamCardPendingTurnId = undefined;
    ds.lastScreenStatus = undefined;
    noteTurnDispatchAttempt(ds, 'turn-previous', 7);
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok' });
    await vi.advanceTimersByTimeAsync(0);

    (ds.worker as any).emit('message', {
      type: 'capture_identity', revision: 1, turnId: TURN, dispatchAttempt: 0,
    });
    (ds.worker as any).emit('message', {
      type: 'capture_identity', revision: 2, turnId: TURN, dispatchAttempt: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect(async () => { await beforeWrite(); }).rejects.toThrow('Restored card no longer owns delivery');
    releaseRestore();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('corrects a late restored starting write after the original idle settle delivered', async () => {
    const delivered: string[] = [];
    let releaseRestore!: () => void;
    updateMessageMock.mockImplementation((...args: any[]) => {
      const status = JSON.parse(String(args[2])).status;
      const opts = args[3];
      if (!releaseRestore) {
        return new Promise<void>(resolve => {
          releaseRestore = () => { delivered.push(status); resolve(); };
        });
      }
      return Promise.resolve().then(async () => {
        if (opts?.beforeWrite) await opts.beforeWrite();
        delivered.push(status);
      });
    });
    const ds = setupStartingDs();
    ds.streamCardPending = false;
    ds.streamCardPendingTurnId = undefined;
    ds.lastScreenStatus = undefined;
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok' });
    await vi.advanceTimersByTimeAsync(0);

    (ds.worker as any).emit('message', terminalMsg(TURN));
    // Residual output supplies busy execution evidence without bumping the card revision.
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'residual busy', status: 'working', turnId: TURN,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(delivered).toEqual(['idle']);

    // The older starting write lands after that correction and must be idled again.
    releaseRestore();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual(['idle', 'starting', 'idle']);
  });

  it('keeps the late-publication correction receipt for a direct-submit repaint', async () => {
    let resolvePost!: (messageId: string) => void;
    initWorkerPool({
      sessionReply: vi.fn(() => new Promise<string>(resolve => { resolvePost = resolve; })),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
    const ds = setupStartingDs();
    ds.streamCardId = undefined;
    ds.lastScreenStatus = 'idle';
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(0);
    resolvePost('om_start_pending_completed_receipt');
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchedStatus()).toBe('idle');

    // A residual busy frame updates execution state without touching the idle card.
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'residual busy', status: 'working', turnId: TURN,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.lastScreenStatus).toBe('working');
    expect(lastPatchedStatus()).toBe('idle');

    // The ordinary same-value frame needs the delivered receipt to repaint live work.
    (ds.worker as any).emit('message', { type: 'direct_submit_started' });
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'direct busy', status: 'working', turnId: TURN,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchedStatus()).toBe('working');
  });

  it('installs idle instead of leaving starting forever after a remote backend exit', async () => {
    const ds = setupStartingDs();
    ds.session.backendType = 'riff';
    await post(ds, TURN);
    (ds.worker as any).emit('message', {
      type: 'claude_exit', code: 1, signal: null, canParkDiagnostic: false,
    });
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['idle']);
  });

  it('preserves the established failure label when a late correction is rejected', async () => {
    let resolvePost!: (messageId: string) => void;
    initWorkerPool({
      sessionReply: vi.fn(() => new Promise<string>(resolve => { resolvePost = resolve; })),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
    const ds = setupStartingDs();
    ds.streamCardId = undefined;
    ds.lastScreenStatus = 'idle';
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);

    // Failed final-output handling establishes this label before turn_terminal.
    ds.failedIdleTurnId = TURN;
    (ds.worker as any).emit('message', terminalMsg(TURN, 'failed'));
    // A silent-listener transition while the POST is in flight rejects the PATCH.
    ds.session.messageListenerRun = { sourceMessageId: 'om_listener', replyMode: 'none' };
    await vi.advanceTimersByTimeAsync(0);
    resolvePost('om_start_pending_failed_label');
    await vi.advanceTimersByTimeAsync(0);

    expect(ds.failedIdleTurnId).toBe(TURN);
  });

  it('reconciles working after an admitted restored starting write loses its post-write fence', async () => {
    const delivered: string[] = [];
    let releaseRestore!: () => void;
    updateMessageMock.mockImplementation((...args: any[]) => {
      const status = JSON.parse(String(args[2])).status;
      const opts = args[3];
      if (!releaseRestore) {
        return Promise.resolve().then(async () => {
          if (opts?.beforeWrite) await opts.beforeWrite();
          return new Promise<void>(resolve => {
            releaseRestore = () => { delivered.push(status); resolve(); };
          });
        });
      }
      return Promise.resolve().then(async () => {
        if (opts?.beforeWrite) await opts.beforeWrite();
        delivered.push(status);
      });
    });
    const ds = setupStartingDs();
    ds.streamCardPending = false;
    ds.streamCardPendingTurnId = undefined;
    ds.lastScreenStatus = undefined;
    (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok' });
    await vi.advanceTimersByTimeAsync(0);

    // The starting write was admitted before any numeric attempt. Two attempts
    // and a newer working frame then arrive before its network completion.
    (ds.worker as any).emit('message', {
      type: 'capture_identity', revision: 1, turnId: TURN, dispatchAttempt: 0,
    });
    (ds.worker as any).emit('message', {
      type: 'capture_identity', revision: 2, turnId: TURN, dispatchAttempt: 1,
    });
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'retry working', status: 'working', turnId: TURN, dispatchAttempt: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual(['working']);

    releaseRestore();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(delivered).toEqual(['working', 'starting', 'working']);
  });

  it('reasserts replacement-worker working after an old remote-exit idle settles', async () => {
    const delivered: string[] = [];
    let releaseExitIdle!: () => void;
    updateMessageMock.mockImplementation((...args: any[]) => {
      const status = JSON.parse(String(args[2])).status;
      const opts = args[3];
      if (!releaseExitIdle) {
        return Promise.resolve().then(async () => {
          if (opts?.beforeWrite) await opts.beforeWrite();
          return new Promise<void>(resolve => {
            releaseExitIdle = () => { delivered.push(status); resolve(); };
          });
        });
      }
      return Promise.resolve().then(async () => {
        if (opts?.beforeWrite) await opts.beforeWrite();
        delivered.push(status);
      });
    });
    const ds = setupStartingDs();
    ds.session.backendType = 'riff';
    await post(ds, TURN);
    (ds.worker as any).emit('message', {
      type: 'claude_exit', code: 1, signal: null, canParkDiagnostic: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    const replacement = makeFakeWorker();
    ds.worker = replacement;
    ds.workerGeneration = (ds.workerGeneration ?? 0) + 1;
    ds.session.workerGeneration = ds.workerGeneration;
    __testOnly_setupWorkerHandlers(ds, replacement);
    replacement.emit('message', { type: 'ready', port: 0, token: 'tok', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual(['working']);

    releaseExitIdle();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual(['working', 'idle', 'working']);
  });
});

describe('Antigravity recovery card retry', () => {
  it('does not repaint a terminalized turn as working when persistence retry finally succeeds', async () => {
    const ds = makeDs();
    ds.session.cliId = 'antigravity';
    activate(ds);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    const dispatch = async (message: WorkerToDaemon) => {
      for (const listener of (ds.worker as any).listeners('message')) await listener(message);
      await vi.advanceTimersByTimeAsync(0);
    };
    await dispatch(terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2000);
    expect(lastPatchedStatus()).toBe('idle');
    ds.usageLimit = { limited: true, kind: 'usage', retryAtMs: Date.now() + 60_000, retryLabel: '1m', retryReady: false, source: 'antigravity-error-composer' };
    ds.lastScreenStatus = 'limited';
    vi.mocked(persistStreamCardState).mockImplementationOnce(() => { throw new Error('first clear fails'); });
    await dispatch({ type: 'screen_update', content: 'composer', status: 'working', turnId: TURN, usageLimitRecovery: 'antigravity-ready-composer' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ds.usageLimit).toBeUndefined();
    expect(lastPatchedStatus()).not.toBe('working');
  });
});

describe('starting card live-working projection, folded follow-ups, races, and stale post-terminal isolation', () => {
  function setupLiveDs(overrides?: Partial<DaemonSession>, cliId: DaemonSession['session']['cliId'] = 'claude-code') {
    const ds = makeDs({
      workerReady: true,
      workerGeneration: 1,
      streamCardPending: false,
      streamCardPendingTurnId: undefined,
      streamCardTurnGeneration: 1,
      currentTurnId: TURN,
      lastScreenStatus: undefined,
      ...overrides,
    });
    ds.session.cliId = cliId;
    ds.session.workerGeneration = ds.workerGeneration;
    activate(ds);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any, undefined, ds.workerGeneration);
    return ds;
  }

  function patchedStatuses(): unknown[] {
    return updateMessageMock.mock.calls.map(call => {
      try { return JSON.parse(String(call[2])).status; } catch { return undefined; }
    });
  }

  async function postTurnCard(
    ds: DaemonSession,
    turnId: string,
    cardId = `om_card_${turnId}`,
  ): Promise<{ postedStatus: unknown; replyMock: ReturnType<typeof vi.fn> }> {
    ds.currentTurnId = turnId;
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = turnId;
    ds.streamCardTurnGeneration = (ds.streamCardTurnGeneration ?? 0) + 1;
    const replyMock = vi.fn(async () => cardId);
    expect(await postTurnStartingCard(ds, replyMock as any, turnId)).toBe(true);
    const postedStatus = JSON.parse(String(replyMock.mock.calls[0][1])).status;
    return { postedStatus, replyMock };
  }

  it.each(['footer', 'off'] as const)(
    'posts Claude folded follow-up directly as working under usageDisplay=%s while preserving waiting-turn isolation and zero false stalls',
    async usageDisplay => {
      const { resolveUsageDisplay } = await import('../src/bot-registry.js');
      vi.mocked(resolveUsageDisplay).mockReturnValue(usageDisplay);
      try {
        const ds = setupLiveDs({ displayMode: 'hidden' }, 'claude-code');
        const followUpTurn = 'turn-live-0002';

        // Turn 1 establishes capture identity and live working proof.
        (ds.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
        (ds.worker as any).emit('message', { type: 'screen_update', content: 'turn 1 working', status: 'working', turnId: TURN });
        await vi.advanceTimersByTimeAsync(0);
        updateMessageMock.mockClear();

        // Turn 2 arrives mid-turn (type-ahead / folded follow-up) with zero screen_update during POST.
        const { postedStatus } = await postTurnCard(ds, followUpTurn);
        expect(postedStatus).toBe('working');
        expect(ds.usageRefreshTimer).toBeUndefined();
        expect(ds.streamCardDisplayTarget).toMatchObject({
          messageId: `om_card_${followUpTurn}`,
          mode: 'waiting-exact-turn',
          turnId: followUpTurn,
        });
        expect(unifiedReplyTurnNotCapturing(ds, followUpTurn)).toBe(true);
        updateMessageMock.mockClear();

        // Predecessor screenshot stays strictly isolated in waitingTurnPreview (never currentImageKey).
        (ds.worker as any).emit('message', {
          type: 'screenshot_uploaded',
          imageKey: 'img_turn1_preview',
          status: 'working',
          turnId: TURN,
          captureRevision: 1,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(ds.currentImageKey).toBeUndefined();
        expect(ds.waitingTurnPreview).toMatchObject({ imageKey: 'img_turn1_preview', turnId: TURN });

        // Folded follow-up emits native_input_consumed(T2) and only T1 working->working frames across 87 minutes.
        (ds.worker as any).emit('message', {
          type: 'native_input_consumed',
          turnId: followUpTurn,
          proofKind: 'claude_transcript_user_record',
        });
        await vi.advanceTimersByTimeAsync(0);
        for (let i = 0; i < 3; i += 1) {
          (ds.worker as any).emit('message', { type: 'screen_update', content: `tick-${i}`, status: 'working', turnId: TURN });
          await vi.advanceTimersByTimeAsync(29 * 60_000);
        }
        expect(patchedStatuses()).not.toContain('stalled');
        expect(patchedStatuses()).not.toContain('starting');
      } finally {
        vi.mocked(resolveUsageDisplay).mockReturnValue('off');
      }
    },
  );

  it('reconciles pre-first-frame folded/steered turns via native_input_consumed, prompt_submitted_input, and steer_accepted without weakening cold watchdogs', async () => {
    const followUpTurn = 'turn-live-0002';

    // Sub-case 1: Post-POST native_input_consumed when captureIdentity=T1 and lastScreenStatus='idle' (no prior live screen_update).
    // Card reconciles immediately to 'working' (never stale 'idle'); host T1 frame disarms watchdog cleanly.
    const ds1 = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
    (ds1.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    const post1 = await postTurnCard(ds1, followUpTurn);
    expect(post1.postedStatus).toBe('starting');
    updateMessageMock.mockClear();

    (ds1.worker as any).emit('message', {
      type: 'native_input_consumed',
      turnId: followUpTurn,
      proofKind: 'claude_transcript_user_record',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['working']);
    expect(unifiedReplyTurnNotCapturing(ds1, followUpTurn)).toBe(true);
    updateMessageMock.mockClear();

    // Host turn screen frame proves capture pipeline alive (real idle->working edge repaints once),
    // disarms the folded watchdog, and subsequent working->working frames produce zero stalled or extra PATCHes.
    (ds1.worker as any).emit('message', { type: 'screen_update', content: 'host alive', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['working']);
    updateMessageMock.mockClear();
    (ds1.worker as any).emit('message', { type: 'screen_update', content: 'host steady', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(87 * 60_000);
    expect(patchedStatuses()).toEqual([]);

    // Sub-case 2: Folded follow-up whose capture_identity never advances AND capture pipeline is truly wedged (0 frames):
    // starting-card-health MUST NOT defer indefinitely — it degrades to 'stalled' at 45s and recovers on host frame.
    const ds2 = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
    (ds2.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    const post2 = await postTurnCard(ds2, followUpTurn);
    expect(post2.postedStatus).toBe('starting');
    updateMessageMock.mockClear();

    (ds2.worker as any).emit('message', {
      type: 'native_input_consumed',
      turnId: followUpTurn,
      proofKind: 'claude_transcript_user_record',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['working']);
    updateMessageMock.mockClear();

    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
    updateMessageMock.mockClear();

    // Recovery from host turn repaints back to 'working'.
    (ds2.worker as any).emit('message', { type: 'screen_update', content: 'host recovered', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['working']);

    // Sub-case 3: Mid-POST prompt_submitted_input and pre-POST codex-app steer_accepted (even with silentTurnReactions).
    const ds3 = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
    (ds3.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    ds3.currentTurnId = followUpTurn;
    ds3.streamCardPending = true;
    ds3.streamCardPendingTurnId = followUpTurn;
    ds3.streamCardTurnGeneration = 2;
    let resolveMidPost!: (id: string) => void;
    const midPosting = postTurnStartingCard(ds3, vi.fn(() => new Promise<string>(r => { resolveMidPost = r; })) as any, followUpTurn);
    await vi.advanceTimersByTimeAsync(0);
    (ds3.worker as any).emit('message', { type: 'prompt_submitted_input', turnId: followUpTurn });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();
    resolveMidPost('om_mid_prompt_submitted');
    await midPosting;
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['working']);
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);

    const ds4 = setupLiveDs({ lastScreenStatus: 'idle' }, 'codex-app');
    (ds4.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    (ds4.worker as any).emit('message', { type: 'steer_accepted', appTurnId: 'app-1', turnId: followUpTurn });
    await vi.advanceTimersByTimeAsync(0);
    const post4 = await postTurnCard(ds4, followUpTurn);
    expect(post4.postedStatus).toBe('working');
    updateMessageMock.mockClear();
    // Pre-POST steer_accepted without live working proof also arms host-turn health (not deferred indefinitely).
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
    // Disarm ds4 before testing the cold-turn control so fake timers stay isolated.
    (ds4.worker as any).emit('message', terminalMsg(followUpTurn, 'completed'));
    await vi.advanceTimersByTimeAsync(0);

    // Sub-case 4: Contrast controls — cold capturing turn (!unifiedReplyTurnNotCapturing) receiving native_input_consumed
    // with 0 rendered frames still degrades to 'stalled' at 45s, and an already-'stalled' card is NOT cleared by native_input_consumed.
    const dsCold = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
    const postCold = await postTurnCard(dsCold, TURN);
    expect(postCold.postedStatus).toBe('starting');
    updateMessageMock.mockClear();
    (dsCold.worker as any).emit('message', {
      type: 'native_input_consumed',
      turnId: TURN,
      proofKind: 'claude_transcript_user_record',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual([]);
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
    updateMessageMock.mockClear();
    (dsCold.worker as any).emit('message', {
      type: 'native_input_consumed',
      turnId: TURN,
      proofKind: 'claude_transcript_user_record',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual([]);
  });

  it('projects live working for non-usage type-ahead CLIs while retaining deferred capture-activation watchdog after handoff', async () => {
    const followUpTurn = 'turn-live-0002';

    // Sub-case A: silent after capture_identity(T2) -> degrades to 'stalled' at 45s.
    const dsHang = setupLiveDs({ displayMode: 'hidden' }, 'pi');
    (dsHang.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    (dsHang.worker as any).emit('message', { type: 'screen_update', content: 'pi working', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();

    const { postedStatus } = await postTurnCard(dsHang, followUpTurn);
    expect(postedStatus).toBe('working');
    expect(dsHang.usageRefreshTimer).toBeUndefined();
    updateMessageMock.mockClear();

    // 60s of predecessor frames produce zero stalled badges.
    (dsHang.worker as any).emit('message', { type: 'screen_update', content: 'pi still t1', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(patchedStatuses()).toEqual([]);

    // Once capture_identity hands off to T2, silent capture pipeline stalls at 45s.
    (dsHang.worker as any).emit('message', { type: 'capture_identity', revision: 2, turnId: followUpTurn });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS - 1);
    expect(patchedStatuses()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(patchedStatuses()).toEqual(['stalled']);

    // Sub-case B: healthy handoff emits T2 frame -> disarms cleanly with 0 redundant PATCH and 0 stalled.
    const dsHealthy = setupLiveDs({ displayMode: 'hidden' }, 'pi');
    (dsHealthy.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    (dsHealthy.worker as any).emit('message', { type: 'screen_update', content: 'pi working', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    await postTurnCard(dsHealthy, followUpTurn);
    (dsHealthy.worker as any).emit('message', { type: 'capture_identity', revision: 2, turnId: followUpTurn });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();

    (dsHealthy.worker as any).emit('message', { type: 'screen_update', content: 't2 alive', status: 'working', turnId: followUpTurn });
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual([]);
  });

  it('exits visibly starting card on first working->working screen_update or hidden screenshot_uploaded without silent watchdog self-disarm', async () => {
    // Sub-case 1: screen_update working->working exits starting and disarms watchdog; second frame emits 0 extra PATCHes.
    const ds1 = setupLiveDs({ lastScreenStatus: 'working' }, 'pi');
    const post1 = await postTurnCard(ds1, TURN);
    expect(post1.postedStatus).toBe('starting');
    updateMessageMock.mockClear();

    (ds1.worker as any).emit('message', { type: 'screen_update', content: 'live 1', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['working']);
    updateMessageMock.mockClear();

    (ds1.worker as any).emit('message', { type: 'screen_update', content: 'live 2', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual([]);

    // Sub-case 2: hidden-mode screenshot_uploaded working->working exits starting.
    const ds2 = setupLiveDs({ lastScreenStatus: 'working', displayMode: 'hidden' }, 'pi');
    const post2 = await postTurnCard(ds2, TURN);
    expect(post2.postedStatus).toBe('starting');
    updateMessageMock.mockClear();

    (ds2.worker as any).emit('message', { type: 'screenshot_uploaded', imageKey: 'img_1', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['working']);
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual([]);

    // Sub-case 3: hidden-mode screenshot_uploaded respects pending trigger streaming card gate.
    const ds3 = setupLiveDs({ scope: 'chat', lastScreenStatus: 'working', displayMode: 'hidden' }, 'pi');
    await postTurnCard(ds3, TURN);
    armTriggerStreamingCard(ds3, {
      presentation: { liveCard: 'on-start', title: 'Cron' },
    } as any, TURN);
    updateMessageMock.mockClear();

    (ds3.worker as any).emit('message', { type: 'screenshot_uploaded', imageKey: 'img_trig', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual([]);
  });

  it('retries starting->working exit PATCH after transient Feishu 503 and ignores booting toggle clicks with undefined lastScreenStatus', async () => {
    const ds = setupLiveDs({ lastScreenStatus: undefined }, 'pi');
    const post = await postTurnCard(ds, TURN);
    expect(post.postedStatus).toBe('starting');
    updateMessageMock.mockClear();

    // Booting toggle click while lastScreenStatus is undefined renders 'starting' and must NOT clear visiblyStartingCards.
    scheduleCardPatch(ds, buildStreamingCardJson(ds));
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['starting']);
    updateMessageMock.mockClear();

    // First working frame PATCH rejects with transient 503; second working->working frame must retry and deliver.
    updateMessageMock.mockRejectedValueOnce(Object.assign(new Error('503'), { response: { status: 503 } }));
    (ds.worker as any).emit('message', { type: 'screen_update', content: 'live 1', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    updateMessageMock.mockClear();

    (ds.worker as any).emit('message', { type: 'screen_update', content: 'live 2', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['working']);
    updateMessageMock.mockClear();

    // Third working->working frame after confirmed delivery emits zero extra PATCHes.
    (ds.worker as any).emit('message', { type: 'screen_update', content: 'live 3', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual([]);

    // Folded 503 retry: native_input_consumed PATCH fails 503 -> next host T1 screen_update retries and delivers 'working'.
    const dsFold = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
    const followUpTurn = 'turn-live-0002';
    (dsFold.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    await postTurnCard(dsFold, followUpTurn);
    updateMessageMock.mockClear();

    updateMessageMock.mockRejectedValueOnce(Object.assign(new Error('503'), { response: { status: 503 } }));
    (dsFold.worker as any).emit('message', {
      type: 'native_input_consumed',
      turnId: followUpTurn,
      proofKind: 'claude_transcript_user_record',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    updateMessageMock.mockClear();

    (dsFold.worker as any).emit('message', { type: 'screen_update', content: 'host retry', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['working']);
  });

  it('handles pre-POST idle->working and fast idle->working->idle races despite active predecessor pending entry and interleaved frames', async () => {
    const turn2 = 'turn-live-0002';

    // Sub-case 1: pending still holds T1; idle->working for T2 (dispatchAttempt: 0) arrives BEFORE
    // postTurnStartingStatusCard snapshots revision, followed by an interleaved T1 idle frame (so
    // workersWithLiveWorkingStatus is cleared and only per-turn latestHealthy retains T2's working status).
    const ds1 = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
    await postTurnCard(ds1, TURN); // arms pending for TURN
    (ds1.worker as any).emit('message', {
      type: 'screen_update',
      content: 't2 started early',
      status: 'working',
      turnId: turn2,
      dispatchAttempt: 0,
    });
    (ds1.worker as any).emit('message', {
      type: 'screen_update',
      content: 't1 idle interleaved',
      status: 'idle',
      turnId: TURN,
    });
    await vi.advanceTimersByTimeAsync(0);
    const post1 = await postTurnCard(ds1, turn2);
    expect(post1.postedStatus).toBe('working');
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual([]);

    // Sub-case 2: fast idle->working->idle for T2 followed by interleaved T1 idle frame BEFORE postTurnStartingCard(T2).
    const ds2 = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
    await postTurnCard(ds2, TURN);
    (ds2.worker as any).emit('message', { type: 'screen_update', content: 't2 busy', status: 'working', turnId: turn2, dispatchAttempt: 0 });
    (ds2.worker as any).emit('message', { type: 'screen_update', content: 't2 done', status: 'idle', turnId: turn2, dispatchAttempt: 0 });
    (ds2.worker as any).emit('message', { type: 'screen_update', content: 't1 idle', status: 'idle', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);

    const post2 = await postTurnCard(ds2, turn2);
    expect(post2.postedStatus).toBe('idle');
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual([]);
  });

  it('reconciles mid-POST capture_identity activation to working while blocking predecessor mid-POST frames from overwriting queued cards', async () => {
    const turn2 = 'turn-live-0002';

    // Sub-case 1: captureIdentity=T1, T2 starts POST; mid-POST T1 emits idle, then capture_identity(T2) arrives -> reconciles to 'working' (never stale 'idle') and arms 45s watchdog.
    const ds1 = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
    (ds1.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    ds1.currentTurnId = turn2;
    ds1.streamCardPending = true;
    ds1.streamCardPendingTurnId = turn2;
    ds1.streamCardTurnGeneration = 2;
    let resolvePost1!: (id: string) => void;
    const posting1 = postTurnStartingCard(ds1, vi.fn(() => new Promise<string>(r => { resolvePost1 = r; })) as any, turn2);
    await vi.advanceTimersByTimeAsync(0);
    (ds1.worker as any).emit('message', { type: 'screen_update', content: 't1 settled idle', status: 'idle', turnId: TURN });
    (ds1.worker as any).emit('message', { type: 'capture_identity', revision: 2, turnId: turn2 });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();

    resolvePost1('om_race_b_card');
    await posting1;
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['working']);
    updateMessageMock.mockClear();

    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);

    // Sub-case 2: queued T2 POSTing 'starting'; mid-POST T1 emits working (and sibling idle) -> zero premature overwrites, watchdog stays deferred.
    for (const midStatus of ['working', 'idle'] as const) {
      const ds2 = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
      (ds2.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
      await vi.advanceTimersByTimeAsync(0);
      ds2.currentTurnId = turn2;
      ds2.streamCardPending = true;
      ds2.streamCardPendingTurnId = turn2;
      ds2.streamCardTurnGeneration = 2;
      let resolvePost2!: (id: string) => void;
      const posting2 = postTurnStartingCard(ds2, vi.fn(() => new Promise<string>(r => { resolvePost2 = r; })) as any, turn2);
      await vi.advanceTimersByTimeAsync(0);
      (ds2.worker as any).emit('message', { type: 'screen_update', content: `t1 ${midStatus}`, status: midStatus, turnId: TURN });
      await vi.advanceTimersByTimeAsync(0);
      updateMessageMock.mockClear();

      resolvePost2(`om_queued_mid_${midStatus}`);
      await posting2;
      await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
      expect(patchedStatuses()).toEqual([]);
    }
  });

  it('settles mid-POST terminals on Layer-1 working cards and fixes both ready restored-card PATCH ordering races', async () => {
    const turn2 = 'turn-live-0002';

    // Sub-case 1: Layer-1 working POST receives turn_terminal(T2, completed) mid-POST -> settles to 'idle'.
    const ds1 = setupLiveDs({ lastScreenStatus: undefined }, 'claude-code');
    (ds1.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    (ds1.worker as any).emit('message', { type: 'screen_update', content: 't1 working', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    ds1.currentTurnId = turn2;
    ds1.streamCardPending = true;
    ds1.streamCardPendingTurnId = turn2;
    ds1.streamCardTurnGeneration = 2;
    let resolvePost1!: (id: string) => void;
    const reply1 = vi.fn(() => new Promise<string>(r => { resolvePost1 = r; }));
    const posting1 = postTurnStartingCard(ds1, reply1 as any, turn2);
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(String(reply1.mock.calls[0][1])).status).toBe('working');
    (ds1.worker as any).emit('message', terminalMsg(turn2, 'completed'));
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();

    resolvePost1('om_layer1_terminal_midpost');
    await posting1;
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['idle']);

    // Sub-case 2: slow ready restore 'starting' PATCH receives 2 attempt transitions + working + turn_terminal(completed) -> settles 'idle' (never 'working').
    const delivered2: string[] = [];
    let releaseRestore2!: () => void;
    updateMessageMock.mockImplementation((...args: any[]) => {
      const status = JSON.parse(String(args[2])).status;
      const opts = args[3];
      if (!releaseRestore2) {
        return Promise.resolve().then(async () => {
          if (opts?.beforeWrite) await opts.beforeWrite();
          return new Promise<void>(resolve => {
            releaseRestore2 = () => { delivered2.push(status); resolve(); };
          });
        });
      }
      return Promise.resolve().then(async () => {
        if (opts?.beforeWrite) await opts.beforeWrite();
        delivered2.push(status);
      });
    });
    const ds2 = setupLiveDs({ lastScreenStatus: undefined }, 'pi');
    (ds2.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    (ds2.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN, dispatchAttempt: 0 });
    (ds2.worker as any).emit('message', { type: 'capture_identity', revision: 2, turnId: TURN, dispatchAttempt: 1 });
    (ds2.worker as any).emit('message', { type: 'screen_update', content: 'working attempt 1', status: 'working', turnId: TURN, dispatchAttempt: 1 });
    (ds2.worker as any).emit('message', { ...terminalMsg(TURN, 'completed'), dispatchAttempt: 1 });
    await vi.advanceTimersByTimeAsync(0);
    releaseRestore2();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered2.at(-1)).toBe('idle');

    // Sub-case 3: slow ready restore 'working' PATCH finishes after turn_terminal(completed) already settled 'idle' -> re-asserts 'idle'.
    const delivered3: string[] = [];
    let releaseRestore3!: () => void;
    updateMessageMock.mockImplementation((...args: any[]) => {
      const status = JSON.parse(String(args[2])).status;
      const opts = args[3];
      if (!releaseRestore3) {
        return new Promise<void>(resolve => {
          releaseRestore3 = () => { delivered3.push(status); resolve(); };
        });
      }
      return Promise.resolve().then(async () => {
        if (opts?.beforeWrite) await opts.beforeWrite();
        delivered3.push(status);
      });
    });
    const ds3 = setupLiveDs({ lastScreenStatus: 'working' }, 'pi');
    (ds3.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    (ds3.worker as any).emit('message', terminalMsg(TURN, 'completed'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(delivered3).toEqual(['idle']);
    releaseRestore3();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered3).toEqual(['idle', 'working', 'idle']);
  });

  it('isolates stale post-terminal working and residual T1 frames across normal, cross-turn, local-*, and retry sequences', async () => {
    const turn2 = 'turn-live-0002';

    // Sub-case 1: standard post-terminal stale working (both claude-code and live-worker codex-app).
    for (const cliId of ['claude-code', 'codex-app'] as const) {
      const ds = setupLiveDs({ lastScreenStatus: undefined }, cliId);
      (ds.worker as any).emit('message', { type: 'screen_update', content: 't1 working', status: 'working', turnId: TURN });
      await vi.advanceTimersByTimeAsync(0);
      expect(turnStartingCardStatus(ds, cliId)).toBe('working');

      (ds.worker as any).emit('message', terminalMsg(TURN, 'completed'));
      await vi.advanceTimersByTimeAsync(2_000);
      // Display-only settle intentionally leaves lastScreenStatus === 'working'.
      expect(ds.lastScreenStatus).toBe('working');
      expect(turnStartingCardStatus(ds, cliId)).toBe('starting');

      // New cold turn T2 starts -> posts 'starting', NOT 'working'.
      updateMessageMock.mockClear();
      const post = await postTurnCard(ds, turn2);
      expect(post.postedStatus).toBe('starting');
      const revAfterPost = ds.streamCardStatusRevision ?? 0;
      updateMessageMock.mockClear();

      // Residual stale working frame tagged with completed T1 MUST be gated (no revision bump, no PATCH, no live-working re-entry).
      (ds.worker as any).emit('message', { type: 'screen_update', content: 'stale t1', status: 'working', turnId: TURN });
      await vi.advanceTimersByTimeAsync(0);
      expect(ds.streamCardStatusRevision ?? 0).toBe(revAfterPost);
      expect(patchedStatuses()).toEqual([]);
      expect(turnStartingCardStatus(ds, cliId)).toBe('starting');

      // Real T2 working frame exits 'starting' -> 'working'.
      (ds.worker as any).emit('message', { type: 'screen_update', content: 'live t2', status: 'working', turnId: turn2 });
      await vi.advanceTimersByTimeAsync(0);
      expect(patchedStatuses()).toEqual(['working']);
    }

    // Sub-case 2: cross-turn race — beginNewTurn advances currentTurnId to T2 BEFORE turn_terminal(T1, completed) arrives.
    const dsRace = setupLiveDs({ lastScreenStatus: undefined }, 'claude-code');
    (dsRace.worker as any).emit('message', { type: 'screen_update', content: 't1 working', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    dsRace.currentTurnId = turn2;
    (dsRace.worker as any).emit('message', terminalMsg(TURN, 'completed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(turnStartingCardStatus(dsRace, 'claude-code')).toBe('starting');
    const postRace = await postTurnCard(dsRace, turn2);
    expect(postRace.postedStatus).toBe('starting');
    updateMessageMock.mockClear();
    (dsRace.worker as any).emit('message', { type: 'screen_update', content: 'late stale t1', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual([]);

    // Sub-case 3: local-* direct-submit terminal clears live-working provenance; attempt-less frame during live T1 retry is NOT gated.
    const dsLocal = setupLiveDs({ lastScreenStatus: undefined }, 'claude-code');
    (dsLocal.worker as any).emit('message', { type: 'screen_update', content: 'local busy', status: 'working', directSubmit: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(turnStartingCardStatus(dsLocal, 'claude-code')).toBe('working');
    (dsLocal.worker as any).emit('message', terminalMsg('local-1', 'completed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(turnStartingCardStatus(dsLocal, 'claude-code')).toBe('starting');

    const dsRetry = setupLiveDs({ lastScreenStatus: undefined }, 'claude-code');
    noteTurnDispatchAttempt(dsRetry, TURN, 1);
    (dsRetry.worker as any).emit('message', { type: 'screen_update', content: 'a1', status: 'working', turnId: TURN, dispatchAttempt: 1 });
    (dsRetry.worker as any).emit('message', { ...terminalMsg(TURN, 'completed'), dispatchAttempt: 1 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(lastPatchedStatus()).toBe('idle');
    // Retry attempt 2 opens; attempt-less screen_update for TURN must remain live (not gated as stale).
    noteTurnDispatchAttempt(dsRetry, TURN, 2);
    updateMessageMock.mockClear();
    (dsRetry.worker as any).emit('message', { type: 'screen_update', content: 'a2 retry', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(turnStartingCardStatus(dsRetry, 'claude-code')).toBe('working');
  });

  it('invalidates live-working provenance and health history across worker retirement, exit, and in-worker CLI auto-restart', async () => {
    const turn2 = 'turn-live-0002';

    // Sub-case 1: worker retirement/exit leaves ds.lastScreenStatus === 'working', but replacement worker starts cold as 'starting'.
    for (const retireMode of ['kill', 'retire', 'exit'] as const) {
      const ds = setupLiveDs({ lastScreenStatus: undefined, suppressRecoveryCard: true }, 'claude-code');
      // Mark worker ready so an abrupt exit exercises post-ready exit (leaving ds.lastScreenStatus === 'working') rather than preReadyExit startup failure.
      (ds.worker as any).emit('message', { type: 'ready', port: 0, token: 'tok' });
      ds.suppressRecoveryCard = false;
      (ds.worker as any).emit('message', { type: 'screen_update', content: 'gen1 working', status: 'working', turnId: TURN });
      await vi.advanceTimersByTimeAsync(0);
      expect(turnStartingCardStatus(ds, 'claude-code')).toBe('working');

      if (retireMode === 'kill') {
        killWorker(ds);
      } else if (retireMode === 'retire') {
        retireWorkerProcessOnly(ds, 'test-retire');
      } else {
        (ds.worker as any).emit('exit', 1, null);
      }
      await vi.advanceTimersByTimeAsync(0);

      const worker2 = makeFakeWorker();
      ds.worker = worker2;
      ds.workerReady = true;
      ds.workerGeneration = 2;
      ds.session.workerGeneration = 2;
      __testOnly_setupWorkerHandlers(ds, worker2, undefined, 2);

      // Even though ds.lastScreenStatus is still 'working', Worker 2 has no live-working proof yet.
      expect(ds.lastScreenStatus).toBe('working');
      expect(turnStartingCardStatus(ds, 'claude-code')).toBe('starting');
      expect(turnStartingCardStatus(ds, 'codex-app')).toBe('starting');

      updateMessageMock.mockClear();
      const post = await postTurnCard(ds, turn2);
      expect(post.postedStatus).toBe('starting');
      updateMessageMock.mockClear();

      // Worker 2's own screen_update flips 'starting' -> 'working'.
      worker2.emit('message', { type: 'screen_update', content: 'gen2 working', status: 'working', turnId: turn2 });
      await vi.advanceTimersByTimeAsync(0);
      expect(patchedStatuses()).toEqual(['working']);
    }

    // Sub-case 2: in-worker CLI auto-restart (claude_exit with same Node worker & workerGeneration) clears provenance & health history.
    const dsAuto = setupLiveDs({ lastScreenStatus: undefined }, 'claude-code');
    (dsAuto.worker as any).emit('message', { type: 'screen_update', content: 'before crash', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(turnStartingCardStatus(dsAuto, 'claude-code')).toBe('working');

    (dsAuto.worker as any).emit('message', { type: 'claude_exit', code: 1, signal: null, canParkDiagnostic: false });
    await vi.advanceTimersByTimeAsync(0);
    // In-worker restart keeps the same Node worker & workerGeneration; once ready again,
    // pre-crash live-working provenance and health history must NOT carry over.
    dsAuto.workerReady = true;
    dsAuto.lastScreenStatus = 'working';
    expect(turnStartingCardStatus(dsAuto, 'claude-code')).toBe('starting');

    updateMessageMock.mockClear();
    const postAfterRestart = await postTurnCard(dsAuto, TURN);
    expect(postAfterRestart.postedStatus).toBe('starting');
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
  });

  it('prevents /card mid-POST sentinel deadlock, preserves watchdogs on /card replacement, and blocks killed/suspended mid-POST commits', async () => {
    const turn2 = 'turn-live-0002';

    // 1. /card while postTurnStartingCard holds CARD_POSTING_SENTINEL must bail synchronously
    // (if /card raced into flight, resolved replyT2 would lose nonce ownership and a subsequent /card 503 would deadlock CARD_POSTING_SENTINEL).
    const ds1 = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
    ds1.currentTurnId = turn2;
    ds1.streamCardPending = true;
    ds1.streamCardPendingTurnId = turn2;
    ds1.streamCardTurnGeneration = 2;
    let resolveStart!: (id: string) => void;
    const posting = postTurnStartingCard(ds1, vi.fn(() => new Promise<string>(r => { resolveStart = r; })) as any, turn2);
    await vi.advanceTimersByTimeAsync(0);
    expect(ds1.streamCardId).toBe(CARD_POSTING_SENTINEL);
    let rejectFresh: ((err: Error) => void) | undefined;
    const freshReply = vi.fn(() => new Promise<string>((_, rej) => { rejectFresh = rej; }));
    const freshPosting = postFreshStreamingCard(ds1, freshReply as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(freshReply).not.toHaveBeenCalled();
    resolveStart('om_start_unblocked');
    expect(await posting).toBe(true);
    rejectFresh?.(new Error('503'));
    expect(await freshPosting).toBe(false);
    expect(ds1.streamCardId).toBe('om_start_unblocked');
    killWorker(ds1);

    // 2. /card replacing a Layer-1 waiting card transfers its deferred capture-activation watchdog to the new cardId.
    const ds2 = setupLiveDs({ displayMode: 'hidden' }, 'pi');
    (ds2.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    (ds2.worker as any).emit('message', { type: 'screen_update', content: 't1 working', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    await postTurnCard(ds2, turn2);
    expect(await postFreshStreamingCard(ds2, vi.fn(async () => 'om_manual_rebound') as any)).toBe(true);
    expect(ds2.streamCardId).toBe('om_manual_rebound');
    (ds2.worker as any).emit('message', { type: 'capture_identity', revision: 2, turnId: turn2 });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);

    // 3. killWorker mid-POST invalidates postTurnStartingCard ownership AND restores pre-POST cardId (never wedges CARD_POSTING_SENTINEL).
    const ds3 = setupLiveDs({ lastScreenStatus: 'idle', streamCardId: 'om_prev_card_before_kill' }, 'claude-code');
    ds3.currentTurnId = turn2;
    ds3.streamCardPending = true;
    ds3.streamCardPendingTurnId = turn2;
    ds3.streamCardTurnGeneration = 2;
    let resolveKilled!: (id: string) => void;
    const postingKilled = postTurnStartingCard(ds3, vi.fn(() => new Promise<string>(r => { resolveKilled = r; })) as any, turn2);
    await vi.advanceTimersByTimeAsync(0);
    killWorker(ds3);
    resolveKilled('om_after_kill');
    expect(await postingKilled).toBe(false);
    expect(deleteMessageMock).toHaveBeenCalledWith(APP, 'om_after_kill');
    expect(ds3.streamCardId).toBe('om_prev_card_before_kill');
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual([]);

    // 4. /card mid-POST screen_update from T1 must NOT prune deferred T2 watchdog before rebind, and mid-POST status changes reconcile after /card lands.
    const ds4 = setupLiveDs({ displayMode: 'hidden' }, 'pi');
    (ds4.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    (ds4.worker as any).emit('message', { type: 'screen_update', content: 't1 working', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    await postTurnCard(ds4, turn2);
    let resolveManual!: (id: string) => void;
    const manualPost = postFreshStreamingCard(ds4, vi.fn(() => new Promise<string>(r => { resolveManual = r; })) as any);
    await vi.advanceTimersByTimeAsync(0);
    (ds4.worker as any).emit('message', { type: 'screen_update', content: 't1 tick mid /card', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    resolveManual('om_manual_mid_screen');
    expect(await manualPost).toBe(true);
    (ds4.worker as any).emit('message', { type: 'capture_identity', revision: 2, turnId: turn2 });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
    killWorker(ds4);

    const ds5 = setupLiveDs({ lastScreenStatus: undefined }, 'pi');
    await postTurnCard(ds5, TURN);
    let resolveManual5!: (id: string) => void;
    const manualPost5 = postFreshStreamingCard(ds5, vi.fn(() => new Promise<string>(r => { resolveManual5 = r; })) as any);
    await vi.advanceTimersByTimeAsync(0);
    (ds5.worker as any).emit('message', { type: 'screen_update', content: 'idle mid /card', status: 'idle', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();
    resolveManual5('om_manual_reconcile_idle');
    expect(await manualPost5).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    const manualCardPatches = updateMessageMock.mock.calls
      .filter(call => call[1] === 'om_manual_reconcile_idle')
      .map(call => JSON.parse(String(call[2])).status);
    expect(manualCardPatches).toEqual(['idle']);
  });

  it('settles display-only folded working and stalled cards after turn_terminal(completed) when ds.lastScreenStatus remained idle', async () => {
    const turn2 = 'turn-live-0002';

    // Sub-case 1: folded native_input_consumed reconciles card to 'working' while lastScreenStatus === 'idle';
    // turn_terminal(completed) must settle the card to 'idle' at 2s (and via 120s sweep / idle screen_update).
    const ds1 = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
    (ds1.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    await postTurnCard(ds1, turn2);
    (ds1.worker as any).emit('message', {
      type: 'native_input_consumed',
      turnId: turn2,
      proofKind: 'claude_transcript_user_record',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchedStatus()).toBe('working');
    expect(ds1.lastScreenStatus).toBe('idle');
    updateMessageMock.mockClear();

    (ds1.worker as any).emit('message', terminalMsg(turn2, 'completed'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(patchedStatuses()).toEqual(['idle']);

    // Sub-case 2: screen_update('idle') cancels the 2s settle timer -> must still sync display-only 'working' card to 'idle'.
    const ds2 = setupLiveDs({ lastScreenStatus: 'idle' }, 'codex-app');
    (ds2.worker as any).emit('message', { type: 'steer_accepted', appTurnId: 'app-2', turnId: turn2 });
    await vi.advanceTimersByTimeAsync(0);
    const post2 = await postTurnCard(ds2, turn2);
    expect(post2.postedStatus).toBe('working');
    updateMessageMock.mockClear();
    (ds2.worker as any).emit('message', terminalMsg(turn2, 'completed'));
    (ds2.worker as any).emit('message', { type: 'screen_update', content: 'prompt', status: 'idle', turnId: turn2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['idle']);

    // Sub-case 3: pre-POST steer_accepted without capture_identity still arms 45s cold watchdog (no silent bypass).
    const ds3 = setupLiveDs({ lastScreenStatus: 'idle' }, 'codex-app');
    (ds3.worker as any).emit('message', { type: 'steer_accepted', appTurnId: 'app-3', turnId: turn2 });
    await vi.advanceTimersByTimeAsync(0);
    const post3 = await postTurnCard(ds3, turn2);
    expect(post3.postedStatus).toBe('working');
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
    // After terminal on a stalled card with lastScreenStatus==='idle', 120s sweep also heals it if 2s was missed.
    (ds3.worker as any).emit('message', terminalMsg(turn2, 'completed'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(lastPatchedStatus()).toBe('idle');
    expect(sweepStaleLiveCardStatuses(APP)).toBe(0);
  });

  it('keeps cold starting cards immune to 12s streaming usage ticks, metadata flushes, and toggle overwrites while preserving folded working on clicks', async () => {
    const turn2 = 'turn-live-0002';
    const { resolveUsageDisplay } = await import('../src/bot-registry.js');
    vi.mocked(resolveUsageDisplay).mockReturnValue('streaming');
    try {
      // 1. After turn_terminal(T1, completed), cold T2 posts 'starting'; 12s usage tick and metadata flush must NOT overwrite it to stale 'working'.
      const ds1 = setupLiveDs({ lastScreenStatus: undefined }, 'claude-code');
      (ds1.worker as any).emit('message', { type: 'screen_update', content: 't1 working', status: 'working', turnId: TURN });
      await vi.advanceTimersByTimeAsync(0);
      (ds1.worker as any).emit('message', terminalMsg(TURN, 'completed'));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ds1.lastScreenStatus).toBe('working');

      ds1.currentTurnId = turn2;
      ds1.streamCardPending = true;
      ds1.streamCardPendingTurnId = turn2;
      ds1.streamCardTurnGeneration = 2;
      let resolvePost!: (id: string) => void;
      const posting = postTurnStartingCard(ds1, vi.fn(() => new Promise<string>(r => { resolvePost = r; })) as any, turn2);
      await vi.advanceTimersByTimeAsync(0);
      scheduleActiveRuntimePatch(ds1); // queued mid-POST
      updateMessageMock.mockClear();
      resolvePost('om_cold_t2');
      await posting;
      await vi.advanceTimersByTimeAsync(0);
      expect(patchedStatuses()).toEqual(['starting']);
      expect(ds1.usageRefreshTimer).toBeUndefined();
      updateMessageMock.mockClear();

      // Advance 36s with zero frames -> 0 spurious 'working' usage ticks; at 45s degrades to 'stalled'.
      await vi.advanceTimersByTimeAsync(36_000);
      expect(patchedStatuses()).toEqual([]);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(patchedStatuses()).toEqual(['stalled']);

      // 2. Folded working card (ds.lastScreenStatus === 'idle') stays 'working' across cachedStreamingCardStatus & toggle clicks.
      const ds2 = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
      (ds2.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
      await vi.advanceTimersByTimeAsync(0);
      await postTurnCard(ds2, turn2);
      (ds2.worker as any).emit('message', {
        type: 'native_input_consumed',
        turnId: turn2,
        proofKind: 'claude_transcript_user_record',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(cachedStreamingCardStatus(ds2)).toBe('working');
      updateMessageMock.mockClear();
      scheduleCardPatch(ds2, buildStreamingCardJson(ds2));
      await vi.advanceTimersByTimeAsync(0);
      expect(patchedStatuses()).toEqual(['working']);
    } finally {
      vi.mocked(resolveUsageDisplay).mockReturnValue('off');
    }
  });

  it('reconciles mid-POST completed terminals that decline idle settle (backgroundTasks, usageLimit) and keeps host screenshot_uploaded aligned', async () => {
    const turn2 = 'turn-live-0002';

    // 1. Mid-POST turn_terminal(completed) with active backgroundTasks > 0 declines idle settle -> Step 2 still reconciles card out of 'starting' to 'working'.
    const dsBg = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
    dsBg.currentTurnId = turn2;
    dsBg.streamCardPending = true;
    dsBg.streamCardPendingTurnId = turn2;
    dsBg.streamCardTurnGeneration = 2;
    let resolveBg!: (id: string) => void;
    const postingBg = postTurnStartingCard(dsBg, vi.fn(() => new Promise<string>(r => { resolveBg = r; })) as any, turn2);
    await vi.advanceTimersByTimeAsync(0);
    (dsBg.worker as any).emit('message', { type: 'screen_update', content: 'bg running', status: 'working', turnId: turn2, backgroundTasks: 2 });
    (dsBg.worker as any).emit('message', terminalMsg(turn2, 'completed'));
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();
    resolveBg('om_bg_declined');
    await postingBg;
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['working']);

    // 2. Host screenshot_uploaded in screenshot mode during folded turn must preserve 'working' (never revert to stale 'idle') and disarm foldedHostTurnId watchdog.
    const dsShot = setupLiveDs({ lastScreenStatus: 'idle', displayMode: 'screenshot' }, 'claude-code');
    (dsShot.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    await postTurnCard(dsShot, turn2);
    (dsShot.worker as any).emit('message', {
      type: 'native_input_consumed',
      turnId: turn2,
      proofKind: 'claude_transcript_user_record',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchedStatus()).toBe('working');
    updateMessageMock.mockClear();

    (dsShot.worker as any).emit('message', {
      type: 'screenshot_uploaded',
      imageKey: 'img_host_folded',
      status: 'working',
      turnId: TURN,
      captureRevision: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(dsShot.currentImageKey).toBeUndefined();
    expect(dsShot.waitingTurnPreview).toMatchObject({ imageKey: 'img_host_folded', turnId: TURN });
    expect(patchedStatuses()).toEqual(['working']);
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual([]);
  });

  it('revokes foldedHostTurnId on delivered stalled entries upon capture promotion, preserves deferred watchdogs on first attempt, and handles retry/untagged edge cases', async () => {
    const turn2 = 'turn-live-0002';

    // 1. Folded T2 degrades to 'stalled' -> capture_identity(T2) promotes capture -> late T1 idle frame must NOT clear T2's stalled badge.
    const ds1 = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
    (ds1.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    await postTurnCard(ds1, turn2);
    (ds1.worker as any).emit('message', {
      type: 'native_input_consumed',
      turnId: turn2,
      proofKind: 'claude_transcript_user_record',
    });
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(lastPatchedStatus()).toBe('stalled');
    expect(startingCardAcceptsHostTurn(ds1, TURN)).toBe(true);

    (ds1.worker as any).emit('message', { type: 'capture_identity', revision: 2, turnId: turn2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(startingCardAcceptsHostTurn(ds1, TURN)).toBe(false);
    updateMessageMock.mockClear();

    (ds1.worker as any).emit('message', { type: 'screen_update', content: 'late t1 idle', status: 'idle', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual([]);

    // 2. Deferred queued watchdog survives noteTurnDispatchAttempt(T2, 0) + predecessor screen_update before activation.
    const ds2 = setupLiveDs({ lastScreenStatus: 'idle' }, 'pi');
    (ds2.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN, dispatchAttempt: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await postTurnCard(ds2, turn2);
    noteTurnDispatchAttempt(ds2, turn2, 0);
    (ds2.worker as any).emit('message', { type: 'screen_update', content: 't1 still running', status: 'working', turnId: TURN, dispatchAttempt: 0 });
    await vi.advanceTimersByTimeAsync(0);
    (ds2.worker as any).emit('message', { type: 'capture_identity', revision: 2, turnId: turn2, dispatchAttempt: 0 });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);

    // 3. Attempt-less completed terminal does NOT gate subsequent numbered retry frames; obsolete attempt terminal does NOT wipe newer retry provenance.
    const ds3 = setupLiveDs({ lastScreenStatus: undefined }, 'claude-code');
    (ds3.worker as any).emit('message', { type: 'screen_update', content: 'run 1', status: 'working', turnId: TURN });
    (ds3.worker as any).emit('message', terminalMsg(TURN, 'completed'));
    await vi.advanceTimersByTimeAsync(2_000);
    noteTurnDispatchAttempt(ds3, TURN, 2);
    await postTurnCard(ds3, TURN);
    updateMessageMock.mockClear();
    (ds3.worker as any).emit('message', { type: 'screen_update', content: 'retry 2', status: 'working', turnId: TURN, dispatchAttempt: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['working']);
    expect(turnStartingCardStatus(ds3, 'claude-code')).toBe('working');
    // Obsolete attempt-1 terminal must not clear attempt-2's live working provenance.
    (ds3.worker as any).emit('message', { ...terminalMsg(TURN, 'completed'), dispatchAttempt: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(turnStartingCardStatus(ds3, 'claude-code')).toBe('working');

    // 4. Mid-POST untagged working screen_update reconciles starting->working via revision fallback without arming a bogus 45s stalled watchdog.
    const ds4 = setupLiveDs({ lastScreenStatus: 'idle' }, 'pi');
    ds4.currentTurnId = turn2;
    ds4.streamCardPending = true;
    ds4.streamCardPendingTurnId = turn2;
    ds4.streamCardTurnGeneration = 2;
    let resolveUntagged!: (id: string) => void;
    const postingUntagged = postTurnStartingCard(ds4, vi.fn(() => new Promise<string>(r => { resolveUntagged = r; })) as any, turn2);
    await vi.advanceTimersByTimeAsync(0);
    (ds4.worker as any).emit('message', { type: 'screen_update', content: 'untagged working', status: 'working' });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();
    resolveUntagged('om_untagged_midpost');
    await postingUntagged;
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['working']);
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual([]);
  });

  it('tracks in-flight PATCH status, screenshot idle status, folded host idle settlement, undelivered stall promotion, folded first attempt, and prompt_ready watchdog safety', async () => {
    const turn2 = 'turn-live-0002';

    // 1. In-flight working->idle PATCH must not be reverted to 'working' by a concurrent metadata flush or toggle.
    const ds1 = setupLiveDs({ lastScreenStatus: undefined }, 'claude-code');
    await postTurnCard(ds1, TURN);
    (ds1.worker as any).emit('message', { type: 'screen_update', content: 'working', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();
    let releaseIdle!: () => void;
    const delivered1: string[] = [];
    updateMessageMock.mockImplementation((...args: any[]) => {
      const status = JSON.parse(String(args[2])).status;
      if (!releaseIdle) {
        return new Promise<void>(resolve => { releaseIdle = () => { delivered1.push(status); resolve(); }; });
      }
      delivered1.push(status);
      return Promise.resolve();
    });
    (ds1.worker as any).emit('message', { type: 'screen_update', content: 'idle', status: 'idle', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    scheduleActiveRuntimePatch(ds1);
    releaseIdle();
    await vi.advanceTimersByTimeAsync(0);
    // Both the in-flight idle PATCH and the concurrent metadata flush render 'idle'
    // (never reverting to stale 'working'); identical JSON is deduped cleanly.
    expect(delivered1.every(s => s === 'idle')).toBe(true);
    expect(delivered1.length).toBeGreaterThanOrEqual(1);
    expect(cachedStreamingCardStatus(ds1)).toBe('idle');
    updateMessageMock.mockReset();
    updateMessageMock.mockImplementation(async () => {});

    // 2. screenshot_uploaded(status: 'idle') in screenshot mode updates tracked status so subsequent toggles stay 'idle'.
    const ds2 = setupLiveDs({ displayMode: 'screenshot', lastScreenStatus: undefined }, 'claude-code');
    (ds2.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    await postTurnCard(ds2, TURN);
    (ds2.worker as any).emit('message', { type: 'screen_update', content: 'working', status: 'working', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    (ds2.worker as any).emit('message', { type: 'screenshot_uploaded', imageKey: 'img_idle', status: 'idle', turnId: TURN, captureRevision: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(cachedStreamingCardStatus(ds2)).toBe('idle');

    // 3. Folded turn terminalized while capture stays on host T1: host T1 screen_update('idle') within 2s cancels settle timer yet still syncs card to 'idle'.
    const ds3 = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
    (ds3.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    await postTurnCard(ds3, turn2);
    (ds3.worker as any).emit('message', { type: 'native_input_consumed', turnId: turn2, proofKind: 'claude_transcript_user_record' });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchedStatus()).toBe('working');
    updateMessageMock.mockClear();
    (ds3.worker as any).emit('message', terminalMsg(turn2, 'completed'));
    (ds3.worker as any).emit('message', { type: 'screen_update', content: 'host idle', status: 'idle', turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['idle']);

    // 4. Undelivered folded stall retry promoted by capture_identity(T2) drops degraded, reconciles 'working', and grants fresh 45s grace window.
    const ds4 = setupLiveDs({ lastScreenStatus: 'idle' }, 'claude-code');
    (ds4.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    await vi.advanceTimersByTimeAsync(0);
    await postTurnCard(ds4, turn2);
    (ds4.worker as any).emit('message', { type: 'native_input_consumed', turnId: turn2, proofKind: 'claude_transcript_user_record' });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();
    updateMessageMock.mockRejectedValueOnce(new Error('503 stall'));
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    updateMessageMock.mockClear();
    (ds4.worker as any).emit('message', { type: 'capture_identity', revision: 2, turnId: turn2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toEqual(['working']);
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS - 1);
    expect(patchedStatuses()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(patchedStatuses()).toEqual(['stalled']);
    killWorker(ds4);

    // 5. Active folded watchdog (dispatchAttempt: undefined) survives T2's first numeric dispatchAttempt=0.
    const ds5 = setupLiveDs({ lastScreenStatus: 'idle' }, 'codex-app');
    (ds5.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN, dispatchAttempt: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await postTurnCard(ds5, turn2);
    (ds5.worker as any).emit('message', { type: 'steer_accepted', appTurnId: 'app-5', turnId: turn2 });
    await vi.advanceTimersByTimeAsync(0);
    noteTurnDispatchAttempt(ds5, turn2, 0);
    expect(startingCardAcceptsHostTurn(ds5, TURN)).toBe(true);
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
    killWorker(ds5);

    // 6. Mid-POST prompt_ready (interrupted -> idle, zero rendered frames) must NOT suppress the 45s watchdog.
    const ds6 = setupLiveDs({ lastScreenStatus: 'interrupted' }, 'pi');
    ds6.currentTurnId = turn2;
    ds6.streamCardPending = true;
    ds6.streamCardPendingTurnId = turn2;
    ds6.streamCardTurnGeneration = 2;
    let resolve6!: (id: string) => void;
    const posting6 = postTurnStartingCard(ds6, vi.fn(() => new Promise<string>(r => { resolve6 = r; })) as any, turn2);
    await vi.advanceTimersByTimeAsync(0);
    (ds6.worker as any).emit('message', { type: 'prompt_ready', turnId: turn2 });
    await vi.advanceTimersByTimeAsync(0);
    resolve6('om_prompt_ready_midpost');
    await posting6;
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual(['stalled']);
  });

  it('settles a queued starting publication to interrupted when startup fails during POST', async () => {
    const turn2 = 'turn-live-0002';
    const ds = setupLiveDs({ lastScreenStatus: 'idle' });
    (ds.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN, dispatchAttempt: 0 });
    ds.currentTurnId = turn2;
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = turn2;
    ds.streamCardTurnGeneration = 2;
    let resolvePost!: (id: string) => void;
    const replyMock = vi.fn(() => new Promise<string>(resolve => { resolvePost = resolve; }));
    const posting = postTurnStartingCard(ds, replyMock as any, turn2);
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(String(replyMock.mock.calls[0][1])).status).toBe('starting');

    (ds.worker as any).emit('message', {
      type: 'error', sessionId: SESSION, message: 'injected spawn failure', turnId: turn2, dispatchAttempt: 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.lastScreenStatus).toBe('interrupted');
    updateMessageMock.mockClear();
    resolvePost('om_queued_startup_failure');
    expect(await posting).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toContain('interrupted');
  });

  it('disarms the previous-attempt watchdog on the first working retry frame before capture advances', async () => {
    const ds = setupLiveDs({ lastScreenStatus: 'idle' });
    (ds.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN, dispatchAttempt: 0 });
    await postTurnCard(ds, TURN, 'om_retry_watchdog');
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'retry working', status: 'working', turnId: TURN, dispatchAttempt: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toContain('working');
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual([]);

    // A different, older turn must never take over the current turn's high-water.
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'late predecessor', status: 'working', turnId: 'turn-previous', dispatchAttempt: 9,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.turnDispatchAttemptHighWater).toEqual({ turnId: TURN, dispatchAttempt: 1 });
  });

  it('disarms the previous-attempt watchdog on a legacy retry screenshot before capture advances', async () => {
    const ds = setupLiveDs({ displayMode: 'screenshot', lastScreenStatus: 'idle' });
    noteTurnDispatchAttempt(ds, TURN, 0);
    await postTurnCard(ds, TURN, 'om_retry_screenshot_watchdog');
    (ds.worker as any).emit('message', {
      type: 'screenshot_uploaded', imageKey: 'img_retry_working', status: 'working', turnId: TURN, dispatchAttempt: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(patchedStatuses()).toContain('working');
    updateMessageMock.mockClear();
    await vi.advanceTimersByTimeAsync(STARTING_CARD_HEALTH_DELAY_MS);
    expect(patchedStatuses()).toEqual([]);
  });

  it('reconciles folded native acceptance received during a manual card POST', async () => {
    const turn2 = 'turn-live-0002';
    const ds = setupLiveDs({ lastScreenStatus: 'idle' });
    (ds.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    await postTurnCard(ds, turn2, 'om_folded_before_manual');
    let resolveManual!: (id: string) => void;
    const manualPosting = postFreshStreamingCard(ds, vi.fn(() => new Promise<string>(resolve => { resolveManual = resolve; })) as any);
    await vi.advanceTimersByTimeAsync(0);
    (ds.worker as any).emit('message', {
      type: 'native_input_consumed', turnId: turn2, dispatchAttempt: 0,
      proofKind: 'claude_transcript_user_record',
    });
    await vi.advanceTimersByTimeAsync(0);
    updateMessageMock.mockClear();
    resolveManual('om_manual_native_acceptance');
    expect(await manualPosting).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(cachedStreamingCardStatus(ds)).toBe('working');
    expect(patchedStatuses()).toContain('working');
  });

  it('does not resurrect native acceptance after terminal for a subsequent same-turn retry', async () => {
    const turn2 = 'turn-live-0002';
    const ds = setupLiveDs({ lastScreenStatus: 'idle' }, 'codex-app');
    (ds.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    noteTurnDispatchAttempt(ds, turn2, 0);
    await postTurnCard(ds, turn2, 'om_terminal_acceptance');
    (ds.worker as any).emit('message', { type: 'steer_accepted', appTurnId: 'app-turn-1', turnId: turn2 });
    (ds.worker as any).emit('message', { ...terminalMsg(turn2, 'completed'), dispatchAttempt: 0 });
    await vi.advanceTimersByTimeAsync(0);

    (ds.worker as any).emit('message', { type: 'steer_accepted', appTurnId: 'app-turn-1', turnId: turn2 });
    await vi.advanceTimersByTimeAsync(0);
    const retry = await postTurnCard(ds, turn2, 'om_retry_after_late_acceptance');
    expect(retry.postedStatus).toBe('starting');
  });

  it('accepts native evidence from a strictly newer attempt after the previous terminal', async () => {
    const turn2 = 'turn-live-0002';
    const ds = setupLiveDs({ lastScreenStatus: 'idle' }, 'codex-app');
    (ds.worker as any).emit('message', { type: 'capture_identity', revision: 1, turnId: TURN });
    noteTurnDispatchAttempt(ds, turn2, 0);
    await postTurnCard(ds, turn2, 'om_previous_attempt_terminal');
    (ds.worker as any).emit('message', { ...terminalMsg(turn2, 'completed'), dispatchAttempt: 0 });
    await vi.advanceTimersByTimeAsync(0);

    (ds.worker as any).emit('message', {
      type: 'native_input_consumed', turnId: turn2, dispatchAttempt: 1,
      proofKind: 'claude_transcript_user_record',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.turnDispatchAttemptHighWater).toEqual({ turnId: turn2, dispatchAttempt: 1 });
    const retry = await postTurnCard(ds, turn2, 'om_retry_with_new_native_acceptance');
    expect(retry.postedStatus).toBe('working');
  });

  it.each(['kill', 'cold-suspend'] as const)('rejects a manual card commit after %s', async mode => {
    const ds = setupLiveDs({ lastScreenStatus: 'idle' });
    await postTurnCard(ds, TURN, 'om_before_manual_invalidation');
    let resolveManual!: (id: string) => void;
    const manualPosting = postFreshStreamingCard(ds, vi.fn(() => new Promise<string>(resolve => { resolveManual = resolve; })) as any);
    await vi.advanceTimersByTimeAsync(0);
    if (mode === 'kill') killWorker(ds);
    else ds.session.suspendedColdResume = true;
    deleteMessageMock.mockClear();
    resolveManual('om_manual_after_invalidation');
    expect(await manualPosting).toBe(false);
    expect(ds.streamCardId).toBe('om_before_manual_invalidation');
    expect(deleteMessageMock).toHaveBeenCalledWith(APP, 'om_manual_after_invalidation');
  });
});
