import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTraexAdapter, traexScreenShowsNoPendingInput } from '../src/adapters/cli/traex.js';
import { createQueuedActivationReceiptObserver } from '../src/services/queued-activation-receipts.js';
import { traexComposerHoldsInput, traexRestoredComposerReady } from '../src/adapters/cli/traex-footer.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { InputDeliveryEvidenceTracker } from '../src/services/input-delivery-evidence.js';
import { createSubmitFailureChainController } from '../src/services/submit-failure-chain.js';
import { combineSubmitCurrentFences, settleDeferredSubmitConfirmation } from '../src/services/submit-confirmation.js';
import { buildSubmitMessagePreview } from '../src/services/submit-notification.js';
import { claudeComposerHoldsInput, decideSessionStartGatedSubmitWarning, diagnoseBackendSubmitFailure,
  diagnoseSubmitFailure, shouldWaitThroughBusyTurn } from '../src/services/submit-failure-diagnosis.js';
import { screenMayShowCredential } from '../src/core/cli-startup-blocker.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { classifyStuckPage } from '../src/utils/stuck-detector.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';

const content = '查询大盘状态';
const composer = (body: string) => `Earlier conversation\n─────────────────────────\n❯ ${body}\n  GPT-6-Astra xhigh · Context 99% left\n  ? for shortcuts`;
/** Real TRAE 0.216.0 cold-resume frames: a large paste collapses into a chip
 *  and the hint row becomes `paste again expand` (provisional and resolved
 *  composer), or the whole footer is redrawn once the model row resolves. */
const recorded = (name: 'provisional-pasted' | 'resolved-pasted' | 'resolved-pasted-redrawn', draft = content) =>
  readFileSync(`test/fixtures/traex-cold-resume/0.216.0-resume-${name}.txt`, 'utf8')
    .replace('[Pasted Content 2349 chars]', `[Pasted Content ${Array.from(draft).length} chars]`);
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
    createQueuedActivationReceiptObserver,
    submitFailureChains: chain, combineSubmitCurrentFences, settleDeferredSubmitConfirmation,
    usageLimitTracker: { currentTurn: () => 1, detectedThisTurn: () => false },
    submitActivityEvidenceSince: () => 'pty-output', readyGate: { isArmed: false },
    SUBMIT_DEFERRED_RECHECK_MS: 20_000, SUBMIT_DEFERRED_RECHECK_MAX_ATTEMPTS: 2,
    FIRST_PROMPT_HARD_TIMEOUT_MS: 90_000,
    SUBMIT_DIAG_BUSY_SILENCE_MAX_EXTRA: 12, SUBMIT_DIAG_ACTIVE_SILENCE_MAX_EXTRA: 3,
    unscopedSubmitFailureChainSequence: 0, effectiveBackendType: 'tmux', lastPtyActivityAtMs: 0,
    captureBackendScreen: () => screen, backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    screenMayShowCredential, diagnoseSubmitFailure,
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
    ownedSubmitConsumptionProofKind: () => undefined,
    buildSubmitMessagePreview, cliName: () => 'TRAE', currentBotmuxTurnId: 'delivery',
    emitTurnTerminal: vi.fn(), send: vi.fn(), log: vi.fn(), t: (key: string) => key,
    shareableStuckScreenTail: () => '', classifyStuckPage,
    isPromptReady: false, flushPending: vi.fn(),
  };
  scope.currentInputDeliveryQuarantine = loadWorkerFunction('currentInputDeliveryQuarantine', scope);
  scope.screenShowsCredentialPage = loadWorkerFunction('screenShowsCredentialPage', scope);
  scope.releaseInputDeliveryQuarantine = loadWorkerFunction('releaseInputDeliveryQuarantine', scope);
  scope.traexQuestionCapture = loadWorkerFunction('traexQuestionCapture', scope);
  scope.submitUnconfirmedNotice = loadWorkerFunction('submitUnconfirmedNotice', scope);
  const arm = loadWorkerFunction('armInputDeliveryQuarantine', scope);
  const quarantine = arm(backend, { turnId: 'delivery', dispatchAttempt: options.dispatchAttempt }, content, recheck);
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

