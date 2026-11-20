/**
 * The session contract must keep a turn tied to the CLI process it runs in
 * when the runtime that CLI is reported under changes beneath it — and must
 * still refuse when the process, or its conversation, is not the same.
 *
 * Both incidents (2026-11-19/20, v3.59.22) ended the same way: the turn's final
 * reply was refused as `execution_scope_unproven` and the group only got the
 * "reply could not be posted" notice.
 *
 * 1. A daemon restart re-attached an Antigravity CLI mid-turn. The new worker
 *    first bound the live process bare (pid + start time, no conversation id),
 *    so the contract opened a new runtime; the conversation id arrived a moment
 *    later and enriched that runtime in place. The running turn stayed on the
 *    old worker's runtime — the very same process and conversation — and every
 *    report of it was refused, eight hours later its final reply too. The event
 *    sequence below is the one recorded in that session's contract database.
 *
 * 2. Pi (and Grok) bake the opening prompt into the spawn argv, before any
 *    runtime exists, so nothing binds that turn to a runtime. Its observer may
 *    capture the launcher's binding; the relay then resolves the real CLI and
 *    the worker continues that launcher in process into the active runtime.
 *    The final, reported under the launcher's binding, was refused.
 *
 * Real SQLite contract store and controller; the worker side is its messages.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import type { ExecutionRef, RuntimeIdentity, RuntimeRef, WorkerRef } from '../src/services/session-contract.js';
import type { DaemonSession } from '../src/core/types.js';

const directories: string[] = [];
const stores: SessionContractStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) try { store.close(); } catch { /* closed */ }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TURN = 'om_turn_across_restart';
const NATIVE = 'eeb1eff1-8614-46c5-83a0-512806c17aba';
const launcher: RuntimeIdentity = { backend: 'tmux', physicalId: '1519638:461270582', proof: 'process_start' };
const cliBare: RuntimeIdentity = { backend: 'tmux', physicalId: '1520027:461270632', proof: 'process_start' };
const cliNative: RuntimeIdentity = { ...cliBare, nativeSessionId: NATIVE };

function fixture() {
  const data = mkdtempSync(join(tmpdir(), 'contract-reattach-live-')); directories.push(data);
  const appId = 'cli_reattach_live_test'; const ref = { appId, sessionId: 'session-reattach-live' };
  const store = new SessionContractStore(data, appId); stores.push(store);
  const ds = { larkAppId: appId, chatId: 'oc_test', session: { sessionId: ref.sessionId, larkAppId: appId, status: 'active' }, cliReadyGeneration: 0 } as DaemonSession;
  const controller = new SessionController(ds, store);
  const sequences = new Map<string, number>();
  const send = (worker: WorkerRef, message: Record<string, unknown>, scope: { runtime?: RuntimeRef; execution?: ExecutionRef }) => {
    const sequence = (sequences.get(worker.workerId) ?? 0) + 1; sequences.set(worker.workerId, sequence);
    const admission = controller.ingest({ ...message, sessionContract: { version: 2, session: ref, producer: worker,
      eventId: `${worker.workerId}:${sequence}`, sequence, scope } } as any, worker);
    // The host re-checks the admitted context after its primary flush.
    if (admission.kind === 'reject' || admission.kind === 'defer') return admission;
    return controller.gateway.admit(String(message.type), admission.context, worker);
  };
  /** One worker generation's binding: reserve, then report its identity. */
  const bind = (worker: WorkerRef, bindingId: string, identity: RuntimeIdentity, continues?: string) => {
    controller.reserveBinding(bindingId, worker);
    return controller.bindRuntime(bindingId, worker, identity, undefined, continues).ref;
  };
  const execution = (turnId = TURN) => store.executions(ref, turnId)[0]!;
  const final = (worker: WorkerRef, scope: { runtime?: RuntimeRef; execution?: ExecutionRef }, turnId = TURN) =>
    send(worker, { type: 'final_output', sessionId: ref.sessionId, turnId, content: 'the long-awaited answer', lastUuid: 'uuid-1' }, scope);
  return { store, ref, controller, send, bind, execution, final };
}

