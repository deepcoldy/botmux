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
  dir = mkdtempSync(join(tmpdir(), 'goal-status-card-store-'));
  const path = join(dir, 'bots.json'); process.env.BOTS_CONFIG = path;
  writeFileSync(path, JSON.stringify([
    { larkAppId: 'cli_goal_one', larkAppSecret: 'fixture', cliId: 'codex' },
    { larkAppId: 'cli_goal_two', larkAppSecret: 'fixture', cliId: 'traex' },
  ]));
  loadBotConfigs().forEach(registerBot);
  return { read: () => JSON.parse(readFileSync(path, 'utf8')) };
}

describe('goal status card bot switch', () => {
  it('is off by default, persists only when on, and stays per bot across reloads', async () => {
    const f = fixture();
    expect(getBotCardPrefs('cli_goal_one').goalStatusCard).toBe(false);
    expect(botDefaultsPayload({ larkAppId: 'cli_goal_one' }, getBotCardPrefs('cli_goal_one')).goalStatusCard).toBe(false);
    expect((await updateBotCardPrefs('cli_goal_one', { goalStatusCard: true })).ok).toBe(true);
    expect(getBot('cli_goal_one').config.goalStatusCard).toBe(true);
    expect(f.read()[0].goalStatusCard).toBe(true);
    expect(f.read()[1]).not.toHaveProperty('goalStatusCard');
    loadBotConfigs().forEach(registerBot);
    expect(getBotCardPrefs('cli_goal_one').goalStatusCard).toBe(true);
    expect(getBotCardPrefs('cli_goal_two').goalStatusCard).toBe(false);
    expect(botDefaultsPayload({ larkAppId: 'cli_goal_one' }, getBotCardPrefs('cli_goal_one')).goalStatusCard).toBe(true);
    expect((await updateBotCardPrefs('cli_goal_one', { goalStatusCard: false })).ok).toBe(true);
    expect(f.read()[0]).not.toHaveProperty('goalStatusCard');
    expect(getBot('cli_goal_one').config.goalStatusCard).toBeUndefined();
  });
  it('round-trips through /botconfig without writing the default', async () => {
    const f = fixture(); const field = findConfigField('goalStatusCard')!;
    expect(field.effect).toBe('next-session');
    expect((await applyConfigField('cli_goal_two', field, true)).ok).toBe(true);
    expect(f.read()[1].goalStatusCard).toBe(true);
    expect(getBotCardPrefs('cli_goal_two').goalStatusCard).toBe(true);
    expect((await applyConfigField('cli_goal_two', field, false)).ok).toBe(true);
    expect(f.read()[1]).not.toHaveProperty('goalStatusCard');
    expect(getBot('cli_goal_two').config.goalStatusCard).toBeUndefined();
  });
});
