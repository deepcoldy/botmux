import './helpers/require-fenced-data-dir.js';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bots from '../src/bot-registry.js';
import { config } from '../src/config.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { registerSessionContractPrimary } from '../src/core/session-contract-primary.js';
import { controllerForSession, readPersistedExecutionContract } from '../src/core/session-controller.js';
import { SessionEventGateway } from '../src/core/session-event-gateway.js';
import { restoreActiveSessions } from '../src/core/session-manager.js';
import * as workerPool from '../src/core/worker-pool.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import {
  classifyOfflineColdRestoreSettlement,
  classifyQueuedActivationInitPlan,
  decideCodexAppSettlementActivationToken,
  decideDurableArgvReattachSubmission,
  decideFlushSubmissionRejectionSettlement,
  decideOrdinaryImRejectionAction,
  decidePendingRawInputAction,
  decidePromotedActivationMessageHandling,
  decideRawInputSubmissionReconciliation,
  isDurableArgvCliId,
  reconcileRemoteRecoveredTurnQueue,
  resolveQueuedActivationEffectiveTurn,
  shouldAdoptPidMarkerWithoutRetiringCurrent,
  shouldAllowTypeAheadOnReattach,
  shouldPrepareInitialPromptArg,
  shouldSkipResumeForReconciledBridge,
} from '../src/services/queued-activation-reconcile.js';
import { createQueuedActivationReceiptObserver } from '../src/services/queued-activation-receipts.js';
import { sessionContractStore } from '../src/services/session-contract-store.js';
import { admitSessionCommand } from '../src/services/session-command-gateway.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import * as sessionStore from '../src/services/session-store.js';
import { inputForcesSerialTurn, resolveInitialPromptDelivery } from '../src/utils/pending-input-queue.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

const APP = 'cli_test_reattach_ack';
const originalDataDir = config.session.dataDir;
const tempDirs: string[] = [];
const registeredActiveKeys: string[] = [];

function createIsolatedDataDir(prefix = 'botmux-reattach-ack-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  config.session.dataDir = dir;
  const bot = {
    config: { larkAppId: APP, larkAppSecret: 'fixture-only', cliId: 'claude-code' },
    botName: 'TestBot',
    resolvedAllowedUsers: [],
  } as unknown as ReturnType<typeof bots.getBot>;
  vi.spyOn(bots, 'getBot').mockImplementation(() => bot);
  vi.spyOn(bots, 'getAllBots').mockImplementation(() => [bot]);
  sessionStore.init(APP);
  workerPool.initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
    getSessionWorkingDir: () => dir,
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
  return dir;
}

function makeSession(overrides: Partial<DaemonSession['session']> = {}): DaemonSession['session'] {
  const created = sessionStore.createSession(
    'oc_chat_reattach_1',
    'om_turn_opening_1',
    'Reattach Test Session',
    'group',
    'chat',
    { source: 'external' },
  );
  created.workingDir = '/tmp';
  created.larkAppId = APP;
  created.cliId = 'claude-code';
  Object.assign(created, overrides);
  sessionStore.updateSession(created);
  return created;
}

function makeDaemonSession(session: DaemonSession['session'], overrides: Partial<DaemonSession> = {}): DaemonSession {
  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: APP,
    chatId: session.chatId,
    chatType: session.chatType ?? 'group',
    scope: session.scope ?? 'chat',
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    initialStartPending: session.queuedActivationPending === true || (session.queuedActivationTail?.length ?? 0) > 0,
    workingDir: session.workingDir,
    ...overrides,
  };
  const registry = workerPool.getActiveSessionsRegistry();
  if (registry) {
    const key = sessionKey(ds.scope === 'chat' ? ds.chatId : ds.session.rootMessageId, ds.larkAppId);
    registry.set(key, ds);
    registeredActiveKeys.push(key);
  }
  return ds;
}

function makeFakeWorker() {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.connected = true;
  worker.pid = 424242;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  worker.sent = [] as any[];
  worker.send = vi.fn((msg: any) => {
    worker.sent.push(msg);
    return true;
  });
  worker.kill = vi.fn(() => {
    worker.killed = true;
    return true;
  });
  return worker;
}