/** Worker 1 runs the turn in the real CLI behind its launcher, then the
 *  daemon restarts: worker 1 is gone, the CLI keeps running. */
function turnRunningAcrossRestart(opts: { workerLost?: boolean; startedUnderLauncher?: boolean } = {}) {
  const s = fixture();
  const w1 = s.controller.bindWorker(1).worker;
  const r1 = s.bind(w1, 'b1', launcher);
  s.send(w1, { type: 'ready' }, {});
  const execution = s.controller.admitInput(TURN);
  // A turn written before the relay resolved the real CLI stays on the
  // launcher's runtime; its process is the one that runtime continued into.
  if (opts.startedUnderLauncher) {
    expect(s.send(w1, { type: 'turn_execution_started', turnId: TURN }, { runtime: r1, execution })).toMatchObject({ kind: 'current' });
  }
  // The relay resolved the real CLI behind its launcher, then its conversation id.
  const r2 = s.bind(w1, 'b2', cliBare, 'b1');
  s.controller.bindRuntime('b2', w1, cliNative);
  s.send(w1, { type: 'prompt_ready' }, { runtime: r2 });
  if (!opts.startedUnderLauncher) {
    expect(s.send(w1, { type: 'turn_execution_started', turnId: TURN }, { runtime: r2, execution })).toMatchObject({ kind: 'current' });
    expect(s.send(w1, { type: 'native_input_consumed', turnId: TURN }, { runtime: r2, execution })).toMatchObject({ kind: 'current' });
  }
  if (opts.workerLost !== false) s.controller.workerLost(w1);
  const w2 = s.controller.bindWorker(2).worker;
  return { ...s, w1, w2, r1, r2, turn: execution };
}

