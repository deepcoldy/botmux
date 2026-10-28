import { describe, expect, it } from 'vitest';
import {
  cotEntriesFromAssistantMessage,
  cotEntryFromToolCall,
  cotEntryFromToolResult,
  DSH_COT_LIMITS,
  normalizeDshCotMarker,
} from '../src/services/dsh-cot.js';
import { COT_SUBJECT_MAX_CHARS } from '../src/services/cot-subject.js';

const toolCall = { type: 'tool-call', id: 'call_cot_1', name: 'bash', arguments: '{"command":"echo cot-probe"}' };

describe('dsh CoT entries', () => {
  it('preserves block order, joins consecutive text, and leaves tool calls to their own events', () => {
    expect(cotEntriesFromAssistantMessage({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '  先确认命令\n' },
        { type: 'text', text: '先执行' },
        { type: 'text', text: '一下命令。' },
        toolCall,
        { type: 'text', text: '等待输出。' },
        { type: 'reasoning', text: '继续检查' },
      ],
    })).toEqual([
      { kind: 'thinking', text: '先确认命令' },
      { kind: 'text', text: '先执行一下命令。' },
      { kind: 'text', text: '等待输出。' },
      { kind: 'thinking', text: '继续检查' },
    ]);
  });

  it('keeps final-step reasoning but never includes final reply text', () => {
    const text = { type: 'text', text: '最终回复' };
    expect(cotEntriesFromAssistantMessage({ content: [text] })).toEqual([]);
    expect(cotEntriesFromAssistantMessage({
      content: [{ type: 'reasoning', text: '输出已确认' }, text],
    })).toEqual([{ kind: 'thinking', text: '输出已确认' }]);
  });

  it('skips empty and non-text blocks', () => {
    expect(cotEntriesFromAssistantMessage({
      content: [null, { type: 'reasoning', text: ' \n' }, { type: 'text', text: '  ' }, toolCall],
    })).toEqual([]);
    expect(cotEntriesFromAssistantMessage(undefined)).toEqual([]);
    expect(cotEntriesFromAssistantMessage({ content: 'invalid' })).toEqual([]);
  });

  it('extracts a tool subject from string or object arguments', () => {
    const input = { command: 'echo cot-probe' };
    for (const args of [input, JSON.stringify(input)]) {
      expect(cotEntryFromToolCall({ callId: toolCall.id, name: 'bash', arguments: args })).toEqual({
        kind: 'tool_call', id: toolCall.id, name: 'bash', args: JSON.stringify(input), subject: input.command,
      });
    }
    expect(cotEntryFromToolCall({ callId: toolCall.id, arguments: 'raw arguments' })).toEqual({
      kind: 'tool_call', id: toolCall.id, name: 'tool', args: 'raw arguments',
    });
  });

  it.each(['', ' \n\t', undefined, null, 7])('uses an accepted fallback for an empty or invalid tool name: %s', name => {
    const entry = cotEntryFromToolCall({ callId: toolCall.id, name, arguments: '{}' });
    expect(entry).toEqual({ kind: 'tool_call', id: toolCall.id, name: 'tool', args: '{}' });
    expect(normalizeDshCotMarker('dsh', { entries: [entry] })).toEqual([entry]);
  });

  it('extracts the subject before truncating arguments', () => {
    const input = { content: 'x'.repeat(DSH_COT_LIMITS.toolArgsChars + 1), path: '/tmp/probe.txt' };
    expect(cotEntryFromToolCall({ callId: toolCall.id, name: 'write', arguments: JSON.stringify(input) })).toEqual({
      kind: 'tool_call', id: toolCall.id, name: 'write',
      args: `${JSON.stringify(input).slice(0, DSH_COT_LIMITS.toolArgsChars)}…`, subject: input.path,
    });
  });

  it('reads real tool results in order and prefers the source call id', () => {
    expect(cotEntryFromToolResult({
      message: {
        role: 'tool', source: { kind: 'tool', callId: toolCall.id }, toolCallId: 'other-call',
        content: [{ type: 'text', text: 'cot-probe\n' }, { type: 'text', text: 'done' }], isError: false,
      },
    })).toEqual({ kind: 'tool_result', id: toolCall.id, result: 'cot-probe\n\ndone' });
    expect(cotEntryFromToolResult({ message: { toolCallId: toolCall.id, content: [] } })).toEqual({
      kind: 'tool_result', id: toolCall.id, result: '',
    });
  });

  it('reads legacy tool-result blocks alongside plain text blocks', () => {
    expect(cotEntryFromToolResult({
      message: {
        source: { callId: toolCall.id },
        content: [
          { type: 'text', text: 'before' },
          { type: 'tool-result', content: [{ type: 'text', text: 'legacy' }, { type: 'text', text: 'output' }], isError: true },
          { type: 'text', text: 'after' },
        ],
      },
    })).toEqual({ kind: 'tool_result', id: toolCall.id, result: 'before\nlegacy\noutput\nafter' });
  });

  it.each([undefined, '', ' \n', 7])('rejects missing or invalid tool ids: %s', id => {
    expect(cotEntryFromToolCall({ callId: id, name: 'bash', arguments: '{}' })).toBeUndefined();
    expect(cotEntryFromToolResult({ message: { source: { callId: id }, content: [] } })).toBeUndefined();
  });

  it('bounds all display fields and accepts the generated entries without retaining their objects', () => {
    const long = '长'.repeat(Math.max(
      DSH_COT_LIMITS.textChars, DSH_COT_LIMITS.toolArgsChars, DSH_COT_LIMITS.toolResultChars,
      DSH_COT_LIMITS.toolNameChars, COT_SUBJECT_MAX_CHARS,
    ) + 2);
    const input = { command: long };
    const entries = [
      ...cotEntriesFromAssistantMessage({ content: [
        { type: 'reasoning', text: long }, { type: 'text', text: long }, toolCall,
      ] }),
      cotEntryFromToolCall({ callId: toolCall.id, name: long, arguments: input })!,
      cotEntryFromToolResult({ message: { toolCallId: toolCall.id, content: [{ type: 'text', text: long }] } })!,
    ];
    expect(entries).toEqual([
      { kind: 'thinking', text: `${long.slice(0, DSH_COT_LIMITS.textChars)}…` },
      { kind: 'text', text: `${long.slice(0, DSH_COT_LIMITS.textChars)}…` },
      { kind: 'tool_call', id: toolCall.id, name: `${long.slice(0, DSH_COT_LIMITS.toolNameChars)}…`,
        args: `${JSON.stringify(input).slice(0, DSH_COT_LIMITS.toolArgsChars)}…`, subject: `${long.slice(0, COT_SUBJECT_MAX_CHARS)}…` },
      { kind: 'tool_result', id: toolCall.id, result: `${long.slice(0, DSH_COT_LIMITS.toolResultChars)}…` },
    ]);
    const normalized = normalizeDshCotMarker('dsh', { entries });
    expect(normalized).toEqual(entries);
    expect(normalized).not.toBe(entries);
    for (let index = 0; index < entries.length; index++) expect(normalized![index]).not.toBe(entries[index]);
  });
});

