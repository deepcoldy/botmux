import { describe, expect, it } from 'vitest';
import { BytedcliCredentialResolver } from '../src/core/bytedcli-broker-credentials.js';
const jwt = (region = 'cn') => `e30.${Buffer.from(JSON.stringify({ region, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
function setup(extra: Record<string, any> = {}) {
  const calls: string[] = []; let current = 'login1';
  const deps = { machineHome: '/trusted/home', machineProfile: undefined,
    provider: { observe: async () => ({ authenticated: true, loginFingerprint: current }),
      mint: async () => jwt(), userinfo: async () => ({ username: 'person', email: 'person@example.test' }) },
    localHome: () => '/trusted/person', localQueue: async (_id: string, run: () => Promise<any>) => run(),
    readEpoch: () => 0, epochAllows: () => true,
    platform: { bindingKey: () => undefined, resolve: async () => { calls.push('platform'); return undefined; } }, ...extra };
  const resolver = new BytedcliCredentialResolver(deps);
  const actor = { verifiedEmail: 'person@example.test', credentialOpenId: 'ou_person', source: 'local' };
  const request = { actor, region: 'cn', recheck: async () => undefined, signal: new AbortController().signal };
  return { resolver, request, calls, changeLogin: () => current = 'login2' };
}
describe('host identity leases', () => {
  it('checks official userinfo before lending the actor token', async () => {
    const s = setup({ provider: { observe: async () => ({ authenticated: true, loginFingerprint: 'login' }), mint: async () => jwt(),
      userinfo: async () => ({ username: 'different', email: 'other@example.test' }) } });
    await expect(s.resolver.actor(s.request)).rejects.toMatchObject({ code: 'actor_identity_unverified' });
  });
  it('does not substitute a token from another partition', async () => {
    const s = setup({ provider: { observe: async () => ({ authenticated: true, loginFingerprint: 'login' }), mint: async () => jwt('us'),
      userinfo: async () => ({ username: 'person', email: 'person@example.test' }) } });
    await expect(s.resolver.machine(s.request)).rejects.toMatchObject({ code: 'region_auth_required' });
  });
  it('fences an administrator account swap after the machine lease', async () => {
    const s = setup(); const lease = await s.resolver.machine(s.request); s.changeLogin();
    expect(await lease.stillCurrent()).toBe('binding_changed');
  });
  it('never consults platform when local auth is selected', async () => {
    const s = setup(); expect((await s.resolver.actor(s.request)).source).toBe('local'); expect(s.calls).toEqual([]);
  });
  it('auto uses platform when bound and never falls back on missing grants', async () => {
    const s = setup({ platform: { bindingKey: () => 'binding', resolve: async () => undefined } });
    s.request.actor.source = 'auto';
    await expect(s.resolver.actor(s.request)).rejects.toMatchObject({ code: 'actor_auth_required' });
  });
  it('rejects a revoke that lands during mint before returning a lease', async () => {
    let epoch = 0;
    const s = setup({ readEpoch: () => epoch, provider: { observe: async () => ({ authenticated: true, loginFingerprint: 'login' }),
      mint: async () => { epoch++; return jwt(); }, userinfo: async () => ({ username: 'person', email: 'person@example.test' }) } });
    await expect(s.resolver.actor(s.request)).rejects.toMatchObject({ code: 'authorization_revoked' });
  });
  it('rejects a durable personal revoke during a platform grant', async () => {
    let epoch = 0;
    const s = setup({ readEpoch: () => epoch, platform: { bindingKey: () => 'binding', resolve: async () => {
      epoch++; return { jwt: jwt(), expiresAt: Date.now() + 60_000, bindingKey: 'binding', unionId: 'on_person' };
    } } });
    s.request.actor.source = 'platform';
    await expect(s.resolver.actor(s.request)).rejects.toMatchObject({ code: 'authorization_revoked' });
  });
  it('freezes the auto choice when an unbound machine becomes bound during local mint', async () => {
    let binding: string | undefined;
    const s = setup({ platform: { bindingKey: () => binding, resolve: async () => undefined },
      provider: { observe: async () => ({ authenticated: true, loginFingerprint: 'login' }),
        mint: async () => { binding = 'new-binding'; return jwt(); }, userinfo: async () => ({ username: 'person', email: 'person@example.test' }) } });
    s.request.actor.source = 'auto';
    await expect(s.resolver.actor(s.request)).rejects.toMatchObject({ code: 'binding_changed' });
  });
});