describe('a turn left running in a CLI the next worker re-attaches', () => {
  it('reports under the live runtime once the re-attached CLI proves the same process and conversation', () => {
    const s = turnRunningAcrossRestart();
    // First binding: the live process, conversation id not read yet.
    const r3 = s.bind(s.w2, 'b3', cliBare);
    expect(r3.runtimeId).not.toBe(s.r2.runtimeId);
    s.send(s.w2, { type: 'ready' }, {});
    // Not proven yet: same process, but which conversation it runs is unknown.
    expect(s.send(s.w2, { type: 'managed_turn_origin', turnId: TURN }, { runtime: r3, execution: s.turn }))
      .toEqual({ kind: 'reject', reason: 'execution_scope_unproven' });

    // The conversation id arrives and enriches that runtime in place.
    s.controller.bindRuntime('b3', s.w2, cliNative);
    expect(s.execution().runtime).toEqual(r3);
    expect(s.execution().phase).toBe('reconciling');
    expect(s.send(s.w2, { type: 'managed_turn_origin', turnId: TURN }, { runtime: r3, execution: s.turn })).toMatchObject({ kind: 'current' });
    // Eight hours later the turn ends: its reply is the current runtime's.
    expect(s.final(s.w2, { runtime: r3, execution: s.turn })).toMatchObject({ kind: 'current' });
    expect(s.send(s.w2, { type: 'turn_terminal', turnId: TURN, status: 'completed' }, { runtime: r3, execution: s.turn }))
      .toMatchObject({ kind: 'current' });
    expect(s.execution()).toMatchObject({ phase: 'succeeded', runtime: r3 });
  });

  it('leaves the turn alone once the live CLI already runs a newer turn', () => {
    const s = turnRunningAcrossRestart();
    const r3 = s.bind(s.w2, 'b3', cliBare);
    s.send(s.w2, { type: 'ready' }, {});
    const newer = s.controller.admitInput('om_newer_turn');
    s.send(s.w2, { type: 'turn_execution_started', turnId: 'om_newer_turn' }, { runtime: r3, execution: newer });
    s.controller.bindRuntime('b3', s.w2, cliNative);
    expect(s.execution().runtime).toEqual(s.r2);
  });

  it('leaves the turn alone when the old worker\'s loss was never recorded', () => {
    // The old runtime was retired by the new binding rather than marked lost:
    // nothing shows its worker is gone.
    const s = turnRunningAcrossRestart({ workerLost: false });
    s.bind(s.w2, 'b3', cliBare);
    expect(s.store.runtime(s.ref, s.r2.runtimeId)?.phase).toBe('retiring');
    s.controller.bindRuntime('b3', s.w2, cliNative);
    expect(s.execution().runtime).toEqual(s.r2);
  });

  it('follows the turn through a second restart', () => {
    const s = turnRunningAcrossRestart();
    const r3 = s.bind(s.w2, 'b3', cliBare);
    s.controller.bindRuntime('b3', s.w2, cliNative);
    expect(s.execution().runtime).toEqual(r3);
    s.controller.workerLost(s.w2);
    const w3 = s.controller.bindWorker(3).worker;
    const r4 = s.bind(w3, 'b4', cliBare);
    s.controller.bindRuntime('b4', w3, cliNative);
    expect(s.execution().runtime).toEqual(r4);
    expect(s.final(w3, { runtime: r4, execution: s.turn })).toMatchObject({ kind: 'current' });
  });

  it('follows a turn written under the old worker\'s launcher binding to the process it continued into', () => {
    const s = turnRunningAcrossRestart({ startedUnderLauncher: true });
    expect(s.execution().runtime).toEqual(s.r1);
    const r3 = s.bind(s.w2, 'b3', cliBare);
    s.controller.bindRuntime('b3', s.w2, cliNative);
    expect(s.execution().runtime).toEqual(r3);
    expect(s.final(s.w2, { runtime: r3, execution: s.turn })).toMatchObject({ kind: 'current' });
  });

  it('moves the turn once a /stop sent before the conversation id arrived has settled', () => {
    const s = turnRunningAcrossRestart();
    const r3 = s.bind(s.w2, 'b3', cliBare);
    s.send(s.w2, { type: 'ready' }, {});
    const { operation } = s.controller.beginControl('cancel', undefined, s.turn);
    s.controller.controlStarted(operation.operationId);
    s.controller.bindRuntime('b3', s.w2, cliNative);
    expect(s.execution().runtime).toEqual(s.r2);
    s.controller.controlResult(operation.operationId, 'confirmed');
    expect(s.execution().runtime).toEqual(r3);
    expect(s.send(s.w2, { type: 'turn_terminal', turnId: TURN, status: 'cancelled' }, { runtime: r3, execution: s.turn }))
      .toMatchObject({ kind: 'current' });
    expect(s.execution().phase).toBe('cancelled');
  });

  it('keeps output frozen under the old runtime provable after the move', () => {
    const s = turnRunningAcrossRestart();
    const frozen = { version: 2 as const, session: s.ref, producer: s.w1, eventId: `${s.w1.workerId}:99`, sequence: 99,
      scope: { runtime: s.r2, execution: s.turn } };
    expect(s.controller.outputOrigin(frozen)?.scope.runtime).toEqual(s.r2);
    const r3 = s.bind(s.w2, 'b3', cliBare);
    s.controller.bindRuntime('b3', s.w2, cliNative);
    expect(s.execution().runtime).toEqual(r3);
    expect(s.controller.outputOrigin(frozen)?.scope).toMatchObject({ runtime: r3, execution: s.turn });
    // An attempt that runs on the live runtime but never moved from the old
    // one gets no such proof.
    const other = s.controller.admitInput('om_unrelated');
    s.send(s.w2, { type: 'turn_execution_started', turnId: 'om_unrelated' }, { runtime: r3, execution: other });
    expect(s.store.execution(s.ref, other.executionId)?.runtime).toEqual(r3);
    expect(s.controller.outputOrigin({ ...frozen, scope: { runtime: s.r2, execution: other } })).toBeUndefined();
  });

  it('leaves a turn this worker already observes under a host grant where the grant names it', () => {
    const s = turnRunningAcrossRestart();
    const r3 = s.bind(s.w2, 'b3', cliBare);
    s.send(s.w2, { type: 'ready' }, {});
    // A newer turn holds the live runtime when the conversation id arrives, so
    // the host grants observation of the old one instead (Codex).
    const newer = s.controller.admitInput('om_newer_turn');
    s.send(s.w2, { type: 'turn_execution_started', turnId: 'om_newer_turn' }, { runtime: r3, execution: newer });
    s.controller.bindRuntime('b3', s.w2, cliNative);
    expect(s.store.authorizeExecutionObserver(s.ref, s.w2, s.turn)).toBe(true);
    s.send(s.w2, { type: 'turn_terminal', turnId: 'om_newer_turn', status: 'completed' }, { runtime: r3, execution: newer });
    // The identity is published again once the newer turn is done.
    s.controller.bindRuntime('b3', s.w2, cliNative);
    expect(s.execution().runtime).toEqual(s.r2);
    expect(s.final(s.w2, { runtime: s.r2, execution: s.turn })).toMatchObject({ kind: 'historical' });
  });

  it('leaves the turn alone when this worker\'s own launcher already ran a newer turn', () => {
    const s = turnRunningAcrossRestart();
    // The new worker's first binding is the launcher; a newer turn ran there
    // before the relay continued it into the real CLI.
    const r3 = s.bind(s.w2, 'b3', launcher);
    s.send(s.w2, { type: 'ready' }, {});
    const newer = s.controller.admitInput('om_newer_turn');
    s.send(s.w2, { type: 'turn_execution_started', turnId: 'om_newer_turn' }, { runtime: r3, execution: newer });
    const r4 = s.bind(s.w2, 'b4', cliNative, 'b3');
    expect(s.controller.currentRuntime()).toEqual(r4);
    expect(s.execution().runtime).toEqual(s.r2);
  });

  it('refuses the reply when the re-attached pane runs a different CLI process', () => {
    const s = turnRunningAcrossRestart();
    // Same pid, different kernel start time: the process was replaced.
    const replaced: RuntimeIdentity = { backend: 'tmux', physicalId: '1520027:999999999', proof: 'process_start', nativeSessionId: NATIVE };
    const r3 = s.bind(s.w2, 'b3', { ...replaced, nativeSessionId: undefined } as RuntimeIdentity);
    s.controller.bindRuntime('b3', s.w2, replaced);
    expect(s.execution().runtime).toEqual(s.r2);
    expect(s.final(s.w2, { runtime: r3, execution: s.turn })).toEqual({ kind: 'reject', reason: 'execution_scope_unproven' });
  });

  it('refuses the reply when the live CLI runs another conversation', () => {
    const s = turnRunningAcrossRestart();
    const r3 = s.bind(s.w2, 'b3', cliBare);
    s.controller.bindRuntime('b3', s.w2, { ...cliBare, nativeSessionId: '0b0e2b4a-0000-4000-8000-000000000001' });
    expect(s.execution().runtime).toEqual(s.r2);
    expect(s.final(s.w2, { runtime: r3, execution: s.turn })).toEqual({ kind: 'reject', reason: 'execution_scope_unproven' });
  });

  it('refuses the reply when the live runtime was once seen in another conversation', () => {
    const s = turnRunningAcrossRestart();
    const r3 = s.bind(s.w2, 'b3', cliBare);
    // The process was observed in another conversation before it went bare again.
    const live = s.store.runtime(s.ref, r3.runtimeId)!;
    s.store.apply(s.ref, { type: 'runtime_bound', runtime: { ...live, identity: { ...cliBare, nativeSessionId: '0b0e2b4a-0000-4000-8000-000000000003' } } });
    s.store.apply(s.ref, { type: 'runtime_bound', runtime: live });
    s.controller.bindRuntime('b3', s.w2, cliNative);
    expect(s.execution().runtime).toEqual(s.r2);
    expect(s.final(s.w2, { runtime: r3, execution: s.turn })).toEqual({ kind: 'reject', reason: 'execution_scope_unproven' });
  });

  it('refuses the reply while the CLI has not shown which conversation it runs', () => {
    const s = turnRunningAcrossRestart();
    const r3 = s.bind(s.w2, 'b3', cliBare);
    expect(s.execution().runtime).toEqual(s.r2);
    expect(s.final(s.w2, { runtime: r3, execution: s.turn })).toEqual({ kind: 'reject', reason: 'execution_scope_unproven' });
  });

  it('leaves the turn alone while a lifecycle operation owns the session', () => {
    const s = turnRunningAcrossRestart();
    const r3 = s.bind(s.w2, 'b3', cliBare);
    const { operation } = s.controller.beginControl('cancel', undefined, s.turn);
    s.controller.controlStarted(operation.operationId);
    s.controller.bindRuntime('b3', s.w2, cliNative);
    expect(s.execution().runtime).toEqual(s.r2);
    expect(r3).toBeDefined();
  });

  it('leaves the turn alone when another process ran work between the two runtimes', () => {
    const s = turnRunningAcrossRestart();
    // A worker generation in between ran a different CLI with a turn of its own.
    const other: RuntimeIdentity = { backend: 'tmux', physicalId: '2000000:111', proof: 'process_start', nativeSessionId: '0b0e2b4a-0000-4000-8000-000000000002' };
    const rOther = s.bind(s.w2, 'b-other', other);
    s.send(s.w2, { type: 'ready' }, {});
    const otherTurn = s.controller.admitInput('om_other_turn');
    s.send(s.w2, { type: 'turn_execution_started', turnId: 'om_other_turn' }, { runtime: rOther, execution: otherTurn });
    s.controller.workerLost(s.w2);
    const w3 = s.controller.bindWorker(3).worker;
    const r4 = s.bind(w3, 'b4', cliBare);
    s.controller.bindRuntime('b4', w3, cliNative);
    expect(s.execution().runtime).toEqual(s.r2);
    expect(s.final(w3, { runtime: r4, execution: s.turn })).toEqual({ kind: 'reject', reason: 'execution_scope_unproven' });
  });
});

