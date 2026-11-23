import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBot, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { getBotCardPrefs, updateBotCardPrefs } from '../src/services/card-prefs-store.js';
import { applyConfigField, findConfigField } from '../src/services/bot-config-store.js';
import { botDefaultsPayload } from '../src/dashboard/bot-payload.js';

const previous = process.env.BOTS_CONFIG;
let dir = '';
afterEach(() => {
  if (previous === undefined) delete process.env.BOTS_CONFIG; else process.env.BOTS_CONFIG = previous;
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  dir = mkdtempSync(join(tmpdir(), 'follow-up-reply-store-'));
  const path = join(dir, 'bots.json'); process.env.BOTS_CONFIG = path;
  writeFileSync(path, JSON.stringify([
    { larkAppId: 'cli_follow_one', larkAppSecret: 'fixture', cliId: 'codex' },
    { larkAppId: 'cli_follow_two', larkAppSecret: 'fixture', cliId: 'claude-code', followUpReply: true },
  ]));
  loadBotConfigs().forEach(registerBot);
  return { read: () => JSON.parse(readFileSync(path, 'utf8')) };
}

describe('mid-turn reply (followUpReply) dashboard switch', () => {
  it('is off by default, persists only when on, updates the live config the daemon reads, and stays per bot', async () => {
    const f = fixture();
    expect(getBotCardPrefs('cli_follow_one').followUpReply).toBe(false);
    expect(getBotCardPrefs('cli_follow_two').followUpReply).toBe(true);
    expect(botDefaultsPayload({ larkAppId: 'cli_follow_one' }, getBotCardPrefs('cli_follow_one')).followUpReply).toBe(false);
    expect((await updateBotCardPrefs('cli_follow_one', { followUpReply: true })).ok).toBe(true);
    expect(getBot('cli_follow_one').config.followUpReply).toBe(true);
    expect(f.read()[0].followUpReply).toBe(true);
    loadBotConfigs().forEach(registerBot);
    expect(getBotCardPrefs('cli_follow_one').followUpReply).toBe(true);
    expect(botDefaultsPayload({ larkAppId: 'cli_follow_one' }, getBotCardPrefs('cli_follow_one')).followUpReply).toBe(true);
    expect((await updateBotCardPrefs('cli_follow_two', { followUpReply: false })).ok).toBe(true);
    expect(f.read()[1]).not.toHaveProperty('followUpReply');
    expect(getBot('cli_follow_two').config.followUpReply).toBeUndefined();
    expect(f.read()[0].followUpReply).toBe(true);
  });

  it('agrees with /botconfig, which writes the same field', async () => {
    const f = fixture(); const field = findConfigField('followUpReply')!;
    expect((await applyConfigField('cli_follow_one', field, true)).ok).toBe(true);
    expect(getBotCardPrefs('cli_follow_one').followUpReply).toBe(true);
    expect((await updateBotCardPrefs('cli_follow_one', { followUpReply: false })).ok).toBe(true);
    expect(f.read()[0]).not.toHaveProperty('followUpReply');
  });
});
