/**
 * Where full-screen paints sit in an attach stream. hc sends one when a viewer
 * attaches and again after dropping a viewer's backlog (viewers.rs
 * `first_paint`/`paint_state`). A paint is CAN, ghostty's soft reset and mode
 * resets, the screen, then the replayed win32-input mode and any OSC 7501
 * status reports; whatever follows (including the continuation of a sequence
 * the program was half-way through) is live output.
 */

export const PAINT_START = Buffer.from('\x18\x1b[!p\x1b[?2026l', 'latin1');
const MODE_ON = Buffer.from('\x1b[?9001h', 'latin1');
const MODE_OFF = Buffer.from('\x1b[?9001l', 'latin1');
const MARKER_BYTES = MODE_ON.length;
const REPORT_OPEN = Buffer.from('\x1b]7501;', 'latin1');
const REPORT_CLOSE = Buffer.from('\x1b\\', 'latin1');

/** A paint that never shows its closing marker is treated as over after this much. */
export const MAX_PAINT_BYTES = 64 << 20;

export interface StreamSegment {
  bytes: Buffer;
  /** Part of a full-screen paint rather than live output. */
  paint: boolean;
  /** Part of the paint that opened the stream. */
  firstPaint: boolean;
  /** The last bytes of that paint. */
  paintDone: boolean;
}

type State = 'live' | 'screen' | 'reports' | 'report-body';

export class PaintTracker {
  private state: State = 'live';
  private carry: Buffer = Buffer.alloc(0);
  /** Live bytes ending a read that could be the start of a paint split across frames. */
  private held: Buffer = Buffer.alloc(0);
  private paintBytes = 0;
  private first = false;
  private seenFirst = false;

  get inPaint(): boolean {
    return this.state !== 'live';
  }

  push(input: Buffer): StreamSegment[] {
    const chunk = this.held.length > 0 ? Buffer.concat([this.held, input]) : input;
    this.held = Buffer.alloc(0);
    const out: StreamSegment[] = [];
    let at = 0;
    while (at < chunk.length) {
      if (this.state === 'live') {
        const start = chunk.indexOf(PAINT_START, at);
        if (start < 0) {
          const keep = partialStart(chunk, at);
          if (chunk.length - keep > at) out.push(this.segment(chunk.subarray(at, chunk.length - keep), false));
          if (keep > 0) this.held = Buffer.from(chunk.subarray(chunk.length - keep));
          break;
        }
        if (start > at) out.push(this.segment(chunk.subarray(at, start), false));
        this.state = 'screen';
        this.carry = Buffer.alloc(0);
        this.paintBytes = 0;
        this.first = !this.seenFirst;
        this.seenFirst = true;
        at = start;
        continue;
      }
      const end = this.paintEnd(chunk, at);
      if (end === null) {
        this.paintBytes += chunk.length - at;
        const over = this.paintBytes > MAX_PAINT_BYTES;
        out.push(this.segment(chunk.subarray(at), true, over));
        if (over) this.state = 'live';
        break;
      }
      this.paintBytes += end - at;
      out.push(this.segment(chunk.subarray(at, end), true, true));
      this.state = 'live';
      at = end;
    }
    return out;
  }

  /** Live bytes still held back because they might have begun a paint; call when the stream ends. */
  flush(): StreamSegment[] {
    if (this.held.length === 0) return [];
    const bytes = this.held;
    this.held = Buffer.alloc(0);
    return [this.segment(bytes, false)];
  }

  /** Index in `chunk` just past the paint, or null when the paint runs past this chunk. */
  private paintEnd(chunk: Buffer, from: number): number | null {
    let at = from;
    if (this.state === 'screen') {
      const search = this.carry.length > 0 ? Buffer.concat([this.carry, chunk.subarray(at)]) : chunk.subarray(at);
      const marker = earliest(search.indexOf(MODE_ON), search.indexOf(MODE_OFF));
      if (marker < 0) {
        this.carry = Buffer.from(search.subarray(Math.max(0, search.length - (MARKER_BYTES - 1))));
        return null;
      }
      at += marker + MARKER_BYTES - this.carry.length;
      this.carry = Buffer.alloc(0);
      this.state = 'reports';
    }
    for (;;) {
      if (this.state === 'report-body') {
        const search = this.carry.length > 0 ? Buffer.concat([this.carry, chunk.subarray(at)]) : chunk.subarray(at);
        const close = search.indexOf(REPORT_CLOSE);
        if (close < 0) {
          this.carry = search[search.length - 1] === 0x1b ? Buffer.from([0x1b]) : Buffer.alloc(0);
          return null;
        }
        at += close + REPORT_CLOSE.length - this.carry.length;
        this.carry = Buffer.alloc(0);
        this.state = 'reports';
      }
      if (!startsWithAt(chunk, at, REPORT_OPEN)) return at;
      this.state = 'report-body';
      at += REPORT_OPEN.length;
    }
  }

  private segment(bytes: Buffer, paint: boolean, done = false): StreamSegment {
    return { bytes, paint, firstPaint: paint && this.first, paintDone: paint && done };
  }
}

/** Length of the longest proper prefix of PAINT_START that ends `chunk` at or after `from`. */
function partialStart(chunk: Buffer, from: number): number {
  const floor = Math.max(from, chunk.length - (PAINT_START.length - 1));
  for (let at = chunk.indexOf(PAINT_START[0]!, floor); at >= 0; at = chunk.indexOf(PAINT_START[0]!, at + 1)) {
    if (PAINT_START.compare(chunk, at, chunk.length, 0, chunk.length - at) === 0) return chunk.length - at;
  }
  return 0;
}

function earliest(a: number, b: number): number {
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

function startsWithAt(haystack: Buffer, at: number, needle: Buffer): boolean {
  return haystack.length - at >= needle.length && haystack.compare(needle, 0, needle.length, at, at + needle.length) === 0;
}
