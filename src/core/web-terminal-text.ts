/**
 * 把 xterm 缓冲区还原成可复制的纯文本。
 *
 * 手机上没法在终端画布里选字：WebGL / Canvas 渲染器画的是像素，DOM 渲染器那层又被
 * 页面关掉了选区（否则手指一拖就开始选字，滚不动）。所以触屏的复制走「把缓冲区的
 * 文字摊到一个原生可选的文本面板里」这条路，这里是唯一的取字实现。
 *
 * 终端页把 {@link terminalBufferText} 的源码原样嵌进去（页面代码住在 worker.ts 的
 * 模板字符串里，没法 import），单测跑的也是这一份。函数因此必须**自给自足**：不引用
 * 任何外部标识符、函数体里不声明内层函数、不出现反引号。
 */

export interface TerminalTextCell {
  getChars(): string;
  getWidth(): number;
}

export interface TerminalTextLine {
  readonly isWrapped: boolean;
  readonly length?: number;
  getCell?(x: number): TerminalTextCell | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface TerminalTextBuffer {
  readonly length: number;
  getLine(y: number): TerminalTextLine | undefined;
}

export interface TerminalTextOptions {
  /** 起始行（含），缓冲区绝对行号。落在一条折行逻辑行的中间时回退到它的行首。 */
  start?: number;
  /** 结束行（不含）。最后一条逻辑行的折行续行会一并带上。 */
  end?: number;
  /** 需要定位的缓冲区行（长按的那一行），换算成输出里的逻辑行下标。 */
  anchorRow?: number;
}

export interface TerminalTextResult {
  /** 逻辑行：终端因列宽自动折出来的行已经拼回一行，行尾空白已去掉。 */
  lines: string[];
  /** anchorRow 所在的逻辑行在 lines 里的下标；没给 anchorRow 或落在被裁掉的空行上时为 -1。 */
  anchorLine: number;
}

export function terminalBufferText(
  buffer: TerminalTextBuffer,
  options?: TerminalTextOptions,
): TerminalTextResult {
  const total = buffer.length;
  const opts = options || {};
  let from = typeof opts.start === 'number' && opts.start > 0 ? Math.floor(opts.start) : 0;
  let to = typeof opts.end === 'number' && opts.end < total ? Math.ceil(opts.end) : total;
  if (from > total) from = total;
  if (to < from) to = from;
  // 区间从折行续行开始时，往回找到这条逻辑行的行首，否则复制出来的是半句话。
  while (from > 0 && from < total) {
    const head = buffer.getLine(from);
    if (!head || !head.isWrapped) break;
    from--;
  }
  // 末尾同理：最后一条逻辑行折到区间外的续行也要带上。
  while (to < total) {
    const tail = buffer.getLine(to);
    if (!tail || !tail.isWrapped) break;
    to++;
  }
  const anchor = typeof opts.anchorRow === 'number' ? Math.floor(opts.anchorRow) : -1;
  const lines: string[] = [];
  let anchorLine = -1;
  for (let y = from; y < to; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const next = y + 1 < to ? buffer.getLine(y + 1) : undefined;
    let text: string;
    if (next && next.isWrapped) {
      // 后面还接着续行时不能去掉行尾空白：那些空格在逻辑行中间，是正文的一部分。
      // 例外是宽字符（中文、emoji）放不进最后一列时留下的空格：字整个挤到了下一行，这一格从没写过内容。
      const cols = typeof line.length === 'number' ? line.length : 0;
      const last = cols > 0 && line.getCell ? line.getCell(cols - 1) : undefined;
      const first = next.getCell ? next.getCell(0) : undefined;
      const padded = !!last && last.getChars() === '' && last.getWidth() === 1 && !!first && first.getWidth() === 2;
      text = padded ? line.translateToString(false, 0, cols - 1) : line.translateToString(false);
    } else {
      text = line.translateToString(true);
    }
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
    if (y === anchor) anchorLine = lines.length - 1;
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (anchorLine >= lines.length) anchorLine = -1;
  let lead = 0;
  while (lead < lines.length && lines[lead].trim() === '') lead++;
  if (lead > 0) {
    lines.splice(0, lead);
    anchorLine = anchorLine >= lead ? anchorLine - lead : -1;
  }
  return { lines, anchorLine };
}

/** 终端页里那份内嵌实现的源码（见文件头注释：一份实现，两处运行）。 */
export const terminalBufferTextSource = terminalBufferText.toString();
