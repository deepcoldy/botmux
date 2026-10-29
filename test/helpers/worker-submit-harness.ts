import { vi } from 'vitest';
import { CodexBridgeQueue } from '../../src/services/codex-bridge-queue.js';
import { InputDeliveryEvidenceTracker } from '../../src/services/input-delivery-evidence.js';
import { createSubmitFailureChainController } from '../../src/services/submit-failure-chain.js';
import { combineSubmitCurrentFences, settleDeferredSubmitConfirmation } from '../../src/services/submit-confirmation.js';
import { buildSubmitMessagePreview } from '../../src/services/submit-notification.js';
import { CodexAppFlushPromptReplay } from '../../src/utils/codex-app-turn-liveness.js';
import { loadWorkerFunction } from './worker-function-harness.js';

/** Run the actual pending-input caller and deferred confirmation callback;
 * control only CLI I/O, readiness, and unrelated worker services. */
export function workerSubmitHarness() {
  const queue = new CodexBridgeQueue();
  const inputDeliveryEvidence = new InputDeliveryEvidenceTracker();
  const submitFailureChains = createSubmitFailureChainController();
  const pendingMessages = [{ turnId: 'delivery', dispatchAttempt: 1, content: 'payload' }];
  const recheck = vi.fn(async () => false);
  const settlements: Awaited<ReturnType<typeof settleDeferredSubmitConfirmation>>[] = [];
  const scope: Record<string, any> = {
    backend: {}, cliAdapter: { reliableTurnTerminal: true, writeInput: vi.fn(async () => ({ submitted: false, recheck })) },
    lastInitConfig: { cliId: 'traex' }, cliSpawnGeneration: 7,
    cliRestartInProgress: false, isPromptReady: true, isFlushing: false,
    codexModelMigrationCheckNeeded: () => false,
    idleDetector: { isStartupPending: () => false },
    shouldHoldCodexRunnerInput: () => false,
    currentInputDeliveryQuarantine: () => null,
    hasPendingInputForFlush: () => pendingMessages.length > 0,
    resetTraexAutoModelBeforePendingTurn: () => false,
    sessionRenameInFlight: () => false,
    shouldDeferUserFlush: () => false,
    refreshHookReviewInputHold: vi.fn(),
    pendingInputMayFlush: () => true,
    rpcLifecycleFailClosedOwners: new Map(),
    probeStartupBlocker: () => false,
    readyGate: { shouldHold: () => false, isArmed: false },
    codexBridgeFallbackActive: () => true,
    runtimePtyInputPolicy: () => ({ supportsTypeAhead: true, allowBackToBackWrites: true }),
    pendingInputAllowsTypeAhead: () => true,
    directRpcTurnBlocksTypeAhead: () => false,
    activeTurnBlocks: () => false,
    pendingSessionRename: null, pendingMessages, pendingRawInputs: [], pendingAdoptMessages: [], pendingInjections: [],
    CodexAppFlushPromptReplay, codexAppTurnLiveness: {},
    beginCliWriteCycle: vi.fn(), bareShellChecked: true,
    firstWriteMayProceed: () => true, hasRunStartupCommands: true,
    traexAutoModelRuntimeEligible: () => false,
    freshnessInputQueue: { takeNormal: () => pendingMessages.shift() },
    attachDeferredPluginSkillCatalog: vi.fn(), applyMojoLivePatch: vi.fn(),
    usageLimitTracker: { currentTurn: () => 1, beginTurn: () => 1, detectedThisTurn: () => false },
    syncQueuedTurnsFromMarkerDisk: vi.fn(), readSendMarkers: () => [], queuedTypeAheadTurns: [],
    setCaptureIdentity: vi.fn(), markActiveTurnStarted: vi.fn(),
    inflightInputs: { onWrite: vi.fn(), forget: vi.fn(), retire: vi.fn() },
    noteCliInputWritten: vi.fn(), writeCliPidMarker: vi.fn(), publishSandboxRelayCapability: vi.fn(),
    currentUsageLimitSnapshot: () => ({}), codexBridgeQueue: queue,
    codexBridgeMarkPendingTurn: (content: string, turnId: string, dispatchAttempt: number, atMs: number) => {
      queue.mark(turnId, content, atMs, dispatchAttempt);
      return turnId;
    },
    markTurnExecutionStart: (turnId: string, dispatchAttempt: number) => inputDeliveryEvidence.start({
      turnId, dispatchAttempt, cliGeneration: scope.cliSpawnGeneration,
    }),
    isCodexAppCliId: () => false,
    runAmbiguousSubmissionTransaction: async (_backend: unknown, write: () => Promise<unknown>,
      _accepted: unknown, prepare: () => void) => { prepare(); return { result: await write() }; },
    adapterInputHandle: (backend: unknown) => backend,
    settleVerifiableSubmissionForJournal: vi.fn(),
    armInputDeliveryQuarantine: vi.fn(() => null),
    redriveRejectedStructuredReady: vi.fn(), observeQueuedActivationReceipt: vi.fn(),
    inputDeliveryEvidence, submitFailureChains, SUBMIT_DEFERRED_RECHECK_MS: 20_000,
    SUBMIT_DEFERRED_RECHECK_MAX_ATTEMPTS: 2, unscopedSubmitFailureChainSequence: 0,
    combineSubmitCurrentFences,
    settleDeferredSubmitConfirmation: async (...args: Parameters<typeof settleDeferredSubmitConfirmation>) => {
      const settlement = await settleDeferredSubmitConfirmation(...args);
      settlements.push(settlement);
      return settlement;
    },
    submitActivityEvidenceSince: () => 'pty-output',
    releaseInputDeliveryQuarantine: vi.fn(),
    deferNativeCodexInputCommit: () => false,
    queuePostSubmitNativeSessionTitle: vi.fn(), persistCliSessionId: vi.fn(),
    syncFreshCodexNativeSessionTitle: vi.fn(async () => {}),
    log: vi.fn(), send: vi.fn(), t: (key: string) => key,
    buildSubmitMessagePreview,
    cliName: () => 'TraeX',
    // Any unrelated failure path is observable instead of silently swallowed.
    SubmissionWriteError: class extends Error {},
    emitTurnTerminal: vi.fn(),
    shouldStopPendingBatch: () => true,
  };
  const schedule = loadWorkerFunction('scheduleSubmitFailureNotify', scope);
  scope.scheduleSubmitFailureNotify = schedule;
  const flush = loadWorkerFunction<() => Promise<void>>('flushPending', scope);
  return { scope, queue, flush, schedule, recheck, settlements, submitFailureChains, inputDeliveryEvidence };
}
