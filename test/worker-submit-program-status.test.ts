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
  decideSessionStartGatedSubmitWarning,
  diagnoseBackendSubmitFailure,
  shouldWaitThroughBusyTurn,
  SUBMIT_BUSY_TURN_MAX_WAITS,
} from '../src/services/submit-failure-diagnosis.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const chains = new Set<ReturnType<typeof createSubmitFailureChainController>>();

afterEach(() => {
  for (const chain of chains) chain.clear();
  chains.clear();
  vi.useRealTimers();
});

function harness(screen = '') {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const adapter = createClaudeCodeAdapter();
  const detector = new IdleDetector(adapter);
  const chain = createSubmitFailureChainController();
  chains.add(chain);
  const evidence = new InputDeliveryEvidenceTracker();
  evidence.start({ turnId: 'delivery', cliGeneration: 1 }, 0);
  const send = vi.fn((_message: WorkerToDaemon) => {});
  const recheck = vi.fn(() => false);
  const backend = { write: vi.fn(), sendText: vi.fn(), sendSpecialKeys: vi.fn() };
  const scope: Record<string, any> = {
    backend, cliAdapter: adapter, idleDetector: detector,
    lastInitConfig: { cliId: 'claude-code' }, cliSpawnGeneration: 1,
    cliRestartInProgress: false, effectiveBackendType: 'tmux',
    readyGate: { isArmed: true }, sessionStartSignalAtMs: 0,
    usageLimitTracker: { currentTurn: () => 1, detectedThisTurn: () => false },
    inputDeliveryEvidence: evidence, codexBridgeQueue: new CodexBridgeQueue(),
    submitFailureChains: chain, combineSubmitCurrentFences, settleDeferredSubmitConfirmation,
    submitActivityEvidenceSince: () => 'pty-output',
    SUBMIT_DEFERRED_RECHECK_MS: 20_000, SUBMIT_DEFERRED_RECHECK_MAX_ATTEMPTS: 2,
    SUBMIT_DIAG_BUSY_SILENCE_MAX_EXTRA: SUBMIT_BUSY_TURN_MAX_WAITS,
    SUBMIT_DIAG_ACTIVE_SILENCE_MAX_EXTRA: 3, unscopedSubmitFailureChainSequence: 0,
    captureBackendScreen: () => screen, lastPtyActivityAtMs: 0,
    backendScreenEvidenceIsAuthoritativeForMutation: () => false,
    diagnoseBackendSubmitFailure, decideSessionStartGatedSubmitWarning, shouldWaitThroughBusyTurn,
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
  it('waits for a delayed Claude receipt while hooks report working without a busy footer', async () => {
    const h = harness();
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
    const h = harness();
    h.scope.lastInitConfig = { cliId: 'kimi' };
    h.scope.cliAdapter = createKimiAdapter();
    const detector = new IdleDetector(h.scope.cliAdapter);
    h.scope.idleDetector = detector;
    detector.observeProgramStatus({ state: 'working' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.warnings()).toEqual([]);
    h.recheck.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(20_000);
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
