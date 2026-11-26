import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBot, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { getBotCardPrefs, updateBotCardPrefs } from '../src/services/card-prefs-store.js';
import { applyConfigField, findConfigField } from '../src/services/bot-config-store.js';
import {
  broadcastFoldBackgroundUpdatesToWorkers,
  registerFoldBackgroundUpdatesChangeHandler,
} from '../src/services/fold-background-updates-change.js';
import { botDefaultsPayload } from '../src/dashboard/bot-payload.js';

const previous = process.env.BOTS_CONFIG;
let dir = '';
afterEach(() => {
  if (previous === undefined) delete process.env.BOTS_CONFIG; else process.env.BOTS_CONFIG = previous;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  dir = mkdtempSync(join(tmpdir(), 'fold-bg-updates-store-'));
  const path = join(dir, 'bots.json');
  process.env.BOTS_CONFIG = path;
  writeFileSync(path, JSON.stringify([
    { larkAppId: 'cli_fold_one', larkAppSecret: 'fixture', cliId: 'claude-code' },
    { larkAppId: 'cli_fold_two', larkAppSecret: 'fixture', cliId: 'claude-code', foldBackgroundUpdates: true },
  ]));
  loadBotConfigs().forEach(registerBot);
  return { read: () => JSON.parse(readFileSync(path, 'utf8')) };
}

describe('foldBackgroundUpdates bot switch persistence and live sync', () => {
  it('is off by default, persists only when true, updates live bot.config, and stays isolated per bot', async () => {
    const f = fixture();
    expect(getBotCardPrefs('cli_fold_one').foldBackgroundUpdates).toBe(false);
    expect(getBotCardPrefs('cli_fold_two').foldBackgroundUpdates).toBe(true);
    expect(botDefaultsPayload({ larkAppId: 'cli_fold_one' }, getBotCardPrefs('cli_fold_one')).foldBackgroundUpdates).toBe(false);

    expect((await updateBotCardPrefs('cli_fold_one', { foldBackgroundUpdates: true })).ok).toBe(true);
    expect(getBot('cli_fold_one').config.foldBackgroundUpdates).toBe(true);
    expect(f.read()[0].foldBackgroundUpdates).toBe(true);
    loadBotConfigs().forEach(registerBot);
    expect(getBotCardPrefs('cli_fold_one').foldBackgroundUpdates).toBe(true);
    expect(botDefaultsPayload({ larkAppId: 'cli_fold_one' }, getBotCardPrefs('cli_fold_one')).foldBackgroundUpdates).toBe(true);

    // Turning off deletes the key on disk (never writes `false`) and clears in-memory flag.
    expect((await updateBotCardPrefs('cli_fold_two', { foldBackgroundUpdates: false })).ok).toBe(true);
    expect(f.read()[1]).not.toHaveProperty('foldBackgroundUpdates');
    expect(getBot('cli_fold_two').config.foldBackgroundUpdates).toBeUndefined();
    // Other bot stays untouched.
    expect(f.read()[0].foldBackgroundUpdates).toBe(true);
  });

  it('agrees with /botconfig applyConfigField and notifies live workers after updating in-memory bot.config', async () => {
    const f = fixture();
    const field = findConfigField('foldBackgroundUpdates')!;
    expect(field).toMatchObject({ key: 'foldBackgroundUpdates', kind: 'boolean', effect: 'immediate' });

    const observed: Array<{ appId: string; enabled: boolean; inMemory: boolean | undefined }> = [];
    const unregister = registerFoldBackgroundUpdatesChangeHandler((appId, enabled) => {
      observed.push({ appId, enabled, inMemory: getBot(appId).config.foldBackgroundUpdates });
    });
    try {
      expect((await applyConfigField('cli_fold_one', field, true)).ok).toBe(true);
      expect(getBotCardPrefs('cli_fold_one').foldBackgroundUpdates).toBe(true);
      expect((await updateBotCardPrefs('cli_fold_one', { foldBackgroundUpdates: false })).ok).toBe(true);
      expect(f.read()[0]).not.toHaveProperty('foldBackgroundUpdates');
      expect((await applyConfigField('cli_fold_one', field, false)).ok).toBe(true);
      expect(f.read()[0]).not.toHaveProperty('foldBackgroundUpdates');
    } finally {
      unregister();
    }
    expect(observed).toEqual([
      { appId: 'cli_fold_one', enabled: true, inMemory: true },
      { appId: 'cli_fold_one', enabled: false, inMemory: undefined },
      { appId: 'cli_fold_one', enabled: false, inMemory: undefined },
    ]);
  });

  it('broadcasts to deduplicated live workers for the matching bot only', () => {
    const sentOwn: unknown[] = [];
    const sentOther: unknown[] = [];
    const sharedSession = {
      larkAppId: 'app_a',
      worker: { killed: false, connected: true, send: (m: unknown) => { sentOwn.push(m); } },
    };
    const killedSession = {
      larkAppId: 'app_a',
      worker: { killed: true, connected: false, send: (m: unknown) => { sentOwn.push(m); } },
    };
    const disconnectedSession = {
      larkAppId: 'app_a',
      worker: { killed: false, connected: false, send: (m: unknown) => { sentOwn.push(m); } },
    };
    const otherBotSession = {
      larkAppId: 'app_b',
      worker: { killed: false, connected: true, send: (m: unknown) => { sentOther.push(m); } },
    };
    // Duplicate reference in iterable must only send once.
    broadcastFoldBackgroundUpdatesToWorkers(
      [sharedSession, sharedSession, killedSession, disconnectedSession, otherBotSession],
      'app_a',
      true,
    );
    expect(sentOwn).toEqual([{ type: 'set_fold_background_updates', enabled: true }]);
    expect(sentOther).toEqual([]);

    // Optional custom dispatcher (daemon IPC bootstrap fence) receives matching deduplicated sessions.
    const dispatched: Array<{ appId: string; enabled: boolean }> = [];
    broadcastFoldBackgroundUpdatesToWorkers(
      [sharedSession, sharedSession, killedSession, otherBotSession],
      'app_a',
      false,
      (ds, enabled) => { dispatched.push({ appId: ds.larkAppId, enabled }); },
    );
    expect(dispatched).toEqual([{ appId: 'app_a', enabled: false }]);
  });
});
