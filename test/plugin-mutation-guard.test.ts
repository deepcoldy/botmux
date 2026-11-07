import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async original => {
  const os = await original<typeof import('node:os')>();
  return { ...os, homedir: () => state.home };
});
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { getInstalledPlugin } from '../src/services/plugin-registry-store.js';
import { pluginRecordHash, type PluginMutationGuard } from '../src/core/plugins/mutation-guard.js';

function pkg(name: string, version: string, id = 'sample') {
  const path = join(state.home, `package-${name.replace(/\W/g, '')}-${version}`);
  mkdirSync(join(path, 'dist'), { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version, keywords: ['botmux-plugin'], botmux: { schemaVersion: 1, id } }));
  writeFileSync(join(path, 'dist/marker'), `${name}@${version}`);
  return path;
}
function guard(previous: unknown = undefined): PluginMutationGuard {
  return { id: 'sample', packageName: '@test/sample', version: '1.2.3', expectedState: pluginRecordHash(previous) };
}
beforeEach(() => { state.home = mkdtempSync(join(tmpdir(), 'plugin-guard-')); });
afterEach(() => { rmSync(state.home, { recursive: true, force: true }); });

describe('locked plugin mutation preconditions', () => {
  it('commits a matching staged package into an unchanged empty slot', () => {
    installLocalPlugin(pkg('@test/sample', '1.2.3'), { guard: guard() });
    expect(getInstalledPlugin('sample')?.version).toBe('1.2.3');
  });
  it('refuses to overwrite a newly installed replacement after confirmation', () => {
    const confirmed = guard();
    installLocalPlugin(pkg('@human/replacement', '9.0.0'));
    expect(() => installLocalPlugin(pkg('@test/sample', '1.2.3'), { guard: confirmed })).toThrow();
    expect(getInstalledPlugin('sample')?.packageName).toBe('@human/replacement');
    expect(readFileSync(join(state.home, '.botmux/plugins/sample/dist/marker'), 'utf8')).toBe('@human/replacement@9.0.0');
  });
  it('validates the staged manifest before replacing any runtime', () => {
    expect(() => installLocalPlugin(pkg('@wrong/package', '1.2.3', 'unexpected'), { guard: guard() })).toThrow();
    expect(getInstalledPlugin('sample')).toBeUndefined();
    expect(getInstalledPlugin('unexpected')).toBeUndefined();
  });
  it('rejects a stale snapshot even when the desired package name is unchanged', () => {
    installLocalPlugin(pkg('@test/sample', '1.0.0'));
    const confirmed = guard(getInstalledPlugin('sample'));
    installLocalPlugin(pkg('@test/sample', '2.0.0'));
    expect(() => installLocalPlugin(pkg('@test/sample', '1.2.3'), { guard: confirmed })).toThrow();
    expect(getInstalledPlugin('sample')?.version).toBe('2.0.0');
  });
  it('revalidates the fixed local owner token at the locked commit', () => {
    mkdirSync(join(state.home, '.botmux'), { recursive: true });
    writeFileSync(join(state.home, '.botmux/.dashboard-token'), 'rotated');
    const confirmed = { ...guard(), authorityDigest: createHash('sha256').update('old-token').digest('hex') };
    expect(() => installLocalPlugin(pkg('@test/sample', '1.2.3'), { guard: confirmed })).toThrow();
    expect(getInstalledPlugin('sample')).toBeUndefined();
  });
});
