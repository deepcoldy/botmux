/**
 * Behavioral coverage for the async-HTTP "settle-on-terminal" fix (core-only
 * completion bug #70).
 *
 * A turn the worker's bridge gate suppressed as GENUINE SILENCE (model
 * terminated with a bare nothing-to-send sentinel, no `botmux send`) emits
 * `turn_terminal` but NO `final_output`. Without a settle path the async-trigger
 * result stays `pending` and the HTTP poller hangs `running` until timeout.
 *
 * The fix settles such a turn to completed-with-empty-output — but ONLY on the
 * worker's explicit positive evidence `outputDisposition: 'nothing_to_send'`,
 * never on a bare `completed` terminal (the RPC-hydration timeout path emits a
 * bare `completed` with no final_output while the real answer is still
 * materializing; settling that empty would mask a lost reply).
 *
 * These drive the real worker-pool IPC handler via __testOnly_setupWorkerHandlers
 * + a fake worker (mirrors bridge-final-output-retry.test.ts) so the guards are
 * exercised, not just pinned in source.
 *
 * Run:  pnpm vitest run test/async-terminal-settle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
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
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveUsageDisplay: vi.fn(() => 'footer'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'pty', cliId: 'codex' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

// Spy the durable store so we assert persistence intent without touching disk.
const recordCompletedMock = vi.fn();
vi.mock('../src/services/async-trigger-store.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/async-trigger-store.js')>();
  return { ...actual, recordCompleted: (...args: any[]) => recordCompletedMock(...args) };
});

import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import { EventEmitter } from 'node:events';

function makeDs(): DaemonSession {
  const fakeWorker = new EventEmitter() as any;
  fakeWorker.killed = false;
  fakeWorker.send = vi.fn();
  fakeWorker.kill = vi.fn();
  fakeWorker.pid = 99999;
  fakeWorker.stdout = new EventEmitter();
  fakeWorker.stderr = new EventEmitter();
  const ds: DaemonSession = {
    session: {
      sessionId: 'sid-async-settle',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: 'codex',
    },
    worker: fakeWorker,
    workerPort: 0,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: false,
  } as any;
  return ds;
}

function terminalMsg(
  turnId: string,
  extra: Partial<Extract<WorkerToDaemon, { type: 'turn_terminal' }>> = {},
): Extract<WorkerToDaemon, { type: 'turn_terminal' }> {
  return {
    type: 'turn_terminal',
    sessionId: 'sid-async-settle',
    turnId,
    status: 'completed',
    ...extra,
  };
}

describe('async-HTTP settle-on-terminal (daemon turn_terminal handler)', () => {
  beforeEach(() => {
    recordCompletedMock.mockClear();
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('settles a pending async result to completed+empty on a nothing_to_send terminal', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([['turn-silent', { status: 'pending' } as any]]);
    ds.idempotentAsyncTurn = { triggerId: 'turn-silent' } as any;
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-silent', { outputDisposition: 'nothing_to_send' }));

    await vi.waitFor(() => {
      const r = ds.asyncTriggerResults!.get('turn-silent')!;
      expect(r.status).toBe('completed');
      expect(r.content).toBe('');
    });
    // Durable persistence with EMPTY content.
    expect(recordCompletedMock).toHaveBeenCalledWith(
      'sid-async-settle', 'turn-silent', '', expect.any(Number), 'app_test',
    );
    // Worker-exit convergence stamp cleared so a later graceful exit can't retro-fail it.
    expect(ds.idempotentAsyncTurn).toBeUndefined();
  });

  it('does NOT settle on a bare completed terminal (no disposition) — the RPC-hydration-timeout case', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([['turn-bare', { status: 'pending' } as any]]);
    ds.idempotentAsyncTurn = { triggerId: 'turn-bare' } as any;
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // Bare completed: no outputDisposition. A real answer may still be materializing.
    (ds.worker as any).emit('message', terminalMsg('turn-bare'));

    // Give the async IPC handler a tick to run.
    await new Promise(r => setTimeout(r, 20));
    const r = ds.asyncTriggerResults!.get('turn-bare')!;
    expect(r.status).toBe('pending');          // untouched — must not fabricate empty output
    expect(recordCompletedMock).not.toHaveBeenCalled();
    expect(ds.idempotentAsyncTurn).toEqual({ triggerId: 'turn-bare' });
  });

  it('does NOT settle on a failed terminal even if flagged (guard is status===completed)', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([['turn-failed', { status: 'pending' } as any]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-failed', {
      status: 'failed', errorCode: 'boom', outputDisposition: 'nothing_to_send',
    }));

    await new Promise(r => setTimeout(r, 20));
    expect(ds.asyncTriggerResults!.get('turn-failed')!.status).toBe('pending');
    expect(recordCompletedMock).not.toHaveBeenCalled();
  });

  it('does NOT clobber a final_output-completed result (pending-only guard)', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map([[
      'turn-done', { status: 'completed', content: 'real answer' } as any,
    ]]);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-done', { outputDisposition: 'nothing_to_send' }));

    await new Promise(r => setTimeout(r, 20));
    const r = ds.asyncTriggerResults!.get('turn-done')!;
    expect(r.status).toBe('completed');
    expect(r.content).toBe('real answer');       // NOT overwritten with ''
    expect(recordCompletedMock).not.toHaveBeenCalled();
  });

  it('is a no-op for a Feishu turn (no asyncTriggerResults entry)', async () => {
    const ds = makeDs();
    ds.asyncTriggerResults = new Map();          // Feishu turn: no async entry
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('turn-feishu', { outputDisposition: 'nothing_to_send' }));

    await new Promise(r => setTimeout(r, 20));
    expect(ds.asyncTriggerResults!.has('turn-feishu')).toBe(false);
    expect(recordCompletedMock).not.toHaveBeenCalled();
  });
});
