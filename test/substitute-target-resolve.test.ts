import { describe, it, expect, vi } from 'vitest';
import { resolveSubstituteTargets, type SubstituteResolveDeps } from '../src/services/substitute-mode-store.js';

vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {} }));

const NAMES: Record<string, string> = { ou_alice: 'Alice', ou_bob: 'Bob', ou_direct: 'Direct' };

const deps: SubstituteResolveDeps = {
  async resolveRaw(_app, raw) {
    const map = new Map<string, string>();
    for (const r of raw) {
      if (r === 'alice@x.com') map.set(r, 'ou_alice');
      else if (r === 'on_bob') map.set(r, 'ou_bob');
      else if (r.startsWith('ou_')) map.set(r, r); // open_id maps to itself
      // ghost@x.com intentionally unresolvable
    }
    return { resolved: [...new Set(map.values())], map };
  },
  async getProfile(_app, openId) {
    return NAMES[openId] ? { name: NAMES[openId] } : null;
  },
};

describe('resolveSubstituteTargets', () => {
  it('resolves email → open_id and attaches the fresh display name', async () => {
    const { targets, resolution } = await resolveSubstituteTargets('app', [{ email: 'alice@x.com' }], deps);
    expect(targets).toEqual([{ openId: 'ou_alice', name: 'Alice', email: 'alice@x.com' }]);
    expect(resolution).toEqual([{ input: 'alice@x.com', ok: true, openId: 'ou_alice', name: 'Alice', avatarUrl: undefined }]);
  });

  it('resolves union_id and a directly-pasted open_id', async () => {
    const { targets } = await resolveSubstituteTargets('app', [{ unionId: 'on_bob' }, { openId: 'ou_direct' }], deps);
    expect(targets).toEqual([
      { openId: 'ou_bob', name: 'Bob' },
      { openId: 'ou_direct', name: 'Direct' },
    ]);
  });

  it('drops an unresolvable email from targets but reports it ok:false', async () => {
    const { targets, resolution } = await resolveSubstituteTargets('app', [
      { email: 'alice@x.com' },
      { email: 'ghost@x.com' },
    ], deps);
    expect(targets).toEqual([{ openId: 'ou_alice', name: 'Alice', email: 'alice@x.com' }]);
    expect(resolution.map(r => [r.input, r.ok])).toEqual([['alice@x.com', true], ['ghost@x.com', false]]);
  });

  it('dedupes the same person while keeping a chip per input line', async () => {
    const { targets, resolution } = await resolveSubstituteTargets('app', [
      { email: 'alice@x.com' },
      { openId: 'ou_alice' },
    ], deps);
    expect(targets).toEqual([{ openId: 'ou_alice', name: 'Alice', email: 'alice@x.com' }]);
    expect(resolution).toHaveLength(2);
    expect(resolution.every(r => r.ok)).toBe(true);
  });

  it('passes a tenant user_id through untouched', async () => {
    const { targets, resolution } = await resolveSubstituteTargets('app', [{ userId: 'u_x', name: 'Xavier' }], deps);
    expect(targets).toEqual([{ userId: 'u_x', name: 'Xavier' }]);
    expect(resolution).toEqual([{ input: 'u_x', ok: true, name: 'Xavier' }]);
  });

  it('degrades to all-unresolved when the resolver throws', async () => {
    const boom: SubstituteResolveDeps = { resolveRaw: async () => { throw new Error('no creds'); }, getProfile: deps.getProfile };
    const { targets, resolution } = await resolveSubstituteTargets('app', [{ email: 'alice@x.com' }], boom);
    expect(targets).toEqual([]);
    expect(resolution).toEqual([{ input: 'alice@x.com', ok: false }]);
  });
});
