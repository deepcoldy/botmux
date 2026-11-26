import { describe, expect, it } from 'vitest';
import { buildSubmitMessagePreview } from '../src/services/submit-notification.js';

describe('buildSubmitMessagePreview', () => {
  it('shows the user message without BotMux envelope metadata', () => {
    const prompt = [
      '<session_id>c514e8a0-7dbe-4a24-8ea5-43a5e4a77242</session_id>',
      '<role context="group">hidden routing</role>',
      '<user_message>',
      '180 秒的超时时间可以调吗？在哪调',
      '</user_message>',
    ].join('\n');

    expect(buildSubmitMessagePreview(prompt)).toBe('180 秒的超时时间可以调吗？在哪调');
  });

  it('normalizes control characters and truncates by Unicode characters', () => {
    expect(buildSubmitMessagePreview(`  你好\n\t${'😀'.repeat(4)}  `, 4)).toBe('你好 😀…');
  });

  it('strips BotMux envelope blocks on hook-mode prompts without <user_message> and unwraps <botmux_task>', () => {
    const hookPrompt = [
      '<role context="group">hidden role</role>',
      '<chat_context_policy>policy</chat_context_policy>',
      '<shared_group_context>recent chat</shared_group_context>',
      '<botmux_task trusted="true">帮我排查数据库连接超时</botmux_task>',
      '<botmux_link_refs>L1=https://example.test</botmux_link_refs>',
      '<botmux_skills mode="priority">- db</botmux_skills>',
    ].join('\n\n');
    expect(buildSubmitMessagePreview(hookPrompt)).toBe('帮我排查数据库连接超时');
  });
});
