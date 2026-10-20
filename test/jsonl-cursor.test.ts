import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  baselineJsonlCursor,
  beginJsonlDrain,
  iterateJsonlLines,
  readJsonlWindow,
  scanJsonlBackward,
  scanJsonlFromOffset,
} from '../src/services/jsonl-cursor.js';

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

  it('keeps durable byte offsets correct when starting inside a UTF-8 codepoint', () => {
    const prefix = '中';
    const firstLine = 'broken-prefix\n';
    const appendedLine = '{"type":"event_msg"}\n';
    const text = prefix + firstLine + appendedLine;
    writeFileSync(path, text, 'utf8');

    const lines: Array<{ line: string; lineStart: number }> = [];
    const cursor = scanJsonlFromOffset(path, 1, {
      chunkSize: 2,
      onLine: (line, lineStart) => lines.push({ line, lineStart }),
    });

    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({
      line: '{"type":"event_msg"}',
      lineStart: Buffer.byteLength(prefix + firstLine, 'utf8'),
    });
    expect(cursor).toEqual({
      newOffset: Buffer.byteLength(text, 'utf8'),
      pendingTail: '',
    });

    const nextLine = '{"type":"token_count"}\n';
    appendFileSync(path, nextLine, 'utf8');
    const followUpLines: Array<{ line: string; lineStart: number }> = [];
    const followUpCursor = scanJsonlFromOffset(path, cursor!.newOffset, {
      chunkSize: 3,
      onLine: (line, lineStart) => followUpLines.push({ line, lineStart }),
    });

    expect(followUpLines).toEqual([{
      line: '{"type":"token_count"}',
      lineStart: Buffer.byteLength(text, 'utf8'),
    }]);
    expect(followUpCursor).toEqual({
      newOffset: Buffer.byteLength(text + nextLine, 'utf8'),
      pendingTail: '',
    });
  });

  it('does not repeatedly concatenate an accumulated long line on every chunk', () => {
    const longLine = 'x'.repeat(256 * 1024);
    const secondLine = '{"type":"complete"}';
    const text = `${longLine}\n${secondLine}\n`;
    writeFileSync(path, text, 'utf8');

    const concatSpy = vi.spyOn(Buffer, 'concat');
    try {
      const lines: Array<{ line: string; lineStart: number }> = [];
      const cursor = scanJsonlFromOffset(path, 0, {
        chunkSize: 1024,
        onLine: (line, lineStart) => lines.push({ line, lineStart }),
      });

      expect(lines).toEqual([
        { line: longLine, lineStart: 0 },
        { line: secondLine, lineStart: Buffer.byteLength(`${longLine}\n`, 'utf8') },
      ]);
      expect(cursor).toEqual({
        newOffset: Buffer.byteLength(text, 'utf8'),
        pendingTail: '',
      });
      expect(concatSpy.mock.calls.length).toBeLessThanOrEqual(1);

      concatSpy.mockClear();
      const appended = '{"type":"next"}\n';
      appendFileSync(path, appended, 'utf8');
      const followUpLines: Array<{ line: string; lineStart: number }> = [];
      const followUpCursor = scanJsonlFromOffset(path, cursor!.newOffset, {
        chunkSize: 3,
        onLine: (line, lineStart) => followUpLines.push({ line, lineStart }),
      });
      expect(followUpLines).toEqual([{
        line: '{"type":"next"}',
        lineStart: Buffer.byteLength(text, 'utf8'),
      }]);
      expect(followUpCursor).toEqual({
        newOffset: Buffer.byteLength(text + appended, 'utf8'),
        pendingTail: '',
      });
      expect(concatSpy.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      concatSpy.mockRestore();
    }
  });
});

describe('readJsonlWindow / beginJsonlDrain / iterateJsonlLines', () => {
  it('cuts the window at the last newline and counts offsets in UTF-8 bytes', () => {
    const body = '{"t":"你好"}\n\n{"t":"b"}\n{"t":"par';
    writeFileSync(path, body, 'utf8');
    const window = readJsonlWindow(path, 0, Buffer.byteLength(body, 'utf8'));
    expect(window.completeText).toBe('{"t":"你好"}\n\n{"t":"b"}\n');
    expect(window.pendingTail).toBe('{"t":"par');
    expect(window.newOffset).toBe(Buffer.byteLength(window.completeText, 'utf8'));

    const whole = Buffer.from(body, 'utf8');
    for (const { line, lineStart, lineEnd } of iterateJsonlLines(window.completeText, 0)) {
      expect(whole.subarray(lineStart, lineEnd).toString('utf8')).toBe(`${line}\n`);
    }
    expect([...iterateJsonlLines(window.completeText, 0)].map(l => l.line)).toEqual(['{"t":"你好"}', '{"t":"b"}']);
  });

  it('keeps a window without any newline entirely pending', () => {
    writeFileSync(path, '{"partial"', 'utf8');
    expect(readJsonlWindow(path, 0, 10)).toEqual({
      start: 0, size: 10, completeText: '', pendingTail: '{"partial"', newOffset: 0,
    });
  });

  it('returns an empty window when nothing is past start', () => {
    writeFileSync(path, 'abc\n', 'utf8');
    expect(readJsonlWindow(path, 4, 4)).toEqual({ start: 4, size: 4, completeText: '', pendingTail: '', newOffset: 4 });
  });

  it('does not leak zero-filled bytes when the file shrank between stat and read', () => {
    writeFileSync(path, 'abc\ndef', 'utf8');
    const window = readJsonlWindow(path, 0, 64); // stat said 64 bytes, only 8 exist
    expect(window.completeText).toBe('abc\n');
    expect(window.pendingTail).toBe('def');
  });

  it('maps missing / unreadable / shrunk / idle / read to steps', () => {
    expect(beginJsonlDrain(path, 7)).toEqual({ kind: 'skip', reason: 'missing', newOffset: 0 });
    expect(beginJsonlDrain(path, 7, { missingOffset: 'keep' })).toEqual({ kind: 'skip', reason: 'missing', newOffset: 7 });

    writeFileSync(path, 'a\nb\n', 'utf8');
    // shrink: reset re-reads from zero, hold keeps the consumed offset
    const reset = beginJsonlDrain(path, 100);
    expect(reset).toMatchObject({ kind: 'read', start: 0, reset: true });
    expect(beginJsonlDrain(path, 100, { onShrink: 'hold' })).toEqual({ kind: 'skip', reason: 'shrunk', newOffset: 100 });

    const idle = beginJsonlDrain(path, 4);
    expect(idle).toMatchObject({ kind: 'idle', start: 4, reset: false, newOffset: 4 });
    expect(idle.kind === 'idle' && idle.window.completeText).toBe('');

    const read = beginJsonlDrain(path, 2);
    expect(read).toMatchObject({ kind: 'read', start: 2, reset: false });
    expect(read.kind === 'read' && read.window).toMatchObject({ completeText: 'b\n', pendingTail: '', newOffset: 4 });
  });
});

