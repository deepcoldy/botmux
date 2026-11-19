import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import * as recovery from '../src/services/ordinary-turn-recovery.js';
import { CODEX_CAPACITY_ERROR_CODE } from '../src/services/codex-transcript.js';
import { codexCapacityRecoveryCli } from '../src/services/codex-app-failure.js';
import { runnerFinalOutcome, codexAppSettlementOutcome } from '../src/services/runner-final-outcome.js';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import { normalizeFinalUsage } from '../src/services/codex-app-runner-protocol.js';
import { bridgePostText } from '../src/services/bridge-fallback-gate.js';
import { CodexAppTurnDispatchQueue } from '../src/utils/codex-app-turn-dispatch.js';
import { committedCodexAppSequence } from '../src/utils/codex-app-dispatch-ledger.js';
import { CodexAppControlSequenceFence, encodeCodexAppSignedControlMarker, encodeCodexAppControlAck,
  parseCodexAppControlWireRecord, verifyCodexAppSignedControlMarker } from '../src/utils/codex-app-control.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { appRecoveryHarness } from './helpers/codex-app-capacity-harness.js';
import { loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';

const sessions: any[] = [];
function host() { const h = appRecoveryHarness(); sessions.push(h.ds.session); return h; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => { for (const s of sessions.splice(0)) recovery.disposeOrdinaryTurnRecovery(s); vi.useRealTimers(); });

describe('capacity recovery adversarial interleavings', () => {
  it('records one opt-out notice and cancels the timer even if disabling recovery cannot persist', async () => {
    vi.useFakeTimers(); const h = host();
    recovery.beginOrdinaryTurnRecovery(h.ds.session, 'om_original'); h.fail();
    h.botCfg.codexCapacityRecovery = false;
    h.persist.mockImplementation(() => { throw new Error('disk unavailable'); });
    const dispose = loadWorkerPoolFunction<any>('disposeIneligibleOrdinaryTurnRecovery', {
      codexCapacityRecoveryCli, sessionCliId: () => 'codex-app',
      ordinaryTurnRecoveryEligible: () => true, ordinaryTurnRecoveryStillOwnsSession: () => true,
      cancelOrdinaryRecoveryForUserInput: recovery.cancelOrdinaryTurnRecoveryForUserInput,
      disposeOrdinaryTurnRecovery: recovery.disposeOrdinaryTurnRecovery,
      sessionStore: { updateSession: h.persist }, notifyOrdinaryTurnRecoveryFailure: h.warn,
      logger: { error: vi.fn() }, tag: () => 'probe',
    });
    dispose(h.ds, h.botCfg); dispose(h.ds, h.botCfg);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.ds.session.ordinaryTurnRecovery).toMatchObject({ status: 'cancelled', warningDispatched: true,
      cancelledByTurnId: 'recovery_disabled' });
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it.each(['ctrlc', 'esc', 'new-input', 'config-off'])(
    'does not dispatch after %s during asynchronous identity preparation', async action => {
      vi.useFakeTimers(); const h = host(); const gate = deferred();
      h.prepare.mockImplementation(() => gate.promise);
      recovery.beginOrdinaryTurnRecovery(h.ds.session, 'om_original'); h.fail();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(h.ds.session.ordinaryTurnRecovery.status).toBe('dispatching');
      if (action === 'config-off') h.botCfg.codexCapacityRecovery = false;
      else if (action === 'new-input') recovery.beginOrdinaryTurnRecovery(h.ds.session, 'om_new');
      else h.stop(h.ds, { type: 'term_action', key: action });
      gate.resolve(); await vi.advanceTimersByTimeAsync(120_000);
      expect(h.send).not.toHaveBeenCalled();
      expect(h.ds.session.ordinaryTurnRecovery.status).toBe(action === 'new-input' ? 'running'
        : action === 'config-off' ? 'attention_required' : 'cancelled');
    });

  it('retains a stop locally if persistence fails and refuses old backoff after restart', async () => {
    vi.useFakeTimers(); const h = host();
    recovery.beginOrdinaryTurnRecovery(h.ds.session, 'om_original'); h.fail();
    const durable = structuredClone(h.ds.session);
    h.persist.mockImplementation(() => { throw new Error('disk unavailable'); });
    h.stop(h.ds, { type: 'term_action', key: 'ctrlc' });
    expect(h.ds.worker.send).toHaveBeenCalledWith(expect.objectContaining({ key: 'ctrlc' }));
    expect(h.ds.session.ordinaryTurnRecovery.status).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(60_000); expect(h.send).not.toHaveBeenCalled();
    recovery.disposeOrdinaryTurnRecovery(h.ds.session);
    const restored = appRecoveryHarness({}, durable); sessions.push(restored.ds.session);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(restored.send).not.toHaveBeenCalled();
    expect(restored.ds.session.ordinaryTurnRecovery.lastErrorCode).toBe('recovery_restart_unverified');
  });

  it('does not replay a continuation accepted before its running projection failed to persist', async () => {
    vi.useFakeTimers(); const h = host(); let durable: any;
    h.persist.mockImplementation(() => {
      if (h.ds.session.ordinaryTurnRecovery.status === 'running'
        && h.ds.session.ordinaryTurnRecovery.continuationsStarted > 0) throw new Error('post-enqueue write failed');
      durable = structuredClone(h.ds.session);
    });
    recovery.beginOrdinaryTurnRecovery(h.ds.session, 'om_original'); h.fail();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.send).toHaveBeenCalledTimes(1);
    recovery.disposeOrdinaryTurnRecovery(h.ds.session);
    const restored = appRecoveryHarness({}, durable); sessions.push(restored.ds.session);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(restored.send).not.toHaveBeenCalled();
    expect(restored.ds.session.ordinaryTurnRecovery.status).toBe('attention_required');
  });

  // P3-1 negative wiring probes: the App continuation's human proof is gated in
  // BOTH the prepare closure (before awaiting identity publication) and the
  // enqueue closure (the later defense-in-depth check). Removing the frozen
  // per-turn record must fail closed at each wiring, never dispatch.
  it('prepare refuses a continuation whose frozen human proof is missing', async () => {
    vi.useFakeTimers(); const h = host();
    delete h.ds.session.turnReplyContexts.om_original;
    delete h.ds.session.replyTargets.om_original;
    recovery.beginOrdinaryTurnRecovery(h.ds.session, 'om_original'); h.fail();
    await vi.advanceTimersByTimeAsync(120_000);
    // The caller check throws before identity publication is even attempted.
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.ds.session.ordinaryTurnRecovery.status).toBe('attention_required');
    expect(h.ds.session.ordinaryTurnRecovery.lastErrorCode).toBe('recovery_enqueue_failed');
  });

  it('enqueue refuses a continuation when the proof vanishes during asynchronous prepare', async () => {
    vi.useFakeTimers(); const h = host(); const gate = deferred();
    // prepare passes its synchronous caller check (proof present), then waits;
    // during that window the live logical-turn proof disappears. The enqueue
    // closure re-reads the LOGICAL turn id and must fail closed.
    h.prepare.mockImplementation(() => gate.promise);
    recovery.beginOrdinaryTurnRecovery(h.ds.session, 'om_original'); h.fail();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.ds.session.ordinaryTurnRecovery.status).toBe('dispatching');
    delete h.ds.session.turnReplyContexts.om_original;
    delete h.ds.session.replyTargets.om_original;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.ds.session.ordinaryTurnRecovery.status).toBe('attention_required');
    expect(h.ds.session.ordinaryTurnRecovery.lastErrorCode).toBe('recovery_enqueue_failed');
  });

  it('preserves original human across newer live routing changes and repeated failed terminals', async () => {    vi.useFakeTimers(); const h = host(); const gate = deferred(); h.prepare.mockImplementation(() => gate.promise);
    recovery.beginOrdinaryTurnRecovery(h.ds.session, 'om_original'); h.fail(); h.fail();
    await vi.advanceTimersByTimeAsync(15_000);
    h.ds.session.quoteTargetSenderOpenId = 'ou_newer';
    h.ds.session.replyTargets.om_newer = { senderOpenId: 'ou_newer', participants: [{ openId: 'ou_newer', isBot: false }] };
    gate.resolve(); await vi.advanceTimersByTimeAsync(120_000);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][3].trustedCaller.requestUserOpenId).toBe('ou_original');
  });
});

