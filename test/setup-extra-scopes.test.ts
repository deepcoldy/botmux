import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadExtraScopeManifest,
  mergeScopeManifests,
  parseExtraScopeManifest,
  resolveExtraScopes,
} from '../src/setup/extra-scopes.js';

describe('parseExtraScopeManifest', () => {
  it('accepts the bundled manifest shape with tenant/user buckets', () => {
    expect(parseExtraScopeManifest(JSON.stringify({
      scopes: { tenant: ['spark:app:read', 'spark:app:read'], user: ['spark:app:write'] },
    }))).toEqual({ scopes: { tenant: ['spark:app:read'], user: ['spark:app:write'] } });
  });

  it('treats entry lists (objects or bare strings) as user scopes', () => {
    expect(parseExtraScopeManifest(JSON.stringify({
      scopes: [{ scope: 'spark:app:read', for: 'apps' }, { scope: 'spark:app:write' }],
    }))).toEqual({ scopes: { tenant: [], user: ['spark:app:read', 'spark:app:write'] } });
    expect(parseExtraScopeManifest('["offline_access"]'))
      .toEqual({ scopes: { tenant: [], user: ['offline_access'] } });
  });

  it('rejects syntactically invalid scope names and malformed files', () => {
    expect(() => parseExtraScopeManifest('{"scopes":{"user":["not a scope"]}}')).toThrow(/not a scope/);
    expect(() => parseExtraScopeManifest('{"scopes":[{"for":"x"}]}')).toThrow(/scope 字段/);
    expect(() => parseExtraScopeManifest('{"scopes":{"tenant":"im:message"}}')).toThrow(/字符串数组/);
    expect(() => parseExtraScopeManifest('{}')).toThrow(/scopes/);
    expect(() => parseExtraScopeManifest('{oops')).toThrow(/JSON/);
  });

  it('rejects unknown bucket keys instead of silently dropping them', () => {
    expect(() => parseExtraScopeManifest('{"scopes":{"tentant":["spark:app:read"]}}')).toThrow(/tentant/);
    expect(() => parseExtraScopeManifest('{"scopes":{"user":["spark:app:read"],"version":1}}')).toThrow(/version/);
    expect(parseExtraScopeManifest('{"scopes":{"tenant":["spark:app:read"]}}'))
      .toEqual({ scopes: { tenant: ['spark:app:read'], user: [] } });
    expect(parseExtraScopeManifest('{"scopes":[{"scope":"spark:app:read","for":"apps","desc":"x"}]}'))
      .toEqual({ scopes: { tenant: [], user: ['spark:app:read'] } });
  });
});

describe('loadExtraScopeManifest', () => {
  it('reads a file and names the path in errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-extra-scopes-'));
    const good = join(dir, 'good.json');
    writeFileSync(good, '{"scopes":{"tenant":["spark:app:read"]}}');
    expect(loadExtraScopeManifest(good).scopes.tenant).toEqual(['spark:app:read']);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"scopes":{"user":["bad scope"]}}');
    expect(() => loadExtraScopeManifest(bad)).toThrow(bad);
    expect(() => loadExtraScopeManifest(join(dir, 'missing.json'))).toThrow(/missing\.json/);
  });
});

describe('mergeScopeManifests', () => {
  it('merges per token bucket and de-duplicates, keeping base order first', () => {
    expect(mergeScopeManifests(
      { scopes: { tenant: ['im:message', 'im:chat'], user: ['im:message'] } },
      { scopes: { tenant: ['im:chat', 'spark:app:read'], user: ['spark:app:read'] } },
    )).toEqual({
      scopes: {
        tenant: ['im:message', 'im:chat', 'spark:app:read'],
        // 同名 scope 在 user 桶独立保留：tenant/user 是两份授权。
        user: ['im:message', 'spark:app:read'],
      },
    });
  });
});

