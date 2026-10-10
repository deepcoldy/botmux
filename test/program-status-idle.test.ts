/**
 * OSC 7501 authority mode on IdleDetector.
 *
 * Screen quiescence stays in charge until the first accepted report. After
 * that, only the folded records move idle: a prompt redraw cannot reopen a
 * finished turn, and `blocked` must not complete one.
 *
 * Run: bun x vitest run test/program-status-idle.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  IdleDetector,
  PROGRAM_STATUS_FALLBACK_MS,
} from '../src/utils/idle-detector.js';
import type { CliAdapter } from '../src/adapters/cli/types.js';

function makeCli(): CliAdapter {
  return {
    id: 'test-cli',
    resolvedBin: '/usr/bin/test-cli',
    buildArgs: () => [],
    writeInput: async () => {},
    readyPattern: /❯/,
    systemHints: [],
    altScreen: false,
  };
}

describe('IdleDetector program status', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps heuristics until the first accepted report', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.feed('prompt ❯');
    vi.advanceTimersByTime(2_000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('screen');
    expect(detector.programStatusActive()).toBe(false);
    detector.dispose();
  });

  it('holds working through a long quiet redraw and completes on done', () => {
    const detector = new IdleDetector(makeCli());
    const idle = vi.fn();
    const busy = vi.fn();
    detector.onIdle(idle);
    detector.onBusy(busy);

    detector.observeProgramStatus({ state: 'working', progress: 10 });
    detector.feed('still thinking ❯');
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(idle).not.toHaveBeenCalled();
    expect(busy).not.toHaveBeenCalled();

    detector.observeProgramStatus({ state: 'working', progress: 40 });
    expect(idle).not.toHaveBeenCalled();

    detector.observeProgramStatus({ state: 'done' });
    expect(idle).toHaveBeenCalledTimes(1);
    expect(idle).toHaveBeenCalledWith('program-status');

    detector.feed('prompt redraw ❯');
    vi.advanceTimersByTime(10_000);
    expect(idle).toHaveBeenCalledTimes(1);

    detector.observeProgramStatus({ state: 'working' });
    expect(busy).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('does not complete a turn on blocked, including an unrecognized kind', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.observeProgramStatus({
      state: 'blocked',
      kind: 'permission',
      msg: 'Allow this edit?',
    });
    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();
    expect(detector.programStatusBlock()).toEqual({
      kind: 'permission',
      msg: 'Allow this edit?',
    });

    detector.observeProgramStatus({ state: 'blocked', kind: 'other', msg: 'wait' });
    expect(detector.programStatusBlock()).toEqual({ msg: 'wait' });
    expect(cb).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('keeps the session busy while any child is working or blocked', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.observeProgramStatus({ state: 'working', id: 'agent/1' });
    detector.observeProgramStatus({ state: 'done' });
    expect(cb).not.toHaveBeenCalled();

    detector.observeProgramStatus({
      state: 'blocked',
      id: 'agent/1',
      kind: 'question',
      msg: 'Which file?',
    });
    expect(cb).not.toHaveBeenCalled();
    expect(detector.programStatusBlock()).toEqual({
      kind: 'question',
      msg: 'Which file?',
    });

    detector.observeProgramStatus({ state: 'clear', id: 'agent' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('program-status');
    expect(detector.programStatusBlock()).toBeNull();
    detector.dispose();
  });

  it('publishes error as a terminal edge and keeps the message', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.observeProgramStatus({ state: 'error', msg: 'rate limited' });
    expect(cb).toHaveBeenCalledWith('program-status');
    expect(detector.programStatusError()).toBe('rate limited');
    detector.dispose();
  });

  it('ignores a malformed id and strips controls and bidi from msg', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.observeProgramStatus({ state: 'idle', id: 'not a path' });
    expect(cb).not.toHaveBeenCalled();
    expect(detector.programStatusActive()).toBe(false);

    detector.observeProgramStatus({
      state: 'blocked',
      kind: 'question',
      msg: 'line\nbreak\u202ego',
    });
    expect(cb).not.toHaveBeenCalled();
    expect(detector.programStatusActive()).toBe(true);
    expect(detector.programStatusBlock()).toEqual({
      kind: 'question',
      msg: 'linebreakgo',
    });

    detector.observeProgramStatus({ state: 'done', msg: '\n\u202e' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('program-status');
    detector.dispose();
  });

  it('does not let fireIdle flush a turn that still has a working or blocked record', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.observeProgramStatus({ state: 'working', id: 'agent/1' });
    detector.observeProgramStatus({
      state: 'blocked',
      kind: 'question',
      msg: 'Which file?',
    });
    detector.fireIdle();
    expect(cb).not.toHaveBeenCalled();

    detector.observeProgramStatus({ state: 'clear', id: 'agent/1' });
    detector.fireIdle();
    expect(cb).not.toHaveBeenCalled();

    detector.observeProgramStatus({ state: 'idle' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('program-status');

    detector.reset();
    detector.fireIdle();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith('external');
    detector.dispose();
  });

  it('keeps the root record when child records exceed the cap', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.observeProgramStatus({ state: 'done' });
    expect(cb).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 64; i++) {
      detector.observeProgramStatus({ state: 'working', id: `c${i}` });
    }
    expect(cb).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 64; i++) {
      detector.observeProgramStatus({ state: 'clear', id: `c${i}` });
    }
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith('program-status');
    detector.dispose();
  });

  it('holds a terminal report while the startup banner is still loading', () => {
    const detector = new IdleDetector({
      ...makeCli(),
      startupPendingPattern: /LOADING/,
      startupReadyPattern: /READY/,
    });
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.feed('LOADING model');
    expect(detector.isStartupPending()).toBe(true);

    detector.observeProgramStatus({ state: 'idle' });
    expect(detector.isStartupPending()).toBe(true);
    expect(cb).not.toHaveBeenCalled();

    detector.feed('READY ❯');
    expect(detector.isStartupPending()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('program-status');
    detector.dispose();
  });

  it('drops authority on a root clear and lets the screen path resume', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.observeProgramStatus({ state: 'working' });
    detector.feed('prompt ❯');
    detector.observeProgramStatus({ state: 'clear' });
    expect(detector.programStatusActive()).toBe(false);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('screen');
    detector.dispose();
  });

  it('forgets a stale idle on submit and falls back only if no report returns', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.observeProgramStatus({ state: 'idle' });
    expect(cb).toHaveBeenCalledTimes(1);

    detector.reset();
    detector.feed('prompt ❯');
    vi.advanceTimersByTime(PROGRAM_STATUS_FALLBACK_MS - 1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(detector.programStatusActive()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(detector.programStatusActive()).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(2, 'screen');
    detector.dispose();
  });

  it('does not fall back while a fresh working report is held', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.observeProgramStatus({ state: 'idle' });
    detector.reset();
    detector.observeProgramStatus({ state: 'working' });
    detector.feed('long think ❯');
    vi.advanceTimersByTime(PROGRAM_STATUS_FALLBACK_MS + 10_000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(detector.programStatusActive()).toBe(true);
    detector.dispose();
  });

  it('republishes a terminal snapshot at the SessionStart boundary', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.observeProgramStatus({ state: 'idle' });
    detector.resetReadyEvidence();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(2, 'program-status');

    const working = new IdleDetector(makeCli());
    const workingCb = vi.fn();
    working.onIdle(workingCb);
    working.observeProgramStatus({ state: 'working' });
    working.resetReadyEvidence();
    expect(workingCb).not.toHaveBeenCalled();
    working.dispose();
    detector.dispose();
  });

  it('preserves active working and blocked records across reset and does not arm fallback', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.observeProgramStatus({ state: 'working', msg: 'thinking' });
    detector.observeProgramStatus({ state: 'blocked', id: 'perm', kind: 'permission', msg: 'allow' });

    // reset() (e.g. from type-ahead submit cycle) must keep working & blocked records
    detector.reset();
    expect(detector.programStatusActive()).toBe(true);
    expect(detector.programStatusBlock()).toEqual({ kind: 'permission', msg: 'allow' });

    // Advancing past fallback window must NOT exit authority or allow screen prompt to trigger idle
    vi.advanceTimersByTime(PROGRAM_STATUS_FALLBACK_MS + 5_000);
    expect(detector.programStatusActive()).toBe(true);
    detector.feed('❯');
    vi.advanceTimersByTime(2_000);
    expect(cb).not.toHaveBeenCalled();

    // Now resolve blocked child and root
    detector.observeProgramStatus({ state: 'done', id: 'perm' });
    detector.observeProgramStatus({ state: 'done' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('program-status');
    detector.dispose();
  });

  it('evicts terminal children first on record cap so active child is not prematurely dropped', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    // Active busy child created early
    detector.observeProgramStatus({ state: 'working', id: 'long-worker' });

    // Push 70 completed terminal children (over 64 cap)
    for (let i = 0; i < 70; i++) {
      detector.observeProgramStatus({ state: 'done', id: `child-${i}` });
    }

    // Root reports done: since long-worker was NOT evicted, overall status is still working
    detector.observeProgramStatus({ state: 'done' });
    expect(cb).not.toHaveBeenCalled();

    // Finally long-worker completes -> now idle fires
    detector.observeProgramStatus({ state: 'done', id: 'long-worker' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('program-status');
    detector.dispose();
  });

  it('retains sticky busy evidence when all records are busy so later terminal root does not prematurely idle', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    // Push 70 active busy children with no terminal records (all working, exceeds 64 cap).
    // The oldest busy children (e.g. busy-0..busy-5) get evicted, but are tracked in evictedBusyIds.
    for (let i = 0; i < 70; i++) {
      detector.observeProgramStatus({ state: 'working', id: `busy-${i}` });
    }

    // Now all remaining 64 children in the map finish
    for (let i = 6; i < 70; i++) {
      detector.observeProgramStatus({ state: 'done', id: `busy-${i}` });
    }

    // Root reports done: session must NOT become idle because evicted busy children (busy-0..5) are still working!
    detector.observeProgramStatus({ state: 'done' });
    expect(cb).not.toHaveBeenCalled();

    // Settle all evicted busy children except the last one
    for (let i = 0; i < 5; i++) {
      detector.observeProgramStatus({ state: 'done', id: `busy-${i}` });
      expect(cb).not.toHaveBeenCalled();
    }

    // Finally the last evicted child finishes -> now idle fires!
    detector.observeProgramStatus({ state: 'done', id: 'busy-5' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('program-status');
    detector.dispose();
  });

  it('caps evictedBusyIds at 256 using FIFO eviction to prevent unbounded growth', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    // Push 350 active busy children (exceeds 64 record cap + 256 sticky busy cap)
    for (let i = 0; i < 350; i++) {
      detector.observeProgramStatus({ state: 'working', id: `busy-${i}` });
    }

    // Records 0..285 got evicted. Due to 256 cap, the oldest (0..29) were dropped from evictedBusyIds.
    // The remaining sticky evicted set contains the newest 256 evicted ids (30..285),
    // and records 286..349 (64 items) remain in active records map.
    // Finish all records in the active map:
    for (let i = 286; i < 350; i++) {
      detector.observeProgramStatus({ state: 'done', id: `busy-${i}` });
    }
    detector.observeProgramStatus({ state: 'done' });
    expect(cb).not.toHaveBeenCalled();

    // Settle all retained sticky evicted items (30..285)
    for (let i = 30; i < 286; i++) {
      detector.observeProgramStatus({ state: 'done', id: `busy-${i}` });
    }

    // Now all tracked busy items are settled -> idle fires (dropped rogue items 0..29 did not permanently lock the session)!
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('program-status');
    detector.dispose();
  });

  it('retains authority and does not idle when clear empties visible records but evicted busy children remain', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    // Push 70 working items: 6 are evicted into evictedBusyIds, 64 are in programStatusRecords.
    for (let i = 0; i < 70; i++) {
      detector.observeProgramStatus({ state: 'working', id: `child-${i}` });
    }

    // Clear all 64 items in programStatusRecords (child-6..child-69).
    for (let i = 6; i < 70; i++) {
      detector.observeProgramStatus({ state: 'clear', id: `child-${i}` });
    }

    // programStatusRecords is now empty (size === 0), but evictedBusyIds has child-0..child-5.
    // A root done should NOT trigger idle because evicted busy children are still running!
    detector.observeProgramStatus({ state: 'done' });
    expect(cb).not.toHaveBeenCalled();

    // Finish the remaining evicted items:
    for (let i = 0; i < 6; i++) {
      detector.observeProgramStatus({ state: 'done', id: `child-${i}` });
    }

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('program-status');
    detector.dispose();
  });
});

