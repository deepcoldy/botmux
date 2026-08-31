import { describe, it, expect } from 'vitest';
import {
  DARWIN_CODEX_CA_BUNDLE_CANDIDATES,
  resolveDarwinCodexCaBundle,
  type CaBundleProbe,
} from '../src/utils/darwin-ca-bundle.js';

const ROOT_READONLY = { uid: 0, mode: 0o100644 };
const USER_WRITABLE = { uid: 501, mode: 0o100644 };

function probe(
  present: Record<string, { real?: string; stat?: { uid: number; mode: number } }>,
  overrides: Partial<CaBundleProbe> = {},
): Partial<CaBundleProbe> & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    platform: 'darwin',
    exists: (p) => p in present,
    realpath: (p) => present[p]?.real ?? p,
    stat: (p) => {
      const hit = Object.values(present).find(v => (v.real ?? '') === p);
      const stat = hit?.stat ?? Object.entries(present).find(([k]) => k === p)?.[1]?.stat;
      if (!stat) throw new Error(`no stat for ${p}`);
      return stat;
    },
    warn: (m) => { warnings.push(m); },
    warnings,
    ...overrides,
  };
}

describe('resolveDarwinCodexCaBundle', () => {
  it('is a no-op off darwin (Seatbelt is the only reason this exists)', () => {
    const p = probe({ '/etc/ssl/cert.pem': { real: '/private/etc/ssl/cert.pem', stat: ROOT_READONLY } });
    expect(resolveDarwinCodexCaBundle({ ...p, platform: 'linux' })).toBeUndefined();
  });

  it('returns the REALPATH, not the symlink: the sandbox exposes /private/etc, not /etc', () => {
    const p = probe({ '/etc/ssl/cert.pem': { real: '/private/etc/ssl/cert.pem', stat: ROOT_READONLY } });
    expect(resolveDarwinCodexCaBundle(p)).toBe('/private/etc/ssl/cert.pem');
  });

  it('prefers a root-owned bundle over an earlier user-writable one, regardless of list order', () => {
    const p = probe({
      // First in the list, but writable by the account the agent runs as.
      '/etc/ssl/cert.pem': { real: '/private/etc/ssl/cert.pem', stat: USER_WRITABLE },
      '/opt/homebrew/etc/ca-certificates/cert.pem': {
        real: '/opt/homebrew/etc/ca-certificates/cert.pem',
        stat: ROOT_READONLY,
      },
    });
    expect(resolveDarwinCodexCaBundle(p)).toBe('/opt/homebrew/etc/ca-certificates/cert.pem');
    expect(p.warnings).toEqual([]);
  });

  it('falls back to a user-writable bundle but says so (no trust store is worse)', () => {
    const p = probe({
      '/opt/homebrew/etc/ca-certificates/cert.pem': {
        real: '/opt/homebrew/etc/ca-certificates/cert.pem',
        stat: USER_WRITABLE,
      },
    });
    expect(resolveDarwinCodexCaBundle(p)).toBe('/opt/homebrew/etc/ca-certificates/cert.pem');
    expect(p.warnings.join('\n')).toContain('not root-owned/read-only');
  });

  it('rejects a group/other-writable bundle the same way as a foreign owner', () => {
    const p = probe({
      '/etc/ssl/cert.pem': { real: '/private/etc/ssl/cert.pem', stat: { uid: 0, mode: 0o100662 } },
    });
    expect(resolveDarwinCodexCaBundle(p)).toBe('/private/etc/ssl/cert.pem');
    expect(p.warnings.join('\n')).toContain('not root-owned/read-only');
  });

  it('returns undefined when no candidate exists, so the caller injects nothing', () => {
    expect(resolveDarwinCodexCaBundle(probe({}))).toBeUndefined();
  });

  it('keeps scanning when a candidate cannot be resolved', () => {
    const p = probe({
      '/etc/ssl/cert.pem': { real: '/private/etc/ssl/cert.pem', stat: ROOT_READONLY },
      '/opt/homebrew/etc/ca-certificates/cert.pem': {
        real: '/opt/homebrew/etc/ca-certificates/cert.pem',
        stat: ROOT_READONLY,
      },
    });
    const throwing = {
      ...p,
      realpath: (path: string) => {
        if (path === '/etc/ssl/cert.pem') throw new Error('EACCES');
        return path;
      },
    };
    expect(resolveDarwinCodexCaBundle(throwing)).toBe('/opt/homebrew/etc/ca-certificates/cert.pem');
  });

  it('probes the system bundle first (Homebrew copies go stale and are user-managed)', () => {
    expect(DARWIN_CODEX_CA_BUNDLE_CANDIDATES[0]).toBe('/etc/ssl/cert.pem');
    expect([...DARWIN_CODEX_CA_BUNDLE_CANDIDATES]).toEqual([
      '/etc/ssl/cert.pem',
      '/opt/homebrew/etc/ca-certificates/cert.pem',
      '/usr/local/etc/ca-certificates/cert.pem',
    ]);
  });
});
