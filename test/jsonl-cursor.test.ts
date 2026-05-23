import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { baselineJsonlCursor } from '../src/services/jsonl-cursor.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bmx-jsonl-cursor-'));
  path = join(dir, 'events.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('baselineJsonlCursor', () => {
  it('returns zero cursor for a missing file', () => {
    expect(baselineJsonlCursor(path)).toEqual({ newOffset: 0, pendingTail: '' });
  });

  it('jumps to the end of complete JSONL history without parsing it', () => {
    appendFileSync(path, '{"uuid":"a"}\n{"uuid":"b"}\n', 'utf8');
    const cursor = baselineJsonlCursor(path);
    expect(cursor.pendingTail).toBe('');
    expect(cursor.newOffset).toBe(Buffer.byteLength('{"uuid":"a"}\n{"uuid":"b"}\n'));
  });

  it('keeps a short trailing partial line for the next incremental drain', () => {
    appendFileSync(path, '{"uuid":"a"}\n{"uuid":"partial"', 'utf8');
    const cursor = baselineJsonlCursor(path);
    expect(cursor.newOffset).toBe(Buffer.byteLength('{"uuid":"a"}\n'));
    expect(cursor.pendingTail).toBe('{"uuid":"partial"');
  });

  it('does not allocate the full file when only the tail is needed', () => {
    const largeHistory = `${'x'.repeat(128 * 1024)}\n`;
    writeFileSync(path, largeHistory, 'utf8');
    appendFileSync(path, '{"uuid":"tail"}', 'utf8');
    const cursor = baselineJsonlCursor(path);
    expect(cursor.newOffset).toBe(Buffer.byteLength(largeHistory));
    expect(cursor.pendingTail).toBe('{"uuid":"tail"}');
  });
});
