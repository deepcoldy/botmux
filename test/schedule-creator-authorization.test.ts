import { describe, expect, it } from 'vitest';
import { authorizeOwnerlessScheduleCreator, requireScheduleCreatorUnionId } from '../src/core/schedule-creator-authorization.js';

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
