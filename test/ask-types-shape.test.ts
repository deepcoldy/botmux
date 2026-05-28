import { describe, it, expect } from 'vitest';
import { toLegacySelected, type AskQuestion, type AskResult } from '../src/core/ask-types.js';

describe('ask-types 多问多选模型', () => {
  it('toLegacySelected: 单问单选答案映射回旧 selected 字符串', () => {
    const answered: AskResult = {
      kind: 'answered',
      answers: [['yes']],
      by: 'ou_x',
      comment: null,
      timedOut: false,
    };
    expect(toLegacySelected(answered)).toBe('yes');
  });

  it('toLegacySelected: 多选或多问返回 null（旧单选语义不适用）', () => {
    const multi: AskResult = {
      kind: 'answered', answers: [['a', 'b']], by: 'ou_x', comment: null, timedOut: false,
    };
    expect(toLegacySelected(multi)).toBeNull();
  });

  it('AskQuestion 结构含 prompt/options/multiSelect', () => {
    const q: AskQuestion = { prompt: 'go?', options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }], multiSelect: false };
    expect(q.options).toHaveLength(2);
  });
});
