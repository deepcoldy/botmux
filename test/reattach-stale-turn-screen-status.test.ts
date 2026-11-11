import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as bots from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import { SessionController, controllerForSession } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { composeRowFromActive } from '../src/core/dashboard-rows.js';
import { normalizeSessionRow } from '../src/services/session-observe.js';
import { collectRelayPickerEntries } from '../src/services/relay-picker.js';
import { recordScheduledSessionRun } from '../src/core/scheduled-send.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const APP = 'cli_reattach_stale_turn';
const SESSION = 'reattach-stale-turn-session';
const STALE_TURN = 'om_old_turn_from_pid_marker';

let dir: string;
let previousDataDir: string;
const openHandles: Array<{ close(): void }> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reattach-stale-turn-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dir;
  workerPool.__testOnly_resetOrdinaryImDeliveries();
  workerPool.__testOnly_setSuspendBackingVerifier(() => true);
  vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);
  vi.spyOn(sessionStore, 'updateSessionPid').mockImplementation(() => undefined);
  vi.spyOn(sessionStore, 'closeSession').mockImplementation(() => undefined);
  vi.spyOn(bots, 'getBot').mockReturnValue({
    config: { larkAppId: APP, larkAppSecret: '', apiOnly: true, cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'ReattachBot',
  } as any);
  vi.spyOn(bots, 'getBotBrand').mockReturnValue('feishu');
});

