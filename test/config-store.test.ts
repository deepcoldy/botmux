import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, statSync, rmSync, readFileSync } from 'node:fs';
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

  it('rejects an impending quota fallback cycle before replacing the file', async () => {
    const before = readFileSync(cfg, 'utf8');
    const cyclic = [
      { larkAppId: 'cli_a', quotaFallbackBot: { enabled: true, targetAppId: 'cli_b' } },
      { larkAppId: 'cli_b', quotaFallbackBot: { enabled: true, targetAppId: 'cli_a' } },
    ];
    await expect(writeRawConfigAtomic(cfg, cyclic)).rejects.toThrow('cli_a -> cli_b -> cli_a');
    expect(readFileSync(cfg, 'utf8')).toBe(before);
  });
});
