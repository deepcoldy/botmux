import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadExtraScopeManifest,
  mergeScopeManifests,
  parseExtraScopeManifest,
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
