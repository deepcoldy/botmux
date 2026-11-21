import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../src/config.js';
import { globalConfigPath, invalidateGlobalConfigCache, mergeDashboardConfig, readGlobalConfig } from '../src/global-config.js';
import { applySettingsWrite, type SettingsWriteApplierDeps } from '../src/dashboard/settings-write-applier.js';

/**
 * Global switch "let the turn initiator press safe keys on stuck cards":
 * default ON (absent ⇒ on), only a stored `false` disables it, and saving the
 * default from the Dashboard removes the key instead of pinning `true`.
 */
describe('stuckCardInitiatorKeys (default-ON global toggle)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-stuck-initiator-'));
    vi.stubEnv('HOME', home);
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(home, { recursive: true, force: true });
  });

  const onDisk = () => JSON.parse(readFileSync(globalConfigPath(), 'utf8')) as { dashboard?: Record<string, unknown> };

  /** The real config writers; everything else the applier may touch is inert. */
  function realDeps(): SettingsWriteApplierDeps {
    return {
      readGlobalConfig,
      mergeDashboardConfig,
      mergeGlobalConfig: vi.fn(),
      writeCodexNotifierConfig: vi.fn(),
      writeHostOverloadAlertConfig: vi.fn(),
      writeScheduleBotGrantConfig: vi.fn(),
      mergeMaintenanceConfig: vi.fn(() => ({})),
      setGlobalLocale: vi.fn(),
      parseMaintenancePatch: vi.fn(() => ({ ok: false, error: 'unused' }) as const),
      isLocalDevInstall: () => false,
      isAutoUpdateSupportedInstall: () => true,
      resolveDashboardSettings: () => ({}) as any,
      isLocale: (v: unknown): v is 'zh' | 'en' => v === 'zh' || v === 'en',
    };
  }

  it.each([undefined, {}, { stuckCardInitiatorKeys: 'no' }, { stuckCardInitiatorKeys: true }])(
    'is ON for an absent, invalid or true stored value: %j',
    (dashboard) => {
      if (dashboard !== undefined) writeFileSync(globalConfigPath(), JSON.stringify({ dashboard }));
      expect(config.stuckCardInitiatorKeys).toBe(true);
    },
  );

  it('is OFF only for a stored false, read live', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard: { stuckCardInitiatorKeys: false } }));
    expect(config.stuckCardInitiatorKeys).toBe(false);
  });

  it('turning it off persists false; turning it back on removes the key (default is not written)', async () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard: { cardBrandLabel: false } }));

    expect(await applySettingsWrite({ stuckCardInitiatorKeys: false }, realDeps())).toMatchObject({ ok: true });
    expect(onDisk().dashboard).toEqual({ cardBrandLabel: false, stuckCardInitiatorKeys: false });
    expect(config.stuckCardInitiatorKeys).toBe(false);

    expect(await applySettingsWrite({ stuckCardInitiatorKeys: true }, realDeps())).toMatchObject({ ok: true });
    expect(onDisk().dashboard).toEqual({ cardBrandLabel: false });
    expect(config.stuckCardInitiatorKeys).toBe(true);
  });

  it('saving the default on a fresh install writes no key', async () => {
    expect(await applySettingsWrite({ stuckCardInitiatorKeys: true }, realDeps())).toMatchObject({ ok: true });
    expect(onDisk().dashboard ?? {}).not.toHaveProperty('stuckCardInitiatorKeys');
  });

  it('rejects a non-boolean value without writing', async () => {
    const deps = realDeps();
    const merge = vi.fn(mergeDashboardConfig);
    deps.mergeDashboardConfig = merge;
    expect(await applySettingsWrite({ stuckCardInitiatorKeys: 'off' }, deps))
      .toEqual({ ok: false, error: 'invalid_stuckCardInitiatorKeys' });
    expect(merge).not.toHaveBeenCalled();
  });
});