describe('resolveExtraScopes', () => {
  const base = { scopes: { tenant: ['im:message'], user: ['im:message'] } };
  const dir = mkdtempSync(join(tmpdir(), 'botmux-extra-scopes-resolve-'));
  const fileA = join(dir, 'a.json');
  const fileB = join(dir, 'b.json');
  const dupFile = join(dir, 'dup.json');
  const emptyFile = join(dir, 'empty.json');
  writeFileSync(fileA, '{"scopes":{"tenant":["spark:app:read"],"user":["spark:app:read"]}}');
  writeFileSync(fileB, '{"scopes":["spark:app:write"]}');
  writeFileSync(dupFile, '{"scopes":{"tenant":["im:message"]}}');
  writeFileSync(emptyFile, '{"scopes":{}}');

  it('does nothing when neither requested nor saved', () => {
    expect(resolveExtraScopes({ requested: undefined, base })).toEqual({});
  });

  it('applies an explicit file, persists its absolute path and counts per-bucket additions', () => {
    const result = resolveExtraScopes({ requested: fileA, base });
    expect(result.persist).toBe(fileA);
    expect(result.manifest).toEqual({
      scopes: { tenant: ['im:message', 'spark:app:read'], user: ['im:message', 'spark:app:read'] },
    });
    expect(result.report).toEqual({ file: fileA, merged: true, addedScopeCount: 2 });
  });

  it('resolves relative paths against cwd before persisting', () => {
    const result = resolveExtraScopes({ requested: relative(process.cwd(), fileA), base });
    expect(result.persist).toBe(fileA);
    expect(isAbsolute(result.report!.file!)).toBe(true);
  });

  it('reuses the saved path without rewriting it', () => {
    const result = resolveExtraScopes({ requested: undefined, saved: fileA, base });
    expect(result.persist).toBeUndefined();
    expect(result.manifest?.scopes.tenant).toContain('spark:app:read');
    expect(result.report).toMatchObject({ file: fileA, merged: true });
    expect(resolveExtraScopes({ requested: fileA, saved: fileA, base }).persist).toBeUndefined();
  });

  it('never asks to persist on reuse, even when the saved spelling is not normalized', () => {
    const dotted = resolveExtraScopes({ requested: undefined, saved: `${dir}/./a.json`, base });
    expect(dotted).not.toHaveProperty('persist');
    expect(dotted.report).toMatchObject({ file: fileA, merged: true });

    const tilde = resolveExtraScopes({ requested: undefined, saved: '~/botmux-extra-scopes-missing.json', base });
    expect(tilde).not.toHaveProperty('persist');
    expect(tilde.report).toMatchObject({ file: join(homedir(), 'botmux-extra-scopes-missing.json'), merged: false });
  });

  it('does not guess a relative saved path against cwd', () => {
    const result = resolveExtraScopes({ requested: undefined, saved: 'scopes.json', base });
    expect(result.manifest).toBeUndefined();
    expect(result).not.toHaveProperty('persist');
    expect(result.report).toMatchObject({ file: 'scopes.json', merged: false });
    expect(result.report?.warning).toMatch(/不是绝对路径/);
  });

  it('ignores blank / non-string saved values on reuse but still clears them on "-"', () => {
    for (const saved of ['', '   ', 42, null]) {
      expect(resolveExtraScopes({ requested: undefined, saved, base })).toEqual({});
      expect(resolveExtraScopes({ requested: null, saved, base })).toMatchObject({ persist: null, report: { cleared: true } });
    }
  });

  it('lets an explicit file override the saved one', () => {
    const result = resolveExtraScopes({ requested: fileB, saved: fileA, base });
    expect(result.persist).toBe(fileB);
    expect(result.manifest).toEqual({ scopes: { tenant: ['im:message'], user: ['im:message', 'spark:app:write'] } });
  });

  it('degrades to the built-in list with a warning when the saved file is unreadable or invalid', () => {
    const missing = join(dir, 'gone.json');
    const result = resolveExtraScopes({ requested: undefined, saved: missing, base });
    expect(result.manifest).toBeUndefined();
    expect(result.persist).toBeUndefined();
    expect(result.report).toMatchObject({ file: missing, merged: false, addedScopeCount: 0 });
    expect(result.report?.warning).toMatch(/gone\.json/);
    expect(result.report?.warning).toMatch(/--extra-scopes-file -/);

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{"scopes":{"user":["bad scope"]}}');
    expect(resolveExtraScopes({ requested: undefined, saved: broken, base }).report)
      .toMatchObject({ file: broken, merged: false });
  });

  it('still fails hard when an explicitly requested file is unreadable', () => {
    expect(() => resolveExtraScopes({ requested: join(dir, 'gone.json'), saved: fileA, base })).toThrow(/gone\.json/);
  });

  it('clears the saved path on "-" and reports a no-op when nothing was saved', () => {
    expect(resolveExtraScopes({ requested: null, saved: fileA, base })).toEqual({
      persist: null,
      report: { file: null, merged: false, addedScopeCount: 0, cleared: true },
    });
    expect(resolveExtraScopes({ requested: null, base })).toEqual({
      report: { file: null, merged: false, addedScopeCount: 0 },
    });
  });

  it('warns when the file adds nothing beyond the built-in list', () => {
    for (const file of [emptyFile, dupFile]) {
      const result = resolveExtraScopes({ requested: file, base });
      expect(result.report).toMatchObject({ file, merged: true, addedScopeCount: 0 });
      expect(result.report?.warning).toMatch(/未贡献内置清单之外的权限/);
    }
  });
});
