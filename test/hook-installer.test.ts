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

  it('(d) sessionStartCommand 时同时写入 SessionStart 就绪 hook，且幂等去重（路径变化也算同一条）', () => {
    const readyCmd = '/usr/bin/node /path/to/cli.js session-ready';
    installHook('claude-code', { configPath, format: 'claude-settings', sessionStartCommand: readyCmd }, hookCommand);

    let settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    let ss: any[] = settings.hooks?.SessionStart ?? [];
    expect(ss.some((g) => g.hooks?.some((e: any) => e.command === readyCmd))).toBe(true);

    // 幂等：用 npm-global 风格的不同 cli.js 绝对路径再装，应替换而非叠加（仍只有一条 botmux 就绪 hook）
    const readyCmd2 = '/opt/npm/lib/node_modules/botmux/dist/cli.js session-ready';
    installHook('claude-code', { configPath, format: 'claude-settings', sessionStartCommand: readyCmd2 }, hookCommand);
    settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    ss = settings.hooks?.SessionStart ?? [];
    const botmuxReady = ss.filter((g) => g.hooks?.some((e: any) => e.command.includes('cli.js') && e.command.trimEnd().endsWith('session-ready')));
    expect(botmuxReady.length).toBe(1);
    expect(botmuxReady[0].hooks[0].command).toBe(readyCmd2);
  });

  it('(e) 不传 sessionStartCommand 时不写 SessionStart（保持旧行为）', () => {
    installHook('claude-code', { configPath, format: 'claude-settings' }, hookCommand);
    const settings = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(settings.hooks?.SessionStart).toBeUndefined();
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

  it('插件用 argv 形式 spawn(cmd, args)，不拆 shell 字符串（Codex P1.2 回归）', () => {
    installHook('opencode', { configPath, format: 'opencode-plugin' }, hookCommand);
    const content = readFileSync(configPath, 'utf-8');

    // 监听 question.asked 事件并经 event 钩子拦截（OpenCode 插件无专用 question 钩子）
    expect(content).toContain('question.asked');
    expect(content).toContain('event:');
    // 插件导出必须是「函数」（OpenCode 要求；导出对象会报 "Plugin export is not a function"）
    expect(content).toContain('export const BotmuxAsk = async');
    // 异步 spawn（绝不能用 spawnSync 同步阻塞 OpenCode 单线程事件总线）
    expect(content).toContain('spawn(');
    expect(content).not.toContain('spawnSync(');
    // 答案 POST 回 OpenCode 的 reply 端点解阻塞
    expect(content).toContain('/question/');
    expect(content).toContain('/reply');
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
