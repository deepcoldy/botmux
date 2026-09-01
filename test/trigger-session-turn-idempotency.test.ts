/**
 * End-to-end tests for TURN-LEVEL idempotency (契約①, PR #71): a follow-up async
 * turn on an EXISTING session, keyed by options.turnIdempotencyKey. Drives the
 * REAL triggerSessionTurn deliverToExisting path against the REAL idempotency- +
 * async-trigger-store (temp SESSION_DATA_DIR). Boundaries (lark / session-store /
 * worker-pool) mocked so we can drive the worker-live (sendWorkerInput) and
 * dormant (forkWorker) dispatch branches and assert the at-most-once lease.
 *
 * The turn lease is stored under the unforgeable `turn` store kind (codex #818
 * P1-2 — a domain separator baked into the key digest, NOT a user-constructable
 * string prefix) and reuses the same reserved→attempting barrier + per-triggerId
 * worker-exit convergence as the fresh-session key.
 *
 * Run:  pnpm vitest run test/trigger-session-turn-idempotency.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import type { DaemonSession } from '../src/core/types.js';

let tempDir: string;
let prevDataDir: string | undefined;

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/im/lark/client.js', () => ({
  getMessageChatId: vi.fn(),
  getChatMode: vi.fn(async () => 'group'),
  sendMessage: vi.fn(async () => 'om_x'),
  replyMessage: vi.fn(async () => 'om_x'),
  listChatBotMembers: vi.fn(async () => []),
}));

const mockGetBot = vi.fn(() => ({ config: { cliId: 'codex-app', apiOnly: true } }));
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...a: any[]) => mockGetBot(...a),
  effectiveDefaultWorkingDir: vi.fn(() => '/tmp'),
}));

vi.mock('../src/services/groups-store.js', () => ({ isInChat: vi.fn(async () => true) }));
vi.mock('../src/services/oncall-store.js', () => ({ getOncallStatus: vi.fn(() => undefined) }));

const existingRows: any[] = [];
vi.mock('../src/services/session-store.js', () => ({
  createSession: vi.fn(),
  updateSession: vi.fn(),
  getSession: vi.fn((id: string) => existingRows.find(s => s.sessionId === id)),
  getOwnedSession: vi.fn((id: string) => existingRows.find(s => s.sessionId === id)),
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
}));

vi.mock('../src/services/message-queue.js', () => ({ ensureQueue: vi.fn() }));
vi.mock('../src/core/session-manager.js', () => ({
  buildFollowUpContent: vi.fn((p: string) => p),
  buildFollowUpCliInput: vi.fn((p: string) => ({ content: p })),
  buildNewTopicPrompt: vi.fn((p: string) => p),
  buildNewTopicCliInput: vi.fn((p: string) => ({ content: p })),
  ensureSessionWhiteboard: vi.fn(),
  getAvailableBots: vi.fn(async () => []),
  rememberLastCliInput: vi.fn(),
}));
vi.mock('../src/services/default-worktree.js', () => ({ botAutoWorktreeEnabled: vi.fn(() => false) }));
vi.mock('../src/im/lark/card-handler.js', () => ({ runAutoWorktreeCommit: vi.fn(async () => {}) }));

// worker-pool: sendWorkerInput (worker-live) + forkWorker (dormant) are the two
// dispatch side effects. Either can be made to throw/refuse on demand.
let forkShouldThrow = false;
let sendShouldRefuse = false;
let queuedActivationGateActive = false;
const mockForkWorker = vi.fn(() => { if (forkShouldThrow) throw new Error('injected fork failure'); });
const mockSendWorkerInput = vi.fn(() => !sendShouldRefuse);
const mockCloseSession = vi.fn(async () => ({ ok: true, alreadyClosed: false, known: true }));
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: (...a: any[]) => mockForkWorker(...a),
  sendWorkerInput: (...a: any[]) => mockSendWorkerInput(...a),
  getCurrentCliVersion: vi.fn(() => 'test'),
  setActiveSessionIfActive: (map: Map<string, any>, key: string, ds: any) => { map.set(key, ds); return true; },
  closeSession: (...a: any[]) => mockCloseSession(...a),
  getDaemonBootId: () => 'boot-CURRENT',
  withActiveSessionKeyLock: (_map: any, _key: string, action: () => any) => action(),
  hasQueuedActivationAdmissionGate: () => queuedActivationGateActive,
}));

import { triggerSessionTurn, reconcileIdempotencyLeasesOnBoot, convergeIdempotentAsyncTurnOnWorkerExit } from '../src/core/trigger-session.js';
import * as asyncTriggerStore from '../src/services/async-trigger-store.js';
import * as idempotencyStore from '../src/services/idempotency-store.js';
import { sessionKey } from '../src/core/types.js';

const APP = 'local_riff';
const SID = 'sess_existing';
const CHAT = `http_async_${'0'.repeat(8)}-0000-0000-0000-000000000000`;

function followUpReq(turnIdempotencyKey: string | undefined, instruction = 'follow up please'): TriggerRequest {
  return {
    source: { type: 'webhook', sourceName: 'riff' } as any,
    target: { kind: 'turn', botId: APP, sessionId: SID },
    envelope: { format: 'text', sourceName: 'riff', trusted: false },
    instruction,
    options: { asyncReturnSessionId: true, ...(turnIdempotencyKey ? { turnIdempotencyKey } : {}) },
  };
}

function existingDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  const s = { sessionId: SID, chatId: CHAT, rootMessageId: '', scope: 'chat', status: 'active', createdAt: '2026-06-01T00:00:00.000Z' };
  return {
    session: s,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: APP,
    chatId: CHAT,
    chatType: 'group',
    scope: 'chat',
    spawnedAt: 1,
    cliVersion: 'test',
    lastMessageAt: 1,
    hasHistory: true,
    ...overrides,
  } as DaemonSession;
}

/** activeSessions map holding one existing session keyed canonically. */
function activeWith(ds: DaemonSession): Map<string, DaemonSession> {
  return new Map<string, DaemonSession>([[sessionKey(CHAT, APP), ds]]);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'trig-turn-idem-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tempDir;
  existingRows.length = 0;
  existingRows.push({ sessionId: SID, chatId: CHAT, scope: 'chat', status: 'active' });
  forkShouldThrow = false; sendShouldRefuse = false; queuedActivationGateActive = false;
  mockForkWorker.mockClear(); mockSendWorkerInput.mockClear(); mockCloseSession.mockClear();
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR; else process.env.SESSION_DATA_DIR = prevDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('turn-level idempotency — worker LIVE (sendWorkerInput) branch', () => {
  it('first follow-up: sends once, writes a turn:<sid>:<key> attempting lease, echoes turnIdempotencyKey', async () => {
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const res = await triggerSessionTurn(followUpReq('tk-1'), { larkAppId: APP, activeSessions: activeWith(ds) });
    expect(res.ok).toBe(true);
    expect(res.idempotent).toBeFalsy();
    expect(res.turnIdempotencyKey).toBe('tk-1');
    expect(mockSendWorkerInput).toHaveBeenCalledTimes(1);
    // At-most-once: the keyed live-delivery MUST carry atMostOnce so a CLI crash
    // never replays it onto the auto-restarted CLI after terminalization (the
    // live-branch replay defect — the fresh-session/dormant paths use the fork
    // init's atMostOnce, the live path needs it threaded through the message IPC).
    expect(mockSendWorkerInput.mock.calls[0][3]?.atMostOnce).toBe(true);
    // Turn lease lives under the unforgeable `turn` store kind (codex #818 P1-2:
    // NOT a user-constructable string prefix); key embeds sessionId.
    const lease = idempotencyStore.lookup(APP, `${SID}\u0000tk-1`, 'turn');
    expect(lease?.state).toBe('attempting'); // barrier crossed before send
    expect(lease?.sessionId).toBe(SID);
    // The idempotent-async-turn convergence entry is set per-triggerId (Map, not a
    // single slot — codex #818 P1-1).
    expect(ds.idempotentAsyncTurns?.get(res.triggerId!)?.key).toBe(`${SID}\u0000tk-1`);
    expect(ds.idempotentAsyncTurns?.get(res.triggerId!)?.kind).toBe('turn');
  });

  it('same key + same payload retry: reuses in-flight turn, does NOT send again', async () => {
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const active = activeWith(ds);
    const first = await triggerSessionTurn(followUpReq('tk-2'), { larkAppId: APP, activeSessions: active });
    expect(mockSendWorkerInput).toHaveBeenCalledTimes(1);
    // Retry while the worker is still live → resolveIdempotencyHit sees an
    // attempting lease + liveWorker → reuse.
    const second = await triggerSessionTurn(followUpReq('tk-2'), { larkAppId: APP, activeSessions: active });
    expect(second.idempotent).toBe(true);
    expect(second.triggerId).toBe(first.triggerId);
    expect(mockSendWorkerInput).toHaveBeenCalledTimes(1); // still ONE send
  });

  it('same key + DIFFERENT payload → 409 idempotency_conflict, no second send', async () => {
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const active = activeWith(ds);
    await triggerSessionTurn(followUpReq('tk-3', 'payload A'), { larkAppId: APP, activeSessions: active });
    const conflict = await triggerSessionTurn(followUpReq('tk-3', 'payload B'), { larkAppId: APP, activeSessions: active });
    expect(conflict.ok).toBe(false);
    expect(conflict.errorCode).toBe('idempotency_conflict');
    expect(mockSendWorkerInput).toHaveBeenCalledTimes(1);
  });

  it('completed turn: same-key retry reuses (async-store completed wins over lease)', async () => {
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const active = activeWith(ds);
    const first = await triggerSessionTurn(followUpReq('tk-done'), { larkAppId: APP, activeSessions: active });
    // Simulate the turn completing (final_output path records completed).
    asyncTriggerStore.recordCompleted(SID, first.triggerId!, 'the answer', Date.now(), APP);
    const retry = await triggerSessionTurn(followUpReq('tk-done'), { larkAppId: APP, activeSessions: active });
    expect(retry.idempotent).toBe(true);
    expect(retry.triggerId).toBe(first.triggerId);
    expect(mockSendWorkerInput).toHaveBeenCalledTimes(1); // no re-dispatch
  });

  it('send REFUSED after barrier → durable failed(dispatch_unknown); same-key retry resolves terminal, no re-send', async () => {
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const active = activeWith(ds);
    sendShouldRefuse = true;
    const res = await triggerSessionTurn(followUpReq('tk-refuse'), { larkAppId: APP, activeSessions: active });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('trigger_failed');
    // Authoritative durable failed so trigger-result converges (not stuck running).
    expect(asyncTriggerStore.lookup(SID, res.triggerId!)?.result.status).toBe('failed');
    expect(asyncTriggerStore.lookup(SID, res.triggerId!)?.result.reason).toBe('dispatch_unknown');
    expect(ds.idempotentAsyncTurns?.get(res.triggerId!)).toBeUndefined(); // entry dropped after durable failed
    // Retry: at-most-once — resolves the terminal, never re-sends.
    sendShouldRefuse = false;
    const sendsBefore = mockSendWorkerInput.mock.calls.length;
    const retry = await triggerSessionTurn(followUpReq('tk-refuse'), { larkAppId: APP, activeSessions: active });
    expect(retry.state).toBe('failed');
    expect(retry.idempotent).toBe(true);
    expect(mockSendWorkerInput.mock.calls.length).toBe(sendsBefore); // no new send
  });
});

describe('turn-level idempotency — worker DORMANT (forkWorker) branch', () => {
  it('first follow-up on a dormant worker: forks once with atMostOnce+resume, attempting lease', async () => {
    const ds = existingDs({ worker: null, hasHistory: true }); // dormant
    const res = await triggerSessionTurn(followUpReq('tk-fork'), { larkAppId: APP, activeSessions: activeWith(ds) });
    expect(res.ok).toBe(true);
    expect(res.turnIdempotencyKey).toBe('tk-fork');
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
    const forkArg = mockForkWorker.mock.calls[0][2];
    expect(forkArg.atMostOnce).toBe(true);   // at-most-once rides the fork init
    expect(forkArg.resume).toBe(true);       // existing session resumes context
    expect(idempotencyStore.lookup(APP, `${SID}\u0000tk-fork`, 'turn')?.state).toBe('attempting');
  });

  it('fork throw AFTER the barrier → durable failed(dispatch_unknown); retry does NOT re-fork', async () => {
    const ds = existingDs({ worker: null, hasHistory: true });
    const active = activeWith(ds);
    forkShouldThrow = true;
    const res = await triggerSessionTurn(followUpReq('tk-fthrow'), { larkAppId: APP, activeSessions: active });
    expect(res.state).toBe('failed');
    expect(res.errorCode).toBe('no_output');
    expect(asyncTriggerStore.lookup(SID, res.triggerId!)?.result.reason).toBe('dispatch_unknown');
    expect(ds.idempotentAsyncTurns?.get(res.triggerId!)).toBeUndefined();
    forkShouldThrow = false;
    const forksBefore = mockForkWorker.mock.calls.length;
    const retry = await triggerSessionTurn(followUpReq('tk-fthrow'), { larkAppId: APP, activeSessions: active });
    expect(retry.state).toBe('failed');
    expect(mockForkWorker.mock.calls.length).toBe(forksBefore); // no new fork
  });
});

describe('turn-level idempotency — no key (unchanged behavior)', () => {
  it('a follow-up WITHOUT turnIdempotencyKey dispatches normally and writes no lease', async () => {
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const res = await triggerSessionTurn(followUpReq(undefined), { larkAppId: APP, activeSessions: activeWith(ds) });
    expect(res.ok).toBe(true);
    expect(res.turnIdempotencyKey).toBeUndefined();
    expect(mockSendWorkerInput).toHaveBeenCalledTimes(1);
    // No key → a plain replayable input (atMostOnce must NOT be set, else an
    // ordinary follow-up would be wrongly dropped on a CLI restart).
    expect(mockSendWorkerInput.mock.calls[0][3]?.atMostOnce).toBeUndefined();
    expect(ds.idempotentAsyncTurns?.size ?? 0).toBe(0); // no lease, no convergence entry
  });
});

// ── codex #818 review regressions: the structural at-most-once defects the
//    first round missed, each pinned with the deterministic scenario codex gave.
describe('turn-level idempotency — codex #818 P1 regressions', () => {
  it('P1-1: two concurrent keyed turns on ONE session BOTH converge on worker exit (no lost stamp)', async () => {
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const active = activeWith(ds);
    const a = await triggerSessionTurn(followUpReq('tk-A'), { larkAppId: APP, activeSessions: active });
    const b = await triggerSessionTurn(followUpReq('tk-B'), { larkAppId: APP, activeSessions: active });
    // Both stamps coexist (a single slot would have let B clobber A).
    expect(ds.idempotentAsyncTurns?.size).toBe(2);
    expect(ds.idempotentAsyncTurns?.get(a.triggerId!)).toBeDefined();
    expect(ds.idempotentAsyncTurns?.get(b.triggerId!)).toBeDefined();
    const gen = ds.idempotentAsyncTurns!.get(a.triggerId!)!.workerGeneration;
    // Worker dies with neither completed → BOTH must converge to dispatch_unknown.
    ds.worker = null;
    const outcome = convergeIdempotentAsyncTurnOnWorkerExit(ds, gen);
    expect(outcome).toBe('converged');
    expect(asyncTriggerStore.lookup(SID, a.triggerId!)?.result.status).toBe('failed');
    expect(asyncTriggerStore.lookup(SID, b.triggerId!)?.result.status).toBe('failed'); // NOT stranded pending
    expect(ds.idempotentAsyncTurns?.size ?? 0).toBe(0);
  });

  it('P1-2: a fresh idempotencyKey cannot collide with a turn key of the same string', async () => {
    // Claim a turn lease under key "sess_existing<NUL>tk-collide".
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    await triggerSessionTurn(followUpReq('tk-collide'), { larkAppId: APP, activeSessions: activeWith(ds) });
    const turnLease = idempotencyStore.lookup(APP, `${SID}\u0000tk-collide`, 'turn');
    expect(turnLease?.state).toBe('attempting');
    // The SAME string under the fresh (default) kind is a DIFFERENT file → absent.
    expect(idempotencyStore.lookup(APP, `${SID}\u0000tk-collide`)).toBeUndefined();
    expect(idempotencyStore.lookup(APP, `${SID}\u0000tk-collide`, 'fresh')).toBeUndefined();
  });

  it('P1-3: boot reconcile terminalizes a turn lease but NEVER closes the shared session', async () => {
    // Seed an attempting TURN lease from a PREVIOUS boot (ownerBootId differs from
    // the reconcile's currentBootId) on a still-live shared session.
    idempotencyStore.claim({
      ownerLarkAppId: APP, sessionId: SID, triggerId: 'trg_prev',
      requestHash: 'sha256:x', ownerBootId: 'boot-OLD', key: `${SID}\u0000tk-recon`, now: 1, kind: 'turn',
    });
    idempotencyStore.transition(APP, `${SID}\u0000tk-recon`,
      idempotencyStore.lookup(APP, `${SID}\u0000tk-recon`, 'turn')!, { state: 'attempting', now: 2 }, 'turn');
    mockCloseSession.mockClear();
    const quarantined = await reconcileIdempotencyLeasesOnBoot(APP, 'boot-CURRENT', () => ({ chatId: CHAT }));
    // The exact turn is terminalized (caller polls failed at-most-once)…
    expect(asyncTriggerStore.lookup(SID, 'trg_prev')?.result.reason).toBe('dispatch_unknown');
    // …but the SHARED session is NEVER closed or quarantined (fresh-session-only teardown).
    expect(mockCloseSession).not.toHaveBeenCalled();
    expect(quarantined.has(SID)).toBe(false);
  });

  it('P1-4: a keyed follow-up is refused RETRYABLY (no claim, no dispatch) while an activation gate is active', async () => {
    queuedActivationGateActive = true; // opening activation still owns submission order
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const res = await triggerSessionTurn(followUpReq('tk-gated'), { larkAppId: APP, activeSessions: activeWith(ds) });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('trigger_failed');
    expect(res.error).toMatch(/activation in progress/i);
    // Nothing claimed, nothing dispatched — the caller retries once the gate drains.
    expect(mockSendWorkerInput).not.toHaveBeenCalled();
    expect(idempotencyStore.lookup(APP, `${SID}\u0000tk-gated`, 'turn')).toBeUndefined();
  });

  it('P1-7 (live): a post-barrier beginAsyncTrigger throw terminalizes the lease; retry resolves failed, no reuse-forever', async () => {
    // Inject a throw in beginAsyncTrigger (via its recordPending call) AFTER the
    // reserved->attempting barrier. Without the unified post-barrier try this
    // leaves lease=attempting + no convergence entry + no async record -> a
    // same-key retry reuses it forever. The fix must durably terminalize here.
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const active = activeWith(ds);
    const pSpy = vi.spyOn(asyncTriggerStore, 'recordPending').mockImplementationOnce(() => { throw new Error('injected recordPending fault'); });
    const res = await triggerSessionTurn(followUpReq('tk-pb'), { larkAppId: APP, activeSessions: active });
    pSpy.mockRestore();
    // Observable terminal (not a hang): the caller polls failed at-most-once.
    expect(res.ok).toBe(false);
    expect(res.state).toBe('failed');
    expect(res.errorCode).toBe('no_output');
    expect(mockSendWorkerInput).not.toHaveBeenCalled(); // nothing dispatched
    // Durable terminal written; convergence entry dropped after the successful write.
    expect(asyncTriggerStore.lookup(SID, res.triggerId!)?.result.reason).toBe('dispatch_unknown');
    expect(ds.idempotentAsyncTurns?.get(res.triggerId!)).toBeUndefined();
    // Same-key retry must NOT reuse-forever - it resolves the terminal, no dispatch.
    const retry = await triggerSessionTurn(followUpReq('tk-pb'), { larkAppId: APP, activeSessions: active });
    expect(retry.state).toBe('failed');
    expect(retry.idempotent).toBe(true);
    expect(mockSendWorkerInput).not.toHaveBeenCalled();
  });

  it('P1-7 (dormant): a post-barrier beginAsyncTrigger throw on the fork path terminalizes the lease too', async () => {
    const ds = existingDs({ worker: null, hasHistory: true }); // dormant -> fork path
    const active = activeWith(ds);
    const pSpy = vi.spyOn(asyncTriggerStore, 'recordPending').mockImplementationOnce(() => { throw new Error('injected recordPending fault'); });
    const res = await triggerSessionTurn(followUpReq('tk-pbd'), { larkAppId: APP, activeSessions: active });
    pSpy.mockRestore();
    expect(res.ok).toBe(false);
    expect(res.state).toBe('failed');
    expect(mockForkWorker).not.toHaveBeenCalled(); // fork never reached
    expect(asyncTriggerStore.lookup(SID, res.triggerId!)?.result.reason).toBe('dispatch_unknown');
    expect(ds.idempotentAsyncTurns?.get(res.triggerId!)).toBeUndefined();
    const retry = await triggerSessionTurn(followUpReq('tk-pbd'), { larkAppId: APP, activeSessions: active });
    expect(retry.state).toBe('failed');
    expect(mockForkWorker).not.toHaveBeenCalled();
  });

  it('P1-8 (double fault): post-barrier throw + terminalize throw → 5xx + flagged; retry re-terminalizes (no reuse-forever)', async () => {
    // recordPending throws (post-barrier) AND recordFailedStrict throws in the SAME
    // request → nothing dispatched, lease attempting, no durable result. For a LIVE
    // shared worker the exit handler never fires, so without the postBarrierFault
    // flag + retry re-terminalize, a same-key retry would `reuse` and hang forever.
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const active = activeWith(ds);
    const pendSpy = vi.spyOn(asyncTriggerStore, 'recordPending').mockImplementationOnce(() => { throw new Error('injected recordPending fault'); });
    const failSpy = vi.spyOn(asyncTriggerStore, 'recordFailedStrict').mockImplementationOnce(() => { throw new Error('injected recordFailedStrict fault'); });
    const first = await triggerSessionTurn(followUpReq('tk-df'), { larkAppId: APP, activeSessions: active });
    pendSpy.mockRestore();
    failSpy.mockRestore();
    // Honest 5xx (no phantom terminal), lease kept attempting, entry flagged.
    expect(first.ok).toBe(false);
    expect(first.errorCode).toBe('trigger_failed');
    expect(first.state).not.toBe('failed');
    expect(mockSendWorkerInput).not.toHaveBeenCalled();
    const entry = [...(ds.idempotentAsyncTurns?.values() ?? [])][0];
    expect(entry?.postBarrierFault).toBe(true);
    expect(idempotencyStore.lookup(APP, `${SID}\u0000tk-df`, 'turn')?.state).toBe('attempting');
    // Store recovers → same-key retry re-attempts the strict terminalize and
    // resolves an observable terminal, WITHOUT reusing/hanging or re-dispatching.
    const retry = await triggerSessionTurn(followUpReq('tk-df'), { larkAppId: APP, activeSessions: active });
    expect(retry.state).toBe('failed');
    expect(retry.idempotent).toBe(true);
    expect(mockSendWorkerInput).not.toHaveBeenCalled();
    // Durable terminal now exists; the fault entry is cleared.
    expect(asyncTriggerStore.lookup(SID, retry.triggerId!)?.result.reason).toBe('dispatch_unknown');
    expect(ds.idempotentAsyncTurns?.size ?? 0).toBe(0);
  });

  it('P1-8 completed-wins race: a postBarrierFault turn that actually completed → retry REUSES completed, never terminalizes over it', async () => {
    // First request double-faults → lease attempting + entry flagged, no dispatch.
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const active = activeWith(ds);
    const pendSpy = vi.spyOn(asyncTriggerStore, 'recordPending').mockImplementationOnce(() => { throw new Error('injected recordPending fault'); });
    const failSpy = vi.spyOn(asyncTriggerStore, 'recordFailedStrict').mockImplementationOnce(() => { throw new Error('injected recordFailedStrict fault'); });
    const first = await triggerSessionTurn(followUpReq('tk-race'), { larkAppId: APP, activeSessions: active });
    pendSpy.mockRestore(); failSpy.mockRestore();
    const flagged = [...(ds.idempotentAsyncTurns?.values() ?? [])][0];
    expect(flagged?.postBarrierFault).toBe(true);
    // The turn ACTUALLY completed in the race window (a real durable owned completed
    // lands on disk for this triggerId).
    asyncTriggerStore.recordCompleted(SID, first.triggerId!, 'the real answer', Date.now(), APP);
    // Same-key retry must REUSE the completed result — NOT terminalize over it as failed.
    const retry = await triggerSessionTurn(followUpReq('tk-race'), { larkAppId: APP, activeSessions: active });
    expect(retry.idempotent).toBe(true);
    expect(retry.state).not.toBe('failed');           // completed wins over the fault
    expect(asyncTriggerStore.lookup(SID, first.triggerId!)?.result.status).toBe('completed'); // untouched
    expect(ds.idempotentAsyncTurns?.size ?? 0).toBe(0); // fault entry cleared
    expect(mockSendWorkerInput).not.toHaveBeenCalled(); // never re-dispatched
  });

  it('P1-8 TOCTOU: completion landing AFTER pre-read but seen IN-LOCK → reuse completed, not failed', async () => {
    // The tighter window codex flagged: the retry pre-read sees NOT-completed, but a
    // completion lands before recordFailedStrict takes the lock. recordFailedStrict
    // then returns `already_completed` (no-op, completed-wins) — the caller must
    // resolve completed, NOT unconditionally return failed. We simulate the in-lock
    // race by having recordFailedStrict itself write the completion then report
    // already_completed (its real completed-wins behavior).
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const active = activeWith(ds);
    const pendSpy = vi.spyOn(asyncTriggerStore, 'recordPending').mockImplementationOnce(() => { throw new Error('injected recordPending fault'); });
    const failSpy = vi.spyOn(asyncTriggerStore, 'recordFailedStrict').mockImplementationOnce(() => { throw new Error('injected recordFailedStrict fault'); });
    const first = await triggerSessionTurn(followUpReq('tk-toctou'), { larkAppId: APP, activeSessions: active });
    pendSpy.mockRestore(); failSpy.mockRestore();
    expect([...(ds.idempotentAsyncTurns?.values() ?? [])][0]?.postBarrierFault).toBe(true);
    // Pre-read will see NOT completed; but the NEXT recordFailedStrict call lands the
    // completion under the lock and returns already_completed (real completed-wins).
    const realRFS = asyncTriggerStore.recordFailedStrict;
    const rfsSpy = vi.spyOn(asyncTriggerStore, 'recordFailedStrict').mockImplementationOnce((sid: any, tid: any) => {
      asyncTriggerStore.recordCompleted(sid, tid, 'raced-in answer', Date.now(), APP);
      return 'already_completed' as any; // mirrors the in-lock completed-wins no-op
    });
    const retry = await triggerSessionTurn(followUpReq('tk-toctou'), { larkAppId: APP, activeSessions: active });
    rfsSpy.mockRestore();
    // Completed wins: response must NOT be failed, and durable stays completed.
    expect(retry.state).not.toBe('failed');
    expect(retry.idempotent).toBe(true);
    expect(asyncTriggerStore.lookup(SID, first.triggerId!)?.result.status).toBe('completed');
    expect(ds.idempotentAsyncTurns?.size ?? 0).toBe(0); // stale fault entry cleared
    expect(mockSendWorkerInput).not.toHaveBeenCalled();
    void realRFS;
  });
});
