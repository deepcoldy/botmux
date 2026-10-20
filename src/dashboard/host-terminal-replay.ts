// src/dashboard/host-terminal-replay.ts
//
// 宿主终端「重连 / 切回前台」时的重同步材料，刻意不在服务端跑终端仿真器：
// 那等于把每个输出字节在 dashboard 事件循环里再解析一遍（@xterm/headless 实测
// 几十 MB/s，`cat` 大文件时会把整个 dashboard 拖住）。这里只保留两样廉价状态：
//
//  - OutputRing：最近 N 字节原始输出，按块存、超容整块丢，重放给新连上的浏览器；
//  - TerminalModeTracker：用 Buffer.indexOf 扫 ESC，只认少数几个影响「输入怎么编码 /
//    画在哪块屏上」的 DEC 私有模式（备用屏、鼠标上报、括号粘贴、应用光标键…）。
//    环形缓冲头部被截掉后，重放内容里可能缺了打开这些模式的那条序列；重放完把它们
//    按真实状态补发一遍，TUI 的鼠标/粘贴才不会在刷新页面后失灵。

/** 跟踪的独立开关型 DEC 私有模式（`CSI ? Pm h/l`）。 */
const TRACKED_MODES = [
  1, // DECCKM 应用光标键
  7, // DECAWM 自动折行（tput rmam 会关）
  25, // DECTCEM 光标可见
  1004, // 焦点事件
  2004, // 括号粘贴
] as const;
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);
const TRACKED = new Set<number>(TRACKED_MODES);
const DEFAULT_ON = new Set<number>([7, 25]);
// 鼠标上报协议与编码在 xterm 里各是一个互斥状态，不是独立开关（同 xterm.js InputHandler）：
//  - 协议：set 9/1000/1002/1003 切到对应协议，reset 其中任何一个都回到「不上报」；
//  - 编码：set 1006/1016 切到 SGR / SGR 像素，reset 任一回到默认编码（1005/1015 xterm 不支持）。
const MOUSE_PROTOCOLS = new Set([9, 1000, 1002, 1003]);
const MOUSE_ENCODINGS = new Set([1006, 1016]);

const ESC = 0x1b;
/** 跨块截断的转义序列最多续这么长；更长的不可能是我们关心的模式序列。 */
const MAX_SEQ = 64;

export class TerminalModeTracker {
  private modes = new Map<number, boolean>();
  private mouseProtocol = 0;
  private mouseEncoding = 0;
  private alt: boolean;
  private keypad = false;
  private carry: Buffer | null = null;

  /**
   * 从环形缓冲某个切口处的状态开始跟踪：startAlt 是否已在备用屏，carry 是切口前没写完、
   * 跨到切口之后才结束的那半截序列。
   */
  constructor(startAlt = false, carry: Buffer | null = null) {
    this.alt = startAlt;
    this.carry = carry && carry.length ? Buffer.from(carry) : null;
  }

  get altScreen(): boolean { return this.alt; }

  /** 跨块还没解析完的半截序列（拷贝）；没有返回 null。 */
  pendingSequence(): Buffer | null {
    return this.carry ? Buffer.from(this.carry) : null;
  }

  isOn(mode: number): boolean {
    return this.modes.get(mode) ?? DEFAULT_ON.has(mode);
  }

  feed(chunk: Buffer): void {
    let start = 0;
    if (this.carry) {
      const carry = this.carry;
      this.carry = null;
      const head = Buffer.concat([carry, chunk.subarray(0, MAX_SEQ)]);
      const end = this.parseAt(head, 0);
      if (end < 0) {
        if (head.length < MAX_SEQ && head.length === carry.length + chunk.length) this.carry = head;
        return;
      }
      start = Math.max(0, end - carry.length);
    }
    let i = chunk.indexOf(ESC, start);
    while (i !== -1) {
      const end = this.parseAt(chunk, i);
      if (end < 0) {
        if (chunk.length - i < MAX_SEQ) this.carry = Buffer.from(chunk.subarray(i));
        return;
      }
      i = chunk.indexOf(ESC, end);
    }
  }

  /**
   * 把模式恢复到真实状态的序列，接在重放内容之后发，其余模式开的发 h、关的发 l。
   *
   * 备用屏只在「应该在备用屏」时补一条 DECSET 1047：重放内容的最后一次切屏与真实状态
   * 一致，唯一可能对不上的是「切进备用屏那条已被环形缓冲截掉」。不用 1049：它的 set
   * 会先 DECSC 覆盖已保存的光标，reset 则无论在哪块屏都会 DECRC——普通屏下补一条
   * `?1049l` 会把光标拽回保存点（RIS 之后就是左上角），后续输出盖掉提示符。
   */
  restoreSequence(): string {
    let out = this.alt ? '\x1b[?1047h' : '';
    const on: number[] = [];
    const off: number[] = [];
    for (const m of TRACKED_MODES) (this.isOn(m) ? on : off).push(m);
    if (off.length) out += `\x1b[?${off.join(';')}l`;
    if (on.length) out += `\x1b[?${on.join(';')}h`;
    // 先全部复位（xterm 里 reset 任一即回到「不上报 / 默认编码」），再只打开当前那一个。
    out += '\x1b[?9;1000;1002;1003l';
    if (this.mouseProtocol) out += `\x1b[?${this.mouseProtocol}h`;
    out += '\x1b[?1006;1016l';
    if (this.mouseEncoding) out += `\x1b[?${this.mouseEncoding}h`;
    out += this.keypad ? '\x1b=' : '\x1b>';
    return out;
  }