afterEach(() => {
  for (const handle of openHandles.splice(0)) {
    try { handle.close(); } catch { /* already closed */ }
  }
  workerPool.setActiveSessionsRegistry(new Map());
  workerPool.__testOnly_setSuspendBackingVerifier();
  workerPool.__testOnly_resetOrdinaryImDeliveries();
  config.session.dataDir = previousDataDir;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function createContractSession(sessionId = SESSION) {
  const ref = { appId: APP, sessionId };
  const store = new SessionContractStore(dir, APP);
  openHandles.push(store);
  const ds = {
    larkAppId: APP,
    chatId: 'oc_p2p_source',
    chatType: 'p2p',
    scope: 'chat',
    cliReadyGeneration: 0,
    session: {
      sessionId,
      larkAppId: APP,
      chatId: 'oc_p2p_source',
      chatType: 'p2p',
      status: 'active',
      cliId: 'claude-code',
      createdAt: new Date(1_000).toISOString(),
    },
  } as unknown as DaemonSession;
  const controller = new SessionController(ds, store);
  const worker = controller.bindWorker(1).worker;
  controller.reserveBinding('binding-reattach', worker);
  const runtime = controller.bindRuntime('binding-reattach', worker, {
    backend: 'tmux',
    physicalId: '4242:procstart1',
    proof: 'process_start',
  }).ref;
  let seq = 0;
  const context = (scope: Record<string, unknown> = { runtime }, producer = worker, sequence = ++seq) => ({
    version: 2 as const,
    session: ref,
    producer,
    eventId: `${producer.workerId}:${sequence}`,
    sequence,
    scope,
  });
  return { ref, store, ds, controller, worker, runtime, context };
}

describe('SessionController: reattached runtime screen_update with stale or unbound turnId', () => {
  it('admits idle screen_update when turnId is unadmitted without minting a phantom queued execution', () => {
    const s = createContractSession();
    expect(s.controller.ingest({ type: 'ready', port: 0, token: 't', sessionContract: s.context() }, s.worker))
      .toMatchObject({ kind: 'current' });
    expect(s.controller.ingest({ type: 'prompt_ready', sessionContract: s.context() }, s.worker))
      .toMatchObject({ kind: 'current' });

    const admission = s.controller.ingest({
      type: 'screen_update',
      status: 'idle',
      content: '',
      turnId: STALE_TURN,
      sessionContract: s.context(),
    }, s.worker);

    expect(admission).toMatchObject({ kind: 'current' });
    if (admission.kind !== 'current') throw new Error('expected current admission');
    expect(admission.context.scope.execution).toBeUndefined();
    expect(s.store.executions(s.ref)).toEqual([]);
  });

  it('admits idle screen_update when a same-named unbound queued execution exists, without binding it', () => {
    const s = createContractSession();
    expect(s.controller.ingest({ type: 'ready', port: 0, token: 't', sessionContract: s.context() }, s.worker))
      .toMatchObject({ kind: 'current' });
    expect(s.controller.ingest({ type: 'prompt_ready', sessionContract: s.context() }, s.worker))
      .toMatchObject({ kind: 'current' });

    // Reproduces capture_identity / legacy queued entry leaving phase='queued', runtime=undefined.
    expect(s.controller.ingest({
      type: 'capture_identity',
      revision: 1,
      turnId: STALE_TURN,
      sessionContract: s.context(),
    }, s.worker)).toMatchObject({ kind: 'current' });
    const queued = s.store.executions(s.ref, STALE_TURN)[0];
    expect(queued).toMatchObject({ phase: 'queued' });
    expect(queued.runtime).toBeUndefined();

    const admission = s.controller.ingest({
      type: 'screen_update',
      status: 'idle',
      content: '',
      turnId: STALE_TURN,
      sessionContract: s.context(),
    }, s.worker);

    expect(admission).toMatchObject({ kind: 'current' });
    if (admission.kind !== 'current') throw new Error('expected current admission');
    expect(admission.context.scope.execution).toBeUndefined();
    expect(s.store.execution(s.ref, queued.ref.executionId)).toMatchObject({ phase: 'queued' });
    expect(s.store.execution(s.ref, queued.ref.executionId)?.runtime).toBeUndefined();

    // Execution-scoped messages carrying an unproven execution ref stay fail-closed,
    // while screen_update drops the unproven execution scope and admits the runtime frame.
    const unprovenExec = { executionId: 'unproven-exec', turnId: STALE_TURN };
    expect(s.controller.ingest({
      type: 'screen_update',
      status: 'idle',
      content: '',
      turnId: STALE_TURN,
      sessionContract: s.context({ runtime: s.runtime, execution: unprovenExec }),
    }, s.worker)).toMatchObject({ kind: 'current' });
    for (const type of ['final_output', 'turn_terminal', 'managed_turn_origin'] as const) {
      expect(s.controller.ingest({
        type,
        turnId: STALE_TURN,
        ...(type === 'turn_terminal' ? { status: 'completed' } : {}),
        sessionContract: s.context({ runtime: s.runtime, execution: unprovenExec }),
      }, s.worker)).toMatchObject({ kind: 'reject', reason: 'execution_scope_unproven' });
    }

    // A fresh user turn after convergence binds to the active runtime and keeps attribution.
    const fresh = s.controller.admitInput('om_fresh_turn');
    expect(s.controller.ingest({
      type: 'turn_execution_started',
      turnId: 'om_fresh_turn',
      startedAtMs: Date.now(),
      sessionContract: s.context({ runtime: s.runtime, execution: fresh }),
    }, s.worker)).toMatchObject({ kind: 'current' });
    expect(s.controller.ingest({
      type: 'native_input_consumed',
      turnId: 'om_fresh_turn',
      sessionContract: s.context({ runtime: s.runtime, execution: fresh }),
    }, s.worker)).toMatchObject({ kind: 'current' });
    const workingAdmission = s.controller.ingest({
      type: 'screen_update',
      status: 'working',
      content: 'running',
      turnId: 'om_fresh_turn',
      sessionContract: s.context({ runtime: s.runtime, execution: fresh }),
    }, s.worker);
    expect(workingAdmission).toMatchObject({ kind: 'current' });
    if (workingAdmission.kind !== 'current') throw new Error('expected current admission');
    expect(workingAdmission.context.scope.execution).toEqual(fresh);
    expect(s.controller.ingest({ type: 'prompt_ready', sessionContract: s.context() }, s.worker))
      .toMatchObject({ kind: 'current' });
    const idleAdmission = s.controller.ingest({
      type: 'screen_update',
      status: 'idle',
      content: '',
      turnId: 'om_fresh_turn',
      sessionContract: s.context({ runtime: s.runtime, execution: fresh }),
    }, s.worker);
    expect(idleAdmission).toMatchObject({ kind: 'current' });
    if (idleAdmission.kind !== 'current') throw new Error('expected current admission');
    expect(idleAdmission.context.scope.execution).toEqual(fresh);
  });

  it('admits idle screen_update on a reattached runtime when turnId settled on a prior runtime', () => {
    const s = createContractSession('session-prior-runtime');
    // Prior runtime enriched nativeSessionId during Turn 1 and settled it.
    s.controller.reserveBinding('binding-enriched', s.worker);
    const enrichedRuntime = s.controller.bindRuntime('binding-enriched', s.worker, {
      backend: 'tmux',
      physicalId: '4242:procstart1',
      nativeSessionId: 'claude-native-sid-1',
      proof: 'native_session',
    }).ref;
    const priorExec = s.controller.admitInput(STALE_TURN, 1);
    expect(s.controller.ingest({
      type: 'turn_execution_started',
      turnId: STALE_TURN,
      dispatchAttempt: 1,
      startedAtMs: Date.now(),
      sessionContract: s.context({ runtime: enrichedRuntime, execution: priorExec }),
    }, s.worker)).toMatchObject({ kind: 'current' });
    expect(s.controller.ingest({
      type: 'turn_terminal',
      turnId: STALE_TURN,
      dispatchAttempt: 1,
      status: 'completed',
      sessionContract: s.context({ runtime: enrichedRuntime, execution: priorExec }),
    }, s.worker)).toMatchObject({ kind: 'current' });

    // Daemon restarts and reattaches before nativeSessionId is rediscovered -> new runtimeId.
    const nextWorker = s.controller.bindWorker(2).worker;
    s.controller.reserveBinding('binding-reattach-2', nextWorker);
    const reattachedRuntime = s.controller.bindRuntime('binding-reattach-2', nextWorker, {
      backend: 'tmux',
      physicalId: '4242:procstart1',
      proof: 'process_start',
    }).ref;
    expect(reattachedRuntime.runtimeId).not.toBe(enrichedRuntime.runtimeId);

    let seq2 = 0;
    const nextContext = (scope: Record<string, unknown> = { runtime: reattachedRuntime }) =>
      s.context(scope, nextWorker, ++seq2);
    expect(s.controller.ingest({ type: 'ready', port: 0, token: 't2', sessionContract: nextContext() }, nextWorker))
      .toMatchObject({ kind: 'current' });
    expect(s.controller.ingest({ type: 'prompt_ready', sessionContract: nextContext() }, nextWorker))
      .toMatchObject({ kind: 'current' });

    const admission = s.controller.ingest({
      type: 'screen_update',
      status: 'idle',
      content: '',
      turnId: STALE_TURN,
      dispatchAttempt: 1,
      sessionContract: nextContext(),
    }, nextWorker);
    expect(admission).toMatchObject({ kind: 'current' });
    if (admission.kind !== 'current') throw new Error('expected current admission');
    expect(admission.context.scope.execution).toBeUndefined();

    // Execution-scoped claims on the reattached runtime for a prior runtime's execution stay rejected.
    for (const type of ['final_output', 'turn_terminal'] as const) {
      expect(s.controller.ingest({
        type,
        turnId: STALE_TURN,
        dispatchAttempt: 1,
        ...(type === 'turn_terminal' ? { status: 'completed' } : {}),
        sessionContract: nextContext(),
      }, nextWorker)).toMatchObject({ kind: 'reject', reason: 'execution_scope_unproven' });
    }
    expect(s.controller.ingest({
      type: 'managed_turn_origin',
      turnId: STALE_TURN,
      dispatchAttempt: 1,
      sessionContract: nextContext(),
    }, nextWorker)).toMatchObject({ kind: 'reject', reason: 'execution_scope_missing' });

    // Stale worker / superseded runtime and out-of-order sequences remain rejected.
    expect(s.controller.ingest({
      type: 'screen_update',
      status: 'idle',
      content: '',
      sessionContract: s.context({ runtime: enrichedRuntime }, s.worker, 99),
    }, s.worker)).toMatchObject({ kind: 'reject', reason: 'stale_runtime_scope' });

    const beforePromptSeq = seq2 + 1;
    seq2 = beforePromptSeq + 1;
    expect(s.controller.ingest({
      type: 'prompt_ready',
      sessionContract: s.context({ runtime: reattachedRuntime }, nextWorker, seq2),
    }, nextWorker)).toMatchObject({ kind: 'current' });
    expect(s.controller.ingest({
      type: 'screen_update',
      status: 'working',
      content: 'late frame from before prompt_ready',
      sessionContract: s.context({ runtime: reattachedRuntime }, nextWorker, beforePromptSeq),
    }, nextWorker)).toMatchObject({ kind: 'reject', reason: 'stale_observation_sequence' });
  });
});

describe('Daemon IPC convergence: observe, relay, transferSession, and turn attribution', () => {
  async function bootFakeContractWorker(opts: {
    sessionId?: string;
    openingScheduledTurnId?: string;
    unownedScheduledTurnId?: string;
  } = {}) {
    const sessionId = opts.sessionId ?? SESSION;
    const onScreenStatus = vi.fn();
    const onDeferredScheduleTurnSettled = vi.fn();
    workerPool.initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => dir,
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onScreenStatus,
      onDeferredScheduleTurnSettled,
    } as any);

    const worker = new EventEmitter() as any;
    worker.killed = false;
    worker.connected = true;
    worker.pid = process.pid;
    worker.kill = vi.fn();
    worker.send = vi.fn(() => true);
    worker.stdout = new EventEmitter();
    worker.stderr = new EventEmitter();

    const ds = {
      session: {
        sessionId,
        larkAppId: APP,
        chatId: 'oc_p2p_source',
        chatType: 'p2p',
        ownerOpenId: 'ou_owner',
        title: 'Reattached Session',
        workingDir: dir,
        backendType: 'tmux',
        tmuxSessionName: 'bmx-reattach-test',
        status: 'active',
        cliId: 'claude-code',
        createdAt: new Date(1_000).toISOString(),
        workerGeneration: 1,
      },
      larkAppId: APP,
      chatId: 'oc_p2p_source',
      chatType: 'p2p',
      ownerOpenId: 'ou_owner',
      scope: 'chat',
      worker,
      workerGeneration: 1,
      workerPort: 0,
      workerToken: 'token',
      spawnedAt: 1_000,
      cliVersion: '1.0.0',
      lastMessageAt: 2_000,
      hasHistory: true,
    } as unknown as DaemonSession;

    if (opts.unownedScheduledTurnId) {
      recordScheduledSessionRun(ds.session, {
        taskId: 'task-unowned',
        runId: 'run-unowned',
        turnId: opts.unownedScheduledTurnId,
        startedAt: new Date(1_500).toISOString(),
      } as any);
    }

    const controller = controllerForSession(ds, true)!;
    openHandles.push(controller.store);
    const contract = controller.bindWorker(1);
    let openingExecution;
    if (opts.openingScheduledTurnId) {
      recordScheduledSessionRun(ds.session, {
        taskId: 'task-cold',
        runId: 'run-cold',
        turnId: opts.openingScheduledTurnId,
        startedAt: new Date(1_500).toISOString(),
      } as any);
      openingExecution = controller.admitInput(opts.openingScheduledTurnId);
    }
    ds.initConfig = {
      type: 'init',
      sessionId,
      cliId: 'claude-code',
      backendType: 'tmux',
      ...(opts.openingScheduledTurnId ? { turnId: opts.openingScheduledTurnId } : {}),
      ...(openingExecution ? { sessionCommand: { version: 2, execution: openingExecution } } : {}),
      sessionContract: contract,
    } as any;

    const activeSessions = new Map<string, DaemonSession>([
      [sessionKey('oc_p2p_source', APP), ds],
    ]);
    workerPool.setActiveSessionsRegistry(activeSessions);
    workerPool.__testOnly_setupWorkerHandlers(ds, worker, undefined, 1);

    const scope = new WorkerSessionEventScope(controller.ref, contract.worker);
    const binding = scope.beginRuntime();
    controller.reserveBinding(binding.bindingId, contract.worker);
    const runtime = controller.bindRuntime(binding.bindingId, contract.worker, {
      backend: 'tmux',
      physicalId: '4242:procstart1',
      proof: 'process_start',
    }).ref;
    scope.assign(binding.bindingId, runtime);

    const sendFromWorker = async (message: WorkerToDaemon) => {
      const payload = scope.run(binding, () => ({ ...message, sessionContract: scope.envelope() }));
      await Promise.all(worker.listeners('message').map((listener: (m: unknown) => unknown) => listener(payload)));
    };

    await sendFromWorker({ type: 'ready', port: 0, token: 'token' });
    await sendFromWorker({ type: 'prompt_ready' });

    return { ds, activeSessions, controller, sendFromWorker, onScreenStatus, onDeferredScheduleTurnSettled };
  }

  it('converges observe and relay to idle without attributing unproven PID-marker turnId', async () => {
    const {
      ds,
      activeSessions,
      sendFromWorker,
      onScreenStatus,
      onDeferredScheduleTurnSettled,
    } = await bootFakeContractWorker({ unownedScheduledTurnId: STALE_TURN });

    // Reproduces the unbound queued execution created on reattach capture_identity.
    await sendFromWorker({ type: 'capture_identity', revision: 1, turnId: STALE_TURN });

    // Before screen_update(idle): observe reports working and relay/transferSession refuse as busy.
    expect(ds.lastScreenStatus).toBeUndefined();
    expect(composeRowFromActive(ds).status).toBe('working');
    expect(normalizeSessionRow(composeRowFromActive(ds) as any, { observedAt: 3_000 }).turn).toBe('working');
    expect((await collectRelayPickerEntries(activeSessions, APP, 'oc_target', 'ou_owner'))[0]?.running).toBe(true);
    expect(await workerPool.transferSession(ds.session.sessionId, 'oc_target', undefined, 'group', 'chat', {
      forkWorkerImpl: vi.fn(),
      detachWorkerImpl: vi.fn(async () => undefined),
    })).toEqual({ ok: false, error: 'worker_busy' });

    // Reattached worker emits idle screen_update carrying the stale marker turnId.
    await sendFromWorker({
      type: 'screen_update',
      status: 'idle',
      content: '❯ ',
      turnId: STALE_TURN,
    });

    expect(ds.lastScreenStatus).toBe('idle');
    expect(composeRowFromActive(ds).status).toBe('idle');
    expect(normalizeSessionRow(composeRowFromActive(ds) as any, { observedAt: 3_100 }).turn).toBe('idle');
    expect((await collectRelayPickerEntries(activeSessions, APP, 'oc_target', 'ou_owner'))[0]?.running).toBe(false);
    expect(onScreenStatus).toHaveBeenCalledWith(ds, expect.objectContaining({
      status: 'idle',
      turnId: undefined,
    }));
    expect(onDeferredScheduleTurnSettled).not.toHaveBeenCalled();

    // Genuine background/busy screen after prompt_ready still reports working.
    await sendFromWorker({
      type: 'screen_update',
      status: 'working',
      content: 'Running background task…',
      turnId: STALE_TURN,
    });
    expect(ds.lastScreenStatus).toBe('working');
    expect(normalizeSessionRow(composeRowFromActive(ds) as any, { observedAt: 3_200 }).turn).toBe('working');

    // Once idle again, transferSession is unblocked.
    await sendFromWorker({
      type: 'screen_update',
      status: 'idle',
      content: '❯ ',
      turnId: STALE_TURN,
    });
    const transferResult = await workerPool.transferSession(ds.session.sessionId, 'oc_target', undefined, 'group', 'chat', {
      forkWorkerImpl: vi.fn(),
      detachWorkerImpl: vi.fn(async () => undefined),
    });
    expect(transferResult).toMatchObject({ ok: true });
  });

  it('preserves turn attribution on cold-start argv opening turns while execution is still queued', async () => {
    const coldTurn = 'schedule:task-cold:run';
    const {
      ds,
      sendFromWorker,
      onScreenStatus,
      onDeferredScheduleTurnSettled,
    } = await bootFakeContractWorker({
      sessionId: 'cold-start-argv-session',
      openingScheduledTurnId: coldTurn,
    });

    await sendFromWorker({
      type: 'screen_update',
      status: 'idle',
      content: '❯ ',
      turnId: coldTurn,
    });

    expect(ds.lastScreenStatus).toBe('idle');
    expect(onScreenStatus).toHaveBeenCalledWith(ds, expect.objectContaining({
      status: 'idle',
      turnId: coldTurn,
    }));
    expect(onDeferredScheduleTurnSettled).toHaveBeenCalledWith(ds, {
      turnId: coldTurn,
      source: 'idle',
    });
  });

  it('replaces inherited AsyncLocalStorage opening execution on later worker screen_update envelopes', () => {
    const s = createContractSession('session-metadata-scope');
    const opening = s.controller.admitInput('om_opening_turn');
    const second = s.controller.admitInput('om_second_turn');
    const workerScope = new WorkerSessionEventScope(s.ref, s.worker);
    const binding = workerScope.beginRuntime();
    workerScope.assign(binding.bindingId, s.runtime);
    workerScope.rememberExecution(opening, binding);
    workerScope.rememberExecution(second, binding);
    const sessionEventMetadata = loadWorkerFunction<(msg: WorkerToDaemon) => WorkerToDaemon>('sessionEventMetadata', {
      workerSessionEventScope: workerScope,
    });

    const unattributed = workerScope.run(binding, () => sessionEventMetadata({
      type: 'screen_update',
      status: 'idle',
      content: '❯ ',
      turnId: undefined,
    }), opening);
    expect(unattributed.sessionContract?.scope.execution).toBeUndefined();
    expect(s.controller.ingest(unattributed, s.worker)).toMatchObject({ kind: 'current' });

    const secondFrame = workerScope.run(binding, () => sessionEventMetadata({
      type: 'screen_update',
      status: 'working',
      content: 'running second turn',
      turnId: 'om_second_turn',
    }), opening);
    expect(secondFrame.sessionContract?.scope.execution).toEqual(second);
  });
});
