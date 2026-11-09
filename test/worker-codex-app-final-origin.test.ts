import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncResource } from 'node:async_hooks';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { TurnExecutionClock } from '../src/services/turn-execution-clock.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { CodexAppTurnDispatchQueue } from '../src/utils/codex-app-turn-dispatch.js';
import { CodexAppTurnLiveness, CodexAppReadyAuthority, applyTrustedCodexAppStateMarker } from '../src/utils/codex-app-turn-liveness.js';
import { runnerFinalOutcome } from '../src/services/runner-final-outcome.js';
import { normalizeFinalUsage } from '../src/services/codex-app-runner-protocol.js';
import { bridgePostText } from '../src/services/bridge-fallback-gate.js';
import { committedCodexAppSequence } from '../src/utils/codex-app-dispatch-ledger.js';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import { CodexAppControlSequenceFence, CodexAppControlFinalAssembler, CodexAppControlReplayWindow,
  CodexAppControlRecordApplicationGate, parseCodexAppControlWireRecord, verifyCodexAppSignedControlMarker,
  encodeCodexAppSignedControlMarker, encodeCodexAppControlAck, codexAppSignedStateReadiness } from '../src/utils/codex-app-control.js';
import { sameWorker } from '../src/services/session-contract.js';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
const config = vi.hoisted(() => ({ dir: '' }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return config.dir; } } } }));
const resources: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const f of resources.splice(0).reverse()) f(); });
function harness(reattached: boolean | 'native-recovery' = false, ordinary = false) {
  const executionAttempt = ordinary ? undefined : 1;
  const dir = mkdtempSync(join(tmpdir(), 'final-origin-probe-')); config.dir = dir;
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  const ref = { appId: 'cli_origin_probe', sessionId: 'session-origin-probe' };
  const store = new SessionContractStore(dir, ref.appId); resources.push(() => store.close());
  const ds: any = { larkAppId: ref.appId, chatId: 'oc_probe', session: { sessionId: ref.sessionId, status: 'active', cliId: 'codex-app' }, cliReadyGeneration: 0 };
  const controller = new SessionController(ds, store); let worker = controller.bindWorker(1).worker;
  let historicalExecution: any; let historicalRuntime: any;
  if (reattached === 'native-recovery') {
    historicalRuntime = controller.reserveBinding('previous-worker-proven', worker);
    controller.bindRuntime('previous-worker-proven', worker, { backend: 'tmux', physicalId: '111:start111', proof: 'process_start', nativeSessionId: 'native-conversation' });
    historicalExecution = controller.admitInput('turnA', executionAttempt); store.bindQueuedExecution(ref, historicalExecution, historicalRuntime);
    store.apply(ref, { type: 'execution_phase', runtime: historicalRuntime, execution: historicalExecution, phase: 'submitting' });
    controller.workerLost(worker); worker = controller.bindWorker(2).worker;
  }
  const scope = new WorkerSessionEventScope(ref, worker);
  const startup = scope.beginRuntime();
  const bind = (b: any, native: string | undefined, physical = '111:start111') => {
    controller.reserveBinding(b.bindingId, worker);
    b.identity = { backend: 'tmux', physicalId: physical, proof: 'process_start', ...(native ? { nativeSessionId: native } : {}) };
    scope.assign(b.bindingId, controller.bindRuntime(b.bindingId, worker, b.identity).ref);
  };
  bind(startup, reattached === 'native-recovery' ? undefined : 'startup-native');
  const socketResource = scope.run(startup, () => new AsyncResource('signed-control-socket'));
  resources.push(() => socketResource.emitDestroy());
  const active = reattached === 'native-recovery' ? startup : scope.beginRuntime(undefined, startup.physicalId);
  if (active !== startup) bind(active, 'native-conversation');
  const execution = historicalExecution ?? controller.admitInput('turnA', executionAttempt); scope.noteAdmission({ ref: execution, phase: 'queued' });
  const queue = new CodexAppTurnDispatchQueue(); queue.reserve('turnA', executionAttempt, 'dispatchA');
  const pair = generateKeyPairSync('ed25519'); const generation = 'g'.repeat(43), challenge = 'c'.repeat(43);
  const socket: any = { destroyed: false, write: vi.fn(), destroy: vi.fn(() => { socket.destroyed = true; }) };
  const env: any = { workerSessionEventScope: scope, sessionId: ref.sessionId, lastInitConfig: { cliId: 'codex-app', sessionId: ref.sessionId },
    codexAppTurnDispatchQueue: queue, codexAppCompletionAwaitingFinal: true, codexAppTurnLiveness: new CodexAppTurnLiveness(),
    isCodexAppCliId, runnerFinalOutcome, normalizeFinalUsage, bridgePostText, randomBytes,
    codexAppGenerationCommits: [], codexAppRecoveredDispatches: [], turnExecutionClock: new TurnExecutionClock(),
    codexAppPendingDaemonAcks: new Map(), CODEX_APP_DAEMON_PERSIST_TIMEOUT_MS: 30_000,
    closeRequested: false, frozenTurnLinkRefMode: () => undefined, isWorkflowWorker: () => false,
    log: vi.fn(), cliName: () => 'Codex App', rejectCodexAppControlMarker: vi.fn(),
    currentBotmuxTurnId: 'turn-next', currentBotmuxDispatchAttempt: 99,
    inputDeliveryEvidence: { start: vi.fn() }, cliSpawnGeneration: 1,
    emittedTurnTerminals: new TurnTerminalDeduper(), cancelSubmitFailureChainForTerminal: vi.fn(),
    submitFailureChains: new Map(), releaseActiveTurnAuthority: () => true, retireTerminatedQueuedTurn: vi.fn(),
    terminalReleasesDurableTurn: () => false,
    parseCodexAppControlWireRecord, verifyCodexAppSignedControlMarker, encodeCodexAppControlAck, committedCodexAppSequence,
    codexAppControlChannelId: 1, codexAppControlEndpointEpoch: 'epoch', codexAppControlActiveSocket: socket,
    codexAppControlReplayWindow: new CodexAppControlReplayWindow(), codexAppControlRecordApplicationGate: new CodexAppControlRecordApplicationGate(),
  };
  const wire: any[] = []; const admissions: any[] = []; const heldAcks: Array<() => void> = [];
  const ack = loadWorkerMessageHandler('codex_app_dispatch_persisted', env);
  const bindingTasks: Promise<void>[] = [];
  const assigned = loadWorkerMessageHandler('runtime_contract_assigned', env);
  const refused = loadWorkerMessageHandler('runtime_binding_refused', env);
  const hostWorker: any = { send: (message: any) => { if (message.type === 'runtime_contract_assigned') bindingTasks.push(assigned(message));
    if (message.type === 'runtime_binding_refused') bindingTasks.push(refused(message)); } }; ds.worker = hostWorker;
  const hostEnv: any = { sessionController: controller, contractWorker: worker, ds, worker: hostWorker, sameWorker, isCodexAppCliId,
    logger: { warn: vi.fn(), debug: vi.fn() }, t: 'native-recovery', handleLegacyWorkerMessage: vi.fn() };
  const host = loadWorkerPoolClosure<any>('handleWorkerMessage', hostEnv); hostEnv.handleWorkerMessage = host;
  env.process = { execPath: process.execPath, send: (message: any) => {
    wire.push(message);
    if (message.type === 'runtime_binding_started' || message.type === 'runtime_binding') { bindingTasks.push(host(message)); return; }
    const admission = controller.ingest(message, worker); admissions.push(admission);
    if (message.type === 'final_output' && admission.kind !== 'reject') {
      const deliver = () => void ack({ type: 'codex_app_dispatch_persisted', requestId: message.codexAppSettlement.requestId, ok: env.persistOutcome !== false });
      if (env.holdPersistence) heldAcks.push(deliver); else deliver();
    }
  } };
  for (const name of ['bindSessionExecutionEvent', 'workerIpcPayload', 'send', 'waitForCodexAppDaemonPersistence', 'emitTurnTerminal', 'handleTrustedCodexAppMarker']) env[name] = loadWorkerFunction(name, env);
  if (reattached === 'native-recovery') {
    scope.noteAdmission({ ref: execution, runtime: historicalRuntime, phase: 'reconciling' });
    env.codexAppRecoveredDispatches = [{ state: 'prepared', dispatchId: 'dispatchA', turnId: 'turnA', dispatchAttempt: executionAttempt }];
    queue.clear(); queue.restore(env.codexAppRecoveredDispatches);
    ds.session.codexAppDispatchLedger = env.codexAppRecoveredDispatches.map((entry: any) => ({ ...entry, content: 'prompt' }));
    env.codexAppControlProven = true; env.effectiveBackendType = 'tmux';
    env.backend = { cliPid: 111, getChildPid: () => 111 };
    env.captureAttachedCodexAppProcessIdentity = vi.fn(() => ({ launcherPid: 111, launcherProcStart: 'start111', enginePid: 222, engineProcStart: 'engine222' }));
    env.findCodexRolloutSetByPid = vi.fn(() => new Set(['native-conversation']));
    env.findCodexRolloutByPid = vi.fn(() => ({ cliSessionId: 'native-conversation' }));
    env.readProcessStartIdentity = vi.fn((pid: number) => pid === 111 ? 'start111' : 'engine222');
    env.runtimeIdentityForContract = loadWorkerFunction('runtimeIdentityForContract', env);
    env.publishRuntimeContract = loadWorkerFunction('publishRuntimeContract', env);
  } else if (reattached) {
    store.bindQueuedExecution(ref, execution, active.runtime!);
    store.apply(ref, { type: 'execution_phase', runtime: active.runtime!, execution, phase: 'submitting' });
    scope.noteAdmission({ ref: execution, runtime: active.runtime!, phase: 'submitting' });
    scope.rememberExecution(execution, active);
  } else scope.run(active, () => { scope.enterTurn('turnA', executionAttempt); loadWorkerFunction<any>('markTurnExecutionStart', env)('turnA', executionAttempt); });
  const line = loadWorkerFunction<any>('handleCodexAppControlLine', env);
  const connection: any = { socket, channelId: 1, epoch: 'epoch', authenticated: true, challenge,
    identity: { generation, publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') },
    sequenceFence: new CodexAppControlSequenceFence(), finalAssembler: new CodexAppControlFinalAssembler() };
  const final = async (metadata: Record<string, unknown> = {}, conn = connection, firstSequence = 1) => {
    const content = typeof metadata.content === 'string' ? metadata.content : 'native answer';
    const total = content.length ? 1 : 0;
    const fragments: Array<[string, any]> = [
      ['final-start', { id: 'finalA', total, turnId: 'turnA', ...metadata }],
      ...(total ? [['final-chunk', { id: 'finalA', index: 0, data: Buffer.from(content).toString('base64') }] as [string, any]] : []),
      ['final-end', { id: 'finalA', total }],
    ];
    for (let i = 0; i < fragments.length; i++) {
      const [kind,payload] = fragments[i]!;
      const encoded = encodeCodexAppSignedControlMarker(pair.privateKey, ref.sessionId, generation, conn.challenge, i + firstSequence, kind, payload);
      await socketResource.runInAsyncScope(() => line(conn, encoded));
    }
  };
  const reconnect = () => {
    const next: any = { destroyed: false, write: vi.fn(), destroy: vi.fn(() => { next.destroyed = true; }) };
    env.codexAppControlActiveSocket = next;
    return { ...connection, socket: next, challenge: randomBytes(32).toString('base64url'),
      sequenceFence: new CodexAppControlSequenceFence(), finalAssembler: new CodexAppControlFinalAssembler() };
  };
  const add = (turnId: string, attempt: number, binding = active, reserve = true) => {
    const next = controller.admitInput(turnId, attempt); scope.noteAdmission({ ref: next, phase: 'queued' });
    if (reserve) queue.reserve(turnId, attempt, `dispatch-${turnId}-${attempt}`);
    scope.run(binding, () => { scope.enterTurn(turnId, attempt); loadWorkerFunction<any>('markTurnExecutionStart', env)(turnId, attempt); });
    return next;
  };
  const marker = (kind: string, payload: Record<string, unknown>, seq = 1) => socketResource.runInAsyncScope(() => line(connection,
    encodeCodexAppSignedControlMarker(pair.privateKey, ref.sessionId, generation, challenge, seq, kind, payload)));
  return { scope, startup, active, execution, store, ref, env, wire, admissions, queue, socket, final, marker, line, connection, reconnect, add, bind, heldAcks, historicalRuntime, controller,
    restoreNative: () => scope.run(startup, () => loadWorkerFunction<any>('restoreCodexAppContractNativeSession', env)()),
    drainBindings: async () => { while (bindingTasks.length) await Promise.all(bindingTasks.splice(0)); } };
}
describe('signed Codex App final execution origin', () => {
  it('delivers and settles a submitted turn after the startup socket survives a semantic rebind', async () => {
    vi.useFakeTimers(); const h = harness();
    const result = h.final(); await vi.advanceTimersByTimeAsync(0);
    expect(h.wire.filter(m => m.type === 'final_output')).toHaveLength(1); await result;
    expect(h.env.log).not.toHaveBeenCalledWith('Dropped final output with unproven execution origin');
    expect(h.wire.filter(m => m.type === 'final_output')).toHaveLength(1);
    expect(h.wire.filter(m => m.type === 'turn_terminal')).toHaveLength(1);
    expect(h.wire.filter(m => m.type === 'final_output' || m.type === 'turn_terminal').every(m =>
      m.sessionContract.scope.runtime.runtimeId === h.active.runtime!.runtimeId
      && m.sessionContract.scope.execution.executionId === h.execution.executionId)).toBe(true);
    expect(h.queue.findByTurnId('turnA')).toBeUndefined();
    expect(h.store.execution(h.ref, h.execution.executionId)?.phase).toBe('succeeded');
    expect(h.socket.destroy).not.toHaveBeenCalled();
    expect(h.socket.write).toHaveBeenCalledOnce();
  });
  it('selects the worker-owned FIFO attempt when signed metadata omits it and another attempt is known', async () => {
    vi.useFakeTimers(); const h = harness(); h.add('turnA', 2, h.active, false);
    await h.final();
    const final = h.wire.find(m => m.type === 'final_output');
    expect(final?.dispatchAttempt).toBe(1);
    expect(final?.sessionContract.scope.execution).toEqual(h.execution);
    expect(h.store.execution(h.ref, h.execution.executionId)?.phase).toBe('succeeded');
  });
  it('settles only the frozen FIFO head while five newer typeahead turns already submitted', async () => {
    vi.useFakeTimers(); const h = harness();
    for (let i = 2; i <= 6; i++) h.add(`turn${i}`, i);
    await h.final();
    expect(h.wire.filter(m => m.type === 'final_output').map(m => m.turnId)).toEqual(['turnA']);
    expect(h.queue.size()).toBe(5);
    expect(h.store.execution(h.ref, h.execution.executionId)?.phase).toBe('succeeded');
    expect(h.store.executions(h.ref).filter(e => e.phase === 'submitting')).toHaveLength(5);
  });
  it('preserves the final and terminal origin while another turn starts during the daemon ACK wait', async () => {
    vi.useFakeTimers(); const h = harness(); h.env.holdPersistence = true;
    const final = h.final(); await vi.advanceTimersByTimeAsync(0);
    expect(h.heldAcks).toHaveLength(1);
    const other = h.add('turn-newer', 2);
    h.heldAcks.shift()!(); await final;
    expect(h.wire.find(m => m.type === 'turn_terminal')?.sessionContract.scope.execution).toEqual(h.execution);
    expect(h.store.execution(h.ref, h.execution.executionId)?.phase).toBe('succeeded');
    expect(h.store.execution(h.ref, other.executionId)?.phase).toBe('submitting');
  });
  it('ACKs a committed signed replay from a fresh challenge without emitting output or terminal twice', async () => {
    vi.useFakeTimers(); const h = harness(); await h.final();
    const next = h.reconnect(); await h.final({}, next);
    expect(h.wire.filter(m => m.type === 'final_output')).toHaveLength(1);
    expect(h.wire.filter(m => m.type === 'turn_terminal')).toHaveLength(1);
    expect(next.socket.write).toHaveBeenCalledTimes(3);
    expect(next.socket.destroy).not.toHaveBeenCalled();
  });
  it('keeps the FIFO and signed record replayable after a failed persistence ACK, then settles once', async () => {
    vi.useFakeTimers(); const h = harness(); h.env.persistOutcome = false;
    await h.final();
    expect(h.queue.size()).toBe(1); expect(h.env.codexAppGenerationCommits).toEqual([]);
    expect(h.env.codexAppControlReplayWindow.hasSeen('g'.repeat(43), 3)).toBe(false);
    h.env.persistOutcome = true; const next = h.reconnect(); await h.final({}, next);
    expect(h.queue.size()).toBe(0);
    expect(h.wire.filter(m => m.type === 'turn_terminal')).toHaveLength(1);
    expect(h.store.execution(h.ref, h.execution.executionId)?.phase).toBe('succeeded');
  });
  it('retries after an ACK timeout and ignores the first request later acknowledgement', async () => {
    vi.useFakeTimers(); const h = harness(); h.env.holdPersistence = true;
    const first = h.final(); await vi.advanceTimersByTimeAsync(30_001); await first;
    expect(h.queue.size()).toBe(1);
    h.env.holdPersistence = false; const next = h.reconnect(); await h.final({}, next);
    h.heldAcks.shift()!(); await vi.advanceTimersByTimeAsync(0);
    expect(h.queue.size()).toBe(0); expect(h.env.codexAppPendingDaemonAcks.size).toBe(0);
    expect(h.wire.filter(m => m.type === 'turn_terminal')).toHaveLength(1);
  });
  it.each([{ turnId: 'unknown-turn' }, { dispatchAttempt: 999 }])('rejects mismatched final metadata before persistence: %j', async marker => {
    vi.useFakeTimers(); const h = harness(); await h.final(marker);
    expect(h.wire.filter(m => m.type === 'final_output')).toHaveLength(0);
    expect(h.queue.size()).toBe(1); expect(h.socket.destroy).toHaveBeenCalledOnce();
    expect(h.env.codexAppPendingDaemonAcks.size).toBe(0);
  });
  it('cannot borrow a submission made by a different physical backend through the old socket context', async () => {
    vi.useFakeTimers(); const h = harness();
    h.queue.cancelExact(h.queue.findByTurnId('turnA')!.handle);
    const replacement = h.scope.beginRuntime(); h.bind(replacement, 'replacement-native', '222:start222');
    const other = h.add('turn-replacement', 2, replacement);
    const final = h.final({ turnId: 'turn-replacement' });
    await vi.advanceTimersByTimeAsync(30_001); await final;
    expect(h.wire.filter(m => m.type === 'final_output')).toHaveLength(0);
    expect(h.wire.filter(m => m.type === 'turn_terminal')).toHaveLength(0);
    expect(h.queue.size()).toBe(1);
    expect(h.store.execution(h.ref, other.executionId)?.phase).toBe('submitting');
    expect(h.env.codexAppGenerationCommits).toEqual([]);
  });
});

function warmHarness() {
  const h = harness(true); h.add('turnB', 2);
  const entries = [
    { state: 'prepared', dispatchId: 'dispatchA', turnId: 'turnA', dispatchAttempt: 1, codexAppSteerable: true as const },
    { state: 'prepared', dispatchId: 'dispatch-turnB-2', turnId: 'turnB', dispatchAttempt: 2, codexAppSteerable: true as const },
  ];
  h.queue.clear(); h.queue.restore(entries);
  h.env.codexAppRecoveredDispatches = entries;
  h.env.codexAppControlProven = true;
  h.env.codexAppControlStateValue = { status: 'active', identities: [{ generation: 'g'.repeat(43) }] };
  h.env.codexAppCompletionAwaitingFinal = false;
  return { ...h, entries };
}
describe('warm superseded final recovery after completed activity was already ACKed', () => {
  it('recovers the exact prepared steered prefix without a new submission, then settles its real final', async () => {
    vi.useFakeTimers(); const h = warmHarness();
    await h.final({ content: '', disposition: 'steer_superseded' });
    expect(h.queue.size()).toBe(1);
    expect(h.env.codexAppCompletionAwaitingFinal).toBe(true);
    expect(h.wire.find(m => m.type === 'final_output')).toMatchObject({ turnId: 'turnA', dispatchAttempt: 1,
      content: '', suppressDelivery: true, disposition: 'steer_superseded',
      sessionContract: { scope: { execution: h.execution, runtime: h.active.runtime } } });
    await h.final({ turnId: 'turnB' }, h.connection, 3);
    expect(h.queue.size()).toBe(0); expect(h.env.codexAppCompletionAwaitingFinal).toBe(false);
    expect(h.wire.filter(m => m.type === 'turn_terminal')).toHaveLength(2);
    expect(h.store.execution(h.ref, h.execution.executionId)?.phase).toBe('succeeded');
  });
  it('does not restore awaiting-final or advance the FIFO when the durable recovery ACK fails', async () => {
    vi.useFakeTimers(); const h = warmHarness(); h.env.persistOutcome = false;
    await h.final({ content: '', disposition: 'steer_superseded' });
    expect(h.queue.size()).toBe(2);
    expect(h.env.codexAppCompletionAwaitingFinal).toBe(false);
    expect(h.env.codexAppGenerationCommits).toEqual([]);
    expect(h.wire.filter(m => m.type === 'turn_terminal')).toHaveLength(0);
  });
  it.each(['single', 'ordinary', 'local', 'unproven', 'wrong-generation', 'missing-ledger', 'wrong-ledger-identity'])(
    'rejects recovery without the required boundary: %s', async boundary => {
      vi.useFakeTimers(); const h = warmHarness();
      if (boundary === 'single') { h.queue.cancelExact(h.queue.findByTurnId('turnB')!.handle); h.env.codexAppRecoveredDispatches = h.entries.slice(0, 1); }
      if (boundary === 'ordinary') { h.queue.clear(); h.queue.restore(h.entries.map(e => ({ ...e, codexAppSteerable: undefined }))); }
      if (boundary === 'local') { h.queue.clear(); for (const entry of h.entries) h.queue.reserve(entry.turnId, entry.dispatchAttempt, entry.dispatchId, false, undefined, true); }
      if (boundary === 'unproven') h.env.codexAppControlProven = false;
      if (boundary === 'wrong-generation') h.env.codexAppControlStateValue.identities[0].generation = 'other-generation';
      if (boundary === 'missing-ledger') h.env.codexAppRecoveredDispatches = [];
      if (boundary === 'wrong-ledger-identity') h.env.codexAppRecoveredDispatches = h.entries.map(e => ({ ...e, dispatchAttempt: 99 }));
      await h.final({ content: '', disposition: 'steer_superseded' });
      expect(h.wire.filter(m => m.type === 'final_output')).toHaveLength(0);
      expect(h.wire.filter(m => m.type === 'turn_terminal')).toHaveLength(0);
      expect(h.env.codexAppCompletionAwaitingFinal).toBe(false);
      expect(h.socket.destroy).toHaveBeenCalledOnce();
    });
  it('refuses an unsigned direct marker even with a matching recovered FIFO', async () => {
    vi.useFakeTimers(); const h = warmHarness();
    expect(await h.scope.run(h.active, () => h.env.handleTrustedCodexAppMarker('final',
      { turnId: 'turnA', content: '', disposition: 'steer_superseded' }))).toBe(false);
    expect(h.queue.size()).toBe(2); expect(h.env.codexAppCompletionAwaitingFinal).toBe(false);
    expect(h.wire.filter(m => m.type === 'final_output')).toHaveLength(0);
  });
});

describe('authenticated native proof recovery across a bare intermediate observation', () => {
  it('keeps the bare runtime selected and observes the historical attempt before the signed final', async () => {
    vi.useFakeTimers(); const h = harness('native-recovery');
    expect(h.store.execution(h.ref, h.execution.executionId)?.phase).toBe('reconciling');
    expect(h.startup.runtime).not.toEqual(h.historicalRuntime);
    h.restoreNative(); await h.drainBindings();
    expect(h.scope.currentBinding()).toBe(h.startup);
    expect(h.scope.currentBinding()?.runtime).toEqual(h.startup.runtime);
    expect(h.scope.currentBinding()?.runtime).not.toEqual(h.historicalRuntime);
    const pending = h.final(); await vi.advanceTimersByTimeAsync(0);
    expect(h.wire.filter(m => m.type === 'final_output')).toHaveLength(1); await pending;
    expect(h.wire.find(m => m.type === 'final_output')?.sessionContract).toMatchObject({ producer: { generation: 2 }, scope: { runtime: h.historicalRuntime, execution: h.execution } });
    expect(h.store.execution(h.ref, h.execution.executionId)?.phase).toBe('succeeded');
    expect(h.queue.size()).toBe(0); expect(h.store.executions(h.ref)).toHaveLength(1);
  });
  it.each(['unproven', 'ambiguous', 'process-gone', 'engine-process-gone', 'missing-attestation', 'rollout-mismatch', 'backend-replacement', 'backend-birth-drift', 'backend-pid-drift'])(
    'does not claim the old native identity from %s evidence', async failure => {
      vi.useFakeTimers(); const h = harness('native-recovery');
      if (failure === 'unproven') h.env.codexAppControlProven = false;
      if (failure === 'ambiguous') h.env.findCodexRolloutSetByPid.mockReturnValue(new Set(['native-conversation', 'other']));
      if (failure === 'process-gone') h.env.readProcessStartIdentity.mockReturnValue(undefined);
      if (failure === 'engine-process-gone') h.env.readProcessStartIdentity.mockImplementation((pid: number) => pid === 111 ? 'start111' : undefined);
      if (failure === 'backend-replacement') h.env.findCodexRolloutByPid.mockImplementation(() => { h.env.backend = { ...h.env.backend }; return { cliSessionId: 'native-conversation' }; });
      if (failure === 'backend-birth-drift') { let reads = 0; h.env.readProcessStartIdentity.mockImplementation((pid: number) => pid === 111 ? (++reads === 1 ? 'start111' : 'reused111') : 'engine222'); }
      if (failure === 'backend-pid-drift') h.env.findCodexRolloutByPid.mockImplementation(() => { h.env.backend.getChildPid = () => 333; return { cliSessionId: 'native-conversation' }; });
      if (failure === 'missing-attestation') h.env.captureAttachedCodexAppProcessIdentity.mockReturnValue(undefined);
      if (failure === 'rollout-mismatch') h.env.findCodexRolloutByPid.mockReturnValue({ cliSessionId: 'other' });
      h.restoreNative(); await h.drainBindings();
      expect(h.scope.currentBinding()).toBe(h.startup);
      expect(h.store.runtime(h.ref)?.ref).toEqual(h.startup.runtime);
      expect(h.store.execution(h.ref, h.execution.executionId)?.phase).toBe('reconciling');
      expect(h.wire.filter(m => m.type === 'runtime_binding')).toHaveLength(0);
    });
});

describe('control stop during final persistence wait', () => {
  it('keeps a replacement execution live when the stopped generation receives a late ACK', async () => {
    vi.useFakeTimers(); const h = harness(); h.env.holdPersistence = true;
    const final = h.final(); await vi.advanceTimersByTimeAsync(0);
    expect(h.heldAcks).toHaveLength(1);
    h.env.clearCodexAppEngineIdentity = vi.fn();
    h.env.codexAppProofDeadline = { clear: vi.fn() };
    h.env.codexAppControlConnections = new Map([[h.socket, h.connection]]);
    loadWorkerFunction<any>('stopCodexAppControlChannel', h.env)();
    const replacement = h.scope.beginRuntime(); h.bind(replacement, 'replacement', '333:start333');
    const other = h.add('replacement-turn', 3, replacement);
    h.env.codexAppCompletionAwaitingFinal = true;
    h.heldAcks.shift()!(); await final;
    expect(h.env.codexAppCompletionAwaitingFinal).toBe(true);
    expect(h.store.execution(h.ref, other.executionId)?.phase).toBe('submitting');
    expect(h.wire.filter(m => m.type === 'turn_terminal')).toHaveLength(0);
    expect(h.queue.findByTurnId('replacement-turn')).toBeDefined();
  });
});

describe('new input during bare runtime recovery', () => {
  it('keeps historical and middle attempts separate when the bare runtime already has unfinished work', async () => {
    vi.useFakeTimers(); const h = harness('native-recovery');
    const middle = h.add('middle-turn', 2, h.startup);
    h.restoreNative(); await h.drainBindings();
    expect(h.scope.currentBinding()).toBe(h.startup);
    expect(h.store.runtime(h.ref)?.ref).toEqual(h.startup.runtime);
    expect(h.store.execution(h.ref, h.execution.executionId)).toMatchObject({ phase: 'reconciling', runtime: h.historicalRuntime });
    expect(h.store.execution(h.ref, middle.executionId)).toMatchObject({ phase: 'submitting', runtime: h.startup.runtime });
    expect(h.store.executions(h.ref)).toHaveLength(2);
  });
});


function signedReadinessHarness() {
  const h = harness(); const e = h.env;
  h.queue.clear();
  Object.assign(e, {
    codexAppCompletionAwaitingFinal: false, codexAppControlProven: true,
    codexAppRunnerProcessIdentity: { launcherPid: 111, launcherProcStart: 'start111', enginePid: 222, engineProcStart: 'engine222' },
    codexAppReadyAuthority: new CodexAppReadyAuthority(), applyTrustedCodexAppStateMarker, codexAppSignedStateReadiness,
    codexAppProofDeadline: { armed: false, clear: vi.fn() }, cleanupCodexAppControlBootstrap: vi.fn(),
    failCodexAppControlGeneration: vi.fn(), awaitingFirstPrompt: false, isPromptReady: false,
    isFlushing: false, durableTurnInFlight: true, preserveActiveTurnAuthorityForReady: false,
    pendingMessages: [], pendingRawInputs: [], pendingAdoptMessages: [], pendingSessionRename: null, pendingInjections: [],
    ptyOutputGeneration: { snapshot: () => 1 }, queuedTypeAheadTurns: [], promptReadyEdges: 0,
    decideQueuedReadyTransition: () => ({ releaseActiveTurnAuthority: false, advanceQueuedTurn: false }),
    inflightInputs: { onTurnComplete: vi.fn() }, backgroundTaskTracker: { pendingTurnAgents: () => 0 },
    freshnessInputQueue: { onPromptReady: () => 'continue' }, bridgeQueue: { cliQueueDrained: vi.fn() },
    readyGate: { shouldHold: () => false },
  });
  for (const name of ['traexFirstPromptViewportRejects', 'currentPostTerminalInputFence', 'currentInputDeliveryQuarantine',
    'holdForNativeSessionFork', 'probeStartupBlocker', 'spawnArgvTurnStartGateHolds', 'hasStructuredLifecycleBlock',
    'syncQueuedTurnsFromMarkerDisk', 'shouldFlushInjectionsFirst']) e[name] = () => false;
  for (const name of ['stopStructuredStartGraceRecheck', 'stopBusyPatternIdleProbe',
    'releaseInterruptedStructuredBridgeOnFirstPrompt', 'judgeClaudeBridgeTurn', 'settleSessionRenameOnPrompt',
    'releaseRawInputRestartGate', 'maybeEmitWorkflowTranscriptOutput', 'refreshBackgroundWait', 'settleRestartAttemptOnReady',
    'advanceQueuedTypeAheadTurn', 'flushPending']) e[name] = vi.fn();
  e.hasCurrentSessionRuntime = loadWorkerFunction('hasCurrentSessionRuntime', e);
  e.markPromptReady = loadWorkerFunction('markPromptReady', e);
  h.scope.run(h.active, () => e.send({ type: 'ready' }));
  return h;
}

describe('signed Codex App state follows the same physical runtime after launcher enrichment', () => {
  it('publishes real prompt-ready metadata through the gateway and makes the current native runtime ready', async () => {
    vi.useFakeTimers(); const h = signedReadinessHarness();
    const before = h.store.read(h.ref)!;
    expect(h.store.runtime(h.ref, h.active.runtime!.runtimeId)?.phase).toBe('starting');
    await h.marker('state', { busy: false, acceptingInput: true });
    await vi.advanceTimersByTimeAsync(0);
    const ready = h.wire.filter(m => m.type === 'prompt_ready');
    expect(ready).toHaveLength(1);
    expect(ready[0].sessionContract.scope.runtime).toEqual(h.active.runtime);
    expect(ready[0].sessionContract.scope.runtime).not.toEqual(h.startup.runtime);
    expect(h.admissions.at(-1)?.kind).toBe('current');
    const after = h.store.read(h.ref)!;
    expect(h.store.runtime(h.ref, h.active.runtime!.runtimeId)?.promptReady).toBe(true);
    expect(after.readinessSequence).toBe(before.readinessSequence + 1);
    expect(h.controller.ds.cliReady).toBe(true);
    expect(h.controller.ds.cliReadyGeneration).toBe(after.readinessSequence);
    expect(h.store.runtime(h.ref, h.active.runtime!.runtimeId)?.phase).toBe('ready');
    expect(h.env.isPromptReady).toBe(true);
    expect(h.env.failCodexAppControlGeneration).not.toHaveBeenCalled();
    expect(h.socket.destroy).not.toHaveBeenCalled();
    expect(h.socket.write).toHaveBeenCalledOnce();
  });
  it('rejects an authenticated stale socket state after the physical backend has been replaced', async () => {
    vi.useFakeTimers(); const h = signedReadinessHarness();
    const replacement = h.scope.beginRuntime(); h.bind(replacement, 'replacement-native', '222:start222');
    const before = h.store.read(h.ref)!;
    await h.marker('state', { busy: false, acceptingInput: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wire.filter(m => m.type === 'prompt_ready')).toHaveLength(0);
    expect(h.store.read(h.ref)?.readinessSequence).toBe(before.readinessSequence);
    expect(h.store.runtime(h.ref, replacement.runtime!.runtimeId)?.promptReady).toBe(false);
    expect(h.controller.ds.cliReady).toBe(false);
    expect(h.store.runtime(h.ref, replacement.runtime!.runtimeId)?.phase).toBe('starting');
    expect(h.env.codexAppReadyAuthority.canPublishPromptReady()).toBe(false);
    expect(h.env.codexAppSignedStateObserved).not.toBe(true);
    expect(h.env.codexAppControlReplayWindow.hasSeen('g'.repeat(43), 1)).toBe(false);
    expect(h.socket.write).not.toHaveBeenCalled();
    expect(h.socket.destroy).toHaveBeenCalledOnce();
  });
});

describe('ordinary Codex App finals retain absent dispatch attempt identity', () => {
  it('settles an ordinary local turn with undefined attempt across a semantic rebind of the same physical runtime', async () => {
    vi.useFakeTimers(); const h = harness(false, true);
    expect(h.execution.dispatchAttempt).toBeUndefined();
    expect(h.queue.findByTurnId('turnA')?.dispatchAttempt).toBeUndefined();
    const final = h.final(); await vi.advanceTimersByTimeAsync(30_001); await final;
    expect(h.wire.filter(m => m.type === 'final_output')).toHaveLength(1);
    expect(h.wire.find(m => m.type === 'final_output')?.sessionContract.scope.execution).toEqual(h.execution);
    expect(h.store.execution(h.ref, h.execution.executionId)?.phase).toBe('succeeded');
  });
  it('settles an ordinary historical turn with undefined attempt through the actual recovered observer assignment', async () => {
    vi.useFakeTimers(); const h = harness('native-recovery', true);
    expect(h.execution.dispatchAttempt).toBeUndefined();
    await h.restoreNative(); await h.drainBindings();
    expect(h.store.authorizedExecutionObserver(h.ref, h.historicalRuntime, h.scope.worker, h.execution)).toBe(true);
    const final = h.final(); await vi.advanceTimersByTimeAsync(30_001); await final;
    expect(h.wire.filter(m => m.type === 'final_output')).toHaveLength(1);
    expect(h.wire.find(m => m.type === 'final_output')?.sessionContract.scope.execution).toEqual(h.execution);
    expect(h.wire.find(m => m.type === 'final_output')?.sessionContract.scope.runtime).toEqual(h.historicalRuntime);
    expect(h.store.execution(h.ref, h.execution.executionId)?.phase).toBe('succeeded');
  });
});
