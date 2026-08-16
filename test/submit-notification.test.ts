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
});
