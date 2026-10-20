import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  CodexAppCotCollector,
  normalizeCodexAppCotMarker,
  prepareCodexAppCotMarker,
} from '../src/services/codex-app-cot.js';
import {
  CODEX_APP_CONTROL_COT_PAYLOAD_MAX_BYTES,
  CodexAppControlLineDecoder,
  encodeCodexAppSignedControlMarker,
} from '../src/utils/codex-app-control.js';

describe('CodexAppCotCollector', () => {
  it('publishes public reasoning summaries but ignores raw reasoning deltas', () => {
    const collector = new CodexAppCotCollector();
    expect(collector.observe('item/reasoning/textDelta', { itemId: 'r1', delta: 'hidden chain' })).toEqual([]);
    expect(collector.observe('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: '检查工程结构' })).toEqual([]);
    expect(collector.observe('item/completed', { item: { id: 'r1', type: 'reasoning' } })).toEqual([
      { kind: 'thinking', text: '检查工程结构' },
    ]);
  });

  it('streams complete public-summary sentences and emits only the remainder on completion', () => {
    const collector = new CodexAppCotCollector();
    expect(collector.observe('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: '先检查工程' })).toEqual([]);
    expect(collector.observe('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: '结构。接下来读取入口' })).toEqual([
      { kind: 'thinking', text: '先检查工程结构。' },
    ]);
    expect(collector.observe('item/completed', {
      item: { id: 'r1', type: 'reasoning', summary: ['先检查工程结构。接下来读取入口文件'] },
    })).toEqual([{ kind: 'thinking', text: '接下来读取入口文件' }]);
  });

  it('streams commentary only after its public phase is known', () => {
    const collector = new CodexAppCotCollector();
    collector.observe('item/started', { item: { id: 'm1', type: 'agentMessage', phase: 'commentary', text: '' } });
    expect(collector.observe('item/agentMessage/delta', { itemId: 'm1', delta: '正在读取。后续' })).toEqual([
      { kind: 'thinking', text: '正在读取。' },
    ]);
    expect(collector.observe('item/completed', {
      item: { id: 'm1', type: 'agentMessage', phase: 'commentary', text: '正在读取。后续处理' },
    })).toEqual([{ kind: 'thinking', text: '后续处理' }]);
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
      item: { id: 'c1', type: 'commandExecution', status: 'completed', exitCode: 0, durationMs: 1_240, aggregatedOutput: 'README.md\nsrc/index.ts' },
    })).toEqual([{ kind: 'tool_result', id: 'c1', result: '✓ 1.2s\nREADME.md\nsrc/index.ts' }]);
  });

  it('renders file changes as a write operation with a concise path subject', () => {
    const collector = new CodexAppCotCollector();
    expect(collector.observe('item/started', {
      item: { id: 'p1', type: 'fileChange', changes: [{ path: 'src/main.ts', diff: 'large diff' }] },
    })).toEqual([{ kind: 'tool_call', id: 'p1', name: 'apply_patch', args: '{"path":"src/main.ts"}' }]);
    expect(collector.observe('item/completed', {
      item: { id: 'p1', type: 'fileChange', status: 'failed' },
    })).toEqual([{ kind: 'tool_result', id: 'p1', result: '✗' }]);
  });

  it('bounds the complete tool result after adding its status prefix', () => {
    const collector = new CodexAppCotCollector();
    const [entry] = collector.observe('item/completed', {
      item: {
        id: 'c1',
        type: 'commandExecution',
        status: 'completed',
        exitCode: 0,
        durationMs: 1_240,
        aggregatedOutput: 'x'.repeat(1_200),
      },
    });

    expect(entry).toMatchObject({ kind: 'tool_result', id: 'c1' });
    if (entry.kind !== 'tool_result') throw new Error('expected tool_result');
    expect(Buffer.byteLength(entry.result, 'utf8')).toBe(1_200);
    expect(entry.result).toMatch(/\u2026$/);
    expect(normalizeCodexAppCotMarker({ turnId: 'om_1', entries: [entry] })).toEqual({
      turnId: 'om_1',
      entries: [entry],
    });
  });

  it('keeps long CJK thinking inside the signed control-line byte limit', () => {
    const collector = new CodexAppCotCollector();
    const entries = collector.observe('item/completed', {
      item: { id: 'r1', type: 'reasoning', summary: ['思'.repeat(2_000)] },
    });
    const payload = { turnId: 'om_1', entries };
    expect(normalizeCodexAppCotMarker(payload)).toEqual(payload);

    const { privateKey } = generateKeyPairSync('ed25519');
    const line = encodeCodexAppSignedControlMarker(
      privateKey,
      '00000000-0000-4000-8000-000000000000',
      'g'.repeat(43),
      'c'.repeat(43),
      1,
      'thinking',
      payload,
    );
    const decoded = new CodexAppControlLineDecoder().push(Buffer.from(`${line}\n`));
    expect(decoded).toEqual({ lines: [line], droppedMalformed: false });
  });

  it.each([
    ['quotes', '"'.repeat(2_000)],
    ['backslashes', '\\'.repeat(2_000)],
    ['mixed escaped text', `${'思"\\'.repeat(600)}${'x'.repeat(200)}`],
  ])('fits long %s using the serialized JSON payload budget', (_label, text) => {
    const collector = new CodexAppCotCollector();
    const entries = collector.observe('item/completed', {
      item: { id: 'r1', type: 'reasoning', summary: [text] },
    });
    const marker = prepareCodexAppCotMarker(`om_${'x'.repeat(32)}`, entries);
    expect(marker).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(marker), 'utf8'))
      .toBeLessThanOrEqual(CODEX_APP_CONTROL_COT_PAYLOAD_MAX_BYTES);
    expect(normalizeCodexAppCotMarker(marker)).toEqual(marker);

    const { privateKey } = generateKeyPairSync('ed25519');
    const line = encodeCodexAppSignedControlMarker(
      privateKey,
      '00000000-0000-4000-8000-000000000000',
      'g'.repeat(43),
      'c'.repeat(43),
      1,
      'thinking',
      marker!,
    );
    expect(new CodexAppControlLineDecoder().push(Buffer.from(`${line}\n`)))
      .toEqual({ lines: [line], droppedMalformed: false });
  });

  it('bounds UTF-8 MCP tool names and arguments before validation', () => {
    const collector = new CodexAppCotCollector();
    const entries = collector.observe('item/started', {
      item: {
        id: 'm1',
        type: 'mcpToolCall',
        server: '服'.repeat(100),
        tool: '工具'.repeat(100),
        arguments: { query: '查'.repeat(600) },
      },
    });
    expect(normalizeCodexAppCotMarker({ turnId: 'om_1', entries })).toEqual({ turnId: 'om_1', entries });
    expect(Buffer.byteLength(entries[0]?.kind === 'tool_call' ? entries[0].name : '', 'utf8')).toBeLessThanOrEqual(120);
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
