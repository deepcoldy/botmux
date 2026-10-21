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

  it('does not evict another chat\'s last-known-good ids on a clean pass', async () => {
    // The cache is APP-scoped while each delivery only knows ITS OWN reviewer
    // list. A healthy send in chat B must not prune chat A's cached ids: chat
    // A's next transient would then look like a cold cache and silently lose
    // the control this cache exists to keep.
    await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['a@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map([['a@example.com', 'ou_a']]),
        entryStatus: new Map([['a@example.com', 'resolved']]),
      }),
    });
    await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['b@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map([['b@example.com', 'ou_b']]),
        entryStatus: new Map([['b@example.com', 'resolved']]),
      }),
    });
    const out = await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['a@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map(),
        errored: true,
        entryStatus: new Map([['a@example.com', 'transient']]),
      }),
    });
    expect(out?.reviewers).toEqual(['ou_a']);
  });

  it('prunes a definitively-gone id even on a DEGRADED pass (mixed batch)', async () => {
    // One email definitively gone, another transient → the pass is degraded.
    // The definitive verdict is still a verdict: dropping it from the cache
    // now is what stops a LATER all-transient pass from reviving a reviewer
    // the API already reported gone.
    await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['gone@example.com', 'blip@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map([['gone@example.com', 'ou_dead'], ['blip@example.com', 'ou_ok']]),
        entryStatus: new Map([['gone@example.com', 'resolved'], ['blip@example.com', 'resolved']]),
      }),
    });
    const mixed = await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['gone@example.com', 'blip@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map(),
        errored: true,
        entryStatus: new Map([['gone@example.com', 'definitive'], ['blip@example.com', 'transient']]),
      }),
    });
    expect(mixed?.reviewers).toEqual(['ou_ok']);
    const later = await materializeFeedbackPolicyForDelivery({
      policy: reviewers(['gone@example.com', 'blip@example.com']),
      larkAppId: appId, dataDir,
      resolveAllowedUsersWithMap: resolver({
        map: new Map(),
        errored: true,
        entryStatus: new Map([['gone@example.com', 'transient'], ['blip@example.com', 'transient']]),
      }),
    });
    expect(later?.reviewers).toEqual(['ou_ok']);
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
