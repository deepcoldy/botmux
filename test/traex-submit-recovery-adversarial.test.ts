import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { traexComposerHoldsInput } from '../src/adapters/cli/traex-footer.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { InputDeliveryEvidenceTracker } from '../src/services/input-delivery-evidence.js';
import { createSubmitFailureChainController } from '../src/services/submit-failure-chain.js';
import { combineSubmitCurrentFences, settleDeferredSubmitConfirmation } from '../src/services/submit-confirmation.js';
import { buildSubmitMessagePreview } from '../src/services/submit-notification.js';
import { claudeComposerHoldsInput, decideSessionStartGatedSubmitWarning, diagnoseBackendSubmitFailure,
  shouldWaitThroughBusyTurn } from '../src/services/submit-failure-diagnosis.js';
import { loadWorkerMessageHandler, loadWorkerFunction } from './helpers/worker-function-harness.js';
import { classifyStuckPage } from '../src/utils/stuck-detector.js';

const content = '查询大盘状态';
const composer = (body: string) => `Earlier conversation\n─────────────────────────\n❯ ${body}\n  GPT-6-Astra xhigh · Context 99% left\n  ? for shortcuts`;
const chains = new Set<ReturnType<typeof createSubmitFailureChainController>>();

afterEach(() => {
  for (const chain of chains) chain.clear();
  chains.clear();
  vi.useRealTimers();
});

function fixture(options: { acceptsRescue?: boolean; screen?: string; dispatchAttempt?: number } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(100);
  let screen = options.screen ?? composer(`[Pasted Content ${Array.from(content).length} chars]`);
  let received = false;
  const backend = {
    write: vi.fn(),
    captureViewportAsync: vi.fn(async () => screen),
    sendSpecialKeys: vi.fn(() => {
      if (options.acceptsRescue !== false) received = true;
      return true;
    }),
  };
  const queue = new CodexBridgeQueue(() => Date.now());
  queue.mark('delivery', content, Date.now(), options.dispatchAttempt);
  queue.beginSubmitVerification('delivery', undefined, options.dispatchAttempt);
  const evidence = new InputDeliveryEvidenceTracker();
  evidence.start({ turnId: 'delivery', dispatchAttempt: options.dispatchAttempt, cliGeneration: 1 }, Date.now(), 1, 0);
  const chain = createSubmitFailureChainController();
  chains.add(chain);
  // A successful receipt from this pane carries the owned rollout session id;
  // an unattributed same-text line (sibling pane) is modeled separately and
  // must not release the parked-draft quarantine.
  const recheck = vi.fn(() => received ? { submitted: true as const, cliSessionId: 'owned-session' } : false);
  const scope: Record<string, any> = {
    backend, cliAdapter: createTraexAdapter(), cliSpawnGeneration: 1,
    cliRestartInProgress: false, lastInitConfig: { cliId: 'traex' },
    webTerminalInputGeneration: 1, cliInterruptGeneration: 0, cliLifetimeNonce: 'lifetime',
    inputDeliveryQuarantine: null, inputDeliveryEvidence: evidence, codexBridgeQueue: queue,
    submitFailureChains: chain, combineSubmitCurrentFences, settleDeferredSubmitConfirmation,
    usageLimitTracker: { currentTurn: () => 1, detectedThisTurn: () => false },
    submitActivityEvidenceSince: () => 'pty-output', readyGate: { isArmed: false },
    SUBMIT_DEFERRED_RECHECK_MS: 20_000, SUBMIT_DEFERRED_RECHECK_MAX_ATTEMPTS: 2,
    FIRST_PROMPT_HARD_TIMEOUT_MS: 90_000,
    SUBMIT_DIAG_BUSY_SILENCE_MAX_EXTRA: 12, SUBMIT_DIAG_ACTIVE_SILENCE_MAX_EXTRA: 3,
    unscopedSubmitFailureChainSequence: 0, effectiveBackendType: 'tmux', lastPtyActivityAtMs: 0,
    captureBackendScreen: () => screen, backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    traexComposerHoldsInput, diagnoseBackendSubmitFailure, shouldWaitThroughBusyTurn,
    claudeComposerHoldsInput, decideSessionStartGatedSubmitWarning,
    busyProbeRegion: (text: string) => text,
    idleDetector: { fireIdle: vi.fn(), programStatusHeldWorking: () => false },
    adapterInputHandle: (target: unknown) => target,
    dropFailedBridgeMark: vi.fn((id: string, attempt?: number) => queue.dropPendingTurn(id, attempt)),
    redriveRejectedStructuredReady: vi.fn(), deferNativeCodexInputCommit: () => false,
    queuePostSubmitNativeSessionTitle: vi.fn(), persistCliSessionId: vi.fn(),
    codexBridgeFallbackActive: () => false, syncFreshCodexNativeSessionTitle: vi.fn(),
    codexHistoryMatchProvesConsumption: () => false,
    buildSubmitMessagePreview, cliName: () => 'TRAE', currentBotmuxTurnId: 'delivery',
    emitTurnTerminal: vi.fn(), send: vi.fn(), log: vi.fn(), t: (key: string) => key,
    shareableStuckScreenTail: () => '', classifyStuckPage,
    isPromptReady: false, flushPending: vi.fn(),
  };
  scope.currentInputDeliveryQuarantine = loadWorkerFunction('currentInputDeliveryQuarantine', scope);
  scope.releaseInputDeliveryQuarantine = loadWorkerFunction('releaseInputDeliveryQuarantine', scope);
  scope.traexQuestionCapture = loadWorkerFunction('traexQuestionCapture', scope);
  scope.submitUnconfirmedNotice = loadWorkerFunction('submitUnconfirmedNotice', scope);
  const arm = loadWorkerFunction('armInputDeliveryQuarantine', scope);
  const quarantine = arm(backend, { turnId: 'delivery', dispatchAttempt: options.dispatchAttempt }, content);
  const schedule = loadWorkerFunction('scheduleSubmitFailureNotify', scope);
  const onConfirmed = () => scope.releaseInputDeliveryQuarantine(quarantine, 'receipt', { redriveTerminal: true });
  const start = () => schedule(content, recheck, 'rollout', 'delivery', undefined, 1,
    { turnId: 'delivery', dispatchAttempt: options.dispatchAttempt }, 'failed', true, onConfirmed);
  scope.armQuarantine = arm;
  return { backend, queue, scope, chain, recheck, start,
    setScreen: (value: string) => { screen = value; },
    accept: () => { received = true; },
    warnings: () => scope.send.mock.calls.filter(([message]: any[]) => message.type === 'user_notify'),
  };
}