function signedWorker() {
  const queue = new CodexAppTurnDispatchQueue();
  queue.reserve('om_first', 1, 'dispatch-first', false, undefined, true);
  queue.reserve('om_last', 2, 'dispatch-last', false, undefined, true);
  const send = vi.fn(), terminal = vi.fn();
  const scope: any = {
    lastInitConfig: { cliId: 'codex-app' }, isCodexAppCliId, normalizeFinalUsage, bridgePostText, runnerFinalOutcome,
    codexAppTurnDispatchQueue: queue, codexAppCompletionAwaitingFinal: true,
    codexAppTurnLiveness: { completeCurrent: vi.fn() }, codexAppGenerationCommits: [], codexAppRecoveredDispatches: [],
    randomBytes: () => ({ toString: () => 'request' }), turnExecutionClock: { peek: () => undefined },
    waitForCodexAppDaemonPersistence: vi.fn(async (_id: any, publish: any) => { publish(); return true; }),
    send, emitTurnTerminal: terminal, log: vi.fn(), cliName: () => 'Codex App', rejectCodexAppControlMarker: vi.fn(),
  };
  const final = loadWorkerFunction<(kind: string, payload: any, control: any) => Promise<boolean>>('handleTrustedCodexAppMarker', scope);
  return { queue, scope, send, terminal, final };
}

