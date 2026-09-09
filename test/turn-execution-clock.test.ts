import { describe, expect, it } from 'vitest';
import { TurnExecutionClock } from '../src/services/turn-execution-clock.js';

describe('TurnExecutionClock', () => {
  it('measures from the literal write, not from when the turn was queued', () => {
    const clock = new TurnExecutionClock();
    // Queued at t=1000 (not observed by the clock), written at t=5000.
    clock.start('turn_a', 1, 5_000);
    expect(clock.settle('turn_a', 1, undefined, 7_400)).toEqual({
      completedAtMs: 7_400,
      durationMs: 2_400,
    });
  });

  it('reports the completion instant but no duration when the start is unknown', () => {
    const clock = new TurnExecutionClock();
    // A terminal for a turn this worker never wrote (recovered/replayed attempt):
    // an absent duration is honest; a zero or a guess would not be.
    expect(clock.settle('turn_never_written', 0, undefined, 9_000)).toEqual({ completedAtMs: 9_000 });
  });

  it('a submission refused before the write reports a failure instant but no execution span', () => {
    // Regression: a durable submit can be refused by a pre-write guard (e.g. the
    // reliable-terminal bridge unavailable check) BEFORE a single byte is handed
    // to the CLI. Such a turn never executed, so it must not be armed and its
    // `failed` terminal carries completedAtMs (the failure instant) but no
    // durationMs — otherwise near-zero fake durations pollute failure/p95 stats.
    const clock = new TurnExecutionClock();
    // Pre-write guard refuses the submission: start() is deliberately never called.
    expect(clock.settle('turn_refused_preflight', 1, undefined, 12_000)).toEqual({
      completedAtMs: 12_000,
    });
    expect(clock.size()).toBe(0);
  });

  it('prefers a backend-supplied completion instant but never lets it exceed now', () => {
    const clock = new TurnExecutionClock();
    clock.start('turn_b', undefined, 1_000);
    // Runner's own timestamp, earlier than our handling of the marker: trusted.
    expect(clock.settle('turn_b', undefined, 3_000, 4_500)).toEqual({
      completedAtMs: 3_000,
      durationMs: 2_000,
    });

    clock.start('turn_c', undefined, 1_000);
    // A future-dated (skewed or forged) runner clock is clamped to now.
    expect(clock.settle('turn_c', undefined, 99_000, 4_000)).toEqual({
      completedAtMs: 4_000,
      durationMs: 3_000,
    });
  });

  it('withholds the duration when the completion instant predates the write', () => {
    const clock = new TurnExecutionClock();
    clock.start('turn_skew', undefined, 8_000);
    // Backend clock disagrees with ours; publish the instant, not a negative span.
    expect(clock.settle('turn_skew', undefined, 5_000, 9_000)).toEqual({ completedAtMs: 5_000 });
  });

  it('consumes the entry so a duplicate terminal cannot report a second duration', () => {
    const clock = new TurnExecutionClock();
    clock.start('turn_d', 2, 1_000);
    expect(clock.settle('turn_d', 2, undefined, 2_000)).toEqual({ completedAtMs: 2_000, durationMs: 1_000 });
    expect(clock.settle('turn_d', 2, undefined, 3_000)).toEqual({ completedAtMs: 3_000 });
    expect(clock.size()).toBe(0);
  });

  it('peek reports the same numbers without consuming, so both settlement phases agree', () => {
    const clock = new TurnExecutionClock();
    clock.start('turn_e', 3, 1_000);
    // codex-app: the daemon-synthesized terminal peeks, the worker's own
    // terminal then settles. Both must publish identical numbers.
    const peeked = clock.peek('turn_e', 3, 4_000, 5_000);
    const settled = clock.settle('turn_e', 3, 4_000, 5_000);
    expect(peeked).toEqual({ completedAtMs: 4_000, durationMs: 3_000 });
    expect(settled).toEqual(peeked);
    expect(clock.size()).toBe(0);
  });

  it('scopes the window per dispatch attempt', () => {
    const clock = new TurnExecutionClock();
    clock.start('turn_f', 1, 1_000);
    clock.start('turn_f', 2, 4_000);
    expect(clock.settle('turn_f', 2, undefined, 5_000)).toEqual({ completedAtMs: 5_000, durationMs: 1_000 });
    expect(clock.settle('turn_f', 1, undefined, 5_000)).toEqual({ completedAtMs: 5_000, durationMs: 4_000 });
  });

  it('re-arming a key restarts the measurement (a resubmit really does restart the work)', () => {
    const clock = new TurnExecutionClock();
    clock.start('turn_g', 0, 1_000);
    clock.start('turn_g', 0, 6_000);
    expect(clock.settle('turn_g', 0, undefined, 6_500)).toEqual({ completedAtMs: 6_500, durationMs: 500 });
  });

  it('bounds retained starts so abandoned turns cannot leak', () => {
    const clock = new TurnExecutionClock(3);
    for (let i = 0; i < 10; i++) clock.start(`turn_${i}`, undefined, 1_000 + i);
    expect(clock.size()).toBe(3);
    // The oldest unsettled starts were evicted; the newest survive with timing.
    expect(clock.settle('turn_0', undefined, undefined, 2_000)).toEqual({ completedAtMs: 2_000 });
    expect(clock.settle('turn_9', undefined, undefined, 2_000)).toEqual({ completedAtMs: 2_000, durationMs: 991 });
  });

  it('forget and clear drop tracked starts without emitting timing', () => {
    const clock = new TurnExecutionClock();
    clock.start('turn_h', undefined, 1_000);
    clock.forget('turn_h', undefined);
    expect(clock.settle('turn_h', undefined, undefined, 2_000)).toEqual({ completedAtMs: 2_000 });

    clock.start('turn_i', undefined, 1_000);
    clock.start('turn_j', undefined, 1_000);
    clock.clear();
    expect(clock.size()).toBe(0);
  });

  it('ignores empty turn ids on every entry point', () => {
    const clock = new TurnExecutionClock();
    clock.start(undefined, 1, 1_000);
    clock.start('', 1, 1_000);
    expect(clock.size()).toBe(0);
    expect(clock.settle(undefined, 1, undefined, 2_000)).toBeUndefined();
    expect(clock.peek(undefined, 1, undefined, 2_000)).toBeUndefined();
  });
});
