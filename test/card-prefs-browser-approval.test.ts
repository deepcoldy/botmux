import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBot, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { getBotCardPrefs, updateBotCardPrefs } from '../src/services/card-prefs-store.js';

const previous = process.env.BOTS_CONFIG;
let dir = '';
afterEach(() => {
  if (previous === undefined) delete process.env.BOTS_CONFIG; else process.env.BOTS_CONFIG = previous;
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  dir = mkdtempSync(join(tmpdir(), 'site-policy-store-'));
  const path = join(dir, 'bots.json'); process.env.BOTS_CONFIG = path;
  const browser = { enabled: true, family: 'edge', pluginRoot: '/tmp/example-browser-plugin' };
  writeFileSync(path, JSON.stringify([
    { larkAppId: 'cli_policy_one', larkAppSecret: 'test', cliId: 'codex-app', codexBrowser: browser },
    { larkAppId: 'cli_policy_two', larkAppSecret: 'test', cliId: 'codex-app', codexBrowser: true },
  ]));
  loadBotConfigs().forEach(registerBot);
  return { path, browser, read: () => JSON.parse(readFileSync(path, 'utf8')) };
}
describe('bot-scoped browser approval preferences', () => {
  it('persists through reload, keeps Edge/pluginRoot and isolates another bot', async () => {
    const f = fixture();
    expect(getBotCardPrefs('cli_policy_one').codexBrowserAutoApproveOrigins).toBe(false);
    expect((await updateBotCardPrefs('cli_policy_one', { codexBrowserAutoApproveOrigins: true })).ok).toBe(true);
    expect(f.read()[0].codexBrowser).toEqual({ ...f.browser, autoApproveOrigins: true });
    expect(f.read()[1].codexBrowser).toBe(true);
    loadBotConfigs().forEach(registerBot);
    expect(getBotCardPrefs('cli_policy_one').codexBrowserAutoApproveOrigins).toBe(true);
    expect(getBotCardPrefs('cli_policy_two').codexBrowserAutoApproveOrigins).toBe(false);
    await updateBotCardPrefs('cli_policy_one', { codexBrowserAutoApproveOrigins: false });
    expect(f.read()[0].codexBrowser).toEqual(f.browser);
    expect(getBot('cli_policy_one').config.codexBrowser).toEqual(f.browser);
  });
  it('clears delegation when the bridge is disabled and does not revive it on re-enable', async () => {
    const f = fixture();
    await updateBotCardPrefs('cli_policy_one', { codexBrowserAutoApproveOrigins: true });
    await updateBotCardPrefs('cli_policy_one', { codexBrowser: false });
    expect(f.read()[0].codexBrowser).toBeUndefined();
    expect(getBotCardPrefs('cli_policy_one').codexBrowserAutoApproveOrigins).toBe(false);
    await updateBotCardPrefs('cli_policy_one', { codexBrowser: true });
    expect(getBotCardPrefs('cli_policy_one').codexBrowserAutoApproveOrigins).toBe(false);
  });
  it('rechecks the locked file when another writer disabled the bridge', async () => {
    const f = fixture(); const raw = f.read(); delete raw[0].codexBrowser;
    writeFileSync(f.path, JSON.stringify(raw));
    expect(await updateBotCardPrefs('cli_policy_one', { codexBrowserAutoApproveOrigins: true }))
      .toEqual({ ok: false, reason: 'codex_browser_not_enabled' });
    expect(f.read()[0].codexBrowser).toBeUndefined();
    expect(getBotCardPrefs('cli_policy_one').codexBrowserAutoApproveOrigins).toBe(false);
  });
});
