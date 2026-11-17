import { describe, expect, it } from 'vitest';
import { waitForListenerSetToSettle } from './helpers/tmux-listener-settle.js';

const A = 100;
const B = 200;
const X = 300; // a short-lived or competing third listener

/** Deterministic harness: a scripted pid source driven by a fake clock. */
function harness(source: (readIndex: number) => number[] | null, opts: {
  deadlineMs?: number; stableMs?: number; pollMs?: number;
} = {}) {
  let clock = 0;
  let reads = 0;
  const sleep = (ms: number) => { clock += ms; };
  const now = () => clock;
  const readPids = () => source(reads++);
  const result = waitForListenerSetToSettle([A, B], {
    readPids, sleep, now, pollMs: 10, stableMs: 30, deadlineMs: 200, ...opts,
  });
  return { result, reads };
}

describe('waitForListenerSetToSettle', () => {
  it('passes once a short-lived extra listener disappears and the set stays at [A,B]', () => {
    // The competing child's fd is enumerated for the first two polls, then gone.
    const { result, reads } = harness(i => (i < 2 ? [A, B, X] : [A, B]));
    expect(result.settled).toBe(true);
    expect(result.pids).toEqual([A, B]);
    // It actually waited out the stability window instead of returning on first sight.
    expect(reads).toBeGreaterThan(3);
  });

  it('fails when an extra listener persists for the whole deadline', () => {
    const { result } = harness(() => [A, B, X]);
    expect(result.settled).toBe(false);
    expect(result.pids).toEqual([A, B, X]);
  });

  it('fails when an extra listener keeps reappearing, never holding a stable window', () => {
    // Alternates every poll, so [A,B] never persists for the 30ms stable window.
    const { result } = harness(i => (i % 2 === 0 ? [A, B, X] : [A, B]));
    expect(result.settled).toBe(false);
  });

  it('treats a null census (proc unavailable) as a non-match and still settles afterward', () => {
    const { result } = harness(i => (i < 2 ? null : [A, B]));
    expect(result.settled).toBe(true);
    expect(result.pids).toEqual([A, B]);
  });

  it('fails rather than settle on a missing expected listener', () => {
    const { result } = harness(() => [A]);
    expect(result.settled).toBe(false);
    expect(result.pids).toEqual([A]);
  });

  it('normalizes ordering so an unordered census still matches the expected set', () => {
    const { result } = harness(() => [B, A]);
    expect(result.settled).toBe(true);
    expect(result.pids).toEqual([A, B]);
  });
});
