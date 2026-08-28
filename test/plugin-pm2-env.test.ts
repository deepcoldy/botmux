import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const childProcess = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  ownershipProcesses: [
    { pid: 123, cgroup: '/user.slice/botmux.service', startIdentity: 'fixture-birth' },
  ] as Array<{ pid: number; cgroup: string; startIdentity: string }>,
}));

vi.mock('node:child_process', () => ({
  spawnSync: childProcess.spawnSync,
}));

vi.mock('../src/core/pm2-lifecycle-owner.js', () => ({
  describeExternalPm2Owner: () => '',
  inspectLinuxPm2Command: () => ({
    ownership: {
      kind: 'owned',
      processes: childProcess.ownershipProcesses,
    },
    plan: { kind: 'direct' },
  }),
}));

describe('plugin PM2 environment', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-plugin-pm2-env-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('kill_timeout', '3500');
    // The test runner itself may run under a PM2-managed daemon, which sets
    // PM2_USAGE/PM2_SILENT in its env. pm2Env spreads process.env, so these
    // would ride into the spawned helper and fail the absence assertions —
    // clear them so the test is environment-independent.
    delete process.env.PM2_USAGE;
    delete process.env.PM2_SILENT;
    vi.resetModules();
    childProcess.spawnSync.mockReset();
    childProcess.ownershipProcesses = [
      { pid: 123, cgroup: '/user.slice/botmux.service', startIdentity: 'fixture-birth' },
    ];
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
    expect(options.env.PM2_SILENT).toBeUndefined();
    expect(options.env.PM2_USAGE).toBeUndefined();
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

  it('refuses a mutation when multiple service-owned Gods share the plugin home', async () => {
    childProcess.ownershipProcesses = [
      { pid: 123, cgroup: '/user.slice/botmux.service', startIdentity: 'birth-a' },
      { pid: 456, cgroup: '/user.slice/botmux.service', startIdentity: 'birth-b' },
    ];
    vi.resetModules();
    const { runPluginPm2 } = await import('../src/core/plugins/pm2.js');

    expect(() => runPluginPm2(['start', 'fixture'], { inherit: false }))
      .toThrow(/exactly one.*123, 456/);
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });
  it('does not leak the Dashboard Feishu H5 login family into plugin PM2 apps', async () => {
    // Plugin services are started/stopped in-process by the DASHBOARD, the one
    // machine-wide holder of BOTMUX_DASHBOARD_FEISHU_H5_* (APP_SECRET can mint
    // app_access_token for the Dashboard's login app). A raw process.env copy
    // hands that credential to an arbitrary third-party plugin service AND
    // persists it in the plugin PM2 home's metadata / dump. No plugin consumes
    // it — the dashboard is the only consumer in the fleet.
    const { DASHBOARD_H5_ENV_KEYS, DASHBOARD_H5_ENV_PREFIX } = await import('../src/utils/child-env.js');
    for (const key of DASHBOARD_H5_ENV_KEYS) vi.stubEnv(key, 'h5-secret');
    vi.stubEnv(`${DASHBOARD_H5_ENV_PREFIX}FUTURE_KNOB`, 'h5-secret');
    vi.resetModules();
    const { runPluginPm2 } = await import('../src/core/plugins/pm2.js');

    runPluginPm2(['start', 'fixture'], { inherit: false, env: { PLUGIN_VALUE: 'preserved' } });

    const options = childProcess.spawnSync.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    for (const key of [...DASHBOARD_H5_ENV_KEYS, `${DASHBOARD_H5_ENV_PREFIX}FUTURE_KNOB`]) {
      expect(key in options.env, key).toBe(false);
    }
    expect(Object.values(options.env)).not.toContain('h5-secret');
    // Plugin-supplied env and the ordinary environment are untouched.
    expect(options.env.PLUGIN_VALUE).toBe('preserved');
    expect(options.env.PATH).toBe(process.env.PATH);
  });

  it('applies the same five scrub families as the core pm2 boundary', async () => {
    // Plugin PM2 shares the God's PM2_HOME, so this entry both persists env
    // into plugin apps and can birth the shared God — a plugin start issued
    // from a bot/workflow session must not carry the session's CLI home,
    // Claude markers, workflow identity, agent-shell fingerprints, or turn
    // identity into either.
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/leak/claude');
    vi.stubEnv('CODEX_HOME', '/leak/codex');
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('BOTMUX_WORKFLOW', 'wf-1');
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('CODEX_CI', '1');
    vi.stubEnv('BOTMUX_SESSION_ID', 'session-leak');
    vi.stubEnv('BOTMUX_OWNER_OPEN_ID', 'ou_leak');
    vi.resetModules();
    const { runPluginPm2 } = await import('../src/core/plugins/pm2.js');

    runPluginPm2(['start', 'fixture'], { inherit: false });

    const options = childProcess.spawnSync.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    for (const key of [
      'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDECODE', 'BOTMUX_WORKFLOW',
      'NO_COLOR', 'CODEX_CI', 'BOTMUX_SESSION_ID', 'BOTMUX_OWNER_OPEN_ID',
    ]) {
      expect(options.env[key], key).toBeUndefined();
    }
    // Deterministic TERM instead of absent (pm2 client color detection).
    expect(options.env.TERM).toBe('xterm-256color');
  });

  it('freezes the scrubs over the manifest env merge — extras cannot revive scrubbed keys', async () => {
    const { PM2_GRACEFUL_EXIT_CODE_ENV } = await import('../src/pm2-graceful-exit.js');
    vi.resetModules();
    const { runPluginPm2 } = await import('../src/core/plugins/pm2.js');

    runPluginPm2(['start', 'fixture'], {
      inherit: false,
      env: {
        BOTMUX_SESSION_ID: 'manifest-forged',
        CLAUDECODE: '1',
        NO_COLOR: '1',
        TERM: 'dumb',
        BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET: 'manifest-forged-secret',
        [PM2_GRACEFUL_EXIT_CODE_ENV]: '90',
        PM2_HOME: '/forged/pm2-home',
        PLUGIN_VALUE: 'preserved',
      },
    });

    const options = childProcess.spawnSync.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env.BOTMUX_SESSION_ID).toBeUndefined();
    expect(options.env.CLAUDECODE).toBeUndefined();
    expect(options.env.NO_COLOR).toBeUndefined();
    expect(options.env[PM2_GRACEFUL_EXIT_CODE_ENV]).toBeUndefined();
    expect(options.env.BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET).toBeUndefined();
    expect(options.env.TERM).toBe('xterm-256color');
    expect(options.env.PM2_HOME).toBe(join(home, '.botmux', 'pm2'));
    expect(options.env.PLUGIN_VALUE).toBe('preserved');
  });
});
