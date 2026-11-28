import { describe, expect, it } from 'vitest';
import { TraexTurnCompletionTracker } from '../src/services/traex-turn-completion.js';
import type { CodexBridgeEvent } from '../src/services/codex-transcript.js';

const event = (kind: 'user' | 'assistant_final', turn: string, timestampMs: number, uuid = `${kind}:${turn}`): CodexBridgeEvent => ({
  kind, uuid, sourceTurnId: turn, sourceSessionId: 'session', timestampMs, text: '',
});

describe('latest TRAE native turn completion', () => {
  it('accepts only the latest native turn final, including terminal input without a Botmux mark', () => {
    const tracker = new TraexTurnCompletionTracker();
    expect(tracker.observe([event('user', 'old', 1), event('assistant_final', 'old', 2)], 1))
      .toEqual({ started: true, completed: true });
    expect(tracker.observe([event('user', 'manual', 3)], 1)).toEqual({ started: true, completed: false });
    expect(tracker.observe([event('assistant_final', 'old', 2)], 1)).toEqual({ started: false, completed: false });
    expect(tracker.observe([event('assistant_final', 'old', 4, 'replayed-old-final')], 1)).toEqual({ started: false, completed: false });
    expect(tracker.observe([event('assistant_final', 'manual', 5)], 1)).toEqual({ started: false, completed: true });
  });

  it('does not reuse an older native user replay or another session final', () => {
    const tracker = new TraexTurnCompletionTracker();
    tracker.observe([event('user', 'latest', 10)], 1);
    expect(tracker.observe([event('user', 'old', 1, 'copied-old-user'), event('assistant_final', 'old', 2)], 1)).toEqual({ started: false, completed: false });
    expect(tracker.observe([{ ...event('assistant_final', 'latest', 11), sourceSessionId: 'other' }], 1)).toEqual({ started: false, completed: false });
  });

  it('deduplicates identical native records copied into another rollout segment', () => {
    const tracker = new TraexTurnCompletionTracker();
    const user = { ...event('user', 'turn', 1), rawId: 'raw-user' };
    tracker.observe([user], 1);
    expect(tracker.observe([{ ...user, uuid: 'another-segment:1' }], 1)).toEqual({ started: false, completed: false });
  });

  it('does not reopen a closed turn from a new-uuid mirror of its native user', () => {
    const tracker = new TraexTurnCompletionTracker();
    tracker.observe([event('user', 'turn', 1), event('assistant_final', 'turn', 2)], 1);
    expect(tracker.observe([event('user', 'turn', 1, 'new-user-mirror')], 1)).toEqual({ started: false, completed: false });
  });

  it('deduplicates a native user uuid while its turn is still open', () => {
    const tracker = new TraexTurnCompletionTracker();
    const user = event('user', 'turn', 1);
    tracker.observe([user], 1);
    expect(tracker.observe([user], 1)).toEqual({ started: false, completed: false });
  });

  it('resets ownership with a new CLI generation and requires a native user before completion', () => {
    const tracker = new TraexTurnCompletionTracker();
    tracker.observe([event('user', 'old', 1)], 1);
    expect(tracker.observe([event('assistant_final', 'old', 2)], 2)).toEqual({ started: false, completed: false });
    expect(tracker.observe([event('user', 'new', 3), event('assistant_final', 'new', 4)], 2)).toEqual({ started: true, completed: true });
  });

  it('does not close a newer user in the same drain batch with a prior final', () => {
    const tracker = new TraexTurnCompletionTracker();
    expect(tracker.observe([event('user', 'first', 1), event('assistant_final', 'first', 2), event('user', 'next', 3)], 1))
      .toEqual({ started: true, completed: false });
  });
});
