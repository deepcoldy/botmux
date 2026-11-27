import { vi } from 'vitest';
import { CodexBridgeQueue } from '../../src/services/codex-bridge-queue.js';
import { InputDeliveryEvidenceTracker } from '../../src/services/input-delivery-evidence.js';
import { createSubmitFailureChainController } from '../../src/services/submit-failure-chain.js';
import { createQueuedActivationReceiptObserver } from '../../src/services/queued-activation-receipts.js';
import { combineSubmitCurrentFences, decideSubmitConfirmationAction, settleDeferredSubmitConfirmation } from '../../src/services/submit-confirmation.js';
import { screenMayShowCredential } from '../../src/core/cli-startup-blocker.js';
import { buildSubmitMessagePreview } from '../../src/services/submit-notification.js';
import { diagnoseSubmitFailure } from '../../src/services/submit-failure-diagnosis.js';
import { CodexAppFlushPromptReplay } from '../../src/utils/codex-app-turn-liveness.js';
import { CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS } from '../../src/utils/codex-app-control.js';
import { loadWorkerFunction } from './worker-function-harness.js';

/** Run the actual pending-input caller and deferred confirmation callback;
 * control only CLI I/O, readiness, and unrelated worker services. */
export function workerSubmitHarness() {
  const queue = new CodexBridgeQueue();
  const inputDeliveryEvidence = new InputDeliveryEvidenceTracker();
  const submitFailureChains = createSubmitFailureChainController();
  const queuedActivationReceipts = createQueuedActivationReceiptObserver(20_000);
  const pendingMessages = [{ turnId: 'delivery', dispatchAttempt: 1, content: 'payload' }];
  const recheck = vi.fn(async () => false);
  const settlements: Awaited<ReturnType<typeof settleDeferredSubmitConfirmation>>[] = [];
  const scope: Record<string, any> = {
    sessionId: 'test-session',
    backend: {}, cliAdapter: { reliableTurnTerminal: true, writeInput: vi.fn(async () => ({ submitted: false, recheck })) },
    lastInitConfig: { cliId: 'traex' }, cliSpawnGeneration: 7, cliGenerationTurnWrites: 0,
    FIRST_PROMPT_HARD_TIMEOUT_MS: CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS,
    cliRestartInProgress: false, isPromptReady: true, isFlushing: false,
    codexModelMigrationCheckNeeded: () => false,
    idleDetector: { isStartupPending: () => false, programStatusHeldWorking: () => false, programStatusHeldBusy: () => false, adoptPromptReady: vi.fn() },
    shouldHoldCodexRunnerInput: () => false,
    currentInputDeliveryQuarantine: () => null,
    hasPendingInputForFlush: () => pendingMessages.length > 0,
    resetTraexAutoModelBeforePendingTurn: () => false,
    sessionRenameInFlight: () => false,
    shouldDeferUserFlush: () => false,
    refreshHookReviewInputHold: vi.fn(),
    hookReviewHoldsQueuedWrite: () => false,
    pendingInputMayFlush: () => true,
    rpcLifecycleFailClosedOwners: new Map(),
    probeStartupBlocker: () => false,
    readyGate: { shouldHold: () => false, isArmed: false },
    codexBridgeFallbackActive: () => true,
    runtimePtyInputPolicy: () => ({ supportsTypeAhead: true, allowBackToBackWrites: true }),
    pendingInputAllowsTypeAhead: () => true,
    directRpcTurnBlocksTypeAhead: () => false,
    programStatusBlockedHoldsTypeAhead: () => false,
    activeTurnBlocks: () => false,
    promotePendingHumanInterruption: () => false,
    pendingSessionRename: null, pendingMessages, pendingRawInputs: [], pendingAdoptMessages: [], pendingInjections: [],
    CodexAppFlushPromptReplay, codexAppTurnLiveness: {},
    beginCliWriteCycle: vi.fn(), bareShellChecked: true,
    firstWriteMayProceed: () => true, hasRunStartupCommands: true,
    traexAutoModelRuntimeEligible: () => false,
    freshnessInputQueue: { takeNormal: () => pendingMessages.shift() },
    attachDeferredPluginSkillCatalog: vi.fn(), applyMojoLivePatch: vi.fn(),
    usageLimitTracker: { currentTurn: () => 1, beginTurn: () => 1, detectedThisTurn: () => false },
    syncQueuedTurnsFromMarkerDisk: vi.fn(), readSendMarkers: () => [], queuedTypeAheadTurns: [],
    retiredTurnIds: new Set<string>(),
    turnTerminalEmitted: () => false,
    setCaptureIdentity: vi.fn(), markActiveTurnStarted: vi.fn(),
    inflightInputs: { onWrite: vi.fn(), forget: vi.fn(), retire: vi.fn() },
    noteCliInputWritten: vi.fn(), writeCliPidMarker: vi.fn(), publishSandboxRelayCapability: vi.fn(),
    currentUsageLimitSnapshot: () => ({}), codexBridgeQueue: queue,
    bridgeQueue: { peek: () => [] },
    codexBridgeMarkPendingTurn: (
      content: string,
      turnId: string,
      dispatchAttempt: number,
      atMs: number,
      _linkRefMode?: 'observe' | 'enabled',
      submittedMessage?: string,
    ) => {
      queue.mark(turnId, content, atMs, dispatchAttempt, undefined, undefined, false, submittedMessage);
      return turnId;
    },
    markTurnExecutionStart: (
      turnId: string,
      dispatchAttempt: number,
      opts?: { evidenceAlreadyStarted?: boolean },
    ) => {
      if (!opts?.evidenceAlreadyStarted) {
        inputDeliveryEvidence.start({
          turnId, dispatchAttempt, cliGeneration: scope.cliSpawnGeneration,
        });
      }
    },
    isCodexAppCliId: () => false,
    runAmbiguousSubmissionTransaction: async (_backend: unknown, write: () => Promise<unknown>,
      _accepted: unknown, prepare: () => void) => { prepare?.(); return { result: await write() }; },
    adapterInputHandle: (backend: unknown) => backend,
    settleVerifiableSubmissionForJournal: vi.fn(),
    armInputDeliveryQuarantine: vi.fn(() => null),
    redriveRejectedStructuredReady: vi.fn(),
    queuedActivationReceipts,
    expireHeldInputBeforeReceivedTurn: vi.fn(),
    inputDeliveryEvidence, submitFailureChains, SUBMIT_DEFERRED_RECHECK_MS: 20_000,
    screenMayShowCredential, diagnoseSubmitFailure,
    SUBMIT_DEFERRED_RECHECK_MAX_ATTEMPTS: 2, unscopedSubmitFailureChainSequence: 0,
    combineSubmitCurrentFences,
    decideSubmitConfirmationAction,
    settleDeferredSubmitConfirmation: async (...args: Parameters<typeof settleDeferredSubmitConfirmation>) => {
      const settlement = await settleDeferredSubmitConfirmation(...args);
      settlements.push(settlement);
      return settlement;
    },
    submitActivityEvidenceSince: () => 'pty-output',
    releaseInputDeliveryQuarantine: vi.fn(),
    deferNativeCodexInputCommit: () => false,
    deferTurnInputCommitUntilSubmission: () => false,
    queuePostSubmitNativeSessionTitle: vi.fn(), persistCliSessionId: vi.fn(),
    maybeQueuePostSubmitNativeSessionTitle: vi.fn(),
    syncFreshCodexNativeSessionTitle: vi.fn(async () => {}),
    projectedRuntimeScreenStatus: () => (scope.isPromptReady ? 'idle' : 'working'),
    publishScreenStatus: vi.fn(),
    log: vi.fn(), send: vi.fn(), t: (key: string) => key,
    buildSubmitMessagePreview,
    cliName: () => 'TraeX',
    // Any unrelated failure path is observable instead of silently swallowed.
    SubmissionWriteError: class extends Error {
      constructor(
        message: string,
        readonly recoveryFailureReason?: string,
        readonly submissionStarted = true,
        readonly runnerGenerationUnsafe = false,
        readonly traexCatalogAdmissionRequired = false,
        readonly retainPendingInput = false,
      ) { super(message); }
    },
    emitTurnTerminal: vi.fn(),
    shouldStopPendingBatch: () => true,
  };
  scope.nativeSessionForkPending = loadWorkerFunction('nativeSessionForkPending', scope);
  scope.restoreSessionRenameReadiness = loadWorkerFunction('restoreSessionRenameReadiness', scope);
  scope.screenShowsCredentialPage = loadWorkerFunction('screenShowsCredentialPage', scope);
  // Real write-edge transport fold: a no-op unless an item carries a parked
  // TraeX RPC catalog and no RPC engine will write it.
  scope.inlineParkedTraexSkillCatalog = loadWorkerFunction('inlineParkedTraexSkillCatalog', scope);
  const schedule = loadWorkerFunction('scheduleSubmitFailureNotify', scope);
  scope.scheduleSubmitFailureNotify = schedule;
  // Real predicates for flushPending's native-consumption proof (traex harness →
  // no Codex history proof); markReplyInputConsumed is a no-op on the empty queue.
  scope.codexHistoryMatchProvesConsumption = loadWorkerFunction('codexHistoryMatchProvesConsumption', scope);
  scope.ownedSubmitConsumptionProofKind = loadWorkerFunction('ownedSubmitConsumptionProofKind', scope);
  scope.markReplyInputConsumed = loadWorkerFunction('markReplyInputConsumed', scope);
  scope.acknowledgeQueuedActivationToken = loadWorkerFunction('acknowledgeQueuedActivationToken', scope);
  scope.acknowledgeQueuedActivation = loadWorkerFunction('acknowledgeQueuedActivation', scope);
  scope.probeAuthoritativeQueuedActivationEvidence = loadWorkerFunction('probeAuthoritativeQueuedActivationEvidence', scope);
  scope.observeQueuedActivationReceipt = vi.fn(loadWorkerFunction('observeQueuedActivationReceipt', scope));
  scope.observeUnconfirmedQueuedActivation = vi.fn(loadWorkerFunction('observeUnconfirmedQueuedActivation', scope));
  const flush = loadWorkerFunction<() => Promise<void>>('flushPending', scope);
  scope.flushPending = flush;
  return { scope, queue, flush, schedule, recheck, settlements, submitFailureChains, inputDeliveryEvidence, queuedActivationReceipts };
}
