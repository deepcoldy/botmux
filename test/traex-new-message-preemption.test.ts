import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createTraexAdapter, traexPreemptionComposerReady } from '../src/adapters/cli/traex.js';
import { ActiveTurnAuthority, sameTrustedPrincipal } from '../src/core/active-turn-authority.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { traexRestoredComposerReady, traexComposerHoldsInput } from '../src/adapters/cli/traex-footer.js';
import { inputForcesSerialTurn, pendingInputAllowsTypeAhead } from '../src/utils/pending-input-queue.js';
import { shouldWriteNow } from '../src/utils/input-gate.js';
import { shouldAllowTypeAheadOnReattach } from '../src/services/queued-activation-reconcile.js';
import { decideQueuedReadyTransition } from '../src/core/queued-ready-transition.js';
import { isStructuredBridgeLifecycleBlockingCli } from '../src/services/structured-bridge-clis.js';
import { TurnExecutionClock } from '../src/services/turn-execution-clock.js';
import { detectCliStartupBlocker } from '../src/core/cli-startup-blocker.js';

const busy = readFileSync(new URL('./fixtures/session-rename/traex-0.216.0-renamed-while-busy.txt', import.meta.url), 'utf8');
const caller = { senderType: 'user' as const, requestUserOpenId: 'owner', requestLarkAppId: 'app' };
const trustDialog = [
  'Folder access', '/fixture', 'Do you trust the contents of this directory?',
  '❯ 1. Yes, continue', '  2. No, quit', '  enter continue  |  esc quit',
].join('\n');
function harness() {
  const authority = new ActiveTurnAuthority();
  authority.reserve({ turnId: 'om_old', caller }); authority.markStarted({ turnId: 'om_old', caller });
  const target = { captureInputState: () => ({ viewport: busy }), sendSpecialKeys: vi.fn(() => true) };
  const scope: Record<string, any> = {
    backend: target, cliAdapter: createTraexAdapter('/bin/true'), lastInitConfig: { cliId: 'traex' },
    effectiveBackendType: 'tmux', cliSpawnGeneration: 2, cliLifetimeNonce: 3, cliInterruptGeneration: 0,
    webTerminalInputGeneration: 0, isPromptReady: false, awaitingFirstPrompt: false,
    currentBotmuxTurnId: 'om_old', currentBotmuxDispatchAttempt: undefined, activeTurnAuthority: authority,
    sameTrustedPrincipal, pendingMessages: [{ turnId: 'om_new', content: 'correct current task', trustedCaller: caller }],
    pendingRawInputs: [], pendingInjections: [], pendingAdoptMessages: [], pendingSessionRename: null,
    currentTraexObservedPid: () => 123, sessionRenameNativeSessionIdNow: () => 'native-sid',
    findTraexRolloutSetByPid: () => new Set(['native-sid']),
    traexActiveNativeInput: () => undefined,
    codexBridgeQueue: { peek: () => [{ turnId: 'om_old', sourceTurnId: 'native-old', sourceSessionId: 'native-sid', started: true }] },
    captureBackendScreen: () => busy, backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    traexPreemptionComposerReady, traexRestoredComposerReady, cliSubmissionInFlight: undefined,
    traexComposerHoldsInput, recentSubmittedTurnTexts: new Map(),
    lastWrittenCliInput: { turnId: 'om_old', content: 'original task' }, invalidatePromptReadinessEvidence: vi.fn(),
    sessionRenameInFlight: () => false, hookReviewHoldsQueuedWrite: () => false,
    programStatusBlockedHoldsTypeAhead: () => false, currentInputDeliveryQuarantine: () => null,
    traexAutoModelRuntimeEligible: () => false, isWorkflowWorker: () => false,
    isFlushing: false, injectionFlushing: false, commandLineWritesPending: 0, durableTurnInFlight: false,
    cliRestartInProgress: false, rawInputRestartGate: false, fatalWorkerErrorPending: false,
    preemptedTurnId: undefined, preemptCooldownUntil: 0, PREEMPT_COOLDOWN_MS: 2000,
    traexPreemption: undefined, traexPreemptionTimer: undefined,
    runAfterAmbiguousSubmissionWrites: async (_b: unknown, f: () => unknown) => f(),
    revokePromptReadiness: vi.fn(() => { scope.isPromptReady = false; }), idleDetector: { reset: vi.fn() },
    log: vi.fn(), send: vi.fn(), cliName: () => 'TraeX', emitTurnTerminal: vi.fn(),
    inflightInputs: { retireTurn: vi.fn() }, retireStructuredTurnAttribution: vi.fn(),
    flushPending: vi.fn(async () => {}), armTraexPreemptionPoll: vi.fn(),
    sendTermActionOnce: (b: typeof target) => b.sendSpecialKeys('Escape'),
    drainReliableTerminalBeforeInterrupt: vi.fn(),
    markPromptReady: vi.fn(), codexBridgeDrainAndMaybeEmit: vi.fn(),
  };
  scope.traexPreemptionEligible = loadWorkerFunction('traexPreemptionEligible', scope);
  scope.traexPreemptionLeaseNow = loadWorkerFunction('traexPreemptionLeaseNow', scope);
  scope.traexPreemptionLeaseCurrent = loadWorkerFunction('traexPreemptionLeaseCurrent', scope);
  scope.preemptTraexForNewMessage = loadWorkerFunction('preemptTraexForNewMessage', scope);
  scope.resolveTraexPreemption = loadWorkerFunction('resolveTraexPreemption', scope);
  scope.observeTraexPreemptionTerminal = loadWorkerFunction('observeTraexPreemptionTerminal', scope);
  scope.clearTraexOwnedRestoredDraft = loadWorkerFunction('clearTraexOwnedRestoredDraft', scope);
  scope.traexPreemptionEmptyComposerReady = loadWorkerFunction('traexPreemptionEmptyComposerReady', scope);
  const preempt = loadWorkerFunction('preemptActiveTurnForNewMessage', scope);
  return { scope, target, preempt };
}

