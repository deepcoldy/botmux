import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRawConfig, writeRawConfigAtomic, findEntryIndex } from '../src/services/config-store.js';

let dir: string; let cfg: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfgstore-'));
  cfg = join(dir, 'bots.json');
  writeFileSync(cfg, JSON.stringify([{ larkAppId: 'a1', allowedUsers: ['ou_x'] }], null, 2), { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('config-store', () => {
  it('writeRawConfigAtomic keeps file 0o600', async () => {
    const raw = await readRawConfig(cfg);
    raw[0].allowedUsers.push('ou_y');
    await writeRawConfigAtomic(cfg, raw);
    expect(statSync(cfg).mode & 0o777).toBe(0o600);
    expect((await readRawConfig(cfg))[0].allowedUsers).toEqual(['ou_x', 'ou_y']);
  });

  it('findEntryIndex matches by larkAppId', async () => {
    expect(findEntryIndex(await readRawConfig(cfg), 'a1')).toBe(0);
    expect(findEntryIndex(await readRawConfig(cfg), 'nope')).toBe(-1);
  });
});
