import { describe, expect, it, vi } from 'vitest';

import {
  resolveCardOperatorUnionId,
  type CardActionData,
  type ResolveCardOperatorUnionIdDeps,
} from '../src/im/lark/card-handler.js';

const LARK_APP_ID = 'cli_test';

function makeData(overrides: Partial<CardActionData> = {}): CardActionData {
  return {
    operator: { open_id: 'ou_operator' },
    action: { value: {} },
    ...overrides,
  };
}

function denyResolver(): ResolveCardOperatorUnionIdDeps {
  return { resolveUserUnionId: vi.fn(async () => ({})) };
}

function allowResolver(unionId: string = 'on_resolved'): ResolveCardOperatorUnionIdDeps {
  return { resolveUserUnionId: vi.fn(async () => ({ unionId, name: 'name' })) };
}

function throwResolver(): ResolveCardOperatorUnionIdDeps {
  return { resolveUserUnionId: vi.fn(async () => { throw new Error('lark-api-5xx'); }) };
}

/** ─── State 1: verified on_ — direct use ─────────────────────────────── */

describe('resolveCardOperatorUnionId — state 1: verified on_', () => {
  it('returns verified union_id directly when it starts with on_', async () => {
    const data = makeData({
      operator: { open_id: 'ou_operator', union_id: 'on_alice' },
    });
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, denyResolver());
    expect(r.unionId).toBe('on_alice');
    expect(r.openId).toBe('ou_operator');
  });

  it('does NOT call the contact-API fallback when verified union_id is on_', async () => {
    const deps = allowResolver('on_fallback');
    const data = makeData({
      operator: { open_id: 'ou_operator', union_id: 'on_alice' },
    });
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, deps);
    expect(r.unionId).toBe('on_alice');  // verified takes precedence
    expect(deps.resolveUserUnionId).not.toHaveBeenCalled();
  });
});

/** ─── State 2: verified malformed — reject, no fallback ──────────────── */

describe('resolveCardOperatorUnionId — state 2: verified malformed', () => {
  it('rejects ou_-prefixed verified union_id (returns no unionId)', async () => {
    const data = makeData({
      operator: { open_id: 'ou_operator', union_id: 'ou_attacker_app_scoped' },
    });
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, allowResolver('on_should_not_be_returned'));
    expect(r.unionId).toBeUndefined();
    expect(r.openId).toBe('ou_operator');
  });

  it('does NOT fallback to resolveUserUnionId when verified is malformed', async () => {
    const deps = allowResolver('on_fallback');
    const data = makeData({
      operator: { open_id: 'ou_operator', union_id: 'ou_app_scoped' },
    });
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, deps);
    expect(r.unionId).toBeUndefined();
    expect(deps.resolveUserUnionId).not.toHaveBeenCalled();
  });

  it('rejects arbitrary non-on_ verified values without fallback', async () => {
    for (const bogus of ['admin', '', 'on', 'user_attacker', 'on-alice', 'On_alice']) {
      const deps = allowResolver('on_should_not_be_returned');
      const data = makeData({
        operator: { open_id: 'ou_operator', union_id: bogus },
      });
      const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, deps);
      expect(r.unionId, `verified='${bogus}'`).toBeUndefined();
      expect(deps.resolveUserUnionId, `verified='${bogus}'`).not.toHaveBeenCalled();
    }
  });
});

/** ─── State 3: verified absent — fallback ────────────────────────────── */

describe('resolveCardOperatorUnionId — state 3: verified absent', () => {
  it('falls back to resolveUserUnionId(larkAppId, openId)', async () => {
    const deps = allowResolver('on_resolved');
    const data = makeData({ operator: { open_id: 'ou_operator' } });
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, deps);
    expect(r.unionId).toBe('on_resolved');
    expect(r.openId).toBe('ou_operator');
    expect(deps.resolveUserUnionId).toHaveBeenCalledWith(LARK_APP_ID, 'ou_operator');
  });

  it('only accepts on_-prefixed unionId from the fallback', async () => {
    const deps = { resolveUserUnionId: vi.fn(async () => ({ unionId: 'ou_app_scoped', name: 'n' })) };
    const data = makeData({ operator: { open_id: 'ou_operator' } });
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, deps);
    expect(r.unionId).toBeUndefined();
    expect(r.openId).toBe('ou_operator');
    expect(deps.resolveUserUnionId).toHaveBeenCalledOnce();
  });

  it('returns no unionId when fallback returns empty object', async () => {
    const deps = denyResolver();
    const data = makeData({ operator: { open_id: 'ou_operator' } });
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, deps);
    expect(r.unionId).toBeUndefined();
    expect(r.openId).toBe('ou_operator');
  });

  it('returns no unionId (fail-closed) when fallback throws', async () => {
    const deps = throwResolver();
    const data = makeData({ operator: { open_id: 'ou_operator' } });
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, deps);
    expect(r.unionId).toBeUndefined();
    expect(r.openId).toBe('ou_operator');
  });

  it('treats null/undefined verified field as absent (fallback runs)', async () => {
    const deps = allowResolver('on_resolved');
    const data = makeData({ operator: { open_id: 'ou_operator', union_id: undefined } });
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, deps);
    expect(r.unionId).toBe('on_resolved');
    expect(deps.resolveUserUnionId).toHaveBeenCalledOnce();
  });
});

