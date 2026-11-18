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
import {
  initWorkerPool,
  setActiveSessionsRegistry,
  sweepStaleLiveCardStatuses,
  scheduleCardPatch,
  noteTurnDispatchAttempt,
  syncUsageRefreshTimer,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
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

  it('stays out of the way when a real screen_update arrives inside the window', async () => {
    const ds = makeDs();
    activate(ds);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg(TURN));
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'still drawing', status: 'working',
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(idlePatchCount()).toBe(0);
    // The screen frame is authoritative; the fallback neither patches nor logs.
    expect(ds.lastScreenStatus).toBe('working');
    expect(settleWarnings()).toHaveLength(0);
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

  it('repairs a late busy frame but does not keep PATCHing an acknowledged stable render', async () => {
    const ds = makeDs(); activate(ds); __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', terminalMsg(TURN));
    await vi.advanceTimersByTimeAsync(2_000);
    (ds.worker as any).emit('message', { type: 'screen_update', content: 'stale busy footer', status: 'working' });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(idlePatchCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(idlePatchCount()).toBe(2);
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
