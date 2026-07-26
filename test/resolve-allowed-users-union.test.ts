import { describe, it, expect, vi } from 'vitest';
import { resolveAllowedUsersWithMap } from '../src/im/lark/client.js';
import { applyAllowedUsersResolve } from '../src/utils/allowed-users-apply.js';
import { registerBot } from '../src/bot-registry.js';
import { logger } from '../src/utils/logger.js';

// Regression for PR #72: setup/onboarding now writes owners as `on_` union_id,
// but the runtime permission layer (canTalk/canOperate) only matches the app's
// `ou_` open_id. The daemon must translate `on_` → this app's `ou_` at startup
// resolution, otherwise an `allowedUsers: ['on_...']` owner is locked out.

const APP = 'app-union-resolve-test';

function stubClient(userGet: any, batchGetId?: any) {
  const st = registerBot({ larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code', botName: 'B' } as any);
  (st as any).client = {
    // PR #310 routes contact.v3.user.get through the generic no-body c.request()
    // (larkGet). Emulate that endpoint here and delegate to the same userGet stub
    // so the assertions on path.user_id / params.user_id_type still hold.
    request: async ({ url, params }: any) => {
      const user_id = decodeURIComponent(String(url).split('/').pop());
      return userGet({ path: { user_id }, params });
    },
    contact: { v3: { user: {
      get: userGet,
      batchGetId: batchGetId ?? (async () => ({ code: 0, data: { user_list: [] } })),
    } } },
  };
}

describe('resolveAllowedUsersWithMap — on_ union_id entries (PR#72 lockout fix)', () => {
  it('resolves a bare on_ entry to this app open_id so canTalk/canOperate can match', async () => {
    stubClient(async ({ path, params }: any) => {
      expect(params.user_id_type).toBe('union_id');
      expect(path.user_id).toBe('on_owner123');
      return { code: 0, data: { user: { open_id: 'ou_resolved_owner', union_id: path.user_id, name: 'Owner' } } };
    });

    const { resolved, map } = await resolveAllowedUsersWithMap(APP, ['on_owner123']);

    expect(resolved).toEqual(['ou_resolved_owner']);     // not dropped, not left as on_
    expect(map.get('on_owner123')).toBe('ou_resolved_owner'); // reverse lookup for /revoke
  });

  it('mixes ou_ (passthrough) + on_ (resolved) in one list', async () => {
    stubClient(async ({ path }: any) =>
      ({ code: 0, data: { user: { open_id: 'ou_from_union', union_id: path.user_id, name: 'X' } } }));

    const { resolved } = await resolveAllowedUsersWithMap(APP, ['ou_plain', 'on_xyz']);

    expect(resolved).toEqual(['ou_plain', 'ou_from_union']);
  });

  // Regression for PR #240: resolution must keep `allowedUsers` config order so
  // `owner = first ou_` follows the configured ranking. The pre-fix logic bucketed
  // literal `ou_` ahead of resolved on_/email entries, so an `on_` owner listed
  // FIRST got displaced by any later literal `ou_` group member. The previous test
  // happens to put `ou_` first, so it never exercises the reorder — this one does.
  it('keeps config order when on_ owner precedes literal ou_ members (no displacement)', async () => {
    stubClient(async ({ path }: any) =>
      ({ code: 0, data: { user: { open_id: 'ou_owner', union_id: path.user_id, name: 'Owner' } } }));

    // Real-world shape: creator written as on_ (first), then group members appended
    // as literal ou_, with the creator also re-appearing as a literal ou_ duplicate.
    const { resolved } = await resolveAllowedUsersWithMap(
      APP, ['on_owner', 'ou_memberA', 'ou_memberB', 'ou_owner'],
    );

    // Owner stays first (was displaced to position 3 under the old bucketing),
    // and the duplicate ou_owner is deduped to its first occurrence.
    expect(resolved).toEqual(['ou_owner', 'ou_memberA', 'ou_memberB']);
    expect(resolved[0]).toBe('ou_owner');
  });

  it('warns when a literal ou_ entry belongs to another app scope', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    stubClient(async ({ path, params }: any) => {
      expect(path.user_id).toBe('ou_other_app');
      expect(params.user_id_type).toBe('open_id');
      return { code: 99992361, msg: 'user not found in app scope' };
    });

    const { resolved, map } = await resolveAllowedUsersWithMap(APP, ['ou_other_app']);

    expect(resolved).toEqual(['ou_other_app']);
    expect(map.get('ou_other_app')).toBe('ou_other_app');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('open_id ou_other_app belongs to another app'));
    warn.mockRestore();
  });
});

