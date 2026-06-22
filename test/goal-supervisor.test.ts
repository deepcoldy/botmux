import { describe, expect, it } from 'vitest';
import { buildGoalSupervisorPrompt } from '../src/core/goal-supervisor.js';

describe('goal supervisor prompt', () => {
  it('pins L2 duties to goal chat, ledger and L1 callback coordinates', () => {
    const prompt = buildGoalSupervisorPrompt({
      chatId: 'oc_goal',
      parentChatId: 'oc_main',
      parentRoot: 'om_root',
      title: '交付可信验收',
      brief: '先整理 charter，再派一个 worker。',
    });

    expect(prompt).toContain('L2 监管 agent');
    expect(prompt).toContain('botmux whiteboard current --create');
    expect(prompt).toContain('botmux whiteboard read --json');
    expect(prompt).toContain('botmux delivery list --goal oc_goal');
    expect(prompt).toContain('botmux dispatch --chat-id <本 goal 群 chatId>');
    expect(prompt).toContain('L1 主群 chatId: oc_main');
    expect(prompt).toContain('L1 主话题 rootMessageId: om_root');
    expect(prompt).toContain('botmux send --chat-id oc_main --quote om_root');
    expect(prompt).toContain('先整理 charter');
    expect(prompt).not.toContain('<whiteboard');
  });
});
