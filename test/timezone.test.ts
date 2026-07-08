// test/timezone.test.ts
import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeScheduleTimeZone,
  scheduleTimeZone,
  isValidTimeZone,
  hostLocalTimeZone,
  zonedTomorrowAt,
} from '../src/utils/timezone.js';
import { Cron } from 'croner';
import { invalidateGlobalConfigCache } from '../src/global-config.js';

describe('normalizeScheduleTimeZone', () => {
  it('passes through a normal IANA zone', () => {
    expect(normalizeScheduleTimeZone('Asia/Bangkok')).toBe('Asia/Bangkok');
    expect(normalizeScheduleTimeZone('America/New_York')).toBe('America/New_York');
    expect(normalizeScheduleTimeZone('UTC')).toBe('UTC');
  });

  it("falls back to UTC on the 'Etc/Unknown' sentinel (unresolvable host zone)", () => {
    // Node reports 'Etc/Unknown' when the local zone can't be resolved (e.g. TZ='').
    // croner + toLocaleString both REJECT it, which would null cron next-runs and
    // crash schedule listing — so it must normalize to a value every consumer accepts.
    expect(normalizeScheduleTimeZone('Etc/Unknown')).toBe('UTC');
  });

  it('falls back to UTC on empty / nullish', () => {
    expect(normalizeScheduleTimeZone('')).toBe('UTC');
    expect(normalizeScheduleTimeZone(undefined)).toBe('UTC');
    expect(normalizeScheduleTimeZone(null)).toBe('UTC');
  });
});

describe('isValidTimeZone', () => {
  it('accepts real IANA zones', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });
  it('rejects garbage / empty / the Etc/Unknown sentinel', () => {
    expect(isValidTimeZone('Mars/Phobos')).toBe(false);
    expect(isValidTimeZone('not a zone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone('Etc/Unknown')).toBe(false);
  });
});

describe('zonedTomorrowAt — "tomorrow HH:MM" in a zone (injected now)', () => {
  // now = 2026-07-07T18:00:00Z → Shanghai 2026-07-08 02:00, LA 2026-07-07 11:00.
  const nowMs = Date.UTC(2026, 6, 7, 18, 0, 0);
  it('Asia/Shanghai: tomorrow (SH date +1) at 09:00 → 2026-07-09T01:00Z', () => {
    expect(zonedTomorrowAt('Asia/Shanghai', 9, 0, nowMs).toISOString())
      .toBe('2026-07-09T01:00:00.000Z');
  });
  it('America/Los_Angeles: tomorrow (LA date +1) at 09:00 → 2026-07-08T16:00Z', () => {
    expect(zonedTomorrowAt('America/Los_Angeles', 9, 0, nowMs).toISOString())
      .toBe('2026-07-08T16:00:00.000Z');
  });

  // DST: computed via croner, so it must equal the SAME-pattern cron exactly —
  // for BOTH negative (LA) and positive (Berlin) offset zones, gap + fall-back.
  const cron = (m: number, h: number, d: number, mo: number, tz: string, from: number) =>
    new Cron(`${m} ${h} ${d} ${mo} *`, { timezone: tz }).nextRun(new Date(from))!.toISOString();

  it('LA spring-forward gap (03-08 02:30) matches croner (→ 03:30 PDT)', () => {
    const now = Date.UTC(2026, 2, 7, 20, 0, 0); // 03-07 in LA
    expect(zonedTomorrowAt('America/Los_Angeles', 2, 30, now).toISOString())
      .toBe(cron(30, 2, 8, 3, 'America/Los_Angeles', now));
  });
  it('Berlin spring-forward gap (03-29 02:30) matches croner (positive offset)', () => {
    const now = Date.UTC(2026, 2, 28, 12, 0, 0); // 03-28 in Berlin
    const got = zonedTomorrowAt('Europe/Berlin', 2, 30, now).toISOString();
    expect(got).toBe(cron(30, 2, 29, 3, 'Europe/Berlin', now));
    expect(got).toBe('2026-03-29T01:30:00.000Z'); // 03:30 CEST
  });
  it('Berlin fall-back repeated hour (10-25 02:30) matches croner (first occurrence)', () => {
    const now = Date.UTC(2026, 9, 24, 12, 0, 0); // 10-24 in Berlin
    const got = zonedTomorrowAt('Europe/Berlin', 2, 30, now).toISOString();
    expect(got).toBe(cron(30, 2, 25, 10, 'Europe/Berlin', now));
    expect(got).toBe('2026-10-25T00:30:00.000Z'); // 02:30 CEST (first)
  });
});

describe('scheduleTimeZone — env → config → host precedence', () => {
  const ENV = 'BOTMUX_SCHEDULE_TIMEZONE';
  const savedEnv = process.env[ENV];
  const savedHome = process.env.HOME;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    invalidateGlobalConfigCache();
  });

  it('env override wins and is returned verbatim', () => {
    process.env[ENV] = 'Asia/Tokyo';
    expect(scheduleTimeZone()).toBe('Asia/Tokyo');
  });

  it('an invalid env value is ignored (falls through past it)', () => {
    process.env[ENV] = 'Not/AZone';
    // With no config override, this must fall back to the host zone (a valid IANA name).
    delete process.env.HOME; // avoid picking up a stray config in a temp/CI home
    invalidateGlobalConfigCache();
    const tz = scheduleTimeZone();
    expect(tz).not.toBe('Not/AZone');
    expect(isValidTimeZone(tz)).toBe(true);
  });

  it('dashboard config (~/.botmux/config.json) is used when no env override', () => {
    delete process.env[ENV];
    const home = mkdtempSync(join(tmpdir(), 'botmux-tz-'));
    mkdirSync(join(home, '.botmux'), { recursive: true });
    writeFileSync(
      join(home, '.botmux', 'config.json'),
      JSON.stringify({ scheduleTimeZone: 'Asia/Bangkok' }),
    );
    process.env.HOME = home;
    invalidateGlobalConfigCache();
    expect(scheduleTimeZone()).toBe('Asia/Bangkok');
  });

  it('falls back to the host local zone when neither env nor config is set', () => {
    delete process.env[ENV];
    const home = mkdtempSync(join(tmpdir(), 'botmux-tz-'));
    process.env.HOME = home; // no config.json in this fresh home
    invalidateGlobalConfigCache();
    expect(scheduleTimeZone()).toBe(hostLocalTimeZone());
  });
});

describe('scheduleTimeZone', () => {
  it('returns a usable IANA zone the scheduler consumers accept (never throws)', () => {
    const tz = scheduleTimeZone();
    expect(typeof tz).toBe('string');
    expect(tz).not.toBe('Etc/Unknown');
    // Must be accepted by Intl (same API croner/toLocaleString rely on).
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0)).not.toThrow();
  });
});
