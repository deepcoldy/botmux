/**
 * One-time startup migration of the legacy per-bot `overloadAlert` card-pref to
 * the machine-level global `hostOverloadAlert` (services/overload-alert-migration.ts).
 *
 * global-config is exercised against a real temp $HOME (its cross-process file
 * lock + atomic write are part of the contract). card-prefs-store is mocked so
 * the "which bots had the legacy toggle on" input + the best-effort clear are
 * observable without standing up a bot registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Legacy per-bot toggle state, keyed by appId; the mock reads from here.
const legacyOverloadAlert = new Map<string, boolean>();
// Records best-effort clears so we can assert they ran post-migration.
const clearedPrefs: Array<{ appId: string; patch: Record<string, unknown> }> = [];

vi.mock('../src/services/card-prefs-store.js', () => ({
  getBotCardPrefs: (appId: string) => ({ overloadAlert: legacyOverloadAlert.get(appId) === true }),
  updateBotCardPrefs: vi.fn(async (appId: string, patch: Record<string, unknown>) => {
    clearedPrefs.push({ appId, patch });
    if ('overloadAlert' in patch) legacyOverloadAlert.set(appId, patch.overloadAlert === true);
  }),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { migrateOverloadAlertAtStartup } from '../src/services/overload-alert-migration.js';
import {
  globalConfigPath,
  invalidateGlobalConfigCache,
  readGlobalConfig,
  writeHostOverloadAlertConfig,
} from '../src/global-config.js';
import { logger } from '../src/utils/logger.js';

describe('migrateOverloadAlertAtStartup', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-overload-migrate-'));
    vi.stubEnv('HOME', home);
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
    legacyOverloadAlert.clear();
    clearedPrefs.length = 0;
    invalidateGlobalConfigCache();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.info).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  // Convenience: build the {larkAppId, apiOnly?}[] the migration now takes.
  const bots = (...ids: string[]) => ids.map(larkAppId => ({ larkAppId }));

  it('no legacy toggle on → leaves the global config unset (feature stays off)', async () => {
    await migrateOverloadAlertAtStartup(bots('cli_a', 'cli_b'));
    invalidateGlobalConfigCache();
    expect(readGlobalConfig().hostOverloadAlert).toBeUndefined();
    expect(clearedPrefs).toEqual([]);
  });

  it('exactly one legacy bot on → becomes the enabled notifier target and its pref is cleared', async () => {
    legacyOverloadAlert.set('cli_b', true);
    await migrateOverloadAlertAtStartup(bots('cli_a', 'cli_b', 'cli_c'));
    invalidateGlobalConfigCache();
    expect(readGlobalConfig().hostOverloadAlert).toEqual({ enabled: true, targetBotAppId: 'cli_b' });
    expect(clearedPrefs).toEqual([{ appId: 'cli_b', patch: { overloadAlert: false } }]);
  });

  it('multiple legacy bots on → picks the FIRST by sorted appId, clears all, warns about the losers', async () => {
    legacyOverloadAlert.set('cli_z', true);
    legacyOverloadAlert.set('cli_a', true);
    legacyOverloadAlert.set('cli_m', true);
    await migrateOverloadAlertAtStartup(bots('cli_z', 'cli_a', 'cli_m'));
    invalidateGlobalConfigCache();
    // Sorted → cli_a wins deterministically regardless of input order.
    expect(readGlobalConfig().hostOverloadAlert).toEqual({ enabled: true, targetBotAppId: 'cli_a' });
    // All three legacy keys are cleared.
    expect(clearedPrefs.map(c => c.appId).sort()).toEqual(['cli_a', 'cli_m', 'cli_z']);
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    const warned = vi.mocked(logger.warn).mock.calls.map(c => String(c[0])).join('\n');
    expect(warned).toContain('cli_a');
  });

  it('EXCLUDES apiOnly bots as candidates (an apiOnly bot can never DM)', async () => {
    // cli_a is apiOnly + legacy-on; by sort order it would win, but it has no
    // Feishu transport → skip it and migrate the next eligible bot instead.
    legacyOverloadAlert.set('cli_a', true);
    legacyOverloadAlert.set('cli_b', true);
    await migrateOverloadAlertAtStartup([
      { larkAppId: 'cli_a', apiOnly: true },
      { larkAppId: 'cli_b', apiOnly: false },
    ]);
    invalidateGlobalConfigCache();
    expect(readGlobalConfig().hostOverloadAlert).toEqual({ enabled: true, targetBotAppId: 'cli_b' });
    // Only the eligible bot's pref is cleared; the apiOnly one is left untouched.
    expect(clearedPrefs).toEqual([{ appId: 'cli_b', patch: { overloadAlert: false } }]);
  });

  it('leaves the feature off when the ONLY legacy-on bot is apiOnly (no eligible target)', async () => {
    legacyOverloadAlert.set('cli_a', true);
    await migrateOverloadAlertAtStartup([{ larkAppId: 'cli_a', apiOnly: true }]);
    invalidateGlobalConfigCache();
    expect(readGlobalConfig().hostOverloadAlert).toBeUndefined();
    expect(clearedPrefs).toEqual([]);
  });

  it('idempotent: a second run after migration is a no-op (does not re-clear or overwrite)', async () => {
    legacyOverloadAlert.set('cli_b', true);
    await migrateOverloadAlertAtStartup(bots('cli_a', 'cli_b'));
    invalidateGlobalConfigCache();
    const first = readGlobalConfig().hostOverloadAlert;
    clearedPrefs.length = 0;

    await migrateOverloadAlertAtStartup(bots('cli_a', 'cli_b'));
    invalidateGlobalConfigCache();
    expect(readGlobalConfig().hostOverloadAlert).toEqual(first);
    // Fast-path skip: no further pref clears on the second run.
    expect(clearedPrefs).toEqual([]);
  });

  it('lock-inner re-check sees a concurrent write through the stale TTL cache (no duplicate write / clobber)', async () => {
    // The race codex flagged: this daemon primes the 2s read cache with a
    // pre-write "absent" snapshot, THEN another PROCESS saves a user selection
    // straight to config.json (which cannot invalidate our in-process cache).
    // The migration must invalidate the cache INSIDE the lock, see the fresh
    // disk value, and bail — not overwrite the user's choice.
    legacyOverloadAlert.set('cli_b', true);
    readGlobalConfig(); // prime the TTL cache: hostOverloadAlert === undefined
    // Cross-process write: bypass global-config's writers so our cache stays stale.
    writeFileSync(globalConfigPath(), JSON.stringify({
      hostOverloadAlert: { enabled: true, targetBotAppId: 'cli_user_pick' },
    }));
    // Sanity: without invalidation the cache still reports absent (proves the
    // fast-path read alone would wrongly proceed to migrate).
    expect(readGlobalConfig().hostOverloadAlert).toBeUndefined();

    await migrateOverloadAlertAtStartup(bots('cli_a', 'cli_b'));
    invalidateGlobalConfigCache();
    // Lock-inner invalidate → fresh read → user's choice preserved, not clobbered.
    expect(readGlobalConfig().hostOverloadAlert).toEqual({ enabled: true, targetBotAppId: 'cli_user_pick' });
    expect(clearedPrefs).toEqual([]); // migration bailed → nothing cleared
  });

  it('does not run when hostOverloadAlert is already present (even if a legacy toggle lingers)', async () => {
    writeHostOverloadAlertConfig({ enabled: false });
    invalidateGlobalConfigCache();
    legacyOverloadAlert.set('cli_b', true);

    await migrateOverloadAlertAtStartup(bots('cli_a', 'cli_b'));
    invalidateGlobalConfigCache();
    // Global untouched; the pre-existing (disabled) config wins over the legacy toggle.
    expect(readGlobalConfig().hostOverloadAlert).toEqual({ enabled: false });
    expect(clearedPrefs).toEqual([]);
  });

  it('never throws (best-effort): a failing pref clear does not brick startup', async () => {
    legacyOverloadAlert.set('cli_b', true);
    const store = await import('../src/services/card-prefs-store.js');
    vi.mocked(store.updateBotCardPrefs).mockRejectedValueOnce(new Error('disk full'));

    await expect(migrateOverloadAlertAtStartup(bots('cli_b'))).resolves.toBeUndefined();
    invalidateGlobalConfigCache();
    // The global write (which happens FIRST) still landed.
    expect(readGlobalConfig().hostOverloadAlert).toEqual({ enabled: true, targetBotAppId: 'cli_b' });
  });
});
