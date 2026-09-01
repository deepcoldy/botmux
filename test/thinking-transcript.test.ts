/**
 * Thinking (CoT) transcript plumbing — unit tests.
 *
 * Covers the worker-side pieces feeding the native CoT message channel:
 *   1. extractAssistantThinking — thinking-block extraction from transcript
 *      assistant events (joined, text-only events yield '').
 *   2. BridgeTurnQueue.ingest observer — thinking events reach the observer
 *      with the attributed turn; history/unattributed events don't; observer
 *      errors never break attribution.
 */
import { describe, it, expect } from 'bun:test';

import { extractAssistantThinking, extractCotEntries, type TranscriptEvent } from '../src/services/claude-transcript.js';
import { BridgeTurnQueue, type BridgePendingTurn } from '../src/services/bridge-turn-queue.js';

function user(uuid: string, content: string): TranscriptEvent {
  return { type: 'user', uuid, message: { role: 'user', content } };
}
function thinkingEvent(uuid: string, thinking: string): TranscriptEvent {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'thinking', thinking } as any] },
  };
}
function textEvent(uuid: string, text: string): TranscriptEvent {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

describe('extractAssistantThinking', () => {
  it('joins thinking blocks and ignores text blocks', () => {
    const ev: TranscriptEvent = {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'step one' } as any,
          { type: 'text', text: 'visible answer' },
          { type: 'thinking', thinking: 'step two' } as any,
        ],
      },
    };
    expect(extractAssistantThinking(ev)).toBe('step one\n\nstep two');
  });

  it('returns empty for text-only and string-content events', () => {
    expect(extractAssistantThinking(textEvent('a1', 'hi'))).toBe('');
    expect(extractAssistantThinking({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: 'hi' } })).toBe('');
  });
});

describe('extractCotEntries', () => {
  it('extracts thinking and tool_use blocks in content order', () => {
    const ev: TranscriptEvent = {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'need to list files' } as any,
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } } as any,
          { type: 'text', text: 'visible answer' },
        ],
      },
    };
    expect(extractCotEntries(ev)).toEqual([
      { kind: 'thinking', text: 'need to list files' },
      { kind: 'tool_call', id: 'toolu_1', name: 'Bash', args: '{"command":"ls"}' },
    ]);
  });

  it('extracts tool_result blocks from user events, flattening text-block content', () => {
    const ev: TranscriptEvent = {
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'file-a' }, { type: 'text', text: 'file-b' }] } as any,
        ],
      },
    };
    expect(extractCotEntries(ev)).toEqual([
      { kind: 'tool_result', id: 'toolu_1', result: 'file-a\nfile-b' },
    ]);
  });

  it('truncates oversized tool args and results', () => {
    const bigInput = { data: 'x'.repeat(2000) };
    const ev: TranscriptEvent = {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Write', input: bigInput } as any,
          { type: 'tool_result', tool_use_id: 'toolu_0', content: 'y'.repeat(2000) } as any,
        ],
      },
    };
    const [call, result] = extractCotEntries(ev) as any[];
    expect(call.args.length).toBeLessThanOrEqual(601);
    expect(call.args.endsWith('…')).toBe(true);
    expect(result.result.length).toBeLessThanOrEqual(801);
    expect(result.result.endsWith('…')).toBe(true);
  });

  it('returns [] for plain text events', () => {
    expect(extractCotEntries(textEvent('a1', 'hi'))).toEqual([]);
  });
});

describe('BridgeTurnQueue ingest observer', () => {
  it('reports thinking events attributed to the started Lark turn', () => {
    const q = new BridgeTurnQueue();
    const seen: Array<{ uuid?: string; turnId: string; isLocal?: boolean }> = [];
    const observer = (ev: TranscriptEvent, turn: BridgePendingTurn) =>
      seen.push({ uuid: ev.uuid, turnId: turn.turnId, isLocal: turn.isLocal });
    q.mark('t1', 'hello cot');
    q.ingest([user('u1', 'hello cot world'), thinkingEvent('th1', 'pondering'), textEvent('a1', 'answer')], undefined, observer);
    expect(seen.map(s => s.uuid)).toEqual(['th1', 'a1']);
    expect(seen.every(s => s.turnId === 't1' && !s.isLocal)).toBe(true);
  });

  it('reports pure-tool_result user events to the observer without starting a turn', () => {
    const q = new BridgeTurnQueue();
    const seen: string[] = [];
    const toolResult: TranscriptEvent = {
      type: 'user',
      uuid: 'tr1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' } as any] },
    };
    q.mark('t1', 'hello');
    q.ingest([user('u1', 'hello'), thinkingEvent('th1', 'hmm'), toolResult, textEvent('a1', 'answer')], undefined, (ev) => seen.push(ev.uuid!));
    expect(seen).toEqual(['th1', 'tr1', 'a1']);
    // The tool_result did not start/steal a turn: t1 is still collecting and settles normally.
    q.ingest([{ type: 'system', subtype: 'turn_duration', uuid: 's1' } as any]);
    const ready = q.drainEmittable();
    expect(ready.length).toBe(1);
    expect(ready[0].turnId).toBe('t1');
    expect(ready[0].assistantUuids).toEqual(['a1']);
  });

  it('does not report tool_result events when no turn is collecting', () => {
    const q = new BridgeTurnQueue();
    const seen: string[] = [];
    const toolResult: TranscriptEvent = {
      type: 'user',
      uuid: 'tr1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' } as any] },
    };
    q.ingest([toolResult], undefined, (ev) => seen.push(ev.uuid!));
    expect(seen).toEqual([]);
  });

  it('does not report historical (absorbed) events and survives observer throws', () => {
    const q = new BridgeTurnQueue();
    q.absorb([thinkingEvent('old', 'stale')]);
    q.mark('t1', 'hello');
    const seen: string[] = [];
    q.ingest([thinkingEvent('old', 'stale'), user('u1', 'hello'), thinkingEvent('th1', 'live')], undefined, (ev) => {
      seen.push(ev.uuid!);
      throw new Error('observer boom');
    });
    expect(seen).toEqual(['th1']);
    // Attribution unharmed by the throwing observer: turn started and closes normally.
    q.ingest([textEvent('a1', 'answer'), { type: 'system', subtype: 'turn_duration', uuid: 's1' } as any]);
    const ready = q.drainEmittable();
    expect(ready.length).toBe(1);
    expect(ready[0].assistantUuids).toEqual(['a1']);
  });
});
