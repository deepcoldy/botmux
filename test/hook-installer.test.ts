/**
 * hook-installer.test.ts
 *
 * 测试 installHook 对 claude-settings 格式的行为：
 *   (a) 写入 PreToolUse AskUserQuestion hook 指向给定 hookCommand
 *   (b) 幂等——二次调用内容不变
 *   (c) 既有无关配置保留（合并而非覆盖）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installHook } from '../src/adapters/hook-installer.js';

// ─── 辅助：在临时目录创建独立的 configPath ─────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'botmux-hook-test-'));
}

// ─── claude-settings 格式 ─────────────────────────────────────────────────────

describe('installHook — claude-settings', () => {
  let tmpDir: string;
  let configPath: string;
  const hookCommand = '/usr/bin/node /path/to/cli.js hook claude-code';

  beforeEach(() => {
    tmpDir = makeTmpDir();
    configPath = join(tmpDir, '.claude', 'settings.json');
  });

  it('(a) 写入 PreToolUse AskUserQuestion hook 指向给定 hookCommand', () => {
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);

    const settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    const groups: any[] = settings.hooks?.PreToolUse ?? [];
    expect(groups.length).toBeGreaterThanOrEqual(1);

    // 找到含有我们 hookCommand 的 group
    const found = groups.find((g: any) =>
      g.hooks?.some((e: any) => e.command === hookCommand),
    );
    expect(found).toBeDefined();
    expect(found.matcher).toBe('AskUserQuestion');

    // 对应 entry 应有 timeout
    const entry = found.hooks.find((e: any) => e.command === hookCommand);
    expect(entry.type).toBe('command');
    expect(typeof entry.timeout).toBe('number');
    expect(entry.timeout).toBeGreaterThan(0);
  });

  it('(b) 幂等——二次调用后文件内容与第一次完全相同', () => {
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);
    const contentAfterFirst = readFileSync(configPath, 'utf-8');

    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);
    const contentAfterSecond = readFileSync(configPath, 'utf-8');

    expect(contentAfterSecond).toBe(contentAfterFirst);
  });

  it('(c) 既有无关配置（其他 key 和其他事件）在安装后保留', () => {
    // 预先写入一个含无关 key 和另一事件 hook 的 settings.json
    const existing = {
      theme: 'dark',
      someOtherSetting: 42,
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/bin/some-other-hook' }],
          },
        ],
      },
    };
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);

    const settings = JSON.parse(readFileSync(configPath, 'utf-8'));

    // 无关顶层 key 未被破坏
    expect(settings.theme).toBe('dark');
    expect(settings.someOtherSetting).toBe(42);

    // 其他事件（PreToolUse）的 hook 仍在
    const preToolGroups: any[] = settings.hooks?.PreToolUse ?? [];
    expect(preToolGroups.some((g) => g.hooks?.some((e: any) => e.command === '/usr/bin/some-other-hook'))).toBe(true);

    // PreToolUse 中有我们新写的 hook
    const found = preToolGroups.find((g: any) =>
      g.hooks?.some((e: any) => e.command === hookCommand),
    );
    expect(found).toBeDefined();
    expect(found.matcher).toBe('AskUserQuestion');
  });

  it('(c2) 已有同 hookCommand 的 PreToolUse entry 不会重复追加', () => {
    // 第一次安装
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);
    const afterFirst = JSON.parse(readFileSync(configPath, 'utf-8'));
    const countFirst = (afterFirst.hooks?.PreToolUse ?? []).filter((g: any) =>
      g.hooks?.some((e: any) => e.command === hookCommand),
    ).length;

    // 第二次安装（幂等）
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);
    const afterSecond = JSON.parse(readFileSync(configPath, 'utf-8'));
    const countSecond = (afterSecond.hooks?.PreToolUse ?? []).filter((g: any) =>
      g.hooks?.some((e: any) => e.command === hookCommand),
    ).length;

    expect(countFirst).toBe(1);
    expect(countSecond).toBe(1); // 不重复
  });

  it('(c3) 不同安装路径的旧 botmux hook 在重装时被去重（避免双卡）', () => {
    // 模拟 dev 源码安装残留的 hook，命令路径与本次 npm-global 安装不同
    const devCommand =
      '"/root/.local/share/fnm/.../bin/node" "/root/claude-code-workspace/botmux/dist/cli.js" hook claude-code';
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'AskUserQuestion',
            hooks: [{ type: 'command', command: devCommand, timeout: 86400 }],
          },
        ],
      },
    };
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

    // 用另一安装路径的 hookCommand 重装
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);

    const settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    const groups: any[] = settings.hooks?.PreToolUse ?? [];
    // 旧 dev 路径 hook 应被结构化识别并移除，只留下本次安装的一条
    const askGroups = groups.filter((g) => g.matcher === 'AskUserQuestion');
    expect(askGroups.length).toBe(1);
    expect(askGroups[0].hooks.some((e: any) => e.command === devCommand)).toBe(false);
    expect(askGroups[0].hooks.some((e: any) => e.command === hookCommand)).toBe(true);
  });

  it('(d) 迁移旧 PermissionRequest botmux entry 到 PreToolUse', () => {
    const existing = {
      hooks: {
        PermissionRequest: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: hookCommand, timeout: 86400 }],
          },
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/bin/other-permission-hook' }],
          },
        ],
      },
    };
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);

    const settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    const permGroups: any[] = settings.hooks?.PermissionRequest ?? [];
    expect(permGroups.some((g) => g.hooks?.some((e: any) => e.command === hookCommand))).toBe(false);
    expect(permGroups.some((g) => g.hooks?.some((e: any) => e.command === '/usr/bin/other-permission-hook'))).toBe(true);

    const preToolGroups: any[] = settings.hooks?.PreToolUse ?? [];
    expect(preToolGroups.some((g) => g.matcher === 'AskUserQuestion' && g.hooks?.some((e: any) => e.command === hookCommand))).toBe(true);
  });
});

// ─── opencode-plugin 格式 ─────────────────────────────────────────────────────

describe('installHook — opencode-plugin', () => {
  let tmpDir: string;
  let configPath: string;
  // 注意：opencode-plugin 路径下 installHook 会忽略传入的 hookCommand 字符串，
  // 改用 hookCommandParts('opencode') 自行解析 argv（见 P1.2 修复）。这里传个占位即可。
  const hookCommand = '/usr/bin/node /path/to/cli.js hook opencode';

  beforeEach(() => {
    tmpDir = makeTmpDir();
    configPath = join(tmpDir, '.config', 'opencode', 'plugin', 'botmux-ask.js');
  });

  it('插件用 argv 形式 spawnSync(cmd, args)，不拆 shell 字符串（Codex P1.2 回归）', () => {
    installHook('opencode', { configPath, format: 'opencode-plugin' }, hookCommand);
    const content = readFileSync(configPath, 'utf-8');

    expect(content).toContain('question.asked');
    expect(content).toContain('spawnSync(');
    // args 以 JSON 数组嵌入，包含 hook 子命令与 cliId
    expect(content).toContain('"hook"');
    expect(content).toContain('"opencode"');
    expect(content).toContain('cli.js');
    // 绝不能再出现「把带引号命令字符串 .split(" ")」的旧写法
    expect(content).not.toContain('.split(');
    expect(content).not.toContain('parts[0]');
  });

  it('幂等——二次调用后文件内容与第一次完全相同', () => {
    installHook('opencode', { configPath, format: 'opencode-plugin' }, hookCommand);
    const afterFirst = readFileSync(configPath, 'utf-8');

    installHook('opencode', { configPath, format: 'opencode-plugin' }, hookCommand);
    const afterSecond = readFileSync(configPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
  });
});
