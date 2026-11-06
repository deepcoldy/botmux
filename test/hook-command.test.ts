import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { shellJoin } from '../src/core/cli-launch-mode.js';
import {
  botmuxShellCommand,
  hookCommandFor,
  hookCommandParts,
  nativeSubagentRuntimeHookCommand,
  sessionReadyHookCommand,
  statuslineHookCommand,
} from '../src/adapters/hook-command.js';

function hookRuntimePrefix(cliId: string): string {
  const parts = hookCommandParts(cliId);
  return shellJoin([parts.cmd, ...parts.args.slice(0, -2)]);
}

function sessionRuntimePrefix(): string {
  const parts = hookCommandParts('unused');
  return shellJoin([parts.cmd, ...parts.args.slice(0, -2)]);
}

// 回归保护：hook 命令必须指向 cli.js（有 `hook` 子命令分发），
// 绝不能指向 index-daemon.js（只 startDaemon、不处理 hook）。
// 该 bug 在 daemon 进程里用 process.argv[1] 时会出现——daemon 的 argv[1]
// 是 index-daemon.js。源码与 npm global 安装都受影响。
describe('hookCommandFor', () => {
  it('指向 CLI 入口而非 index-daemon.js，并以 hook 子命令结尾', () => {
    const cmd = hookCommandFor('claude-code');
    expect(cmd).toContain('cli.ts');
    expect(cmd).not.toContain('index-daemon');
    expect(cmd.endsWith('hook claude-code')).toBe(true);
  });

  it('quotes each Node/tsx argv token literally', () => {
    expect(hookCommandFor('opencode')).toBe(`${hookRuntimePrefix('opencode')} hook opencode`);
  });

  it('passes shell metacharacters in a CLI path literally without executing substitutions', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'botmux-hook-shell-'));
    const fixture = join(root, "space $(touch${IFS}dollar-marker) `touch${IFS}backtick-marker` ' \" $HOME");
    const moduleUrl = pathToFileURL(join(fixture, 'dist', 'adapters', 'hook-command.js')).href;
    try {
      mkdirSync(join(fixture, 'dist', 'adapters'), { recursive: true });
      writeFileSync(join(fixture, 'dist', 'cli.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
      const command = botmuxShellCommand(['hook', 'opencode'], false, moduleUrl);
      const result = spawnSync('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(['hook', 'opencode']);
      expect(existsSync(join(root, 'dollar-marker'))).toBe(false);
      expect(existsSync(join(root, 'backtick-marker'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sessionReadyHookCommand', () => {
  it('指向 CLI 入口而非 index-daemon.js，并以 session-ready 子命令结尾', () => {
    const cmd = sessionReadyHookCommand();
    expect(cmd).toContain('cli.ts');
    expect(cmd).not.toContain('index-daemon');
    expect(cmd.endsWith('session-ready')).toBe(true);
  });

  it('Node/tsx 运行时为解释器参数和 CLI 路径加引号', () => {
    expect(sessionReadyHookCommand()).toBe(`${sessionRuntimePrefix()} session-ready`);
  });
});

describe('statuslineHookCommand', () => {
  it('指向 CLI 入口而非 index-daemon.js，并以 statusline 子命令结尾', () => {
    const cmd = statuslineHookCommand();
    expect(cmd).toContain('cli.ts');
    expect(cmd).not.toContain('index-daemon');
    expect(cmd.endsWith(' statusline')).toBe(true);
  });

  it('Node/tsx 运行时为解释器参数和 CLI 路径加引号', () => {
    expect(statuslineHookCommand()).toBe(`${sessionRuntimePrefix()} statusline`);
  });
});

describe('nativeSubagentRuntimeHookCommand', () => {
  it('uses the dedicated stable native-hook wrapper so a reattached pane picks up the current build', () => {
    const cmd = nativeSubagentRuntimeHookCommand();
    expect(cmd).toMatch(/^".+[/\\]\.botmux[/\\]bin[/\\]botmux-native-subagent-runtime-hook(?:\.cmd)?"$/);
    expect(cmd).not.toContain('cli.js');
    expect(cmd).not.toContain(' native-subagent-runtime-hook');
  });

  it('canonicalizes a symlinked HOME wrapper path so full bwrap can still see it', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'botmux-hook-home-'));
    const realHome = join(root, 'real-home');
    const aliasHome = join(root, 'alias-home');
    mkdirSync(join(realHome, '.botmux', 'bin'), { recursive: true });
    symlinkSync(realHome, aliasHome, 'dir');
    try {
      const cmd = nativeSubagentRuntimeHookCommand({ HOME: aliasHome }, 'linux');
      expect(cmd).toBe(`"${join(realpathSync(join(realHome, '.botmux', 'bin')), 'botmux-native-subagent-runtime-hook')}"`);
      expect(cmd).not.toContain(aliasHome);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