describe('TRAE recovery adversarial interleavings', () => {
  it.each(['receipt-wait', 'fresh-capture', 'final-receipt'] as const)('honors card stop during %s even if the original draft remains', async phase => {
    const h = fixture({ acceptsRescue: false });
    Object.assign(h.scope, {
      cliInterruptGeneration: 0, nativeSessionForkPending: () => false,
      traexQuotaPending: null, traexAutoModelController: null,
      codexCliEffortOperation: null, tmuxScrolledHalfPages: 0,
      isRemoteBackendType: () => false, isCriticalInterruptKey: (key: string) => key === 'ctrlc' || key === 'esc',
      runAfterAmbiguousSubmissionWrites: async (_target: unknown, write: () => unknown) => write(),
      sendCriticalControlKey: async (_key: unknown, write: () => unknown) => write(),
      TMUX_KEY_MAP: { ctrlc: 'C-c', esc: 'Escape', enter: 'Enter' }, PTY_SEQ_MAP: {},
      invalidatePromptReadinessEvidence: vi.fn(), retireDoubaoBridgeTurnOnInterrupt: vi.fn(),
      currentBotmuxDispatchAttempt: undefined, tuiPromptBlocking: false,
      scheduleOneShotAfterAction: vi.fn(),
    });
    h.scope.sendTermActionOnce = loadWorkerFunction('sendTermActionOnce', h.scope);
    h.scope.handleTermAction = loadWorkerFunction('handleTermAction', h.scope);
    const action = loadWorkerMessageHandler('term_action', h.scope);
    h.start();
    if (phase === 'receipt-wait') {
      await vi.advanceTimersByTimeAsync(20_000);
      await action({ type: 'term_action', key: 'ctrlc' });
    } else if (phase === 'fresh-capture') {
      h.backend.captureViewportAsync.mockImplementation(async () => {
        await action({ type: 'term_action', key: 'ctrlc' });
        return composer(content);
      });
    } else {
      h.recheck.mockImplementation(async () => {
        if (h.recheck.mock.calls.length === 3) await action({ type: 'term_action', key: 'ctrlc' });
        return false;
      });
    }
    await vi.advanceTimersByTimeAsync(80_000);
    expect(h.backend.sendSpecialKeys).toHaveBeenCalledWith('C-c');
    expect(h.scope.cliInterruptGeneration).toBe(1);
    expect(h.backend.sendSpecialKeys.mock.calls.filter(([key]) => key === 'Enter')).toHaveLength(0);
  });

  it.each([40_000, 120_000])('keeps one rescue and notice budget when the same attempt is scheduled again at %sms', async delay => {
    const h = fixture({ acceptsRescue: false });
    h.start();
    await vi.advanceTimersByTimeAsync(delay);
    expect(h.backend.sendSpecialKeys).toHaveBeenCalledTimes(1);
    h.start();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(h.backend.sendSpecialKeys).toHaveBeenCalledTimes(1);
    expect(h.warnings()).toHaveLength(1);
  });

  it('survives a possibly partial key write before transport throws and later manual receipt', async () => {
    const h = fixture({ acceptsRescue: false });
    h.backend.sendSpecialKeys.mockImplementation(() => { throw new Error('transport lost after partial key write'); });
    h.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.backend.sendSpecialKeys).toHaveBeenCalledTimes(1);
    expect(h.queue.hasPendingTurn('delivery')).toBe(true);
    expect(h.warnings()).toHaveLength(1);
    h.accept();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
    expect(h.scope.flushPending).toHaveBeenCalledTimes(1);
  });

  it('blocks resubmission when manual editing happens inside the final receipt await', async () => {
    const h = fixture({ acceptsRescue: false });
    h.recheck.mockImplementation(async () => {
      if (h.recheck.mock.calls.length === 3) h.scope.webTerminalInputGeneration++;
      return false;
    });
    h.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.backend.sendSpecialKeys).not.toHaveBeenCalled();
    h.recheck.mockResolvedValue({ submitted: true, cliSessionId: 'owned-session' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
  });

  it('retains a quarantined receipt after a late usage-limit signal without an exact terminal', async () => {
    const h = fixture({ acceptsRescue: false });
    h.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.warnings()).toHaveLength(1);
    h.scope.usageLimitTracker.detectedThisTurn = () => true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.queue.hasPendingTurn('delivery')).toBe(true);
    h.accept();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
    expect(h.scope.flushPending).toHaveBeenCalledTimes(1);
  });

  it('does not submit a replacement quarantine installed during the fresh capture', async () => {
    const h = fixture({ acceptsRescue: false });
    h.backend.captureViewportAsync.mockImplementation(async () => {
      h.scope.armQuarantine(h.backend, { turnId: 'another' }, content);
      return composer(content);
    });
    h.start();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(h.backend.sendSpecialKeys).not.toHaveBeenCalled();
    expect(h.warnings()).toHaveLength(0);
  });

  it('keeps the quarantine on a sibling-pane same-text receipt without an owned session id', async () => {
    const h = fixture({ acceptsRescue: false });
    // history.jsonl is shared across TRAE panes: the any-text fallback can
    // confirm on a SIBLING's same-text line, which carries no cliSessionId this
    // pane owns. Such a receipt must not release the parked-draft quarantine.
    h.recheck.mockResolvedValue({ submitted: true });
    h.start();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.scope.inputDeliveryQuarantine).not.toBeNull();
    expect(h.scope.flushPending).not.toHaveBeenCalled();
    expect(h.chain.size()).toBe(1);
    expect(h.queue.hasPendingTurn('delivery')).toBe(true);

    // An owned receipt (same pane manual submit with a proven rollout) still
    // releases the quarantine exactly as before.
    h.recheck.mockResolvedValue({ submitted: true, cliSessionId: 'owned-session' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
    expect(h.scope.flushPending).toHaveBeenCalledTimes(1);
  });
});