describe('scanJsonlBackward', () => {
  /** Independent oracle: slice the byte range, drop ONE trailing newline,
   *  split, skip empties, optionally drop the leading fragment at a non-zero
   *  floor. Returns newest-first [text, absoluteStart]. */
  function oracle(content: Buffer, endOffset: number, floor: number, dropPartial: boolean): Array<[string, number]> {
    const window = content.subarray(floor, endOffset);
    const body = window.length > 0 && window[window.length - 1] === 0x0a ? window.subarray(0, window.length - 1) : window;
    const lines: Array<[string, number]> = [];
    let from = 0;
    for (let i = 0; i <= body.length; i++) {
      if (i === body.length || body[i] === 0x0a) {
        lines.push([body.subarray(from, i).toString('utf8'), floor + from]);
        from = i + 1;
      }
    }
    if (dropPartial && floor > 0) lines.shift();
    return lines.filter(([text]) => text.length > 0).reverse();
  }

  function scan(opts: { endOffset: number; floor?: number; chunkBytes?: number; dropPartialAtFloor?: boolean }) {
    const seen: Array<[string, number]> = [];
    const stopped = scanJsonlBackward(path, {
      ...opts,
      onLine: (line, lineStart) => { seen.push([line.toString('utf8'), lineStart]); },
    });
    return { seen, stopped };
  }

  it('matches the oracle across chunk sizes, floors and multibyte / blank lines', () => {
    const content = Buffer.from(
      '{"a":1}\n\n{"b":"你好世界"}\n{"c":"x"}\n\n\n{"d":"終わり"}\n{"e":5}\n',
      'utf8',
    );
    writeFileSync(path, content);
    // line-boundary end offsets only: the contract requires endOffset on a '\n'
    const ends = [content.length];
    for (let i = 0; i < content.length; i++) if (content[i] === 0x0a) ends.push(i + 1);
    for (const endOffset of ends) {
      for (const floor of [0, 1, 5, 9, 20]) {
        if (floor > endOffset) continue;
        for (const chunkBytes of [1, 2, 3, 7, 16, 64 * 1024]) {
          for (const dropPartialAtFloor of [false, true]) {
            const { seen, stopped } = scan({ endOffset, floor, chunkBytes, dropPartialAtFloor });
            expect(stopped).toBe(false);
            expect(seen).toEqual(oracle(content, endOffset, floor, dropPartialAtFloor));
          }
        }
      }
    }
  });

  it('reports the first record at floor 0 even with dropPartialAtFloor', () => {
    const body = '{"first":1}\n{"second":2}\n';
    writeFileSync(path, body, 'utf8');
    const { seen } = scan({ endOffset: Buffer.byteLength(body), dropPartialAtFloor: true });
    expect(seen.map(([text]) => text)).toEqual(['{"second":2}', '{"first":1}']);
  });

  it('drops the leading fragment only when dropPartialAtFloor is set and floor > 0', () => {
    const body = 'XXXX-cut-off\n{"whole":1}\n';
    writeFileSync(path, body, 'utf8');
    const end = Buffer.byteLength(body);
    const floor = 4; // inside the first line
    expect(scan({ endOffset: end, floor, dropPartialAtFloor: true }).seen.map(([t]) => t)).toEqual(['{"whole":1}']);
    expect(scan({ endOffset: end, floor }).seen).toEqual([
      ['{"whole":1}', 13],
      ['-cut-off', floor],
    ]);
  });

  it('stops as soon as onLine returns true and closes the fd', () => {
    writeFileSync(path, 'a\nb\nc\n', 'utf8');
    const seen: string[] = [];
    const stopped = scanJsonlBackward(path, {
      endOffset: 6,
      chunkBytes: 2,
      onLine: (line) => { seen.push(line.toString()); return seen.length === 2; },
    });
    expect(stopped).toBe(true);
    expect(seen).toEqual(['c', 'b']);
  });

  it('lets fs errors propagate so callers keep their own catch semantics', () => {
    expect(() => scanJsonlBackward(join(dir, 'missing.jsonl'), { endOffset: 10, onLine: () => false })).toThrow();
  });
});
