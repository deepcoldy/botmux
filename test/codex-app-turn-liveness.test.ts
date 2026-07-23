import { describe, expect, it, vi } from 'vitest';
import {
  applyTrustedCodexAppActivityMarker,
  applyTrustedCodexAppStateMarker,
  CodexAppFlushPromptReplay,
  CodexAppReadyAuthority,
  CodexAppTurnLiveness,
  shouldBeginCodexAppReattachObservation,
} from '../src/utils/codex-app-turn-liveness.js';
import {
  CodexAppControlRecordApplicationGate,
  projectCodexAppControlReadinessStatus,
} from '../src/utils/codex-app-control.js';

describe('CodexAppReadyAuthority', () => {
  it('does not allocate a Botmux liveness slot for a native Goal continuation', () => {
    const authority = new CodexAppReadyAuthority();
    const tracker = new CodexAppTurnLiveness(1_000);
    const state = applyTrustedCodexAppStateMarker(tracker, authority, {
      busy: true,
      tracksTurn: false,
      acceptingInput: true,
      atMs: 10_000,
    }, 10_000);
    expect(state).toMatchObject({ accepted: true, busy: true, tracksTurn: false });
    expect(tracker.hasActiveTurn()).toBe(false);
    expect(authority.canPublishPromptReady()).toBe(false);

    tracker.beginReattachObservation(10_100);
    expect(tracker.hasActiveTurn()).toBe(true);
    applyTrustedCodexAppStateMarker(tracker, authority, {
      busy: true,
      tracksTurn: false,
      acceptingInput: true,
      atMs: 10_110,
    }, 10_110);
    expect(tracker.hasActiveTurn()).toBe(false);
  });

  it('suppresses a terminal prompt and publishes ready only after signed idle, preserving final-before-ready', () => {
    const authority = new CodexAppReadyAuthority();
    const tracker = new CodexAppTurnLiveness(1_000);
    const events: string[] = [];

    tracker.begin('turn-ready', 10_000);
    authority.beginWork();
    applyTrustedCodexAppActivityMarker(tracker, {
      phase: 'completed',
      atMs: 10_100,
    }, 10_100);
    // Model a prompt byte that wins the terminal/backend race and arrives
    // before the signed final transaction. It is not an idle authority.
    if (tracker.notePrompt(10_101) && authority.canPublishPromptReady()) events.push('ready-from-terminal');
    else events.push('terminal-prompt-suppressed');

    events.push('final-output');
    const state = applyTrustedCodexAppStateMarker(tracker, authority, {
      busy: false,
      atMs: 10_102,
    }, 10_102);
    expect(state).toMatchObject({ accepted: true, busy: false, shouldPublishReady: true });
    if (state.shouldPublishReady && authority.canPublishPromptReady()) events.push('prompt-ready');

    expect(events).toEqual([
      'terminal-prompt-suppressed',
      'final-output',
      'prompt-ready',
    ]);
  });

  it('does not retain an old idle grant across a new queued turn', () => {
    const authority = new CodexAppReadyAuthority();
    authority.noteSignedState(false);
    expect(authority.canPublishPromptReady()).toBe(true);

    authority.beginWork();
    expect(authority.canPublishPromptReady()).toBe(false);
    authority.noteSignedState(true);
    expect(authority.canPublishPromptReady()).toBe(false);
  });

  it('grants exactly one late terminal prompt after an exact submit cancellation', () => {
    const authority = new CodexAppReadyAuthority();
    const tracker = new CodexAppTurnLiveness(1_000);
    const replay = new CodexAppFlushPromptReplay();
    const handle = tracker.begin('cancelled-turn', 10_000);
    authority.beginWork();

    // No prompt was observed during writeInput; it arrives only after the
    // exact failed slot has been removed and the flush has returned.
    replay.cancelSubmission(tracker, authority, handle, 10_100);
    expect(replay.consumeAfterFlush(tracker)).toBe(false);
    expect(tracker.notePrompt(10_110)).toBe(true);
    expect(authority.canPublishPromptReady()).toBe(false);
    expect(authority.consumeLatePromptRecovery(!tracker.hasActiveTurn())).toBe(true);
    expect(authority.canPublishPromptReady()).toBe(false);
    expect(authority.consumeLatePromptRecovery(true)).toBe(false);
  });

  it('does not arm recovery for an absent or already-cancelled submit handle', () => {
    const authority = new CodexAppReadyAuthority();
    const tracker = new CodexAppTurnLiveness(1_000);
    const replay = new CodexAppFlushPromptReplay();

    replay.cancelSubmission(tracker, authority, undefined);
    replay.cancelSubmission(tracker, authority, 999);
    expect(authority.consumeLatePromptRecovery(true)).toBe(false);

    const exact = tracker.begin('exact-turn');
    replay.cancelSubmission(tracker, authority, exact);
    expect(authority.consumeLatePromptRecovery(true)).toBe(true);
    replay.cancelSubmission(tracker, authority, exact);
    expect(authority.consumeLatePromptRecovery(true)).toBe(false);
  });

  it('does not let a cancelled turn prompt release newer work', () => {
    const authority = new CodexAppReadyAuthority();
    const tracker = new CodexAppTurnLiveness(1_000);
    const replay = new CodexAppFlushPromptReplay();
    const cancelled = tracker.begin('cancelled-turn', 10_000);
    authority.beginWork();
    replay.cancelSubmission(tracker, authority, cancelled, 10_100);

    tracker.begin('new-turn', 10_110);
    authority.beginWork();
    expect(tracker.notePrompt(10_120)).toBe(false);
    expect(authority.consumeLatePromptRecovery(!tracker.hasActiveTurn())).toBe(false);
    expect(authority.canPublishPromptReady()).toBe(false);
  });

  it('clears late-prompt recovery on trusted work, signed state, and reset', () => {
    const authority = new CodexAppReadyAuthority();
    const tracker = new CodexAppTurnLiveness(1_000);
    const replay = new CodexAppFlushPromptReplay();
    const arm = () => {
      const handle = tracker.begin('cancelled-turn');
      authority.beginWork();
      replay.cancelSubmission(tracker, authority, handle);
    };

    arm();
    authority.beginWork(); // trusted submitted/progress handler
    expect(authority.consumeLatePromptRecovery(true)).toBe(false);

    arm();
    authority.noteSignedState(false);
    expect(authority.consumeLatePromptRecovery(true)).toBe(false);
    expect(authority.canPublishPromptReady()).toBe(true);

    arm();
    authority.reset();
    expect(authority.consumeLatePromptRecovery(true)).toBe(false);
    expect(authority.canPublishPromptReady()).toBe(false);
  });
});