function settlementWriter(h: ReturnType<typeof appRecoveryHarness>, updateSession: any,
  reconcile = recovery.reconcileOrdinaryTurnRecoveryTerminalReceipt) {
  return loadWorkerPoolFunction<any>('persistCodexAppRecoverySettlement', {
    ordinaryTurnRecoveryEligible: () => true,
    stageOrdinaryTurnRecoveryTerminal: recovery.stageOrdinaryTurnRecoveryTerminal,
    reconcileOrdinaryTurnRecoveryTerminalReceipt: reconcile, codexAppSettlementOutcome,
    sessionStore: { updateSession },
  });
}

describe('signed capacity final persistence boundary', () => {
  it('replacement workers ACK committed signed failures without re-emitting the final', async () => {
    vi.useFakeTimers();
    const pair = generateKeyPairSync('ed25519');
    const generation = 'g'.repeat(43), challenge = 'c'.repeat(43), sessionId = 'committed-replay';
    const socket = { write: vi.fn(), destroy: vi.fn() };
    const connection: any = { socket, channelId: 1, epoch: 'epoch', authenticated: true, challenge,
      identity: { generation, publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') },
      sequenceFence: new CodexAppControlSequenceFence(), finalAssembler: { accept: vi.fn(() => ({ status: 'accepted' })) } };
    const scope = { lastInitConfig: { sessionId }, codexAppControlChannelId: 1,
      codexAppControlEndpointEpoch: 'epoch', codexAppControlActiveSocket: socket,
      parseCodexAppControlWireRecord, verifyCodexAppSignedControlMarker, encodeCodexAppControlAck,
      committedCodexAppSequence, codexAppGenerationCommits: [{ generation, committedThrough: 1 }],
      rejectCodexAppControlMarker: vi.fn(), codexAppControlReplayWindow: { hasSeen: () => false } };
    const line = encodeCodexAppSignedControlMarker(pair.privateKey, sessionId, generation, challenge, 1,
      'final', { turnId: 'om_original', content: 'capacity', errorCode: CODEX_CAPACITY_ERROR_CODE });
    await loadWorkerFunction<any>('handleCodexAppControlLine', scope)(connection, line);
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(connection.finalAssembler.accept).not.toHaveBeenCalled();
    expect(JSON.parse(socket.write.mock.calls[0][0])).toMatchObject({ type: 'ack', seq: 1 });
  });

  it.each(['http_async', 'http_wait'] as const)('settles parked %s steer members as failed when the real signed final is a capacity failure', async sink => {
    vi.useFakeTimers(); const w = signedWorker();
    const wait = { resolve: vi.fn(), reject: vi.fn() };
    const ds: any = { larkAppId: 'app_original', session: { sessionId: 'steered-http' },
      asyncTriggerResults: new Map([['om_first', { status: 'pending' }]]),
      pendingWaitPromises: new Map(sink === 'http_wait' ? [['om_first', wait]] : []), idempotentAsyncTurns: new Set(['om_first']),
    };
    const scope: any = { steerFanoutBySession: new Map(),
      asyncTriggerStore: { recordSteerParked: vi.fn(), recordCompleted: vi.fn(), recordTerminalFailureStrict: vi.fn() },
      logger: { error: vi.fn() }, tag: () => 'probe' };
    const park = loadWorkerPoolFunction<any>('parkSteerFanoutMember', scope);
    const fanout = loadWorkerPoolFunction<any>('fanOutSteerGroupFinal', scope);
    await w.final('final', { turnId: 'om_first', content: '', disposition: 'steer_superseded' }, { generation: 'g', seq: 1 });
    park(ds, 'g', { turnId: 'om_first', sink }, 'om_last');
    await w.final('final', { turnId: 'om_last', content: 'capacity', errorCode: CODEX_CAPACITY_ERROR_CODE }, { generation: 'g', seq: 2 });
    const msg = w.send.mock.calls.at(-1)![0];
    expect(codexAppSettlementOutcome(msg).status).toBe('failed');
    // Mirrors setupWorkerHandlers' post-commit call for a non-superseded final.
    fanout(ds, 'g', msg.content, Date.now(), msg);
    if (sink === 'http_async') {
      expect(ds.asyncTriggerResults.get('om_first')).toMatchObject({ status: 'failed', terminalErrorCode: CODEX_CAPACITY_ERROR_CODE });
      expect(scope.asyncTriggerStore.recordTerminalFailureStrict).toHaveBeenCalledOnce();
    } else {
      expect(wait.reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(CODEX_CAPACITY_ERROR_CODE) }));
      expect(wait.resolve).not.toHaveBeenCalled();
      expect(ds.pendingWaitPromises.has('om_first')).toBe(false);
    }
    expect(scope.asyncTriggerStore.recordCompleted).not.toHaveBeenCalled();
  });

  it.each(['before-reconcile', 'after-ACK'])('surfaces a committed capacity failure after process death %s', async crashAt => {
    vi.useFakeTimers(); const h = host(); const w = signedWorker();
    recovery.beginOrdinaryTurnRecovery(h.ds.session, 'om_original');
    w.queue.cancelExact(w.queue.findByTurnId('om_first')!.handle);
    w.queue.cancelExact(w.queue.findByTurnId('om_last')!.handle);
    w.queue.reserve('om_original', undefined, 'dispatch-original');
    let durable: any;
    const write = settlementWriter(h, () => { durable = structuredClone(h.ds.session); },
      crashAt === 'before-reconcile' ? () => { throw new Error('daemon killed after atomic write'); }
        : recovery.reconcileOrdinaryTurnRecoveryTerminalReceipt);
    h.persist.mockImplementation(() => { durable = structuredClone(h.ds.session); });
    w.scope.waitForCodexAppDaemonPersistence.mockImplementation(async (_id: any, publish: any) => {
      publish();
      write(h.ds, { ledger: [], commits: [{ generation: 'g', committedThrough: 1 }] }, w.send.mock.calls.at(-1)![0], 'lark');
      return true;
    });
    w.terminal.mockImplementation(() => { throw new Error('worker killed after ACK'); });
    await expect(w.final('final', { turnId: 'om_original', content: 'capacity', errorCode: CODEX_CAPACITY_ERROR_CODE },
      { generation: 'g', seq: 1 })).rejects.toThrow(crashAt === 'before-reconcile' ? 'daemon killed after atomic write' : 'worker killed after ACK');
    expect(durable.codexAppGenerationCommits).toEqual([{ generation: 'g', committedThrough: 1 }]);
    if (crashAt === 'before-reconcile') {
      expect(durable.ordinaryTurnRecovery.pendingTerminal).toEqual({ turnId: 'om_original', status: 'failed', errorCode: CODEX_CAPACITY_ERROR_CODE });
    }
    recovery.disposeOrdinaryTurnRecovery(h.ds.session);
    const restored = appRecoveryHarness({}, durable); sessions.push(restored.ds.session);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(restored.send).not.toHaveBeenCalled();
    // No final replay is available: the daemon has committed this signed seq.
    // The failed task must at least leave a warning/attention state on restore.
    expect(restored.ds.session.ordinaryTurnRecovery.status).toBe('attention_required');
    expect(restored.warn).toHaveBeenCalledTimes(1);
    expect(restored.ds.session.ordinaryTurnRecovery.pendingTerminal).toBeUndefined();
  });

  it('rolls back ledger, high-water and staged terminal when their atomic write fails', () => {
    vi.useFakeTimers(); const h = host(); recovery.beginOrdinaryTurnRecovery(h.ds.session, 'om_original');
    const ledger = [{ dispatchId: 'original' }], commits: any[] = [];
    h.ds.session.codexAppDispatchLedger = ledger; h.ds.session.codexAppGenerationCommits = commits;
    const prior = h.ds.session.ordinaryTurnRecovery;
    const write = settlementWriter(h, () => { throw new Error('atomic write failed'); });
    expect(() => write(h.ds, { ledger: [], commits: [{ generation: 'g', committedThrough: 1 }] },
      { turnId: 'om_original', turnFailed: true, turnFailureCode: CODEX_CAPACITY_ERROR_CODE }, 'lark')).toThrow('atomic write failed');
    expect(h.ds.session.codexAppDispatchLedger).toBe(ledger);
    expect(h.ds.session.codexAppGenerationCommits).toBe(commits);
    expect(h.ds.session.ordinaryTurnRecovery).toBe(prior);
    expect(prior.pendingTerminal).toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each(['newer-owner', 'http-sink'])('never stages a recovery receipt across %s provenance', scenario => {
    vi.useFakeTimers(); const h = host(); recovery.beginOrdinaryTurnRecovery(h.ds.session, 'om_original');
    const writes: any[] = [];
    const write = settlementWriter(h, () => { writes.push(structuredClone(h.ds.session)); });
    write(h.ds, { ledger: [], commits: [{ generation: 'g', committedThrough: 1 }] },
      { turnId: scenario === 'newer-owner' ? 'om_obsolete' : 'om_original', turnFailed: true,
        turnFailureCode: CODEX_CAPACITY_ERROR_CODE }, scenario === 'http-sink' ? 'http_async' : 'lark');
    expect(writes[0].ordinaryTurnRecovery.pendingTerminal).toBeUndefined();
    expect(h.ds.session.ordinaryTurnRecovery.status).toBe('running');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('retains the committed receipt if its later recovery projection fails and reconciles it once', async () => {
    vi.useFakeTimers(); const h = host(); recovery.beginOrdinaryTurnRecovery(h.ds.session, 'om_original');
    let durable: any;
    const write = settlementWriter(h, () => { durable = structuredClone(h.ds.session); });
    h.persist.mockImplementation(() => { throw new Error('projection write failed'); });
    const msg = { turnId: 'om_original', turnFailed: true, turnFailureCode: CODEX_CAPACITY_ERROR_CODE };
    expect(() => write(h.ds, { ledger: [], commits: [{ generation: 'g', committedThrough: 1 }] }, msg, 'lark')).toThrow('projection write failed');
    expect(h.ds.session.codexAppGenerationCommits).toEqual(durable.codexAppGenerationCommits);
    expect(h.ds.session.ordinaryTurnRecovery.pendingTerminal).toMatchObject({ turnId: 'om_original' });
    h.persist.mockImplementation(() => { durable = structuredClone(h.ds.session); });
    recovery.reconcileOrdinaryTurnRecoveryTerminalReceipt(h.ds.session);
    recovery.reconcileOrdinaryTurnRecoveryTerminalReceipt(h.ds.session);
    expect(h.ds.session.ordinaryTurnRecovery.pendingTerminal).toBeUndefined();
    expect(h.ds.session.ordinaryTurnRecovery.status).toBe('backoff');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('retains exact head on negative ACK and replays the same failed outcome after ACK', async () => {
    vi.useFakeTimers(); const w = signedWorker();
    await w.final('final', { turnId: 'om_first', content: '', disposition: 'steer_superseded' }, { generation: 'g', seq: 1 });
    w.scope.waitForCodexAppDaemonPersistence.mockImplementationOnce(async (_id: any, publish: any) => { publish(); return false; });
    const payload = { turnId: 'om_last', content: 'capacity', errorCode: CODEX_CAPACITY_ERROR_CODE };
    expect(await w.final('final', payload, { generation: 'g', seq: 2 })).toBe(false);
    expect(w.queue.findByTurnId('om_last')).toBeDefined();
    expect(w.terminal).toHaveBeenCalledTimes(1);
    expect(w.scope.codexAppCompletionAwaitingFinal).toBe(true);
    expect(await w.final('final', payload, { generation: 'g', seq: 2 })).toBe(true);
    expect(w.queue.findByTurnId('om_last')).toBeUndefined();
    expect(w.terminal.mock.calls.at(-1)?.slice(0, 4)).toEqual(['om_last', 'failed', CODEX_CAPACITY_ERROR_CODE, 2]);
    const last = w.send.mock.calls.at(-1)![0];
    expect(codexAppSettlementOutcome(last)).toEqual({ status: 'failed', errorCode: CODEX_CAPACITY_ERROR_CODE });
  });

  it('attributes steer placeholders to their exact heads and capacity failure only to the real final', async () => {
    vi.useFakeTimers(); const w = signedWorker();
    expect(await w.final('final', { turnId: 'om_first', content: '', disposition: 'steer_superseded' }, { generation: 'g', seq: 1 })).toBe(true);
    expect(w.scope.codexAppCompletionAwaitingFinal).toBe(true);
    expect(await w.final('final', { turnId: 'om_last', content: 'capacity', errorCode: CODEX_CAPACITY_ERROR_CODE }, { generation: 'g', seq: 2 })).toBe(true);
    expect(w.send.mock.calls.map(([msg]) => [msg.turnId, msg.turnFailed, msg.disposition])).toEqual([
      ['om_first', undefined, 'steer_superseded'], ['om_last', true, undefined],
    ]);
    expect(w.scope.codexAppCompletionAwaitingFinal).toBe(false);
  });
});
