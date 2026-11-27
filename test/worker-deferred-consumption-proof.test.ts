import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { submitTuiTextInput } from '../src/utils/tui-input-delivery.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

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
    deferredConsumptionProofProbes: new WeakSet(),
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

  it('deduplicates ordinary and deferred owners of the same probe closure', () => {
    const { scope, watch } = harness();
    const prove = vi.fn(() => undefined);
    watch('om_turn', 1, 'antigravity_transcript_user_input', prove);
    watch('om_turn', 1, 'antigravity_transcript_user_input', prove);
    vi.advanceTimersByTime(600);
    expect(prove).toHaveBeenCalledTimes(1);
  });

  it('binds a late-discovered Antigravity conversation before its receipt', () => {
    const { scope, watch } = harness();
    let proven: { cliSessionId?: string } | undefined;
    const prove = vi.fn(() => proven);
    scope.cliAdapter = {};
    scope.shouldPreserveAntigravitySubmittedTurn = vi.fn(() => true);
    scope.applyAuthoritativeAntigravitySessionId = vi.fn();
    watch('om_turn', 1, 'antigravity_transcript_user_input', prove);
    vi.advanceTimersByTime(600);
    proven = { cliSessionId: 'native-late' };
    vi.advanceTimersByTime(1_000);
    expect(scope.applyAuthoritativeAntigravitySessionId).toHaveBeenCalledWith(
      'native-late', { preserveLiveTurn: true });
    expect(scope.applyAuthoritativeAntigravitySessionId.mock.invocationCallOrder[0])
      .toBeLessThan(scope.acknowledgeNativeInputConsumed.mock.invocationCallOrder[0]);
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

  it('settles the detached generation on CLI respawn or close', () => {
    for (const stop of ['respawn', 'close'] as const) {
      const { scope, watch } = harness();
      const prove = vi.fn(() => undefined);
      const settle = vi.fn();
      watch('om_turn', undefined, 'antigravity_transcript_user_input', prove, settle);
      vi.advanceTimersByTime(600);
      if (stop === 'respawn') scope.cliSpawnGeneration += 1;
      if (stop === 'close') scope.closeRequested = true;
      vi.advanceTimersByTime(10_000);
      expect(settle).toHaveBeenCalledTimes(1);
      const probes = prove.mock.calls.length;
      vi.advanceTimersByTime(60_000);
      expect(prove.mock.calls.length).toBe(probes);
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

  it('keeps an entry fail-closed when no turn id can safely settle it', () => {
    const { scope, watch } = harness();
    const prove = vi.fn(() => undefined);
    const settle = vi.fn();
    watch(undefined, undefined, 'antigravity_transcript_user_input', prove, settle);
    expect(settle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(prove).not.toHaveBeenCalled();
    expect(scope.acknowledgeNativeInputConsumed).not.toHaveBeenCalled();
  });

  it('starts ordinary consumption proof even before history confirms the submit', async () => {
    const h = workerSubmitHarness();
    const proveConsumed = vi.fn(() => undefined);
    const settleConsumed = vi.fn();
    h.scope.ownedSubmitConsumptionProofKind = () => 'antigravity_transcript_user_input';
    h.scope.cliAdapter.writeInput = vi.fn(async () => ({
      submitted: false, recheck: async () => false, proveConsumed, settleConsumed,
    }));
    await h.flush();
    expect(h.scope.watchDeferredConsumptionProof.mock.calls).toEqual([[
      'delivery', 1, 'antigravity_transcript_user_input', proveConsumed, settleConsumed,
    ]]);
  });

  it('hands TUI text answer proofs to the watcher on accepted and unconfirmed results', async () => {
    const proveConsumed = vi.fn(() => undefined);
    const settleConsumed = vi.fn();
    const watch = vi.fn();
    const backend = { write: vi.fn(() => true), sendSpecialKeys: vi.fn(() => true) };
    let forkPending = false;
    const scope: Record<string, any> = {
      backend,
      cliAdapter: {
        writeInput: vi.fn(async () => ({
          submitted: true as const, cliSessionId: 'native-1', proveConsumed, settleConsumed,
        })),
      },
      nativeSessionForkPending: () => forkPending,
      cliLifetimeNonce: 1, cliSpawnGeneration: 1,
      log: vi.fn(), logError: vi.fn(), KEY_TO_ANSI: {},
      strictInputHandle: (value: unknown) => value,
      readinessTrackedInput: (value: unknown) => value,
      submitTuiTextInput: (options: any) => submitTuiTextInput({ ...options, pause: async () => {} }),
      runAmbiguousSubmissionTransaction: async (
        _target: unknown,
        write: () => Promise<unknown>,
        _accepted: unknown,
        beforeWrite?: () => void,
      ) => {
        beforeWrite?.();
        return { result: await write() };
      },
      invalidatePromptReadinessEvidence: vi.fn(),
      currentBotmuxTurnId: 'om_tui', currentBotmuxDispatchAttempt: 2,
      ownedSubmitConsumptionProofKind: () => 'antigravity_transcript_user_input',
      watchDeferredConsumptionProof: watch,
      tuiPromptBlocking: false, isPromptReady: false,
      revokePromptReadiness: vi.fn(), idleDetector: { reset: vi.fn() },
    };
    const handle = loadWorkerFunction<(keys: string[], text: string) => Promise<boolean>>(
      'handleTuiTextInput', scope);
    expect(await handle(['Enter'], 'answer')).toBe(true);
    expect(watch.mock.calls).toEqual([[
      'om_tui', 2, 'antigravity_transcript_user_input', proveConsumed, settleConsumed,
    ]]);

    // This path has no scheduleSubmitFailureNotify owner. An unconfirmed write
    // must therefore retain its own terminal settlement instead of orphaning.
    watch.mockClear();
    scope.cliAdapter.writeInput.mockResolvedValue({
      submitted: false, recheck: () => false, proveConsumed, settleConsumed,
    });
    expect(await handle(['Enter'], 'answer again')).toBe(false);
    expect(watch.mock.calls).toEqual([[
      'om_tui', 2, 'antigravity_transcript_user_input', proveConsumed, settleConsumed,
    ]]);

    // The current turn may advance while the adapter write is in flight. Proof
    // must stay with the turn that displayed this prompt, not its successor.
    watch.mockClear();
    scope.cliAdapter.writeInput.mockImplementation(async () => {
      scope.currentBotmuxTurnId = 'om_next';
      scope.currentBotmuxDispatchAttempt = 99;
      return { submitted: true, cliSessionId: 'native-1', proveConsumed, settleConsumed };
    });
    expect(await handle(['Enter'], 'original answer')).toBe(true);
    expect(watch.mock.calls).toEqual([[
      'om_tui', 2, 'antigravity_transcript_user_input', proveConsumed, settleConsumed,
    ]]);

    // A generation replacement during Enter detaches the old adapter. Do not
    // let its late proof register under the replacement generation.
    watch.mockClear();
    settleConsumed.mockClear();
    scope.cliAdapter.writeInput.mockImplementation(async () => {
      scope.cliSpawnGeneration = 2;
      return { submitted: true, cliSessionId: 'native-1', proveConsumed, settleConsumed };
    });
    expect(await handle(['Enter'], 'detached answer')).toBe(false);
    expect(watch).not.toHaveBeenCalled();
    expect(settleConsumed).toHaveBeenCalledTimes(1);

    // Likewise, a fork boundary after a submitted result must settle rather
    // than leaving an unowned entry behind just because submitted was true.
    watch.mockClear();
    settleConsumed.mockClear();
    scope.cliSpawnGeneration = 1;
    scope.cliAdapter.writeInput.mockImplementation(async () => {
      forkPending = true;
      return { submitted: true, cliSessionId: 'native-1', proveConsumed, settleConsumed };
    });
    expect(await handle(['Enter'], 'forked answer')).toBe(false);
    expect(watch).not.toHaveBeenCalled();
    expect(settleConsumed).toHaveBeenCalledTimes(1);
  });
});