function persistExecutionPhase(
  dataDir: string,
  ds: DaemonSession,
  turnId: string,
  phase: 'queued' | 'submitting' | 'reconciling' | 'succeeded',
  dispatchAttempt?: number,
) {
  const store = sessionContractStore(dataDir, APP);
  const ref = { appId: APP, sessionId: ds.session.sessionId };
  store.ensure(ref, { closed: false });
  const worker = { workerId: 'worker-gen-1', generation: 1 };
  store.apply(ref, { type: 'worker_bound', worker }, 'ev-w1');
  const execution = store.admitExecution(ref, turnId, dispatchAttempt);
  if (phase !== 'queued') {
    const runtimeRef = store.reserveRuntime(ref, worker, 'bind-gen-1');
    store.bindRuntime(
      ref,
      runtimeRef,
      worker,
      { backend: 'tmux', physicalId: 'pid:1001:boot:1', nativeSessionId: ds.session.sessionId, proof: 'process_start' },
    );
    store.bindQueuedExecution(ref, execution.ref, runtimeRef);
    store.apply(
      ref,
      { type: 'execution_phase', runtime: runtimeRef, execution: execution.ref, phase: 'submitting' },
      'ev-submitting',
    );
    if (phase === 'reconciling') {
      store.apply(
        ref,
        { type: 'runtime_lost', runtime: runtimeRef, confirmed: false, reason: 'worker_disconnected' },
        'ev-lost',
      );
      store.markUnresolvedExecutions(ref, runtimeRef);
    } else if (phase === 'succeeded') {
      store.apply(
        ref,
        { type: 'execution_terminal', runtime: runtimeRef, execution: execution.ref, status: 'succeeded', evidence: 'native_terminal' },
        'ev-succeeded',
      );
    }
  }
  const latest = store.read(ref)!;
  ds.session.sessionContractRevision = latest.revision;
  sessionStore.updateSession(ds.session);
  return { store, ref, execution };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  workerPool.__testOnly_setWorkerSpawner(undefined);
  workerPool.__testOnly_resetOrdinaryImDeliveries();
  const registry = workerPool.getActiveSessionsRegistry();
  while (registeredActiveKeys.length > 0) {
    const key = registeredActiveKeys.pop()!;
    registry?.delete(key);
  }
  sessionStore.__testOnly_setBeforeRowPersist(undefined);
  if (tempDirs.length > 0) {
    config.session.dataDir = originalDataDir;
    sessionStore.init(APP);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('SessionEventGateway & sessionEventMetadata transport admission for queued_activation_submitted', () => {
  it('strips runtime/execution/bindingId in sessionEventMetadata and admits queued_activation_submitted across pre-spawn, rebind, and non-deferred controller ingest while rejecting stale workers', () => {
    const dataDir = createIsolatedDataDir();
    const session = makeSession({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-gw-1',
      queuedActivationTurnId: 'om_turn_opening_1',
    });
    const ds = makeDaemonSession(session);
    const controller = controllerForSession(ds, true)!;
    const w1 = controller.bindWorker(1);
    const scope = new WorkerSessionEventScope(w1.session, w1.worker);

    // 1. Metadata stripping: even inside an active runtime + execution scope,
    // queued_activation_submitted strips runtime, execution, operationId, bindingId.
    const binding = scope.beginRuntime('op-1');
    binding.runtime = { runtimeId: 'rt-1', epoch: 1 };
    const exec = controller.admitInput('om_turn_opening_1');
    const sessionEventMetadata = loadWorkerFunction<(msg: any) => any>('sessionEventMetadata', {
      workerSessionEventScope: scope,
    });
    const framed = scope.run(binding, () => sessionEventMetadata({
      type: 'queued_activation_submitted',
      sessionId: session.sessionId,
      activationToken: 'tok-gw-1',
    }), exec, 'op-1');
    expect(framed.sessionContract).toBeDefined();
    expect(framed.sessionContract.scope.runtime).toBeUndefined();
    expect(framed.sessionContract.scope.execution).toBeUndefined();
    expect(framed.sessionContract.scope.operationId).toBeUndefined();
    expect(framed.sessionContract.bindingId).toBeUndefined();

    // 2. Gateway admits pre-spawn (no runtime bound yet) as kind='worker'.
    const gateway = new SessionEventGateway(controller.store, controller.ref);
    const preSpawnAdmission = gateway.admit('queued_activation_submitted', framed.sessionContract, w1.worker);
    expect(preSpawnAdmission.kind).toBe('worker');

    // 3. Even if a rolling-upgrade worker attaches an unbound bindingId,
    // SessionController.ingest admits without deferring.
    const reserved = controller.reserveBinding('bind-pending-1', w1.worker);
    expect(reserved).toBeTruthy();
    const withBinding = {
      type: 'queued_activation_submitted',
      sessionId: session.sessionId,
      activationToken: 'tok-gw-1',
      sessionContract: {
        ...scope.envelope({}),
        bindingId: 'bind-pending-1',
      },
    };
    const ingestAdmission = controller.ingest(withBinding as any, w1.worker);
    expect(ingestAdmission.kind).toBe('worker');

    // 4. After an in-process runtime rebind, queued_activation_submitted still admits.
    controller.bindRuntime('bind-pending-1', w1.worker, {
      backend: 'tmux',
      physicalId: 'pid:2001:boot:1',
      nativeSessionId: session.sessionId,
      proof: 'process_start',
    });
    const postRebindFramed = sessionEventMetadata({
      type: 'queued_activation_submitted',
      sessionId: session.sessionId,
      activationToken: 'tok-gw-1',
    });
    expect(controller.ingest(postRebindFramed, w1.worker).kind).toBe('worker');

    // 5. Security invariant: once worker gen 2 takes over, a late gen 1 ACK with
    // the exact same token is still rejected by SessionEventGateway.
    const w2 = controller.bindWorker(2);
    expect(w2.worker.generation).toBe(2);
    const staleFramed = sessionEventMetadata({
      type: 'queued_activation_submitted',
      sessionId: session.sessionId,
      activationToken: 'tok-gw-1',
    });
    const staleAdmission = gateway.admit('queued_activation_submitted', staleFramed.sessionContract, w1.worker);
    expect(staleAdmission.kind).toBe('reject');
    expect(dataDir).toBeTruthy();
  });
});

describe('Read-only contract inspection & init reconciliation planning (Cases A/B/C, Codex App, Legacy)', () => {
  it('classifies Case A (reconciling) and Case B (succeeded) as reconcile_already_submitted, Case C (queued/no-contract) as replay_queued, and Codex App as codex_app_ledger', () => {
    const dataDir = createIsolatedDataDir();

    // Legacy pre-contract session: readPersistedExecutionContract must NOT call store.ensure()
    const legacySession = makeSession({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-legacy',
      queuedActivationInput: { content: 'opening turn' },
      queuedActivationTurnId: 'om_turn_legacy',
    });
    const legacyDs = makeDaemonSession(legacySession);
    const legacyRead = readPersistedExecutionContract(legacyDs, 'om_turn_legacy');
    expect(legacyRead).toEqual({ hasContract: false });
    expect(legacyDs.session.sessionContractRevision).toBeUndefined();
    expect(sessionContractStore(dataDir, APP).read({ appId: APP, sessionId: legacySession.sessionId })).toBeUndefined();
    expect(classifyQueuedActivationInitPlan({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-legacy',
      isCodexApp: false,
      hasTextPrompt: true,
      hasRawInput: false,
      turnId: 'om_turn_legacy',
      hasContract: legacyRead.hasContract,
      contractPhase: legacyRead.phase,
    })).toEqual({ action: 'replay_queued' });

    // Case C negative control: persisted execution still in phase='queued'
    const caseCSession = makeSession({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-case-c',
      queuedActivationInput: { content: 'never submitted prompt' },
      queuedActivationTurnId: 'om_turn_case_c',
    });
    const caseCDs = makeDaemonSession(caseCSession);
    persistExecutionPhase(dataDir, caseCDs, 'om_turn_case_c', 'queued');
    const caseCRead = readPersistedExecutionContract(caseCDs, 'om_turn_case_c');
    expect(caseCRead.hasContract).toBe(true);
    expect(caseCRead.phase).toBe('queued');
    expect(classifyQueuedActivationInitPlan({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-case-c',
      isCodexApp: false,
      hasTextPrompt: true,
      hasRawInput: false,
      turnId: 'om_turn_case_c',
      hasContract: caseCRead.hasContract,
      contractPhase: caseCRead.phase,
    })).toEqual({ action: 'replay_queued' });

    // Case A (live production wedge): phase='reconciling'
    const caseASession = makeSession({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-case-a',
      queuedActivationInput: { content: 'already running prompt' },
      queuedActivationTurnId: 'om_turn_case_a',
    });
    const caseADs = makeDaemonSession(caseASession);
    persistExecutionPhase(dataDir, caseADs, 'om_turn_case_a', 'reconciling');
    const caseARead = readPersistedExecutionContract(caseADs, 'om_turn_case_a');
    expect(caseARead.hasContract).toBe(true);
    expect(caseARead.phase).toBe('reconciling');
    expect(classifyQueuedActivationInitPlan({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-case-a',
      isCodexApp: false,
      hasTextPrompt: true,
      hasRawInput: false,
      turnId: 'om_turn_case_a',
      hasContract: caseARead.hasContract,
      contractPhase: caseARead.phase,
    })).toEqual({
      action: 'reconcile_already_submitted',
      hint: { turnId: 'om_turn_case_a', phase: 'reconciling' },
    });

    // Case B (already finished while daemon down): phase='succeeded'
    const caseBSession = makeSession({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-case-b',
      queuedActivationInput: { content: 'finished prompt' },
      queuedActivationTurnId: 'om_turn_case_b',
    });
    const caseBDs = makeDaemonSession(caseBSession);
    persistExecutionPhase(dataDir, caseBDs, 'om_turn_case_b', 'succeeded');
    const caseBRead = readPersistedExecutionContract(caseBDs, 'om_turn_case_b');
    expect(caseBRead.phase).toBe('succeeded');
    expect(classifyQueuedActivationInitPlan({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-case-b',
      isCodexApp: false,
      hasTextPrompt: true,
      hasRawInput: false,
      turnId: 'om_turn_case_b',
      hasContract: caseBRead.hasContract,
      contractPhase: caseBRead.phase,
    })).toEqual({
      action: 'reconcile_already_submitted',
      hint: { turnId: 'om_turn_case_b', phase: 'succeeded' },
    });

    // Codex App negative control: even with phase='reconciling' (e.g. untouched retry),
    // Codex App stays governed strictly by codexAppDispatchLedger.
    expect(classifyQueuedActivationInitPlan({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-codex-app',
      isCodexApp: true,
      hasTextPrompt: true,
      hasRawInput: false,
      turnId: 'om_turn_case_a',
      hasContract: true,
      contractPhase: 'reconciling',
    })).toEqual({ action: 'codex_app_ledger' });
  });
});

describe('Synchronous offline cold-restore settlement (missing pane / local PTY)', () => {
  it('settles empty-tail non-queued local cold-restore offline with explicit-null dashboard patch and zero wasted cold-spawn', () => {
    const dataDir = createIsolatedDataDir();
    const session = makeSession({
      backendType: 'pty',
      queuedActivationPending: true,
      queuedActivationToken: 'tok-cold-empty',
      queuedActivationInput: { content: 'already submitted before pty died' },
      queuedActivationTurnId: 'om_turn_cold_1',
    });
    const ds = makeDaemonSession(session);
    persistExecutionPhase(dataDir, ds, 'om_turn_cold_1', 'reconciling');

    const patches: any[] = [];
    const unsub = dashboardEventBus.subscribe(ev => {
      if (ev.type === 'session.update' && ev.body.sessionId === session.sessionId) patches.push(ev.body.patch);
    });
    try {
      const outcome = workerPool.settleOfflineReconciledQueuedActivation(ds, {
        isCodexApp: false,
        isRemoteBackend: false,
        backingMode: 'cold_restore',
      });
      expect(outcome).toBe('settled_empty');
      expect(ds.session.queuedActivationPending).toBeUndefined();
      expect(ds.session.queuedActivationToken).toBeUndefined();
      expect(ds.hasHistory).toBe(true);
      expect(ds.initialStartPending).toBe(false);
      expect(patches.some(p => p.queuedActivationPending === null && p.queuedActivationTailCount === null)).toBe(true);
      const reloaded = sessionStore.getSession(session.sessionId)!;
      expect(reloaded.queuedActivationPending).toBeUndefined();
    } finally {
      unsub();
    }
  });

  it('promotes queuedActivationTail[0] with resume=true on cold-restore and rolls back cleanly on transient SQLite failures', () => {
    const dataDir = createIsolatedDataDir();

    // 1. Non-empty tail promotes Tail1 offline with queuedActivationResume=true
    const s1 = makeSession({
      backendType: 'tmux',
      queuedActivationPending: true,
      queuedActivationToken: 'tok-cold-head',
      queuedActivationInput: { content: 'head turn' },
      queuedActivationTurnId: 'om_turn_head',
      queuedActivationTailNextOrder: 2,
      queuedActivationTail: [
        { id: 'tail-1', order: 1, userPrompt: 'tail one', cliInput: { content: 'tail one' }, turnId: 'om_turn_tail_1' },
        { id: 'tail-2', order: 2, userPrompt: 'tail two', cliInput: { content: 'tail two' }, turnId: 'om_turn_tail_2' },
      ],
    });
    const ds1 = makeDaemonSession(s1);
    persistExecutionPhase(dataDir, ds1, 'om_turn_head', 'reconciling');

    const out1 = workerPool.settleOfflineReconciledQueuedActivation(ds1, {
      isCodexApp: false,
      isRemoteBackend: false,
      backingMode: 'cold_restore',
    });
    expect(out1).toBe('promoted_replay');
    expect(ds1.hasHistory).toBe(true);
    expect(ds1.session.queuedActivationPending).toBe(true);
    expect(ds1.session.queuedActivationTurnId).toBe('om_turn_tail_1');
    expect(ds1.session.queuedActivationResume).toBe(true);
    expect(ds1.session.queuedActivationToken).not.toBe('tok-cold-head');
    expect(ds1.session.queuedActivationTail?.map(e => e.turnId)).toEqual(['om_turn_tail_2']);

    // 2. Transient SQLite error during head clear rolls back journal and returns fallback_to_fork
    const s2 = makeSession({
      backendType: 'pty',
      queuedActivationPending: true,
      queuedActivationToken: 'tok-cold-err',
      queuedActivationInput: { content: 'head err' },
      queuedActivationTurnId: 'om_turn_err',
    });
    const ds2 = makeDaemonSession(s2);
    persistExecutionPhase(dataDir, ds2, 'om_turn_err', 'reconciling');
    sessionStore.__testOnly_setBeforeRowPersist(() => {
      throw new Error('SQLITE_BUSY_TEST');
    });
    const out2 = workerPool.settleOfflineReconciledQueuedActivation(ds2, {
      isCodexApp: false,
      isRemoteBackend: false,
      backingMode: 'cold_restore',
    });
    sessionStore.__testOnly_setBeforeRowPersist(undefined);
    expect(out2).toBe('fallback_to_fork');
    expect(ds2.session.queuedActivationPending).toBe(true);
    expect(ds2.session.queuedActivationToken).toBe('tok-cold-err');
    expect(ds2.hasHistory).toBe(false);

    // 3. Remote backends, unknown probes, live reattach, codex-app, and Case C (queued) NEVER settle offline
    expect(classifyOfflineColdRestoreSettlement({
      queuedActivationPending: true,
      isCodexApp: false,
      isRemoteBackend: true,
      backingMode: 'cold_restore',
      hasContract: true,
      turnId: 'om_remote',
      contractPhase: 'reconciling',
    })).toBe('defer_to_fork');
    expect(classifyOfflineColdRestoreSettlement({
      queuedActivationPending: true,
      isCodexApp: false,
      isRemoteBackend: false,
      backingMode: 'unknown_probe',
      hasContract: true,
      turnId: 'om_unknown',
      contractPhase: 'reconciling',
    })).toBe('defer_to_fork');
    expect(classifyOfflineColdRestoreSettlement({
      queuedActivationPending: true,
      isCodexApp: false,
      isRemoteBackend: false,
      backingMode: 'cold_restore',
      hasContract: true,
      turnId: 'om_queued',
      contractPhase: 'queued',
    })).toBe('defer_to_fork');
  });
});

describe('Worker tail isolation, reattach type-ahead gate, Case B settlement, and double-restart PID-marker adoption', () => {
  it('forces queueAfterActiveTurn=true on promoted tail messages (both same- and cross-principal) without clobbering Turn 1 card or rejecting cross-principal turns', async () => {
    const decisionSamePrincipal = decidePromotedActivationMessageHandling({
      hasQueuedActivationToken: true,
      explicitQueueAfterActiveTurn: false,
      reattachOpenTurnGate: true,
      remoteRunnerRecoveredTurnInFlight: false,
      activeTurnBlocks: false,
      activeTurnStartedOnDifferentTurn: true,
    });
    expect(decisionSamePrincipal).toEqual({
      queueAfterActiveTurn: true,
      reason: 'reattach_open_turn_gate',
    });

    const decisionCrossPrincipal = decidePromotedActivationMessageHandling({
      hasQueuedActivationToken: true,
      explicitQueueAfterActiveTurn: false,
      reattachOpenTurnGate: false,
      remoteRunnerRecoveredTurnInFlight: false,
      activeTurnBlocks: true,
      activeTurnStartedOnDifferentTurn: true,
    });
    expect(decisionCrossPrincipal).toEqual({
      queueAfterActiveTurn: true,
      reason: 'active_turn_blocks',
    });

    // Non-activation message keeps existing behavior (no forced queueAfterActiveTurn)
    expect(decidePromotedActivationMessageHandling({
      hasQueuedActivationToken: false,
      explicitQueueAfterActiveTurn: false,
      reattachOpenTurnGate: true,
      remoteRunnerRecoveredTurnInFlight: false,
      activeTurnBlocks: true,
      activeTurnStartedOnDifferentTurn: true,
    })).toEqual({ queueAfterActiveTurn: false, reason: 'none' });

    // Exercise the REAL worker `case 'message'` handler
    const activeTurnAuthority = new ActiveTurnAuthority();
    const userA = { requestUserOpenId: 'ou_user_a', requestLarkAppId: APP, senderType: 'user' as const };
    const userB = { requestUserOpenId: 'ou_user_b', requestLarkAppId: APP, senderType: 'user' as const };
    activeTurnAuthority.reserve({ turnId: 'om_turn_1', caller: userA });
    activeTurnAuthority.markStarted({ turnId: 'om_turn_1', caller: userA });

    const markNewTurn = vi.fn();
    const beginTurn = vi.fn();
    const sendToPty = vi.fn(() => true);
    const send = vi.fn();
    const rejectOrdinaryImTurn = vi.fn();

    const scope: Record<string, any> = {
      lastInitConfig: { cliId: 'claude-code', adoptMode: false },
      activeTurnAuthority,
      reattachOpenTurnGate: true,
      remoteRunnerRecoveredTurnInFlight: false,
      decidePromotedActivationMessageHandling,
      isOrdinaryImTurnId: (id?: string) => Boolean(id?.startsWith('om_')),
      receiveOrdinaryImTurn: () => 'new',
      acknowledgeTurnInputCommitted: vi.fn(),
      rejectOrdinaryImTurn,
      activeTurnBlocks: (input: any) => activeTurnAuthority.blocks({
        turnId: input.turnId,
        caller: input.trustedCaller,
        controller: input.trustedController,
        queueAfterActiveTurn: input.queueAfterActiveTurn,
      }),
      renderer: { markNewTurn },
      usageLimitTracker: { beginTurn },
      currentUsageLimitSnapshot: () => ({}),
      tmuxScrolledHalfPages: 0,
      messageAdoptMode: false,
      backend: { write: vi.fn() },
      crashDiagnosticStopped: false,
      sendToPty,
      send,
      deferTurnInputCommitUntilSubmission: () => false,
      markActiveTurnStarted: vi.fn(),
      rememberTurnLinkRefMode: vi.fn(),
      publishCliInputBacklog: vi.fn(),
      log: vi.fn(),
      onMessageHandled: vi.fn(),
      adoptRunState: undefined,
      maybeApplyRuntimeModelPatch: vi.fn(),
      maybeApplyRuntimeEffortPatch: vi.fn(),
      maybeApplyRuntimeLarkToolBindingPatch: vi.fn(),
      maybeApplyRuntimeTriggerUserAuthPatch: vi.fn(),
      maybeApplyRuntimeReplyDeliveryPatch: vi.fn(),
      maybeApplyRuntimeStartupCommandsPatch: vi.fn(),
      maybeApplyRuntimeLaunchShellPatch: vi.fn(),
      applyWorkerLaunchModel: vi.fn(),
      applyWorkerLaunchReasoningEffort: vi.fn(),
      applyWorkerLaunchLarkToolBinding: vi.fn(),
      applyWorkerLaunchTriggerUserAuth: vi.fn(),
      applyWorkerLaunchReplyDelivery: vi.fn(),
      applyWorkerLaunchStartupCommands: vi.fn(),
      applyWorkerLaunchLaunchShell: vi.fn(),
      applyRespawnConfigPatch: vi.fn(),
      respawnConfigPatchFromMessage: vi.fn(() => ({})),
      finalHandoffAdmissionEnabled: false,
      finalHandoffAdmissions: new Set(),
      pendingMessages: [],
      ordinaryImTurnDedupe: { release: vi.fn() },
    };
    const handleMessage = loadWorkerMessageHandler('message', scope);

    // Cross-principal promoted tail message MUST NOT be rejected or call markNewTurn
    await handleMessage({
      type: 'message',
      content: 'tail from user B',
      turnId: 'om_turn_tail_2',
      queuedActivationToken: 'tok-tail-2',
      trustedCaller: userB,
    });
    expect(rejectOrdinaryImTurn).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_input_rejected' }));
    expect(markNewTurn).not.toHaveBeenCalled();
    expect(beginTurn).not.toHaveBeenCalled();
    expect(sendToPty).toHaveBeenCalledWith(
      'tail from user B',
      'om_turn_tail_2',
      expect.objectContaining({
        queueAfterActiveTurn: true,
        queuedActivationToken: 'tok-tail-2',
      }),
    );

    // Same-principal promoted tail message while reattachOpenTurnGate is armed ALSO preserves Turn 1 card
    sendToPty.mockClear();
    await handleMessage({
      type: 'message',
      content: 'tail from user A',
      turnId: 'om_turn_tail_3',
      queuedActivationToken: 'tok-tail-3',
      trustedCaller: userA,
    });
    expect(markNewTurn).not.toHaveBeenCalled();
    expect(sendToPty).toHaveBeenCalledWith(
      'tail from user A',
      'om_turn_tail_3',
      expect.objectContaining({
        queueAfterActiveTurn: true,
        queuedActivationToken: 'tok-tail-3',
      }),
    );
  });

  it('disables type-ahead in flushPending while reattachOpenTurnGate is armed and drains once Turn 1 reaches prompt_ready', async () => {
    expect(shouldAllowTypeAheadOnReattach(true, true)).toBe(false);
    expect(shouldAllowTypeAheadOnReattach(false, true)).toBe(true);
    expect(shouldAllowTypeAheadOnReattach(false, false)).toBe(false);

    const h = workerSubmitHarness();
    const writeInput = vi.fn(async () => ({ submitted: true }));
    const tailItem = {
      content: 'promoted tail prompt',
      turnId: 'om_turn_tail_1',
      queuedActivationToken: 'tok-tail-1',
      queueAfterActiveTurn: true as const,
    };
    h.scope.pendingMessages.splice(0, h.scope.pendingMessages.length, tailItem);
    const sent: any[] = [];
    Object.assign(h.scope, {
      sessionId: 'sess-gate',
      lastInitConfig: { cliId: 'claude-code' },
      isPromptReady: false,
      reattachOpenTurnGate: true,
      shouldAllowTypeAheadOnReattach,
      pendingInputAllowsTypeAhead: (supportsTypeAhead: boolean) => supportsTypeAhead,
      runtimePtyInputPolicy: () => ({ supportsTypeAhead: true, allowBackToBackWrites: true }),
      idleDetector: { isStartupPending: () => false, programStatusHeldWorking: () => false, reset: vi.fn() },
      recordStructuredInput: vi.fn(),
      deferTurnInputCommitUntilSubmission: () => false,
      maybeQueuePostSubmitNativeSessionTitle: () => false,
      settleSubmission: vi.fn(),
      cliAdapter: { reliableTurnTerminal: true, writeInput },
      stampMojoTurnMark: vi.fn(),
      bridgeJsonlPath: null,
      codexBridgeFallbackActive: () => false,
      send: (m: any) => sent.push(m),
    });

    // While reattachOpenTurnGate is true (even if activeTurnBlocks is false — e.g. missing PID marker),
    // flushPending MUST hold the promoted tail item instead of type-ahead writing into Turn 1.
    await h.flush();
    expect(writeInput).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toHaveLength(1);

    // Once Turn 1 reaches prompt_ready, reattachOpenTurnGate drops and Tail1 flushes & ACKs.
    h.scope.reattachOpenTurnGate = false;
    h.scope.isPromptReady = true;
    await h.flush();
    expect(writeInput).toHaveBeenCalledTimes(1);
    expect(sent).toContainEqual({
      type: 'queued_activation_submitted',
      sessionId: 'sess-gate',
      activationToken: 'tok-tail-1',
    });
  });

  it('handles Case B (terminal Turn 1 not re-adopted) and Restart #2 mid-Turn-1 (unstarted Tail1 not retired) in restoreQueuedTurnsFromMarkerDisk', () => {
    const dir = createIsolatedDataDir('botmux-pid-marker-');
    const markerPath = join(dir, '12345.json');
    writeFileSync(markerPath, JSON.stringify({
      turnId: 'om_turn_1',
      callerOpenId: 'ou_user_a',
    }));

    // 1. Restart #2 mid-Turn-1: init reserved Tail1 (started: false), disk holds active Turn 1 ->
    // MUST call adoptInitialActiveTurn without calling adoptDisplacedActiveTurn.
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId: 'om_turn_tail_1' });
    const adoptInitialActiveTurn = vi.fn();
    const adoptDisplacedActiveTurn = vi.fn();
    const scopeRestart2: Record<string, any> = {
      existsSync: () => true,
      withPidMarkerLock: (_p: string, fn: () => void) => fn(),
      readFileSync: () => JSON.stringify({ turnId: 'om_turn_1', callerOpenId: 'ou_user_a' }),
      currentBotmuxTurnId: 'om_turn_tail_1',
      initialInputOwnershipPending: true,
      backend: { isReattach: true },
      activeTurnAuthority: authority,
      activeAuthorityMatchesMarker: () => false,
      retiredTurnIds: new Set<string>(),
      retireTerminatedMarkerTurn: () => false,
      workerSessionEventScope: { isExecutionSettled: () => false },
      shouldAdoptPidMarkerWithoutRetiringCurrent,
      adoptInitialActiveTurn,
      adoptDisplacedActiveTurn,
      queuedTypeAheadTurns: [],
      markerQueuedTurnStillLive: () => true,
      markerIdentityTurnId: (id?: string) => id,
    };
    const restoreRestart2 = loadWorkerFunction<(p: string) => void>('restoreQueuedTurnsFromMarkerDisk', scopeRestart2);
    restoreRestart2(markerPath);
    expect(adoptInitialActiveTurn).toHaveBeenCalledTimes(1);
    expect(adoptDisplacedActiveTurn).not.toHaveBeenCalled();

    // 2. Case B: Turn 1 is already terminal in SessionContract -> skip re-adopting Turn 1!
    const adoptInitialCaseB = vi.fn();
    const adoptDisplacedCaseB = vi.fn();
    const scopeCaseB: Record<string, any> = {
      ...scopeRestart2,
      currentBotmuxTurnId: undefined,
      initialInputOwnershipPending: false,
      activeTurnAuthority: new ActiveTurnAuthority(),
      workerSessionEventScope: { isExecutionSettled: (id: string) => id === 'om_turn_1' },
      adoptInitialActiveTurn: adoptInitialCaseB,
      adoptDisplacedActiveTurn: adoptDisplacedCaseB,
    };
    const restoreCaseB = loadWorkerFunction<(p: string) => void>('restoreQueuedTurnsFromMarkerDisk', scopeCaseB);
    restoreCaseB(markerPath);
    expect(adoptInitialCaseB).not.toHaveBeenCalled();
    expect(adoptDisplacedCaseB).not.toHaveBeenCalled();
  });
});

