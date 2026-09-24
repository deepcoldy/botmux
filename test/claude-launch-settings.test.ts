/**
 * Per-bot env (bots.json `env`) must actually WIN over the user's global
 * ~/.claude/settings.json `env` map. Claude applies every settings source's
 * `env` ON TOP of inherited process env, so a bot's provider overrides
 * (ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL) delivered as pane process env are
 * silently rewritten by whatever the user's global settings say — the bot
 * ends up on the wrong provider with zero error.
 *
 * The claude adapter therefore promotes the per-bot env into its process-level
 * `--settings` payload (higher precedence than user/project settings files).
 * Because the env typically carries ANTHROPIC_AUTH_TOKEN, the payload must go
 * through a 0600 FILE (`--settings <path>`), never inline JSON in argv —
 * argv is world-readable through `ps`.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';

const BASE = {
  sessionId: 'S1',
  resume: false,
  botName: 'B',
  botOpenId: 'ou_x',
  locale: 'zh' as const,
};

const SECRET_ENV = {
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'sk-test-should-not-appear-in-argv',
  ANTHROPIC_MODEL: 'deepseek-flash',
};

function settingsFlagValue(args: string[]): string | undefined {
  const i = args.indexOf('--settings');
  return i >= 0 ? args[i + 1] : undefined;
}

describe('claude buildArgs — per-bot settingsEnv promotion', () => {
  it('writes env into a 0600 settings file and passes its path, never inline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-ls-'));
    const file = join(dir, 'nested', 'botmux-launch-settings.json'); // adapter must mkdir -p
    const args = createClaudeCodeAdapter().buildArgs({
      ...BASE,
      settingsEnv: SECRET_ENV,
      settingsFilePath: file,
    });

    const flag = settingsFlagValue(args);
    expect(flag).toBe(file);
    // 密钥不得出现在 argv 任何元素里
    for (const a of args) expect(a).not.toContain('sk-test-should-not-appear-in-argv');

    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(file, 'utf-8'));
    expect(written.env).toEqual(SECRET_ENV);
    // bypass 键与 env 同文件共存
    expect(written.skipDangerousModePermissionPrompt).toBe(true);
    expect(written.permissions).toEqual({ defaultMode: 'bypassPermissions' });
  });

  it('keeps the inline bypass-only payload when no settingsEnv is given', () => {
    const args = createClaudeCodeAdapter().buildArgs({ ...BASE });
    const flag = settingsFlagValue(args);
    expect(flag).toBeDefined();
    const parsed = JSON.parse(flag!);
    expect(parsed.skipDangerousModePermissionPrompt).toBe(true);
    expect(parsed.env).toBeUndefined();
  });

  it('drops --settings entirely when env exists but no file path is available (no argv leak)', () => {
    const args = createClaudeCodeAdapter().buildArgs({
      ...BASE,
      settingsEnv: SECRET_ENV,
      // settingsFilePath 缺失：宁可退化到进程 env（旧行为），也不内联密钥
    });
    expect(settingsFlagValue(args)).toBeUndefined();
    for (const a of args) expect(a).not.toContain('sk-test-should-not-appear-in-argv');
  });

  it('under disableCliBypass, a settingsEnv file still carries the env (and no bypass keys)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-ls-'));
    const file = join(dir, 'botmux-launch-settings.json');
    const args = createClaudeCodeAdapter().buildArgs({
      ...BASE,
      disableCliBypass: true,
      settingsEnv: SECRET_ENV,
      settingsFilePath: file,
    });
    expect(settingsFlagValue(args)).toBe(file);
    const written = JSON.parse(readFileSync(file, 'utf-8'));
    expect(written.env).toEqual(SECRET_ENV);
    expect(written.permissions).toBeUndefined();
  });
});