  /** 当前鼠标上报协议（9 / 1000 / 1002 / 1003，0 = 不上报）。 */
  get mouseTracking(): number { return this.mouseProtocol; }

  /** 解析 buf[i] 处的 ESC 序列；返回其后的下标，序列不完整返回 -1。 */
  private parseAt(buf: Buffer, i: number): number {
    if (i + 1 >= buf.length) return -1;
    const b1 = buf[i + 1];
    if (b1 === 0x63) { // ESC c — RIS 全复位
      this.modes.clear();
      this.mouseProtocol = 0;
      this.mouseEncoding = 0;
      this.alt = false;
      this.keypad = false;
      return i + 2;
    }
    if (b1 === 0x3d) { this.keypad = true; return i + 2; } // ESC =
    if (b1 === 0x3e) { this.keypad = false; return i + 2; } // ESC >
    if (b1 !== 0x5b) return i + 1; // 不是 CSI
    if (i + 2 >= buf.length) return -1;
    if (buf[i + 2] === 0x21) { // CSI ! p — DECSTR 软复位（tput init 会发）
      if (i + 3 >= buf.length) return -1;
      if (buf[i + 3] === 0x70) {
        // 同 xterm.js softReset：光标可见，应用光标键 / 应用小键盘 / 括号粘贴 / 焦点上报复位；
        // 鼠标上报与备用屏不受影响。
        this.modes.clear();
        this.keypad = false;
        return i + 4;
      }
      return i + 3;
    }
    if (buf[i + 2] !== 0x3f) return i + 2; // 不是 DEC 私有模式
    let j = i + 3;
    while (j < buf.length) {
      const b = buf[j];
      if (b >= 0x40 && b <= 0x7e) break; // final byte
      if (j - i > MAX_SEQ) return j;
      j++;
    }
    if (j >= buf.length) return -1;
    const final = buf[j];
    if (final === 0x68 || final === 0x6c) { // h / l
      const set = final === 0x68;
      for (const part of buf.toString('latin1', i + 3, j).split(';')) {
        const mode = Number(part);
        if (ALT_SCREEN_MODES.has(mode)) this.alt = set;
        else if (MOUSE_PROTOCOLS.has(mode)) this.mouseProtocol = set ? mode : 0;
        else if (MOUSE_ENCODINGS.has(mode)) this.mouseEncoding = set ? mode : 0;
        else if (TRACKED.has(mode)) this.modes.set(mode, set);
      }
    }
    return j + 1;
  }
}

/** 小块合并阈值：交互回显是一两个字节一帧，不合并会攒出几万个小 Buffer。 */
const MERGE_BELOW = 16 * 1024;

/**
 * 字节流末尾「还没写完」的那一截从哪开始：未闭合的转义序列（CSI 没到终止字节、OSC / DCS
 * 没到 BEL / ST）或被截断的 UTF-8 多字节字符。完整时返回 buf.length。
 *
 * 重同步要在快照后面补发模式序列；直接接在半截序列后面会把它截断（ESC 取消未完成的
 * CSI，剩下的字节被当文本画出来；半个汉字丢失）。补发的字节要插在这个切口之前，半截
 * 留到最后，由紧接着的实时输出把它补完整。
 */
