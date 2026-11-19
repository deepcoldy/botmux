import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../src/config.js';
import { globalConfigPath, invalidateGlobalConfigCache, mergeDashboardConfig, readGlobalConfig } from '../src/global-config.js';

describe('orphan tmux server reaping (experimental, default OFF)', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'botmux-orphan-tmux-reap-'));
    vi.stubEnv('HOME', configDir);
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(configDir, { recursive: true, force: true });
  });

  it('is disabled when no configuration has been saved (automatic kill never runs by default)', () => {
    expect(config.reapOrphanTmuxServers).toBe(false);
  });

  it('reads saved enable/disable changes live without reloading the runtime configuration', () => {
    mergeDashboardConfig({ reapOrphanTmuxServers: true });
    expect(config.reapOrphanTmuxServers).toBe(true);
    expect(readGlobalConfig().dashboard?.reapOrphanTmuxServers).toBe(true);

    mergeDashboardConfig({ reapOrphanTmuxServers: false });
    expect(config.reapOrphanTmuxServers).toBe(false);
  });

  it.each([{}, { reapOrphanTmuxServers: 'true' }])('defaults OFF for an absent or invalid saved value: %j', (dashboard) => {
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard }));
    expect(config.reapOrphanTmuxServers).toBe(false);
    expect(readGlobalConfig().dashboard?.reapOrphanTmuxServers).toBeUndefined();
  });
});
