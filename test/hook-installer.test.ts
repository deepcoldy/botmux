/**
 * hook-installer.test.ts
 *
 * 测试 installHook 对 claude-settings 格式的行为：
 *   (a) 写入 PermissionRequest hook 指向给定 hookCommand
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

  it('(a) 写入 PermissionRequest hook 指向给定 hookCommand', () => {
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);

    const settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    const groups: any[] = settings.hooks?.PermissionRequest ?? [];
    expect(groups.length).toBeGreaterThanOrEqual(1);

    // 找到含有我们 hookCommand 的 group
    const found = groups.find((g: any) =>
      g.hooks?.some((e: any) => e.command === hookCommand),
    );
    expect(found).toBeDefined();
    expect(found.matcher).toBe('*');

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
    expect(preToolGroups.length).toBe(1);
    expect(preToolGroups[0].hooks[0].command).toBe('/usr/bin/some-other-hook');

    // PermissionRequest 中有我们新写的 hook
    const permGroups: any[] = settings.hooks?.PermissionRequest ?? [];
    const found = permGroups.find((g: any) =>
      g.hooks?.some((e: any) => e.command === hookCommand),
    );
    expect(found).toBeDefined();
  });

  it('(c2) 已有同 hookCommand 的 PermissionRequest entry 不会重复追加', () => {
    // 第一次安装
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);
    const afterFirst = JSON.parse(readFileSync(configPath, 'utf-8'));
    const countFirst = (afterFirst.hooks?.PermissionRequest ?? []).filter((g: any) =>
      g.hooks?.some((e: any) => e.command === hookCommand),
    ).length;

    // 第二次安装（幂等）
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);
    const afterSecond = JSON.parse(readFileSync(configPath, 'utf-8'));
    const countSecond = (afterSecond.hooks?.PermissionRequest ?? []).filter((g: any) =>
      g.hooks?.some((e: any) => e.command === hookCommand),
    ).length;

    expect(countFirst).toBe(1);
    expect(countSecond).toBe(1); // 不重复
  });
});

// ─── opencode-plugin 格式 ─────────────────────────────────────────────────────

describe('installHook — opencode-plugin', () => {
  let tmpDir: string;
  let configPath: string;
  const hookCommand = '/usr/bin/node /path/to/cli.js hook opencode';

  beforeEach(() => {
    tmpDir = makeTmpDir();
    configPath = join(tmpDir, '.config', 'opencode', 'plugin', 'botmux-ask.js');
  });

  it('写入包含 hookCommand 的插件文件', () => {
    installHook('opencode', { configPath, format: 'opencode-plugin' }, hookCommand);

    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain(hookCommand);
    expect(content).toContain('question.asked');
  });

  it('幂等——二次调用后文件内容与第一次完全相同', () => {
    installHook('opencode', { configPath, format: 'opencode-plugin' }, hookCommand);
    const afterFirst = readFileSync(configPath, 'utf-8');

    installHook('opencode', { configPath, format: 'opencode-plugin' }, hookCommand);
    const afterSecond = readFileSync(configPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
  });
});
