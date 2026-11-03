import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { drainPiTranscript, resetPiPendingTurnState } from '../src/services/pi-transcript.js';
import type { CotEntry } from '../src/types.js';

const SESSION_ID = 'eef935b5-4201-4e59-8bc7-06f03aa3388c';
const NOW = Date.parse('2026-09-29T04:00:00Z');
let root: string;
let path: string;

function row(message: Record<string, unknown>, time = NOW): object {
  return { type: 'message', timestamp: new Date(time).toISOString(), message };
}
function user(text: string, time = NOW): object {
  return row({ role: 'user', content: [{ type: 'text', text }] }, time);
}
function assistant(content: object[], stopReason = 'toolUse', time = NOW): object {
  return row({ role: 'assistant', content, stopReason }, time);
}
function append(...rows: object[]): void {
  appendFileSync(path, rows.map(value => JSON.stringify(value)).join('\n') + '\n');
}
function entries(): CotEntry[] {
  return drainPiTranscript(path, 0).events.flatMap(event => event.cotEntries ?? []);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-pi-cot-'));
  path = join(root, `2026-09-29T04-00-00Z_${SESSION_ID}.jsonl`);
  writeFileSync(path, '');
  resetPiPendingTurnState();
});
afterEach(() => {
  resetPiPendingTurnState();
  rmSync(root, { recursive: true, force: true });
});

