import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { assertPluginPrerequisitesReady } from '../src/core/plugins/prerequisites.js';

let home: string;
afterEach(() => { vi.unstubAllEnvs(); if (home) rmSync(home, { recursive: true, force: true }); });

function fixture(required: boolean, entry?: string) {
  home = mkdtempSync(join(tmpdir(), 'botmux-prerequisites-'));
  vi.stubEnv('HOME', home);
  const source = join(home, 'source');
  mkdirSync(join(source, 'dist/prerequisites'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({
    name: '@fixture/prepared', version: '1.0.0', keywords: ['botmux-plugin'],
    botmux: { schemaVersion: 1, id: 'prepared', ...(required ? { prerequisites: true } : {}) },
  }));
  writeFileSync(join(source, 'dist/package.json'), '{"type":"module"}');
  if (entry) writeFileSync(join(source, 'dist/prerequisites/index.mjs'), entry);
  return source;
}

describe('explicit plugin prerequisites', () => {
  it('keeps ordinary plugin installation and enabling unchanged', async () => {
    installLocalPlugin(fixture(false, 'throw Error("must not execute");'));
    await expect(assertPluginPrerequisitesReady('prepared')).resolves.toBeUndefined();
  });

  it('does not commit a required plugin without its preparation entry', () => {
    expect(() => installLocalPlugin(fixture(true))).toThrow();
    expect(existsSync(join(home, '.botmux/plugins/prepared/dist'))).toBe(false);
  });

  it('starts preparation at install without a Dashboard token and checks fresh state before enabling', async () => {
    const source = fixture(true, `
      import {writeFileSync,readFileSync,existsSync} from 'node:fs';
      import {join} from 'node:path';
      import {homedir} from 'node:os';
      import {createHash} from 'node:crypto';
      const home = join(homedir(),'.botmux');
      const marker = join(home,'prepared.json');
      if(process.argv[2] === 'installed') {
        const record = JSON.parse(readFileSync(join(home,'plugins-registry.json'),'utf8')).plugins.prepared;
        const identity = createHash('sha256').update(JSON.stringify(record)).digest('hex');
        if(identity !== process.env.BOTMUX_PLUGIN_INSTALL_RECORD) throw Error('revoked');
        writeFileSync(marker,JSON.stringify({ready:false,installed:true}));
      } else console.log(existsSync(marker) ? readFileSync(marker,'utf8') : '{"ready":false}');
    `);
    const result = installLocalPlugin(source);
    expect(result.record.contributions?.prerequisites?.entry).toBeDefined();
    const marker = join(home, '.botmux/prepared.json');
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    expect(existsSync(join(home, '.botmux/.dashboard-token'))).toBe(false);
    const registry = readFileSync(join(home, '.botmux/plugins-registry.json'), 'utf8');
    await expect(assertPluginPrerequisitesReady('prepared')).rejects.toThrow();
    writeFileSync(marker, '{"ready":true}');
    await expect(assertPluginPrerequisitesReady('prepared')).resolves.toBeUndefined();
    writeFileSync(marker, '{"ready":false}');
    await expect(assertPluginPrerequisitesReady('prepared')).rejects.toThrow();
    expect(readFileSync(join(home, '.botmux/plugins-registry.json'), 'utf8')).toBe(registry);
  });

  it.each(['{"ready":"true"}', 'not json', 'null'])('rejects invalid or inconclusive live checks (%s)', async value => {
    installLocalPlugin(fixture(true, `
      if(process.argv[2] === 'check') console.log(${JSON.stringify(value)});
    `));
    await expect(assertPluginPrerequisitesReady('prepared')).rejects.toThrow();
  });
});
