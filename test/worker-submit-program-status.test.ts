import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerToDaemon } from '../src/types.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createKimiAdapter } from '../src/adapters/cli/kimi.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { InputDeliveryEvidenceTracker } from '../src/services/input-delivery-evidence.js';
import { createSubmitFailureChainController } from '../src/services/submit-failure-chain.js';
import { combineSubmitCurrentFences, settleDeferredSubmitConfirmation } from '../src/services/submit-confirmation.js';
import { buildSubmitMessagePreview } from '../src/services/submit-notification.js';
import {
  claudeComposerHoldsInput,
  decideSessionStartGatedSubmitWarning,
  diagnoseBackendSubmitFailure,
  shouldWaitThroughBusyTurn,
  SUBMIT_BUSY_TURN_MAX_WAITS,
  SUBMIT_POST_SESSION_START_GRACE_MS,
} from '../src/services/submit-failure-diagnosis.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const chains = new Set<ReturnType<typeof createSubmitFailureChainController>>();

afterEach(() => {
  for (const chain of chains) chain.clear();
  chains.clear();
  vi.useRealTimers();
});

function harness(screen = '', options: { cliId?: 'claude-code' | 'kimi'; priorWorking?: boolean } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const cliId = options.cliId ?? 'claude-code';
  const adapter = cliId === 'kimi' ? createKimiAdapter() : createClaudeCodeAdapter();
  const detector = new IdleDetector(adapter);
  if (options.priorWorking) {
    detector.observeProgramStatus({ state: 'working', id: 'background' });
    detector.reset(); // The next write preserves an earlier background task's working record.
  }
  const chain = createSubmitFailureChainController();
  chains.add(chain);
  const evidence = new InputDeliveryEvidenceTracker();
  evidence.start({ turnId: 'delivery', cliGeneration: 1 }, 0);
  const send = vi.fn((_message: WorkerToDaemon) => {});
  const recheck = vi.fn(() => false);
  const backend = { write: vi.fn(), sendText: vi.fn(), sendSpecialKeys: vi.fn() };
  const scope: Record<string, any> = {
    backend, cliAdapter: adapter, idleDetector: detector,
    lastInitConfig: { cliId }, cliSpawnGeneration: 1,
    cliRestartInProgress: false, effectiveBackendType: 'tmux',
    readyGate: { isArmed: cliId === 'claude-code' }, sessionStartSignalAtMs: 0,
    usageLimitTracker: { currentTurn: () => 1, detectedThisTurn: () => false },
    inputDeliveryEvidence: evidence, codexBridgeQueue: new CodexBridgeQueue(),
    submitFailureChains: chain, combineSubmitCurrentFences, settleDeferredSubmitConfirmation,
    submitActivityEvidenceSince: () => 'pty-output',
    SUBMIT_DEFERRED_RECHECK_MS: 20_000, SUBMIT_DEFERRED_RECHECK_MAX_ATTEMPTS: 2,
    SUBMIT_DIAG_BUSY_SILENCE_MAX_EXTRA: SUBMIT_BUSY_TURN_MAX_WAITS,
    SUBMIT_DIAG_ACTIVE_SILENCE_MAX_EXTRA: 3, unscopedSubmitFailureChainSequence: 0,
    SUBMIT_POST_SESSION_START_GRACE_MS,
    captureBackendScreen: () => screen, lastPtyActivityAtMs: 0,
    backendScreenEvidenceIsAuthoritativeForMutation: () => false,
    diagnoseBackendSubmitFailure, decideSessionStartGatedSubmitWarning, shouldWaitThroughBusyTurn,
    claudeComposerHoldsInput,
    busyProbeRegion: (text: string) => text,
    dropFailedBridgeMark: vi.fn(), redriveRejectedStructuredReady: vi.fn(),
    deferNativeCodexInputCommit: () => false, queuePostSubmitNativeSessionTitle: vi.fn(),
    buildSubmitMessagePreview, cliName: () => 'Claude', currentBotmuxTurnId: 'delivery',
    emitTurnTerminal: vi.fn(), log: vi.fn(), send, t: (key: string) => key,
  };
  scope.submitUnconfirmedNotice = loadWorkerFunction('submitUnconfirmedNotice', scope);
  const schedule = loadWorkerFunction('scheduleSubmitFailureNotify', scope);
  schedule('status please', recheck, 'transcript', 'delivery', undefined, 1, { turnId: 'delivery' });
  return {
    detector, recheck, chain, scope, backend,
    warnings: () => send.mock.calls.map(([message]) => message).filter(message => message.type === 'user_notify'),
  };
}

