/**
 * claude-settings-hook.test.ts
 *
 * 验证 Claude Code adapter 的 buildArgs 通过 --settings 内联 JSON 注入
 * PreToolUse hook，而非依赖全局 settings.json。
 */
import { describe, it, expect, vi } from 'vitest';

// Mock child_process.execSync 使 resolveCommand() 直接返回命令名。
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
}));

import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';

describe('claude-code buildArgs —— --settings 内联 hook 注入', () => {
  const adapter = createClaudeCodeAdapter('/usr/bin/claude');

  it('--settings 中包含 hooks.PreToolUse，hook command 指向 cli.js 并以 hook claude-code 结尾', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, locale: 'zh' });
    const idx = args.indexOf('--settings');
    expect(idx).toBeGreaterThanOrEqual(0);

    const parsed = JSON.parse(args[idx + 1]);

    // hook 配置存在
    const preToolUse = parsed.hooks?.PreToolUse;
    expect(Array.isArray(preToolUse)).toBe(true);
    expect(preToolUse.length).toBeGreaterThanOrEqual(1);

    // 第一个 group 的第一条 hook command
    const hookEntry = preToolUse[0]?.hooks?.[0];
    expect(hookEntry).toBeDefined();
    expect(hookEntry.command).toContain('cli.js');
    expect(hookEntry.command.endsWith('hook claude-code')).toBe(true);
  });

  it('--settings 合并后 permissions.defaultMode 仍为 bypassPermissions', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    const idx = args.indexOf('--settings');
    const parsed = JSON.parse(args[idx + 1]);
    expect(parsed.permissions?.defaultMode).toBe('bypassPermissions');
  });

  it('--settings 合并后 skipDangerousModePermissionPrompt 仍为 true', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    const idx = args.indexOf('--settings');
    const parsed = JSON.parse(args[idx + 1]);
    expect(parsed.skipDangerousModePermissionPrompt).toBe(true);
  });
});