// PR #590 fix: per-entry resolve status drives the last-known-good cache
// fallback. Only 'transient' entries may be recovered from cache; 'definitive'
// misses (removed / not-visible / invalid) must NOT be, or a stale owner gets
// revived. errored must stay in lockstep with 'transient'.
describe('resolveAllowedUsersWithMap — entryStatus classification (PR#590)', () => {
  it('union_id resolved → resolved; errored stays false', async () => {
    stubClient(async ({ path }: any) =>
      ({ code: 0, data: { user: { open_id: 'ou_ok', union_id: path.user_id, name: 'X' } } }));
    const { entryStatus, errored } = await resolveAllowedUsersWithMap(APP, ['on_ok']);
    expect(entryStatus.get('on_ok')).toBe('resolved');
    expect(errored).toBeFalsy();
  });

  it('union_id code-0 with NO open_id → definitive (NOT transient); does not flag errored', async () => {
    // Union user outside this app's contact visibility → tenant returns a code-0
    // empty shell rather than 41050. Must be definitive so the never-converging
    // retry chain is not armed and a stale cached ou_ is not revived.
    stubClient(async ({ path }: any) => ({ code: 0, data: { user: { union_id: path.user_id } } }));
    const { entryStatus, errored, resolved } = await resolveAllowedUsersWithMap(APP, ['on_ghost']);
    expect(entryStatus.get('on_ghost')).toBe('definitive');
    expect(errored).toBeFalsy();
    expect(resolved).toEqual([]);
  });

  it('union_id definitive contact code (41050 not_visible) → definitive; not errored', async () => {
    stubClient(async () => ({ code: 41050, msg: 'not visible' }));
    const { entryStatus, errored } = await resolveAllowedUsersWithMap(APP, ['on_hidden']);
    expect(entryStatus.get('on_hidden')).toBe('definitive');
    expect(errored).toBeFalsy();
  });

  it('union_id transient failure (throw) → transient + errored', async () => {
    stubClient(async () => { throw new Error('ECONNRESET'); });
    const { entryStatus, errored } = await resolveAllowedUsersWithMap(APP, ['on_flaky']);
    expect(entryStatus.get('on_flaky')).toBe('transient');
    expect(errored).toBe(true);
  });

  it('union_id non-definitive non-zero code (server error) → transient + errored', async () => {
    stubClient(async () => ({ code: 500, msg: 'internal' }));
    const { entryStatus, errored } = await resolveAllowedUsersWithMap(APP, ['on_5xx']);
    expect(entryStatus.get('on_5xx')).toBe('transient');
    expect(errored).toBe(true);
  });

  it('literal ou_ is always resolved (never dropped/transient)', async () => {
    stubClient(async () => ({ code: 0, data: { user: {} } }));
    const { entryStatus } = await resolveAllowedUsersWithMap(APP, ['ou_literal']);
    expect(entryStatus.get('ou_literal')).toBe('resolved');
  });

  it('email not returned by a code-0 batch → definitive (not transient)', async () => {
    stubClient(
      async () => ({ code: 0, data: { user: {} } }),
      async () => ({ code: 0, data: { user_list: [] } }), // batch OK but empty
    );
    const { entryStatus, errored } = await resolveAllowedUsersWithMap(APP, ['ghost@corp.com']);
    expect(entryStatus.get('ghost@corp.com')).toBe('definitive');
    expect(errored).toBeFalsy();
  });

  it('email batch call fails (code!=0) → transient + errored for every requested email', async () => {
    stubClient(
      async () => ({ code: 0, data: { user: {} } }),
      async () => ({ code: 500, msg: 'batch down' }),
    );
    const { entryStatus, errored } = await resolveAllowedUsersWithMap(APP, ['a@corp.com', 'b@corp.com']);
    expect(entryStatus.get('a@corp.com')).toBe('transient');
    expect(entryStatus.get('b@corp.com')).toBe('transient');
    expect(errored).toBe(true);
  });

  it('email batch permanent 4xx (40001) is a WHOLE-REQUEST error → transient, NOT per-email definitive', async () => {
    // codex 2nd delta: 40001 is an invalid-argument error for the whole batch
    // request, not a per-email identity verdict. Marking each email definitive
    // would silently prune an email-only owner's LKG cache and lock them out.
    // Must be transient so fallback + retry + DM all fire.
    stubClient(
      async () => ({ code: 0, data: { user: {} } }),
      async () => ({ code: 40001, msg: 'invalid argument' }),
    );
    const { entryStatus, errored, resolved } = await resolveAllowedUsersWithMap(APP, ['owner@corp.com']);
    expect(entryStatus.get('owner@corp.com')).toBe('transient');
    expect(errored).toBe(true);
    expect(resolved).toEqual([]); // no cache in this stub → empty, but retry-eligible
  });

  it('email batch throw (any error, incl thrown 4xx) → transient for every requested email', async () => {
    // A throw is a whole-request failure — same reasoning as a non-zero code.
    stubClient(
      async () => ({ code: 0, data: { user: {} } }),
      async () => { const e: any = new Error('not visible'); e.response = { data: { code: 41050 } }; throw e; },
    );
    const thrown4xx = await resolveAllowedUsersWithMap(APP, ['hidden@corp.com']);
    expect(thrown4xx.entryStatus.get('hidden@corp.com')).toBe('transient');
    expect(thrown4xx.errored).toBe(true);

    stubClient(
      async () => ({ code: 0, data: { user: {} } }),
      async () => { throw new Error('ECONNRESET'); },
    );
    const network = await resolveAllowedUsersWithMap(APP, ['flaky@corp.com']);
    expect(network.entryStatus.get('flaky@corp.com')).toBe('transient');
    expect(network.errored).toBe(true);
  });
});

