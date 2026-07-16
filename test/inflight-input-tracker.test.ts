/**
 * InflightInputTracker — the state machine that re-queues user inputs across
 * a CLI crash.
 *
 * Regression for the 2026-06-10 incident: a bot-to-bot @mention spawned a
 * fresh codex session, the worker wrote the prompt to the PTY, codex exited
 * code 1 ~3s later WITHOUT recording the submit (history.jsonl has no entry),
 * the auto-restart brought up an idle CLI, and nothing re-delivered — the
 * session sat at 「等待输入」 forever and the message was silently lost
 * (killCli wipes pendingMessages; the item had already been dequeued).
 *
 * Run:  pnpm vitest run test/inflight-input-tracker.test.ts
 */
import { describe, it, expect } from 'vitest';

import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';

const item = (content: string, turnId?: string) => ({ content, turnId });

describe('InflightInputTracker', () => {
  it('incident shape: write → CLI crash → respawn re-queues the lost input', () => {
    const t = new InflightInputTracker();
    t.onWrite(item('review PR #159', 'turn-1'));

    expect(t.onCliExit()).toBe(1);

    const carry = t.takeCarryOver();
    expect(carry).toEqual([{ content: 'review PR #159', turnId: 'turn-1' }]);
    // Consumed exactly once — a second spawn gets nothing.
    expect(t.takeCarryOver()).toEqual([]);
  });

  it('preserves the Codex App structured sidecar across a crash replay', () => {
    const t = new InflightInputTracker();
    const codexAppInput = {
      text: 'clean',
      additionalContext: { botmux_sender: { kind: 'untrusted' as const, value: 'Alice' } },
    };
    t.onWrite({ content: '<legacy />', turnId: 'om_1', codexAppInput });
    expect(t.onCliExit()).toBe(1);
    expect(t.takeCarryOver()).toEqual([{ content: '<legacy />', turnId: 'om_1', codexAppInput }]);
  });

  it('completed turn: idle clears in-flight, a later crash re-queues nothing', () => {
    const t = new InflightInputTracker();
    t.onWrite(item('hello'));
    t.onTurnComplete();

    expect(t.onCliExit()).toBe(0);
    expect(t.takeCarryOver()).toEqual([]);
  });

  it('durable terminal clears the attempt before a later CLI exit can carry it over', () => {
    const t = new InflightInputTracker();
    t.onWrite({ content: 'meeting delivery', turnId: 'delivery-1', dispatchAttempt: 3 });

    // worker emitTurnTerminal uses this same completion edge before releasing
    // the durable arbiter back to the receiver-owned replay loop.
    t.onTurnComplete();

    expect(t.onCliExit()).toBe(0);
    expect(t.takeCarryOver()).toEqual([]);
  });

  it('CLI exit leaves durable replay to the receiver while preserving ordinary carry-over', () => {
    const t = new InflightInputTracker();
    t.onWrite({ content: 'ordinary IM', turnId: 'im-1' });
    t.onWrite({ content: 'meeting delivery', turnId: 'delivery-1', dispatchAttempt: 2 });

    expect(t.onCliExit(item => item.dispatchAttempt === undefined)).toBe(1);
    expect(t.takeCarryOver()).toEqual([{ content: 'ordinary IM', turnId: 'im-1' }]);
  });

  it('preserves a clean explicit-IM envelope but leaves a clean durable replay to the receiver', () => {
    const t = new InflightInputTracker();
    const codexAppInput = { text: 'clean' };
    const origin = {
      listenerAppId: 'listener', meetingId: 'meeting', memberId: 'member',
      memberEpoch: 1, agentAppId: 'agent', ownerBootId: 'boot', ownerEpoch: 1,
      membershipGeneration: 1, sinkOwnerGeneration: 1,
      receiverSessionId: 'receiver', larkMessageId: 'im-clean',
    };
    t.onWrite({
      content: '<legacy IM />',
      turnId: 'im-clean',
      vcMeetingImTurnOrigin: origin,
      codexAppInput,
    });
    t.onWrite({
      content: '<legacy delivery />',
      turnId: 'delivery-clean',
      dispatchAttempt: 7,
      codexAppInput,
    });

    expect(t.onCliExit(item => item.dispatchAttempt === undefined)).toBe(1);
    expect(t.takeCarryOver()).toEqual([{
      content: '<legacy IM />',
      turnId: 'im-clean',
      vcMeetingImTurnOrigin: origin,
      codexAppInput,
    }]);
  });

  it('type-ahead: multiple writes before idle are all carried over in order', () => {
    const t = new InflightInputTracker();
    t.onWrite(item('msg-1', 'a'));
    t.onWrite(item('msg-2', 'b'));

    expect(t.onCliExit()).toBe(2);
    expect(t.takeCarryOver().map(i => i.content)).toEqual(['msg-1', 'msg-2']);
  });

  it('double exit before respawn keeps the earlier stash (appends, not replaces)', () => {
    const t = new InflightInputTracker();
    t.onWrite(item('first'));
    expect(t.onCliExit()).toBe(1);

    // Second exit with nothing newly in flight must not drop the stash.
    expect(t.onCliExit()).toBe(0);
    expect(t.takeCarryOver().map(i => i.content)).toEqual(['first']);
  });

  it('exit → stash → new write before consume → second exit appends both batches', () => {
    const t = new InflightInputTracker();
    t.onWrite(item('first'));
    t.onCliExit();
    t.onWrite(item('second'));
    t.onCliExit();

    expect(t.takeCarryOver().map(i => i.content)).toEqual(['first', 'second']);
  });

  it('takeCarryOver on a fresh spawn drops stale in-flight entries from a previous life', () => {
    const t = new InflightInputTracker();
    // A detach-style kill never fires onExit, so unacked could go stale.
    t.onWrite(item('stale'));
    expect(t.takeCarryOver()).toEqual([]);   // nothing stashed — nothing replayed
    // The stale entry must be gone: a later exit has nothing to stash.
    expect(t.onCliExit()).toBe(0);
  });

  it('full lifecycle: turns complete normally, only the crashed turn replays', () => {
    const t = new InflightInputTracker();
    // Turn 1 — normal.
    t.onWrite(item('turn-1'));
    t.onTurnComplete();
    // Turn 2 — crash mid-turn.
    t.onWrite(item('turn-2'));
    expect(t.onCliExit()).toBe(1);
    expect(t.takeCarryOver().map(i => i.content)).toEqual(['turn-2']);
    // Turn 3 on the fresh CLI — normal again, nothing lingers.
    t.onWrite(item('turn-3'));
    t.onTurnComplete();
    expect(t.onCliExit()).toBe(0);
    expect(t.takeCarryOver()).toEqual([]);
  });
});
