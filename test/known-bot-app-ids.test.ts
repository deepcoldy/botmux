import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knownBotAppIds } from '../src/services/known-bot-app-ids.js';

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'known-bots-'));
}

describe('knownBotAppIds', () => {
  it('unions the configured bots, the online descriptors and the own app id', () => {
    const dataDir = tempDataDir();
    const botsJsonPath = join(dataDir, 'bots.json');
    writeFileSync(botsJsonPath, JSON.stringify({ bots: [{ larkAppId: 'cli_conf' }, { appId: 'cli_legacy_key' }, {}] }));
    mkdirSync(join(dataDir, 'dashboard-daemons'), { recursive: true });
    writeFileSync(join(dataDir, 'dashboard-daemons', 'cli_online.json'), JSON.stringify({
      larkAppId: 'cli_online', ipcPort: 9, lastHeartbeat: Date.now(),
    }));
    writeFileSync(join(dataDir, 'dashboard-daemons', 'cli_stale.json'), JSON.stringify({
      larkAppId: 'cli_stale', ipcPort: 9, lastHeartbeat: Date.now() - 10 * 60_000,
    }));

    const known = knownBotAppIds({ dataDir, botsJsonPath, env: { BOTMUX_LARK_APP_ID: 'cli_self' } });
    expect([...known].sort()).toEqual(['cli_conf', 'cli_legacy_key', 'cli_online', 'cli_self']);
  });

  it('degrades to the own app id when bots.json is missing or unreadable', () => {
    const dataDir = tempDataDir();
    expect([...knownBotAppIds({ dataDir, botsJsonPath: join(dataDir, 'missing.json'), env: { BOTMUX_LARK_APP_ID: 'cli_self' } })])
      .toEqual(['cli_self']);
    const broken = join(dataDir, 'broken.json');
    writeFileSync(broken, '{not json');
    expect([...knownBotAppIds({ dataDir, botsJsonPath: broken, env: {} })]).toEqual([]);
  });

  describe('strict', () => {
    it('still unions the three sources when every source is readable', () => {
      const dataDir = tempDataDir();
      const botsJsonPath = join(dataDir, 'bots.json');
      writeFileSync(botsJsonPath, JSON.stringify([{ larkAppId: 'cli_conf' }]));
      mkdirSync(join(dataDir, 'dashboard-daemons'), { recursive: true });
      writeFileSync(join(dataDir, 'dashboard-daemons', 'cli_online.json'), JSON.stringify({
        larkAppId: 'cli_online', ipcPort: 9, lastHeartbeat: Date.now(),
      }));
      const known = knownBotAppIds({ dataDir, botsJsonPath, env: { BOTMUX_LARK_APP_ID: 'cli_self' }, strict: true });
      expect([...known].sort()).toEqual(['cli_conf', 'cli_online', 'cli_self']);
    });

    it('throws instead of degrading when bots.json is missing, malformed or shapeless', () => {
      const dataDir = tempDataDir();
      const env = { BOTMUX_LARK_APP_ID: 'cli_self' };
      expect(() => knownBotAppIds({ dataDir, botsJsonPath: join(dataDir, 'missing.json'), env, strict: true }))
        .toThrow(/cannot read bots\.json/);
      const broken = join(dataDir, 'broken.json');
      writeFileSync(broken, '{not json');
      expect(() => knownBotAppIds({ dataDir, botsJsonPath: broken, env, strict: true }))
        .toThrow(/not valid JSON/);
      const shapeless = join(dataDir, 'shapeless.json');
      writeFileSync(shapeless, JSON.stringify({ bots: 'nope' }));
      expect(() => knownBotAppIds({ dataDir, botsJsonPath: shapeless, env, strict: true }))
        .toThrow(/no bot list/);
      // The non-strict reading of the same files stays best-effort.
      expect([...knownBotAppIds({ dataDir, botsJsonPath: broken, env })]).toEqual(['cli_self']);
    });

    it('throws when the daemon registry exists but cannot be listed', () => {
      const dataDir = tempDataDir();
      const botsJsonPath = join(dataDir, 'bots.json');
      writeFileSync(botsJsonPath, JSON.stringify({ bots: [] }));
      // A regular file where the registry directory should be: readdir → ENOTDIR.
      writeFileSync(join(dataDir, 'dashboard-daemons'), '');
      expect(() => knownBotAppIds({ dataDir, botsJsonPath, env: {}, strict: true })).toThrow();
      expect([...knownBotAppIds({ dataDir, botsJsonPath, env: {} })]).toEqual([]);
    });
  });
});
