import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBot, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { getBotCardPrefs, updateBotCardPrefs } from '../src/services/card-prefs-store.js';
import { applyConfigField, findConfigField } from '../src/services/bot-config-store.js';

const previous = process.env.BOTS_CONFIG;
let dir = '';
afterEach(() => {
  if (previous === undefined) delete process.env.BOTS_CONFIG; else process.env.BOTS_CONFIG = previous;
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  dir = mkdtempSync(join(tmpdir(), 'native-cot-store-'));
  const path = join(dir, 'bots.json'); process.env.BOTS_CONFIG = path;
  writeFileSync(path, JSON.stringify([
    { larkAppId: 'cli_native_one', larkAppSecret: 'fixture', cliId: 'codex', replyCardMode: 'unified', cotEnabled: false },
    { larkAppId: 'cli_native_two', larkAppSecret: 'fixture', cliId: 'claude-code' },
  ]));
  loadBotConfigs().forEach(registerBot);
  return { read: () => JSON.parse(readFileSync(path, 'utf8')) };
}
describe('independent native CoT preference', () => {
  it('defaults off, persists across reload and mode switches, and isolates other preferences and bots', async () => {
    const f = fixture();
    expect(getBotCardPrefs('cli_native_one').replyCardNativeCot).toBe(false);
    expect((await updateBotCardPrefs('cli_native_one', { replyCardNativeCot: true })).ok).toBe(true);
    expect(getBot('cli_native_one').config.replyCardNativeCot).toBe(true);
    expect(f.read()[0]).toMatchObject({ cotEnabled: false, replyCardNativeCot: true });
    loadBotConfigs().forEach(registerBot);
    expect(getBotCardPrefs('cli_native_one')).toMatchObject({ cotEnabled: false, replyCardNativeCot: true });
    expect(getBotCardPrefs('cli_native_two').replyCardNativeCot).toBe(false);
    await updateBotCardPrefs('cli_native_one', { replyCardMode: 'legacy' });
    expect(f.read()[0].replyCardNativeCot).toBe(true);
    await updateBotCardPrefs('cli_native_one', { replyCardMode: 'unified', replyCardNativeCot: false });
    expect(f.read()[0]).not.toHaveProperty('replyCardNativeCot');
    expect(f.read()[0].cotEnabled).toBe(false);
    loadBotConfigs().forEach(registerBot);
    expect(getBotCardPrefs('cli_native_one').replyCardNativeCot).toBe(false);
  });
  it('supports the same round trip through /config without resetting card activity', async () => {
    const f = fixture(); const field = findConfigField('replyCardNativeCot')!;
    expect((await applyConfigField('cli_native_one', field, true)).ok).toBe(true);
    expect(getBotCardPrefs('cli_native_one')).toMatchObject({ cotEnabled: false, replyCardNativeCot: true });
    expect((await applyConfigField('cli_native_one', field, false)).ok).toBe(true);
    expect(f.read()[0]).not.toHaveProperty('replyCardNativeCot');
    expect(getBot('cli_native_one').config.replyCardNativeCot).toBeUndefined();
    expect(getBotCardPrefs('cli_native_one').cotEnabled).toBe(false);
  });
});
