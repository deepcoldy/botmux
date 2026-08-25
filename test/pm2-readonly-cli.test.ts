import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { captureReadonlyPm2Jlist } from '../src/cli/pm2-readonly.js';
import { inspectLinuxPm2GodOwnership } from '../src/core/pm2-lifecycle-owner.js';

const CLI_PATH = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const PM2_PATH = fileURLToPath(new URL('../node_modules/pm2/bin/pm2', import.meta.url));
const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'botmux-pm2-readonly-'));
  homes.push(home);
  return home;
}

function runCli(home: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], {
    cwd: dirname(dirname(CLI_PATH)),
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, HOME: home },
  });
}

describe.runIf(process.platform === 'linux')('PM2 read-only CLI lifecycle boundary', () => {
  afterEach(() => {
    for (const home of homes.splice(0)) {
      const pm2Home = join(home, '.botmux', 'pm2');
      spawnSync(process.execPath, [PM2_PATH, 'kill'], {
        env: { ...process.env, PM2_HOME: pm2Home },
        stdio: 'ignore',
        timeout: 10_000,
      });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports absence without creating a PM2 God daemon', () => {
    const home = tempHome();
    const result = runCli(home, 'status');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('daemon 未在运行');
    expect(existsSync(join(home, '.botmux', 'pm2', 'pm2.pid'))).toBe(false);
  });

  it('refuses to query a God daemon inherited from the caller cgroup', () => {
    const home = tempHome();
    const pm2Home = join(home, '.botmux', 'pm2');
    mkdirSync(pm2Home, { recursive: true });
    const boot = spawnSync(process.execPath, [PM2_PATH, 'status'], {
      env: { ...process.env, PM2_HOME: pm2Home },
      stdio: 'ignore',
      timeout: 10_000,
    });
    expect(boot.status).toBe(0);

    for (const command of ['status', 'logs']) {
      const result = runCli(home, command);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('❌ 检测到 PM2 God Daemon 归属于其它 supervisor');
      expect(result.stderr).toContain('迁移建议：');
      expect(result.stderr).toContain('botmux restart');
      expect(result.stderr).not.toMatch(/\n\s+at /);
    }
  });

  it('queries an existing God through direct RPC without rotating its generation', () => {
    const home = tempHome();
    const pm2Home = join(home, '.botmux', 'pm2');
    mkdirSync(pm2Home, { recursive: true });
    const boot = spawnSync(process.execPath, [PM2_PATH, 'status'], {
      env: { ...process.env, PM2_HOME: pm2Home },
      stdio: 'ignore',
      timeout: 10_000,
    });
    expect(boot.status).toBe(0);
    const pidFile = join(pm2Home, 'pm2.pid');
    const originalPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);

    expect(JSON.parse(captureReadonlyPm2Jlist({
      pkgRoot: dirname(dirname(CLI_PATH)),
      home: pm2Home,
    }))).toEqual([]);
    expect(Number.parseInt(readFileSync(pidFile, 'utf8'), 10)).toBe(originalPid);
  });

  it('rejects a different God generation after the parent ownership check', () => {
    const home = tempHome();
    const pm2Home = join(home, '.botmux', 'pm2');
    mkdirSync(pm2Home, { recursive: true });
    expect(spawnSync(process.execPath, [PM2_PATH, 'status'], {
      env: { ...process.env, PM2_HOME: pm2Home },
      stdio: 'ignore',
      timeout: 10_000,
    }).status).toBe(0);
    const ownership = inspectLinuxPm2GodOwnership(pm2Home);
    expect(ownership.kind).not.toBe('absent');
    const god = ownership.kind === 'absent' ? undefined : ownership.processes[0];

    expect(() => captureReadonlyPm2Jlist({
      pkgRoot: dirname(dirname(CLI_PATH)),
      home: pm2Home,
      expectedGod: { ...god!, startIdentity: `${god!.startIdentity}-replaced` },
    })).toThrow(/generation changed/);
  });
});
