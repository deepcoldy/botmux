import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The host children the DASHBOARD forks: `botmux start-bot/stop-bot` (bring an
 * onboarded bot online without a fleet restart) and the global npm/pnpm/bun
 * install behind the update button.
 *
 * P1-9: all three used to run with a raw `process.env`. The dashboard process
 * is the machine's one legitimate holder of the Feishu H5 login family
 * (BOTMUX_DASHBOARD_FEISHU_H5_*, APP_SECRET included — it can mint
 * app_access_token for the Dashboard's login app), and it historically loaded
 * ~/.botmux/.env wholesale, so those children inherited every operator secret
 * in that file. Worse, `start-bot` re-enters the botmux CLI → pm2, which
 * PERSISTS the caller env into the managed app and into dump.pm2; and a global
 * install runs arbitrary package lifecycle scripts with whatever it is handed.
 *
 * These assert the env object each child actually receives.
 */
const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: childProcess.spawn }));

function fakeChild(exit: { code?: number; stdout?: string } = {}) {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setImmediate(() => {
    if (exit.stdout) child.stdout.emit('data', Buffer.from(exit.stdout));
    child.emit('exit', exit.code ?? 0);
  });
  return child;
}

const SECRETS = {
  BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET: 'h5-app-secret',
  BOTMUX_DASHBOARD_FEISHU_H5_APP_ID: 'cli_h5app',
  LARK_APP_SECRET: 'legacy-bot-secret',
  LARK_APP_ID: 'cli_legacy',
  GITHUB_TOKEN: 'ghp_leaked',
  GH_TOKEN: 'gho_leaked',
};

function spawnedEnv(callIndex = 0): NodeJS.ProcessEnv {
  const opts = childProcess.spawn.mock.calls[callIndex]?.[2] as { env: NodeJS.ProcessEnv };
  return opts.env;
}

function expectNoSecrets(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(SECRETS)) {
    expect(key in env, `${key} must not reach the child`).toBe(false);
  }
  expect(Object.values(env)).not.toContain('h5-app-secret');
  expect(Object.values(env)).not.toContain('legacy-bot-secret');
}

describe('dashboard host children run on a redacted env', () => {
  beforeEach(() => {
    childProcess.spawn.mockReset();
    childProcess.spawn.mockImplementation(() => fakeChild());
    for (const [k, v] of Object.entries(SECRETS)) vi.stubEnv(k, v);
    vi.stubEnv('BOTMUX_DASHBOARD_PORT', '7891');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('start-bot gets no dashboard/bot credentials (they would land in pm2 metadata + dump.pm2)', async () => {
    const { spawnStartBotLive } = await import('../src/dashboard/managed-spawn.js');
    const result = await spawnStartBotLive('cli_target');

    expect(childProcess.spawn).toHaveBeenCalledOnce();
    const [, args] = childProcess.spawn.mock.calls[0] as [string, string[], unknown];
    expect(args.slice(1)).toEqual(['start-bot', 'cli_target', '--json']);
    expectNoSecrets(spawnedEnv());
    // Ordinary settings and the process environment still ride along — the new
    // daemon is a normal botmux process.
    expect(spawnedEnv().BOTMUX_DASHBOARD_PORT).toBe('7891');
    expect(spawnedEnv().PATH).toBe(process.env.PATH);
    expect(result.ok).toBe(true);
  });

  it('stop-bot gets the same treatment', async () => {
    const { spawnStopBotLive } = await import('../src/dashboard/managed-spawn.js');
    await spawnStopBotLive('cli_target');

    const [, args] = childProcess.spawn.mock.calls[0] as [string, string[], unknown];
    expect(args.slice(1)).toEqual(['stop-bot', 'cli_target', '--json']);
    expectNoSecrets(spawnedEnv());
  });

  it('the global install (and every npm lifecycle script it runs) sees no secrets', async () => {
    const { runGlobalInstall } = await import('../src/dashboard/managed-spawn.js');
    await runGlobalInstall({
      manager: 'npm',
      command: 'npm',
      args: ['install', '-g', 'botmux@latest'],
      env: { npm_config_registry: 'https://registry.example.com' },
    } as any);

    const env = spawnedEnv();
    expectNoSecrets(env);
    // The plan's own env still wins — it carries the registry/ownership knobs.
    expect(env.npm_config_registry).toBe('https://registry.example.com');
  });

  it('reports the child result unchanged (redaction is not a behavior change)', async () => {
    childProcess.spawn.mockImplementation(() => fakeChild({ code: 0, stdout: '{"processName":"botmux-3"}' }));
    const { spawnStartBotLive } = await import('../src/dashboard/managed-spawn.js');
    expect(await spawnStartBotLive('cli_target')).toEqual({ ok: true, message: 'botmux-3 已上线' });

    childProcess.spawn.mockImplementation(() => fakeChild({ code: 1, stdout: '{"message":"启动失败"}' }));
    expect(await spawnStartBotLive('cli_target')).toEqual({ ok: false, message: '启动失败' });
  });

  it('dashboard.ts forks nothing on its own — every host child comes from this module', async () => {
    // Structural companion to the behavior above: a new `spawn(...)` inlined in
    // dashboard.ts would bypass the redaction this module centralizes.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/from\s+['"]node:child_process['"]/);
    expect(src).toContain("from './dashboard/managed-spawn.js'");
  });
});
