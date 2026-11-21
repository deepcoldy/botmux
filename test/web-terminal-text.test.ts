import xtermHeadless from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import {
  terminalBufferText,
  terminalBufferTextSource,
  type TerminalTextBuffer,
} from '../src/core/web-terminal-text.js';

const { Terminal } = xtermHeadless;

// 真的 xterm 缓冲区：宽字符在折行处怎么留空格只有它说了算。
async function xtermBuffer(cols: number, data: string): Promise<TerminalTextBuffer> {
  const t = new Terminal({ cols, rows: 6, allowProposedApi: true, scrollback: 100 });
  await new Promise<void>(resolve => t.write(data, resolve));
  return t.buffer.active;
}

// 按 xterm 的行为造一个缓冲区：每行是定宽的格子，右侧用空格补齐；
// 以 '↵' 开头的行表示它是上一行因列宽自动折下来的续行（isWrapped）。
function fakeBuffer(rows: string[], cols = 12): TerminalTextBuffer {
  const lines = rows.map(row => {
    const isWrapped = row.startsWith('↵');
    const text = (isWrapped ? row.slice(1) : row).padEnd(cols, ' ');
    return {
      isWrapped,
      translateToString: (trimRight?: boolean) => (trimRight ? text.replace(/\s+$/, '') : text),
    };
  });
  return { length: lines.length, getLine: (y: number) => lines[y] };
}

describe('terminalBufferText', () => {
  it('去掉行尾补齐的空格，并裁掉首尾的空行', () => {
    const buffer = fakeBuffer(['', '$ ls', 'a.txt  b.txt', '', '']);
    expect(terminalBufferText(buffer).lines).toEqual(['$ ls', 'a.txt  b.txt']);
  });

  it('把自动折行拼回一行，折行处的空格是正文的一部分不能丢', () => {
    const buffer = fakeBuffer(['hello world ', '↵and more', 'next'], 12);
    expect(terminalBufferText(buffer).lines).toEqual(['hello world and more', 'next']);
  });

  it('区间从折行中间开始或在折行中间结束时，补齐整条逻辑行', () => {
    const buffer = fakeBuffer(['first', 'abcdefghijkl', '↵mnop', 'last', 'ABCDEFGHIJKL', '↵MN']);
    expect(terminalBufferText(buffer, { start: 2, end: 5 }).lines).toEqual([
      'abcdefghijklmnop',
      'last',
      'ABCDEFGHIJKLMN',
    ]);
  });

  it('区间参数越界时收进缓冲区范围', () => {
    const buffer = fakeBuffer(['a', 'b', 'c']);
    expect(terminalBufferText(buffer, { start: -5, end: 99 }).lines).toEqual(['a', 'b', 'c']);
    expect(terminalBufferText(buffer, { start: 10 }).lines).toEqual([]);
    expect(terminalBufferText(buffer, { start: 2, end: 1 }).lines).toEqual([]);
  });

  it('把定位行换算成拼接、裁剪后的逻辑行下标', () => {
    const buffer = fakeBuffer(['', '', 'one', 'twotwotwotwo', '↵two', 'three', '']);
    // 按在折行续行上：算到它所属的那条逻辑行。
    expect(terminalBufferText(buffer, { anchorRow: 4 })).toEqual({
      lines: ['one', 'twotwotwotwotwo', 'three'],
      anchorLine: 1,
    });
    expect(terminalBufferText(buffer, { anchorRow: 5 }).anchorLine).toBe(2);
    // 按在被裁掉的空行上、或没给定位行：-1。
    expect(terminalBufferText(buffer, { anchorRow: 0 }).anchorLine).toBe(-1);
    expect(terminalBufferText(buffer, { anchorRow: 6 }).anchorLine).toBe(-1);
    expect(terminalBufferText(buffer).anchorLine).toBe(-1);
  });

  it('宽字符放不进最后一列而折到下一行时，不把留下的空格当成正文', async () => {
    const han = '一二三四五六七八九十'.repeat(3);
    // 奇数长的前缀让每一行都有一个字跨在折行点上；偶数长的一个不跨，是对照。
    for (const prefix of ['a', '  a', '$ ']) {
      const buffer = await xtermBuffer(10, prefix + han + '\r\nnext');
      expect(buffer.getLine(1)!.isWrapped).toBe(true);
      expect(terminalBufferText(buffer).lines).toEqual([prefix + han, 'next']);
    }
  });

  it('折行处真正写进去的空格照样保留，不管下一行是不是宽字符', async () => {
    // 空格正好落在最后一列。
    expect(terminalBufferText(await xtermBuffer(10, 'abcdefghi 中文')).lines).toEqual(['abcdefghi 中文']);
    expect(terminalBufferText(await xtermBuffer(10, 'abcdefghi xyz')).lines).toEqual(['abcdefghi xyz']);
    // 空格在倒数第二列，最后一列是宽字符挤走后留下的空格。
    expect(terminalBufferText(await xtermBuffer(10, 'abcdefgh 中文')).lines).toEqual(['abcdefgh 中文']);
  });

  it('缓冲区里只有空白时返回空列表', () => {
    expect(terminalBufferText(fakeBuffer(['', '   ', ''])).lines).toEqual([]);
  });

  it('嵌进终端页的源码自给自足，重建后行为一致', async () => {
    // 页面代码住在模板字符串里：源码里不能有反引号，也不能有插值起始序列。
    expect(terminalBufferTextSource).not.toContain('`');
    expect(terminalBufferTextSource).not.toContain('${');
    // eslint-disable-next-line no-new-func
    const rebuilt = new Function(`return (${terminalBufferTextSource})`)() as typeof terminalBufferText;
    const buffer = fakeBuffer(['', 'hello world ', '↵and more', 'next', '']);
    expect(rebuilt(buffer, { anchorRow: 2 })).toEqual(terminalBufferText(buffer, { anchorRow: 2 }));
    const wide = await xtermBuffer(10, 'a一二三四五六七八九十');
    expect(rebuilt(wide).lines).toEqual(['a一二三四五六七八九十']);
  });
});