describe('normalizeDshCotMarker', () => {
  const thinking = { kind: 'thinking', text: '先确认命令' };
  const call = { kind: 'tool_call', id: toolCall.id, name: 'bash', args: '{}' };
  const result = { kind: 'tool_result', id: toolCall.id, result: 'cot-probe\n' };

  it.each([undefined, 'codex-app', 'claude', 'dsh-tui'])('rejects a non-dsh CLI: %s', cliId => {
    expect(normalizeDshCotMarker(cliId, { entries: [thinking] })).toBeUndefined();
  });

  it.each([
    null, [[]], 'invalid', {}, new Date(),
    Object.create({ entries: [thinking] }),
    { entries: [thinking], turnId: 'injected' },
    { entries: [] }, { entries: 'invalid' },
    { entries: Array.from({ length: DSH_COT_LIMITS.maxEntries + 1 }, () => thinking) },
  ])('rejects malformed envelopes: %j', payload => {
    expect(normalizeDshCotMarker('dsh', payload)).toBeUndefined();
  });

  it.each([
    null, [], { kind: 'unknown', text: 'x' },
    { ...thinking, extra: true }, { ...call, extra: true }, { ...result, extra: true },
    { kind: 'text', text: 'x', subject: 'unexpected' },
    { ...thinking, text: '' }, { kind: 'text', text: ' \n' },
    { ...call, id: '' }, { ...call, name: '' }, { ...result, id: '' },
    { ...thinking, text: 1 }, { kind: 'text', text: null },
    { ...call, id: 1 }, { ...call, name: null }, { ...call, args: {} }, { ...call, subject: [] },
    { ...result, id: null }, { ...result, result: false },
    { ...thinking, text: 'x'.repeat(DSH_COT_LIMITS.textChars + 2) }, { kind: 'text', text: 'x'.repeat(DSH_COT_LIMITS.textChars + 2) },
    { ...call, name: 'x'.repeat(DSH_COT_LIMITS.toolNameChars + 2) }, { ...call, args: 'x'.repeat(DSH_COT_LIMITS.toolArgsChars + 2) },
    { ...call, subject: 'x'.repeat(COT_SUBJECT_MAX_CHARS + 2) }, { ...result, result: 'x'.repeat(DSH_COT_LIMITS.toolResultChars + 2) },
  ].map((entry, index) => ({ entry, index })))('rejects the whole frame for invalid entry $index', ({ entry }) => {
    expect(normalizeDshCotMarker('dsh', { entries: [thinking, entry] })).toBeUndefined();
  });

  it('accepts empty arguments and results and the maximum number of entries', () => {
    const entries = [
      cotEntryFromToolCall({ callId: toolCall.id })!,
      cotEntryFromToolResult({ message: { toolCallId: toolCall.id, content: [] } })!,
    ];
    expect(normalizeDshCotMarker('dsh', { entries })).toEqual([
      { kind: 'tool_call', id: toolCall.id, name: 'tool', args: '' },
      { kind: 'tool_result', id: toolCall.id, result: '' },
    ]);
    expect(normalizeDshCotMarker('dsh', {
      entries: Array.from({ length: DSH_COT_LIMITS.maxEntries }, () => thinking),
    })).toHaveLength(DSH_COT_LIMITS.maxEntries);
  });

  it('limits the serialized payload by UTF-8 bytes', () => {
    const entry = { kind: 'thinking', text: '想'.repeat(DSH_COT_LIMITS.textChars) };
    const entryCount = Math.floor(DSH_COT_LIMITS.payloadBytes / Buffer.byteLength(JSON.stringify(entry), 'utf8')) + 1;
    const entries = Array.from({ length: entryCount }, () => entry);
    const payload = { entries };
    expect(entries.length).toBeLessThanOrEqual(DSH_COT_LIMITS.maxEntries);
    expect(JSON.stringify(payload).length).toBeLessThan(DSH_COT_LIMITS.payloadBytes);
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeGreaterThan(DSH_COT_LIMITS.payloadBytes);
    expect(normalizeDshCotMarker('dsh', payload)).toBeUndefined();
    const smaller = entries.slice(0, -1);
    expect(normalizeDshCotMarker('dsh', { entries: smaller })).toEqual(smaller);
  });
});
