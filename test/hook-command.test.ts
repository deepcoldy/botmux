import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hookCommandFor,
  nativeSubagentRuntimeHookCommand,
  sessionReadyHookCommand,
} from '../src/adapters/hook-command.js';

// 回归保护：hook 命令必须指向 cli.js（有 `hook` 子命令分发），
// 绝不能指向 index-daemon.js（只 startDaemon、不处理 hook）。
// 该 bug 在 daemon 进程里用 process.argv[1] 时会出现——daemon 的 argv[1]
// 是 index-daemon.js。源码与 npm global 安装都受影响。
describe('hookCommandFor', () => {
  it('指向 cli.js 而非 index-daemon.js，并以 hook 子命令结尾', () => {
    const cmd = hookCommandFor('claude-code');
    expect(cmd).toContain('cli.js');
    expect(cmd).not.toContain('index-daemon');
    expect(cmd.endsWith('hook claude-code')).toBe(true);
  });

  it('Node 路径与 cli 路径均加引号（容忍空格），cliId 透传', () => {
    const cmd = hookCommandFor('opencode');
    expect(cmd).toMatch(/^".+" ".+cli\.js" hook opencode$/);
  });
});

describe('sessionReadyHookCommand', () => {
  it('指向 cli.js 而非 index-daemon.js，并以 session-ready 子命令结尾', () => {
    const cmd = sessionReadyHookCommand();
    expect(cmd).toContain('cli.js');
    expect(cmd).not.toContain('index-daemon');
    expect(cmd.endsWith('session-ready')).toBe(true);
  });

  it('Node 路径与 cli 路径均加引号（容忍空格），无 cliId 参数', () => {
    const cmd = sessionReadyHookCommand();
    expect(cmd).toMatch(/^".+" ".+cli\.js" session-ready$/);
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
