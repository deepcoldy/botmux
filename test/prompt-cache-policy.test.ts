/**
 * Prompt-cache policy: layer normalization, global ⊕ bot resolution, and the
 * keep-alive "is it due" window.
 *
 * Run: bun run vitest run test/prompt-cache-policy.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  buildPromptCacheKeepalivePrompt,
  decidePromptCacheKeepalive,
  isWithinActiveHours,
  normalizePromptCacheConfig,
  parseActiveHours,
  readPromptCacheConfig,
  resolvePromptCachePolicy,
  type ResolvedPromptCachePolicy,
} from '../src/services/prompt-cache-policy.js';

const MIN = 60_000;

describe('normalizePromptCacheConfig', () => {
  it('accepts a full layer and drops blank activeHours', () => {
    expect(normalizePromptCacheConfig({
      ttl: '1h',
      keepalive: { enabled: true, idleMinutes: 50, maxPings: 3, activeHours: ' ', minContextTokens: 0 },
    })).toEqual({ ttl: '1h', keepalive: { enabled: true, idleMinutes: 50, maxPings: 3, minContextTokens: 0 } });
  });

  it('clears on null / undefined / empty objects', () => {
    expect(normalizePromptCacheConfig(null)).toBeUndefined();
    expect(normalizePromptCacheConfig(undefined)).toBeUndefined();
    expect(normalizePromptCacheConfig({})).toBeUndefined();
    expect(normalizePromptCacheConfig({ keepalive: {} })).toBeUndefined();
  });

  it.each([
    [{ ttl: '2h' }, /ttl/],
    [{ tll: '1h' }, /Unknown promptCache field: tll/],
    [{ keepalive: { enable: true } }, /Unknown promptCache.keepalive field: enable/],
    [{ keepalive: { enabled: 'yes' } }, /enabled must be boolean/],
    [{ keepalive: { idleMinutes: 60 } }, /idleMinutes/],
    [{ keepalive: { idleMinutes: 0 } }, /idleMinutes/],
    [{ keepalive: { maxPings: 1.5 } }, /maxPings/],
    [{ keepalive: { activeHours: '9-21' } }, /activeHours/],
    [{ keepalive: { minContextTokens: -1 } }, /minContextTokens/],
    [[], /must be an object/],
  ])('rejects %j', (input, message) => {
    expect(() => normalizePromptCacheConfig(input)).toThrow(message);
  });

  it('the lenient reader ignores a malformed block instead of throwing', () => {
    expect(readPromptCacheConfig({ ttl: 'forever' })).toBeUndefined();
    expect(readPromptCacheConfig({ ttl: '5m' })).toEqual({ ttl: '5m' });
  });
});

describe('active hours', () => {
  it('parses HH:MM-HH:MM with 24:00 only as an end', () => {
    expect(parseActiveHours('09:00-21:30')).toEqual({ start: 540, end: 1290 });
    expect(parseActiveHours('22:00 - 06:00')).toEqual({ start: 1320, end: 360 });
    expect(parseActiveHours('00:00-24:00')).toEqual({ start: 0, end: 1440 });
    expect(parseActiveHours('')).toBeUndefined();
    expect(parseActiveHours('24:00-06:00')).toBeNull();
    expect(parseActiveHours('09:60-10:00')).toBeNull();
  });

  it('includes the start, excludes the end, and crosses midnight', () => {
    const day = { start: 540, end: 1290 };
    expect(isWithinActiveHours(day, 540)).toBe(true);
    expect(isWithinActiveHours(day, 1289)).toBe(true);
    expect(isWithinActiveHours(day, 1290)).toBe(false);
    const night = { start: 1320, end: 360 };
    expect(isWithinActiveHours(night, 1400)).toBe(true);
    expect(isWithinActiveHours(night, 100)).toBe(true);
    expect(isWithinActiveHours(night, 600)).toBe(false);
    expect(isWithinActiveHours({ start: 0, end: 1440 }, 700)).toBe(true);
    expect(isWithinActiveHours(undefined, 700)).toBe(true);
  });
});

describe('resolvePromptCachePolicy', () => {
  it('is fully off with no layers', () => {
    const p = resolvePromptCachePolicy(undefined, undefined);
    expect(p.ttl).toBeUndefined();
    expect(p.keepalive.enabled).toBe(false);
  });

  it('enabling keep-alive implies the 1h lifetime and its 54-minute default', () => {
    const p = resolvePromptCachePolicy({ keepalive: { enabled: true } }, undefined);
    expect(p.ttl).toBe('1h');
    expect(p.keepalive).toEqual({ enabled: true, idleMinutes: 54, maxPings: 2, minContextTokens: 50_000 });
  });

  it('bot fields override global fields one by one', () => {
    const p = resolvePromptCachePolicy(
      { ttl: '1h', keepalive: { enabled: true, idleMinutes: 50, activeHours: '10:00-23:00' } },
      { keepalive: { maxPings: 5 } },
    );
    expect(p.ttl).toBe('1h');
    expect(p.keepalive).toEqual({
      enabled: true, idleMinutes: 50, maxPings: 5, activeHours: { start: 600, end: 1380 }, minContextTokens: 50_000,
    });
  });

  it('a bot can turn keep-alive off under a global on, keeping an explicit ttl', () => {
    const p = resolvePromptCachePolicy({ ttl: '1h', keepalive: { enabled: true } }, { keepalive: { enabled: false } });
    expect(p.keepalive.enabled).toBe(false);
    expect(p.ttl).toBe('1h');
    // ...and without an explicit ttl, turning keep-alive off also drops the implied 1h.
    expect(resolvePromptCachePolicy({ keepalive: { enabled: true } }, { keepalive: { enabled: false } }).ttl).toBeUndefined();
  });

  it('resolves spelled-out all-day windows to no window', () => {
    for (const activeHours of ['00:00-24:00', '09:00-09:00']) {
      expect(resolvePromptCachePolicy({ keepalive: { enabled: true, activeHours } }, undefined).keepalive.activeHours).toBeUndefined();
    }
  });

  it('clamps the interval below a 5m lifetime', () => {
    const p = resolvePromptCachePolicy({ ttl: '5m', keepalive: { enabled: true, idleMinutes: 30 } }, undefined);
    expect(p.keepalive.idleMinutes).toBe(4);
    expect(resolvePromptCachePolicy({ ttl: '5m', keepalive: { enabled: true } }, undefined).keepalive.idleMinutes).toBe(4);
  });
});

describe('decidePromptCacheKeepalive', () => {
  const policy: ResolvedPromptCachePolicy = resolvePromptCachePolicy(
    { keepalive: { enabled: true, activeHours: '10:00-23:00' } },
    undefined,
  );
  const base = { now: 1_000 * MIN, minuteOfDay: 12 * 60, idleSinceAt: 1_000 * MIN - 55 * MIN, contextTokens: 200_000 };

  it('is due inside [idleMinutes, ttl) of the idle start', () => {
    expect(decidePromptCacheKeepalive(policy, base)).toEqual({ due: true });
    expect(decidePromptCacheKeepalive(policy, { ...base, idleSinceAt: base.now - 53 * MIN })).toEqual({ due: false, reason: 'not_yet' });
    expect(decidePromptCacheKeepalive(policy, { ...base, idleSinceAt: base.now - 60 * MIN })).toEqual({ due: false, reason: 'cache_expired' });
  });

  it('counts the next interval from the last keep-alive and stops at maxPings', () => {
    const state = { pings: 1, lastPingAt: base.now - 54 * MIN, idleSinceAt: base.now - 108 * MIN };
    expect(decidePromptCacheKeepalive(policy, { ...base, idleSinceAt: state.idleSinceAt, state })).toEqual({ due: true });
    expect(decidePromptCacheKeepalive(policy, { ...base, idleSinceAt: state.idleSinceAt, state: { ...state, pings: 2 } }))
      .toEqual({ due: false, reason: 'max_pings' });
  });

  it('waits while a keep-alive is in flight, but not forever', () => {
    const inFlight = { pings: 0, idleSinceAt: base.idleSinceAt, inFlightSince: base.now - MIN };
    expect(decidePromptCacheKeepalive(policy, { ...base, state: inFlight })).toEqual({ due: false, reason: 'in_flight' });
    const stale = { ...inFlight, inFlightSince: base.now - 11 * MIN };
    expect(decidePromptCacheKeepalive(policy, { ...base, state: stale })).toEqual({ due: true });
  });

  it('respects active hours, context size, and the master switch', () => {
    expect(decidePromptCacheKeepalive(policy, { ...base, minuteOfDay: 23 * 60 })).toEqual({ due: false, reason: 'off_hours' });
    expect(decidePromptCacheKeepalive(policy, { ...base, contextTokens: 49_999 })).toEqual({ due: false, reason: 'small_context' });
    expect(decidePromptCacheKeepalive(policy, { ...base, contextTokens: undefined })).toEqual({ due: false, reason: 'context_unknown' });
    expect(decidePromptCacheKeepalive(policy, { ...base, idleSinceAt: undefined })).toEqual({ due: false, reason: 'not_idle' });
    const off = resolvePromptCachePolicy(undefined, undefined);
    expect(decidePromptCacheKeepalive(off, base)).toEqual({ due: false, reason: 'disabled' });
    const noMin = resolvePromptCachePolicy({ keepalive: { enabled: true, minContextTokens: 0 } }, undefined);
    expect(decidePromptCacheKeepalive(noMin, { ...base, contextTokens: undefined })).toEqual({ due: true });
  });
});

describe('buildPromptCacheKeepalivePrompt', () => {
  it('is a single line that asks for the silent sentinel', () => {
    for (const locale of ['zh', 'en'] as const) {
      const text = buildPromptCacheKeepalivePrompt(locale);
      expect(text).not.toMatch(/[\r\n]/);
      expect(text).toContain('BOTMUX_NOTHING_TO_SEND');
    }
  });
});
