import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

/** The real worker watcher, with a controllable clock and the turn/CLI state
 * it reads. It must send exactly one receipt on proof, and on the turn's
 * terminal release the probe instead (so an unproven input cannot later claim
 * an identical newer input's record). */
function harness() {
  const scope: Record<string, any> = {
    cliSpawnGeneration: 3,
    closeRequested: false,
    lastInitConfig: { cliId: 'antigravity', cliSessionId: 'native-1' },
    terminal: false,
    turnTerminalEmitted: () => scope.terminal,
    acknowledgeNativeInputConsumed: vi.fn(),
    scaleMs: (ms: number) => ms,
    DEFERRED_CONSUMPTION_PROOF_WINDOW_MS: 60_000,
    DEFERRED_CONSUMPTION_PROOF_MIN_POLL_MS: 500,
    DEFERRED_CONSUMPTION_PROOF_MAX_POLL_MS: 5_000,
  };
  const watch = loadWorkerFunction<(
    turnId: string | undefined, dispatchAttempt: number | undefined, kind: string,
    prove: () => { cliSessionId?: string } | undefined, settle?: () => void,
  ) => void>('watchDeferredConsumptionProof', scope);
  return { scope, watch };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('deferred native consumption proof watcher', () => {
  it('acknowledges once when the probe proves, with the original dispatch attempt', () => {
    const { scope, watch } = harness();
    let proven: { cliSessionId?: string } | undefined;
    const prove = vi.fn(() => proven);
    watch('om_turn', 2, 'antigravity_transcript_user_input', prove);
    vi.advanceTimersByTime(1_600);
    expect(scope.acknowledgeNativeInputConsumed).not.toHaveBeenCalled();
    proven = { cliSessionId: 'native-1' };
    vi.advanceTimersByTime(10_000);
    expect(scope.acknowledgeNativeInputConsumed.mock.calls).toEqual([
      ['om_turn', 'antigravity_transcript_user_input', 'native-1', undefined, 2],
    ]);
    vi.advanceTimersByTime(60_000);
    expect(scope.acknowledgeNativeInputConsumed).toHaveBeenCalledTimes(1);
  });

  it('settles the probe and stops at the turn terminal without a receipt', () => {
    const { scope, watch } = harness();
    const prove = vi.fn(() => undefined);
    const settle = vi.fn();
    watch('om_turn', 1, 'antigravity_transcript_user_input', prove, settle);
    vi.advanceTimersByTime(600);
    scope.terminal = true;
    vi.advanceTimersByTime(5_000);
    expect(settle).toHaveBeenCalledTimes(1);
    const probes = prove.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(prove.mock.calls.length).toBe(probes);
    expect(scope.acknowledgeNativeInputConsumed).not.toHaveBeenCalled();
  });

  it('stops without settling on a CLI respawn or close', () => {
    for (const stop of ['respawn', 'close'] as const) {
      const { scope, watch } = harness();
      const prove = vi.fn(() => undefined);
      const settle = vi.fn();
      watch('om_turn', undefined, 'antigravity_transcript_user_input', prove, settle);
      vi.advanceTimersByTime(600);
      if (stop === 'respawn') scope.cliSpawnGeneration += 1;
      if (stop === 'close') scope.closeRequested = true;
      vi.advanceTimersByTime(10_000);
      scope.terminal = true;
      vi.advanceTimersByTime(60_000);
      expect(settle).not.toHaveBeenCalled();
      expect(scope.acknowledgeNativeInputConsumed).not.toHaveBeenCalled();
    }
  });

  it('stops probing at the end of its window but still settles at the later terminal', () => {
    const { scope, watch } = harness();
    const prove = vi.fn(() => undefined);
    const settle = vi.fn();
    watch('om_turn', undefined, 'antigravity_transcript_user_input', prove, settle);
    vi.advanceTimersByTime(120_000);
    const probes = prove.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(prove.mock.calls.length).toBe(probes);
    expect(settle).not.toHaveBeenCalled();
    scope.terminal = true;
    vi.advanceTimersByTime(10_000);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(scope.acknowledgeNativeInputConsumed).not.toHaveBeenCalled();
  });

  it('keeps the consumption probe across the ZMX journal\'s deferred recheck', async () => {
    const proveConsumed = () => undefined;
    const settleConsumed = () => {};
    const scope: Record<string, any> = { SUBMIT_DEFERRED_RECHECK_MS: 1_000, log: vi.fn() };
    const settleJournal = loadWorkerFunction<(result: any) => Promise<boolean>>('settleVerifiableSubmissionForJournal', scope);
    const result: any = { submitted: false, recheck: () => ({ submitted: true, cliSessionId: 'cid', proveConsumed, settleConsumed }) };
    const settled = settleJournal(result);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled).toBe(true);
    expect(result).toMatchObject({ submitted: true, cliSessionId: 'cid', proveConsumed, settleConsumed });
  });
});
