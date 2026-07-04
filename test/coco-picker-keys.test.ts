import { describe, it, expect } from 'vitest';
import { computeCocoPickerKeys } from '../src/core/coco-picker-keys.js';
import type { AskQuestion } from '../src/core/ask-types.js';

function q(prompt: string, labels: string[], multiSelect: boolean): AskQuestion {
  return { prompt, multiSelect, options: labels.map((l) => ({ key: l, label: l })) };
}

describe('computeCocoPickerKeys', () => {
  it('single question, single-select, first option → just Enter', () => {
    const questions = [q('Pick', ['A', 'B', 'C'], false)];
    const { navKeys } = computeCocoPickerKeys(questions, [['A']]);
    expect(navKeys).toEqual(['Enter']);
  });

  it('single question, single-select, third option → Down Down Enter', () => {
    const questions = [q('Pick', ['A', 'B', 'C'], false)];
    const { navKeys } = computeCocoPickerKeys(questions, [['C']]);
    expect(navKeys).toEqual(['Down', 'Down', 'Enter']);
  });

  it('single question, multi-select, options 0 and 2 → Space, nav to 2 + Space, nav to Next + Enter', () => {
    // rows: 0 A, 1 B, 2 C, 3 "Type something", 4 Next
    const questions = [q('Pick', ['A', 'B', 'C'], true)];
    const { navKeys } = computeCocoPickerKeys(questions, [['A', 'C']]);
    expect(navKeys).toEqual(['Space', 'Down', 'Down', 'Space', 'Down', 'Down', 'Enter']);
  });

  it('multi-select with single middle option → nav to it, Space, nav to Next, Enter', () => {
    const questions = [q('Pick', ['A', 'B', 'C'], true)];
    const { navKeys } = computeCocoPickerKeys(questions, [['B']]);
    // to idx1: Down, Space; to Next(idx4): Down Down Down; Enter
    expect(navKeys).toEqual(['Down', 'Space', 'Down', 'Down', 'Down', 'Enter']);
  });

  it('multi-select with nothing selected → straight to Next + Enter', () => {
    const questions = [q('Pick', ['A', 'B', 'C'], true)];
    const { navKeys } = computeCocoPickerKeys(questions, [[]]);
    // to Next(idx4) from 0: Down x4, Enter
    expect(navKeys).toEqual(['Down', 'Down', 'Down', 'Down', 'Enter']);
  });

  it('two questions: single-select(idx1) then multi-select(idx0)', () => {
    const questions = [
      q('Lang', ['Python', 'Go', 'Rust'], false),
      q('Features', ['Auth', 'Logging', 'Cache'], true),
    ];
    const { navKeys } = computeCocoPickerKeys(questions, [['Go'], ['Auth']]);
    // Q1 single idx1: Down, Enter (auto-advance)
    // Q2 multi idx0: Space; Next(idx4) from 0: Down x4; Enter
    expect(navKeys).toEqual(['Down', 'Enter', 'Space', 'Down', 'Down', 'Down', 'Down', 'Enter']);
  });

  it('unknown answer key falls back to first option (defensive)', () => {
    const questions = [q('Pick', ['A', 'B'], false)];
    const { navKeys } = computeCocoPickerKeys(questions, [['ZZZ']]);
    expect(navKeys).toEqual(['Enter']);
  });
});
