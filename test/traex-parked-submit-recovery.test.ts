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
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
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
  return { backend, queue, scope, chain, recheck, start,
    setScreen: (value: string) => { screen = value; },
    accept: () => { received = true; },
    warnings: () => scope.send.mock.calls.filter(([message]: any[]) => message.type === 'user_notify'),
  };
}

describe('TRAE parked draft recovery', () => {
  it.each([content, `[Pasted Content ${Array.from(content).length} chars]`])(
    'submits the same parked draft once and releases the next input: %s', async body => {
      const h = fixture({ screen: composer(body) });
      h.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.backend.sendSpecialKeys).toHaveBeenCalledExactlyOnceWith('Enter');
      expect(h.backend.write).not.toHaveBeenCalled();
      expect(h.scope.inputDeliveryQuarantine).toBeNull();
      expect(h.scope.flushPending).toHaveBeenCalledTimes(1);
      expect(h.warnings()).toEqual([]);
      expect(h.chain.size()).toBe(0);
    });

  it('clears the queue retention flag when releasing so the head can prune again', async () => {
    const h = fixture();
    // Arming the quarantine must also pin the bridge-queue head against lease
    // expiry pruning while the draft is parked.
    expect(h.queue.peek()[0]?.inputDeliveryQuarantined).toBe(true);
    expect(h.queue.pruneExpiredPreStartHeads(100_000)).toEqual([]);

    h.scope.releaseInputDeliveryQuarantine(
      h.scope.inputDeliveryQuarantine,
      'receipt',
      { redriveTerminal: false },
    );
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
    expect(h.queue.peek()[0]?.inputDeliveryQuarantined).toBeUndefined();
    // Without the flag clear, an unstarted head past every lease stays pinned
    // forever and blocks attribution of every later fingerprint.
    expect(h.queue.pruneExpiredPreStartHeads(100_000).map(turn => turn.turnId)).toEqual(['delivery']);
  });

  it('keeps the exact mark after one warning and accepts a later manual submit', async () => {
    const h = fixture({ acceptsRescue: false });
    h.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.warnings()).toHaveLength(1);
    expect(h.backend.sendSpecialKeys).toHaveBeenCalledTimes(1);
    expect(h.queue.pruneExpiredPreStartHeads()).toEqual([]);
    expect(h.queue.hasPendingTurn('delivery')).toBe(true);
    h.scope.webTerminalInputGeneration++;
    h.accept();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
    expect(h.scope.flushPending).toHaveBeenCalledTimes(1);
    expect(h.warnings()).toHaveLength(1);
    expect(h.chain.size()).toBe(0);
  });

  it.each(['adapter-wait', 'after-schedule', 'during-capture', 'during-receipt'] as const)(
    'never presses Enter after manual editing %s', async phase => {
      const h = fixture({ acceptsRescue: false });
      if (phase === 'adapter-wait') h.scope.webTerminalInputGeneration++;
      h.start();
      if (phase === 'after-schedule') h.scope.webTerminalInputGeneration++;
      if (phase === 'during-capture') h.backend.captureViewportAsync.mockImplementation(async () => {
        h.scope.webTerminalInputGeneration++;
        return composer(content);
      });
      if (phase === 'during-receipt') h.recheck.mockImplementation(() => {
        if (h.recheck.mock.calls.length === 3) h.scope.webTerminalInputGeneration++;
        return false;
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.backend.sendSpecialKeys).not.toHaveBeenCalled();
      expect(h.warnings()).toHaveLength(1);
      h.accept();
      h.recheck.mockReturnValue({ submitted: true, cliSessionId: 'owned-session' });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.scope.inputDeliveryQuarantine).toBeNull();
    });

  it('reads a receipt arriving during capture before pressing any key', async () => {
    const h = fixture();
    h.start();
    h.backend.captureViewportAsync.mockImplementation(async () => { h.accept(); return composer(content); });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.backend.sendSpecialKeys).not.toHaveBeenCalled();
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
  });

  it.each(['restart', 'backend', 'replacement'] as const)('fences a capture awaiting %s', async change => {
    const h = fixture();
    h.start();
    h.backend.captureViewportAsync.mockImplementation(async () => {
      if (change === 'restart') h.scope.cliSpawnGeneration++;
      if (change === 'backend') h.scope.backend = {};
      if (change === 'replacement') h.start();
      return composer(content);
    });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.backend.sendSpecialKeys).not.toHaveBeenCalled();
    expect(h.warnings()).toEqual([]);
  });

  it('waits for the provisional pre-thread composer before using the sole rescue', async () => {
    const h = fixture({ screen: '─────────────────────────\n❯ [Pasted Content 6 chars]\n  ? for shortcuts' });
    h.start();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.backend.sendSpecialKeys).not.toHaveBeenCalled();
    expect(h.warnings()).toEqual([]);

    h.setScreen(composer(`[Pasted Content ${Array.from(content).length} chars]`));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.backend.sendSpecialKeys).toHaveBeenCalledExactlyOnceWith('Enter');
    expect(h.warnings()).toEqual([]);
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
  });

  it('warns without pressing when the provisional composer outlives the startup hard cap', async () => {
    const h = fixture({ screen: '─────────────────────────\n❯ [Pasted Content 6 chars]\n  ? for shortcuts' });
    h.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.backend.sendSpecialKeys).not.toHaveBeenCalled();
    expect(h.warnings()).toHaveLength(1);
  });

  it.each(['pty', 'zmx', 'adopt'] as const)('does not guess a recovery for %s', async surface => {
    const h = fixture();
    h.start();
    if (surface === 'zmx') h.scope.effectiveBackendType = 'zmx';
    if (surface === 'pty') h.scope.backendScreenEvidenceIsAuthoritativeForMutation = () => false;
    if (surface === 'adopt') h.scope.lastInitConfig.adoptMode = true;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.backend.sendSpecialKeys).not.toHaveBeenCalled();
  });
});

describe('TRAE live draft recognition', () => {
  it('matches wrapped input and a Unicode scalar-count chip', () => {
    expect(traexComposerHoldsInput(composer('查询大盘\n  状态'), content)).toBe(true);
    expect(traexComposerHoldsInput(composer('[Pasted Content 2 chars]'), '中😀')).toBe(true);
  });
  it.each([
    composer('a different draft'), composer('[Pasted Content 99 chars]'),
    `${composer('[Pasted Content 6 chars]')}\n${composer('Ask TRAE CLI to do anything')}`,
    composer(''), '❯ [Pasted Content 6 chars]',
    `Sign in to TraeCode CLI\n${composer(content)}`,
    `◆ Working… (1s • esc to interrupt)\n────────────────\n❯ ${content}\n  GPT-6-Astra · Context 99% left`,
    '  Question 1/1\n❯ 1. Yes\n  enter submit answer',
  ])('rejects another input owner, a history example, or an unknown footer', screen => {
    expect(traexComposerHoldsInput(screen, content)).toBe(false);
  });
});