describe('worker submit confirmation with native program status', () => {
  const rule = '─'.repeat(60);
  const composerScreen = (body: string) => ['Claude Code', rule, `❯ ${body}`, rule, '  ? for shortcuts'].join('\n');

  it.each([
    { kind: 'unpainted prompt', screen: '' },
    { kind: 'empty composer', screen: composerScreen('') },
    { kind: 'historical paste box', screen: [composerScreen('[Pasted text #2 +3 lines]'), 'Earlier example', composerScreen('')].join('\n') },
  ])('waits for a delayed Claude receipt with $kind while hooks report working without a busy footer', async ({ screen }) => {
    const h = harness(screen);
    h.detector.observeProgramStatus({ state: 'working' });
    h.detector.resetReadyEvidence(); // SessionStart can arrive after the working report.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.warnings()).toEqual([]);
    expect(h.scope.dropFailedBridgeMark).not.toHaveBeenCalled();
    h.recheck.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.warnings()).toEqual([]);
    expect(h.chain.size()).toBe(0);
    expect(h.backend.write).not.toHaveBeenCalled();
    expect(h.backend.sendText).not.toHaveBeenCalled();
    expect(h.backend.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('still warns for an unsubmitted draft with only weak PTY activity', async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.warnings()).toHaveLength(1);
    expect(h.chain.size()).toBe(0);
  });

  it('also keeps native working evidence for another CLI using the same confirmation path', async () => {
    const h = harness('', { cliId: 'kimi' });
    h.detector.observeProgramStatus({ state: 'working' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.warnings()).toEqual([]);
    h.recheck.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.chain.size()).toBe(0);
  });

  it.each([
    { kind: 'collapsed paste', screen: composerScreen('[Pasted text #2 +3 lines]') },
    { kind: 'plain input', screen: composerScreen('status please') },
  ])('warns for a parked $kind even when an earlier background task still reports working', async ({ screen }) => {
    const h = harness(screen, { priorWorking: true });
    expect(h.detector.programStatusHeldWorking()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.warnings()).toHaveLength(1);
    expect(h.chain.size()).toBe(0);
    expect(h.backend.write).not.toHaveBeenCalled();
    expect(h.backend.sendText).not.toHaveBeenCalled();
    expect(h.backend.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('lets the generic parked-draft screen gate override held working for another CLI', async () => {
    // The claude-only composer guard cannot see this CLI's input box; the
    // draft_parked screen verdict is the only thing that keeps a stale
    // background working record from muting the parked-draft warning.
    const parkedScreen = '❯\n[Pasted Content 3882 chars]\n⏎ to submit';
    const h = harness(parkedScreen, { cliId: 'kimi', priorWorking: true });
    expect(h.detector.programStatusHeldWorking()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.warnings()).toHaveLength(1);
    expect(h.chain.size()).toBe(0);
  });

  it('preserves the one-shot late SessionStart submit rescue while an older working record remains', async () => {
    const h = harness(composerScreen('status please'), { priorWorking: true });
    const pressComposerSubmit = vi.fn(() => true);
    h.scope.cliAdapter = { ...h.scope.cliAdapter, pressComposerSubmit };
    h.scope.sessionStartSignalAtMs = 15_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pressComposerSubmit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pressComposerSubmit).toHaveBeenCalledTimes(1);
    expect(h.warnings()).toEqual([]);
    h.recheck.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pressComposerSubmit).toHaveBeenCalledTimes(1);
    expect(h.warnings()).toEqual([]);
    expect(h.chain.size()).toBe(0);
  });

  it.each(['Please run /login', 'hooks need review'])('keeps a visible blocking page actionable: %s', async screen => {
    const h = harness(screen);
    h.detector.observeProgramStatus({ state: 'working' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.warnings()).toHaveLength(1);
  });

  it('does not treat a native blocked status as working evidence', async () => {
    const h = harness();
    h.detector.observeProgramStatus({ state: 'working' });
    h.detector.observeProgramStatus({ state: 'blocked', kind: 'permission' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.warnings()).toHaveLength(1);
  });

  it('returns to normal diagnosis when native working ends without a receipt', async () => {
    const h = harness();
    h.detector.observeProgramStatus({ state: 'working' });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.warnings()).toEqual([]);
    h.detector.observeProgramStatus({ state: 'idle' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.warnings()).toHaveLength(1);
  });

  it('keeps the existing ceiling even when native working never ends', async () => {
    const h = harness();
    h.detector.observeProgramStatus({ state: 'working' });
    await vi.advanceTimersByTimeAsync(20_000 * (SUBMIT_BUSY_TURN_MAX_WAITS + 3));
    expect(h.warnings()).toHaveLength(1);
    expect(h.chain.size()).toBe(0);
  });

  it('discards a deferred check after the CLI generation changes', async () => {
    const h = harness();
    h.detector.observeProgramStatus({ state: 'working' });
    h.scope.cliSpawnGeneration++;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.warnings()).toEqual([]);
    expect(h.recheck).not.toHaveBeenCalled();
    expect(h.chain.size()).toBe(0);
  });
});