describe('shouldBeginCodexAppReattachObservation', () => {
  it('covers a Zellij reattach even though Zellij is not pipe mode', () => {
    for (const backendType of ['tmux', 'herdr', 'zellij'] as const) {
      expect(shouldBeginCodexAppReattachObservation({
        cliId: 'codex-app',
        backendType,
        isReattach: true,
      })).toBe(true);
    }
  });

  it('does not observe a fresh spawn, non-persistent backend, or another CLI', () => {
    expect(shouldBeginCodexAppReattachObservation({
      cliId: 'codex-app',
      backendType: 'zellij',
      isReattach: false,
    })).toBe(false);
    expect(shouldBeginCodexAppReattachObservation({
      cliId: 'codex-app',
      backendType: 'pty',
      isReattach: true,
    })).toBe(false);
    expect(shouldBeginCodexAppReattachObservation({
      cliId: 'codex',
      backendType: 'tmux',
      isReattach: true,
    })).toBe(false);
  });
});

describe('CodexAppTurnLiveness', () => {
  it('coalesces a replayed final while persistence is pending and keeps type-ahead working', async () => {
    const tracker = new CodexAppTurnLiveness(1_000);
    const gate = new CodexAppControlRecordApplicationGate();
    tracker.begin('turn-n', 10_000);
    tracker.begin('turn-n-plus-1', 10_010);

    let completionAwaitingFinal = false;
    const completed = applyTrustedCodexAppActivityMarker(tracker, {
      phase: 'completed',
      atMs: 10_100,
    }, 10_100);
    expect(completed).toMatchObject({ accepted: true, phase: 'completed' });
    completionAwaitingFinal = true;

    let releasePersistence!: () => void;
    const persistence = new Promise<void>(resolve => {
      releasePersistence = resolve;
    });
    let applicationCount = 0;
    const applyFinal = async (): Promise<boolean> => {
      applicationCount++;
      if (!completionAwaitingFinal) tracker.completeCurrent(10_110);
      completionAwaitingFinal = false;
      await persistence;
      return true;
    };

    const first = gate.run('generation-a', 42, applyFinal);
    await Promise.resolve();
    const replayEffect = vi.fn(async () => true);
    const replay = gate.run('generation-a', 42, replayEffect);

    expect(applicationCount).toBe(1);
    expect(replayEffect).not.toHaveBeenCalled();
    expect(tracker.poll(10_110)).toMatchObject({
      active: true,
      turnId: 'turn-n-plus-1',
    });
    expect(projectCodexAppControlReadinessStatus('idle', {
      controlProven: true,
      signedStateObserved: false,
      inputReady: false,
    })).toBe('working');

    releasePersistence();
    await expect(first).resolves.toBe(true);
    await expect(replay).resolves.toBe(true);
    gate.release('generation-a', 42, first);

    expect(applicationCount).toBe(1);
    expect(tracker.poll(10_120)).toMatchObject({
      active: true,
      turnId: 'turn-n-plus-1',
    });
  });

  it('projects idle only after authenticated signed input readiness', () => {
    expect(projectCodexAppControlReadinessStatus('idle', {
      controlProven: false,
      signedStateObserved: false,
      inputReady: false,
    })).toBe('working');
    expect(projectCodexAppControlReadinessStatus('idle', {
      controlProven: true,
      signedStateObserved: false,
      inputReady: false,
    })).toBe('working');
    expect(projectCodexAppControlReadinessStatus('idle', {
      controlProven: true,
      signedStateObserved: true,
      inputReady: false,
    })).toBe('working');
    expect(projectCodexAppControlReadinessStatus('idle', {
      controlProven: true,
      signedStateObserved: true,
      inputReady: true,
    })).toBe('idle');
    expect(projectCodexAppControlReadinessStatus('stalled', {
      controlProven: false,
      signedStateObserved: false,
      inputReady: false,
    })).toBe('stalled');
  });

  it('stays working before the no-progress threshold, then stalls and notifies once', () => {
    const tracker = new CodexAppTurnLiveness(1_000);
    tracker.begin('turn-1', 10_000);

    expect(tracker.poll(10_999)).toEqual({
      active: true,
      stalled: false,
      newlyStalled: false,
      shouldNotify: false,
      turnId: 'turn-1',
    });
    expect(tracker.poll(11_000)).toEqual({
      active: true,
      stalled: true,
      newlyStalled: true,
      shouldNotify: true,
      turnId: 'turn-1',
    });
    expect(tracker.poll(12_000)).toEqual({
      active: true,
      stalled: true,
      newlyStalled: false,
      shouldNotify: false,
      turnId: 'turn-1',
    });
  });

  it('uses runner activity as the clock and clears a stalled projection on recovery', () => {
    const tracker = new CodexAppTurnLiveness(1_000);
    tracker.begin('turn-1', 10_000);
    tracker.noteActivity(10_900);
    expect(tracker.poll(11_500).stalled).toBe(false);

    expect(tracker.poll(11_900)).toMatchObject({ stalled: true, shouldNotify: true });
    tracker.noteActivity(12_000);
    expect(tracker.poll(12_000)).toMatchObject({ stalled: false, newlyStalled: false });

    // A recovered turn may become quiet again, but it must not spam the same
    // warning a second time.
    expect(tracker.poll(13_000)).toMatchObject({
      stalled: true,
      newlyStalled: true,
      shouldNotify: false,
    });
  });

  it('does not move the activity clock backwards for a delayed OSC marker', () => {
    const tracker = new CodexAppTurnLiveness(1_000);
    tracker.begin('turn-1', 10_000);
    tracker.noteActivity(11_000);
    tracker.noteActivity(10_500);
    expect(tracker.poll(11_999).stalled).toBe(false);
    expect(tracker.poll(12_000).stalled).toBe(true);
  });

  it('keeps flushPending inputs FIFO and starts a queued turn clock only after its predecessor completes', () => {
    const tracker = new CodexAppTurnLiveness(1_000);
    // flushPending() may write both Botmux inputs before the serial runner
    // finishes the first one. Completion must advance one queue slot, not
    // clear or overwrite the later turn.
    tracker.begin('turn-1', 10_000);
    tracker.begin('turn-2', 10_010);
    tracker.noteActivity(10_900);
    tracker.completeCurrent(11_000);

    expect(tracker.poll(11_999)).toEqual({
      active: true,
      stalled: false,
      newlyStalled: false,
      shouldNotify: false,
      turnId: 'turn-2',
    });
    expect(tracker.poll(12_000)).toEqual({
      active: true,
      stalled: true,
      newlyStalled: true,
      shouldNotify: true,
      turnId: 'turn-2',
    });
  });

  it('cancels only the exact failed submission and preserves queued peers', () => {
    const tracker = new CodexAppTurnLiveness(1_000);
    const first = tracker.begin('turn-1', 10_000);
    const second = tracker.begin('turn-2', 10_010);

    tracker.cancel(second, 10_100);
    expect(tracker.poll(11_000)).toMatchObject({
      stalled: true,
      shouldNotify: true,
      turnId: 'turn-1',
    });

    tracker.cancel(first, 11_100);
    expect(tracker.poll(20_000)).toEqual({
      active: false,
      stalled: false,
      newlyStalled: false,
      shouldNotify: false,
    });
  });

  it('replays a deferred inter-turn prompt when the queued control-line write is cancelled', () => {
    const tracker = new CodexAppTurnLiveness(1_000);
    tracker.begin('turn-1', 10_000);
    const second = tracker.begin('turn-2', 10_010);

    expect(tracker.completeCurrent(10_100)).toBe(false);
    // The runner briefly became empty while turn-2 was still arriving in
    // chunks, so its real prompt is held behind turn-2's liveness slot.
    expect(tracker.notePrompt(10_110)).toBe(false);
    expect(tracker.cancel(second, 10_120)).toBe(true);
    expect(tracker.hasActiveTurn()).toBe(false);
  });

  it('replays a cancelled flush prompt exactly once after every peer liveness slot drains', () => {
    const tracker = new CodexAppTurnLiveness(1_000);
    const authority = new CodexAppReadyAuthority();
    const replay = new CodexAppFlushPromptReplay();
    tracker.begin('turn-1', 10_000);
    const second = tracker.begin('turn-2', 10_010);
    const third = tracker.begin('turn-3', 10_020);

    tracker.completeCurrent(10_100);
    expect(tracker.notePrompt(10_110)).toBe(false);
    replay.cancelSubmission(tracker, authority, second, 10_120);
    expect(replay.consumeAfterFlush(tracker)).toBe(false);

    // A later flush can observe the same real prompt only after the remaining
    // peer is cancelled; the one-shot gate cannot replay it twice.
    expect(tracker.notePrompt(10_130)).toBe(false);
    replay.cancelSubmission(tracker, authority, third, 10_140);
    expect(replay.consumeAfterFlush(tracker)).toBe(true);
    expect(replay.consumeAfterFlush(tracker)).toBe(false);
  });

  it('does not replay cancellation state after an authenticated next submit supersedes the prompt', () => {
    const tracker = new CodexAppTurnLiveness(1_000);
    const authority = new CodexAppReadyAuthority();
    const replay = new CodexAppFlushPromptReplay();
    tracker.begin('turn-1', 10_000);
    const second = tracker.begin('turn-2', 10_010);
    tracker.completeCurrent(10_100);
    expect(tracker.notePrompt(10_110)).toBe(false);
    tracker.noteSubmitted(10_120);
    authority.beginWork();
    replay.cancelSubmission(tracker, authority, second, 10_130);
    expect(replay.consumeAfterFlush(tracker)).toBe(false);
  });

  it('discards a deferred inter-turn prompt once the next turn really starts', () => {
    const tracker = new CodexAppTurnLiveness(1_000);
    tracker.begin('turn-1', 10_000);
    tracker.begin('turn-2', 10_010);
    tracker.completeCurrent(10_100);
    expect(tracker.notePrompt(10_110)).toBe(false);

    tracker.noteSubmitted(10_120);
    expect(tracker.completeCurrent(10_200)).toBe(false);
  });

  it('applies only valid activity from the authenticated socket and bounds future timestamps', () => {
    const tracker = new CodexAppTurnLiveness(1_000);
    tracker.begin('turn-1', 10_000);
    tracker.begin('turn-2', 10_010);

    expect(applyTrustedCodexAppActivityMarker(tracker, {
      phase: 'forged',
      atMs: 999_999,
    }, 10_100)).toEqual({ accepted: false });
    expect(tracker.poll(10_100)).toMatchObject({ turnId: 'turn-1', stalled: false });
    expect(tracker.poll(11_000)).toMatchObject({ turnId: 'turn-1', stalled: true });

    expect(applyTrustedCodexAppActivityMarker(tracker, {
      phase: 'completed',
      atMs: 11_100,
    }, 11_100)).toMatchObject({ accepted: true, phase: 'completed' });
    expect(tracker.poll(11_100)).toMatchObject({ turnId: 'turn-2', stalled: false });

    // Even an authenticated runner timestamp is bounded by receipt time.
    expect(applyTrustedCodexAppActivityMarker(tracker, {
      phase: 'progress',
      atMs: 999_999,
    }, 11_200)).toMatchObject({ accepted: true, phase: 'progress' });
    expect(tracker.poll(12_200)).toMatchObject({ turnId: 'turn-2', stalled: true });
  });

  it('uses a prompt only to close a synthetic authenticated reattach observation', () => {
    const tracker = new CodexAppTurnLiveness(1_000);
    tracker.beginReattachObservation(10_000);
    expect(tracker.notePrompt(10_100)).toBe(true);
    expect(tracker.poll(20_000).stalled).toBe(false);

    tracker.begin('turn-1', 20_000);
    tracker.begin('turn-2', 20_010);
    expect(tracker.notePrompt(20_100)).toBe(false);
    expect(tracker.poll(21_000)).toMatchObject({
      stalled: true,
      turnId: 'turn-1',
    });
  });

  it('does not install duplicate reattach observations over a tracked turn', () => {
    const tracker = new CodexAppTurnLiveness(1_000);
    tracker.begin('turn-1', 10_000);
    expect(tracker.beginReattachObservation(10_100)).toBeUndefined();
    expect(tracker.poll(11_000)).toMatchObject({
      stalled: true,
      turnId: 'turn-1',
    });
  });

  it('recovers an explicit active slot from a submitted marker after worker reattach', () => {
    const tracker = new CodexAppTurnLiveness(1_000);
    tracker.noteSubmitted(10_000);

    expect(tracker.notePrompt(10_100)).toBe(false);
    expect(tracker.poll(11_000)).toMatchObject({
      active: true,
      stalled: true,
      shouldNotify: true,
    });
  });

  it('clears all state on CLI exit, kill, or worker reinitialization', () => {
    const tracker = new CodexAppTurnLiveness(1_000);
    tracker.begin('turn-1', 10_000);
    tracker.begin('turn-2', 10_010);
    tracker.clear();
    expect(tracker.poll(20_000)).toEqual({
      active: false,
      stalled: false,
      newlyStalled: false,
      shouldNotify: false,
    });
  });

  it('rejects invalid timeout configuration', () => {
    expect(() => new CodexAppTurnLiveness(0)).toThrow(/positive finite/);
    expect(() => new CodexAppTurnLiveness(Number.NaN)).toThrow(/positive finite/);
  });
});
