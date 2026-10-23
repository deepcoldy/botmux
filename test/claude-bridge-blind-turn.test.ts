import { describe, expect, it } from 'vitest';
import {
  BLIND_TURN_MIN_BUSY_MS,
  BridgeBlindTurnWatch,
  blindTurnNeedsNotice,
} from '../src/services/claude-bridge-blind-turn.js';

const OLD = '/claude/projects/-w/6b50f4a4-3392-43df-837b-02261f498b43.jsonl';
const NEW = '/claude/projects/-w/76cd870a-7bd4-46e7-b191-34290ff42dc2.jsonl';
const LONG = BLIND_TURN_MIN_BUSY_MS + 1;

describe('BridgeBlindTurnWatch', () => {
  it('a turn whose transcript grew, or that moved the bridge to another file, was read', () => {
    const watch = new BridgeBlindTurnWatch();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 0);
    expect(watch.noteTurnEnded({ path: OLD, offset: 180 }, LONG)).toEqual({ kind: 'read' });
    watch.noteTurnStarted({ path: OLD, offset: 180 }, 0);
    expect(watch.noteTurnEnded({ path: NEW, offset: 0 }, LONG)).toEqual({ kind: 'read' });
  });

  it('a turn the bridge read nothing of is blind; a run of them replays from the first', () => {
    const watch = new BridgeBlindTurnWatch();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 1_000);
    // Repeated evidence of the same turn keeps its start.
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 1_500);
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, 1_000 + LONG))
      .toEqual({ kind: 'blind', turnStartedAtMs: 1_000, blindSinceMs: 1_000, reported: false });
    watch.noteReported();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 90_000);
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, 90_000 + LONG))
      .toEqual({ kind: 'blind', turnStartedAtMs: 90_000, blindSinceMs: 1_000, reported: true });
  });

  it('a read turn ends the run: the next blind one starts a new run and is reported again', () => {
    const watch = new BridgeBlindTurnWatch();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 0);
    watch.noteTurnEnded({ path: OLD, offset: 100 }, LONG);
    watch.noteReported();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 10_000);
    expect(watch.noteTurnEnded({ path: OLD, offset: 200 }, 10_000 + LONG)).toEqual({ kind: 'read' });
    watch.noteTurnStarted({ path: OLD, offset: 200 }, 20_000);
    expect(watch.noteTurnEnded({ path: OLD, offset: 200 }, 20_000 + LONG))
      .toEqual({ kind: 'blind', turnStartedAtMs: 20_000, blindSinceMs: 20_000, reported: false });
  });

  it('judges nothing without turn evidence, for a brief flicker, or after a teardown', () => {
    const watch = new BridgeBlindTurnWatch();
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, LONG)).toEqual({ kind: 'none' });
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 0);
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, BLIND_TURN_MIN_BUSY_MS - 1)).toEqual({ kind: 'none' });
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 0);
    watch.reset();
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, LONG)).toEqual({ kind: 'none' });
  });
});

describe('blindTurnNeedsNotice', () => {
  it('always when the transcript is how every reply reaches the group', () => {
    expect(blindTurnNeedsNotice({ transcriptCarriesEveryReply: true, unreadLarkTurn: false, sentDuringTurn: true })).toBe(true);
  });

  it('with `botmux send` delivery, only for a Lark turn the model did not answer itself', () => {
    expect(blindTurnNeedsNotice({ transcriptCarriesEveryReply: false, unreadLarkTurn: true, sentDuringTurn: false })).toBe(true);
    expect(blindTurnNeedsNotice({ transcriptCarriesEveryReply: false, unreadLarkTurn: true, sentDuringTurn: true })).toBe(false);
    // A terminal-local turn is never forwarded in this mode, read or not.
    expect(blindTurnNeedsNotice({ transcriptCarriesEveryReply: false, unreadLarkTurn: false, sentDuringTurn: false })).toBe(false);
  });
});
