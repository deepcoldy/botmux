import { afterEach, expect, it, vi } from 'vitest';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

afterEach(() => { vi.useRealTimers(); });

it.each([false, true])('a passthrough queues behind an opening whose input box has not settled (settled: %s)', async settled => {
  const queued = !settled;
  const enqueueRaw = vi.fn();
  const deliverRawInput = vi.fn(async () => {});
  const scope: Record<string, unknown> = {
    unattendedRawInputRefusal: () => undefined, discardDeploymentContinuation: () => {}, log: () => {},
    hookReviewAdmissionScreen: () => '', refreshHookReviewInputHold: () => {}, hookReviewInputHold: false,
    firstWriteLivenessConfirmed: true, openingInputBoxSettled: settled,
    pendingMessages: [{ turnId: 'om_opening', content: 'opening' }],
    startupCommandsInProgress: false, startupCommandAckHold: null, nativeSessionForkPending: () => false,
    cliRestartInProgress: false, rawInputRestartGate: null, sessionRenameInFlight: () => false,
    shouldHoldCodexRunnerInput: () => false, codexRunnerFreshness: undefined, injectionFlushing: false,
    shouldDeferUserFlush: () => false, pendingInjections: [], bareShellCheckInProgress: false,
    bareShellLaunchBlocked: false, lastInitConfig: { cliId: 'codex' }, isFlushing: true,
    codexModelMigrationHoldsRawInput: () => false, currentBotmuxTurnId: undefined,
    freshnessInputQueue: { enqueueRaw }, deliverRawInput, flushPending: vi.fn(async () => {}),
  };
  const msg = { type: 'raw_input', content: '/status', turnId: 'om_status' };
  await loadWorkerMessageHandler('raw_input', scope)(msg);
  expect(enqueueRaw.mock.calls).toEqual(queued ? [[msg]] : []);
  expect(deliverRawInput.mock.calls).toEqual(queued ? [] : [[msg]]);
});

it.each([false, true])('dequeues the opening after its input box settles only on the same CLI (replaced: %s)', async replaced => {
  const h = workerSubmitHarness();
  const settleInputBox = vi.fn(async () => {
    if (replaced) {
      h.scope.backend = {};
      h.scope.cliSpawnGeneration += 1;
    }
    return undefined;
  });
  Object.assign(h.scope.cliAdapter, { settleInputBox });
  Object.assign(h.scope, { openingInputBoxSettled: false, inputBoxJudgeable: () => true, holdOpeningInput: vi.fn() });
  await h.flush();
  expect(settleInputBox).toHaveBeenCalledOnce();
  expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(replaced ? 0 : 1);
  expect(h.scope.pendingMessages).toHaveLength(replaced ? 1 : 0);
  expect(h.scope.openingInputBoxSettled).toBe(!replaced);
  expect(h.scope.holdOpeningInput).not.toHaveBeenCalled();
});

it.each([true, false])('a first write held past the hard cap keeps a slow re-check and one notice only while input is queued (queued: %s)', async queued => {
  vi.useFakeTimers();
  const scope: Record<string, any> = {
    firstWriteLivenessTimer: null, backend: {}, cliSpawnGeneration: 3, firstWriteLivenessConfirmed: false,
    hasPendingInputForFlush: () => queued, hasRunStartupCommands: true,
    FIRST_PROMPT_HARD_TIMEOUT_MS: 90_000, firstWriteSpawnedAtMs: Date.now() - 90_000,
    FIRST_WRITE_LIVENESS_POLL_MS: 250, FIRST_WRITE_HELD_POLL_MS: 5_000,
    adapterInputBoxReady: vi.fn(() => false), notifyFirstWriteHeldPastHardCap: vi.fn(), flushPending: vi.fn(),
  };
  loadWorkerFunction<() => void>('armFirstWriteLivenessRecheck', scope)();
  await vi.advanceTimersByTimeAsync(250);
  expect(scope.notifyFirstWriteHeldPastHardCap).toHaveBeenCalledTimes(queued ? 1 : 0);
  await vi.advanceTimersByTimeAsync(4_900);
  expect(scope.adapterInputBoxReady).toHaveBeenCalledTimes(queued ? 1 : 0);
  await vi.advanceTimersByTimeAsync(200);
  expect(scope.adapterInputBoxReady).toHaveBeenCalledTimes(queued ? 2 : 0);
  expect(scope.firstWriteLivenessTimer === null).toBe(!queued);
  expect(scope.flushPending).not.toHaveBeenCalled();
});