describe('WorkerSessionEventScope.inspectSubmissionGate & flushPending defense-in-depth', () => {
  it('separates persisted_non_queued from local_submission and only settles non-Codex-App persisted_non_queued in flushPending', async () => {
    const scopeObj = new WorkerSessionEventScope(
      { appId: APP, sessionId: 'sess-gate-inspect' },
      { workerId: 'worker-gen-2', generation: 2 },
    );
    const b = scopeObj.beginRuntime();
    scopeObj.noteAdmission({
      ref: { executionId: 'exec-1', turnId: 'om_reconciling' },
      phase: 'reconciling',
    });
    scopeObj.noteAdmission({
      ref: { executionId: 'exec-2', turnId: 'om_queued' },
      phase: 'queued',
    });
    scopeObj.noteAdmission({
      ref: { executionId: 'exec-3', turnId: 'om_local_untouched' },
      phase: 'queued',
    });
    scopeObj.recordSubmission('om_local_untouched');

    expect(scopeObj.inspectSubmissionGate('om_queued')).toEqual({
      canSubmit: true,
      phase: 'queued',
      terminal: false,
    });
    expect(scopeObj.inspectSubmissionGate('om_reconciling')).toEqual({
      canSubmit: false,
      reason: 'persisted_non_queued',
      phase: 'reconciling',
      terminal: false,
    });
    expect(scopeObj.inspectSubmissionGate('om_local_untouched')).toEqual({
      canSubmit: false,
      reason: 'local_submission',
      phase: 'submitting',
      terminal: false,
    });
    expect(b).toBeTruthy();

    // Verify pure gate decision for codex-app vs non-codex-app & local_submission
    expect(decideFlushSubmissionRejectionSettlement({
      isCodexApp: false,
      hasToken: true,
      gate: scopeObj.inspectSubmissionGate('om_reconciling'),
    })).toBe('settle_already_submitted');
    expect(decideFlushSubmissionRejectionSettlement({
      isCodexApp: false,
      hasToken: true,
      gate: scopeObj.inspectSubmissionGate('om_local_untouched'),
    })).toBe('retain');
    expect(decideFlushSubmissionRejectionSettlement({
      isCodexApp: true,
      hasToken: true,
      gate: scopeObj.inspectSubmissionGate('om_reconciling'),
    })).toBe('retain');

    // Exercise REAL flushPending on both persisted_non_queued (settles) and local_submission (does NOT settle)
    const h = workerSubmitHarness();
    const acked: any[] = [];
    const writeInput = vi.fn(async () => ({ submitted: true }));
    h.scope.pendingMessages.splice(
      0,
      h.scope.pendingMessages.length,
      { content: 'already ran', turnId: 'om_reconciling', queuedActivationToken: 'tok-reconciling' },
      { content: 'local untouched', turnId: 'om_local_untouched', queuedActivationToken: 'tok-local' },
    );
    Object.assign(h.scope, {
      sessionId: 'sess-gate-inspect',
      lastInitConfig: { cliId: 'claude-code' },
      isPromptReady: true,
      workerSessionEventScope: scopeObj,
      decideFlushSubmissionRejectionSettlement,
      isCodexAppCliId: (id?: string) => id === 'codex-app',
      cliAdapter: { reliableTurnTerminal: true, writeInput },
      acknowledgeQueuedActivation: (item: any) => acked.push(item.queuedActivationToken),
    });
    await h.flush();
    expect(writeInput).not.toHaveBeenCalled();
    expect(acked).toEqual(['tok-reconciling']);
  });
});

