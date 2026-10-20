import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import { materializeFeedbackPolicyForDelivery } from '../src/services/feedback-reviewer-delivery.js';
import { feedbackReviewersCachePath } from '../src/utils/feedback-reviewers-cache.js';

type Outcome = {
  map: Map<string, string>;
  errored?: boolean;
  entryStatus?: Map<string, 'resolved' | 'transient' | 'definitive'>;
};

describe('materializeFeedbackPolicyForDelivery', () => {
  let dataDir: string;
  const appId = 'app_test';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-reviewer-delivery-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function reviewers(entries: string[]) {
    return normalizeFeedbackPolicy({ enabled: true, audience: 'reviewers', reviewers: entries });
  }

  function resolver(result: Outcome | (() => Outcome)) {
    return async (_appId: string, entries: string[]): Promise<Outcome> => {
      const r = typeof result === 'function' ? result() : result;
      // Mirror the real resolver contract: callers see exactly the requested
      // entries' statuses; the helper itself filters to ou_ values.
      expect(entries.every(e => !e.startsWith('ou_') && !e.startsWith('on_'))).toBe(true);
      return r;
    };
  }

  it('returns the frozen policy on a healthy resolve and warms the cache', async () => {
    const out = await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['oncall@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map([['oncall@example.com', 'ou_oncall']]),
        entryStatus: new Map([['oncall@example.com', 'resolved']]),
      }),
    });
    expect(out?.reviewers).toEqual(['ou_oncall']);
    const cached = JSON.parse(readFileSync(feedbackReviewersCachePath(dataDir, appId), 'utf8'));
    expect(cached.map).toEqual({ 'oncall@example.com': 'ou_oncall' });
  });

  it('keeps a definitive empty list visible (does not drop the control)', async () => {
    const out = await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['ghost@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map(),
        entryStatus: new Map([['ghost@example.com', 'definitive']]),
      }),
    });
    expect(out?.reviewers).toEqual([]);
  });

  it('reuses last-known-good on a transient failure and keeps the reviewer', async () => {
    // First send: healthy, warms the cache.
    await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['oncall@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map([['oncall@example.com', 'ou_oncall']]),
        entryStatus: new Map([['oncall@example.com', 'resolved']]),
      }),
    });
    // Second send: contact API blips (rate limit / 5xx) → same frozen id.
    const out = await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['oncall@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map(),
        errored: true,
        entryStatus: new Map([['oncall@example.com', 'transient']]),
      }),
    });
    expect(out?.reviewers).toEqual(['ou_oncall']);
  });

  it('does not ship an empty snapshot on a cold-cache transient failure', async () => {
    const out = await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['oncall@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map(),
        errored: true,
        entryStatus: new Map([['oncall@example.com', 'transient']]),
      }),
    });
    expect(out).toBeUndefined();
  });

  it('never revives a reviewer that was removed from config, even with a warm cache', async () => {
    // Old config had old@example.com; cache holds it.
    await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['old@example.com', 'keep@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map([['old@example.com', 'ou_old'], ['keep@example.com', 'ou_keep']]),
        entryStatus: new Map([['old@example.com', 'resolved'], ['keep@example.com', 'resolved']]),
      }),
    });
    // New config swapped to new@example.com, which transiently fails. The
    // removed reviewer's id must not appear, and with nothing recoverable the
    // control is dropped.
    const out = await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['new@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map(),
        errored: true,
        entryStatus: new Map([['new@example.com', 'transient']]),
      }),
    });
    expect(out).toBeUndefined();
  });

  it('prunes a definitively-gone reviewer from the cache so a later blip cannot revive it', async () => {
    await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['oncall@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map([['oncall@example.com', 'ou_oncall']]),
        entryStatus: new Map([['oncall@example.com', 'resolved']]),
      }),
    });
    // Definitive miss on the next pass prunes the sidecar.
    await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['oncall@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map(),
        entryStatus: new Map([['oncall@example.com', 'definitive']]),
      }),
    });
    // A following transient failure must NOT recover the pruned id.
    const out = await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['oncall@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map(),
        errored: true,
        entryStatus: new Map([['oncall@example.com', 'transient']]),
      }),
    });
    expect(out).toBeUndefined();
    const cached = JSON.parse(readFileSync(feedbackReviewersCachePath(dataDir, appId), 'utf8'));
    expect(cached.map).toEqual({});
  });

  it('keeps literal ou_/on_ reviewers working through a full email-batch failure', async () => {
    const out = await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['ou_literal', 'on_union']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({ map: new Map() }),
    });
    expect(out?.reviewers).toEqual(['ou_literal', 'on_union']);
    expect(existsSync(feedbackReviewersCachePath(dataDir, appId))).toBe(false);
  });
});
