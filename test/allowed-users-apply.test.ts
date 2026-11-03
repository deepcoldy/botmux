import { describe, expect, it } from 'vitest';
import {
  applyAllowedUsersResolve,
  shouldSilenceAllowedUsersOwnerDm,
  classifyAllowedUsersTerminalNotice,
} from '../src/utils/allowed-users-apply.js';
import type { EntryResolveStatus } from '../src/im/lark/client.js';

/** Build a resolveResult from a raw→ou_ map + per-entry status. */
function result(
  freshPairs: Array<[string, string]>,
  status: Array<[string, EntryResolveStatus]>,
  errored = false,
) {
  return {
    resolved: freshPairs.map(([, oid]) => oid),
    map: new Map(freshPairs),
    errored,
    entryStatus: new Map(status),
  };
}

describe('applyAllowedUsersResolve', () => {
  it('uses a fresh successful resolve (no fallback, no notice)', () => {
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_owner'],
      previousResolvedMap: { on_owner: 'ou_stale' },
      resolveResult: result([['on_owner', 'ou_owner']], [['on_owner', 'resolved']]),
    });

    expect(out.resolved).toEqual(['ou_owner']);
    expect(out.map.get('on_owner')).toBe('ou_owner');
    expect(out.usedFallback).toBe(false);
    expect(out.failed).toBe(false);
    expect(out.notice).toBeNull();
  });

  it('per-entry: recovers ONLY the transient-failed, still-configured entry from cache', () => {
    // on_a resolved fresh; on_b transient-failed → recovered from cache.
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_a', 'on_b'],
      previousResolvedMap: { on_a: 'ou_a_stale', on_b: 'ou_b_cached' },
      resolveResult: result(
        [['on_a', 'ou_a']],
        [['on_a', 'resolved'], ['on_b', 'transient']],
        true,
      ),
    });

    // Fresh ou_a (authoritative, not the stale cache) + cached ou_b.
    expect(out.resolved).toEqual(['ou_a', 'ou_b_cached']);
    expect(out.map.get('on_a')).toBe('ou_a');
    expect(out.map.get('on_b')).toBe('ou_b_cached');
    expect(out.usedFallback).toBe(true);
    expect(out.failed).toBe(true);
    expect(out.fullyRecovered).toBe(true);
    expect(out.notice).toContain('on_b');
  });

  it('total transient failure with cache: keeps every configured entry from cache (owner not locked out)', () => {
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_928c2db360e48084f1ff72ebe161b1d6'],
      previousResolvedMap: { on_928c2db360e48084f1ff72ebe161b1d6: 'ou_8a744395b1a13034de3e5e8ba6ba9715' },
      resolveResult: result([], [['on_928c2db360e48084f1ff72ebe161b1d6', 'transient']], true),
    });

    expect(out.resolved).toEqual(['ou_8a744395b1a13034de3e5e8ba6ba9715']);
    expect(out.usedFallback).toBe(true);
    expect(out.failed).toBe(true);
    expect(out.fullyRecovered).toBe(true);
    // map/resolved consistency: /revoke reverse-lookup must still work.
    expect(out.map.get('on_928c2db360e48084f1ff72ebe161b1d6')).toBe('ou_8a744395b1a13034de3e5e8ba6ba9715');
  });

  it('MUST NOT revive a definitively-removed owner even if cache still has them', () => {
    // errored=false + entry marked definitive (removed from tenant / not visible).
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_fired_owner'],
      previousResolvedMap: { on_fired_owner: 'ou_fired' },
      resolveResult: result([], [['on_fired_owner', 'definitive']], false),
    });

    expect(out.resolved).toEqual([]);
    expect(out.usedFallback).toBe(false);
    // Definitive removal is not a failure — reflects reality, nothing to retry.
    expect(out.failed).toBe(false);
    expect(out.notice).toBeNull();
  });

  it('MUST NOT revive an owner that was swapped out of config (on_old → on_new)', () => {
    // Config now only has on_new; on_new transient-fails; cache still holds on_old.
    // on_old is NOT in rawEntries, so it can never be recovered.
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_new'],
      previousResolvedMap: { on_old: 'ou_old', on_new: 'ou_new_cached' },
      resolveResult: result([], [['on_new', 'transient']], true),
    });

    expect(out.resolved).toEqual(['ou_new_cached']);
    expect(out.resolved).not.toContain('ou_old');
    expect(out.map.has('on_old')).toBe(false);
  });

  it('transient failure with NO cache: empty list + hard-failure notice', () => {
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_owner'],
      previousResolvedMap: {},
      resolveResult: result([], [['on_owner', 'transient']], true),
    });

    expect(out.resolved).toEqual([]);
    expect(out.usedFallback).toBe(false);
    expect(out.failed).toBe(true);
    expect(out.notice).toContain('no last-known ou_ cache');
  });

  it('empty config is a non-failure open path', () => {
    const out = applyAllowedUsersResolve({
      rawEntries: [],
      previousResolvedMap: { on_x: 'ou_stale' },
      resolveResult: result([], []),
    });

    expect(out.resolved).toEqual([]);
    expect(out.map.size).toBe(0);
    expect(out.failed).toBe(false);
    expect(out.notice).toBeNull();
  });

  it('never leaves bare on_ / email in the runtime list', () => {
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_owner'],
      // Even if a malformed cache somehow held a non-ou_ value, it is filtered.
      previousResolvedMap: { on_owner: 'on_not_an_open_id' },
      resolveResult: result([], [['on_owner', 'transient']], true),
    });

    expect(out.resolved.every(id => id.startsWith('ou_'))).toBe(true);
    expect(out.resolved).toEqual([]);
  });

  it('literal ou_ resolved fresh is kept; output map is self-consistent', () => {
    const out = applyAllowedUsersResolve({
      rawEntries: ['ou_literal', 'on_owner'],
      previousResolvedMap: {},
      resolveResult: result(
        [['ou_literal', 'ou_literal'], ['on_owner', 'ou_owner']],
        [['ou_literal', 'resolved'], ['on_owner', 'resolved']],
      ),
    });

    expect(out.resolved).toEqual(['ou_literal', 'ou_owner']);
    expect(out.usedFallback).toBe(false);
    expect(out.failed).toBe(false);
  });

  it('dedupes when the same person is configured twice (union + email) and preserves order', () => {
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_owner', 'owner@corp.com'],
      previousResolvedMap: {},
      resolveResult: result(
        [['on_owner', 'ou_owner'], ['owner@corp.com', 'ou_owner']],
        [['on_owner', 'resolved'], ['owner@corp.com', 'resolved']],
      ),
    });

    expect(out.resolved).toEqual(['ou_owner']);
    // Both raw keys still map to the ou_ for /revoke reverse-lookup.
    expect(out.map.get('on_owner')).toBe('ou_owner');
    expect(out.map.get('owner@corp.com')).toBe('ou_owner');
  });

  it('definitive miss for one entry + fresh for another: drops removed, keeps live, not failed', () => {
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_gone', 'on_live'],
      previousResolvedMap: { on_gone: 'ou_gone_cached' },
      resolveResult: result(
        [['on_live', 'ou_live']],
        [['on_gone', 'definitive'], ['on_live', 'resolved']],
      ),
    });

    expect(out.resolved).toEqual(['ou_live']);
    expect(out.resolved).not.toContain('ou_gone_cached');
    expect(out.usedFallback).toBe(false);
    expect(out.failed).toBe(false);
    expect(out.fullyRecovered).toBe(false);
  });

  it('partially recovered from cache but one entry has no cache: fullyRecovered is false', () => {
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_cached', 'on_uncached'],
      previousResolvedMap: { on_cached: 'ou_cached' },
      resolveResult: result(
        [],
        [['on_cached', 'transient'], ['on_uncached', 'transient']],
        true,
      ),
    });

    expect(out.resolved).toEqual(['ou_cached']);
    expect(out.usedFallback).toBe(true);
    expect(out.failed).toBe(true);
    expect(out.fullyRecovered).toBe(false);
  });

  it('propagates hasPermanentBatchError flag to output', () => {
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_cached'],
      previousResolvedMap: { on_cached: 'ou_cached' },
      resolveResult: {
        ...result([], [['on_cached', 'transient']], true),
        hasPermanentBatchError: true,
      },
    });

    expect(out.resolved).toEqual(['ou_cached']);
    expect(out.usedFallback).toBe(true);
    expect(out.fullyRecovered).toBe(true);
    expect(out.hasPermanentBatchError).toBe(true);
  });
});