describe('Multi-entry FIFO tail drain & Codex App historical warm-reattach settlement', () => {
  it('settles a warm-reattached Codex App prepared activation under historical admission and promotes queuedActivationTail in strict (order, id) FIFO', async () => {
    const dataDir = createIsolatedDataDir();
    const session = makeSession({
      cliId: 'codex-app',
      queuedActivationPending: true,
      queuedActivationToken: 'tok-codex-head',
      queuedActivationTurnId: 'om_codex_1',
      codexAppDispatchLedger: [],
      queuedActivationTailNextOrder: 3,
      queuedActivationTail: [
        { id: 'b-second', order: 2, userPrompt: 'second', cliInput: { content: 'second' }, turnId: 'om_codex_3' },
        { id: 'a-first', order: 1, userPrompt: 'first', cliInput: { content: 'first' }, turnId: 'om_codex_2' },
      ],
    });
    const worker = makeFakeWorker();
    const ds = makeDaemonSession(session, {
      worker,
      workerGeneration: 2,
      initialStartPending: true,
    });
    ds.session.workerGeneration = 2;
    sessionStore.updateSession(ds.session);

    const controller = controllerForSession(ds, true)!;
    controller.bindWorker(2);
    // Simulate historical observer-grant admission scope where currentAuthority() === false
    const matchedToken = decideCodexAppSettlementActivationToken({
      queuedActivationPending: ds.session.queuedActivationPending === true,
      queuedActivationToken: ds.session.queuedActivationToken,
      queuedActivationTurnId: ds.session.queuedActivationTurnId,
      queuedActivationDispatchAttempt: ds.session.queuedActivationDispatchAttempt,
      hasPendingRepoRawInput: false,
      settledEntry: { turnId: 'om_codex_1', queuedActivationToken: 'tok-codex-head' },
      ledgerDrained: true,
    });
    expect(matchedToken).toBe('tok-codex-head');

    const promotedOrder: string[] = [];
    const ok = await controller.run(
      {
        kind: 'historical',
        context: {
          version: 2,
          session: controller.ref,
          producer: { workerId: 'worker-gen-2', generation: 2 },
          eventId: 'worker-gen-2:9',
          sequence: 9,
          scope: {},
        },
      },
      async () => {
        // Confirm default currentAuthority() really IS false under historical scope!
        expect(controller.currentAuthority()).toBe(false);
        return await workerPool.handleQueuedActivationSubmittedAck({
          ds,
          msg: { sessionId: ds.session.sessionId, activationToken: matchedToken! },
          tag: ds.session.sessionId.slice(0, 8),
          ownsLifecycleMutation: () => {
            const state = controller.store.read(controller.ref);
            return ds.worker === worker
              && !!state
              && state.lifecycle !== 'closing'
              && state.lifecycle !== 'closed'
              && state.lifecycle !== 'suspended';
          },
          updateSession: s => sessionStore.updateSession(s),
          onQueuedActivationSubmitted: target => {
            const head = [...(target.session.queuedActivationTail ?? [])]
              .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))[0];
            if (head) promotedOrder.push(head.turnId!);
            return workerPool.promoteQueuedActivationTail(target, { send: false });
          },
        });
      },
    );
    expect(ok).toBe(true);
    expect(ds.hasHistory).toBe(true);
    expect(promotedOrder).toEqual(['om_codex_2']);
    expect(ds.session.queuedActivationPending).toBe(true);
    expect(ds.session.queuedActivationTurnId).toBe('om_codex_2');
    expect(ds.session.queuedActivationTail?.map(e => e.turnId)).toEqual(['om_codex_3']);

    // Acknowledge Tail 1 -> promotes Tail 2
    const tail1Token = ds.session.queuedActivationToken!;
    await workerPool.handleQueuedActivationSubmittedAck({
      ds,
      msg: { sessionId: ds.session.sessionId, activationToken: tail1Token },
      tag: ds.session.sessionId.slice(0, 8),
      ownsLifecycleMutation: () => ds.worker === worker,
      updateSession: s => sessionStore.updateSession(s),
      onQueuedActivationSubmitted: target => {
        const head = [...(target.session.queuedActivationTail ?? [])]
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))[0];
        if (head) promotedOrder.push(head.turnId!);
        return workerPool.promoteQueuedActivationTail(target, { send: false });
      },
    });
    expect(promotedOrder).toEqual(['om_codex_2', 'om_codex_3']);
    expect(ds.session.queuedActivationTurnId).toBe('om_codex_3');
    expect(ds.session.queuedActivationTail).toBeUndefined();

    // Acknowledge Tail 2 -> tail empty, clears initialStartPending
    const tail2Token = ds.session.queuedActivationToken!;
    await workerPool.handleQueuedActivationSubmittedAck({
      ds,
      msg: { sessionId: ds.session.sessionId, activationToken: tail2Token },
      tag: ds.session.sessionId.slice(0, 8),
      ownsLifecycleMutation: () => ds.worker === worker,
      updateSession: s => sessionStore.updateSession(s),
    });
    expect(ds.session.queuedActivationPending).toBeUndefined();
    expect(ds.initialStartPending).toBe(false);
    expect(dataDir).toBeTruthy();
  });
});

