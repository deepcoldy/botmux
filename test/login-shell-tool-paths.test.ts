import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLoginShellPathShim } from '../src/core/cli-identity.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(coreOnly = false) {
  const home = mkdtempSync(join(tmpdir(), 'botmux-login-tools-'));
  roots.push(home);
  const identityBin = join(home, 'identity');
  const dataDir = join(home, 'core data');
  const botmuxBin = coreOnly ? join(dataDir, 'bin') : join(home, '.botmux', 'bin');
  const machineBin = join(home, 'machine');
  for (const dir of [identityBin, botmuxBin, machineBin]) mkdirSync(dir, { recursive: true });
  function tool(dir: string, name: string, output: string) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
    chmodSync(path, 0o755);
  }
  tool(identityBin, 'lark-cli', 'session-identity');
  tool(botmuxBin, 'lark-cli', 'wrong-install-identity');
  tool(botmuxBin, 'botmux', 'owning-botmux');
  tool(machineBin, 'botmux', 'wrong-machine-botmux');
  const launchEnv = { HOME: home, ...(coreOnly ? { BOTMUX_CORE_ONLY: '1', SESSION_DATA_DIR: dataDir } : {}) };
  const { zdotdir, bashEnv } = installLoginShellPathShim(identityBin);
  // Login startup may discard the inherited PATH altogether. Keep BASH_ENV,
  // as required for bash to execute the session's generated startup file.
  const resetPath = `export PATH='${machineBin}:/usr/bin:/bin'\n`;
  writeFileSync(join(home, '.bash_profile'), resetPath);
  writeFileSync(join(home, '.zprofile'), resetPath);
  const env = {
    ...launchEnv, BOTMUX_WRAPPER_BIN: botmuxBin, PATH: `${identityBin}:${botmuxBin}:/usr/bin:/bin`,
    BOTMUX_IDENTITY_BIN: identityBin, ZDOTDIR: zdotdir, BASH_ENV: bashEnv,
  };
  return { home, identityBin, dataDir, botmuxBin, bashEnv, env, tool };
}

const shells = ['bash', 'zsh'].filter(shell => spawnSync(shell, ['--version']).status === 0);

describe('login shell command paths', () => {
  it.each(shells)('restores botmux and retains session identity after %s login resets PATH', shell => {
    const f = fixture();
    const result = spawnSync(shell, ['-lc', 'botmux; lark-cli'], { env: f.env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['owning-botmux', 'session-identity']);
  });

  it('uses the dedicated core-only installation instead of the same-HOME fleet', () => {
    const f = fixture(true);
    const sharedBin = join(f.home, '.botmux', 'bin');
    mkdirSync(sharedBin, { recursive: true });
    f.tool(sharedBin, 'botmux', 'wrong-shared-fleet');
    const result = spawnSync('bash', ['-lc', 'botmux; lark-cli'], { env: f.env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['owning-botmux', 'session-identity']);
  });

  it('is idempotent when the same shell sources its startup file repeatedly', () => {
    const f = fixture();
    const result = spawnSync('bash', ['-lc', '. "$BASH_ENV"; . "$BASH_ENV"; printf "%s" "$PATH"'], {
      env: f.env, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const paths = result.stdout.split(':');
    expect(paths[0]).toBe(f.identityBin);
    expect(paths.filter(path => path === f.identityBin)).toHaveLength(1);
    expect(paths.filter(path => path === f.botmuxBin)).toHaveLength(1);
  });

  it('does not restore another session when the identity locator is absent', () => {
    const f = fixture();
    const env: NodeJS.ProcessEnv = { ...f.env };
    delete env.BOTMUX_IDENTITY_BIN;
    delete env.BOTMUX_WRAPPER_BIN;
    const result = spawnSync('bash', ['-lc', 'botmux'], { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('wrong-machine-botmux');
  });

  const bwrapBin = (process.env.PATH ?? '').split(':').map(dir => join(dir, 'bwrap')).find(existsSync);
  const bwrapAvailable = process.platform === 'linux' && !!bwrapBin && spawnSync(bwrapBin, [
    '--unshare-user', '--die-with-parent', '--ro-bind', '/', '/', '--', '/bin/true',
  ]).status === 0;

  it.skipIf(!bwrapAvailable).each(['available', 'hidden', 'unset', 'unbound'] as const)(
    'restores the sandbox relay after bash login with the host wrapper %s', host => {
        const f = fixture();
        const relayBin = join(f.home, 'relay');
        mkdirSync(relayBin);
        f.tool(relayBin, 'botmux', 'sandbox-relay');
        const env: NodeJS.ProcessEnv = { ...f.env };
        if (host === 'unset') delete env.BOTMUX_WRAPPER_BIN;
        if (host === 'unbound') env.BOTMUX_WRAPPER_BIN = '/host-only/unbound/botmux/bin';
        const result = spawnSync(bwrapBin!, [
          '--unshare-user', '--die-with-parent', '--ro-bind', '/', '/',
          '--tmpfs', '/run', '--ro-bind', relayBin, '/run/sbxbin',
          ...(host === 'hidden' ? ['--tmpfs', f.botmuxBin] : []),
          '--', '/bin/bash', '-lc', 'botmux; lark-cli',
        ], { env, encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim().split('\n')).toEqual(['sandbox-relay', 'session-identity']);
    },
  );
});
