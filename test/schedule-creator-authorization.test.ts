import { describe, expect, it } from 'vitest';
import { authorizeOwnerlessScheduleCreator, authorizeScheduleOperator,
  isScheduleOperatorAuthorization, requireScheduleCreatorUnionId,
  requireScheduleOperatorAuthorization } from '../src/core/schedule-creator-authorization.js';

describe('ownerless schedule creator authorization', () => {
  const base = { callerOpenId: 'ou_owner', allowedUsers: ['on_owner'], resolutionCache: { on_owner: 'ou_owner' }, resolvedAllowedUsers: ['ou_owner'] };
  it('binds the allowed current caller without borrowing a session owner', () => {
    expect(authorizeOwnerlessScheduleCreator(base)).toEqual({ ok: true, ownerUnionId: 'on_owner' });
  });
  it.each([
    { ...base, callerOpenId: 'ou_stranger' },
    { ...base, callerOpenId: undefined },
    { ...base, allowedUsers: [] },
    { ...base, resolvedAllowedUsers: [] },
    { ...base, resolutionCache: { on_owner: 'ou_other_app' } },
  ])('rejects a missing, unauthorized, revoked or cross-app caller', input => {
    expect(authorizeOwnerlessScheduleCreator(input)).toEqual({ ok: false, error: 'caller_not_allowed' });
  });
  it('never recovers a revoked union id from a stale cache', () => {
    expect(authorizeOwnerlessScheduleCreator({ ...base, allowedUsers: ['ou_owner'] })).toEqual({ ok: false, error: 'caller_union_id_unresolved' });
  });
  it('rejects ambiguous identity mappings', () => {
    expect(authorizeOwnerlessScheduleCreator({ ...base, allowedUsers: ['on_owner', 'on_other'], resolutionCache: { on_owner: 'ou_owner', on_other: 'ou_owner' } })).toEqual({ ok: false, error: 'caller_union_id_unresolved' });
  });
  it('fails closed for old daemons without granting standalone authority', () => {
    expect(() => requireScheduleCreatorUnionId(undefined)).toThrow('upgrade the owning daemon');
    expect(() => requireScheduleCreatorUnionId({ ok: false, error: 'caller_not_allowed' })).toThrow('not an allowed bot operator');
  });
});

describe('same-app schedule operator admission', () => {
  const base = { callerOpenId: 'ou_owner', allowedUsers: ['ou_owner'],
    resolutionCache: {}, resolvedAllowedUsers: ['ou_owner'] };
  it('admits the live app-scoped caller without a union id while creator binding stays strict', () => {
    expect(authorizeScheduleOperator(base)).toEqual({ ok: true });
    expect(authorizeOwnerlessScheduleCreator(base)).toEqual({ ok: false, error: 'caller_union_id_unresolved' });
  });
  it('admits a configured email mapping without borrowing a cached union id', () => {
    expect(authorizeScheduleOperator({ ...base, allowedUsers: ['owner@example.test'],
      resolutionCache: { 'owner@example.test': 'ou_owner', on_stale: 'ou_owner' } })).toEqual({ ok: true });
  });
  it.each([
    { ...base, callerOpenId: undefined },
    { ...base, callerOpenId: 'ou_other_app' },
    { ...base, allowedUsers: [] },
    { ...base, resolvedAllowedUsers: [] },
    { ...base, allowedUsers: ['on_owner'], resolutionCache: { on_owner: 'ou_other_app' } },
  ])('rejects missing, foreign-app, unauthorized and revoked callers', input => {
    expect(authorizeScheduleOperator(input)).toEqual({ ok: false, error: 'caller_not_allowed' });
  });
  it('does not infer admission from creator errors or malformed HTTP data', () => {
    expect(isScheduleOperatorAuthorization({ ok: false, error: 'caller_union_id_unresolved' })).toBe(false);
    for (const value of [null, [], true, { ok: 'true' }, { ok: false, error: 'unknown' }]) {
      expect(isScheduleOperatorAuthorization(value)).toBe(false);
    }
    expect(() => requireScheduleOperatorAuthorization(undefined)).toThrow('upgrade the owning daemon');
    expect(() => requireScheduleOperatorAuthorization({ ok: false, error: 'caller_not_allowed' })).toThrow('not an allowed bot operator');
    expect(() => requireScheduleOperatorAuthorization({ ok: true })).not.toThrow();
  });
});
