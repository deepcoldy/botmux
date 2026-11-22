import { describe, expect, it } from 'vitest';
import { plainRows, serializeRows } from '../src/adapters/backend/hc/ansi-serialize.js';
import { bufferCells, makeTerminal, writeAll } from './helpers/xterm-cells.js';

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const COLOURS = [
  range(30, 37).map(n => `\x1b[${n}mf${n}`).join(' '),
  range(90, 97).map(n => `\x1b[${n}mf${n}`).join(' '),
  `\x1b[39m${range(40, 47).map(n => `\x1b[${n}mb${n}`).join(' ')}`,
  range(100, 107).map(n => `\x1b[${n}mb${n}`).join(' '),
  '\x1b[0m\x1b[38;5;196m256fg \x1b[48;5;21m256bg \x1b[38;5;3mlow256 \x1b[48;5;15mlow256bg',
  '\x1b[0m\x1b[38;2;1;2;3mrgb \x1b[48;2;250;128;0mrgbbg \x1b[39mdefault-fg \x1b[49mdefault-bg',
  '\x1b[31;44mred-on-blue\x1b[0m plain \x1b[38;5;82;48;2;9;9;9mmixed\x1b[0m',
].join('\r\n');

const ATTRIBUTES = [
  '\x1b[1mbold\x1b[22m \x1b[2mdim\x1b[22m \x1b[3mitalic\x1b[23m \x1b[4munder\x1b[24m \x1b[5mblink\x1b[25m',
  '\x1b[7minverse\x1b[27m \x1b[8mhidden\x1b[28m \x1b[9mstrike\x1b[29m \x1b[53mover\x1b[55m',
  '\x1b[1;3;4;31;42mcombo\x1b[24m-no-underline\x1b[22m-no-bold\x1b[0m done',
  '\x1b[1;2mbold-dim\x1b[22m\x1b[2m-dim-only\x1b[0m \x1b[7;31minverse-red\x1b[0m',
].join('\r\n');

const WIDE = [
  '中文字符 mixed 漢字 end',
  '\x1b[31m中\x1b[42m文\x1b[0m😀 ✅ 가 Ａ',
  `${'x'.repeat(19)}中 wrapped wide`,
  '\x1b[44m宽\x1b[0m',
].join('\r\n');

const WRAPPED = `\x1b[36m${'abcdefghij'.repeat(5)}\x1b[0m tail\r\nshort\r\n${'0123456789'.repeat(3)}`;

const SCROLLBACK = range(0, 299).map(i => `\x1b[3${i % 8}mline ${i}\x1b[0m ${'·'.repeat(i % 13)}`).join('\r\n');

const ALT = 'main 1\r\nmain 2\x1b[?1049h\x1b[H\x1b[1;35malt top\x1b[0m\x1b[3;5H\x1b[48;5;100malt mid 中\x1b[0m';

async function roundTrip(input: string, cols = 20, rows = 6): Promise<{ expected: string[][]; actual: string[][]; text: string }> {
  const source = makeTerminal(cols, rows);
  await writeAll(source, input);
  const buffer = source.buffer.active;
  const end = buffer.type === 'alternate' ? rows : buffer.baseY + rows;
  const text = serializeRows(buffer, 0, end);
  const replay = makeTerminal(cols, rows);
  await writeAll(replay, text);
  return { expected: bufferCells(buffer, 0, end), actual: bufferCells(replay.buffer.normal, 0, end), text };
}

describe('serializeRows round trip', () => {
  it.each([
    ['16, 256 and truecolor colours with default resets', COLOURS, 80],
    ['every SGR attribute, alone, combined and removed one at a time', ATTRIBUTES, 80],
    ['wide characters, including one wrapped at the margin', WIDE, 20],
    ['soft-wrapped rows', WRAPPED, 20],
    ['scrollback', SCROLLBACK, 30],
    ['the alternate screen', ALT, 20],
  ])('%s', async (_name, input, cols) => {
    const { expected, actual } = await roundTrip(input, cols);
    expect(expected.some(row => row.length > 0)).toBe(true);
    expect(actual).toEqual(expected);
  });
});

describe('serializeRows format', () => {
  async function rowsOf(input: string, cols = 20, rows = 3): Promise<string> {
    const term = makeTerminal(cols, rows);
    await writeAll(term, input);
    return serializeRows(term.buffer.active, 0, rows);
  }

  it('terminates every row, empty ones included, with the line ending', async () => {
    expect(await rowsOf('a\r\n\r\nc')).toBe('a\r\n\r\nc\r\n');
    const term = makeTerminal(10, 2);
    await writeAll(term, 'x');
    expect(serializeRows(term.buffer.active, 0, 2, '\n')).toBe('x\n\n');
  });

  // tmux 2.8 to 3.6a alike: `capture-pane -e` trims the spaces after a row's
  // last attribute change, so blanks before a change are kept (a reverse-video
  // cursor, a coloured bar, cells erased with a colour) and blanks that reach
  // the margin without one are not.
  it('keeps blanks up to the last attribute change of a row and drops the rest', async () => {
    expect(await rowsOf('ab   \x1b[44m   \x1b[0m')).toBe('ab   \x1b[44m   \x1b[0m\r\n\r\n\r\n');
    expect(await rowsOf('> \x1b[7m \x1b[0m')).toBe('> \x1b[7m \x1b[0m\r\n\r\n\r\n');
    expect(await rowsOf('ab\x1b[41m\x1b[3X\x1b[0m')).toBe('ab\x1b[41m   \x1b[0m\r\n\r\n\r\n');
    expect(await rowsOf('ab   ')).toBe('ab\r\n\r\n\r\n');
    expect(await rowsOf('ab\x1b[44m\x1b[K\x1b[0m')).toBe('ab\r\n\r\n\r\n');
    expect(await rowsOf('a   b')).toBe('a   b\r\n\r\n\r\n');
    expect(await rowsOf('a\x1b[5Cb')).toBe('a     b\r\n\r\n\r\n');
  });

  it('drops styled blanks that reach the last column', async () => {
    expect(await rowsOf(`\x1b[44m${' '.repeat(20)}\x1b[0m`)).toBe('\r\n\r\n\r\n');
    expect(await rowsOf(`\x1b[44m${' '.repeat(19)}\x1b[7m \x1b[0m`)).toBe(`\x1b[44m${' '.repeat(19)}\x1b[0m\r\n\r\n\r\n`);
    expect(await rowsOf(`${'t'.repeat(19)}\x1b[7m \x1b[0m`)).toBe(`${'t'.repeat(19)}\r\n\r\n\r\n`);
  });

  it('writes a wide character once, without its padding cell', async () => {
    expect(await rowsOf('中a文')).toBe('中a文\r\n\r\n\r\n');
  });

  it('keeps each colour in its own SGR family', async () => {
    const text = await rowsOf('\x1b[31mA\x1b[91mB\x1b[38;5;31mC\x1b[38;2;10;20;30mD\x1b[41mE\x1b[101mF\x1b[48;5;9mG\x1b[48;2;1;1;1mH', 40, 1);
    for (const piece of ['31mA', '91mB', '38;5;31mC', '38;2;10;20;30mD', '41mE', '101mF', '48;5;9mG', '48;2;1;1;1mH']) {
      expect(text).toContain(piece);
    }
  });

  it('starts every row from the default pen', async () => {
    const text = await rowsOf('\x1b[41mred\r\nstill red\x1b[0m\r\nplain', 20, 3);
    const lines = text.split('\r\n');
    expect(lines[0]!.endsWith('\x1b[0m')).toBe(true);
    expect(lines[1]!.startsWith('\x1b[41m')).toBe(true);
    expect(lines[2]).toBe('plain');
  });

  it('replays without painting a coloured background into rows a scroll opens', async () => {
    const source = makeTerminal(10, 2);
    await writeAll(source, '\x1b[44mblue\r\nstill\x1b[0m');
    const replay = makeTerminal(10, 2);
    await writeAll(replay, serializeRows(source.buffer.active, 0, 2) + 'x');
    const cell = replay.buffer.active.getLine(replay.buffer.active.baseY + 1)!.getCell(5)!;
    expect(cell.isBgDefault()).toBe(true);
  });
});

describe('plainRows', () => {
  it('prints bare text, trailing spaces trimmed, every row ending in LF', async () => {
    const term = makeTerminal(12, 3);
    await writeAll(term, '\x1b[31mred\x1b[0m   \r\n中文 \x1b[44m  \x1b[0m\r\n');
    expect(plainRows(term.buffer.active, 0, 3)).toBe('red\n中文\n\n');
  });

  it('splits soft-wrapped rows', async () => {
    const term = makeTerminal(5, 3);
    await writeAll(term, 'abcdefgh');
    expect(plainRows(term.buffer.active, 0, 3)).toBe('abcde\nfgh\n\n');
  });
});
