/**
 * claude-settings-hook.test.ts
 *
 * 验证 Claude Code adapter 的 --settings hook 注入策略：
 * - askUserQuestion hook **不**注入进程级 --settings（避免只对 botmux spawn 的会话生效）；
 *   而是声明 hookInstall 写全局 ~/.claude/settings.json —— 这样 adopt 模式（botmux 接管
 *   别处已启动、拿不到 --settings 的 claude 会话）也能让那条会话读到 hook（即 --settings
 *   里 **不含** PreToolUse / AskUserQuestion）。
 * - 进程级 --settings 仅保留 bypassPermissions / skipDangerousMode；没有这些键时干脆不传 --settings。
 * - SessionStart hook（真就绪信号 → `botmux session-ready`）**改走全局** settings.json
 *   （hookInstall.sessionStartCommand），不再注入进程级 --settings。原因：① wrapperCli=aiden x
 *   claude 会剥掉 --settings，全局是其唯一渠道；② 进程级+全局同时注入会让 Claude 等两条 hook
 *   退出才渲染输入框、而 worker 在第一条信号就放行首条 prompt → 抢跑触发 paste-burst → 软换行
 *   `\` 字面残留。单一全局来源消除竞态。
 */
import { describe, it, expect, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Mock child_process.execSync 使 resolveCommand() 直接返回命令名。
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
}));

import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';

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

  it('disableCliBypass=true 时无 bypass 键 → 干脆不传进程级 --settings（就绪 hook 走全局）', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, disableCliBypass: true });
    // bypass 关闭 → 不加 --dangerously-skip-permissions
    expect(args).not.toContain('--dangerously-skip-permissions');
    // 没有 bypass 键、SessionStart 已移走 → 不再传 --settings
    expect(args).not.toContain('--settings');
    // 就绪 hook 仍由全局 hookInstall 提供
    expect(adapter.hookInstall?.sessionStartCommand).toContain('session-ready');
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
