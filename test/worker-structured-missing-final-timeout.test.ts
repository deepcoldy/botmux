import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { StructuredMissingFinalWatchdog } from '../src/services/structured-missing-final.js';
import { PtyOutputGeneration } from '../src/utils/runtime-screen-status.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

function workerRig(cliId = 'codex', opts: { attempt?: number; delivery?: 'send' | 'transcript' } = {}) {
  let now = 0;
  const queue = new CodexBridgeQueue(() => now);
  queue.mark('om_turn', 'question', now, opts.attempt);
  queue.ingest([{ uuid: 'native-user-1', timestampMs: now, kind: 'user', text: 'question' }]);
  const scope: Record<string, any> = {
    lastInitConfig: { cliId, replyDelivery: opts.delivery ?? 'transcript', adoptMode: false },
    replyDeliveryMode: () => opts.delivery ?? 'transcript',
    zeroPromptTerminalSync: () => false,
    codexBridgeQueue: queue,
    backgroundTaskTracker: { pendingTurnAgents: () => 0 },
    structuredBridgeIs: (id: string) => id === cliId,
    antigravityBridgeState: () => ({}),
    hasAntigravityPendingTasks: () => false,
    idleDetector: { programStatusHeldBusy: () => false },
    isPromptReady: true,
    hasStructuredLifecycleBlock: () => false,
    structuredRejectedReadyEvidenceGeneration: undefined,
    ptyOutputGeneration: new PtyOutputGeneration(),
    lastStructuredBridgeActivityAtMs: 0,
    cliSpawnGeneration: 1,
    structuredMissingFinalWatchdog: new StructuredMissingFinalWatchdog(),
    codexBridgeIngest: vi.fn(),
    dropPendingTurn: undefined,
    log: vi.fn(),
    emitTurnTerminal: vi.fn(),
    retireStructuredTurnAttribution: vi.fn(),
    send: vi.fn(),
    t: (key: string) => key,
    cliName: () => cliId,
    emitReadyCodexTurns: vi.fn(),
    redriveRejectedStructuredReady: vi.fn(),
  };
  scope.structuredMissingFinalTarget = loadWorkerFunction('structuredMissingFinalTarget', scope);
  scope.notifyMissingFinalTurn = loadWorkerFunction('notifyMissingFinalTurn', scope);
  const settle = loadWorkerFunction<() => void>('maybeSettleMissingStructuredFinal', scope);
  return { scope, queue, settle, advance: (ms: number) => { now += ms; } };
}

afterEach(() => vi.restoreAllMocks());

describe('worker: missing structured final timeout', () => {
  it.each(['codex', 'doubao', 'coco'])('retires the same idle started head for %s with a Web-terminal notice', cliId => {
    const r = workerRig(cliId);
    vi.spyOn(Date, 'now').mockImplementation(() => 0);
    r.settle();
    vi.spyOn(Date, 'now').mockImplementation(() => 19_999);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.send).not.toHaveBeenCalled();
    vi.spyOn(Date, 'now').mockImplementation(() => 20_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
    expect(r.scope.send.mock.calls.map(([msg]) => msg)).toEqual([{
      type: 'user_notify', message: 'worker.structured_final_not_collected',
      kind: 'structured_turn_not_collected', turnId: 'om_turn',
    }]);
    expect(r.scope.retireStructuredTurnAttribution).toHaveBeenCalledOnce();
    expect(r.scope.emitReadyCodexTurns).toHaveBeenCalledOnce();
    expect(r.scope.redriveRejectedStructuredReady).toHaveBeenCalledOnce();
  });

  it('uses an ambiguous exact-attempt terminal for durable delivery without a duplicate IM notice', () => {
    const r = workerRig('codex', { attempt: 2 });
    vi.spyOn(Date, 'now').mockReturnValue(0);
    r.settle();
    vi.spyOn(Date, 'now').mockReturnValue(20_000);
    r.settle();
    expect(r.scope.emitTurnTerminal.mock.calls).toEqual([['om_turn', 'ambiguous', 'structured_final_not_collected', 2]]);
    expect(r.scope.send).not.toHaveBeenCalled();
  });

  it('does not run in send mode, after stop, or after a native final', () => {
    const send = workerRig('codex', { delivery: 'send' });
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    send.settle();
    expect(send.queue.peek()).toHaveLength(1);

    const stopped = workerRig('doubao');
    vi.spyOn(Date, 'now').mockReturnValue(0);
    stopped.settle();
    expect(stopped.queue.dropPendingTurn('om_turn', undefined, true)).not.toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    stopped.settle();
    expect(stopped.scope.send).not.toHaveBeenCalled();

    const finished = workerRig('doubao');
    vi.spyOn(Date, 'now').mockReturnValue(0);
    finished.settle();
    finished.queue.ingest([{ uuid: 'native-final', timestampMs: 5_000, kind: 'assistant_final', text: 'done' }]);
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    finished.settle();
    expect(finished.queue.peek()[0]?.finalText).toBe('done');
    expect(finished.scope.send).not.toHaveBeenCalled();
  });

  it('keeps the owner and retries a fresh window when the deadline drain fails', () => {
    const r = workerRig('codex', { attempt: 2 });
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    r.settle();
    r.scope.codexBridgeIngest.mockImplementationOnce(() => { throw new Error('transient transcript read failure'); });
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.emitTurnTerminal).not.toHaveBeenCalled();
    expect(r.scope.send).not.toHaveBeenCalled();

    // The failed drain is not a negative terminal verdict. A later tick starts
    // a new full wait; only a successful drain lets the same owner retire.
    clock.mockReturnValue(20_001);
    r.settle();
    clock.mockReturnValue(39_999);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    clock.mockReturnValue(40_001);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
    expect(r.scope.emitTurnTerminal.mock.calls).toEqual([['om_turn', 'ambiguous', 'structured_final_not_collected', 2]]);
  });

  it('resets the wait on output and supports a lifecycle-blocked rejected idle edge', () => {
    const r = workerRig('codex');
    r.scope.isPromptReady = false;
    r.scope.hasStructuredLifecycleBlock = () => true;
    r.scope.structuredRejectedReadyEvidenceGeneration = r.scope.ptyOutputGeneration.snapshot();
    vi.spyOn(Date, 'now').mockReturnValue(0);
    r.settle();
    expect(r.scope.structuredMissingFinalTarget()).toBeDefined();

    // New output invalidates that rejected idle edge and the old deadline.
    r.scope.ptyOutputGeneration.observe();
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.structuredMissingFinalTarget()).toBeUndefined();

    // A fresh idle edge for the same started owner gets its own full window.
    r.scope.structuredRejectedReadyEvidenceGeneration = r.scope.ptyOutputGeneration.snapshot();
    r.settle();
    vi.spyOn(Date, 'now').mockReturnValue(119_999);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    vi.spyOn(Date, 'now').mockReturnValue(120_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
  });
});