export function incompleteTailStart(buf: Buffer): number {
  const len = buf.length;
  // UTF-8：从末尾往回找最近的起始字节，看它要求的长度够不够。
  let utf8Cut = len;
  for (let i = len - 1; i >= Math.max(0, len - 4); i--) {
    const b = buf[i];
    if ((b & 0xc0) === 0x80) continue; // 续字节
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (len - i < need) utf8Cut = i;
    break;
  }
  // 转义：最后一个 ESC 开头的序列是否已结束。OSC / DCS 可能很长（OSC 52 剪贴板），往回多看一些。
  const from = Math.max(0, len - 64 * 1024);
  let esc = buf.lastIndexOf(ESC, len - 1);
  // `ESC \`（ST）本身是上一段 OSC/DCS 的结束，不是新序列的开头。
  if (esc >= from && esc === len - 2 && buf[len - 1] === 0x5c) esc = -1;
  if (esc < from) return utf8Cut;
  if (esc === len - 1) return Math.min(esc, utf8Cut);
  const kind = buf[esc + 1];
  let complete = true;
  if (kind === 0x5b) { // CSI：参数 / 中间字节之后要有 0x40–0x7e 的终止字节
    complete = false;
    for (let j = esc + 2; j < len; j++) {
      if (buf[j] >= 0x40 && buf[j] <= 0x7e) { complete = true; break; }
    }
  } else if (kind === 0x5d || kind === 0x50 || kind === 0x5f || kind === 0x5e || kind === 0x58) {
    // OSC / DCS / APC / PM / SOS：到 BEL（仅 OSC）或 ST（ESC \）为止
    complete = false;
    for (let j = esc + 2; j < len; j++) {
      if (buf[j] === 0x07 && kind === 0x5d) { complete = true; break; }
      if (buf[j] === ESC && buf[j + 1] === 0x5c) { complete = true; break; }
    }
  } else if (kind >= 0x20 && kind <= 0x2f) {
    // ESC + 中间字节（如 `ESC ( B` 选字符集）：还要一个终止字节
    complete = esc + 2 < len;
  }
  return complete ? utf8Cut : Math.min(esc, utf8Cut);
}

/** 某个切口处的解析状态：是否在备用屏 + 跨过切口的半截序列。 */
interface CutState {
  alt: boolean;
  carry: Buffer | null;
}

/** 从 start 出发吃完 bytes 之后的切口状态。 */
function stateAfter(bytes: Buffer, start: CutState): CutState {
  const t = new TerminalModeTracker(start.alt, start.carry);
  t.feed(bytes);
  return { alt: t.altScreen, carry: t.pendingSequence() };
}

interface RingChunk extends CutState {
  buf: Buffer;
}

export interface RingSnapshot {
  bytes: Buffer;
  /**
   * 快照开头时是否在备用屏。长时间运行的全屏程序（htop / vim）切进备用屏的那条
   * `?1049h` 早被挤出环形缓冲时，重放必须先切到备用屏再画，否则 TUI 内容会画进普通屏、
   * 污染滚动历史，而真正的备用屏一片空白。
   */
  altAtStart: boolean;
}

export class OutputRing {
  private chunks: RingChunk[] = [];
  private size = 0;
  private trimmed = false;

  constructor(private readonly capacity: number) {}

  get bytes(): number { return this.size; }

  /**
   * altAtStart：frame 第一个字节之前终端是否在备用屏；carry：frame 之前没写完、在 frame 里
   * 才结束的半截序列（例如 `?1049h` 被 PTY 读切成两块）。前一块被淘汰后，重放从这块开头，
   * 要把半截补回去，切屏才完整。
   */
  push(frame: Buffer, altAtStart = false, carry: Buffer | null = null): void {
    if (frame.length === 0) return;
    const last = this.chunks[this.chunks.length - 1];
    if (last && last.buf.length < MERGE_BELOW && frame.length < MERGE_BELOW) {
      last.buf = Buffer.concat([last.buf, frame]);
    } else {
      // 独立拷贝：PTY 读出的 Buffer 可能是 64KB 读缓冲上的 subarray，直接留着会
      // 让每个几字节的回显钉住一整块读缓冲。
      this.chunks.push({ buf: Buffer.from(frame), alt: altAtStart, carry: carry ? Buffer.from(carry) : null });
    }
    this.size += frame.length;
    while (this.size > this.capacity && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.buf.length;
      this.trimmed = true;
    }
    if (this.size > this.capacity && this.chunks.length === 1) {
      const only = this.chunks[0];
      const cut = only.buf.length - this.capacity;
      Object.assign(only, stateAfter(only.buf.subarray(0, cut), only));
      only.buf = Buffer.from(only.buf.subarray(cut));
      this.size = only.buf.length;
      this.trimmed = true;
    }
  }

  /**
   * 当前内容。头部被截过时从第一个换行之后开始——切口大概率落在一条转义序列中间，
   * 从行首起能少画一截乱码。
   */
  snapshot(): RingSnapshot {
    const head = this.chunks[0];
    if (!head) return { bytes: Buffer.alloc(0), altAtStart: false };
    // 头块开头若接着一段跨块的半截序列，把它前半截补回去（它本来就是这段输出的一部分）。
    const parts = this.chunks.map(c => c.buf);
    if (this.trimmed && head.carry) parts.unshift(head.carry);
    const all = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    if (!this.trimmed) return { bytes: all, altAtStart: head.alt };
    const nl = all.indexOf(0x0a);
    if (nl < 0 || nl >= 4096) return { bytes: all, altAtStart: head.alt };
    return { bytes: all.subarray(nl + 1), altAtStart: stateAfter(all.subarray(0, nl + 1), { alt: head.alt, carry: null }).alt };
  }
}
