import { describe, expect, it } from 'vitest';
import { safePromptPreview } from '../src/services/insight/prompt.js';

describe('insight prompt formatting metadata', () => {
  it('removes botmux formatting guidance from bare transcript prompts', () => {
    expect(safePromptPreview(
      '继续\n\n<botmux_formatting>internal formatting guidance</botmux_formatting>',
    )?.text).toBe('继续');
  });

  it('removes hook-mode opening context blocks while preserving user text', () => {
    const hookOpening = [
      '<role context="group">Internal role</role>',
      '<summary_memory>Summary block</summary_memory>',
      '<chat_context_policy>Policy</chat_context_policy>',
      '<shared_group_context>History</shared_group_context>',
      '请分析慢查询日志',
      '<available_bots>Helper</available_bots>',
      '<botmux_skills mode="priority">- sql</botmux_skills>',
    ].join('\n\n');
    expect(safePromptPreview(hookOpening)?.text).toBe('请分析慢查询日志');
  });
});
