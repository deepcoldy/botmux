/**
 * claude-settings-hook.test.ts
 *
 * 验证 Claude Code adapter 的 --settings hook 注入策略：
 * - askUserQuestion hook **不**注入进程级 --settings（避免只对 botmux spawn 的会话生效）；
 *   而是声明 hookInstall 写全局 ~/.claude/settings.json —— 这样 adopt 模式（botmux 接管
 *   别处已启动、拿不到 --settings 的 claude 会话）也能让那条会话读到 hook（即 --settings
 *   里 **不含** PreToolUse / AskUserQuestion）。
 * - 进程级 --settings 保留 bypassPermissions / skipDangerousMode，并（仅 claude-code）恒带
 *   statusLine → `botmux statusline`：statusLine 是单值、不像 hooks 按事件合并，写全局会覆盖
 *   用户自己的，所以只能走进程级；被 wrapperCli 剥掉时卡片省略配额段即可。
 * - SessionStart hook（真就绪信号 → `botmux session-ready`）**改走全局** settings.json
 *   （hookInstall.sessionStartCommand），不再注入进程级 --settings。原因：① wrapperCli=aiden x
 *   claude 会剥掉 --settings，全局是其唯一渠道；② 进程级+全局同时注入会让 Claude 等两条 hook
 *   退出才渲染输入框、而 worker 在第一条信号就放行首条 prompt → 抢跑触发 paste-burst → 软换行
 *   `\` 字面残留。单一全局来源消除竞态。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

// Mock child_process.execSync 使 resolveCommand() 直接返回命令名。
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
}));

import { createClaudeCodeAdapter, resolveShadowedStatusLine } from '../src/adapters/cli/claude-code.js';

function settingsOf(args: string[]): any {
  const idx = args.indexOf('--settings');
  expect(idx).toBeGreaterThanOrEqual(0);
  return JSON.parse(args[idx + 1]);
}

describe('claude-code —— hook 注入策略（adopt 兼容 + SessionStart 真就绪信号）', () => {
  const adapter = createClaudeCodeAdapter('/usr/bin/claude');

  it('SessionStart 就绪 hook 改走全局 hookInstall，不再注入进程级 --settings', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, locale: 'zh' });
    // 默认 !disableCliBypass → --settings 仍在（带 bypass 键），但 **不含** SessionStart
    const parsed = settingsOf(args);
    expect(parsed.hooks?.SessionStart).toBeUndefined();
    // 就绪 hook 由全局 settings.json 注入（hookInstall.sessionStartCommand）
    const cmd = adapter.hookInstall?.sessionStartCommand as string;
    expect(typeof cmd).toBe('string');
    expect(cmd).toContain('cli.js');
    expect(cmd).not.toContain('index-daemon');
    expect(cmd.endsWith('session-ready')).toBe(true);
  });

  it('--settings 内联 JSON **不含** askUserQuestion（PreToolUse 仍走全局 settings，适配 adopt）', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    const parsed = settingsOf(args);
    expect(parsed.hooks?.PreToolUse).toBeUndefined();
  });

  it('--settings 仍保留 bypassPermissions 与 skipDangerousModePermissionPrompt', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    const parsed = settingsOf(args);
    expect(parsed.permissions?.defaultMode).toBe('bypassPermissions');
    expect(parsed.skipDangerousModePermissionPrompt).toBe(true);
  });

  it('disableCliBypass=true 时仍传 --settings（statusLine 恒在），但无 bypass 键（就绪 hook 走全局）', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, disableCliBypass: true });
    // bypass 关闭 → 不加 --dangerously-skip-permissions
    expect(args).not.toContain('--dangerously-skip-permissions');
    // claude-code 恒传 --settings（承载 statusLine），但不含任何 bypass 键
    const parsed = settingsOf(args);
    expect(parsed.permissions).toBeUndefined();
    expect(parsed.skipDangerousModePermissionPrompt).toBeUndefined();
    expect(parsed.hooks).toBeUndefined();
    expect(parsed.statusLine?.type).toBe('command');
    // 就绪 hook 仍由全局 hookInstall 提供
    expect(adapter.hookInstall?.sessionStartCommand).toContain('session-ready');
  });

  it('--settings 恒带 statusLine → `botmux statusline`，refreshInterval=60', () => {
    const parsed = settingsOf(adapter.buildArgs({ sessionId: 's', resume: false }));
    expect(parsed.statusLine).toMatchObject({ type: 'command', refreshInterval: 60 });
    expect(typeof parsed.statusLine.command).toBe('string');
    expect(parsed.statusLine.command.endsWith('statusline')).toBe(true);
    expect(parsed.statusLine.command).toContain('cli.js');
    expect(parsed.statusLine.command).not.toContain('index-daemon');
    // 只走进程级：全局 hookInstall 不声明 statusLine（全局单值会覆盖用户自己的）
    expect((adapter.hookInstall as any)?.statusLineCommand).toBeUndefined();
  });

  it('adapter 标记 injectsReadyHook（驱动 worker 武装 ready-gate）', () => {
    expect(adapter.injectsReadyHook).toBe(true);
  });

  it('adapter 声明 hookInstall 指向全局 ~/.claude/settings.json', () => {
    // 家族工厂从 dataDir 统一拼绝对路径（= ~/.claude/settings.json 经 expandHome 的等价形式）。
    expect(adapter.hookInstall).toMatchObject({
      configPath: join(homedir(), '.claude', 'settings.json'),
      format: 'claude-settings',
    });
    // 同时把 SessionStart 就绪 hook 写全局（为 aiden x claude 这类剥 --settings 的启动器供信号）
    expect(adapter.hookInstall?.sessionStartCommand).toMatch(/session-ready$/);
    // 仍标记 asksViaHook（驱动「不装 botmux-ask skill 兜底」）
    expect(adapter.asksViaHook).toBe(true);
  });
});

describe('resolveShadowedStatusLine —— 找回被进程级 --settings 遮蔽的用户 statusLine', () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  function scaffold(): { workingDir: string; userSettingsPath: string } {
    const root = mkdtempSync(join(tmpdir(), 'botmux-shadowed-statusline-'));
    roots.push(root);
    const workingDir = join(root, 'proj');
    mkdirSync(join(workingDir, '.claude'), { recursive: true });
    mkdirSync(join(root, 'home', '.claude'), { recursive: true });
    return { workingDir, userSettingsPath: join(root, 'home', '.claude', 'settings.json') };
  }
  const statusLine = (command: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ statusLine: { type: 'command', command, ...extra } });

  it('优先级：settings.local.json > settings.json > 用户 settings', () => {
    const { workingDir, userSettingsPath } = scaffold();
    writeFileSync(userSettingsPath, statusLine('user-cmd'));
    expect(resolveShadowedStatusLine({ workingDir, userSettingsPath })).toEqual({ command: 'user-cmd' });
    writeFileSync(join(workingDir, '.claude', 'settings.json'), statusLine('project-cmd', { padding: 0 }));
    expect(resolveShadowedStatusLine({ workingDir, userSettingsPath })).toEqual({ command: 'project-cmd', padding: 0 });
    writeFileSync(join(workingDir, '.claude', 'settings.local.json'), statusLine('local-cmd', { refreshInterval: 5 }));
    expect(resolveShadowedStatusLine({ workingDir, userSettingsPath })).toEqual({ command: 'local-cmd', refreshInterval: 5 });
  });

  it('坏文件 / 非 command 类型 / 空 command 视为该层无配置，继续向下找；全部没有 ⇒ {}', () => {
    const { workingDir, userSettingsPath } = scaffold();
    expect(resolveShadowedStatusLine({ workingDir, userSettingsPath })).toEqual({});
    writeFileSync(join(workingDir, '.claude', 'settings.local.json'), '{ not json');
    writeFileSync(join(workingDir, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: '   ' } }));
    writeFileSync(userSettingsPath, statusLine('user-cmd'));
    expect(resolveShadowedStatusLine({ workingDir, userSettingsPath })).toEqual({ command: 'user-cmd' });
    // 用户层不是 command 类型 ⇒ 也视为无
    writeFileSync(userSettingsPath, JSON.stringify({ statusLine: { type: 'static', text: 'x' } }));
    expect(resolveShadowedStatusLine({ workingDir, userSettingsPath })).toEqual({});
    // 顶层不是对象 / 数组也不炸
    writeFileSync(userSettingsPath, '[1,2]');
    expect(resolveShadowedStatusLine({ workingDir, userSettingsPath })).toEqual({});
    // 不给 userSettingsPath 也可以
    expect(resolveShadowedStatusLine({ workingDir })).toEqual({});
  });

  it('padding / refreshInterval 只放行有限数值', () => {
    const { workingDir, userSettingsPath } = scaffold();
    writeFileSync(userSettingsPath, statusLine('user-cmd', { padding: 'x', refreshInterval: Number.NaN }));
    expect(resolveShadowedStatusLine({ workingDir, userSettingsPath })).toEqual({ command: 'user-cmd' });
  });
});