describe('Adapter & backend parity (RemoteRunner, OpenCode/MiMoCode, Pi, Hybrid RPC ambiguous, Raw Input, Ordinary IM rejection)', () => {
  it('deduplicates RemoteRunner recovered turns and collects matched activation tokens without dropping unrelated turns', () => {
    const queue = [
      { turnId: 'om_remote_1', dispatchAttempt: 1, queuedActivationToken: 'tok-r1', content: 'turn 1' },
      { turnId: 'om_remote_2', dispatchAttempt: 1, queuedActivationToken: 'tok-r2', content: 'turn 2' },
    ];
    const res = reconcileRemoteRecoveredTurnQueue(
      queue,
      { turnId: 'om_remote_1', dispatchAttempt: 1 },
      { turnId: 'om_remote_1', dispatchAttempt: 1, queuedActivationToken: 'tok-r1' },
    );
    expect(res.matchedInitTurn).toBe(true);
    expect(res.matchedTokens).toEqual(['tok-r1']);
    expect(res.remaining.map(x => x.turnId)).toEqual(['om_remote_2']);
  });

  it('requires session ownership for OpenCode/MiMoCode durable argv reattach probe and skips Pi prepareInitialPromptArg on persistent reattach', () => {
    // Ownership verified via expectedCliSessionId
    expect(decideDurableArgvReattachSubmission({
      probeResult: { submitted: true, cliSessionId: 'ses_abc123' },
      expectedCliSessionId: 'ses_abc123',
      promptContainsSessionId: false,
    })).toEqual({ action: 'already_submitted', cliSessionId: 'ses_abc123' });

    // Ownership verified via ownedCliSessionId (latestOpenCodeSessionForBotmuxSession)
    expect(decideDurableArgvReattachSubmission({
      probeResult: { submitted: true, cliSessionId: 'ses_owned_9' },
      ownedCliSessionId: 'ses_owned_9',
      promptContainsSessionId: false,
    })).toEqual({ action: 'already_submitted', cliSessionId: 'ses_owned_9' });

    // Negative control: short generic prompt ("continue") from an unrelated OpenCode session MUST fail closed to replay!
    expect(decideDurableArgvReattachSubmission({
      probeResult: { submitted: true, cliSessionId: 'ses_other_session' },
      expectedCliSessionId: undefined,
      ownedCliSessionId: undefined,
      promptContainsSessionId: false,
    })).toEqual({ action: 'replay' });

    // Unreadable DB MUST fail closed to replay
    expect(decideDurableArgvReattachSubmission({
      probeResult: { submitted: false, unreadable: true },
      expectedCliSessionId: 'ses_abc123',
      promptContainsSessionId: true,
    })).toEqual({ action: 'replay' });

    // Pi persistent reattach: never invoke prepareInitialPromptArg and never substitute /botmux-initial-prompt
    expect(shouldPrepareInitialPromptArg({
      hasPrompt: true,
      willReattachPersistent: true,
      adoptMode: false,
    })).toBe(false);
    expect(shouldPrepareInitialPromptArg({
      hasPrompt: true,
      willReattachPersistent: false,
      adoptMode: false,
    })).toBe(true);
    expect(resolveInitialPromptDelivery({
      originalPrompt: 'real user prompt',
      preparedArg: '@file.txt',
      preparedDeferredContent: '/botmux-initial-prompt',
      defer: true,
      willReattachPersistent: true,
    })).toEqual({ queuedContent: 'real user prompt' });
  });

  it('settles hybrid RPC ambiguous activation token on clearRpcLifecycleFailClosedOwner and does NOT ACK on bare stopCodexRpcEngine teardown', () => {
    const engine = { stop: vi.fn() };
    const gen = { engine, cliGeneration: 1 };
    const identity = { turnId: 'om_rpc_1' };
    const ownerKey = `${identity.turnId}\0`;

    // 1. Positive path: clearRpcLifecycleFailClosedOwner ACKs ONLY with explicit acknowledgeActivation=true
    const ackedPositive: string[] = [];
    const scopePos: Record<string, any> = {
      rpcTurnOwnerKey: (id: any) => `${id.turnId}\0${id.dispatchAttempt ?? ''}`,
      sameRpcGeneration: (l: any, r: any) => l?.engine === r.engine && l.cliGeneration === r.cliGeneration,
      rpcLifecycleFailClosedOwners: new Map([[ownerKey, gen]]),
      rpcLifecycleFailClosedIdentities: new Map([[ownerKey, identity]]),
      ambiguousRpcActivationTokens: new Map([[ownerKey, { generation: gen, token: 'tok-rpc-amb' }]]),
      acknowledgeQueuedActivationToken: (tok: string) => ackedPositive.push(tok),
    };
    const clearOwner = loadWorkerFunction<(id: any, g: any, opts?: { acknowledgeActivation?: boolean }) => boolean>('clearRpcLifecycleFailClosedOwner', scopePos);
    expect(clearOwner(identity, gen, { acknowledgeActivation: true })).toBe(true);
    expect(ackedPositive).toEqual(['tok-rpc-amb']);
    expect(scopePos.ambiguousRpcActivationTokens.size).toBe(0);

    // 1b. Unproven timeout clear (no acknowledgeActivation) MUST NOT ACK
    const ackedTimeout: string[] = [];
    const scopeTimeout: Record<string, any> = {
      ...scopePos,
      rpcLifecycleFailClosedOwners: new Map([[ownerKey, gen]]),
      rpcLifecycleFailClosedIdentities: new Map([[ownerKey, identity]]),
      ambiguousRpcActivationTokens: new Map([[ownerKey, { generation: gen, token: 'tok-rpc-timeout' }]]),
      acknowledgeQueuedActivationToken: (tok: string) => ackedTimeout.push(tok),
    };
    const clearOwnerTimeout = loadWorkerFunction<(id: any, g: any, opts?: { acknowledgeActivation?: boolean }) => boolean>('clearRpcLifecycleFailClosedOwner', scopeTimeout);
    expect(clearOwnerTimeout(identity, gen)).toBe(true);
    expect(ackedTimeout).toEqual([]);

    // 2. Negative control: stopCodexRpcEngine MUST NOT ACK even when engine.stop()
    // synchronously emits a 'stopped' terminal through settleRpcTurnTerminal!
    const ackedTeardown: string[] = [];
    const scopeTeardown: Record<string, any> = {
      rpcEngagementFence: { invalidate: vi.fn() },
      taskContinuationRpcGeneration: 'rpc-gen',
      rpcTurnsAwaitingActivation: new Map(),
      rpcTurnsAwaitingActivationIdentities: new Map(),
      rpcTurnsAwaitingActivationReplayAnchors: new Map(),
      rpcLifecycleFailClosedOwners: new Map([[ownerKey, gen]]),
      rpcLifecycleFailClosedIdentities: new Map([[ownerKey, identity]]),
      ambiguousRpcActivationTokens: new Map([[ownerKey, { generation: gen, token: 'tok-rpc-teardown' }]]),
      pendingAmbiguousFreshRpcActivation: { token: 'tok-rpc-pending' },
      rpcActiveOwners: new Map(),
      settlingRpcTerminalOwners: new Map(),
      pendingRpcTurnTerminals: new Map(),
      rpcTerminalHydrationTerminals: new Map(),
      rpcTerminalHydrationTimers: new Map(),
      rpcTerminalHydrationOwners: new Map(),
      codexBridgeQueue: { peek: () => [] },
      emitTurnTerminal: vi.fn(),
      clearRpcEnginePidMarker: vi.fn(),
      stopStructuredStartGraceRecheck: vi.fn(),
      acknowledgeQueuedActivationToken: (tok: string) => ackedTeardown.push(tok),
      rpcTurnOwnerKey: (id: any) => `${id.turnId}\0${id.dispatchAttempt ?? ''}`,
      sameRpcGeneration: (l: any, r: any) => l?.engine === r.engine && l.cliGeneration === r.cliGeneration,
    };
    const clearDuringStop = loadWorkerFunction<(id: any, g: any, opts?: { acknowledgeActivation?: boolean }) => boolean>('clearRpcLifecycleFailClosedOwner', scopeTeardown);
    scopeTeardown.codexRpcEngine = {
      stop: vi.fn(() => {
        clearDuringStop(identity, gen, { acknowledgeActivation: true });
      }),
    };
    const stopEngine = loadWorkerFunction<() => void>('stopCodexRpcEngine', scopeTeardown);
    stopEngine();
    expect(ackedTeardown).toEqual([]);
    expect(scopeTeardown.ambiguousRpcActivationTokens.size).toBe(0);
    expect(scopeTeardown.pendingAmbiguousFreshRpcActivation).toBeUndefined();
  });

  it('reconciles already-submitted raw_input activations while delivering Case C raw_input and forwarding bundled followUpContent', async () => {
    const rawSession = {
      queuedActivationRawInput: '/clear',
      queuedActivationRawTurnId: 'om_raw_1',
    };
    expect(resolveQueuedActivationEffectiveTurn(rawSession)).toEqual({
      turnId: 'om_raw_1',
      isRawInput: true,
      hasTextPrompt: false,
      hasRawInput: true,
    });
    expect(decidePendingRawInputAction({
      isCodexApp: false,
      hasContract: true,
      contractPhase: 'reconciling',
      hasQueuedActivationToken: true,
    })).toBe('reconcile_already_submitted');
    expect(decidePendingRawInputAction({
      isCodexApp: false,
      hasContract: true,
      contractPhase: 'queued',
      hasQueuedActivationToken: true,
    })).toBe('send_raw_input');

    // Exercise REAL worker `case 'raw_input'` handler on persisted_non_queued with bundled followUpContent
    const acked: string[] = [];
    const sentFollowUps: any[] = [];
    const unattendedRawInputRefusal = vi.fn();
    const rawScope: Record<string, any> = {
      lastInitConfig: { cliId: 'claude-code' },
      isCodexAppCliId: (id?: string) => id === 'codex-app',
      decideRawInputSubmissionReconciliation,
      workerSessionEventScope: {
        inspectSubmissionGate: () => ({ canSubmit: false, reason: 'persisted_non_queued', phase: 'reconciling', terminal: false }),
      },
      acknowledgeQueuedActivationToken: (tok: string) => acked.push(tok),
      sendToPty: (content: string, turnId?: string, opts?: any) => {
        sentFollowUps.push({ content, turnId, opts });
        return true;
      },
      unattendedRawInputRefusal,
      log: vi.fn(),
    };
    const handleRaw = loadWorkerMessageHandler('raw_input', rawScope);
    await handleRaw({
      type: 'raw_input',
      content: '/compact',
      turnId: 'om_raw_1',
      queuedActivationToken: 'tok-raw-1',
      followUpContent: 'follow up prompt after raw',
      followUpTurnId: 'om_followup_2',
    });
    expect(unattendedRawInputRefusal).not.toHaveBeenCalled();
    expect(acked).toEqual(['tok-raw-1']);
    expect(sentFollowUps).toHaveLength(1);
    expect(sentFollowUps[0]).toMatchObject({
      content: 'follow up prompt after raw',
      turnId: 'om_followup_2',
    });

    // Ordinary IM rejection defense-in-depth
    expect(decideOrdinaryImRejectionAction('execution_reconciliation_required')).toBe('clear_without_retry');
    expect(decideOrdinaryImRejectionAction('cross_principal_requires_owner_confirmation')).toBe('default');
    expect(createQueuedActivationReceiptObserver).toBeTypeOf('function');
  });

  it('drives real worker case init: emits queued_activation_submitted after spawnCli+ready on reconcileQueuedActivation, preserves journal on spawn failure, replays Case C without false ACK, and enforces OpenCode ownership on durable argv reattach', async () => {
    const buildInitScope = (overrides: Record<string, any> = {}) => {
      const sent: any[] = [];
      const acked: Array<{ token: string; sessionId?: string }> = [];
      const pendingMessages: any[] = [];
      const persistedCliSessionIds: string[] = [];
      const scope: Record<string, any> = {
        WORKFLOW_NODE_SESSION_ENV: 'BOTMUX_WORKFLOW_NODE_SESSION',
        lastInitConfig: null,
        initHandoffRejectedTurnId: undefined,
        captureTurnFailureDiagnostics: false,
        workerSessionEventScope: undefined,
        initializeWorkerSessionContract: vi.fn(),
        isOrdinaryImTurnId: (id?: string) => Boolean(id?.startsWith('om_')),
        receiveOrdinaryImTurn: () => 'new',
        acknowledgeTurnInputCommitted: vi.fn(),
        resetFollowUpReplyStateForInit: vi.fn(),
        antigravityQuotaHistory: undefined,
        unconfirmedAntigravityQuotas: new Map(),
        kimiCacheExpiryAutoCompact: false,
        configureTraexAutoModel: vi.fn(),
        isCodexAppCliId: (id?: string) => id === 'codex-app',
        isCodexFamilyCliId: (id?: string) => id === 'codex' || id === 'codex-app' || id === 'traex' || id === 'coco',
        codexAppTurnLiveness: { retimeout: vi.fn() },
        applyCodexInstanceEnv: vi.fn(),
        codexUpgradeTimer: {},
        initialInputOwnershipPending: false,
        activeRestartAttemptId: undefined,
        seedInitTurnTerminals: vi.fn(),
        initializeFinalOutputHandoff: vi.fn(),
        applyInitFinalOutputBackpressure: vi.fn(),
        refreshTerminalWriteToken: vi.fn(),
        refreshTerminalCardViewToken: vi.fn(),
        applySessionOwnerEnv: vi.fn(),
        setDefaultLocale: vi.fn(),
        registerPromptOverrideResolver: vi.fn(),
        sessionStore: { init: vi.fn() },
        sessionLarkTransportEnabled: () => false,
        config: { daemon: { backendType: 'tmux' }, web: { workerHost: '127.0.0.1' } },
        resolveRenderDimensions: () => ({ cols: 160, rows: 50 }),
        log: vi.fn(),
        setCaptureIdentity: vi.fn(),
        rememberTurnLinkRefMode: vi.fn(),
        reserveActiveTurn: vi.fn(),
        markTurnExecutionStart: vi.fn(),
        writeCliPidMarker: vi.fn(),
        publishSandboxRelayCapability: vi.fn(),
        backendSupportsWebTerminal: () => false,
        isWorkflowWorker: () => false,
        startScreenUpdates: vi.fn(),
        startStuckDetector: vi.fn(),
        startIdleSpinDetector: vi.fn(),
        orchestrateCodexRpcInit: vi.fn(async () => ({ engaged: false, queuePrompt: true, abortSpawn: false })),
        sandboxEnabled: () => false,
        spawnCli: vi.fn(async () => {}),
        traexAutoModelRuntimeEligible: () => false,
        publishActiveRuntime: vi.fn(),
        prepareCodexNativeTitleGeneration: vi.fn(async () => {}),
        codexRpcEngine: undefined,
        deferredFreshRpcTurn: undefined,
        pendingAmbiguousFreshRpcActivation: undefined,
        lastSpawnDeferInitialPrompt: true,
        lastSpawnPersistentReattach: true,
        lastSpawnQueuedInitialPrompt: undefined,
        lastSpawnQueuedInitialPromptLogicalContent: undefined,
        lastSpawnArgvDurableInitialPrompt: false,
        lastSpawnArgvDurableInitialPromptSubmission: undefined,
        cliAdapter: { passesInitialPromptViaArgs: false },
        codexBridgeFallbackActive: () => false,
        codexAppRecoveredDispatches: [],
        takeUnsentInputsFromPredecessor: () => [],
        remoteRunnerRecoveredTurnIdentity: undefined,
        reattachOpenTurnGate: true,
        activeTurnAuthority: new ActiveTurnAuthority(),
        shouldQueueInitialPrompt: ({ hasPrompt }: { hasPrompt: boolean }) => hasPrompt,
        inputForcesSerialTurn,
        spawnCliReconciledActivationToken: undefined,
        pendingMessages,
        decideDurableArgvReattachSubmission,
        persistCliSessionId: (id: string) => persistedCliSessionIds.push(id),
        markActiveTurnStarted: vi.fn(),
        deferTurnInputCommitUntilSubmission: () => false,
        initPromptMaterialized: false,
        isPromptReady: false,
        flushPending: vi.fn(),
        send: (m: any) => sent.push(m),
        writeToken: 'wt',
        viewToken: 'vt',
        cardViewToken: 'cvt',
        capturedSpawnCommand: undefined,
        readSendMarkers: () => [],
        currentBotmuxTurnId: undefined,
        currentBotmuxDispatchAttempt: undefined,
        acknowledgeQueuedActivationToken: (token: string, sid?: string) => {
          acked.push({ token, sessionId: sid });
          sent.push({ type: 'queued_activation_submitted', sessionId: sid ?? 'sess-init', activationToken: token });
          return true;
        },
        CliSpawnSupersededError: class CliSpawnSupersededError extends Error {},
        sendFatalWorkerErrorAndExit: vi.fn(async () => {}),
        sessionId: 'sess-init-1',
        backend: { isReattach: true },
        cliSpawnGeneration: 2,
        ...overrides,
      };
      const handleInit = loadWorkerMessageHandler('init', scope);
      return { scope, sent, acked, pendingMessages, persistedCliSessionIds, handleInit };
    };

    // 1. Reconciled reattach (Case A/B): prompt='', reconcileQueuedActivation set ->
    // emits ready FIRST, then queued_activation_submitted(tok), zero queued prompts.
    const h1 = buildInitScope();
    await h1.handleInit({
      type: 'init',
      sessionId: 'sess-init-1',
      chatId: 'oc_chat',
      rootMessageId: 'om_turn_1',
      workingDir: '/tmp',
      cliId: 'claude-code',
      backendType: 'tmux',
      prompt: '',
      resume: true,
      larkAppId: APP,
      larkAppSecret: '',
      queuedActivationToken: 'tok-reconcile-1',
      reconcileQueuedActivation: { turnId: 'om_turn_1', phase: 'reconciling' },
    });
    expect(h1.scope.sendFatalWorkerErrorAndExit).not.toHaveBeenCalled();
    expect(h1.pendingMessages).toEqual([]);
    expect(h1.sent.map(m => m.type)).toEqual(['ready', 'queued_activation_submitted']);
    expect(h1.acked).toEqual([{ token: 'tok-reconcile-1', sessionId: 'sess-init-1' }]);

    // 2. Failed spawnCli on reconciled reattach -> MUST NOT emit queued_activation_submitted!
    const h2 = buildInitScope({
      spawnCli: vi.fn(async () => { throw new Error('tmux attach failed'); }),
    });
    await h2.handleInit({
      type: 'init',
      sessionId: 'sess-init-1',
      chatId: 'oc_chat',
      rootMessageId: 'om_turn_1',
      workingDir: '/tmp',
      cliId: 'claude-code',
      backendType: 'tmux',
      prompt: '',
      resume: true,
      larkAppId: APP,
      larkAppSecret: '',
      queuedActivationToken: 'tok-reconcile-fail',
      reconcileQueuedActivation: { turnId: 'om_turn_1', phase: 'reconciling' },
    });
    expect(h2.acked).toEqual([]);
    expect(h2.scope.sendFatalWorkerErrorAndExit).toHaveBeenCalledTimes(1);

    // 3. Case C negative control: prompt non-empty, NO reconcileQueuedActivation ->
    // queues prompt into pendingMessages and emits ONLY ready (NO queued_activation_submitted!).
    const h3 = buildInitScope();
    await h3.handleInit({
      type: 'init',
      sessionId: 'sess-init-1',
      chatId: 'oc_chat',
      rootMessageId: 'om_turn_c',
      workingDir: '/tmp',
      cliId: 'claude-code',
      backendType: 'tmux',
      prompt: 'unsubmitted opening prompt',
      turnId: 'om_turn_c',
      resume: false,
      larkAppId: APP,
      larkAppSecret: '',
      queuedActivationToken: 'tok-case-c',
    });
    expect(h3.scope.sendFatalWorkerErrorAndExit).not.toHaveBeenCalled();
    expect(h3.pendingMessages).toHaveLength(1);
    expect(h3.pendingMessages[0]).toMatchObject({
      content: 'unsubmitted opening prompt',
      turnId: 'om_turn_c',
      queuedActivationToken: 'tok-case-c',
      queueAfterActiveTurn: true,
    });
    expect(h3.acked).toEqual([]);
    expect(h3.sent.map(m => m.type)).toEqual(['ready']);

    // 4. OpenCode durable argv persistent reattach: owned fresh match settles without re-queueing;
    // unowned generic match ("continue") AND resumed Case-C match (resume=true) fail closed and replay!
    const h4Owned = buildInitScope({
      cliAdapter: {
        passesInitialPromptViaArgs: true,
        durableInitialPromptViaArgs: true,
        findInitialPromptArgSubmission: () => ({ submitted: true, cliSessionId: 'ses_owned_42' }),
        buildResumeCommand: () => 'opencode -s ses_owned_42',
      },
    });
    await h4Owned.handleInit({
      type: 'init',
      sessionId: 'sess-init-1',
      chatId: 'oc_chat',
      rootMessageId: 'om_turn_oc_1',
      workingDir: '/tmp',
      cliId: 'opencode',
      backendType: 'tmux',
      prompt: 'continue',
      resume: false,
      turnId: 'om_turn_oc_1',
      larkAppId: APP,
      larkAppSecret: '',
      queuedActivationToken: 'tok-oc-owned',
    });
    expect(h4Owned.scope.sendFatalWorkerErrorAndExit).not.toHaveBeenCalled();
    expect(h4Owned.pendingMessages).toEqual([]);
    expect(h4Owned.persistedCliSessionIds).toEqual(['ses_owned_42']);
    expect(h4Owned.acked).toEqual([{ token: 'tok-oc-owned', sessionId: 'sess-init-1' }]);

    const h4Unowned = buildInitScope({
      cliAdapter: {
        passesInitialPromptViaArgs: true,
        durableInitialPromptViaArgs: true,
        findInitialPromptArgSubmission: () => ({ submitted: true, cliSessionId: 'ses_unrelated_99' }),
        buildResumeCommand: () => null,
      },
    });
    await h4Unowned.handleInit({
      type: 'init',
      sessionId: 'sess-init-1',
      chatId: 'oc_chat',
      rootMessageId: 'om_turn_oc_2',
      workingDir: '/tmp',
      cliId: 'opencode',
      backendType: 'tmux',
      prompt: 'continue',
      resume: false,
      turnId: 'om_turn_oc_2',
      larkAppId: APP,
      larkAppSecret: '',
      queuedActivationToken: 'tok-oc-unowned',
    });
    expect(h4Unowned.scope.sendFatalWorkerErrorAndExit).not.toHaveBeenCalled();
    expect(h4Unowned.pendingMessages).toHaveLength(1);
    expect(h4Unowned.acked).toEqual([]);

    // Resumed Case-C OpenCode turn repeating prior user text MUST replay, never false-ACK!
    const h4ResumedCaseC = buildInitScope({
      cliAdapter: {
        passesInitialPromptViaArgs: true,
        durableInitialPromptViaArgs: true,
        findInitialPromptArgSubmission: () => ({ submitted: true, cliSessionId: 'ses_owned_42' }),
        buildResumeCommand: () => 'opencode -s ses_owned_42',
      },
    });
    await h4ResumedCaseC.handleInit({
      type: 'init',
      sessionId: 'sess-init-1',
      chatId: 'oc_chat',
      rootMessageId: 'om_turn_oc_3',
      workingDir: '/tmp',
      cliId: 'opencode',
      backendType: 'tmux',
      prompt: 'continue',
      resume: true,
      cliSessionId: 'ses_owned_42',
      turnId: 'om_turn_oc_3',
      larkAppId: APP,
      larkAppSecret: '',
      queuedActivationToken: 'tok-oc-resumed-c',
    });
    expect(h4ResumedCaseC.scope.sendFatalWorkerErrorAndExit).not.toHaveBeenCalled();
    expect(h4ResumedCaseC.pendingMessages).toHaveLength(1);
    expect(h4ResumedCaseC.acked).toEqual([]);
  });
});

