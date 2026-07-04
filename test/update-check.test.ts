import { describe, expect, it } from 'vitest';
import {
  parseVersion,
  isStableVersion,
  compareVersions,
  isNewerVersion,
  selectReleasesSince,
  fetchLatestVersion,
  fetchReleasesSince,
} from '../src/core/update-check.js';

describe('parseVersion', () => {
  it('parses plain and v-prefixed stable versions', () => {
    expect(parseVersion('2.85.1')).toEqual({ major: 2, minor: 85, patch: 1, pre: [] });
    expect(parseVersion('v2.85.1')).toEqual({ major: 2, minor: 85, patch: 1, pre: [] });
  });
  it('parses prerelease identifiers', () => {
    expect(parseVersion('2.85.1-canary.3')).toEqual({ major: 2, minor: 85, patch: 1, pre: ['canary', '3'] });
  });
  it('rejects garbage', () => {
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('2.85')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(undefined as unknown as string)).toBeNull();
  });
});

describe('isStableVersion', () => {
  it('true only for parseable non-prerelease', () => {
    expect(isStableVersion('2.85.1')).toBe(true);
    expect(isStableVersion('2.85.1-canary.0')).toBe(false);
    expect(isStableVersion('nope')).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders by major/minor/patch', () => {
    expect(compareVersions('2.85.1', '2.85.0')).toBe(1);
    expect(compareVersions('2.84.9', '2.85.0')).toBe(-1);
    expect(compareVersions('3.0.0', '2.99.99')).toBe(1);
    expect(compareVersions('2.85.1', '2.85.1')).toBe(0);
  });
  it('stable outranks prerelease of the same core', () => {
    expect(compareVersions('2.85.1', '2.85.1-canary.0')).toBe(1);
    expect(compareVersions('2.85.1-rc.1', '2.85.1')).toBe(-1);
  });
  it('compares prerelease identifiers per semver', () => {
    expect(compareVersions('2.85.1-canary.2', '2.85.1-canary.10')).toBe(-1); // numeric
    expect(compareVersions('2.85.1-alpha', '2.85.1-beta')).toBe(-1);          // lexical
    expect(compareVersions('2.85.1-rc.1', '2.85.1-rc.1.1')).toBe(-1);         // shorter < longer
    expect(compareVersions('2.85.1-1', '2.85.1-alpha')).toBe(-1);             // numeric < alnum
  });
  it('unparseable sorts smallest', () => {
    expect(compareVersions('garbage', '0.0.1')).toBe(-1);
    expect(compareVersions('1.0.0', 'garbage')).toBe(1);
    expect(compareVersions('x', 'y')).toBe(0);
  });
});

describe('isNewerVersion', () => {
  it('is strict', () => {
    expect(isNewerVersion('2.85.1', '2.85.0')).toBe(true);
    expect(isNewerVersion('2.85.1', '2.85.1')).toBe(false);
    expect(isNewerVersion('2.85.0', '2.85.1')).toBe(false);
  });

  // The update check always compares against the stable `latest` dist-tag (the
  // update button installs `@latest` = stable). These lock in the canary policy:
  // a canary running AHEAD of the latest stable must NOT be prompted to update,
  // while a canary that merely preceded the now-released stable should be.
  it('does not prompt a canary that is ahead of the latest stable', () => {
    expect(isNewerVersion('2.86.0', '2.87.0-canary.0')).toBe(false); // minor ahead
    expect(isNewerVersion('2.86.0', '2.86.1-canary.0')).toBe(false); // patch ahead
  });
  it('prompts a canary precursor when its stable (or a newer stable) is released', () => {
    expect(isNewerVersion('2.86.0', '2.86.0-canary.5')).toBe(true);  // stable finalizes its own canary
    expect(isNewerVersion('2.87.0', '2.87.0-canary.3')).toBe(true);
  });
});