function trustHandler(h: ReturnType<typeof harness>) {
  Object.assign(h.scope, {
    trustHandled: false, TRUST_DIALOG_PATTERN: /Yes, I trust this folder|Yes, continue|Trust and continue/,
    dismissAidenCodexUpdateDialog: () => false, noticeCodexModelMigrationDialog: vi.fn(),
    detectCliStartupBlocker, stripAnsiScreenText: (text: string) => text,
    promptReadinessRevision: 0, closeRequested: false,
    pendingWebTerminalInput: () => false, webTerminalInputWireDirty: () => false,
    nativeSessionForkPending: () => false,
  });
  return loadWorkerFunction('handleVisibleStartupInteraction', h.scope);
}

describe('ordinary TraeX new-message preemption', () => {
  it('does not accept historical trust text while the native viewport is already working', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      expect(trustHandler(h)(trustDialog + '\n' + busy)).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(h.target.sendSpecialKeys).not.toHaveBeenCalled();
      expect(h.scope.trustHandled).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('accepts a still-current native trust dialog once after the startup delay', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.target.captureInputState = () => ({ viewport: trustDialog });
      const handle = trustHandler(h);
      expect(handle(trustDialog)).toBe(true);
      expect(handle(trustDialog)).toBe(false);
      await vi.advanceTimersByTimeAsync(399);
      expect(h.target.sendSpecialKeys).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.target.sendSpecialKeys).toHaveBeenCalledExactlyOnceWith('Enter');
    } finally { vi.useRealTimers(); }
  });

  it('expires a trust Enter when exact preemption restores the old request as a draft', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.target.captureInputState = () => ({ viewport: trustDialog });
      expect(trustHandler(h)(trustDialog)).toBe(true);
      h.target.captureInputState = () => ({ viewport: busy });
      h.preempt(h.scope.pendingMessages[0], h.target);
      await Promise.resolve(); await Promise.resolve();
      expect(h.target.sendSpecialKeys).toHaveBeenCalledExactlyOnceWith('Escape');
      h.scope.observeTraexPreemptionTerminal([{ kind: 'assistant_final', text: '',
        terminalStatus: 'ambiguous', terminalErrorCode: 'traex_turn_aborted:interrupted',
        sourceSessionId: 'native-sid', sourceTurnId: 'native-old' }]);
      h.target.captureInputState = () => ({ viewport: busy.replace(/^◆ Working[^\n]*\n/m, '')
        .replace('Run /review on my current changes', 'original task') });
      await vi.advanceTimersByTimeAsync(400);
      expect(h.target.sendSpecialKeys).toHaveBeenCalledExactlyOnceWith('Escape');
      expect(h.scope.pendingMessages).toHaveLength(1);
      expect(h.scope.emitTurnTerminal).toHaveBeenCalledExactlyOnceWith(
        'om_old', 'cancelled', 'preempted_by_user_message', undefined,
      );
    } finally { vi.useRealTimers(); }
  });

  it.each(['viewport draft', 'unreadable viewport', 'selected quit', 'backend', 'lifetime', 'generation',
    'interrupt', 'readiness', 'Web input', 'normal writer', 'injection writer', 'command writer', 'pending preemption'])
    ('never sends a stale trust Enter after %s takes the input surface', async state => {
      vi.useFakeTimers();
      try {
        const h = harness();
        h.target.captureInputState = () => ({ viewport: trustDialog });
        expect(trustHandler(h)(trustDialog)).toBe(true);
        if (state === 'viewport draft') h.target.captureInputState = () => ({ viewport: busy });
        if (state === 'unreadable viewport') h.target.captureInputState = () => { throw new Error('capture unavailable'); };
        if (state === 'selected quit') h.target.captureInputState = () => ({ viewport: trustDialog
          .replace('❯ 1. Yes, continue', '  1. Yes, continue').replace('  2. No, quit', '❯ 2. No, quit') });
        if (state === 'backend') h.scope.backend = {};
        if (state === 'lifetime') h.scope.cliLifetimeNonce++;
        if (state === 'generation') h.scope.cliSpawnGeneration++;
        if (state === 'interrupt') h.scope.cliInterruptGeneration++;
        if (state === 'readiness') h.scope.promptReadinessRevision++;
        if (state === 'Web input') h.scope.webTerminalInputGeneration++;
        if (state === 'normal writer') h.scope.cliSubmissionInFlight = { composerOwned: true };
        if (state === 'injection writer') h.scope.injectionFlushing = true;
        if (state === 'command writer') h.scope.commandLineWritesPending = 1;
        if (state === 'pending preemption') h.scope.traexPreemption = {};
        await vi.advanceTimersByTimeAsync(400);
        expect(h.target.sendSpecialKeys).not.toHaveBeenCalled();
        expect(h.scope.invalidatePromptReadinessEvidence).not.toHaveBeenCalled();
      } finally { vi.useRealTimers(); }
    });

  it('does not schedule a trust key while a pending preemption already owns the composer', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.target.captureInputState = () => ({ viewport: trustDialog });
      h.scope.traexPreemption = {};
      expect(trustHandler(h)(trustDialog)).toBe(false);
      await vi.advanceTimersByTimeAsync(400);
      expect(h.target.sendSpecialKeys).not.toHaveBeenCalled();
      expect(h.scope.trustHandled).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('interrupts before paste and keeps the old turn pending until native settlement', async () => {
    const h = harness();
    expect(h.preempt(h.scope.pendingMessages[0], h.target)).toBe(true);
    await vi.waitFor(() => expect(h.target.sendSpecialKeys).toHaveBeenCalledExactlyOnceWith('Escape'));
    expect(h.scope.traexPreemption).toBeDefined();
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toHaveLength(1);
  });

  it('holds a native task whose exact original request cannot be recovered without interrupting it', async () => {
    const h = harness();
    h.scope.lastWrittenCliInput = undefined;
    h.scope.recentSubmittedTurnTexts.clear();
    h.scope.traexActiveNativeInput = () => undefined;
    h.preempt(h.scope.pendingMessages[0], h.target);
    await Promise.resolve(); await Promise.resolve();
    expect(h.target.sendSpecialKeys).not.toHaveBeenCalled();
    expect(h.scope.flushPending).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toHaveLength(1);
    expect(h.scope.traexPreemption).toBeDefined();
  });

  it.each([
    ['foreign', { trustedCaller: { ...caller, requestUserOpenId: 'foreign' } }],
    ['bot', { trustedCaller: { ...caller, senderType: 'bot' } }],
    ['unknown caller', { trustedCaller: undefined }],
    ['schedule', { trustedCaller: { ...caller, source: 'schedule_creator' } }],
    ['durable', { dispatchAttempt: 1 }], ['FIFO', { queueAfterActiveTurn: true }],
    ['at-most-once', { noReplay: true }], ['continuation', { taskContinuation: {} }],
    ['auto recovery', { traexAutoModelRecovery: true }], ['restart', { restartNoteOriginalContent: 'old' }],
  ])('does not interrupt for %s traffic', (_name, patch) => {
    const h = harness();
    expect(h.preempt({ ...h.scope.pendingMessages[0], ...patch }, h.target)).toBe(false);
    expect(h.target.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it.each(['draft', 'permission', 'unknown', 'RPC', 'adopt', 'PID', 'generation'])('does not interrupt unsafe %s state', state => {
    const h = harness();
    if (state === 'draft') h.target.captureInputState = () => ({ viewport: busy.replace('Run /review on my current changes', 'unfinished draft') });
    if (state === 'permission') h.scope.programStatusBlockedHoldsTypeAhead = () => true;
    if (state === 'unknown') h.target.captureInputState = () => ({ viewport: '' });
    if (state === 'RPC') h.scope.codexRpcEngine = {};
    if (state === 'adopt') h.scope.lastInitConfig.adoptMode = true;
    if (state === 'PID') h.scope.findTraexRolloutSetByPid = () => undefined;
    if (state === 'generation') h.target.captureInputState = () => { h.scope.cliSpawnGeneration++; return { viewport: busy }; };
    h.preempt(h.scope.pendingMessages[0], h.target);
    expect(h.target.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('sends only one interrupt for a burst and retains both inputs until the exact abort and empty composer', async () => {
    const h = harness();
    h.preempt(h.scope.pendingMessages[0], h.target);
    await vi.waitFor(() => expect(h.target.sendSpecialKeys).toHaveBeenCalledOnce());
    h.scope.pendingMessages.push({ ...h.scope.pendingMessages[0], turnId: 'om_second' });
    expect(h.preempt(h.scope.pendingMessages[1], h.target)).toBe(true);
    expect(h.target.sendSpecialKeys).toHaveBeenCalledOnce();
    const abort = { kind: 'assistant_final', text: '', terminalStatus: 'ambiguous', terminalErrorCode: 'traex_turn_aborted:interrupted', sourceSessionId: 'native-sid', sourceTurnId: 'native-old' };
    h.scope.observeTraexPreemptionTerminal([{ ...abort, sourceTurnId: 'foreign' }]);
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
    h.scope.observeTraexPreemptionTerminal([abort]);
    expect(h.scope.emitTurnTerminal).toHaveBeenCalledWith('om_old', 'cancelled', 'preempted_by_user_message', undefined);
    expect(h.scope.inflightInputs.retireTurn).toHaveBeenCalledWith('om_old');
    h.target.captureInputState = () => ({ viewport: busy.replace(/^◆ Working[^\n]*\n/m, '') });
    await h.scope.resolveTraexPreemption();
    expect(h.scope.traexPreemption).toBeUndefined();
    expect(h.scope.flushPending).toHaveBeenCalledOnce();
    expect(h.scope.pendingMessages).toHaveLength(2);
  });

  it('rechecks the target after submission serialization before sending Escape', async () => {
    const h = harness();
    h.scope.runAfterAmbiguousSubmissionWrites = async (_b: unknown, action: () => unknown) => { h.scope.cliLifetimeNonce++; return action(); };
    h.preempt(h.scope.pendingMessages[0], h.target);
    await Promise.resolve(); await Promise.resolve();
    expect(h.target.sendSpecialKeys).not.toHaveBeenCalled();
    await h.scope.resolveTraexPreemption();
    expect(h.scope.traexPreemption).toBeUndefined();
  });

  it('reserves an intent during a prior write and interrupts only after that writer settles', async () => {
    const h = harness();
    h.scope.isFlushing = true;
    h.preempt(h.scope.pendingMessages[0], h.target);
    expect(h.target.sendSpecialKeys).not.toHaveBeenCalled();
    expect(h.scope.traexPreemption).toBeDefined();
    h.scope.isFlushing = false;
    await h.scope.resolveTraexPreemption();
    expect(h.target.sendSpecialKeys).toHaveBeenCalledExactlyOnceWith('Escape');
  });

  it('preserves a natural successful terminal that wins the interrupt race and still releases the pending input', async () => {
    const h = harness();
    h.preempt(h.scope.pendingMessages[0], h.target);
    await vi.waitFor(() => expect(h.target.sendSpecialKeys).toHaveBeenCalledOnce());
    h.scope.codexBridgeQueue.peek = () => [{ turnId: 'om_old', sourceTurnId: 'native-old', finalText: 'already done', terminalStatus: 'completed' }];
    h.scope.observeTraexPreemptionTerminal([{ kind: 'assistant_final', text: 'already done', sourceSessionId: 'native-sid', sourceTurnId: 'native-old', terminalStatus: 'completed' }]);
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
    h.target.captureInputState = () => ({ viewport: busy.replace(/^◆ Working[^\n]*\n/m, '') });
    await h.scope.resolveTraexPreemption();
    expect(h.scope.traexPreemption).toBeUndefined();
    expect(h.scope.flushPending).toHaveBeenCalledOnce();
  });

  it('keeps an unconfirmed Escape to one attempt and reports bounded recovery instead of resending', async () => {
    const h = harness();
    h.target.sendSpecialKeys.mockReturnValue(false);
    h.preempt(h.scope.pendingMessages[0], h.target);
    await vi.waitFor(() => expect(h.target.sendSpecialKeys).toHaveBeenCalledOnce());
    h.scope.traexPreemption.requestedAt = Date.now() - 11_000;
    await h.scope.resolveTraexPreemption();
    await h.scope.resolveTraexPreemption();
    expect(h.target.sendSpecialKeys).toHaveBeenCalledOnce();
    expect(h.scope.send).toHaveBeenCalledOnce();
    expect(h.scope.traexPreemption).toBeDefined();
    expect(h.scope.pendingMessages).toHaveLength(1);
  });

  it('the real arrival enqueues before interrupt and holds the real flush while cancellation is pending', async () => {
    const h = harness();
    const submission = workerSubmitHarness();
    Object.assign(h.scope, {
      initPromptMaterialized: true, rememberTurnLinkRefMode: vi.fn(), inputForcesSerialTurn,
      runtimePtyInputPolicy: () => ({ supportsTypeAhead: true, allowBackToBackWrites: true }),
      reattachOpenTurnGate: true, shouldAllowTypeAheadOnReattach,
      pendingInputAllowsTypeAhead, directRpcTurnBlocksTypeAhead: () => false, activeTurnBlocks: () => false,
      traexAutoModelRuntimeEligible: () => false, shouldWriteNow, idleDetector: { isStartupComplete: () => true, reset: vi.fn() },
      shouldHoldCodexRunnerInput: () => false,
      freshnessInputQueue: { enqueueNormal: (item: unknown) => h.scope.pendingMessages.push(item) },
      traexPreemptionHoldsWrites: loadWorkerFunction('traexPreemptionHoldsWrites', h.scope),
      preemptActiveTurnForNewMessage: h.preempt,
    });
    h.scope.pendingMessages.length = 0;
    const order: string[] = [];
    h.target.sendSpecialKeys.mockImplementation(() => { order.push(h.scope.pendingMessages[0]?.turnId); return true; });
    const arrival = loadWorkerFunction('sendToPty', h.scope);
    arrival('correction', 'om_new', { trustedCaller: caller });
    await vi.waitFor(() => expect(order).toEqual(['om_new']));
    expect(h.scope.flushPending).not.toHaveBeenCalled();
    expect(h.scope.reattachOpenTurnGate).toBe(true);
    Object.assign(submission.scope, { lastInitConfig: { cliId: 'traex' },
      traexPreemptionHoldsWrites: () => true, armTraexPreemptionPoll: vi.fn() });
    await submission.flush();
    expect(submission.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
  });

  it('releases the reattach gate through real prompt readiness only after exact abort and an empty composer', async () => {
    const h = harness();
    const submission = workerSubmitHarness();
    const idle = busy.replace(/^◆ Working[^\n]*\n/m, '');
    submission.queue.mark('om_old', 'original task', Date.now());
    submission.queue.ingest([{ kind: 'user', text: 'original task', uuid: 'old-input',
      sourceSessionId: 'native-sid', sourceTurnId: 'native-old', timestampMs: Date.now() }]);
    Object.assign(h.scope, {
      reattachOpenTurnGate: true, shouldAllowTypeAheadOnReattach,
      codexBridgeQueue: submission.queue, isStructuredBridgeLifecycleBlockingCli,
      rpcTurnsAwaitingActivation: new Map(), rpcLifecycleFailClosedOwners: new Map(),
      rpcTerminalHydrationOwners: new Map(), turnExecutionClock: new TurnExecutionClock(),
      retiredTurnIds: new Set(),
      workerSessionEventScope: undefined,
      traexNativeStartupInputIsPending: () => false, traexFirstPromptViewportRejects: () => false,
      currentPostTerminalInputFence: () => false, probeStartupBlocker: () => false,
      holdForNativeSessionFork: () => false, stopBusyPatternIdleProbe: vi.fn(),
      stopStructuredStartGraceRecheck: vi.fn(),
      readyGate: { shouldHold: () => false }, freshnessInputQueue: { onPromptReady: () => 'continue' },
      spawnArgvTurnStartGateHolds: () => false,
      releaseInterruptedStructuredBridgeOnFirstPrompt: vi.fn(),
      ptyOutputGeneration: { snapshot: () => 1 }, queuedTypeAheadTurns: [], decideQueuedReadyTransition,
      releaseActiveTurnAuthority: (_reason: string, identity: any) => {
        if (identity) h.scope.activeTurnAuthority.releaseExact(identity);
      },
      setCaptureIdentity: (turnId?: string, attempt?: number) => {
        h.scope.currentBotmuxTurnId = turnId; h.scope.currentBotmuxDispatchAttempt = attempt;
      },
      writeCliPidMarker: vi.fn(), judgeClaudeBridgeTurn: vi.fn(),
      bridgeQueue: { cliQueueDrained: vi.fn() }, settleSessionRenameOnPrompt: vi.fn(),
      syncQueuedTurnsFromMarkerDisk: () => false, stuckDetector: null,
      maybeEmitWorkflowTranscriptOutput: vi.fn(),
      refreshBackgroundWait: vi.fn(), settleRestartAttemptOnReady: vi.fn(),
      shouldFlushInjectionsFirst: () => false,
      idleDetector: { isStartupPending: () => false, reset: vi.fn(), adoptPromptReady: vi.fn() },
    });
    h.scope.inflightInputs.onTurnComplete = vi.fn();
    h.scope.hasStructuredLifecycleBlock = loadWorkerFunction('hasStructuredLifecycleBlock', h.scope);
    h.scope.markTurnRetired = loadWorkerFunction('markTurnRetired', h.scope);
    h.scope.retireStructuredTurnAttribution = loadWorkerFunction('retireStructuredTurnAttribution', h.scope);
    h.scope.releaseRawInputRestartGate = loadWorkerFunction('releaseRawInputRestartGate', h.scope);
    h.scope.markPromptReady = loadWorkerFunction('markPromptReady', h.scope);
    h.scope.flushPending = vi.fn(async () => {
      Object.assign(submission.scope, {
        pendingMessages: h.scope.pendingMessages, lastInitConfig: { cliId: 'traex' },
        reattachOpenTurnGate: h.scope.reattachOpenTurnGate, shouldAllowTypeAheadOnReattach,
        pendingInputAllowsTypeAhead, isPromptReady: h.scope.isPromptReady,
        traexPreemptionHoldsWrites: () => !!h.scope.traexPreemption,
      });
      submission.scope.freshnessInputQueue.takeNormal = () => h.scope.pendingMessages.shift();
      submission.scope.cliAdapter.writeInput.mockResolvedValue({ submitted: true });
      await submission.flush();
    });
    h.preempt(h.scope.pendingMessages[0], h.target);
    await vi.waitFor(() => expect(h.target.sendSpecialKeys).toHaveBeenCalledOnce());
    h.scope.markPromptReady();
    expect(h.scope.reattachOpenTurnGate).toBe(true);
    expect(h.scope.isPromptReady).toBe(false);
    expect(submission.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    const aborted = { kind: 'assistant_final' as const, text: '',
      uuid: 'old-abort', timestampMs: Date.now(),
      terminalStatus: 'ambiguous', terminalErrorCode: 'traex_turn_aborted:interrupted',
      sourceSessionId: 'native-sid', sourceTurnId: 'native-old' };
    submission.queue.ingest([aborted]);
    h.scope.observeTraexPreemptionTerminal([aborted]);
    expect(h.scope.hasStructuredLifecycleBlock()).toBe(false);
    expect(h.scope.activeTurnAuthority.snapshot()).toBeUndefined();
    expect(h.scope.reattachOpenTurnGate).toBe(true);
    h.target.captureInputState = () => ({ viewport: idle });
    await h.scope.resolveTraexPreemption();
    expect(h.scope.traexPreemption).toBeUndefined();
    expect(h.scope.reattachOpenTurnGate).toBe(false);
    await vi.waitFor(() => expect(submission.scope.cliAdapter.writeInput).toHaveBeenCalledOnce());
    expect(h.scope.pendingMessages).toHaveLength(0);
    expect(h.scope.emitTurnTerminal).toHaveBeenCalledExactlyOnceWith(
      'om_old', 'cancelled', 'preempted_by_user_message', undefined,
    );
    expect(h.scope.send.mock.calls.map(([event]) => event).filter(event => event.type === 'prompt_ready')).toHaveLength(1);
  });

  it('observes the exact abort after the real TraeX bridge ingestion and before final emission', async () => {
    const h = harness();
    h.preempt(h.scope.pendingMessages[0], h.target);
    await vi.waitFor(() => expect(h.target.sendSpecialKeys).toHaveBeenCalledOnce());
    const order: string[] = [];
    const events = [{ kind: 'assistant_final', text: '', terminalStatus: 'ambiguous', terminalErrorCode: 'traex_turn_aborted:interrupted', sourceSessionId: 'native-sid', sourceTurnId: 'native-old' }];
    Object.assign(h.scope, {
      rpcTranscriptIngestBlockedByAwaitingActivation: () => false, rpcTurnsAwaitingActivation: new Map(),
      structuredBridgeIs: (id: string) => id === 'traex', codexBridgeRolloutPath: '/fixture/rollout.jsonl',
      codexBridgeBaselineDone: true, codexBridgeOffset: 0, codexBridgePendingSessionId: undefined,
      structuredBridgeIngestPath: () => ({ events, newOffset: 100, pendingTail: '' }),
      bridgeSpecFor: () => undefined, publishActiveRuntime: vi.fn(), publishedActiveRuntime: {},
      OrcaBackend: class {}, observeStructuredBackgroundTasks: vi.fn(),
      noteSpawnArgvTurnStartTranscriptEvidence: vi.fn(), pruneExpiredStructuredHeadsAndEmit: vi.fn(),
      emitReadyCodexTurns: () => order.push('finals'), deferFinalIdleSignal: vi.fn(),
      idleDetector: { fireIdle: vi.fn() },
    });
    h.scope.codexBridgeQueue.ingest = () => order.push('ingest');
    h.scope.emitTurnTerminal = () => order.push('cancel');
    loadWorkerFunction('codexBridgeIngest', h.scope)({ signalIdle: false });
    expect(order).toEqual(['ingest', 'cancel', 'finals']);
    expect(h.scope.traexPreemption.settled).toBe(true);
  });

  it('clears only the restored exact cancelled prompt before admitting the replacement', async () => {
    const h = harness();
    h.preempt(h.scope.pendingMessages[0], h.target);
    await vi.waitFor(() => expect(h.target.sendSpecialKeys).toHaveBeenCalledOnce());
    h.scope.traexPreemption.settled = true;
    const idle = busy.replace(/^◆ Working[^\n]*\n/m, '');
    h.target.captureInputState = () => ({ viewport: idle.replace('Run /review on my current changes', 'original task') });
    await h.scope.resolveTraexPreemption();
    expect(h.target.sendSpecialKeys).toHaveBeenLastCalledWith('C-c');
    expect(h.scope.flushPending).not.toHaveBeenCalled();
    h.target.captureInputState = () => ({ viewport: idle });
    await h.scope.resolveTraexPreemption();
    expect(h.scope.flushPending).toHaveBeenCalledOnce();
    expect(h.scope.pendingMessages[0].content).toContain('original task');
    expect(h.scope.pendingMessages[0].content).toContain('correct current task');
    expect(h.scope.pendingMessages[0].logicalContent).toBe('correct current task');
    expect(h.scope.pendingMessages[0].content).toContain('do not repeat completed actions');
  });

  it.each(['user changed draft', 'original task extra', '[Pasted Content 13 chars]'])('never clears an unproven %s draft after cancellation', async draft => {
    const h = harness();
    h.preempt(h.scope.pendingMessages[0], h.target);
    await vi.waitFor(() => expect(h.target.sendSpecialKeys).toHaveBeenCalledOnce());
    h.scope.traexPreemption.settled = true;
    h.target.captureInputState = () => ({ viewport: busy.replace(/^◆ Working[^\n]*\n/m, '').replace('Run /review on my current changes', draft) });
    await h.scope.resolveTraexPreemption();
    expect(h.target.sendSpecialKeys).toHaveBeenCalledOnce();
    expect(h.scope.flushPending).not.toHaveBeenCalled();
  });

  it('verifies a long restored draft at a larger native grid, clears once, restores the grid and waits out quit confirmation', async () => {
    const h = harness();
    const old = 'original task line\n'.repeat(172);
    h.scope.lastWrittenCliInput.content = old;
    h.preempt(h.scope.pendingMessages[0], h.target);
    await vi.waitFor(() => expect(h.target.sendSpecialKeys).toHaveBeenCalledOnce());
    h.scope.traexPreemption.settled = true;
    let size = { cols: 160, rows: 50 };
    let cleared = false;
    const idle = busy.replace(/^◆ Working[^\n]*\n/m, '');
    Object.assign(h.target, {
      getPaneSize: () => size, resize: vi.fn((cols: number, rows: number) => { size = { cols, rows }; }),
      captureInputState: () => ({ viewport: cleared ? idle.replace('← for agents', '← for agents · ctrl+c again to quit')
        : idle.replace('Run /review on my current changes', size.rows > 100 ? old : 'original task line') }),
    });
    h.target.sendSpecialKeys.mockImplementation((key: string) => { if (key === 'C-c') cleared = true; return true; });
    const verifying = h.scope.resolveTraexPreemption();
    await h.scope.resolveTraexPreemption(); // no second concurrent resize/clear
    await verifying;
    expect(h.target.resize.mock.calls).toHaveLength(2);
    expect(h.target.resize.mock.calls[0][1]).toBeGreaterThan(100);
    expect(size).toEqual({ cols: 160, rows: 50 });
    expect(h.target.sendSpecialKeys.mock.calls.filter(([key]) => key === 'C-c')).toHaveLength(1);
    await h.scope.resolveTraexPreemption();
    expect(h.scope.flushPending).not.toHaveBeenCalled();
    expect(h.target.sendSpecialKeys.mock.calls.filter(([key]) => key === 'C-c')).toHaveLength(1);
    h.target.captureInputState = () => ({ viewport: idle });
    await h.scope.resolveTraexPreemption();
    expect(h.scope.flushPending).toHaveBeenCalledOnce();
  });

  it('keeps a changed Web input draft and current geometry while full-draft verification awaits', async () => {
    const h = harness();
    h.scope.lastWrittenCliInput.content = 'long old input\n'.repeat(72);
    h.preempt(h.scope.pendingMessages[0], h.target);
    await vi.waitFor(() => expect(h.target.sendSpecialKeys).toHaveBeenCalledOnce());
    h.scope.traexPreemption.settled = true;
    let size = { cols: 160, rows: 50 };
    Object.assign(h.target, {
      getPaneSize: () => size,
      resize: vi.fn((cols: number, rows: number) => { size = { cols, rows }; }),
      captureInputState: () => ({ viewport: busy.replace(/^◆ Working[^\n]*\n/m, '').replace('Run /review on my current changes', 'foreign user draft') }),
    });
    const verifying = h.scope.resolveTraexPreemption();
    h.scope.webTerminalInputGeneration++;
    size = { cols: 120, rows: 80 };
    await verifying;
    expect(h.target.sendSpecialKeys).toHaveBeenCalledOnce();
    expect(size).toEqual({ cols: 120, rows: 80 });
    expect(h.target.resize.mock.calls).toHaveLength(1);
  });

  it('holds an oversized or unresolved long draft with one bounded notice and no clear', async () => {
    const h = harness();
    h.scope.lastWrittenCliInput.content = 'old line\n'.repeat(3000);
    h.preempt(h.scope.pendingMessages[0], h.target);
    await vi.waitFor(() => expect(h.target.sendSpecialKeys).toHaveBeenCalledOnce());
    h.scope.traexPreemption.settled = true;
    const resize = vi.fn();
    Object.assign(h.target, { getPaneSize: () => ({ cols: 160, rows: 50 }), resize,
      captureInputState: () => ({ viewport: busy.replace(/^◆ Working[^\n]*\n/m, '').replace('Run /review on my current changes', 'old line') }) });
    await h.scope.resolveTraexPreemption();
    expect(resize).not.toHaveBeenCalled();
    expect(h.target.sendSpecialKeys).toHaveBeenCalledOnce();
    h.scope.traexPreemption.requestedAt = Date.now() - 11_000;
    await h.scope.resolveTraexPreemption(); await h.scope.resolveTraexPreemption();
    expect(h.scope.send).toHaveBeenCalledOnce();
    expect(h.scope.flushPending).not.toHaveBeenCalled();
  });
});
