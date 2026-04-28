/**
 * Tests for the JSONL transcript reader used by adopt-bridge mode.
 *
 *   - drainTranscript handles missing files, half-written tail lines,
 *     truncation, and malformed lines without throwing.
 *   - pickAssistantTextEvents filters out user / sidechain / tool-only events.
 *   - extractAssistantText / joinAssistantText concatenate multi-block text.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, openSync, writeSync, closeSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  drainTranscript,
  pickAssistantTextEvents,
  extractAssistantText,
  joinAssistantText,
  type TranscriptEvent,
} from '../src/services/claude-transcript.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bmx-tx-'));
  path = join(dir, 'session.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function appendLine(obj: unknown): void {
  appendFileSync(path, JSON.stringify(obj) + '\n', 'utf8');
}

describe('drainTranscript', () => {
  it('returns empty result when file does not exist', () => {
    const r = drainTranscript('/no/such/file.jsonl', 0);
    expect(r.events).toEqual([]);
    expect(r.newOffset).toBe(0);
  });

  it('reads complete lines, leaves trailing partial line for next drain', () => {
    appendLine({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
    // half line at the end (no \n yet)
    appendFileSync(path, '{"type":"assistant","uuid":"u2"', 'utf8');
    const r = drainTranscript(path, 0);
    expect(r.events.length).toBe(1);
    expect(r.events[0].uuid).toBe('u1');
    expect(r.pendingTail).toContain('"u2"');
    // newOffset must point at end of complete line, not the partial tail
    expect(r.newOffset).toBeLessThan(JSON.stringify({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }).length + 50);
  });

  it('continues from newOffset on subsequent drains', () => {
    appendLine({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'one' } });
    const r1 = drainTranscript(path, 0);
    expect(r1.events.length).toBe(1);
    appendLine({ type: 'assistant', uuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } });
    const r2 = drainTranscript(path, r1.newOffset);
    expect(r2.events.length).toBe(1);
    expect(r2.events[0].uuid).toBe('u2');
  });

  it('skips malformed JSON lines silently', () => {
    appendFileSync(path, 'not-json\n', 'utf8');
    appendLine({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
    const r = drainTranscript(path, 0);
    expect(r.events.length).toBe(1);
    expect(r.events[0].uuid).toBe('u1');
  });

  it('detects shrinkage (size < lastOffset) and re-reads from 0', () => {
    // We don't claim to handle full file rotation (rare in practice — Claude
    // Code keeps one JSONL per session and never truncates), but we DO need
    // to recover when the file's current size is smaller than the offset we
    // held — otherwise the next drain would read garbage from a stale offset.
    appendLine({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'this-is-quite-a-long-payload-here-for-bytes' }] } });
    const r1 = drainTranscript(path, 0);
    const fd = openSync(path, 'r+');
    try { ftruncateSync(fd, 0); } finally { closeSync(fd); }
    appendLine({ type: 'assistant', uuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'short' }] } });
    const r2 = drainTranscript(path, r1.newOffset);
    expect(r2.events.find(e => e.uuid === 'u2')).toBeDefined();
  });
});

describe('pickAssistantTextEvents', () => {
  it('keeps assistant text events with uuid', () => {
    const events: TranscriptEvent[] = [
      { type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ];
    expect(pickAssistantTextEvents(events).map(e => e.uuid)).toEqual(['a']);
  });

  it('drops user events', () => {
    const events: TranscriptEvent[] = [
      { type: 'user', uuid: 'u', message: { role: 'user', content: 'hi' } },
    ];
    expect(pickAssistantTextEvents(events)).toEqual([]);
  });

  it('drops sidechain (sub-agent) events', () => {
    const events: TranscriptEvent[] = [
      { type: 'assistant', uuid: 's', message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] }, ...({ isSidechain: true } as any) },
    ];
    expect(pickAssistantTextEvents(events)).toEqual([]);
  });

  it('drops tool_use-only events (no text block)', () => {
    const events: TranscriptEvent[] = [
      { type: 'assistant', uuid: 't', message: { role: 'assistant', content: [{ type: 'tool_use', text: undefined } as any] } },
    ];
    expect(pickAssistantTextEvents(events)).toEqual([]);
  });

  it('drops events without uuid', () => {
    const events: TranscriptEvent[] = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'no-uuid' }] } },
    ];
    expect(pickAssistantTextEvents(events)).toEqual([]);
  });
});

describe('extractAssistantText / joinAssistantText', () => {
  it('joins multiple text blocks of one event with blank lines', () => {
    const ev: TranscriptEvent = {
      type: 'assistant',
      uuid: 'a',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'part-one' },
          { type: 'tool_use' } as any,
          { type: 'text', text: 'part-two' },
        ],
      },
    };
    expect(extractAssistantText(ev)).toBe('part-one\n\npart-two');
  });

  it('handles bare-string content (legacy schema)', () => {
    const ev: TranscriptEvent = {
      type: 'assistant',
      uuid: 'a',
      message: { role: 'assistant', content: 'hi-from-old-schema' as any },
    };
    expect(extractAssistantText(ev)).toBe('hi-from-old-schema');
  });

  it('joinAssistantText filters then concatenates multiple events', () => {
    const events: TranscriptEvent[] = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'q' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
    ];
    expect(joinAssistantText(events)).toBe('first\n\nsecond');
  });

  it('returns empty string for empty input', () => {
    expect(joinAssistantText([])).toBe('');
  });
});
