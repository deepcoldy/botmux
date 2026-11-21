/**
 * The systemd fence (test/helpers/systemd-fence.ts, mounted by the runners'
 * setup) must stop every route a test could take to the host's systemd, and
 * nothing else. Refused calls use `--version` and other read-only arguments:
 * should the fence ever let one through, it must not touch the host.
 */
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { probeSystemdPidNamespace, stopSessionScope, wrapCommandInSessionScope } from '../src/core/session-scope.js';
import { takeSystemdFenceViolations } from './helpers/systemd-fence.js';

const ROOT = resolve(__dirname, '..');
const realBinary = (name: string) => ['/usr/bin', '/bin'].map(dir => join(dir, name)).find(existsSync);
const bun = (globalThis as { Bun?: { spawnSync: (...args: any[]) => any; spawn: (...args: any[]) => any } }).Bun;

describe.skipIf(process.platform === 'win32')('systemd test fence', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Runs `attempt`, expects the fence to throw, and takes the record it left. */
  function refused(attempt: () => unknown): string[] {
    expect(attempt).toThrow(/systemd test fence refused/);
    const recorded = takeSystemdFenceViolations();
    expect(recorded).toHaveLength(1);
    return recorded;
  }

  function scratch(): string {
    dir ??= mkdtempSync(join(tmpdir(), 'botmux-systemd-fence-'));
    return dir;
  }

  it('stops production scope code that was not given a fake', () => {
    refused(() => probeSystemdPidNamespace({
      platform: 'linux', readlink: () => 'pid:[4026532999]', readFile: () => 'NSpid:\t4\n',
    }));
    refused(() => stopSessionScope('fence-check', {
      platform: 'linux', pidNamespace: { shared: true, basis: 'initial-namespace', namespace: 'pid:[4026531836]' },
    }));
  });

  it('stops the pane command a scoped launch builds', () => {
    // A namespace no pane is in: were the call let through, the pane would
    // run `true` without systemd-run.
    const wrapped = wrapCommandInSessionScope('fence-check', 'true', [], undefined,
      { cleanupSupported: true, memoryControllerSupported: false }, {}, undefined,
      { shared: true, basis: 'initial-namespace', namespace: 'pid:[1]' });
    refused(() => spawnSync(wrapped.bin, wrapped.args));
  });

  it.each([
    ['spawnSync', () => spawnSync('busctl', ['--version'])],
    ['execFileSync', () => execFileSync('systemctl', ['--user', '--version'])],
    ['execSync', () => execSync('systemd-run --version')],
    ['exec', () => exec('systemctl --user --version')],
    ['spawn', () => spawn('systemd-run', ['--version'])],
    ['execFile', () => execFile('busctl', ['--version'])],
    ['promisified execFile', () => promisify(execFile)('busctl', ['--version'])],
    ['require', () => createRequire(import.meta.url)('node:child_process').spawnSync('busctl', ['--version'])],
    ['shell option', () => spawnSync('busctl --version', { shell: true })],
    ['env', () => spawnSync('/usr/bin/env', ['XDG_RUNTIME_DIR=/run/user/0', 'systemd-run', '--version'])],
    ['env -S', () => spawnSync('env', ['-S', 'A=1 systemctl --user --version'])],
    ['timeout', () => spawnSync('timeout', ['-k', '1', '5', 'systemd-run', '--version'])],
    ['nice', () => spawnSync('nice', ['-n', '5', 'busctl', '--version'])],
    ['setsid', () => spawnSync('setsid', ['-f', 'systemd-run', '--version'])],
    ['nohup', () => spawnSync('nohup', ['busctl', '--version'])],
    ['stdbuf', () => spawnSync('stdbuf', ['-o', 'L', 'systemctl', '--user', '--version'])],
    ['ionice', () => spawnSync('ionice', ['-c', '3', 'systemd-run', '--version'])],
    ['nested wrappers', () => spawnSync('env', ['A=1', 'timeout', '5', 'nice', 'sh', '-c', 'busctl --version'])],
    ['sh -c script', () => spawnSync('sh', ['-c', 'set -e; systemctl --user "$1"', 'sh', '--version'])],
    ['sh -c positional', () => spawnSync('/bin/sh', ['-c', '"$@"; status=$?; exit "$status"', 'botmux-session-scope', 'systemd-run', '--version'])],
    ['sh -c exec', () => spawnSync('bash', ['-lc', 'cd / && exec busctl --version'])],
    ['command substitution', () => execSync('echo "$(systemctl --user --version)"')],
  ])('refuses %s', (_label, attempt) => {
    refused(attempt);
  });

  it('refuses a shell script file that calls systemd', () => {
    writeFileSync(join(scratch(), 'probe.sh'), '#!/bin/sh\nif true; then\n  timeout 5 systemd-run --version >/dev/null 2>&1\nfi\n');
    refused(() => spawnSync('sh', ['probe.sh'], { cwd: scratch() }));
  });

  it.runIf(!!bun)('refuses Bun.spawnSync and Bun.spawn, and gives their children the shims', () => {
    refused(() => bun!.spawnSync(['busctl', '--version']));
    refused(() => bun!.spawn({ cmd: ['systemd-run', '--version'] }));
    // Without `env` Bun would hand the child the environment it started with.
    const child = bun!.spawnSync(['sh', '-c', 'command -v busctl']);
    expect(String(child.stdout).trim()).toMatch(/systemd-fence-bin\/busctl$/);
  });

  it.runIf(!!realBinary('systemd-run'))('refuses the real binary by absolute path or through a PATH without the shims', () => {
    refused(() => spawnSync(realBinary('systemd-run')!, ['--version']));
    refused(() => spawnSync('systemd-run', ['--version'], { env: { PATH: '/usr/bin:/bin' } }));
  });

  it('lets a fake first on the child\'s PATH run', () => {
    writeFileSync(join(scratch(), 'systemd-run'), '#!/bin/sh\necho fake "$@"\n', { mode: 0o755 });
    const child = spawnSync('systemd-run', ['--user', '--scope', 'true'], {
      env: { ...process.env, PATH: `${scratch()}${delimiter}${process.env.PATH ?? ''}` }, encoding: 'utf8',
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('fake --user --scope true\n');
    expect(takeSystemdFenceViolations()).toEqual([]);
  });

  it('lets scripts merely mention systemd', () => {
    const run = (script: string) => spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    expect(run('echo systemctl --user stop x.scope').stdout).toBe('systemctl --user stop x.scope\n');
    expect(run('printf "%s\\n" busctl | grep -c busctl').stdout).toBe('1\n');
    expect(run('command -v systemd-run >/dev/null || true').status).toBe(0);
    expect(execSync('echo "systemd-run is not called here"', { encoding: 'utf8' })).toBe('systemd-run is not called here\n');
    expect(takeSystemdFenceViolations()).toEqual([]);
  });

  it('refuses child processes too, through the shims first on PATH', () => {
    for (const command of ['systemd-run --version', 'busctl --version', 'systemctl --user --version']) {
      // Through `sh -s` the in-process layer cannot read the script; the shim answers.
      const child = spawnSync('sh', ['-s'], { input: `${command}\n`, encoding: 'utf8' });
      expect(child.status, command).toBe(1);
      expect(child.stderr, command).toContain('botmux test systemd fence: refusing');
    }
    expect(takeSystemdFenceViolations()).toEqual([]);
  });

  it.runIf(!!realBinary('systemctl'))('passes systemctl through when it does not address the user manager', () => {
    const child = spawnSync('systemctl', ['--version'], { encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(takeSystemdFenceViolations()).toEqual([]);
  });

  it('keeps unrelated child_process calls working, promisified ones included', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(stdout).toBe('ok');
    expect(execSync('echo systemd-free', { encoding: 'utf8' })).toBe('systemd-free\n');
    expect(takeSystemdFenceViolations()).toEqual([]);
  });

  it('fails a test that swallowed the refusal', () => {
    const runner = bun
      ? [process.execPath, 'test', './test/fixtures/systemd-fence/swallowed.fixture.ts']
      : [process.execPath, join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'test/fixtures/systemd-fence/vitest.config.ts'];
    const child = spawnSync(runner[0], runner.slice(1), { cwd: ROOT, encoding: 'utf8', timeout: 90_000 });
    expect(child.status, child.stdout + child.stderr).not.toBe(0);
    expect(child.stdout + child.stderr).toContain('systemd test fence refused 1 call(s)');
  }, 120_000);
});