describe('selectReleasesSince', () => {
  const raw = [
    { tag_name: 'v2.85.1', name: 'release 2.85.1', body: 'notes 1', html_url: 'u1', published_at: '2026-06-21T00:00:00Z' },
    { tag_name: 'v2.85.0', name: '', body: 'notes 0', html_url: 'u0', published_at: '2026-06-20T00:00:00Z' },
    { tag_name: 'v2.84.1', name: 'old', body: 'old notes', html_url: 'uo', published_at: '2026-06-19T00:00:00Z' },
    { tag_name: 'v2.86.0-canary.1', name: 'canary', body: 'c', html_url: 'uc', published_at: '2026-06-22T00:00:00Z', prerelease: true },
    { tag_name: 'v2.87.0', name: 'draft', body: 'd', html_url: 'ud', published_at: '2026-06-23T00:00:00Z', draft: true },
  ];

  it('keeps only stable releases newer than current, newest first', () => {
    const out = selectReleasesSince(raw, '2.84.1');
    expect(out.map(r => r.version)).toEqual(['2.85.1', '2.85.0']);
  });
  it('falls back name to the tag when GitHub name is empty', () => {
    const out = selectReleasesSince(raw, '2.84.1');
    expect(out.find(r => r.version === '2.85.0')?.name).toBe('v2.85.0');
  });
  it('excludes prereleases and drafts even if newer', () => {
    const out = selectReleasesSince(raw, '2.85.1');
    expect(out).toEqual([]);
  });
  it('honors the cap', () => {
    expect(selectReleasesSince(raw, '2.84.1', 1).map(r => r.version)).toEqual(['2.85.1']);
  });
  it('tolerates malformed entries', () => {
    const out = selectReleasesSince([null, 42, { tag_name: 5 }, { tag_name: 'v2.85.2', body: 'x', html_url: 'u' }] as unknown[], '2.85.1');
    expect(out.map(r => r.version)).toEqual(['2.85.2']);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe('fetchLatestVersion', () => {
  it('returns the registry version', async () => {
    const v = await fetchLatestVersion({ fetchImpl: async () => jsonResponse(200, { version: '2.85.1' }) });
    expect(v).toBe('2.85.1');
  });
  it('null on non-200 / malformed / unparseable / throw', async () => {
    expect(await fetchLatestVersion({ fetchImpl: async () => jsonResponse(503, {}) })).toBeNull();
    expect(await fetchLatestVersion({ fetchImpl: async () => jsonResponse(200, {}) })).toBeNull();
    expect(await fetchLatestVersion({ fetchImpl: async () => jsonResponse(200, { version: 'latest' }) })).toBeNull();
    expect(await fetchLatestVersion({ fetchImpl: async () => { throw new Error('offline'); } })).toBeNull();
  });
});

describe('fetchReleasesSince', () => {
  it('maps + filters the releases array (ok:true)', async () => {
    const releases = [{ tag_name: 'v2.85.1', body: 'n', html_url: 'u', published_at: 'x' }];
    const out = await fetchReleasesSince('2.85.0', { fetchImpl: async () => jsonResponse(200, releases) });
    expect(out.ok).toBe(true);
    expect(out.releases.map(r => r.version)).toEqual(['2.85.1']);
  });
  it('ok:true with an empty list when already latest (genuinely empty)', async () => {
    const out = await fetchReleasesSince('2.85.1', { fetchImpl: async () => jsonResponse(200, [{ tag_name: 'v2.85.1' }]) });
    expect(out).toMatchObject({ ok: true, releases: [] });
  });
  it('ok:false on failure, flags rate-limit on 403', async () => {
    const rl = await fetchReleasesSince('2.85.0', { fetchImpl: async () => jsonResponse(403, {}) });
    expect(rl).toMatchObject({ ok: false, rateLimited: true, releases: [] });
    expect(await fetchReleasesSince('2.85.0', { fetchImpl: async () => jsonResponse(404, {}) })).toMatchObject({ ok: false, releases: [] });
    expect(await fetchReleasesSince('2.85.0', { fetchImpl: async () => jsonResponse(200, { not: 'array' }) })).toMatchObject({ ok: false, releases: [] });
    expect(await fetchReleasesSince('2.85.0', { fetchImpl: async () => { throw new Error('x'); } })).toMatchObject({ ok: false, releases: [] });
  });
});
