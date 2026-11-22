import { describe, expect, it } from 'vitest';
import {
  bracketedPasteFrame,
  encodeTmuxKey,
  encodeTmuxKeys,
  pasteBufferBytes,
  submitBracketedPasteBytes,
} from '../src/adapters/backend/hc/keys.js';
import { ScreenMirror } from '../src/adapters/backend/hc/screen-mirror.js';

const NORMAL = { applicationCursorKeys: false };
const APP = { applicationCursorKeys: true };

/** Every key name botmux hands to sendSpecialKeys, with the bytes it must produce in either cursor mode. */
const BOTMUX_KEYS: Array<[string, string]> = [
  ['Enter', '\r'],
  ['M-Enter', '\x1b\r'],
  ['C-c', '\x03'],
  ['C-j', '\n'],
  ['Escape', '\x1b'],
  ['Tab', '\t'],
  ['Space', ' '],
  ['PPage', '\x1b[5~'],
  ['NPage', '\x1b[6~'],
  ['t', 't'],
  ['s', 's'],
  ['1', '1'],
];

const CURSOR_KEYS: Array<[string, string, string]> = [
  ['Up', '\x1b[A', '\x1bOA'],
  ['Down', '\x1b[B', '\x1bOB'],
  ['Right', '\x1b[C', '\x1bOC'],
  ['Left', '\x1b[D', '\x1bOD'],
  ['Home', '\x1b[H', '\x1bOH'],
  ['End', '\x1b[F', '\x1bOF'],
];