describe('Pi activity through the structured bridge', () => {
  it('pairs tool calls and results in order without closing the active turn', () => {
    append(user('inspect files'), assistant([
      { type: 'thinking', thinking: 'Inspect the repository', thinkingSignature: 'opaque-signature' },
      { type: 'text', text: 'Reading the entry point.' },
      { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/main.ts' } },
    ]), row({ role: 'toolResult', toolCallId: 'read-1', content: [
      { type: 'text', text: 'line one' }, { type: 'image', data: 'base64-image' },
      { type: 'text', text: 'line two' },
    ], details: { secret: 'internal metadata' }, isError: false }));
    const events = drainPiTranscript(path, 0).events;
    expect(events.map(event => event.kind)).toEqual(['user', 'cot', 'cot']);
    expect(events.flatMap(event => event.cotEntries ?? [])).toEqual([
      { kind: 'thinking', text: 'Inspect the repository' },
      { kind: 'text', text: 'Reading the entry point.' },
      { kind: 'tool_call', id: 'read-1', name: 'read', args: '{"path":"src/main.ts"}', subject: 'src/main.ts' },
      { kind: 'tool_result', id: 'read-1', result: 'line one\nline two' },
    ]);
    const q = new CodexBridgeQueue(() => NOW);
    q.mark('om_turn', 'inspect files', NOW);
    q.ingest(events);
    expect(q.hasBlockingTurn()).toBe(true);
    expect(q.drainEmittable()).toEqual([]);
    expect(events.every(event => event.sourceSessionId === SESSION_ID)).toBe(true);
  });

  it('sends final-message thinking before one final, with separate stable dedup keys', () => {
    append(user('hello'), assistant([
      { type: 'thinking', thinking: 'Ready to answer' },
      { type: 'text', text: 'Hello!' },
    ], 'stop'));
    const first = drainPiTranscript(path, 0);
    expect(first.events.map(event => event.kind)).toEqual(['user', 'cot', 'assistant_final']);
    expect(new Set(first.events.map(event => event.uuid)).size).toBe(3);
    expect(first.events[1].cotEntries).toEqual([{ kind: 'thinking', text: 'Ready to answer' }]);
    const q = new CodexBridgeQueue(() => NOW);
    const seen: CotEntry[] = [];
    q.mark('om_turn', 'hello', NOW);
    q.setCotObserver(values => seen.push(...values));
    q.ingest(first.events);
    q.ingest(drainPiTranscript(path, 0).events);
    expect(seen).toHaveLength(1);
    expect(q.drainEmittable()).toMatchObject([{ turnId: 'om_turn', finalText: 'Hello!' }]);
    expect(drainPiTranscript(path, first.newOffset).events).toEqual([]);
  });

  it('extracts a long command/path before truncating arguments and bounds tool results', () => {
    const command = `echo ${'x'.repeat(700)}`;
    append(assistant([
      { type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command } },
      { type: 'toolCall', id: 'write-1', name: 'write', arguments: { content: 'x'.repeat(2000), path: 'src/large.ts' } },
    ]), row({ role: 'toolResult', toolCallId: 'bash-1', content: [{ type: 'text', text: 'x'.repeat(2000) }] }));
    expect(entries()).toMatchObject([
      { kind: 'tool_call', subject: command, args: expect.stringMatching(/…$/) },
      { kind: 'tool_call', subject: 'src/large.ts', args: expect.stringMatching(/…$/) },
      { kind: 'tool_result', result: `${'x'.repeat(800)}…` },
    ]);
    expect(entries().filter(entry => entry.kind === 'tool_call').every(entry => entry.args.length === 601)).toBe(true);
  });

  it('keeps empty/image-only results so the matching tool can finish', () => {
    append(row({ role: 'toolResult', toolCallId: 'image-1', content: [{ type: 'image', data: 'private-bytes' }] }));
    expect(entries()).toEqual([{ kind: 'tool_result', id: 'image-1', result: '' }]);
  });

  it('ignores envelopes, redacted thinking, signatures, malformed blocks and retry errors', () => {
    append(
      user('<botmux_routing>hidden</botmux_routing>'),
      row({ role: 'system', content: [{ type: 'text', text: 'system rules' }] }),
      { type: 'custom', data: { content: 'internal extension state' } },
      row({ role: 'bashExecution', content: [{ type: 'text', text: 'local command' }] }),
      assistant([
        { type: 'thinking', thinking: 'redacted-content', redacted: true },
        { type: 'thinking', thinkingSignature: 'secret-signature' },
        { type: 'text', text: '  \n ' },
        { type: 'toolCall', name: 'bash' },
        { type: 'toolCall', id: 'broken', name: 123 },
        { type: 'image', data: 'private-image' },
      ]),
      assistant([{ type: 'thinking', thinking: 'partial error' }, { type: 'text', text: 'provider error' }], 'error'),
      assistant([{ type: 'text', text: 'interrupted partial' }], 'aborted'),
      row({ role: 'toolResult', content: [{ type: 'text', text: 'orphan' }] }),
    );
    expect(entries()).toEqual([]);
  });

  it('attributes subsequent activity to the steered turn, while ignoring history and unmatched events', () => {
    append(assistant([{ type: 'text', text: 'historical' }]));
    const q = new CodexBridgeQueue(() => NOW);
    const seen: Array<{ turnId: string; entries: readonly CotEntry[] }> = [];
    q.setCotObserver((values, turn) => seen.push({ turnId: turn.turnId, entries: values }));
    const history = drainPiTranscript(path, 0);
    q.absorb(history.events);
    q.mark('om_first', 'first input', NOW);
    q.mark('om_steer', 'steered input', NOW);
    append(
      assistant([{ type: 'text', text: 'unmatched' }]),
      user('first input'), assistant([{ type: 'text', text: 'first activity' }]),
      user('steered input', NOW + 1000), assistant([{ type: 'text', text: 'steered activity' }], 'toolUse', NOW + 1001),
      assistant([{ type: 'text', text: 'final answer' }], 'stop', NOW + 2000),
    );
    q.ingest([...history.events, ...drainPiTranscript(path, history.newOffset).events]);
    expect(seen).toEqual([
      { turnId: 'om_first', entries: [{ kind: 'text', text: 'first activity' }] },
      { turnId: 'om_steer', entries: [{ kind: 'text', text: 'steered activity' }] },
    ]);
    expect(q.drainEmittable()).toMatchObject([{ turnId: 'om_steer', finalText: 'final answer' }]);
  });

  it('waits for a complete UTF-8 JSONL line and delivers activity once across drains', () => {
    append(user('读取文件'));
    const first = drainPiTranscript(path, 0);
    const line = JSON.stringify(assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '中文.ts' } }]));
    const bytes = Buffer.from(line + '\n');
    const split = bytes.indexOf(Buffer.from('中文')) + 1;
    appendFileSync(path, bytes.subarray(0, split));
    const partial = drainPiTranscript(path, first.newOffset);
    expect(partial.events).toEqual([]);
    expect(partial.newOffset).toBe(first.newOffset);
    appendFileSync(path, bytes.subarray(split));
    const completed = drainPiTranscript(path, partial.newOffset);
    expect(completed.events[0].cotEntries).toMatchObject([{ kind: 'tool_call', subject: '中文.ts' }]);
    expect(drainPiTranscript(path, completed.newOffset).events).toEqual([]);
  });
});
