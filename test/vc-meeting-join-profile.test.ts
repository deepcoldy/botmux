import { describe, expect, it } from 'bun:test';
import {
  ensureLarkCliBotProfile,
  larkCliProfileExists,
  type LarkCliProfileDeps,
} from '../src/vc-agent/polling-source.js';

/** In-memory lark-cli stand-in: records add calls, models list/add outcomes. */
function makeDeps(opts: {
  initialProfiles?: string[];
  /** When true, `listProfileNames` returns null (lark-cli missing/errors). */
  listUnavailable?: boolean;
  /** Force a status for the add call; default 0 (success). */
  addStatus?: number | null;
  addStderr?: string;
  /** Simulate a concurrent creator: mark profile present the moment add runs. */
  addRaces?: boolean;
}): { deps: LarkCliProfileDeps; addCalls: Array<{ profileName: string; appId: string; appSecret: string; brand: string }> } {
  const profiles = new Set(opts.initialProfiles ?? []);
  const addCalls: Array<{ profileName: string; appId: string; appSecret: string; brand: string }> = [];
  const deps: LarkCliProfileDeps = {
    listProfileNames() {
      return opts.listUnavailable ? null : [...profiles];
    },
    addProfile(input) {
      addCalls.push({
        profileName: input.profileName,
        appId: input.appId,
        appSecret: input.appSecret,
        brand: input.brand,
      });
      if (opts.addRaces) profiles.add(input.profileName);
      const status = opts.addStatus ?? 0;
      if (status === 0) profiles.add(input.profileName);
      return { status, stderr: opts.addStderr };
    },
  };
  return { deps, addCalls };
}

describe('ensureLarkCliBotProfile', () => {
  it('is a no-op when the profile already exists (never touches add)', () => {
    const { deps, addCalls } = makeDeps({ initialProfiles: ['cli_abc'] });
    const result = ensureLarkCliBotProfile(
      { profileName: 'cli_abc', appId: 'cli_abc', appSecret: 'secret' },
      deps,
    );
    expect(result).toEqual({ ok: true, created: false });
    expect(addCalls).toHaveLength(0);
  });

  it('provisions a missing profile from the stored secret via stdin', () => {
    const { deps, addCalls } = makeDeps({ initialProfiles: ['cli_other'] });
    const result = ensureLarkCliBotProfile(
      { profileName: 'cli_abc', appId: 'cli_abc', appSecret: 's3cr3t', brand: 'lark' },
      deps,
    );
    expect(result).toEqual({ ok: true, created: true });
    expect(addCalls).toEqual([
      { profileName: 'cli_abc', appId: 'cli_abc', appSecret: 's3cr3t', brand: 'lark' },
    ]);
  });

  it('defaults brand to feishu when unset', () => {
    const { deps, addCalls } = makeDeps({});
    ensureLarkCliBotProfile({ profileName: 'cli_abc', appId: 'cli_abc', appSecret: 'x' }, deps);
    expect(addCalls[0]?.brand).toBe('feishu');
  });

  it('fails closed with missing_secret when no appSecret is stored (never calls add)', () => {
    const { deps, addCalls } = makeDeps({});
    const result = ensureLarkCliBotProfile(
      { profileName: 'cli_abc', appId: 'cli_abc', appSecret: '' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_secret');
    expect(addCalls).toHaveLength(0);
  });

  it('surfaces add_failed with the lark-cli stderr when creation fails', () => {
    const { deps } = makeDeps({ addStatus: 2, addStderr: 'invalid app secret' });
    const result = ensureLarkCliBotProfile(
      { profileName: 'cli_abc', appId: 'cli_abc', appSecret: 'wrong' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('add_failed');
      expect(result.error).toContain('invalid app secret');
    }
  });

  it('treats a concurrent-create race (add fails but profile now present) as success', () => {
    // add returns exit 2 (already exists) but the profile is present afterwards.
    const { deps } = makeDeps({ addStatus: 2, addStderr: 'already exists', addRaces: true });
    const result = ensureLarkCliBotProfile(
      { profileName: 'cli_abc', appId: 'cli_abc', appSecret: 'x' },
      deps,
    );
    expect(result).toEqual({ ok: true, created: false });
  });

  it('treats an "already exists" add error as success even when enumeration is unavailable', () => {
    // Regression: `profile list` couldn't confirm existence (returns null), but
    // add reports the profile already exists → join must proceed, not fail.
    const { deps } = makeDeps({
      listUnavailable: true,
      addStatus: 2,
      addStderr: 'profile "cli_abc" already exists',
    });
    const result = ensureLarkCliBotProfile(
      { profileName: 'cli_abc', appId: 'cli_abc', appSecret: 'x' },
      deps,
    );
    expect(result).toEqual({ ok: true, created: false });
  });

  it('attempts provisioning (not a false positive) when lark-cli list is unavailable', () => {
    // listProfileNames returns null → must not report "exists"; goes to add.
    const { deps, addCalls } = makeDeps({ listUnavailable: true });
    const result = ensureLarkCliBotProfile(
      { profileName: 'cli_abc', appId: 'cli_abc', appSecret: 'x' },
      deps,
    );
    expect(result).toEqual({ ok: true, created: true });
    expect(addCalls).toHaveLength(1);
  });
});

describe('larkCliProfileExists', () => {
  it('is false for an empty/blank name without consulting lark-cli', () => {
    const { deps } = makeDeps({ initialProfiles: ['cli_abc'] });
    expect(larkCliProfileExists('', {}, deps)).toBe(false);
    expect(larkCliProfileExists('   ', {}, deps)).toBe(false);
  });

  it('matches an exact profile name', () => {
    const { deps } = makeDeps({ initialProfiles: ['cli_abc', 'cli_def'] });
    expect(larkCliProfileExists('cli_def', {}, deps)).toBe(true);
    expect(larkCliProfileExists('cli_zzz', {}, deps)).toBe(false);
  });

  it('reports false (not a crash) when lark-cli cannot be enumerated', () => {
    const { deps } = makeDeps({ listUnavailable: true });
    expect(larkCliProfileExists('cli_abc', {}, deps)).toBe(false);
  });
});
