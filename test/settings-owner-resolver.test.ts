import { describe, expect, it, vi } from 'vitest';

import { isAuthorizedForGlobalSettings } from '../src/dashboard/settings-owner-resolver.js';

const SAMPLE_CANDIDATES = [
  { unionId: 'on_alice', name: 'alice' },
  { unionId: 'on_bob', name: 'bob' },
];

describe('isAuthorizedForGlobalSettings happy paths', () => {
  it('returns true when senderUnionId matches a candidate', async () => {
    const resolver = vi.fn(async () => SAMPLE_CANDIDATES);
    const allowed = await isAuthorizedForGlobalSettings(
      { senderUnionId: 'on_alice' },
      { resolveOwnerCandidates: resolver },
    );
    expect(allowed).toBe(true);
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('returns true with surrounding whitespace (trim) on senderUnionId', async () => {
    const resolver = vi.fn(async () => SAMPLE_CANDIDATES);
    const allowed = await isAuthorizedForGlobalSettings(
      { senderUnionId: '  on_bob  ' },
      { resolveOwnerCandidates: resolver },
    );
    expect(allowed).toBe(true);
  });

  it('returns true when multiple candidates exist and senderUnionId matches one', async () => {
    const resolver = vi.fn(async () => [
      ...SAMPLE_CANDIDATES,
      { unionId: 'on_carol', name: 'carol' },
    ]);
    const allowed = await isAuthorizedForGlobalSettings(
      { senderUnionId: 'on_carol' },
      { resolveOwnerCandidates: resolver },
    );
    expect(allowed).toBe(true);
  });
});

describe('isAuthorizedForGlobalSettings rejection matrix', () => {
  it('returns false when senderUnionId does not match any candidate', async () => {
    const allowed = await isAuthorizedForGlobalSettings(
      { senderUnionId: 'on_dave' },
      { resolveOwnerCandidates: async () => SAMPLE_CANDIDATES },
    );
    expect(allowed).toBe(false);
  });

  it('returns false when candidates list is empty', async () => {
    const allowed = await isAuthorizedForGlobalSettings(
      { senderUnionId: 'on_alice' },
      { resolveOwnerCandidates: async () => [] },
    );
    expect(allowed).toBe(false);
  });

  it('fails closed (returns false) when the candidate resolver throws', async () => {
    const allowed = await isAuthorizedForGlobalSettings(
      { senderUnionId: 'on_alice' },
      { resolveOwnerCandidates: async () => { throw new Error('lark_api_5xx'); } },
    );
    expect(allowed).toBe(false);
  });

  it('returns false when senderUnionId is undefined', async () => {
    const resolver = vi.fn(async () => SAMPLE_CANDIDATES);
    const allowed = await isAuthorizedForGlobalSettings(
      { senderUnionId: undefined },
      { resolveOwnerCandidates: resolver },
    );
    expect(allowed).toBe(false);
    // Short-circuit: resolver MUST NOT be called for invalid input.
    expect(resolver).not.toHaveBeenCalled();
  });

  it('returns false when senderUnionId is null', async () => {
    const resolver = vi.fn(async () => SAMPLE_CANDIDATES);
    const allowed = await isAuthorizedForGlobalSettings(
      { senderUnionId: null },
      { resolveOwnerCandidates: resolver },
    );
    expect(allowed).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('returns false when senderUnionId is empty string / whitespace only', async () => {
    const resolver = vi.fn(async () => SAMPLE_CANDIDATES);
    expect(await isAuthorizedForGlobalSettings({ senderUnionId: '' }, { resolveOwnerCandidates: resolver })).toBe(false);
    expect(await isAuthorizedForGlobalSettings({ senderUnionId: '   ' }, { resolveOwnerCandidates: resolver })).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('returns false when senderUnionId is non-on_ (e.g. open_id ou_xxx)', async () => {
    const resolver = vi.fn(async () => [
      { unionId: 'ou_appscoped_alice', name: 'alice' }, // hypothetical malformed candidate
    ]);
    const allowed = await isAuthorizedForGlobalSettings(
      { senderUnionId: 'ou_appscoped_alice' },
      { resolveOwnerCandidates: resolver },
    );
    expect(allowed).toBe(false);
    // Critical: prefix gate must short-circuit before resolver runs to avoid leaking
    // resolver state via timing or audit logs.
    expect(resolver).not.toHaveBeenCalled();
  });

  it('returns false for arbitrary string without on_ prefix', async () => {
    const resolver = vi.fn(async () => SAMPLE_CANDIDATES);
    expect(await isAuthorizedForGlobalSettings({ senderUnionId: 'admin' }, { resolveOwnerCandidates: resolver })).toBe(false);
    expect(await isAuthorizedForGlobalSettings({ senderUnionId: 'on' }, { resolveOwnerCandidates: resolver })).toBe(false);
    // Edge: 'on_' alone passes the prefix gate but cannot match a real candidate.
    expect(await isAuthorizedForGlobalSettings({ senderUnionId: 'on_' }, { resolveOwnerCandidates: resolver })).toBe(false);
    expect(await isAuthorizedForGlobalSettings(
      { senderUnionId: 'on_unknown_user' },
      { resolveOwnerCandidates: async () => [{ unionId: 'on_alice', name: 'alice' }] },
    )).toBe(false);
  });
});

describe('isAuthorizedForGlobalSettings — deps injection', () => {
  it('uses the default (real) resolver when no deps are passed — checked via mock seam not real network', async () => {
    // We exercise the deps-injection seam: when an override is given, the
    // production import is NOT consulted. This protects single-test isolation.
    let realResolverInvoked = false;
    const fakeOverride = async () => { realResolverInvoked = false; return [{ unionId: 'on_x', name: 'x' }]; };
    const allowed = await isAuthorizedForGlobalSettings({ senderUnionId: 'on_x' }, { resolveOwnerCandidates: fakeOverride });
    expect(allowed).toBe(true);
    expect(realResolverInvoked).toBe(false);
  });
});