describe('an opening turn whose input rode the spawn argv', () => {
  /** The turn is admitted before any runtime exists; the worker then binds
   *  the launcher, and the relay resolves the real CLI behind it. */
  function argvBakedOpening() {
    const s = fixture();
    const w1 = s.controller.bindWorker(1).worker;
    const turn = s.controller.admitInput(TURN);
    const r1 = s.bind(w1, 'b1', launcher);
    s.send(w1, { type: 'ready' }, {});
    return { ...s, w1, r1, turn };
  }

  it('takes its final from the launcher\'s binding once that CLI continued into the active runtime', () => {
    const s = argvBakedOpening();
    const r2 = s.bind(s.w1, 'b2', cliBare, 'b1');
    expect(s.controller.currentRuntime()).toEqual(r2);
    expect(s.execution().runtime).toBeUndefined();
    // The transcript observer was armed under the launcher's binding.
    expect(s.final(s.w1, { runtime: s.r1, execution: s.turn })).toMatchObject({ kind: 'current' });
    expect(s.send(s.w1, { type: 'turn_terminal', turnId: TURN, status: 'completed' }, { runtime: s.r1, execution: s.turn }))
      .toMatchObject({ kind: 'current' });
    expect(s.execution()).toMatchObject({ phase: 'succeeded', runtime: r2 });
  });

  it('still refuses it from a runtime that was replaced rather than continued', () => {
    const s = argvBakedOpening();
    // A new CLI process bound on its own: no in-process continuation.
    s.bind(s.w1, 'b2', { backend: 'tmux', physicalId: '3000000:222', proof: 'process_start' });
    expect(s.final(s.w1, { runtime: s.r1, execution: s.turn })).toEqual({ kind: 'reject', reason: 'execution_scope_unproven' });
    expect(s.execution().runtime).toBeUndefined();
  });
});
