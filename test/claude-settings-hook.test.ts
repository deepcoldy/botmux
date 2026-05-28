/**
 * claude-settings-hook.test.ts
 *
 * 验证 Claude Code adapter：
 * - askUserQuestion hook **不**注入进程级 --settings（避免只对 botmux spawn 的会话生效）；
 * - 而是声明 hookInstall 写全局 ~/.claude/settings.json —— 这样 adopt 模式（botmux 接管
 *   别处已启动、拿不到 --settings 的 claude 会话）也能让那条会话读到 hook。
 * - 进程级 --settings 仅保留 bypassPermissions / skipDangerousMode，不被挤掉。
 */
import { describe, it, expect, vi } from 'vitest';

// Mock child_process.execSync 使 resolveCommand() 直接返回命令名。
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
}));

import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';

describe('claude-code —— hook 走全局 settings、不进 --settings（适配 adopt 模式）', () => {
  const adapter = createClaudeCodeAdapter('/usr/bin/claude');

  it('--settings 内联 JSON 不含 hooks（hook 改由全局 settings.json 承载）', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, locale: 'zh' });
    const idx = args.indexOf('--settings');
    expect(idx).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(args[idx + 1]);
    expect(parsed.hooks).toBeUndefined();
  });

  it('--settings 仍保留 bypassPermissions 与 skipDangerousModePermissionPrompt', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    const idx = args.indexOf('--settings');
    const parsed = JSON.parse(args[idx + 1]);
    expect(parsed.permissions?.defaultMode).toBe('bypassPermissions');
    expect(parsed.skipDangerousModePermissionPrompt).toBe(true);
  });

  it('adapter 声明 hookInstall 指向全局 ~/.claude/settings.json', () => {
    expect(adapter.hookInstall).toEqual({
      configPath: '~/.claude/settings.json',
      format: 'claude-settings',
    });
    // 仍标记 asksViaHook（驱动「不装 botmux-ask skill 兜底」）
    expect(adapter.asksViaHook).toBe(true);
  });
});
