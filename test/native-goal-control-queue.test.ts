import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { CodexRunnerFreshnessInputQueue } from '../src/services/codex-runner-freshness.js';

function fixture() {
  const queue = new CodexRunnerFreshnessInputQueue(() => 'current', () => {});
  const no = () => false;
  const delivered: string[] = [];
  const scope: any = {
    freshnessInputQueue: queue, pendingRawInputs: queue.raw, pendingMessages: [], pendingAdoptMessages: [], pendingInjections: [],
    unattendedRawInputRefusal: no, discardDeploymentContinuation() {}, hookReviewAdmissionScreen: no, refreshHookReviewInputHold() {},
    firstWriteLivenessConfirmed: true, openingInputBoxSettled: true, startupCommandsInProgress: false, startupCommandAckHold: null,
    nativeSessionForkPending: no, cliRestartInProgress: false, rawInputRestartGate: false, sessionRenameInFlight: no,
    shouldHoldCodexRunnerInput: no, injectionFlushing: false, shouldDeferUserFlush: no, bareShellCheckInProgress: false,
    bareShellLaunchBlocked: false, hookReviewInputHold: false, codexModelMigrationHoldsRawInput: no, isFlushing: true, log() {},
    deliverRawInput: async (message: any) => { delivered.push(message.content); }, backend: {}, cliAdapter: {},
    codexModelMigrationCheckNeeded: no, idleDetector: undefined, initialInputOwnershipPending: false, isCodexAppCliId: no,
    ambiguousSubmissionRecoveryHold: null, remoteRunnerRecoveredTurnInFlight: false, currentInputDeliveryQuarantine: no,
    hasPendingInputForFlush: () => queue.raw.length > 0, resetTraexAutoModelBeforePendingTurn: no, commandLineWritesPending: 0,
    hookReviewHoldsQueuedWrite: no, pendingInputMayFlush: () => true, durableTurnInFlight: false, rpcLifecycleFailClosedOwners: new Set(),
    probeStartupBlocker: no, readyGate: { shouldHold: no }, isSettlingFirstFlush: false, awaitingPostSessionStartPromptEvidence: false,
    bridgeJsonlPath: null, lastInitConfig: { cliId: 'traex' }, codexBridgeFallbackActive: no,
    runtimePtyInputPolicy: () => ({ supportsTypeAhead: true, allowBackToBackWrites: true }), promotePendingHumanInterruption: no,
    pendingInputAllowsTypeAhead: () => true, directRpcTurnBlocksTypeAhead: no, programStatusBlockedHoldsTypeAhead: no, activeTurnBlocks: no,
    isPromptReady: false, pendingSessionRename: null, effectiveBackendType: 'pty',
    CodexAppFlushPromptReplay: class { consumeAfterFlush() { return false; } }, bareShellChecked: true,
    firstWriteMayProceed: () => true, hasRunStartupCommands: true, cliSubmissionInFlight: null, codexAppTurnLiveness: {}, detectBareShellLaunch: no,
  };
  const handler = loadWorkerMessageHandler('raw_input', scope);
  const flush = loadWorkerFunction('flushPending', scope);
  scope.flushPending = flush;
  return { queue, scope, handler, flush, delivered };
}
const pause = { type: 'raw_input', content: '/goal pause', nativeGoalControl: true };
describe('native goal controls deferred by another input write', () => {
  it('drains a pause after the business write while the goal is still busy', async () => {
    const { scope, handler, flush, delivered, queue } = fixture();
    await handler(pause);
    expect(delivered).toEqual([]);
    scope.isFlushing = false;
    await flush();
    expect(delivered).toEqual(['/goal pause']);
    expect(queue.raw).toHaveLength(0);
    expect(scope.isPromptReady).toBe(false);
  });
  it.each(['first-write', 'menu', 'restart', 'rename'])('retains %s holds without a microtask retry loop', async gate => {
    const { scope, flush, delivered, queue } = fixture();
    scope.isFlushing = false;
    scope.queueMicrotask = vi.fn();
    queue.enqueueRaw(pause);
    if (gate === 'first-write') { scope.firstWriteMayProceed = () => false; scope.inputBoxJudgeable = () => false; }
    if (gate === 'menu') scope.hookReviewHoldsQueuedWrite = () => true;
    if (gate === 'restart') scope.cliRestartInProgress = true;
    if (gate === 'rename') scope.sessionRenameInFlight = () => true;
    await flush(); await flush();
    expect(delivered).toEqual([]);
    expect(queue.raw).toHaveLength(1);
    expect(scope.queueMicrotask).not.toHaveBeenCalled();
  });
  it('drains multiple busy controls once in order', async () => {
    const { scope, flush, delivered, queue } = fixture();
    scope.isFlushing = false;
    queue.enqueueRaw(pause);
    queue.enqueueRaw({ ...pause, content: '/goal resume' });
    await flush();
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(delivered).toEqual(['/goal pause', '/goal resume']);
    expect(queue.raw).toHaveLength(0);
  });
});
