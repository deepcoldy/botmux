/**
 * `ds.cliReady` / `ds.cliReadyGeneration` — the in-memory CLI-prompt readiness
 * flag introduced for the command router's SessionPhase derivation
 * (docs/design/2026-09-11-command-router.md §5).
 *
 * Drives the REAL worker IPC handlers via __testOnly_setupWorkerHandlers with a
 * fake worker (same harness shape as test/stuck-warning-integration.test.ts),
 * so these are behavioural assertions, not source greps.
 *
 * Invariants under test:
 *   1. `prompt_ready` is the ONLY set point; it bumps a monotonic generation.
 *   2. `ready` (worker init done) does NOT clear it — on riff/mojo and fast
 *      TUIs `prompt_ready` legitimately arrives BEFORE `ready`, so clearing
 *      there would erase a just-set value and the phase machine would never
 *      see those sessions reach `ready`.
 *   3. `claude_exit`, an in-worker `restart`, and worker retirement clear the
 *      flag, but NEVER rewind the generation counter.
 *   4. A stale worker generation cannot set the flag.
 *
 * Run:  bun run vitest run test/session-cli-ready.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  initWorkerPool,
  killWorker,
  requestSessionRestart,
  __testOnly_setupWorkerHandlers,
  __testOnly_resetRestartCoordinator,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  MessageWithdrawnError: class extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildTuiPromptCard: vi.fn(() => '{"type":"tui_prompt"}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  buildTuiPromptFailedCard: vi.fn(() => '{}'),
  buildTuiPromptProcessingCard: vi.fn(() => '{}'),
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
  getSession: vi.fn(() => undefined),
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

let sid = 0;

function makeDs(overrides?: Partial<DaemonSession>): DaemonSession {
  sid += 1;
  return {
    session: {
      sessionId: `sid-cli-ready-${sid}`,
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

/** A wired-up session with its real IPC handlers installed on a fake worker. */
function wire(overrides?: Partial<DaemonSession>) {
  const worker = makeFakeWorker();
  const ds = makeDs({ worker, ...overrides });
  __testOnly_setupWorkerHandlers(ds, worker);
  return { ds, worker };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('ds.cliReady (command-router §5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testOnly_resetRestartCoordinator();
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_card'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
  });

  it('starts unset — nothing is ready before the CLI says so', () => {
    const { ds } = wire();
    expect(ds.cliReady).toBeUndefined();
    expect(ds.cliReadyGeneration).toBeUndefined();
  });

  it('prompt_ready sets the flag and bumps the generation each time', async () => {
    const { ds, worker } = wire();

    worker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(ds.cliReady).toBe(true);
    expect(ds.cliReadyGeneration).toBe(1);

    // A second idle observation is a DISTINCT readiness event: the cascade
    // sequencer waits on the counter, not on the boolean.
    worker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(ds.cliReady).toBe(true);
    expect(ds.cliReadyGeneration).toBe(2);
  });

  it('prompt_ready from a replaced worker generation does not set the flag', async () => {
    const { ds, worker } = wire();
    // The session has already moved on to a replacement worker.
    ds.worker = makeFakeWorker();

    worker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(ds.cliReady).toBeUndefined();
    expect(ds.cliReadyGeneration).toBeUndefined();
  });

  it('ready does NOT clear a flag prompt_ready already set', async () => {
    const { ds, worker } = wire();

    // The riff/mojo/fast-TUI ordering: the prompt is announced BEFORE the
    // worker finishes init and reports `ready`.
    worker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(ds.cliReady).toBe(true);

    worker.emit('message', { type: 'ready', port: 0, token: '', viewToken: '' });
    await flush();

    expect(ds.workerReady).toBe(true);
    // The whole point of the flag: `ready` is worker-init state, not CLI-prompt
    // state, so it must leave cliReady alone.
    expect(ds.cliReady).toBe(true);
    expect(ds.cliReadyGeneration).toBe(1);
  });

  it('claude_exit clears the flag but never rewinds the generation', async () => {
    const { ds, worker } = wire();

    worker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(ds.cliReady).toBe(true);
    expect(ds.cliReadyGeneration).toBe(1);

    worker.emit('message', { type: 'claude_exit', code: 0, signal: null });
    await flush();

    expect(ds.cliReady).toBe(false);
    expect(ds.cliReadyGeneration).toBe(1);
  });

  it('an in-worker restart clears the flag but never rewinds the generation', async () => {
    const { ds, worker } = wire();

    worker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(ds.cliReady).toBe(true);

    const joined = requestSessionRestart(ds, {
      onReady: vi.fn(),
      onFailed: vi.fn(),
    } as any);
    expect(joined).toBeTruthy();
    expect(worker.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'restart' }),
    );

    expect(ds.cliReady).toBe(false);
    expect(ds.cliReadyGeneration).toBe(1);

    // The NEXT generation's prompt_ready is what makes it ready again, and it
    // is distinguishable from the pre-restart one by the counter.
    worker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(ds.cliReady).toBe(true);
    expect(ds.cliReadyGeneration).toBe(2);
  });

  it('retiring the worker clears the flag', async () => {
    const { ds, worker } = wire();

    worker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(ds.cliReady).toBe(true);

    killWorker(ds);

    expect(ds.worker).toBeNull();
    expect(ds.cliReady).toBe(false);
    expect(ds.cliReadyGeneration).toBe(1);
  });

  it('worker process exit clears the flag', async () => {
    const { ds, worker } = wire();

    worker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(ds.cliReady).toBe(true);

    worker.killed = true;
    worker.emit('exit', 1, null);
    await flush();

    expect(ds.cliReady).toBe(false);
    expect(ds.cliReadyGeneration).toBe(1);
  });
});
