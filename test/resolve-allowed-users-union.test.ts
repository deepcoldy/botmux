import { describe, it, expect } from 'vitest';
import { resolveAllowedUsersWithMap } from '../src/im/lark/client.js';
import { registerBot } from '../src/bot-registry.js';

// Regression for PR #72: setup/onboarding now writes owners as `on_` union_id,
// but the runtime permission layer (canTalk/canOperate) only matches the app's
// `ou_` open_id. The daemon must translate `on_` → this app's `ou_` at startup
// resolution, otherwise an `allowedUsers: ['on_...']` owner is locked out.

const APP = 'app-union-resolve-test';

function stubClient(userGet: any, batchGetId?: any) {
  const st = registerBot({ larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code', botName: 'B' } as any);
  (st as any).client = {
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
});
