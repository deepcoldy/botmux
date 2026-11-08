import { describe, expect, it } from 'vitest';
import type { AskQuestion } from '../src/core/ask-types.js';
import { capChars, optionDescriptions } from '../src/im/lark/ask-option-descriptions.js';

describe('capChars', () => {
  it.each([
    ['😀😀😀😀', 1, ''],
    ['😀😀😀😀', 2, '😀'],
    ['😀😀😀😀', 3, '😀'],
    ['😀😀😀😀', 5, '😀😀'],
    ['😀😀😀😀', 7, '😀😀😀'],
    ['a😀😀😀', 2, 'a'],
    ['a😀😀😀', 3, 'a😀'],
    ['a😀😀😀', 4, 'a😀'],
    ['a😀😀😀', 6, 'a😀😀'],
    ['a😀😀😀', 7, 'a😀😀😀'],
    ['abc', 0, ''],
  ] as Array<[string, number, string]>)('capChars(%j, %i) → %j：切点落在代理对中间时退一位', (text, cap, expected) => {
    expect(capChars(text, cap)).toBe(expected);
  });
});

describe('optionDescriptions', () => {
  const q: AskQuestion = { prompt: '选哪个？', multiSelect: false, options: [
    { key: 'a', label: '甲', description: '😀😀😀' },
    { key: 'b', label: '乙', description: 'x😀😀😀' },
  ] };

  it.each([
    [1, '…', 'x…'],
    [2, '😀…', 'x…'],
    [3, '😀…', 'x😀…'],
    [4, '😀😀…', 'x😀…'],
    [5, '😀😀…', 'x😀😀…'],
  ] as Array<[number, string, string]>)('共享 cap=%i：两条说明 emoji 奇偶相反，被切开代理对的那条退一位', (cap, first, second) => {
    const out = optionDescriptions(q, 'zh', cap)!;
    expect(out.truncated).toBe(true);
    expect(out.content.split('\n\n').slice(0, 2)).toEqual([`**甲**：${first}`, `**乙**：${second}`]);
  });
});
