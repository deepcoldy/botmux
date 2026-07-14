import { describe, it, expect } from 'vitest';
import { isCustomReply, toLegacySelected, type AskQuestion, type AskResult } from '../src/core/ask-types.js';

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

  it('answered 的 comment 可为自定义回复字符串；空 answers 时 toLegacySelected 返回 null', () => {
    const custom: AskResult = {
      kind: 'answered', answers: [[]], by: 'ou_x', comment: '我自己的答案', timedOut: false,
    };
    expect(custom.comment).toBe('我自己的答案');
    expect(toLegacySelected(custom)).toBeNull();
  });

  it('isCustomReply: 无选中项且 comment 非 null → 文字作答', () => {
    const custom: AskResult = {
      kind: 'answered', answers: [[]], by: 'ou_x', comment: '我发个多行消息试试\n这是第二行', timedOut: false,
    };
    expect(isCustomReply(custom)).toBe(true);
  });

  it('isCustomReply: 多问全部未选中同样成立', () => {
    const custom: AskResult = {
      kind: 'answered', answers: [[], []], by: 'ou_x', comment: '都不选', timedOut: false,
    };
    expect(isCustomReply(custom)).toBe(true);
  });

  it('isCustomReply: 按钮路径（有选中项，comment 为 null）→ false', () => {
    const clicked: AskResult = {
      kind: 'answered', answers: [['yes']], by: 'ou_x', comment: null, timedOut: false,
    };
    expect(isCustomReply(clicked)).toBe(false);
  });

  it('isCustomReply: 有选中项时即使带 comment 也不算文字作答', () => {
    const mixed: AskResult = {
      kind: 'answered', answers: [['yes']], by: 'ou_x', comment: '附注', timedOut: false,
    };
    expect(isCustomReply(mixed)).toBe(false);
  });

  it('isCustomReply: 非 answered 结果一律 false', () => {
    const timedOut: AskResult = {
      kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true,
    };
    const invalidated: AskResult = {
      kind: 'invalidated', reason: 'daemon restart', selected: null, by: null, comment: null, timedOut: false,
    };
    expect(isCustomReply(timedOut)).toBe(false);
    expect(isCustomReply(invalidated)).toBe(false);
  });
});
