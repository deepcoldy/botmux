/**
 * PR1 mitigation: reclaim a managed TRAE worker whose executable was replaced
 * on disk, without ever killing work that still belongs to the old generation.
 *
 * Covers the safety predicate matrix, request idempotency, shared-entry
 * detection, late attestation fences, and the final-delivery retry edge.
 *
 * Run: bun x vitest run --project unit test/worker-pool-traex-install-reclaim.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { emitHookEventMock } = vi.hoisted(() => ({ emitHookEventMock: vi.fn() }));

vi.mock('../src/services/hook-runner.js', () => ({
  emitHookEvent: (...args: unknown[]) => emitHookEventMock(...args),
}));

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return { updateMessage: vi.fn(async () => {}), deleteMessage: vi.fn(async () => {}), MessageWithdrawnError };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{"type":"streaming"}'),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
  buildTuiPromptCard: vi.fn(() => '{"type":"tui"}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{"type":"tui-resolved"}'),
  getCliDisplayName: vi.fn(() => 'TRAE'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'traex' },
    resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'traex' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(), updateSession: vi.fn(), updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()), saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  ensureSessionWhiteboard: vi.fn(), persistStreamCardState: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(() => ({ tokenUsage: null })),
}));

vi.mock('../src/skills/installer.js', () => ({ ensureSkills: vi.fn() }));
vi.mock('../src/adapters/cli/registry.js', () => ({ createCliAdapterSync: vi.fn() }));
vi.mock('../src/adapters/cli/claude-code.js', () => ({ claudeJsonlPathForSession: vi.fn() }));
vi.mock('../src/adapters/backend/tmux-backend.js', () => ({ TmuxBackend: class {} }));
// This host's shared node_modules is intentionally not fully installed; the
// worker-pool import graph only needs the TOML parser symbol.
vi.mock('smol-toml', () => ({ parse: vi.fn(() => ({})) }));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import {
  initWorkerPool,
  __testOnly_setupWorkerHandlers,
  __testOnly_setSuspendBackingVerifier,
  __testOnly_canSafelyReclaimWorkerForInstallChange,
  __testOnly_runPendingSuspendIfSettled,
  __testOnly_resetOrdinaryImDeliveries,
  requestInstallChangeSuspend,
  sweepTraexInstallChanges,
  sendWorkerInput,
  hasPendingOrdinaryImInput,
  recordWorkerCliInputBacklog,
} from '../src/core/worker-pool.js';
import { beginFinalOutputDelivery } from '../src/core/final-output-delivery-drain.js';
import type { DaemonSession } from '../src/core/types.js';
import type { ExecutableIdentity } from '../src/services/cli-install-identity.js';
import { readRunningExeIdentity, resolveInstallIdentity } from '../src/services/cli-install-identity.js';
import { observeTraexInstall, __testOnly_resetTraexInstallWatch } from '../src/services/traex-install-watch.js';
import { isTraexProcess } from '../src/core/traex-leaf-pid.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';

const dirs: string[] = [];
const children: ChildProcess[] = [];

function tempEntry(content = 'traex-release'): { entry: string; identity: ExecutableIdentity } {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-traex-reclaim-'));
  dirs.push(dir);
  const entry = join(dir, 'traex');
  writeFileSync(entry, content);
  return { entry, identity: resolveInstallIdentity(entry)! };
}

function makeFakeWorker() {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.once = vi.fn();
  worker.pid = 4242;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return worker;
}

function makeDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: {
      sessionId: 'sid-traex', rootMessageId: 'om_root', chatId: 'oc_chat', title: 'TRAE',
      status: 'active', createdAt: new Date('2026-11-09T00:00:00.000Z').toISOString(), chatType: 'group',
      cliId: 'traex', workingDir: '/repo', cliSessionId: 'native-known',
    },
    worker: makeFakeWorker(),
    workerReady: true,
    lastScreenStatus: 'idle',
    workerGeneration: 7,
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1,
    lastMessageAt: 2,
    hasHistory: true,
    workingDir: '/repo',
    displayMode: 'hidden',
    lastScreenContent: '',
    initConfig: { backendType: 'tmux', cliId: 'traex' },
    ...overrides,
  } as unknown as DaemonSession;
}

function detail(
  entry: string,
  running: ExecutableIdentity,
  installed: ExecutableIdentity,
  installAtSpawn: ExecutableIdentity = running,
) {
  return { entry, running, installAtSpawn, install: installed };
}

beforeEach(() => {
  vi.clearAllMocks();
  __testOnly_resetTraexInstallWatch();
  __testOnly_setSuspendBackingVerifier(() => true);
  initWorkerPool({
    sessionReply: vi.fn(async () => 'om_notice'),
    getSessionWorkingDir: () => '/repo',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  } as any);
});

afterEach(async () => {
  __testOnly_setSuspendBackingVerifier();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise<void>(resolve => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    });
  }
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('canSafelyReclaimWorkerForInstallChange', () => {
  it('accepts a quiet, fully owned worker even though the reclaim request is queued', () => {
    const ds = makeDs();
    ds.pendingSuspendReason = 'cli_install_changed';
    ds.pendingSuspendGeneration = ds.workerGeneration;
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(true);
  });

  it('is backend-neutral: a quiet PTY worker is eligible too (retirement path)', () => {
    const ds = makeDs();
    ds.initConfig = { backendType: 'pty', cliId: 'traex' } as any;
    ds.session.backendType = 'pty';
    ds.pendingSuspendReason = 'cli_install_changed';
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(true);
  });

  it.each([
    ['no worker', (ds: DaemonSession) => { ds.worker = null; }],
    ['dead worker', (ds: DaemonSession) => { (ds.worker as any).killed = true; }],
    ['inactive session', (ds: DaemonSession) => { ds.session.status = 'suspended'; }],
    ['adopted worker', (ds: DaemonSession) => { ds.adoptedFrom = 'legacy'; }],
    ['adopt mode', (ds: DaemonSession) => { ds.initConfig = { ...ds.initConfig!, adoptMode: true } as any; }],
    ['locked by operator', (ds: DaemonSession) => { ds.session.locked = true; }],
    ['worker not ready', (ds: DaemonSession) => { ds.workerReady = false; }],
    ['protected mutation', (ds: DaemonSession) => { ds.session.queued = true; }],
    ['activation pending', (ds: DaemonSession) => { ds.session.queuedActivationPending = true; }],
    ['activation tail', (ds: DaemonSession) => { ds.session.queuedActivationTail = [{ id: 't' } as any]; }],
    ['pending prompt', (ds: DaemonSession) => { ds.pendingPrompt = 'hi'; }],
    ['pending turn id', (ds: DaemonSession) => { ds.pendingTurnId = 'turn'; }],
    ['pending raw input', (ds: DaemonSession) => { ds.pendingRawInput = 'raw'; }],
    ['pending follow-up', (ds: DaemonSession) => { ds.pendingFollowUpInput = 'f'; }],
    ['follow-up queue', (ds: DaemonSession) => { ds.pendingFollowUps = ['a']; }],
    ['cascade in flight', (ds: DaemonSession) => { ds.cascadeInFlight = true; }],
    ['cascade deferred', (ds: DaemonSession) => { ds.cascadeDeferred = ['x']; }],
    ['tui prompt', (ds: DaemonSession) => { ds.tuiPromptCardId = 'card'; }],
    ['agent attention', (ds: DaemonSession) => { ds.agentAttention = true; }],
    ['usage limit', (ds: DaemonSession) => { ds.usageLimit = true; }],
    ['background task', (ds: DaemonSession) => { ds.backgroundTaskCount = 1; }],
    ['final delivery in flight', (ds: DaemonSession) => {
      ds.finalOutputDeliveriesInFlight = new Set([Promise.resolve()]);
    }],
    ['remote close', (ds: DaemonSession) => { ds.remoteCloseState = { state: 'closing' } as any; }],
    ['repo setup', (ds: DaemonSession) => { ds.pendingRepo = { repo: 'r' } as any; }],
    ['initial start', (ds: DaemonSession) => { ds.initialStartPending = true; }],
  ])('rejects when busy: %s', (_label, mutate) => {
    const ds = makeDs();
    ds.pendingSuspendReason = 'cli_install_changed';
    mutate(ds);
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(false);
  });
});

describe('requestInstallChangeSuspend', () => {
  it('queues one request bound to the current generation', () => {
    const { entry, identity } = tempEntry();
    const ds = makeDs();
    const queued = requestInstallChangeSuspend(ds, detail(entry, identity, identity), { tryNow: false });
    expect(queued).toBe(true);
    expect(ds.pendingSuspendReason).toBe('cli_install_changed');
    expect(ds.pendingSuspendGeneration).toBe(ds.workerGeneration);
  });

  it('keeps the existing request and generation when detection repeats', () => {
    const { entry, identity } = tempEntry();
    const ds = makeDs();
    requestInstallChangeSuspend(ds, detail(entry, identity, identity), { tryNow: false });
    const generation = ds.pendingSuspendGeneration;
    expect(requestInstallChangeSuspend(ds, detail(entry, identity, identity), { tryNow: false })).toBe(false);
    expect(ds.pendingSuspendGeneration).toBe(generation);
  });

  it('never overwrites a manual suspend already queued', () => {
    const { entry, identity } = tempEntry();
    const ds = makeDs();
    ds.pendingSuspendReason = 'manual_suspend';
    ds.pendingSuspendGeneration = ds.workerGeneration;
    expect(requestInstallChangeSuspend(ds, detail(entry, identity, identity), { tryNow: false })).toBe(false);
    expect(ds.pendingSuspendReason).toBe('manual_suspend');
  });

  it('does not suspend while the generation still owns a background task, then does after it ends', () => {
    const { entry, identity } = tempEntry('release-new');
    // The worker runs the OLD image; the install entry already names the new
    // one. A claim must carry that exact stale object or the fresh
    // re-validation would (correctly) treat it as reverted.
    const stale = { ...identity, ino: `${Number(identity.ino) + 1}`, source: 'linux-proc-exe' as const };
    const ds = makeDs({
      localProcessAttestation: {
        backendType: 'tmux', credentialIsolated: false, cliExe: stale, cliInstallEntry: entry, cliSpawnGeneration: 1,
      },
    });
    const worker = ds.worker as any;
    ds.backgroundTaskCount = 1;
    requestInstallChangeSuspend(ds, detail(entry, stale, identity), { tryNow: true });
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.pendingSuspendReason).toBe('cli_install_changed');

    ds.backgroundTaskCount = 0;
    __testOnly_runPendingSuspendIfSettled(ds);
    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
  });
});

describe('sweepTraexInstallChanges', () => {
  it('queues every stale worker sharing one install entry and leaves current workers alone', () => {
    const { entry, identity } = tempEntry('release-0.213.1');
    const stale = { ...identity, ino: `${Number(identity.ino) + 1}`, source: 'linux-proc-exe' as const };
    const attestation = (exe: ExecutableIdentity) => ({
      backendType: 'tmux' as const, credentialIsolated: false, cliExe: exe, cliInstallEntry: entry,
      cliInstallAtSpawn: exe,
    });

    const a = makeDs({ lastScreenStatus: 'working', localProcessAttestation: attestation(stale) });
    const b = makeDs({ lastScreenStatus: 'working', localProcessAttestation: attestation(stale) });
    const c = makeDs({ lastScreenStatus: 'working', localProcessAttestation: attestation(identity) });

    expect(sweepTraexInstallChanges([a, b, c], { cliId: 'traex' }, 1_000)).toBe(2);
    expect(a.pendingSuspendReason).toBe('cli_install_changed');
    expect(b.pendingSuspendReason).toBe('cli_install_changed');
    expect(c.pendingSuspendReason).toBeUndefined();
  });

  it('leaves a worker running a user-pinned old executable alone', () => {
    // A pinned config points the install entry at the very binary the worker
    // launched, so the running inode still matches — no reclaim, no config edit.
    const { entry, identity } = tempEntry('pinned-0.213.1');
    const pinned = makeDs({
      lastScreenStatus: 'idle',
      localProcessAttestation: {
        backendType: 'tmux', credentialIsolated: false, cliExe: identity, cliInstallEntry: entry,
        cliInstallAtSpawn: identity,
      },
    });
    expect(sweepTraexInstallChanges([pinned], { cliId: 'traex' }, 3_000)).toBe(0);
    expect(pinned.pendingSuspendReason).toBeUndefined();
  });

  it('does not touch non-TRAE, unknown, or adopted workers', () => {
    const { entry, identity } = tempEntry();
    const stale = { ...identity, ino: `${Number(identity.ino) + 1}`, source: 'linux-proc-exe' as const };
    const unknown = makeDs({ localProcessAttestation: undefined });
    const adopted = makeDs({
      adoptedFrom: 'legacy',
      localProcessAttestation: { backendType: 'tmux', credentialIsolated: false, cliExe: stale, cliInstallEntry: entry },
    });
    const otherCli = makeDs({
      session: { ...makeDs().session, cliId: 'claude-code' },
      localProcessAttestation: { backendType: 'tmux', credentialIsolated: false, cliExe: stale, cliInstallEntry: entry },
    });

    expect(sweepTraexInstallChanges([unknown, adopted, otherCli], { cliId: 'traex' }, 2_000)).toBe(0);
  });
});

describe('attestation fences', () => {
  it('ignores an attestation from a replaced worker generation', async () => {
    const { entry, identity } = tempEntry();
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);
    const reserved = ds.workerGeneration!;
    ds.workerGeneration = reserved + 1;

    worker.emit('message', {
      type: 'local_process_attestation', backendType: 'tmux', credentialIsolated: false,
      cliExe: identity, cliInstallEntry: entry, cliSpawnGeneration: 1,
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(ds.localProcessAttestation).toBeUndefined();
  });

  it('ignores a late attestation from an older CLI spawn of the same worker', async () => {
    const { entry, identity } = tempEntry();
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);
    ds.localProcessAttestation = {
      backendType: 'tmux', credentialIsolated: false, cliExe: identity, cliInstallEntry: entry, cliSpawnGeneration: 3,
    };
    const newer = { ...identity, ino: '999', source: 'linux-proc-exe' as const };

    worker.emit('message', {
      type: 'local_process_attestation', backendType: 'tmux', credentialIsolated: false,
      cliExe: newer, cliInstallEntry: entry, cliSpawnGeneration: 2,
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ds.localProcessAttestation!.cliExe!.ino).toBe(identity.ino);

    worker.emit('message', {
      type: 'local_process_attestation', backendType: 'tmux', credentialIsolated: false,
      cliExe: newer, cliInstallEntry: entry, cliSpawnGeneration: 4,
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ds.localProcessAttestation!.cliExe!.ino).toBe('999');
  });
});

describe('final delivery retry edge', () => {
  it('waits for an in-flight final answer, then reclaims when the delivery settles', () => {
    const { entry, identity } = tempEntry('release-new');
    const stale = { ...identity, ino: `${Number(identity.ino) + 1}`, source: 'linux-proc-exe' as const };
    const ds = makeDs({
      localProcessAttestation: {
        backendType: 'tmux', credentialIsolated: false, cliExe: stale, cliInstallEntry: entry, cliSpawnGeneration: 1,
      },
    });
    const worker = ds.worker as any;
    // A real claim (not just the reason string): the strict safe-reclaim
    // predicate only applies to install claims, so the final-delivery guard
    // has to be exercised through the same path production uses.
    requestInstallChangeSuspend(ds, detail(entry, stale, identity), { tryNow: false });
    const finish = beginFinalOutputDelivery(ds, 'turn-1');

    __testOnly_runPendingSuspendIfSettled(ds);
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });

    finish();
    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.worker).toBeNull();
  });
});

describe('independent review regressions', () => {
  it('combines upstream backlog protection with the install-claim settle predicate', async () => {
    const { entry, identity } = tempEntry('release-new');
    const stale = { ...identity, ino: `${Number(identity.ino) + 1}`, source: 'linux-proc-exe' as const };
    const ds = makeDs({
      localProcessAttestation: {
        backendType: 'tmux', credentialIsolated: false, cliExe: stale, cliInstallEntry: entry, cliSpawnGeneration: 1,
      },
    });
    const worker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, worker);
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));

    // #3136 guard: the CLI has not taken the input yet. Even with a real
    // install claim pending, nothing may be retired in this window.
    recordWorkerCliInputBacklog(worker, { pending: true, writingTurnId: 'om_combo' });
    requestInstallChangeSuspend(ds, detail(entry, stale, identity), { tryNow: false });
    __testOnly_runPendingSuspendIfSettled(ds);
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });

    // Backlog drained, but the worker queue has accepted the turn: the input
    // exists only inside the CLI now, so it still blocks the reclaim.
    recordWorkerCliInputBacklog(worker, { pending: false });
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_combo' });
    await flush();
    __testOnly_runPendingSuspendIfSettled(ds);
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });

    // Turn settled, but its final answer is still being delivered.
    const finish = beginFinalOutputDelivery(ds, 'turn-combo');
    worker.emit('message', { type: 'turn_terminal', turnId: 'om_combo', sessionId: ds.session.sessionId });
    await flush();
    __testOnly_runPendingSuspendIfSettled(ds);
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });

    // Every obligation is settled: the queued reclaim finally runs.
    finish();
    __testOnly_runPendingSuspendIfSettled(ds);
    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.worker).toBeNull();
  });

  it('settles an early native receipt together with its later explicit commit', async () => {
    const ds = makeDs();
    const worker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, worker);
    // TRAE supports RPC input. worker.ts emits native acceptance immediately
    // after sendTurn(), before the deferred explicit-attempt commit below.
    worker.emit('message', { type: 'native_input_consumed', turnId: 'om_native_first', proofKind: 'codex_rpc_turn_start' });
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_native_first', dispatchAttempt: 2 });
    worker.emit('message', { type: 'turn_terminal', turnId: 'om_native_first', dispatchAttempt: 2, sessionId: ds.session.sessionId });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(true);
  });

  it('does not assume an un-attempted native receipt belongs to an older settled attempt', async () => {
    const ds = makeDs();
    const worker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'turn_terminal', turnId: 'om_native_retry', dispatchAttempt: 1, sessionId: ds.session.sessionId });
    // This can be the new attempt's submit proof before its commit ACK. An
    // attempt-1 terminal alone cannot prove it is an attempt-1 duplicate.
    worker.emit('message', { type: 'native_input_consumed', turnId: 'om_native_retry', proofKind: 'codex_rpc_turn_start' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(false);
  });

  it('keeps automatic reclaim blocked after unresolved obligations exceed the actual cap', async () => {
    const ds = makeDs();
    const worker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, worker);
    for (let index = 0; index < 4097; index += 1) {
      worker.emit('message', { type: 'turn_input_committed', turnId: `om_overflow_${index}` });
    }
    expect(ds.acceptedInputOverflow).toBe(true);
    for (let index = 0; index < 4097; index += 1) {
      worker.emit('message', { type: 'turn_terminal', turnId: `om_overflow_${index}`, sessionId: ds.session.sessionId });
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(false);
  });

  it('settles a native receipt carrying the same explicit attempt as commit/terminal', async () => {
    const ds = makeDs();
    const worker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'native_input_consumed', turnId: 'om_native_exact', dispatchAttempt: 2, proofKind: 'codex_rpc_turn_start' });
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_native_exact', dispatchAttempt: 2 });
    worker.emit('message', { type: 'turn_terminal', turnId: 'om_native_exact', dispatchAttempt: 2, sessionId: ds.session.sessionId });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(true);
  });

  it('does not let an older attempt native receipt or terminal release a newer attempt', async () => {
    const ds = makeDs();
    const worker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_native_late', dispatchAttempt: 2 });
    // A late attempt-1 native proof must not downgrade/duplicate the live
    // attempt-2 obligation, and a late attempt-1 terminal must not settle it.
    worker.emit('message', { type: 'native_input_consumed', turnId: 'om_native_late', dispatchAttempt: 1, proofKind: 'codex_rpc_turn_start' });
    worker.emit('message', { type: 'turn_terminal', turnId: 'om_native_late', dispatchAttempt: 1, sessionId: ds.session.sessionId });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(false);
    worker.emit('message', { type: 'turn_terminal', turnId: 'om_native_late', dispatchAttempt: 2, sessionId: ds.session.sessionId });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(true);
  });

  it('does not revive completed work when a committed duplicate is re-ACKed', async () => {
    const ds = makeDs();
    const worker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_done' });
    worker.emit('message', { type: 'turn_terminal', turnId: 'om_done', sessionId: ds.session.sessionId });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(true);
    // worker.ts explicitly re-ACKs committed duplicates, including ones whose
    // native turn has already terminated; a transport retry is not new work.
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_done' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(true);
  });

  it('does not release a later attempt on an older attempt terminal', async () => {
    const ds = makeDs();
    const worker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_retry', dispatchAttempt: 2 });
    worker.emit('message', { type: 'turn_terminal', turnId: 'om_retry', dispatchAttempt: 1, sessionId: ds.session.sessionId });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(false);
  });

  it('keeps an explicit attempt protected when a terminal carries no attempt', async () => {
    const ds = makeDs();
    const worker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_no_attempt', dispatchAttempt: 2 });
    // An un-attempted receipt cannot prove it is the attempt-2 execution.
    worker.emit('message', { type: 'turn_terminal', turnId: 'om_no_attempt', sessionId: ds.session.sessionId });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(false);
  });

  it('allows a rejected input to be re-accepted under the same identity', async () => {
    const ds = makeDs();
    const worker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_retryable' });
    worker.emit('message', { type: 'turn_input_rejected', turnId: 'om_retryable', reason: 'worker_busy', rejectedBeforeAdmission: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(true);
    // The retry is accepted again: it is new work and must be protected.
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_retryable' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(false);
  });

  it('never evicts an unresolved input obligation to bound observation memory', async () => {
    const ds = makeDs();
    const worker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_unresolved' });
    for (let index = 0; index < 512; index += 1) {
      worker.emit('message', { type: 'turn_input_committed', turnId: `om_done_${index}` });
    }
    for (let index = 0; index < 512; index += 1) {
      worker.emit('message', { type: 'turn_terminal', turnId: `om_done_${index}`, sessionId: ds.session.sessionId });
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(false);
  });

  it('protects a TRAE turn the worker queue committed before the native PTY write', async () => {
    __testOnly_resetOrdinaryImDeliveries();
    const { entry, identity } = tempEntry('release-new');
    const old = { ...identity, ino: `${Number(identity.ino) + 1}`, source: 'linux-proc-exe' as const };
    const ds = makeDs({
      localProcessAttestation: {
        backendType: 'tmux', credentialIsolated: false, cliExe: old, cliInstallEntry: entry, cliSpawnGeneration: 1,
      },
    });
    const worker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, 'queued native work', 'om_review_queued')).toBe(true);
    expect(hasPendingOrdinaryImInput(ds)).toBe(true);
    // TRAE's commit ACK means the worker QUEUE owns the turn; the asynchronous
    // PTY flush has not run and the screen may still show a cached idle.
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_review_queued' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(hasPendingOrdinaryImInput(ds)).toBe(false);
    expect(ds.lastScreenStatus).toBe('idle');

    requestInstallChangeSuspend(ds, detail(entry, old, identity), { tryNow: true });
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });
  });

  it('releases the accepted-input guard only on the exact turn terminal', async () => {
    __testOnly_resetOrdinaryImDeliveries();
    const { entry, identity } = tempEntry('release-new');
    const old = { ...identity, ino: `${Number(identity.ino) + 1}`, source: 'linux-proc-exe' as const };
    const ds = makeDs({
      localProcessAttestation: {
        backendType: 'tmux', credentialIsolated: false, cliExe: old, cliInstallEntry: entry, cliSpawnGeneration: 1,
      },
    });
    const worker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, 'queued native work', 'om_review_queued')).toBe(true);
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_review_queued' });
    await new Promise(resolve => setTimeout(resolve, 0));
    requestInstallChangeSuspend(ds, detail(entry, old, identity), { tryNow: false });

    __testOnly_runPendingSuspendIfSettled(ds);
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });

    // The turn finishes: the guard releases and the queued reclaim proceeds.
    worker.emit('message', { type: 'turn_terminal', turnId: 'om_review_queued', sessionId: ds.session.sessionId });
    await new Promise(resolve => setTimeout(resolve, 0));
    __testOnly_runPendingSuspendIfSettled(ds);
    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
  });

  it('must not suspend a replacement CLI for the old spawn install-change claim', () => {
    const { entry, identity } = tempEntry('release-new');
    const old = { ...identity, ino: `${Number(identity.ino) + 1}`, source: 'linux-proc-exe' as const };
    const ds = makeDs({
      lastScreenStatus: 'working',
      localProcessAttestation: {
        backendType: 'tmux', credentialIsolated: false, cliExe: old, cliInstallEntry: entry, cliSpawnGeneration: 1,
      },
    });
    const worker = ds.worker as any;
    requestInstallChangeSuspend(ds, detail(entry, old, identity), { tryNow: true });
    // In-worker restart: the worker generation is unchanged, its CLI becomes current.
    ds.localProcessAttestation = {
      backendType: 'tmux', credentialIsolated: false, cliExe: identity, cliInstallEntry: entry, cliSpawnGeneration: 2,
    };
    ds.lastScreenStatus = 'idle';
    __testOnly_runPendingSuspendIfSettled(ds);
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });
  });

  it('must cancel an install-change claim if the selected install reverts before idle', () => {
    const { entry, identity } = tempEntry('selected-old-release');
    const changed = { ...identity, ino: `${Number(identity.ino) + 1}`, source: 'install-stat' as const };
    const ds = makeDs({
      lastScreenStatus: 'working',
      localProcessAttestation: {
        backendType: 'tmux', credentialIsolated: false, cliExe: identity, cliInstallEntry: entry, cliSpawnGeneration: 1,
      },
    });
    const worker = ds.worker as any;
    requestInstallChangeSuspend(ds, detail(entry, identity, changed), { tryNow: true });
    // The selected entry names the old image again before the turn completes.
    ds.lastScreenStatus = 'idle';
    __testOnly_runPendingSuspendIfSettled(ds);
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });
  });
});

describe('launch provenance', () => {
  it('never queues a claim for a running image the entry did not name at spawn', () => {
    const { entry, identity } = tempEntry('wrapper-script');
    const real = { ...identity, ino: `${Number(identity.ino) + 1}`, source: 'linux-proc-exe' as const };
    const ds = makeDs({
      localProcessAttestation: {
        backendType: 'tmux', credentialIsolated: false, cliExe: real, cliInstallEntry: entry,
        cliInstallAtSpawn: identity, cliSpawnGeneration: 1,
      },
    });
    expect(observeTraexInstall(ds, 'traex')).toMatchObject({ state: 'unknown', reason: 'launch-unproven' });
    expect(sweepTraexInstallChanges([ds], { cliId: 'traex' })).toBe(0);
    expect(requestInstallChangeSuspend(ds, detail(entry, real, identity, identity), { tryNow: true })).toBe(false);
    expect(ds.pendingSuspendReason).toBeUndefined();
    expect((ds.worker as any).send).not.toHaveBeenCalledWith({ type: 'suspend' });
  });

  it('re-validates a queued claim by the same launched-from-entry rule', () => {
    const { entry, identity } = tempEntry('release-new');
    const old = { ...identity, ino: `${Number(identity.ino) + 1}`, source: 'linux-proc-exe' as const };
    const ds = makeDs({
      lastScreenStatus: 'working',
      localProcessAttestation: {
        backendType: 'tmux', credentialIsolated: false, cliExe: old, cliInstallEntry: entry,
        cliInstallAtSpawn: old, cliSpawnGeneration: 1,
      },
    });
    const worker = ds.worker as any;
    expect(requestInstallChangeSuspend(ds, detail(entry, old, identity), { tryNow: true })).toBe(true);
    ds.pendingSuspendInstallClaim = { ...ds.pendingSuspendInstallClaim!, installAtSpawn: identity };
    ds.lastScreenStatus = 'idle';
    __testOnly_runPendingSuspendIfSettled(ds);
    // Unknown: kept for a later checkpoint, never consumed as a suspend.
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.pendingSuspendReason).toBe('cli_install_changed');
  });

  it('records the spawn-time install identity the worker attested', async () => {
    const { entry, identity } = tempEntry();
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', {
      type: 'local_process_attestation', backendType: 'tmux', credentialIsolated: false,
      cliExe: identity, cliInstallEntry: entry, cliInstallAtSpawn: identity, cliSpawnGeneration: 1,
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ds.localProcessAttestation?.cliInstallAtSpawn).toEqual(identity);
    expect(observeTraexInstall(ds, 'traex').state).toBe('current');
  });
});

describe.skipIf(process.platform !== 'linux')('launch provenance with real processes', () => {
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  function comm(pid: number): string | undefined {
    try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return undefined; }
  }

  function tempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-traex-launch-'));
    dirs.push(dir);
    return dir;
  }

  /** A fake TRAE release: a copy of `bin` named `traex`, so comm and exe look real. */
  function release(root: string, name: string, bin = '/bin/sleep'): string {
    const dir = join(root, 'releases', name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'traex');
    copyFileSync(bin, file);
    chmodSync(file, 0o755);
    return file;
  }

  /** Standard versioned layout: `bin/traex -> ../current/traex`, `current -> releases/<name>`. */
  function versionedEntry(root: string, name: string): string {
    symlinkSync(`releases/${name}`, join(root, 'current'));
    mkdirSync(join(root, 'bin'));
    symlinkSync('../current/traex', join(root, 'bin', 'traex'));
    return join(root, 'bin', 'traex');
  }

  function flip(root: string, name: string): void {
    unlinkSync(join(root, 'current'));
    symlinkSync(`releases/${name}`, join(root, 'current'));
    __testOnly_resetTraexInstallWatch();
  }

  /** Launch the way worker.ts does: stat the entry right before spawn, then
   *  attest the TRAE leaf's kernel exe once it is up. */
  async function launch(entry: string, args: string[], cliSpawnGeneration = 1) {
    const cliInstallAtSpawn = resolveInstallIdentity(entry);
    const child = spawn(entry, args, { stdio: 'ignore' });
    children.push(child);
    const pid = child.pid!;
    for (let i = 0; i < 300 && comm(pid) !== 'traex'; i++) await sleep(10);
    const cliProcStart = readProcessStartIdentity(pid);
    const cliExe = isTraexProcess(pid) ? readRunningExeIdentity(pid, cliProcStart) : undefined;
    return {
      child,
      pid,
      attestation: {
        backendType: 'tmux' as const,
        credentialIsolated: false,
        cliPid: pid,
        ...(cliProcStart ? { cliProcStart } : {}),
        ...(cliExe ? { cliExe } : {}),
        cliInstallEntry: entry,
        ...(cliInstallAtSpawn ? { cliInstallAtSpawn } : {}),
        cliSpawnGeneration,
      },
    };
  }

  function exited(child: ChildProcess): Promise<void> {
    return new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    });
  }

  it('reclaims a process whose versioned entry was flipped to a new release', async () => {
    const root = tempRoot();
    release(root, '1.0.0');
    release(root, '1.1.0');
    const entry = versionedEntry(root, '1.0.0');
    const { attestation } = await launch(entry, ['60']);
    expect(attestation.cliExe).toBeDefined();
    const ds = makeDs({ localProcessAttestation: attestation });
    expect(observeTraexInstall(ds, 'traex').state).toBe('current');

    flip(root, '1.1.0');
    expect(sweepTraexInstallChanges([ds], { cliId: 'traex' })).toBe(1);
    expect(ds.worker).toBeNull();
  });

  it('leaves a wrapper-script entry alone: it never names the running image', async () => {
    const root = tempRoot();
    const real = release(root, '1.0.0');
    const wrapper = join(root, 'traex-wrapper.sh');
    writeFileSync(wrapper, `#!/bin/sh\nexec '${real}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    const { attestation } = await launch(wrapper, ['60']);
    expect(attestation.cliExe).toBeDefined();
    const ds = makeDs({ localProcessAttestation: attestation });
    const worker = ds.worker as any;

    expect(observeTraexInstall(ds, 'traex')).toMatchObject({ state: 'unknown', reason: 'launch-unproven' });
    expect(sweepTraexInstallChanges([ds], { cliId: 'traex' })).toBe(0);
    expect(ds.pendingSuspendReason).toBeUndefined();
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });
  });

  it('does not reclaim a process that re-execs into the new release before the checkpoint', async () => {
    const root = tempRoot();
    release(root, '1.0.0', '/bin/sh');
    const next = release(root, '1.1.0');
    const entry = versionedEntry(root, '1.0.0');
    const { pid, attestation } = await launch(entry, ['-c', `sleep 1.5; exec '${next}' 60`]);
    const ds = makeDs({ lastScreenStatus: 'working', localProcessAttestation: attestation });
    const worker = ds.worker as any;
    flip(root, '1.1.0');
    expect(sweepTraexInstallChanges([ds], { cliId: 'traex' })).toBe(1);

    const install = resolveInstallIdentity(entry)!;
    for (let i = 0; i < 500; i++) {
      const now = readRunningExeIdentity(pid, attestation.cliProcStart);
      if (now?.dev === install.dev && now.ino === install.ino) break;
      await sleep(10);
    }
    expect(readRunningExeIdentity(pid, attestation.cliProcStart)?.ino).toBe(install.ino);

    ds.lastScreenStatus = 'idle';
    __testOnly_runPendingSuspendIfSettled(ds);
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.pendingSuspendReason).toBeUndefined();
  }, 15_000);

  it('keeps the claim but never suspends while the attested process cannot be read', async () => {
    const root = tempRoot();
    release(root, '1.0.0');
    release(root, '1.1.0');
    const entry = versionedEntry(root, '1.0.0');
    const first = await launch(entry, ['60']);
    const ds = makeDs({ lastScreenStatus: 'working', localProcessAttestation: first.attestation });
    const worker = ds.worker as any;
    flip(root, '1.1.0');
    expect(sweepTraexInstallChanges([ds], { cliId: 'traex' })).toBe(1);

    // In-worker CLI restart: the old process is gone and its replacement has
    // not attested yet, so the attestation still names the dead pid.
    await exited(first.child);
    ds.lastScreenStatus = 'idle';
    __testOnly_runPendingSuspendIfSettled(ds);
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.pendingSuspendInstallClaim).toBeDefined();

    // The replacement's own attestation consumes the old claim instead of
    // applying it to the new process.
    const second = await launch(entry, ['60'], 2);
    ds.localProcessAttestation = second.attestation;
    __testOnly_runPendingSuspendIfSettled(ds);
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.pendingSuspendReason).toBeUndefined();
  });
});

describe('same-turn steer settlement', () => {
  it('settles a steered turn on thinking_superseded so the merged terminal frees the reclaim', async () => {
    const { entry, identity } = tempEntry('release-new');
    const old = { ...identity, ino: `${Number(identity.ino) + 1}`, source: 'linux-proc-exe' as const };
    const ds = makeDs({
      localProcessAttestation: {
        backendType: 'tmux', credentialIsolated: false, cliExe: old, cliInstallEntry: entry,
        cliInstallAtSpawn: old, cliSpawnGeneration: 1,
      },
    });
    const worker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, worker);
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));

    // The bridge queue merged t1 into t2: t1 only gets thinking_superseded,
    // and the merged answer is t2's terminal.
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_t1', dispatchAttempt: 1 });
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_t2', dispatchAttempt: 1 });
    worker.emit('message', { type: 'thinking_superseded', sessionId: ds.session.sessionId, turnId: 'om_t1', dispatchAttempt: 1 });
    await flush();
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(false);

    // A re-sent commit ACK for the steered attempt is a transport retry, not new work.
    worker.emit('message', { type: 'turn_input_committed', turnId: 'om_t1', dispatchAttempt: 1 });
    worker.emit('message', { type: 'turn_terminal', turnId: 'om_t2', dispatchAttempt: 1, sessionId: ds.session.sessionId });
    await flush();
    expect(__testOnly_canSafelyReclaimWorkerForInstallChange(ds)).toBe(true);

    requestInstallChangeSuspend(ds, detail(entry, old, identity), { tryNow: true });
    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
  });
});
