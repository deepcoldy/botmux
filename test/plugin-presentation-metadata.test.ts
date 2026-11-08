import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async original => {
  const os = await original<typeof import('node:os')>();
  return { ...os, homedir: () => fixture.home };
});
import { parsePluginPackageManifest } from '../src/core/plugins/manifest.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { getInstalledPlugin } from '../src/services/plugin-registry-store.js';

const base = { name: '@test/presentation', version: '1.0.0', keywords: ['botmux-plugin'], botmux: { schemaVersion: 1, id: 'presentation' } };
beforeEach(() => { fixture.home = mkdtempSync(join(tmpdir(), 'plugin-copy-')); });
afterEach(() => rmSync(fixture.home, { recursive: true, force: true }));
describe('optional plugin presentation metadata', () => {
  it('preserves standard package description and audience declaration', () => {
    const value = parsePluginPackageManifest({ ...base, description: '  Meeting voice output  ', botmux: { ...base.botmux, audience: ' Internal users ' } });
    expect(value.description).toBe('Meeting voice output');
    expect(value.botmux.audience).toBe('Internal users');
  });
  it('does not add metadata to legacy packages', () => {
    const value = parsePluginPackageManifest(base);
    expect(value).not.toHaveProperty('description');
    expect(value.botmux).not.toHaveProperty('audience');
  });
  it('ignores invalid or empty optional display strings', () => {
    const value = parsePluginPackageManifest({ ...base, description: 42, botmux: { ...base.botmux, audience: '  ' } });
    expect(value).not.toHaveProperty('description');
    expect(value.botmux).not.toHaveProperty('audience');
  });
  it('retains metadata in installed records without adding runtime capabilities', () => {
    const pkg = join(fixture.home, 'package');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({
      ...base, description: 'Meeting voice output', botmux: { ...base.botmux, audience: 'Internal users' },
    }));
    installLocalPlugin(pkg);
    const record = getInstalledPlugin('presentation')!;
    expect(record.description).toBe('Meeting voice output');
    expect(record.manifest.audience).toBe('Internal users');
    expect(record.contributions?.service).toBeUndefined();
    expect(record.contributions?.mcp).toBeUndefined();
  });
});
