import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { installAidenCodexShim, renderAidenCodexShim, writeAidenCodexShellConfigs } from '../src/services/aiden-codex-shim.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Aiden Codex reasoning shim', () => {
  it('materializes an executable shim on the real filesystem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-aiden-shim-'));
    dirs.push(dir);
    expect(installAidenCodexShim(dir)).toBe(dir);
    expect(readFileSync(join(dir, 'codex'), 'utf8')).toBe(renderAidenCodexShim());
  });

  it.each(['max', 'ultra'] as const)('passes %s to the real Codex without downgrading', (effort) => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-aiden-shim-'));
    dirs.push(dir);
    const shimDir = installAidenCodexShim(join(dir, 'shim'));
    const realCodex = join(dir, 'real-codex');
    writeFileSync(realCodex, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    chmodSync(realCodex, 0o755);

    const result = spawnSync(join(shimDir, 'codex'), ['--model', 'deepseek-v4-pro'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BOTMUX_AIDEN_CODEX_REAL_BIN: realCodex,
        BOTMUX_AIDEN_CODEX_REASONING_EFFORT: effort,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      '-c',
      `model_reasoning_effort="${effort}"`,
      '--model',
      'deepseek-v4-pro',
    ]);
  });

  it('fails closed when neither effort nor a shell-config file is configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-aiden-shim-'));
    dirs.push(dir);
    const shimDir = installAidenCodexShim(join(dir, 'shim'));
    const realCodex = join(dir, 'real-codex');
    writeFileSync(realCodex, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    chmodSync(realCodex, 0o755);

    const result = spawnSync(join(shimDir, 'codex'), ['x'], {
      encoding: 'utf8',
      env: { ...process.env, BOTMUX_AIDEN_CODEX_REAL_BIN: realCodex },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing launch configuration');
  });
});

