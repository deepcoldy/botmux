import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const H5_PREFIX = 'BOTMUX_DASHBOARD_FEISHU_H5_';
const FUTURE_H5_KEY = `${H5_PREFIX}FUTURE_SPAWN_TEST`;

const io = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ pid: 4321, unref: vi.fn() })),
  openSync: vi.fn(() => 1),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: io.spawn };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: io.openSync };
});

describe('startFleetViaSupervisor restart environment', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fleet-spawn-env-'));
    mkdirSync(join(home, '.botmux'), { recursive: true });
    writeFileSync(join(home, '.botmux', '.env'), [
      'WEB_HOST=10.9.9.9',
      'WEB_EXTERNAL_PORT=9100',
      'BOTMUX_WEB_PROXY_BASE_PORT=8900',
      'BOTMUX_WORKER_HTTP_HOST=127.0.0.2',
      'BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET=file-secret',
      `${FUTURE_H5_KEY}=file-future-secret`,
      '',
    ].join('\n'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('BOTMUX_SESSION_ID', 'session-1');
    vi.stubEnv('WEB_HOST', '127.0.0.1');
    vi.stubEnv('WEB_EXTERNAL_PORT', '9000');
    vi.stubEnv('BOTMUX_WEB_PROXY_BASE_PORT', '8800');
    vi.stubEnv('BOTMUX_WORKER_HTTP_HOST', '127.0.0.3');
    vi.stubEnv('BOTMUX_WORKER_HOST', '::');
    io.spawn.mockClear();
    io.openSync.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('passes persisted terminal endpoint settings to the supervisor instead of stale session snapshots', async () => {
    const { startFleetViaSupervisor } = await import('../src/core/fleet-runtime.js');

    expect(startFleetViaSupervisor()).toMatchObject({ action: 'started', supervisorPid: 4321 });
    expect(io.spawn).toHaveBeenCalledOnce();
    const options = io.spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env.WEB_HOST).toBe('10.9.9.9');
    expect(options.env.WEB_EXTERNAL_PORT).toBe('9100');
    expect(options.env.BOTMUX_WEB_PROXY_BASE_PORT).toBe('8900');
    expect(options.env.BOTMUX_WORKER_HTTP_HOST).toBe('127.0.0.2');
    expect(options.env.BOTMUX_WORKER_HOST).toBe('');
  });

  it('does not carry the one-shot refresh marker into the supervisor', async () => {
    vi.stubEnv('BOTMUX_INTERNAL_REFRESH_DAEMON_ENV', '1');
    vi.stubEnv('BOTMUX_INTERNAL_RESTART_ENV_FALLBACK', JSON.stringify({
      version: 1,
      env: { WEB_HOST: '127.0.0.1' },
    }));
    const { startFleetViaSupervisor } = await import('../src/core/fleet-runtime.js');

    expect(startFleetViaSupervisor({ refreshPersistedEnv: true })).toMatchObject({
      action: 'started',
      supervisorPid: 4321,
    });
    const options = io.spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env.BOTMUX_INTERNAL_REFRESH_DAEMON_ENV).toBeUndefined();
    expect(options.env.BOTMUX_INTERNAL_RESTART_ENV_FALLBACK).toBeUndefined();
  });

  it('does not load persisted H5 settings into the supervisor spawn environment', async () => {
    const { startFleetViaSupervisor } = await import('../src/core/fleet-runtime.js');

    expect(startFleetViaSupervisor({ refreshPersistedEnv: true })).toMatchObject({
      action: 'started',
      supervisorPid: 4321,
    });
    const options = io.spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env.BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET).toBeUndefined();
    expect(options.env[FUTURE_H5_KEY]).toBeUndefined();
  });

  it('strips inherited named and future H5 settings before spawning the supervisor', async () => {
    vi.stubEnv('BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET', 'inherited-secret');
    vi.stubEnv(FUTURE_H5_KEY, 'inherited-future-secret');
    const { startFleetViaSupervisor } = await import('../src/core/fleet-runtime.js');

    expect(startFleetViaSupervisor()).toMatchObject({ action: 'started', supervisorPid: 4321 });
    const options = io.spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(Object.keys(options.env).filter(key => key.startsWith(H5_PREFIX))).toEqual([]);
  });

  it('clears inherited lifecycle settings when the persisted .env is absent', async () => {
    rmSync(join(home, '.botmux', '.env'));
    delete process.env.BOTMUX_SESSION_ID;
    const { startFleetViaSupervisor } = await import('../src/core/fleet-runtime.js');

    expect(startFleetViaSupervisor({ refreshPersistedEnv: true })).toMatchObject({ action: 'started', supervisorPid: 4321 });
    expect(io.spawn).toHaveBeenCalledOnce();
    const options = io.spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env.WEB_HOST).toBe('0.0.0.0');
    expect(options.env.WEB_EXTERNAL_PORT).toBe('');
    expect(options.env.BOTMUX_WEB_PROXY_BASE_PORT).toBe('');
    expect(options.env.BOTMUX_WORKER_HTTP_HOST).toBe('0.0.0.0');
    expect(options.env.BOTMUX_WORKER_HOST).toBe('');
  });

  it('uses the explicit fallback snapshot when the persisted .env cannot be read', async () => {
    const envPath = join(home, '.botmux', '.env');
    rmSync(envPath);
    mkdirSync(envPath); // deterministic EISDIR from readFileSync on Linux
    delete process.env.BOTMUX_SESSION_ID;
    const { startFleetViaSupervisor } = await import('../src/core/fleet-runtime.js');

    expect(startFleetViaSupervisor({
      refreshPersistedEnv: true,
      readFailureFallback: {
        WEB_HOST: '127.0.0.1',
        WEB_EXTERNAL_PORT: '9000',
        BOTMUX_WEB_PROXY_BASE_PORT: '8800',
        BOTMUX_WORKER_HTTP_HOST: '127.0.0.3',
      },
    })).toMatchObject({ action: 'started', supervisorPid: 4321 });
    expect(io.spawn).toHaveBeenCalledOnce();
    const options = io.spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env.WEB_HOST).toBe('127.0.0.1');
    expect(options.env.WEB_EXTERNAL_PORT).toBe('9000');
    expect(options.env.BOTMUX_WEB_PROXY_BASE_PORT).toBe('8800');
    expect(options.env.BOTMUX_WORKER_HTTP_HOST).toBe('127.0.0.3');
    expect(options.env.BOTMUX_WORKER_HOST).toBe('');
    expect(options.env.BOTMUX_INTERNAL_RESTART_ENV_FALLBACK).toBeUndefined();
  });
});
