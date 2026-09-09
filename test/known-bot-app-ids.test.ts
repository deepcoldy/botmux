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
});