describe('Aiden Codex shell-config file', () => {
  interface SetupOptions {
    configs?: string[];
    effort?: string;
    args?: string[];
  }

  function setupShim({ configs, effort, args = [] }: SetupOptions) {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-aiden-shim-cfg-'));
    dirs.push(dir);
    const shimDir = installAidenCodexShim(join(dir, 'shim'));
    const realCodex = join(dir, 'real-codex');
    writeFileSync(realCodex, '#!/bin/sh\ni=0\nfor a in "$@"; do printf "argv[%s]=<%s>\\n" "$i" "$a"; i=$((i+1)); done\n',
      { mode: 0o755 });
    chmodSync(realCodex, 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, BOTMUX_AIDEN_CODEX_REAL_BIN: realCodex };
    if (configs) {
      const cfgFile = join(dir, 'shell-configs');
      writeFileSync(cfgFile, `${configs.join('\n')}\n`);
      env.BOTMUX_AIDEN_CODEX_SHELL_CONFIG_FILE = cfgFile;
    }
    if (effort) env.BOTMUX_AIDEN_CODEX_REASONING_EFFORT = effort;
    return spawnSync(join(shimDir, 'codex'), args, { encoding: 'utf8', env });
  }

  it('prepends every config -c BEFORE the resume subcommand (fresh + resume shape)', () => {
    const result = setupShim({
      configs: [
        'shell_environment_policy.set.SESSION_DATA_DIR="/d/x"',
        'shell_environment_policy.set.ZDOTDIR="/d/x/shell"',
        'shell_environment_policy.set.BASH_ENV="/d/x/bash_env.sh"',
      ],
      args: ['--no-alt-screen', 'resume', 'cid', '-C', '/repo dir'],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'argv[0]=<-c>',
      'argv[1]=<shell_environment_policy.set.BASH_ENV="/d/x/bash_env.sh">',
      'argv[2]=<-c>',
      'argv[3]=<shell_environment_policy.set.ZDOTDIR="/d/x/shell">',
      'argv[4]=<-c>',
      'argv[5]=<shell_environment_policy.set.SESSION_DATA_DIR="/d/x">',
      'argv[6]=<--no-alt-screen>',
      'argv[7]=<resume>',
      'argv[8]=<cid>',
      'argv[9]=<-C>',
      'argv[10]=</repo dir>',
    ]);
  });

  it('keeps shell metacharacters in a value verbatim (no glob/expansion/eval)', () => {
    const nasty = 'shell_environment_policy.set.X="/h/o\'reilly $HOME `x` * [a] \\\\n end"';
    const result = setupShim({ configs: [nasty], args: ['x'] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['argv[0]=<-c>', `argv[1]=<${nasty}>`, 'argv[2]=<x>']);
  });

  it('handles a final line with no trailing newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-aiden-shim-cfg-nl-'));
    dirs.push(dir);
    const shimDir = installAidenCodexShim(join(dir, 'shim'));
    const realCodex = join(dir, 'real-codex');
    writeFileSync(realCodex, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    chmodSync(realCodex, 0o755);
    const cfgFile = join(dir, 'shell-configs');
    writeFileSync(cfgFile, 'shell_environment_policy.set.Y="1"'); // no newline
    const result = spawnSync(join(shimDir, 'codex'), ['x'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BOTMUX_AIDEN_CODEX_REAL_BIN: realCodex,
        BOTMUX_AIDEN_CODEX_SHELL_CONFIG_FILE: cfgFile,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      '-c', 'shell_environment_policy.set.Y="1"', 'x',
    ]);
  });

  it('combines configs with a reasoning level in the same launch', () => {
    const result = setupShim({
      configs: ['shell_environment_policy.set.ZDOTDIR="/d/x"'],
      effort: 'max',
      args: ['--model', 'm'],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'argv[0]=<-c>',
      'argv[1]=<model_reasoning_effort="max">',
      'argv[2]=<-c>',
      'argv[3]=<shell_environment_policy.set.ZDOTDIR="/d/x">',
      'argv[4]=<--model>',
      'argv[5]=<m>',
    ]);
  });

  it('fails closed when the configured file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-aiden-shim-cfg-missing-'));
    dirs.push(dir);
    const shimDir = installAidenCodexShim(join(dir, 'shim'));
    const realCodex = join(dir, 'real-codex');
    writeFileSync(realCodex, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    chmodSync(realCodex, 0o755);
    const result = spawnSync(join(shimDir, 'codex'), ['x'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BOTMUX_AIDEN_CODEX_REAL_BIN: realCodex,
        BOTMUX_AIDEN_CODEX_SHELL_CONFIG_FILE: join(dir, 'gone'),
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cannot open|No such file/);
  });
});

describe('writeAidenCodexShellConfigs', () => {
  // The config file carries session paths / identity-dir locations (no credentials,
  // but still per-session data a co-tenant pane must not read). Its 0600 mode is a
  // deliberate guard, so assert it against the real filesystem rather than trusting
  // the call site.
  it('writes one override per line with 0600 permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-aiden-shellcfg-'));
    dirs.push(dir);
    const shimDir = installAidenCodexShim(join(dir, 'shim'));
    const configs = [
      'service_tier="priority"',
      'shell_environment_policy.set.SESSION_DATA_DIR="/data dir/x"',
      'shell_environment_policy.set.ZDOTDIR="/data/x/shell"',
    ];
    const file = writeAidenCodexShellConfigs(shimDir, configs);

    // umask must not widen it: assert the exact mode, not just "not world-writable".
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(configs.join('\n') + '\n');
  });

  it('leaves the value bytes intact for a value with spaces/quotes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-aiden-shellcfg-bytes-'));
    dirs.push(dir);
    const shimDir = installAidenCodexShim(join(dir, 'shim'));
    const value = 'shell_environment_policy.set.X="/a b $HOME `x` \\"q\\""';
    const file = writeAidenCodexShellConfigs(shimDir, [value]);
    expect(readFileSync(file, 'utf8')).toBe(value + '\n');
  });
});
