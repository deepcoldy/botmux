import { describe, it, expect } from 'vitest';
import {
  ProgramStatusFramingStream,
  parseProgramStatusPayload,
  decodeProgramStatusMsg,
} from '../src/utils/program-status-parser.js';

describe('decodeProgramStatusMsg', () => {
  it('decodes valid base64 UTF-8 text', () => {
    // "Hello World" in base64: "SGVsbG8gV29ybGQ="
    expect(decodeProgramStatusMsg('SGVsbG8gV29ybGQ=')).toBe('Hello World');
    // "Apply 3 to add" in base64: "QXBwbHkgMyB0byBhZGQ="
    expect(decodeProgramStatusMsg('QXBwbHkgMyB0byBhZGQ=')).toBe('Apply 3 to add');
  });

  it('safely returns undefined for invalid base64 or control chars', () => {
    expect(decodeProgramStatusMsg('')).toBeUndefined();
    expect(decodeProgramStatusMsg('!!!not-base64???')).toBeUndefined();
    // Base64 containing null byte: "AA==" -> "\x00"
    expect(decodeProgramStatusMsg('AA==')).toBeUndefined();
    // Base64 containing escape byte: "Gw==" -> "\x1b"
    expect(decodeProgramStatusMsg('Gw==')).toBeUndefined();
  });
});

describe('parseProgramStatusPayload', () => {
  it('parses valid status event with all fields', () => {
    const payload = 'state=blocked:kind=permission:app=claude-code:id=subtask-1:progress=42:msg=QXBwbHkgMyB0byBhZGQ=';
    const event = parseProgramStatusPayload(payload);
    expect(event).toEqual({
      state: 'blocked',
      kind: 'permission',
      app: 'claude-code',
      id: 'subtask-1',
      progress: 42,
      msg: 'Apply 3 to add',
    });
  });

  it('returns null if state is missing or invalid', () => {
    expect(parseProgramStatusPayload('app=claude-code')).toBeNull();
    expect(parseProgramStatusPayload('state=unknown_state')).toBeNull();
  });

  it('safely omits invalid msg without failing entire event', () => {
    const payload = 'state=working:msg=invalid!!base64';
    const event = parseProgramStatusPayload(payload);
    expect(event).toEqual({
      state: 'working',
    });
  });
});

describe('ProgramStatusFramingStream', () => {
  it('passes regular text through as data', () => {
    const stream = new ProgramStatusFramingStream();
    const parts = stream.feed('hello world\nthis is plain text');
    expect(parts).toEqual([
      { type: 'data', text: 'hello world\nthis is plain text' },
    ]);
  });

  it('preserves non-7501 OSC sequences intact (OSC 0, 8, 52, 777, 1989)', () => {
    const stream = new ProgramStatusFramingStream();
    const input =
      'start ' +
      '\x1b]0;window title\x07' +
      '\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\' +
      '\x1b]777;notify;title;body\x07' +
      '\x1b]1989;raw;1\x1b\\' +
      ' end';
    const parts = stream.feed(input);
    expect(parts).toEqual([
      { type: 'data', text: input },
    ]);
  });

  it('extracts probe sequence with ST and BEL terminators', () => {
    const stream = new ProgramStatusFramingStream();
    expect(stream.feed('\x1b]7501;?\x1b\\')).toEqual([{ type: 'probe' }]);
    expect(stream.feed('\x1b]7501;?\x07')).toEqual([{ type: 'probe' }]);
  });

  it('extracts status sequence and separates adjacent data', () => {
    const stream = new ProgramStatusFramingStream();
    const parts = stream.feed('prefix\x1b]7501;state=working:app=claude-code\x1b\\suffix');
    expect(parts).toEqual([
      { type: 'data', text: 'prefix' },
      { type: 'status', event: { state: 'working', app: 'claude-code' } },
      { type: 'data', text: 'suffix' },
    ]);
  });

  it('handles probe split across chunks', () => {
    const stream = new ProgramStatusFramingStream();
    const chunk1 = stream.feed('some output \x1b]75');
    expect(chunk1).toEqual([{ type: 'data', text: 'some output ' }]);

    const chunk2 = stream.feed('01;?\x1b\\ trailing');
    expect(chunk2).toEqual([
      { type: 'probe' },
      { type: 'data', text: ' trailing' },
    ]);
  });

  it('handles terminator split across chunks (\\x1b in chunk 1, \\ in chunk 2)', () => {
    const stream = new ProgramStatusFramingStream();
    const chunk1 = stream.feed('\x1b]7501;state=done\x1b');
    expect(chunk1).toEqual([]);

    const chunk2 = stream.feed('\\after');
    expect(chunk2).toEqual([
      { type: 'status', event: { state: 'done' } },
      { type: 'data', text: 'after' },
    ]);
  });

  it('handles chunk ending with ESC byte that turns out to be non-OSC', () => {
    const stream = new ProgramStatusFramingStream();
    const chunk1 = stream.feed('color \x1b');
    expect(chunk1).toEqual([{ type: 'data', text: 'color ' }]);

    // Next chunk is CSI, not OSC:
    const chunk2 = stream.feed('[31mred\x1b[0m');
    expect(chunk2).toEqual([{ type: 'data', text: '\x1b[31mred\x1b[0m' }]);
  });

  it('handles chunk ending with ESC ] 7 that turns out to be OSC 777', () => {
    const stream = new ProgramStatusFramingStream();
    const chunk1 = stream.feed('test \x1b]7');
    expect(chunk1).toEqual([{ type: 'data', text: 'test ' }]);

    const chunk2 = stream.feed('77;notify\x07');
    expect(chunk2).toEqual([{ type: 'data', text: '\x1b]777;notify\x07' }]);
  });

  it('drops buffer and warns when buffer limit is exceeded without terminator', () => {
    const stream = new ProgramStatusFramingStream({ maxBufferSize: 20 });
    // \x1b]7501; is 7 chars. Add 25 chars without terminator.
    const chunk1 = stream.feed('\x1b]7501;' + 'A'.repeat(25));
    // Should drop the buffer
    expect(stream.flush()).toEqual([]);
  });

  it('flush emits remaining buffered text if non-7501', () => {
    const stream = new ProgramStatusFramingStream();
    stream.feed('ending with \x1b');
    expect(stream.flush()).toEqual([{ type: 'data', text: '\x1b' }]);
  });

  it('does not swallow subsequent escape sequences when 7501 is unterminated', () => {
    const stream = new ProgramStatusFramingStream();
    const parts = stream.feed('\x1b]7501;state=working\x1b]0;title\x07');
    expect(parts).toEqual([
      { type: 'data', text: '\x1b]7501;state=working\x1b]0;title\x07' },
    ]);
  });

  it('does not swallow subsequent OSC 8 hyperlink when 7501 is unterminated', () => {
    const stream = new ProgramStatusFramingStream();
    const parts = stream.feed('\x1b]7501;state=working\x1b]8;;http://x\x1b\\link');
    expect(parts).toEqual([
      { type: 'data', text: '\x1b]7501;state=working\x1b]8;;http://x\x1b\\link' },
    ]);
  });
});