/** ─── Missing operator / open_id ─────────────────────────────────────── */

describe('resolveCardOperatorUnionId — missing operator', () => {
  it('returns empty object when operator is absent', async () => {
    const deps = allowResolver('on_should_not_be_returned');
    const data: CardActionData = { action: { value: {} } };
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, deps);
    expect(r).toEqual({});
    expect(deps.resolveUserUnionId).not.toHaveBeenCalled();
  });

  it('returns empty object when open_id is absent', async () => {
    const deps = allowResolver('on_should_not_be_returned');
    const data: CardActionData = { operator: { union_id: 'on_alice' }, action: { value: {} } };
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, deps);
    expect(r).toEqual({});
    expect(deps.resolveUserUnionId).not.toHaveBeenCalled();
  });
});

/** ─── Red line: action.value.* identity must be ignored ──────────────── */

describe('resolveCardOperatorUnionId — action.value identity is ignored (red line)', () => {
  it('ignores action.value.union_id even when verified payload is missing', async () => {
    const deps = denyResolver();
    const data: CardActionData = {
      operator: { open_id: 'ou_operator' },
      action: { value: { union_id: 'on_attacker', open_id: 'ou_attacker' } },
    };
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, deps);
    expect(r.unionId).toBeUndefined();  // fallback denied, NOT promoted from action.value
    expect(r.openId).toBe('ou_operator'); // echoes verified open_id, NOT action.value.open_id
  });

  it('action.value.* never overrides verified operator.union_id', async () => {
    const data: CardActionData = {
      operator: { open_id: 'ou_operator', union_id: 'on_alice' },
      action: { value: { union_id: 'on_attacker', user_id: 'attacker' } },
    };
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, denyResolver());
    expect(r.unionId).toBe('on_alice');  // verified wins
    expect(r.openId).toBe('ou_operator');
  });

  it('action.value.* never overrides verified-but-malformed rejection', async () => {
    const deps = allowResolver('on_should_not_be_returned');
    const data: CardActionData = {
      operator: { open_id: 'ou_operator', union_id: 'ou_malformed' },
      action: { value: { union_id: 'on_attacker' } },
    };
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, deps);
    expect(r.unionId).toBeUndefined();
    expect(deps.resolveUserUnionId).not.toHaveBeenCalled();
  });

  it('action.value.* with on_-prefixed string does not cause acceptance', async () => {
    // Comprehensive smoke: even when every imaginable identity field on
    // action.value is well-formed, the helper still ignores them.
    const deps = denyResolver();
    const data: CardActionData = {
      operator: { open_id: 'ou_operator' },
      action: {
        value: {
          union_id: 'on_attacker_v1',
          unionId: 'on_attacker_v2',
          open_id: 'ou_attacker_v3',
          user_id: 'on_attacker_v4',
          owner_id: 'on_attacker_v5',
          invoker_open_id: 'ou_attacker_v6',
        },
      },
    };
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID, deps);
    expect(r.unionId).toBeUndefined();
    expect(r.openId).toBe('ou_operator');
  });
});

/** ─── Default deps wiring ────────────────────────────────────────────── */

describe('resolveCardOperatorUnionId — default deps wiring', () => {
  it('uses the production resolveUserUnionId import when no deps override is supplied', async () => {
    // We do not invoke the real Lark API here; we only assert that omitting
    // deps does not throw a "resolver is undefined" runtime error. The body
    // takes the verified-on_ short-circuit which never reaches the resolver.
    const data: CardActionData = {
      operator: { open_id: 'ou_op', union_id: 'on_alice' },
      action: { value: {} },
    };
    const r = await resolveCardOperatorUnionId(data, LARK_APP_ID);
    expect(r.unionId).toBe('on_alice');
  });
});
