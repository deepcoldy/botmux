import { describe, expect, it } from 'vitest';
import {
  localParts,
  parseHhMmToMinutes,
  evaluateDue,
} from '../src/core/maintenance-schedule.js';

const TZ = 'Asia/Shanghai'; // UTC+8, no DST
// 2026-06-07T04:00:00Z === 2026-06-07 12:00 local (minutesOfDay = 720)
const NOON = Date.parse('2026-06-07T04:00:00.000Z');
const MIN = 60_000;

describe('localParts', () => {
  it('converts epoch to local date string + minutes-of-day in Asia/Shanghai', () => {
    expect(localParts(NOON, TZ)).toEqual({ dateStr: '2026-06-07', minutesOfDay: 720 });
  });
  it('rolls the date at the local midnight boundary, not UTC', () => {
    // 2026-06-06T17:30:00Z === 2026-06-07 01:30 local
    expect(localParts(Date.parse('2026-06-06T17:30:00.000Z'), TZ))
      .toEqual({ dateStr: '2026-06-07', minutesOfDay: 90 });
  });
});

describe('parseHhMmToMinutes', () => {
  it('parses HH:MM into minutes of day', () => {
    expect(parseHhMmToMinutes('00:00')).toBe(0);
    expect(parseHhMmToMinutes('04:30')).toBe(270);
    expect(parseHhMmToMinutes('4:05')).toBe(245);
    expect(parseHhMmToMinutes('23:59')).toBe(1439);
  });
  it('returns null for invalid input', () => {
    expect(parseHhMmToMinutes('99:99')).toBeNull();
    expect(parseHhMmToMinutes('nope')).toBeNull();
  });
});

describe('evaluateDue', () => {
  const opts = { tz: TZ, graceMinutes: 60 };
  // 2026-06-07T16:10:00Z === 2026-06-08 00:10 local (just past midnight)
  const PAST_MIDNIGHT = Date.parse('2026-06-07T16:10:00.000Z');

  it('disabled when not enabled', () => {
    expect(evaluateDue({ enabled: false, time: '12:00' }, undefined, NOON, opts).decision).toBe('disabled');
  });
  it('disabled when time missing or invalid', () => {
    expect(evaluateDue({ enabled: true }, undefined, NOON, opts).decision).toBe('disabled');
    expect(evaluateDue({ enabled: true, time: '99:99' }, undefined, NOON, opts).decision).toBe('disabled');
  });
  it('idle before the scheduled minute when yesterday is already handled (no-op)', () => {
    // now 12:00 < T 13:00 → the most-recent occurrence is yesterday's, which
    // lastDate marks done → already-handled (a no-op, like not-yet, in the tick).
    expect(evaluateDue({ enabled: true, time: '13:00' }, '2026-06-06', NOON, opts).decision).toBe('already-handled');
  });
  it('due exactly at the scheduled minute, marks today', () => {
    const r = evaluateDue({ enabled: true, time: '12:00' }, undefined, NOON, opts);
    expect(r.decision).toBe('due');
    expect(r.markDate).toBe('2026-06-07');
  });
  it('due when late but within the grace window', () => {
    expect(evaluateDue({ enabled: true, time: '11:30' }, undefined, NOON, opts).decision).toBe('due');
  });
  it('missed when past the scheduled minute + grace, marks today', () => {
    const r = evaluateDue({ enabled: true, time: '10:00' }, undefined, NOON, opts);
    expect(r.decision).toBe('missed');
    expect(r.markDate).toBe('2026-06-07');
  });
  it('already-handled when lastDate equals today (fired or skipped earlier today)', () => {
    expect(evaluateDue({ enabled: true, time: '11:30' }, '2026-06-07', NOON, opts).decision).toBe('already-handled');
    expect(evaluateDue({ enabled: true, time: '12:00' }, '2026-06-07', NOON, opts).decision).toBe('already-handled');
  });
  it('re-arms on the next local day (yesterday handled, today reaches the time)', () => {
    expect(evaluateDue({ enabled: true, time: '12:00' }, '2026-06-06', NOON, opts).decision).toBe('due');
  });

  // ── cross-midnight grace (Codex finding #3) ──
  it('fires a late-night run within grace even after midnight, marking the PREVIOUS day', () => {
    // scheduled 23:30 on 06-07, daemon back at 00:10 on 06-08 → 40 min late (< 60)
    const r = evaluateDue({ enabled: true, time: '23:30' }, undefined, PAST_MIDNIGHT, opts);
    expect(r.decision).toBe('due');
    expect(r.markDate).toBe('2026-06-07'); // the run belongs to the previous day
  });
  it('does not re-fire the late-night run once the previous day is marked', () => {
    const r = evaluateDue({ enabled: true, time: '23:30' }, '2026-06-07', PAST_MIDNIGHT, opts);
    expect(r.decision).toBe('already-handled');
  });
  it('a previous-day run already past grace is dropped (waits for today), not fired', () => {
    // scheduled 12:00; now 00:10 next day → yesterday's run is ~12h late → not fired
    const r = evaluateDue({ enabled: true, time: '12:00' }, undefined, PAST_MIDNIGHT, opts);
    expect(r.decision).toBe('not-yet');
  });
});
