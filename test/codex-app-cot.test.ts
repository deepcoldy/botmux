import { describe, expect, it } from 'vitest';
import { CodexAppCotCollector, normalizeCodexAppCotMarker } from '../src/services/codex-app-cot.js';

describe('CodexAppCotCollector', () => {
  it('publishes public reasoning summaries but ignores raw reasoning deltas', () => {
    const collector = new CodexAppCotCollector();
    expect(collector.observe('item/reasoning/textDelta', { itemId: 'r1', delta: 'hidden chain' })).toEqual([]);
    expect(collector.observe('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: '检查工程结构' })).toEqual([]);
    expect(collector.observe('item/completed', { item: { id: 'r1', type: 'reasoning' } })).toEqual([
      { kind: 'thinking', text: '检查工程结构' },
    ]);
  });

  it('maps commentary and tool lifecycle notifications in display order', () => {
    const collector = new CodexAppCotCollector();
    expect(collector.observe('item/completed', {
      item: { id: 'm1', type: 'agentMessage', phase: 'commentary', text: '我先读取入口文件。' },
    })).toEqual([{ kind: 'thinking', text: '我先读取入口文件。' }]);
    expect(collector.observe('item/started', {
      item: { id: 'c1', type: 'commandExecution', command: 'rg --files' },
    })).toEqual([{ kind: 'tool_call', id: 'c1', name: 'shell', args: '{"command":"rg --files"}' }]);
    expect(collector.observe('item/completed', {
      item: { id: 'c1', type: 'commandExecution', aggregatedOutput: 'README.md\nsrc/index.ts' },
    })).toEqual([{ kind: 'tool_result', id: 'c1', result: 'README.md\nsrc/index.ts' }]);
  });

  it('does not turn the final answer into a thinking node', () => {
    const collector = new CodexAppCotCollector();
    expect(collector.observe('item/completed', {
      item: { id: 'm2', type: 'agentMessage', phase: 'final_answer', text: '最终回答' },
    })).toEqual([]);
  });
});

describe('normalizeCodexAppCotMarker', () => {
  it('accepts a bounded signed marker and rejects extra fields', () => {
    expect(normalizeCodexAppCotMarker({
      turnId: 'om_1',
      entries: [{ kind: 'thinking', text: '正在检查' }],
    })).toEqual({ turnId: 'om_1', entries: [{ kind: 'thinking', text: '正在检查' }] });
    expect(normalizeCodexAppCotMarker({
      turnId: 'om_1',
      entries: [{ kind: 'thinking', text: '正在检查', injected: true }],
    })).toBeUndefined();
  });
});