describe('Production wiring & adversarial regression probes (P0/P1/P2)', () => {
  it('P0-1: SessionController.command omits dead Gen-1 activeRuntime before Gen-2 binds so promoted Tail1 is never dropped as stale_runtime_target', () => {
    const dataDir = createIsolatedDataDir();
    const session = makeSession({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-gen1-head',
      queuedActivationTurnId: 'om_turn_1',
    });
    const ds = makeDaemonSession(session);
    const controller = controllerForSession(ds, true)!;
    const w1 = controller.bindWorker(1);
    const rt1 = controller.reserveBinding('bind-g1', w1.worker);
    controller.bindRuntime('bind-g1', w1.worker, {
      backend: 'tmux',
      physicalId: 'pid:7001:boot:1',
      nativeSessionId: session.sessionId,
      proof: 'process_start',
    });
    controller.workerLost(w1.worker);
    // Gen 2 binds worker BEFORE binding its own runtime
    const w2 = controller.bindWorker(2);
    expect(rt1.epoch).toBe(1);
    const execTail = controller.admitInput('om_turn_tail_1');
    const cmd = controller.command({ type: 'message', turnId: 'om_turn_tail_1' });
    expect(cmd.runtime).toBeUndefined();
    expect(cmd.execution?.executionId).toBe(execTail.executionId);

    // Feed into worker admitSessionCommand before Gen 2 runtime is assigned
    const decision = admitSessionCommand('message', cmd, undefined);
    expect(decision).toEqual({ allowed: true });
    expect(w2.worker.generation).toBe(2);

    // PROBE_1 (in-worker rebind): once Gen 2 has live rt2, a pre-scoped `message`
    // command without runtime MUST NOT get `runtime` retrofitted onto it (so
    // in-worker rebind accepts it without stale_runtime_target).
    const rt2 = controller.reserveBinding('bind-g2', w2.worker);
    controller.bindRuntime('bind-g2', w2.worker, {
      backend: 'tmux',
      physicalId: 'pid:7002:boot:1',
      nativeSessionId: session.sessionId,
      proof: 'process_start',
    });
    const execDuringRebind = controller.admitInput('om_turn_during_rebind');
    const preScopedMsgCmd = controller.command({
      type: 'message',
      turnId: 'om_turn_during_rebind',
      sessionCommand: { version: 2, execution: execDuringRebind },
    });
    expect(preScopedMsgCmd.runtime).toBeUndefined();
    expect(admitSessionCommand('message', preScopedMsgCmd, undefined)).toEqual({ allowed: true });

    // PROBE_2 (raw_input on Gen 2 referencing a dead Gen-1 execution):
    // SessionController.command() MUST stamp live rt2 (NOT stopped rt1!).
    const execGen1 = controller.store.admitExecution(controller.ref, 'om_dead_gen1_raw');
    controller.store.bindQueuedExecution(controller.ref, execGen1.ref, rt1);
    const rawCmd = controller.command({
      type: 'raw_input',
      turnId: 'om_dead_gen1_raw',
      sessionCommand: { version: 2, execution: execGen1.ref },
    });
    expect(rawCmd.runtime).toEqual(rt2);
    expect(admitSessionCommand('raw_input', rawCmd, rt2)).toEqual({ allowed: true });
    expect(dataDir).toBeTruthy();
  });

  it('P1-1: promoteQueuedActivationTail attaches sessionCommand.execution for SessionController.ingest AND kills live worker if controller.admitInput throws', () => {
    const dataDir = createIsolatedDataDir();
    const session = makeSession({
      queuedActivationPending: undefined,
      queuedActivationTailNextOrder: 2,
      queuedActivationTail: [
        { id: 'tail-live-1', order: 1, userPrompt: 'tail live', cliInput: { content: 'tail live' }, turnId: 'om_turn_tail_live' },
      ],
    });
    const worker = makeFakeWorker();
    const ds = makeDaemonSession(session, { worker, workerGeneration: 2, initialStartPending: true });
    ds.session.workerGeneration = 2;
    sessionStore.updateSession(ds.session);
    const controller = controllerForSession(ds, true)!;
    const w2 = controller.bindWorker(2);

    const promoted = workerPool.promoteQueuedActivationTail(ds);
    expect(promoted).toBe(true);
    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0].sessionCommand?.execution?.turnId).toBe('om_turn_tail_live');

    // Worker remembers execution from sessionCommand and emits turn_input_received ->
    // SessionController.ingest MUST admit it (not reject with execution_scope_missing).
    const scope = new WorkerSessionEventScope(w2.session, w2.worker);
    scope.rememberExecution(worker.sent[0].sessionCommand.execution);
    const sessionEventMetadata = loadWorkerFunction<(msg: any) => any>('sessionEventMetadata', {
      workerSessionEventScope: scope,
    });
    const framed = sessionEventMetadata({ type: 'turn_input_received', turnId: 'om_turn_tail_live' });
    expect(controller.ingest(framed, w2.worker).kind).toBe('worker');

    // Half-completed promotion: admitInput throws AFTER sessionStore.updateSession ->
    // MUST kill ds.worker instead of leaving a live worker permanently wedged.
    const s2 = makeSession({
      queuedActivationPending: undefined,
      queuedActivationTailNextOrder: 2,
      queuedActivationTail: [
        { id: 'tail-err-1', order: 1, userPrompt: 'tail err', cliInput: { content: 'tail err' }, turnId: 'om_turn_tail_err' },
      ],
    });
    const worker2 = makeFakeWorker();
    const ds2 = makeDaemonSession(s2, { worker: worker2, workerGeneration: 2, initialStartPending: true });
    ds2.session.workerGeneration = 2;
    sessionStore.updateSession(ds2.session);
    const ctrl2 = controllerForSession(ds2, true)!;
    ctrl2.bindWorker(2);
    vi.spyOn(ctrl2, 'admitInput').mockImplementation(() => {
      throw new Error('SQLITE_BUSY_ADMIT');
    });
    const promotedErr = workerPool.promoteQueuedActivationTail(ds2);
    // Durable promotion already persisted; post-persist admitInput throw kills
    // the unfenced live worker so recovery replays the promoted head.
    expect(promotedErr).toBe(true);
    expect(worker2.sent).toHaveLength(0);
    expect(worker2.kill).toHaveBeenCalledTimes(1);
    expect(dataDir).toBeTruthy();
  });

  it('P1-3 + W1: real forkWorker reconciles Case A (strips prompt, sets resume=true before sandbox freeze, preserves token), replays Case C, reconciles drained Codex App, and rolls back pre-init failure cleanly', () => {
    const dataDir = createIsolatedDataDir();

    // 1. Case A (phase='reconciling') on legacy sandbox-unset row:
    const sA = makeSession({
      backendType: 'tmux',
      queuedActivationPending: true,
      queuedActivationToken: 'tok-fw-case-a',
      queuedActivationInput: { content: 'already running opening' },
      queuedActivationTurnId: 'om_fw_case_a',
      queuedActivationResume: false,
      sandbox: undefined,
    });
    const dsA = makeDaemonSession(sA, {
      hasHistory: false,
      pendingRawInput: '/compact',
      pendingRawTurnId: 'om_fw_case_a',
    });
    persistExecutionPhase(dataDir, dsA, 'om_fw_case_a', 'reconciling');
    const fakeW1 = makeFakeWorker();
    workerPool.__testOnly_setWorkerSpawner(() => fakeW1);

    workerPool.forkWorker(dsA, dsA.session.queuedActivationInput!, {
      resume: false,
      turnId: 'om_fw_case_a',
    }, { reattachLiveBackend: true });
    fakeW1.emit('message', { type: 'worker_ipc_ready' });
    const initA = fakeW1.sent.find((m: any) => m.type === 'init');
    expect(initA).toBeDefined();
    expect(initA.prompt).toBe('');
    expect(initA.turnId).toBeUndefined();
    expect(initA.resume).toBe(true);
    expect(initA.queuedActivationToken).toBe('tok-fw-case-a');
    expect(initA.reconcileQueuedActivation).toEqual({ turnId: 'om_fw_case_a', phase: 'reconciling' });
    expect(dsA.pendingRawInput).toBeUndefined();
    // Sandbox froze with resume=true (legacy row -> 'off', not true)
    expect(dsA.session.sandbox).toBe('off');

    // 2. Case C negative control (phase='queued'): forkWorker keeps prompt intact and NO reconcileQueuedActivation
    const sC = makeSession({
      backendType: 'tmux',
      queuedActivationPending: true,
      queuedActivationToken: 'tok-fw-case-c',
      queuedActivationInput: { content: 'never written opening' },
      queuedActivationTurnId: 'om_fw_case_c',
      queuedActivationResume: false,
    });
    const dsC = makeDaemonSession(sC, { hasHistory: false });
    persistExecutionPhase(dataDir, dsC, 'om_fw_case_c', 'queued');
    const fakeW2 = makeFakeWorker();
    workerPool.__testOnly_setWorkerSpawner(() => fakeW2);

    workerPool.forkWorker(dsC, dsC.session.queuedActivationInput!, {
      resume: false,
      turnId: 'om_fw_case_c',
    }, { reattachLiveBackend: true });
    fakeW2.emit('message', { type: 'worker_ipc_ready' });
    const initC = fakeW2.sent.find((m: any) => m.type === 'init');
    expect(initC.prompt).toBe('never written opening');
    expect(initC.turnId).toBe('om_fw_case_c');
    expect(initC.reconcileQueuedActivation).toBeUndefined();

    // 3. Pre-init spawn failure on reconcileQueuedActivation rolls back pendingRawInput and clears initialStartPending
    const sFail = makeSession({
      backendType: 'tmux',
      queuedActivationPending: true,
      queuedActivationToken: 'tok-fw-fail',
      queuedActivationInput: { content: 'already running' },
      queuedActivationTurnId: 'om_fw_fail',
    });
    const dsFail = makeDaemonSession(sFail, {
      initialStartPending: true,
      pendingRawInput: '/status',
      pendingRawTurnId: 'om_fw_fail',
    });
    persistExecutionPhase(dataDir, dsFail, 'om_fw_fail', 'reconciling');
    workerPool.__testOnly_setWorkerSpawner(() => {
      throw new Error('SPAWN_EMFILE_TEST');
    });
    expect(() => workerPool.forkWorker(dsFail, dsFail.session.queuedActivationInput!, {
      resume: false,
      turnId: 'om_fw_fail',
    }, { reattachLiveBackend: true })).toThrow('SPAWN_EMFILE_TEST');
    expect(dsFail.worker).toBeNull();
    expect(dsFail.initialStartPending).toBe(false);
    expect(dsFail.pendingRawInput).toBe('/status');
    expect(dsFail.pendingRawTurnId).toBe('om_fw_fail');

    // 4. Cursor/MTR Turn-1 live reattach preserves resume=false so bridge reads offset 0
    expect(shouldSkipResumeForReconciledBridge({ reattachLiveBackend: true, hasHistory: false, cliId: 'cursor' })).toBe(true);
    expect(shouldSkipResumeForReconciledBridge({ reattachLiveBackend: true, hasHistory: false, cliId: 'mtr' })).toBe(true);
    expect(shouldSkipResumeForReconciledBridge({ reattachLiveBackend: true, hasHistory: false, cliId: 'claude-code' })).toBe(false);
    expect(shouldSkipResumeForReconciledBridge({ reattachLiveBackend: false, hasHistory: false, cliId: 'cursor' })).toBe(false);

    // 5. Drained Codex App ledger recovers cleanly via reconcile_already_submitted instead of wedging
    expect(classifyQueuedActivationInitPlan({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-codex-drained',
      isCodexApp: true,
      hasUnsettledCodexAppDispatch: false,
      hasTextPrompt: false,
      hasRawInput: false,
      turnId: 'om_codex_drained',
      hasContract: false,
    })).toEqual({
      action: 'reconcile_already_submitted',
      hint: { turnId: 'om_codex_drained', phase: 'succeeded' },
    });
    expect(isDurableArgvCliId('opencode')).toBe(true);
    expect(isDurableArgvCliId('mimocode')).toBe(true);
    expect(isDurableArgvCliId('claude-code')).toBe(false);
  });

  it('P0-3 + P1-2 + P1-7 + P2-1 + W3/W4/W5: real setupWorkerHandlers atomically settles Codex App cancel (no split on SQLite error, blocks suspending, excludes durable-replay cancel), reconciles prompt_ready raw input ahead of tail, and clears ordinary IM delivery on execution_reconciliation_required', async () => {
    const dataDir = createIsolatedDataDir();

    // 1. Atomic Codex App cancel: SQLite failure rolls back BOTH ledger and queuedActivationPending (ok=false)
    const sCodex = makeSession({
      cliId: 'codex-app',
      queuedActivationPending: true,
      queuedActivationToken: 'tok-ca-atomic',
      queuedActivationTurnId: 'om_ca_1',
      codexAppDispatchLedger: [{
        dispatchId: 'disp-atomic-1',
        turnId: 'om_ca_1',
        content: 'hello',
        state: 'prepared',
        queuedActivationToken: 'tok-ca-atomic',
        acceptedAt: new Date().toISOString(),
      }],
      queuedActivationTailNextOrder: 2,
      queuedActivationTail: [
        { id: 'tail-ca-2', order: 1, userPrompt: 'tail 2', cliInput: { content: 'tail 2' }, turnId: 'om_ca_2' },
      ],
    });
    const wCodex = makeFakeWorker();
    const dsCodex = makeDaemonSession(sCodex, { worker: wCodex, workerGeneration: 1, initialStartPending: true });
    dsCodex.session.workerGeneration = 1;
    sessionStore.updateSession(dsCodex.session);
    const tailPromoted: string[] = [];
    workerPool.initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => dataDir,
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onQueuedActivationSubmitted: async target => {
        const head = target.session.queuedActivationTail?.[0];
        if (head?.turnId) tailPromoted.push(head.turnId);
        return workerPool.promoteQueuedActivationTail(target, { send: false });
      },
    });
    workerPool.__testOnly_setupWorkerHandlers(dsCodex, wCodex, { workerGeneration: 1 });
    const ctrlCodex = controllerForSession(dsCodex, true)!;
    const wRefCodex = ctrlCodex.bindWorker(1);
    const scopeCodex = new WorkerSessionEventScope(wRefCodex.session, wRefCodex.worker);
    const bindCodex = scopeCodex.beginRuntime();
    ctrlCodex.reserveBinding(bindCodex.bindingId, wRefCodex.worker);
    const rtCodex = ctrlCodex.bindRuntime(bindCodex.bindingId, wRefCodex.worker, {
      backend: 'tmux',
      physicalId: 'pid:8101:boot:1',
      nativeSessionId: sCodex.sessionId,
      proof: 'process_start',
    });
    scopeCodex.assign(bindCodex.bindingId, rtCodex.ref);
    const metaCodex = loadWorkerFunction<(msg: any) => any>('sessionEventMetadata', {
      workerSessionEventScope: scopeCodex,
    });

    // Inject SQLite failure -> BOTH ledger AND activation journal roll back atomically!
    sessionStore.__testOnly_setBeforeRowPersist(() => { throw new Error('SQLITE_ATOMIC_FAIL'); });
    wCodex.emit('message', scopeCodex.run(bindCodex, () => metaCodex({
      type: 'codex_app_dispatch_transition',
      sessionId: sCodex.sessionId,
      requestId: 'req-fail-1',
      operation: 'cancel',
      entries: [{ dispatchId: 'disp-atomic-1', turnId: 'om_ca_1' }],
    })));
    await new Promise(r => setTimeout(r, 30));
    sessionStore.__testOnly_setBeforeRowPersist(undefined);
    expect(wCodex.sent.some((m: any) => m.type === 'codex_app_dispatch_persisted' && m.requestId === 'req-fail-1' && m.ok === false)).toBe(true);
    expect(dsCodex.session.codexAppDispatchLedger).toHaveLength(1);
    expect(dsCodex.session.queuedActivationPending).toBe(true);

    // Now succeed -> single atomic commit clears head AND promotes tail-ca-2!
    wCodex.emit('message', scopeCodex.run(bindCodex, () => metaCodex({
      type: 'codex_app_dispatch_transition',
      sessionId: sCodex.sessionId,
      requestId: 'req-ok-1',
      operation: 'cancel',
      entries: [{ dispatchId: 'disp-atomic-1', turnId: 'om_ca_1' }],
    })));
    await new Promise(r => setTimeout(r, 40));
    expect(wCodex.sent.some((m: any) => m.type === 'codex_app_dispatch_persisted' && m.requestId === 'req-ok-1' && m.ok === true)).toBe(true);
    expect(tailPromoted).toEqual(['om_ca_2']);
    expect(dsCodex.session.queuedActivationTurnId).toBe('om_ca_2');

    // Pure checks for explicit mismatch, immediate raw input, and durable-replay cancel
    expect(decideCodexAppSettlementActivationToken({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-new',
      queuedActivationTurnId: 'om_new',
      hasPendingRawInput: false,
      settledEntry: { turnId: 'om_old', queuedActivationToken: 'tok-old' },
      ledgerDrained: true,
    })).toBeUndefined();
    expect(decideCodexAppSettlementActivationToken({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-raw',
      hasPendingRawInput: true,
      ledgerDrained: true,
    })).toBeUndefined();
    expect(decideCodexAppSettlementActivationToken({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-dur',
      queuedActivationTurnId: 'om_dur',
      queuedActivationDispatchAttempt: 1,
      hasPendingRawInput: false,
      isDurableReplayCancel: true,
      settledEntry: { turnId: 'om_dur', dispatchAttempt: 1, queuedActivationToken: 'tok-dur' },
      ledgerDrained: true,
    })).toBeUndefined();

    // 2. Real setupWorkerHandlers case 'prompt_ready': bundled followUp arrives STRICTLY BEFORE queuedActivationTail[0]
    const sRaw = makeSession({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-raw-head',
      queuedActivationRawInput: '/compact',
      queuedActivationRawTurnId: 'om_raw_submitted',
      queuedActivationTurnId: 'om_raw_submitted',
      queuedActivationTailNextOrder: 2,
      queuedActivationTail: [
        { id: 'tail-after-raw', order: 1, userPrompt: 'LATER_TAIL_MSG', cliInput: { content: 'LATER_TAIL_MSG' }, turnId: 'om_later_tail' },
      ],
    });
    const wRaw = makeFakeWorker();
    const dsRaw = makeDaemonSession(sRaw, {
      worker: wRaw,
      workerGeneration: 1,
      initialStartPending: true,
      pendingRawInput: '/compact',
      pendingRawTurnId: 'om_raw_submitted',
      pendingFollowUpInput: {
        userPrompt: 'EARLIER_FOLLOWUP_MSG',
        cliInput: 'EARLIER_FOLLOWUP_MSG',
        turnId: 'om_earlier_followup',
      },
    });
    dsRaw.session.workerGeneration = 1;
    sessionStore.updateSession(dsRaw.session);
    persistExecutionPhase(dataDir, dsRaw, 'om_raw_submitted', 'submitting');
    workerPool.initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => dataDir,
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onQueuedActivationSubmitted: async target => workerPool.promoteQueuedActivationTail(target),
    });
    workerPool.__testOnly_setupWorkerHandlers(dsRaw, wRaw, { workerGeneration: 1 });
    const ctrlRaw = controllerForSession(dsRaw, true)!;
    const wRefRaw = ctrlRaw.bindWorker(1);
    const scopeRaw = new WorkerSessionEventScope(wRefRaw.session, wRefRaw.worker);
    const bindRaw = scopeRaw.beginRuntime();
    ctrlRaw.reserveBinding(bindRaw.bindingId, wRefRaw.worker);
    const rtRaw = ctrlRaw.bindRuntime(bindRaw.bindingId, wRefRaw.worker, {
      backend: 'tmux',
      physicalId: 'pid:8102:boot:1',
      nativeSessionId: sRaw.sessionId,
      proof: 'process_start',
    });
    scopeRaw.assign(bindRaw.bindingId, rtRaw.ref);
    const metaRaw = loadWorkerFunction<(msg: any) => any>('sessionEventMetadata', {
      workerSessionEventScope: scopeRaw,
    });
    wRaw.emit('message', { type: 'worker_ipc_ready' });
    wRaw.emit('message', scopeRaw.run(bindRaw, () => metaRaw({ type: 'prompt_ready' })));
    await new Promise(r => setTimeout(r, 40));
    const messageContents = wRaw.sent.filter((m: any) => m.type === 'message').map((m: any) => m.content);
    expect(wRaw.sent.filter((m: any) => m.type === 'raw_input')).toEqual([]);
    expect(messageContents).toEqual(['EARLIER_FOLLOWUP_MSG', 'LATER_TAIL_MSG']);

    // 3. Real turn_input_rejected(reason='execution_reconciliation_required') clears pendingOrdinaryImDeliveries with ZERO retry!
    const sRej = makeSession({ backendType: 'tmux' });
    const dsRej = makeDaemonSession(sRej);
    const wRej = makeFakeWorker();
    workerPool.__testOnly_setWorkerSpawner(() => wRej);
    workerPool.forkWorker(dsRej, { content: 'ordinary prompt' }, { resume: false, turnId: 'om_ordinary_rej' });
    wRej.emit('message', { type: 'worker_ipc_ready' });
    const initSentBefore = wRej.sent.filter((m: any) => m.type === 'init').length;
    expect(initSentBefore).toBe(1);
    const ctrlRej = controllerForSession(dsRej, false)!;
    const wRefRej = ctrlRej.store.read(ctrlRej.ref)!.worker!;
    const scopeRej = new WorkerSessionEventScope(ctrlRej.ref, wRefRej);
    const execRej = ctrlRej.store.executions(ctrlRej.ref, 'om_ordinary_rej')[0]!.ref;
    scopeRej.rememberExecution(execRej);
    const metaRej = loadWorkerFunction<(msg: any) => any>('sessionEventMetadata', {
      workerSessionEventScope: scopeRej,
    });
    // Also verify cross-runtime turn_input_rejected (Gen-2 runtime + Gen-1 execution)
    // omits runtime/bindingId so SessionEventGateway admits it without execution_scope_unproven.
    const bindRej = scopeRej.beginRuntime();
    bindRej.runtime = { runtimeId: 'rt-gen-2-rej', epoch: 2 };
    const framedRej = scopeRej.run(bindRej, () => metaRej({
      type: 'turn_input_rejected',
      turnId: 'om_ordinary_rej',
      reason: 'execution_reconciliation_required',
    }), execRej);
    expect(framedRej.sessionContract.scope.runtime).toBeUndefined();
    expect(framedRej.sessionContract.bindingId).toBeUndefined();
    expect(framedRej.sessionContract.scope.execution?.executionId).toBe(execRej.executionId);
    wRej.emit('message', framedRej);
    await new Promise(r => setTimeout(r, 40));
    expect(wRej.sent.filter((m: any) => m.type === 'init')).toHaveLength(1);
  });

  it('P1-5 + P1-8 + P2-2 + P2-4 + W2: covers bindCliPidMarker->writeCliPidMarker, primarySnapshot readPersistedExecutionContract, spawnCli fallback reconciliation, mid-close offline guard, resolveQuarantinedForkPlan catch, and restoreActiveSessions offline cold-restore', async () => {
    const dataDir = createIsolatedDataDir();

    // 1. P1-5: Real bindCliPidMarker -> writeCliPidMarker on Case B (isExecutionSettled) does NOT resurrect dead Turn 1
    const markerDir = mkdtempSync(join(tmpdir(), 'botmux-bind-marker-'));
    tempDirs.push(markerDir);
    const markerPath = join(markerDir, '9999.json');
    writeFileSync(markerPath, JSON.stringify({ turnId: 'om_settled_turn_1', callerOpenId: 'ou_user_a' }));
    const retiredTurnIds = new Set<string>();
    const adoptInitial = vi.fn();
    const bindScope: Record<string, any> = {
      existsSync: (p: string) => p === markerPath,
      withPidMarkerLock: (_p: string, fn: () => void) => fn(),
      readFileSync: () => JSON.stringify({ turnId: 'om_settled_turn_1', callerOpenId: 'ou_user_a' }),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      dirname: () => markerDir,
      cliPidMarker: markerPath,
      rpcEnginePidMarker: null,
      currentBotmuxTurnId: undefined,
      currentBotmuxDispatchAttempt: undefined,
      currentBotmuxCallerOpenId: undefined,
      currentBotmuxLinkRefMode: undefined,
      currentVcMeetingImTurnOrigin: undefined,
      currentTurnSteerPromoted: false,
      initialInputOwnershipPending: false,
      pendingMessages: [],
      backend: { isReattach: true },
      activeTurnAuthority: new ActiveTurnAuthority(),
      activeAuthorityMatchesMarker: () => false,
      retiredTurnIds,
      markTurnRetired: (id?: string) => { if (id) retiredTurnIds.add(id); },
      retireTerminatedMarkerTurn: () => false,
      workerSessionEventScope: { isExecutionSettled: (id: string) => id === 'om_settled_turn_1' },
      shouldAdoptPidMarkerWithoutRetiringCurrent,
      adoptInitialActiveTurn: adoptInitial,
      adoptDisplacedActiveTurn: vi.fn(),
      queuedTypeAheadTurns: [],
      markerQueuedTurnStillLive: () => true,
      markerIdentityTurnId: (id?: string) => id,
      publishActiveTurn: vi.fn(),
      publishSandboxRelayCapability: () => false,
      rememberQueuedTurnAdvanceForPendingReady: vi.fn(),
      sessionId: 'sess-pid-case-b',
      lastInitConfig: { cliId: 'claude-code' },
      send: vi.fn(),
      log: vi.fn(),
    };
    const restoreFn = loadWorkerFunction<(p: string) => void>('restoreQueuedTurnsFromMarkerDisk', bindScope);
    const writeFn = loadWorkerFunction<() => void>('writeCliPidMarker', bindScope);
    restoreFn(markerPath);
    writeFn();
    expect(adoptInitial).not.toHaveBeenCalled();
    expect(retiredTurnIds.has('om_settled_turn_1')).toBe(true);

    // 2. P1-8: readPersistedExecutionContract honors authoritative primarySnapshot (no stale local SQLite fallthrough)
    // AND reads existing sessions.db when sessionContractRevision is undefined!
    const sDbNoRev = makeSession({
      queuedActivationPending: true,
      queuedActivationToken: 'tok-no-rev',
      queuedActivationTurnId: 'om_no_rev',
    });
    const dsDbNoRev = makeDaemonSession(sDbNoRev);
    persistExecutionPhase(dataDir, dsDbNoRev, 'om_no_rev', 'reconciling');
    dsDbNoRev.session.sessionContractRevision = undefined;
    expect(readPersistedExecutionContract(dsDbNoRev, 'om_no_rev').phase).toBe('reconciling');

    const PRIMARY_APP = 'cli_test_reattach_primary';
    registerSessionContractPrimary(PRIMARY_APP, {} as any, () => {});
    const sPrimary = makeSession({
      larkAppId: PRIMARY_APP,
      queuedActivationTurnId: 'om_primary_empty',
      sessionRuntimeContract: {
        version: 2,
        session: {
          ref: { appId: PRIMARY_APP, sessionId: 'placeholder' },
          revision: 5,
          lifecycle: 'active',
          workerOnline: false,
          runtimeEpoch: 1,
          readinessSequence: 0,
        },
        tables: { entities: [] },
      },
    });
    sPrimary.sessionRuntimeContract!.session.ref.sessionId = sPrimary.sessionId;
    const dsPrimary = makeDaemonSession(sPrimary, { larkAppId: PRIMARY_APP });
    // Seed a stale reconciling row in local SQLite under PRIMARY_APP
    const pStore = sessionContractStore(dataDir, PRIMARY_APP);
    const pRef = { appId: PRIMARY_APP, sessionId: sPrimary.sessionId };
    pStore.ensure(pRef, { closed: false });
    const pw = { workerId: 'worker-gen-1', generation: 1 };
    pStore.apply(pRef, { type: 'worker_bound', worker: pw }, 'ev-pw1');
    const pExec = pStore.admitExecution(pRef, 'om_primary_empty');
    const pRt = pStore.reserveRuntime(pRef, pw, 'bind-pw1');
    pStore.bindRuntime(pRef, pRt, pw, { backend: 'tmux', physicalId: 'pid:999:boot:1', nativeSessionId: sPrimary.sessionId, proof: 'process_start' });
    pStore.bindQueuedExecution(pRef, pExec.ref, pRt);
    pStore.apply(pRef, { type: 'execution_phase', runtime: pRt, execution: pExec.ref, phase: 'submitting' }, 'ev-p-sub');
    pStore.apply(pRef, { type: 'runtime_lost', runtime: pRt, confirmed: false, reason: 'worker_disconnected' }, 'ev-p-lost');
    pStore.markUnresolvedExecutions(pRef, pRt);
    // primarySnapshot has 0 executions -> MUST NOT fall through to local SQLite!
    expect(readPersistedExecutionContract(dsPrimary, 'om_primary_empty')).toEqual({ hasContract: true });

    // 3. P1-8: spawnCli stashes spawnCliReconciledActivationToken on persisted_non_queued
    const spawnScopeObj = new WorkerSessionEventScope(
      { appId: APP, sessionId: 'sess-spawn-reconcile' },
      { workerId: 'worker-gen-2', generation: 2 },
    );
    spawnScopeObj.noteAdmission({
      ref: { executionId: 'exec-spawn-1', turnId: 'om_spawn_1' },
      phase: 'reconciling',
    });
    const spawnEnv: Record<string, any> = {
      closeRequested: false,
      workerSessionEventScope: spawnScopeObj,
      decideFlushSubmissionRejectionSettlement,
      isCodexAppCliId: (id?: string) => id === 'codex-app',
      spawnCliReconciledActivationToken: undefined,
      initialInputOwnershipPending: true,
      send: vi.fn(),
      pendingMessages: [],
      traexAutoModelController: null,
      activeRestartAttemptId: undefined,
      pendingRuntimeReservations: new Map(),
      awaitRuntimeReservation: async () => 'granted',
      RUNTIME_RESERVATION_SLOW_LOG_MS: 5000,
      RUNTIME_RESERVATION_DEADLINE_MS: 10000,
      log: vi.fn(),
      setCaptureIdentity: vi.fn(),
      currentBotmuxTurnId: undefined,
      currentBotmuxDispatchAttempt: undefined,
      currentBotmuxCallerOpenId: undefined,
      spawnCliBody: vi.fn(async () => {}),
      publishRuntimeContract: vi.fn(async () => {}),
    };
    const spawnCliFn = loadWorkerFunction<(cfg: any) => Promise<void>>('spawnCli', spawnEnv);
    const cfgSpawn: any = {
      type: 'init',
      sessionId: 'sess-spawn-reconcile',
      cliId: 'claude-code',
      prompt: 'already submitted',
      turnId: 'om_spawn_1',
      queuedActivationToken: 'tok-spawn-reconcile',
    };
    await spawnCliFn(cfgSpawn);
    expect(cfgSpawn.prompt).toBe('');
    expect(spawnEnv.spawnCliReconciledActivationToken).toBe('tok-spawn-reconcile');

    // 4. P2-2: mid-close guard in settleOfflineReconciledQueuedActivation & resolveQuarantinedForkPlan catch
    const sClosing = makeSession({
      backendType: 'pty',
      queuedActivationPending: true,
      queuedActivationToken: 'tok-closing',
      queuedActivationTurnId: 'om_closing_1',
    });
    const dsClosing = makeDaemonSession(sClosing);
    persistExecutionPhase(dataDir, dsClosing, 'om_closing_1', 'reconciling');
    const ctrlClosing = controllerForSession(dsClosing, true)!;
    const closeOp = ctrlClosing.beginControl('close');
    ctrlClosing.controlStarted(closeOp.operation.operationId);
    expect(dsClosing.session.sessionLifecycle).toBe('closing');
    expect(workerPool.settleOfflineReconciledQueuedActivation(dsClosing, {
      isCodexApp: false,
      isRemoteBackend: false,
      backingMode: 'cold_restore',
    })).toBe('not_applicable');
    expect(dsClosing.session.queuedActivationPending).toBe(true);

    const sQuar = makeSession({
      queuedActivationPending: undefined,
      queuedActivationTailNextOrder: 2,
      queuedActivationTail: [
        { id: 'q-1', order: 1, userPrompt: 'q1', cliInput: { content: 'q1' }, turnId: 'om_q1' },
      ],
    });
    const dsQuar = makeDaemonSession(sQuar, { quarantinedActivationTailPromotion: true });
    vi.spyOn(bots, 'getBot').mockImplementationOnce(() => { throw new Error('transient_registry_reload'); });
    const qPlan = workerPool.resolveQuarantinedForkPlan(dsQuar, '', true);
    expect(qPlan.fork).toBe(false);

    // 5. W2: real restoreActiveSessions settles reconciled local PTY row offline with ZERO forkWorker calls
    const restoreDir = createIsolatedDataDir('botmux-restore-w2-');
    const sRestore = makeSession({
      backendType: 'pty',
      queuedActivationPending: true,
      queuedActivationToken: 'tok-restore-w2',
      queuedActivationInput: { content: 'already submitted pty' },
      queuedActivationTurnId: 'om_restore_w2',
    });
    const dsSeed = makeDaemonSession(sRestore);
    persistExecutionPhase(restoreDir, dsSeed, 'om_restore_w2', 'reconciling');
    const spawnCalls = vi.fn(() => makeFakeWorker());
    workerPool.__testOnly_setWorkerSpawner(spawnCalls);
    await restoreActiveSessions(new Map());
    expect(spawnCalls).not.toHaveBeenCalled();
    expect(sessionStore.getSession(sRestore.sessionId)?.queuedActivationPending).toBeUndefined();
  });
});
