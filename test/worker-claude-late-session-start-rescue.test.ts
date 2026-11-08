import { describe, expect, it, vi } from 'vitest';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import {
  claudeComposerHoldsInput,
  decideSessionStartGatedSubmitWarning,
  diagnoseBackendSubmitFailure,
  shouldWaitThroughBusyTurn,
  SUBMIT_POST_SESSION_START_GRACE_MS,
} from '../src/services/submit-failure-diagnosis.js';

const RULE = '─'.repeat(60);
const PARKED_SCREEN = ['Claude Code', '', RULE, '❯ payload', RULE, '  ? for shortcuts'].join('\n');
const IDENTITY = { turnId: 'delivery', dispatchAttempt: 1 };

/** The real deferred recheck of a write made before the spawn's first
 *  SessionStart, with the prompt parked in Claude's input box throughout. */
function lateSessionStartHarness(cliId: string) {
  const h = workerSubmitHarness();
  const pressComposerSubmit = vi.fn(() => true);
  Object.assign(h.scope, {
    readyGate: { shouldHold: () => false, isArmed: true },
    lastInitConfig: { cliId },
    cliAdapter: { ...h.scope.cliAdapter, pressComposerSubmit },
    effectiveBackendType: 'tmux',
    captureBackendScreen: () => PARKED_SCREEN,
    lastPtyActivityAtMs: 0,
    sessionStartSignalAtMs: undefined,
    pressBackendEnter: vi.fn(),
    dropFailedBridgeMark: vi.fn(),
    claudeComposerHoldsInput,
    decideSessionStartGatedSubmitWarning,
    diagnoseBackendSubmitFailure,
    shouldWaitThroughBusyTurn,
    SUBMIT_POST_SESSION_START_GRACE_MS,
    SUBMIT_DIAG_BUSY_SILENCE_MAX_EXTRA: 12,
    SUBMIT_DIAG_ACTIVE_SILENCE_MAX_EXTRA: 1,
  });
  return { h, pressComposerSubmit };
}

describe('late SessionStart re-submit in the deferred submit recheck', () => {
  it('presses the configured submit key once after the grace, then still warns when that press is lost too', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { h, pressComposerSubmit } = lateSessionStartHarness('claude-code');
    try {
      h.schedule('payload', h.recheck, 'history', undefined, undefined, 1, IDENTITY);
      h.scope.sessionStartSignalAtMs = 15_000;

      await vi.advanceTimersByTimeAsync(20_000);
      expect(pressComposerSubmit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(20_000);
      expect(pressComposerSubmit).toHaveBeenCalledTimes(1);
      expect(pressComposerSubmit).toHaveBeenCalledWith(h.scope.backend);
      expect(h.scope.pressBackendEnter).not.toHaveBeenCalled();
      expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(20_000);
      expect(pressComposerSubmit).toHaveBeenCalledTimes(1);
      expect(h.scope.emitTurnTerminal).toHaveBeenCalledWith('delivery', 'failed', 'submit_unconfirmed', 1);
    } finally {
      h.submitFailureChains.clear();
      vi.useRealTimers();
    }
  });

  it('leaves the input box of a CLI other than Claude Code alone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { h, pressComposerSubmit } = lateSessionStartHarness('codex');
    try {
      h.schedule('payload', h.recheck, 'history', undefined, undefined, 1, IDENTITY);
      h.scope.sessionStartSignalAtMs = 15_000;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(pressComposerSubmit).not.toHaveBeenCalled();
      expect(h.scope.pressBackendEnter).not.toHaveBeenCalled();
      expect(h.scope.emitTurnTerminal).toHaveBeenCalledWith('delivery', 'failed', 'submit_unconfirmed', 1);
    } finally {
      h.submitFailureChains.clear();
      vi.useRealTimers();
    }
  });
});