// End-to-end: resolver → applyAllowedUsersResolve → cache decision, for the exact
// scenario codex flagged — an email-only owner + a batch-wide error (incl 40001)
// must NOT be locked out. The whole-request error is transient, so the pure fn
// recovers the owner from the last-known-good cache and never prunes it.
describe('resolve → apply end-to-end: email-only owner + batch error keeps owner (PR#590)', () => {
  it('batch 40001 with a cached owner → owner recovered from cache, marked failed (retry), not pruned', async () => {
    stubClient(
      async () => ({ code: 0, data: { user: {} } }),
      async () => ({ code: 40001, msg: 'invalid argument' }),
    );
    const resolveResult = await resolveAllowedUsersWithMap(APP, ['owner@corp.com']);
    // resolver: whole-request failure → transient, errored, nothing resolved.
    expect(resolveResult.entryStatus.get('owner@corp.com')).toBe('transient');
    expect(resolveResult.errored).toBe(true);
    expect(resolveResult.resolved).toEqual([]);

    const applied = applyAllowedUsersResolve({
      rawEntries: ['owner@corp.com'],
      previousResolvedMap: { 'owner@corp.com': 'ou_owner' }, // last-known-good
      resolveResult,
    });
    // owner kept alive from cache; flagged failed so a retry is armed; the cache
    // key is NOT in the definitive set, so a caller pruning definitives keeps it.
    expect(applied.resolved).toEqual(['ou_owner']);
    expect(applied.usedFallback).toBe(true);
    expect(applied.failed).toBe(true);
    expect(applied.map.get('owner@corp.com')).toBe('ou_owner');
    const definitives = [...resolveResult.entryStatus.entries()]
      .filter(([, s]) => s === 'definitive').map(([e]) => e);
    expect(definitives).toEqual([]); // nothing to prune → cached owner survives
  });

  it('batch 40001 with NO cache → empty runtime but failed=true so fallback/DM/retry still fire', async () => {
    stubClient(
      async () => ({ code: 0, data: { user: {} } }),
      async () => ({ code: 40001, msg: 'invalid argument' }),
    );
    const resolveResult = await resolveAllowedUsersWithMap(APP, ['owner@corp.com']);
    const applied = applyAllowedUsersResolve({
      rawEntries: ['owner@corp.com'],
      previousResolvedMap: {},
      resolveResult,
    });
    expect(applied.resolved).toEqual([]);
    expect(applied.failed).toBe(true); // NOT a silent success — owner-lockout is surfaced + retried
    expect(applied.notice).toBeTruthy();
  });
});