// PR#1559 alert-tiering predicates — the daemon's startup DM gate and terminal
// notice tier are pure policy over the apply result / current bot state. Pin
// every boolean combination so a flipped operator (|| vs &&) cannot go green.
describe('shouldSilenceAllowedUsersOwnerDm — startup alert gate (PR#1559)', () => {
  const cases: Array<{ name: string; applied: Parameters<typeof shouldSilenceAllowedUsersOwnerDm>[0]; expected: boolean }> = [
    { name: 'failed + fully recovered + pure transient → silence', applied: { failed: true, fullyRecovered: true, hasPermanentBatchError: false }, expected: true },
    { name: 'failed + fully recovered + flag absent → silence', applied: { failed: true, fullyRecovered: true }, expected: true },
    { name: 'failed + fully recovered + permanent batch error → DM', applied: { failed: true, fullyRecovered: true, hasPermanentBatchError: true }, expected: false },
    { name: 'failed + NOT fully recovered (owner partly locked out) → DM', applied: { failed: true, fullyRecovered: false, hasPermanentBatchError: false }, expected: false },
    { name: 'failed + not recovered + permanent → DM', applied: { failed: true, fullyRecovered: false, hasPermanentBatchError: true }, expected: false },
    { name: 'clean pass (failed=false) → gate irrelevant, no silence decision', applied: { failed: false, fullyRecovered: true, hasPermanentBatchError: false }, expected: false },
  ];
  for (const { name, applied, expected } of cases) {
    it(name, () => {
      expect(shouldSilenceAllowedUsersOwnerDm(applied)).toBe(expected);
    });
  }

  it('end-to-end: pure transient timeout with complete cache silences; missing-scope permanent does not', () => {
    const transient = applyAllowedUsersResolve({
      rawEntries: ['on_a'],
      previousResolvedMap: { on_a: 'ou_a' },
      resolveResult: result([], [['on_a', 'transient']], true),
    });
    expect(shouldSilenceAllowedUsersOwnerDm(transient)).toBe(true);

    const permanent = applyAllowedUsersResolve({
      rawEntries: ['on_a'],
      previousResolvedMap: { on_a: 'ou_a' },
      resolveResult: { ...result([], [['on_a', 'transient']], true), hasPermanentBatchError: true },
    });
    expect(shouldSilenceAllowedUsersOwnerDm(permanent)).toBe(false);
  });
});

describe('classifyAllowedUsersTerminalNotice — retry-exhaustion tier (PR#1559)', () => {
  const cases: Array<{ name: string; state: { configuredCount: number; resolvedCount: number }; expected: ReturnType<typeof classifyAllowedUsersTerminalNotice> }> = [
    { name: 'config removed mid-retry → no notice', state: { configuredCount: 0, resolvedCount: 0 }, expected: null },
    { name: 'still configured, runtime list empty → allowlist-empty', state: { configuredCount: 2, resolvedCount: 0 }, expected: 'allowlist-empty' },
    { name: 'still configured with recovered list → cache-degraded', state: { configuredCount: 2, resolvedCount: 2 }, expected: 'cache-degraded' },
    { name: 'teardown with non-empty list does not alarm', state: { configuredCount: 0, resolvedCount: 3 }, expected: null },
  ];
  for (const { name, state, expected } of cases) {
    it(name, () => {
      expect(classifyAllowedUsersTerminalNotice(state)).toBe(expected);
    });
  }
});
