import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../src/config.js';
import { globalConfigPath, invalidateGlobalConfigCache, mergeDashboardConfig, readGlobalConfig } from '../src/global-config.js';

describe('automatic Codex session upgrades (experimental, default OFF)', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'botmux-codex-session-upgrade-'));
    vi.stubEnv('HOME', configDir);
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(configDir, { recursive: true, force: true });
  });

  it('leaves upgrades disabled when no configuration has been saved', () => {
    expect(config.autoUpgradeCodexSessions).toBe(false);
  });

  it('reads saved disable and re-enable changes without reloading the runtime configuration', () => {
    mergeDashboardConfig({ autoUpgradeCodexSessions: true, codexRpcInput: true });
    expect(config.autoUpgradeCodexSessions).toBe(true);
    expect(readGlobalConfig().dashboard?.autoUpgradeCodexSessions).toBe(true);

    mergeDashboardConfig({ autoUpgradeCodexSessions: false });
    expect(config.autoUpgradeCodexSessions).toBe(false);
    expect(readGlobalConfig().dashboard?.codexRpcInput).toBe(true);
  });

  it.each([{}, { autoUpgradeCodexSessions: 'true' }])('defaults OFF for an absent or invalid saved value: %j', (dashboard) => {
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard }));
    expect(config.autoUpgradeCodexSessions).toBe(false);
    expect(readGlobalConfig().dashboard?.autoUpgradeCodexSessions).toBeUndefined();
  });
});
