import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const childProcess = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: childProcess.spawnSync,
}));

describe('plugin PM2 environment', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-plugin-pm2-env-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('kill_timeout', '3500');
    vi.resetModules();
    childProcess.spawnSync.mockReset();
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('does not leak the Botmux host kill_timeout into plugin PM2 commands', async () => {
    const { runPluginPm2 } = await import('../src/core/plugins/pm2.js');

    runPluginPm2(['start', 'fixture'], {
      inherit: false,
      env: { PLUGIN_VALUE: 'preserved' },
    });

    expect(childProcess.spawnSync).toHaveBeenCalledOnce();
    const options = childProcess.spawnSync.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env.kill_timeout).toBeUndefined();
    expect(options.env.PLUGIN_VALUE).toBe('preserved');
    expect(options.env.PM2_HOME).toBe(join(home, '.botmux', 'pm2'));
  });

  it('does not leak the daemon PM2 graceful-exit sentinel into plugin PM2 apps', async () => {
    // The sentinel (BOTMUX_PM2_GRACEFUL_EXIT_CODE) is baked into the
    // daemon/dashboard env. Dashboard starts plugin services via `pm2 start
    // --update-env`, so pm2Env's raw process.env copy would otherwise write 90
    // into the plugin app's env — and a plugin service that later launches a
    // foreground botmux would exit 90 on a clean stop. pm2Env must strip it.
    const { PM2_GRACEFUL_EXIT_CODE_ENV } = await import('../src/pm2-graceful-exit.js');
    vi.stubEnv(PM2_GRACEFUL_EXIT_CODE_ENV, '90');
    vi.resetModules();
    const { runPluginPm2 } = await import('../src/core/plugins/pm2.js');

    runPluginPm2(['start', 'fixture'], { inherit: false });

    const options = childProcess.spawnSync.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env[PM2_GRACEFUL_EXIT_CODE_ENV]).toBeUndefined();
  });
});
