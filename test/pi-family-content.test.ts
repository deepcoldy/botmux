import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { contentHasToolCall, entryTimestampMs, messageContentText } from '../src/services/pi-family-content.js';
import { ompMessageText } from '../src/services/omp-transcript.js';

describe('messageContentText', () => {
  it('trims a bare string and joins text blocks with a newline', () => {
    expect(messageContentText('  hi  ')).toBe('hi');
    expect(messageContentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b ' }])).toBe('a\nb');
  });

  it('ignores non-text blocks, malformed items and non-content values', () => {
    expect(messageContentText([
      null, 'x', { type: 'image', text: 'no' }, { type: 'text', text: 7 }, { type: 'text', text: 'ok' },
      { type: 'toolCall', id: '1' },
    ])).toBe('ok');
    expect(messageContentText(undefined)).toBe('');
    expect(messageContentText({ type: 'text', text: 'obj' })).toBe('');
    expect(messageContentText(42)).toBe('');
  });

  it('is what the OMP bridge exports as ompMessageText', () => {
    for (const content of ['  plain  ', [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], undefined, 42, { type: 'text', text: 'obj' }]) {
      expect(ompMessageText(content)).toBe(messageContentText(content));
    }
  });
});

describe('contentHasToolCall', () => {
  it('detects a toolCall block only inside an array', () => {
    expect(contentHasToolCall([{ type: 'text', text: 'a' }, { type: 'toolCall' }])).toBe(true);
    expect(contentHasToolCall([{ type: 'text', text: 'a' }, null, 'toolCall'])).toBe(false);
    expect(contentHasToolCall('toolCall')).toBe(false);
    expect(contentHasToolCall({ type: 'toolCall' })).toBe(false);
    expect(contentHasToolCall(undefined)).toBe(false);
  });
});

describe('entryTimestampMs', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('prefers the entry ISO string, then the message epoch-ms, then the wall clock', () => {
    expect(entryTimestampMs({ timestamp: '2026-05-01T00:00:00.000Z' }, { timestamp: 5 }))
      .toBe(Date.parse('2026-05-01T00:00:00.000Z'));
    expect(entryTimestampMs({ timestamp: 'not a date' }, { timestamp: 1_700_000_000_000 })).toBe(1_700_000_000_000);
    expect(entryTimestampMs({}, { timestamp: '2026-05-01T00:00:00.000Z' })).toBe(Date.parse('2030-01-01T00:00:00.000Z'));
    expect(entryTimestampMs({ timestamp: 123 }, { timestamp: Number.NaN })).toBe(Date.parse('2030-01-01T00:00:00.000Z'));
    expect(entryTimestampMs({})).toBe(Date.parse('2030-01-01T00:00:00.000Z'));
  });
});
