import { describe, expect, it } from 'vitest';
import { buildNewTopicPrompt } from '../src/core/session-manager.js';

describe('session CLI selection opening prompt', () => {
  it('builds the non-Claude routing context when the selected CLI is Codex', () => {
    const prompt = buildNewTopicPrompt('首轮任务', 'session-codex', 'codex');

    expect(prompt).toContain('<botmux_routing>');
    expect(prompt).toContain('<session_id>session-codex</session_id>');
  });
});
