import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createTraexAdapter, traexPreemptionComposerReady } from '../src/adapters/cli/traex.js';
import { ActiveTurnAuthority, sameTrustedPrincipal } from '../src/core/active-turn-authority.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { traexRestoredComposerReady, traexComposerHoldsInput } from '../src/adapters/cli/traex-footer.js';
import { inputForcesSerialTurn, pendingInputAllowsTypeAhead } from '../src/utils/pending-input-queue.js';
import { shouldWriteNow } from '../src/utils/input-gate.js';

const busy = readFileSync(new URL('./fixtures/session-rename/traex-0.216.0-renamed-while-busy.txt', import.meta.url), 'utf8');
const caller = { senderType: 'user' as const, requestUserOpenId: 'owner', requestLarkAppId: 'app' };
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
  const preempt = loadWorkerFunction('preemptActiveTurnForNewMessage', scope);
  return { scope, target, preempt };
}
describe('ordinary TraeX new-message preemption', () => {
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
    Object.assign(submission.scope, { lastInitConfig: { cliId: 'traex' },
      traexPreemptionHoldsWrites: () => true, armTraexPreemptionPoll: vi.fn() });
    await submission.flush();
    expect(submission.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
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
    expect(h.target.sendSpecialKeys).toHaveBeenLastCalledWith('C-u');
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
});
