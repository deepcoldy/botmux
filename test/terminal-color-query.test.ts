import { describe, expect, it } from 'vitest';
import { isTerminalColorQueryOnly } from '../src/core/terminal-color-query.js';

describe('non-rendering terminal color query batches', () => {
  for (const start of ['\x1b]', '\x9d']) {
    for (const end of ['\x07', '\x1b\\', '\x9c']) {
      for (const code of [10, 11, 12]) {
        it(`recognizes OSC ${code} with ${JSON.stringify([start, end])}`, () => {
          expect(isTerminalColorQueryOnly(`${start}${code};?${end}`)).toBe(true);
        });
      }
    }
  }

  it('accepts coalesced queries without dropping their bytes', () => {
    expect(isTerminalColorQueryOnly('\x1b]10;?\x07\x1b]11;?\x1b\\\x9d12;?\x9c')).toBe(true);
  });

  for (const data of [
    '', ' ', '\r', '\n', '\x1b[2J', '\x1b[1;1H', '\x1b]11;rgb:ffff/ffff/ffff\x07',
    '\x1b]0;title\x07', '\x1b]52;c;?\x07', '\x1b]13;?\x07',
    '\x1b]11;?\x07draft', 'draft\x1b]11;?\x07', '\x1b]11;?\x07\x1b[2J',
    '\x1b]11;?', '\x1b]11;?\x1b', '11;?\x07', '\x1b]11;?extra\x07',
    '\x1b]11;?\x07\n', '\x1b]11;?\x07\x1b',
  ]) {
    it(`keeps possible screen activity ${JSON.stringify(data)}`, () => {
      expect(isTerminalColorQueryOnly(data)).toBe(false);
    });
  }
});