describe('unconfirmed input that left the TRAE composer', () => {
  it('keeps native queued input through the real PTY renderer without collapsing its structural indentation', async () => {
    const renderer = new TerminalRenderer(160, 50);
    try {
      const pending = `✦ Running… (1m • esc to interrupt)\nSend after tool call · esc to interrupt and send · ↑ to edit\n❯ original input\n${Array(25).fill('  continued native input').join('\n')}\n─────────────────────────\n❯ Use /skills to list available skills\n  GPT-6-Astra xhigh · Context 99% left\n  ? for shortcuts`;
      await renderer.writeAndFlush(pending.replace(/\n/g, '\r\n'));
      const h = fixture({ acceptsRescue: false });
      h.scope.captureBackendScreen = loadWorkerFunction('captureBackendScreen', { renderer });
      expect(traexScreenShowsNoPendingInput(h.scope.captureBackendScreen({}, { preserveFormatting: true }))).toBe(false);
      h.start();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.scope.inputDeliveryQuarantine).not.toBeNull();
      expect(h.backend.write).not.toHaveBeenCalled();
      expect(h.backend.sendSpecialKeys).not.toHaveBeenCalled();
    } finally { renderer.dispose(); }
  });

  it('accepts only an initialized empty composer, preserving drafts, work and native queued input', () => {
    const empty = composer('Use /skills to list available skills');
    expect(traexScreenShowsNoPendingInput(empty)).toBe(true);
    expect(traexScreenShowsNoPendingInput(empty.replace('99% left', '—'))).toBe(true);
    expect(traexScreenShowsNoPendingInput(composer(content))).toBe(false);
    expect(traexScreenShowsNoPendingInput('❯\n? for shortcuts')).toBe(false);
    expect(traexScreenShowsNoPendingInput(`✦ 正在运行… (2m • esc to interrupt)\n${empty}`)).toBe(false);
    const pending = `Send after tool call · esc to interrupt and send · ↑ to edit\n❯ original draft\n${Array(25).fill('  continued draft').join('\n')}\n${empty.replace('Earlier conversation\n', '')}`;
    expect(traexScreenShowsNoPendingInput(pending)).toBe(false);
    for (const name of ['traex-0.214.1-single-160x50.txt', 'traex-0.214.1-submit-confirm-160x50.txt']) {
      expect(traexScreenShowsNoPendingInput(readFileSync(`test/fixtures/traex-question/${name}`, 'utf8'))).toBe(false);
    }
  });

  it('keeps a wrapped native pending-input panel through the real narrow PTY renderer', async () => {
    const empty = '❯ Use /skills to list available skills\n  m · Context 99% left\n  ? for shortcuts';
    expect(traexScreenShowsNoPendingInput(empty)).toBe(true);
    const pending = `Send after tool call · esc to interrupt and send · ↑ to edit\n❯ original input\n${Array(25).fill('  continued native input').join('\n')}\n${empty}`;
    const renderer = new TerminalRenderer(40, 50);
    try {
      await renderer.writeAndFlush(pending.replace(/\n/g, '\r\n'));
      const screen = renderer.rawSnapshot({ preserveFormatting: true });
      expect(screen).toContain('Send after tool call');
      expect(traexScreenShowsNoPendingInput(screen)).toBe(false);
    } finally { renderer.dispose(); }
  });

  it('does not mistake natural-language lines for a wrapped pending-input header', () => {
    const empty = '❯ Use /skills to list available skills\n  m · Context 99% left\n  ? for shortcuts';
    for (const row of ['and send it to the reviewer', 'Send after you finish']) {
      expect(traexScreenShowsNoPendingInput(`${row}\n${empty}`)).toBe(true);
    }
  });

  it.each([
    ['truncated model/cwd row', [
      '──────────────────────────────────────────────────────────',
      '❯ Ask TRAE CLI to do anything',
      '──────────────────────────────────────────────────────────',
      '  GPT-6.1-Sol · /tmp/repo/very-long-directory-name-component-0123456789/very-long-directory-name-compo…',
      '  ? for shortcuts',
    ].join('\n')],
    ['initialized hint-only footer', [
      '  █ ◆ ◆ █  TRAE CLI (v0.214.1)',
      '  Tip: status_line=[] keeps this initialized composer on the native hint footer',
      '──────────────────────────────────────────────────────────',
      '❯ Ask TRAE CLI to do anything',
      '──────────────────────────────────────────────────────────',
      '  ? for shortcuts',
    ].join('\n')],
  ])('accepts the strictly initialized empty composer: %s', (_name, screen) => {
    expect(traexRestoredComposerReady(screen, { requireThreadReady: true })).toBe(true);
    expect(traexScreenShowsNoPendingInput(screen)).toBe(true);
  });

  it('still rejects a provisional shortcut-only composer without initialized content', () => {
    const screen = [
      '  █ ◆ ◆ █  TRAE CLI (v0.214.1)',
      '  /tmp/traex0214/work',
      '──────────────────────────────────────────────────────────',
      '❯ Ask TRAE CLI to do anything',
      '──────────────────────────────────────────────────────────',
      '  ? for shortcuts',
    ].join('\n');
    expect(traexRestoredComposerReady(screen)).toBe(true);
    expect(traexRestoredComposerReady(screen, { requireThreadReady: true })).toBe(false);
    expect(traexScreenShowsNoPendingInput(screen)).toBe(false);
  });

  it('releases an ordinary submit after two empty screens without resending the original', async () => {
    const h = fixture({ acceptsRescue: false, screen: composer('Use /skills to list available skills') });
    h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).not.toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).not.toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
    expect(h.chain.size()).toBe(0);
    expect(h.backend.write).not.toHaveBeenCalled();
    expect(h.backend.sendSpecialKeys).not.toHaveBeenCalled();
    expect(h.scope.flushPending).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.chain.size()).toBe(0);
    expect(h.warnings()).toHaveLength(1);
  });

  it('resets the empty-screen count if a draft reappears between polls', async () => {
    const h = fixture({ acceptsRescue: false, screen: composer('Use /skills to list available skills') });
    h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    h.setScreen(composer(`[Pasted Content ${Array.from(content).length} chars]`));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).not.toBeNull();
    h.setScreen(composer('Use /skills to list available skills'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).not.toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
    expect(h.backend.write).not.toHaveBeenCalled();
  });
});

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

  it('submits a draft parked under the recorded resolved footer that kept the paste hint', async () => {
    const h = fixture({ screen: recorded('resolved-pasted') });
    h.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.backend.sendSpecialKeys).toHaveBeenCalledExactlyOnceWith('Enter');
    expect(h.backend.write).not.toHaveBeenCalled();
    expect(h.warnings()).toEqual([]);
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
    expect(h.scope.flushPending).toHaveBeenCalledTimes(1);
  });

  it('waits on the recorded provisional paste footer, then submits once after the redraw', async () => {
    const h = fixture({ screen: recorded('provisional-pasted') });
    h.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.backend.sendSpecialKeys).not.toHaveBeenCalled();
    expect(h.warnings()).toEqual([]);

    h.setScreen(recorded('resolved-pasted-redrawn'));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.backend.sendSpecialKeys).toHaveBeenCalledExactlyOnceWith('Enter');
    expect(h.warnings()).toEqual([]);
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
  });

  it('logs why the rescue did not run, whether the key was accepted and what the read-back saw', async () => {
    const lines = (h: ReturnType<typeof fixture>) => h.scope.log.mock.calls.map(([line]: [string]) => line)
      .filter((line: string) => line.startsWith('TRAE draft rescue'));
    const unknown = fixture({ screen: composer(content).replace('? for shortcuts', 'ⓘ unknown new footer') });
    unknown.start();
    await vi.advanceTimersByTimeAsync(140_000);
    expect(unknown.warnings()).toHaveLength(1);
    // One line per distinct reason, even though the retained chain keeps polling.
    expect(lines(unknown)).toEqual([
      expect.stringMatching(/skipped: the live composer does not show the original draft .*ⓘ unknown new footer/),
      expect.stringMatching(/skipped: the one-shot warning was already sent/),
    ]);

    const refused = fixture({ acceptsRescue: false });
    refused.backend.sendSpecialKeys.mockReturnValue(false);
    refused.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines(refused)).toContainEqual(expect.stringMatching(/failed: the backend did not accept the submit key/));

    const dropped = fixture({ acceptsRescue: false });
    dropped.start();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(dropped.backend.sendSpecialKeys).toHaveBeenCalledTimes(1);
    expect(lines(dropped)).toEqual(expect.arrayContaining([
      expect.stringMatching(/submit key accepted by the backend/),
      expect.stringMatching(/read-back: no receipt after the submit key; composer still holds the original draft/),
    ]));
  });

  it('withholds a credential-page last row from persistent rescue logs', async () => {
    const secret = 'DEVICE-CODE-SECRET-7319';
    const h = fixture({
      screen: `Sign in to TraeCode CLI\nOpen this link in your browser: https://auth.example.invalid/login?code=${secret}`,
    });
    h.start();
    await vi.advanceTimersByTimeAsync(140_000);
    expect(h.warnings()).toHaveLength(1);
    const logs = h.scope.log.mock.calls.map(([line]: [string]) => line).join('\n');
    expect(logs).not.toContain(secret);
    expect(logs).toContain('last row withheld: credential page');
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
  it('reads the recorded 0.216.0 paste-hint footers as a draft surface', () => {
    const draft = 'x'.repeat(2349);
    expect(traexComposerHoldsInput(recorded('provisional-pasted', draft), draft, { requireThreadReady: false })).toBe(true);
    expect(traexComposerHoldsInput(recorded('provisional-pasted', draft), draft)).toBe(false);
    expect(traexComposerHoldsInput(recorded('resolved-pasted', draft), draft)).toBe(true);
    expect(traexComposerHoldsInput(recorded('resolved-pasted-redrawn', draft), draft)).toBe(true);
    expect(traexComposerHoldsInput(recorded('resolved-pasted', draft), 'y'.repeat(2348))).toBe(false);
  });
  it('recognizes an initialized hidden-status draft while keeping its provisional twin gated', () => {
    const draft = 'x'.repeat(2349);
    const initialized = recorded('provisional-pasted', draft).replace('  permissions: YOLO mode',
      '  Good afternoon, user\n\n  Tip: Use /fork to branch the current chat into a new thread.');
    expect(traexComposerHoldsInput(initialized, draft)).toBe(true);
    expect(traexComposerHoldsInput(recorded('provisional-pasted', draft), draft)).toBe(false);
  });
  it('never accepts the paste hint below an empty composer', () => {
    const empty = recorded('resolved-pasted').replace(/❯ \[Pasted Content \d+ chars\]/, '❯ Ask TRAE CLI to do anything');
    expect(traexRestoredComposerReady(empty)).toBe(false);
    expect(traexRestoredComposerReady(empty, { requireThreadReady: true })).toBe(false);
  });
});
