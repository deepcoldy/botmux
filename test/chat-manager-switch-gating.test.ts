import { describe, expect, it, vi } from 'vitest';

const { loadBotConfigs } = vi.hoisted(() => ({ loadBotConfigs: vi.fn() }));
vi.mock('../src/global-config.js', () => ({
  isWorkflowFeatureEnabled: () => false,
  isMultiTopicOrchestrationEnabled: () => false,
}));
vi.mock('../src/bot-registry.js', () => ({ loadBotConfigs }));

import { builtinSkillEntries, chatManagerEnabledForApp } from '../src/skills/injection-mode.js';
import { CHAT_MANAGER_SKILL_NAME } from '../src/skills/definitions.js';

function names(opts: Parameters<typeof builtinSkillEntries>[0] = {}): string[] {
  return builtinSkillEntries(opts).map(e => e.name);
}

describe('chat-manager skill per-bot gating (default off)', () => {
  it('omits the skill by default / when no bot is enabled', () => {
    loadBotConfigs.mockReturnValue([{ larkAppId: 'cli_a' }]);
    expect(chatManagerEnabledForApp('cli_a')).toBe(false);
    expect(names()).not.toContain(CHAT_MANAGER_SKILL_NAME);
    expect(names({ chatManagerEnabled: false })).not.toContain(CHAT_MANAGER_SKILL_NAME);
  });
  it('includes the skill only for an enabled bot, leaves other builtins intact', () => {
    loadBotConfigs.mockReturnValue([{ larkAppId: 'cli_a', chatManagerEnabled: true }, { larkAppId: 'cli_b' }]);
    expect(chatManagerEnabledForApp('cli_a')).toBe(true);
    expect(chatManagerEnabledForApp('cli_b')).toBe(false);
    expect(names({ chatManagerEnabled: true })).toContain(CHAT_MANAGER_SKILL_NAME);
  });
});
