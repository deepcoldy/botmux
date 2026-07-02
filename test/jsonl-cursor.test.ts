import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { baselineJsonlCursor, scanJsonlFromOffset } from '../src/services/jsonl-cursor.js';

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

  it('keeps trailing partial tail when the tail probe starts mid-UTF8 codepoint', () => {
    const totalBytes = 64 * 1024 + 1;
    const prefix = '你';
    const pendingTail = '{"uuid":"partial"';
    const fillerBytes = totalBytes - Buffer.byteLength(prefix, 'utf8') - 1 - Buffer.byteLength(pendingTail, 'utf8');
    const history = `${prefix}${'a'.repeat(fillerBytes)}\n`;
    writeFileSync(path, history + pendingTail, 'utf8');

    const cursor = baselineJsonlCursor(path);
    expect(cursor).toEqual({
      newOffset: Buffer.byteLength(history, 'utf8'),
      pendingTail,
    });
  });

  it('keeps exact end offset when the tail probe starts mid-UTF8 codepoint and file ends with newline', () => {
    const totalBytes = 64 * 1024 + 1;
    const prefix = '你';
    const fillerBytes = totalBytes - Buffer.byteLength(prefix, 'utf8') - 1;
    const content = `${prefix}${'a'.repeat(fillerBytes)}\n`;
    writeFileSync(path, content, 'utf8');

    const cursor = baselineJsonlCursor(path);
    expect(cursor).toEqual({
      newOffset: Buffer.byteLength(content, 'utf8'),
      pendingTail: '',
    });
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

describe('scanJsonlFromOffset', () => {
  it('preserves UTF-8 multi-byte characters split across chunk boundaries', () => {
    const text = '{"text":"ab你cd"}\n';
    writeFileSync(path, text, 'utf8');

    const lines: Array<{ line: string; lineStart: number }> = [];
    const cursor = scanJsonlFromOffset(path, 0, {
      chunkSize: Buffer.byteLength('ab', 'utf8') + 1,
      onLine: (line, lineStart) => lines.push({ line, lineStart }),
    });

    expect(lines).toEqual([{ line: '{"text":"ab你cd"}', lineStart: 0 }]);
    expect(cursor).toEqual({
      newOffset: Buffer.byteLength(text, 'utf8'),
      pendingTail: '',
    });
  });
});
