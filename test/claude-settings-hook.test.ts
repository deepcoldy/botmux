/**
 * claude-settings-hook.test.ts
 *
 * 验证 Claude Code adapter 的 --settings hook 注入策略：
 * - askUserQuestion hook **不**注入进程级 --settings（避免只对 botmux spawn 的会话生效）；
 *   而是声明 hookInstall 写全局 ~/.claude/settings.json —— 这样 adopt 模式（botmux 接管
 *   别处已启动、拿不到 --settings 的 claude 会话）也能让那条会话读到 hook（即 --settings
 *   里 **不含** PreToolUse / AskUserQuestion）。
 * - 进程级 --settings 仅保留 bypassPermissions / skipDangerousMode，不被挤掉。
 * - SessionStart hook（真就绪信号 → `botmux session-ready`）**走**进程级 --settings：
 *   它无需兼容 adopt（adopt 会话不走 botmux 投首条的门控），故只进程级注入；且无条件
 *   注入（即便 disableCliBypass）否则 worker 就绪门控会空等到超时兜底。
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

  it('--settings 含 SessionStart hook → botmux session-ready', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, locale: 'zh' });
    const parsed = settingsOf(args);
    const cmd = parsed.hooks?.SessionStart?.[0]?.hooks?.[0]?.command as string;
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

  it('disableCliBypass=true 时仍注入 SessionStart hook，但不带 bypass 键', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, disableCliBypass: true });
    // bypass 关闭 → 不加 --dangerously-skip-permissions
    expect(args).not.toContain('--dangerously-skip-permissions');
    const parsed = settingsOf(args);
    // SessionStart hook 仍在（否则 worker 就绪门控空等超时）
    expect(parsed.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toContain('session-ready');
    // 但 bypass 相关键缺席
    expect(parsed.skipDangerousModePermissionPrompt).toBeUndefined();
    expect(parsed.permissions).toBeUndefined();
  });

  it('adapter 标记 injectsReadyHook（驱动 worker 武装 ready-gate）', () => {
    expect(adapter.injectsReadyHook).toBe(true);
  });

  it('adapter 声明 hookInstall 指向全局 ~/.claude/settings.json', () => {
    // 家族工厂从 dataDir 统一拼绝对路径（= ~/.claude/settings.json 经 expandHome 的等价形式）。
    expect(adapter.hookInstall).toEqual({
      configPath: join(homedir(), '.claude', 'settings.json'),
      format: 'claude-settings',
    });
    // 仍标记 asksViaHook（驱动「不装 botmux-ask skill 兜底」）
    expect(adapter.asksViaHook).toBe(true);
  });
});