describe('encodeTmuxKey', () => {
  it.each(BOTMUX_KEYS)('%s is the same in both cursor modes', (name, bytes) => {
    expect(encodeTmuxKey(name, NORMAL)).toBe(bytes);
    expect(encodeTmuxKey(name, APP)).toBe(bytes);
  });

  it.each(CURSOR_KEYS)('%s follows DECCKM', (name, normal, app) => {
    expect(encodeTmuxKey(name, NORMAL)).toBe(normal);
    expect(encodeTmuxKey(name, APP)).toBe(app);
  });

  it.each([
    ['C-Up', '\x1b[1;5A'],
    ['S-Up', '\x1b[1;2A'],
    ['M-Up', '\x1b[1;3A'],
    ['C-S-Up', '\x1b[1;6A'],
    ['C-M-Left', '\x1b[1;7D'],
    ['C-Home', '\x1b[1;5H'],
    ['S-End', '\x1b[1;2F'],
  ])('modified cursor key %s ignores DECCKM', (name, bytes) => {
    expect(encodeTmuxKey(name, NORMAL)).toBe(bytes);
    expect(encodeTmuxKey(name, APP)).toBe(bytes);
  });

  it.each([
    ['F1', '\x1bOP'], ['F4', '\x1bOS'], ['S-F1', '\x1b[1;2P'], ['C-F2', '\x1b[1;5Q'],
    ['F5', '\x1b[15~'], ['F6', '\x1b[17~'], ['F10', '\x1b[21~'], ['F11', '\x1b[23~'], ['F12', '\x1b[24~'],
    ['S-F5', '\x1b[15;2~'], ['M-F5', '\x1b[15;3~'],
    ['IC', '\x1b[2~'], ['Insert', '\x1b[2~'], ['DC', '\x1b[3~'], ['Delete', '\x1b[3~'],
    ['PageUp', '\x1b[5~'], ['PgUp', '\x1b[5~'], ['PageDown', '\x1b[6~'], ['PgDn', '\x1b[6~'],
    ['C-PPage', '\x1b[5;5~'], ['S-DC', '\x1b[3;2~'], ['C-M-DC', '\x1b[3;7~'],
  ])('function and editing key %s', (name, bytes) => {
    expect(encodeTmuxKey(name, NORMAL)).toBe(bytes);
  });

  it.each([
    ['BTab', '\x1b[Z'], ['S-Tab', '\x1b[Z'], ['M-Tab', '\x1b\t'], ['C-Tab', '\x1b[27;5;9~'],
    ['C-S-Tab', '\x1b[27;6;9~'], ['M-BTab', '\x1b[27;4;9~'],
    ['C-Enter', '\x1b[27;5;13~'], ['S-Enter', '\x1b[27;2;13~'], ['C-M-Enter', '\x1b[27;7;13~'],
    ['M-Escape', '\x1b\x1b'], ['C-Escape', '\x1b[27;5;27~'], ['S-Escape', '\x1b[27;2;27~'],
    ['BSpace', '\x7f'], ['C-BSpace', '\b'], ['M-BSpace', '\x1b\x7f'], ['C-M-BSpace', '\x1b\b'], ['S-BSpace', '\x7f'],
  ])('Tab, Enter, Escape and BSpace with modifiers: %s', (name, bytes) => {
    expect(encodeTmuxKey(name, NORMAL)).toBe(bytes);
  });

  it.each([
    ['C-a', '\x01'], ['C-z', '\x1a'], ['C-A', '\x01'], ['^c', '\x03'], ['^C', '\x03'],
    ['C-Space', '\x00'], ['C-2', '\x00'], ['C-6', '\x1e'], ['C-/', '\x1f'], ['C--', '\x1f'], ['C-?', '\x7f'],
    ['C-[', '\x1b'], ['C-\\', '\x1c'], ['C-]', '\x1d'], ['C-1', '1'],
    ['M-x', '\x1bx'], ['M-7', '\x1b7'], ['M-Space', '\x1b '], ['C-M-a', '\x1b\x01'], ['C-M-Space', '\x1b\x00'],
    ['S-a', 'A'], ['S-Space', ' '], ['-', '-'], ['^', '^'],
    ['中', '中'], ['M-中', '\x1b中'], ['😀', '😀'],
  ])('character key %j', (name, bytes) => {
    expect(encodeTmuxKey(name, NORMAL)).toBe(bytes);
  });

  it('matches key names case-insensitively, prefixes included', () => {
    for (const name of ['enter', 'ENTER', 'eNtEr']) expect(encodeTmuxKey(name, NORMAL)).toBe('\r');
    expect(encodeTmuxKey('m-enter', NORMAL)).toBe('\x1b\r');
    expect(encodeTmuxKey('c-c', NORMAL)).toBe('\x03');
    expect(encodeTmuxKey('ppage', NORMAL)).toBe('\x1b[5~');
    expect(encodeTmuxKey('UP', APP)).toBe('\x1bOA');
  });

  it('types anything that is not a tmux key name literally, as send-keys does', () => {
    for (const name of ['hello', 'Esc', 'Backspace', 'C-', 'a-b', '--', 'X-Enter', 'C-hello', 'F13', 'enter ']) {
      expect(encodeTmuxKey(name, NORMAL)).toBe(name);
    }
  });

  it('sends keypad keys as characters, or SS3 under DECKPAM', () => {
    expect(encodeTmuxKeys(['KP5', 'KPEnter', 'KP/'], NORMAL)).toBe('5\r/');
    expect(encodeTmuxKeys(['KP5', 'KPEnter', 'KP/'], { applicationCursorKeys: false, applicationKeypad: true })).toBe('\x1bOu\x1bOM\x1bOo');
  });

  it('concatenates a send-keys argument list in order', () => {
    expect(encodeTmuxKeys(['Escape', 'Up', 'Enter', 'q'], APP)).toBe('\x1b\x1bOA\rq');
  });

  it('takes DECCKM and DECKPAM straight from a screen mirror', () => {
    const mirror = new ScreenMirror({ cols: 10, rows: 2 });
    expect(encodeTmuxKeys(['Up', 'KP1'], mirror)).toBe('\x1b[A1');
    mirror.write('\x1b[?1h\x1b=');
    expect(encodeTmuxKeys(['Up', 'KP1'], mirror)).toBe('\x1bOA\x1bOq');
    mirror.write('\x1b[?1l\x1b>');
    expect(encodeTmuxKeys(['Up', 'KP1'], mirror)).toBe('\x1b[A1');
  });
});

describe('paste framing', () => {
  it('pasteBufferBytes is tmux paste-buffer -p: LF to CR, markers only under DEC 2004', () => {
    expect(pasteBufferBytes('a\nb\n', false)).toBe('a\rb\r');
    expect(pasteBufferBytes('a\nb', true)).toBe('\x1b[200~a\rb\x1b[201~');
    expect(pasteBufferBytes('', true)).toBe('');
  });

  it('follows the mirror for DEC 2004', () => {
    const mirror = new ScreenMirror({ cols: 10, rows: 2 });
    expect(pasteBufferBytes('x', mirror.bracketedPaste)).toBe('x');
    mirror.write('\x1b[?2004h');
    expect(pasteBufferBytes('x', mirror.bracketedPaste)).toBe('\x1b[200~x\x1b[201~');
  });

  it('bracketedPasteFrame always brackets and keeps the text verbatim', () => {
    expect(bracketedPasteFrame('a\nb')).toBe('\x1b[200~a\nb\x1b[201~');
    expect(bracketedPasteFrame('')).toBe('\x1b[200~\x1b[201~');
  });

  it('submitBracketedPasteBytes brackets the raw text then presses Enter, even when empty', () => {
    expect(submitBracketedPasteBytes('line 1\nline 2')).toBe('\x1b[200~line 1\nline 2\x1b[201~\r');
    expect(submitBracketedPasteBytes('')).toBe('\x1b[200~\x1b[201~\r');
  });
});
