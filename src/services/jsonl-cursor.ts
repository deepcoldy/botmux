import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';

export interface JsonlCursor {
  newOffset: number;
  pendingTail: string;
}

export interface JsonlScanOptions {
  endOffset?: number;
  chunkSize?: number;
  onLine?: (line: string, lineStart: number) => void;
  onError?: (error: unknown) => void;
}

const TAIL_PROBE_BYTES = 64 * 1024;
const JSONL_SCAN_CHUNK_BYTES = 64 * 1024;

function scanJsonlFromOpenFd(fd: number, fromOffset: number, opts: JsonlScanOptions = {}): JsonlCursor | null {
  const endOffset = opts.endOffset;
  const chunkSize = Math.max(1, opts.chunkSize ?? JSONL_SCAN_CHUNK_BYTES);
  let nextReadOffset = Math.max(0, fromOffset);
  let lineStartOffset = nextReadOffset;
  let lineBuffers: Buffer[] = [];
  let lineBytes = 0;
  const buf = Buffer.alloc(chunkSize);

  try {
    while (true) {
      const remaining = endOffset === undefined ? chunkSize : endOffset - nextReadOffset;
      if (remaining <= 0) break;
      const toRead = Math.min(chunkSize, remaining);
      const bytesRead = readSync(fd, buf, 0, toRead, nextReadOffset);
      if (bytesRead <= 0) break;
      nextReadOffset += bytesRead;

      let searchFrom = 0;
      let nl = buf.subarray(0, bytesRead).indexOf(0x0a);
      while (nl >= 0) {
        const segment = Buffer.from(buf.subarray(searchFrom, nl));
        if (segment.length > 0) {
          lineBuffers.push(segment);
          lineBytes += segment.length;
        }
        const line = lineBuffers.length === 1
          ? lineBuffers[0]
          : Buffer.concat(lineBuffers, lineBytes);
        opts.onLine?.(line.toString('utf8'), lineStartOffset);
        searchFrom = nl + 1;
        lineStartOffset += lineBytes + 1;
        lineBuffers = [];
        lineBytes = 0;
        nl = buf.subarray(searchFrom, bytesRead).indexOf(0x0a);
        if (nl >= 0) nl += searchFrom;
      }
      if (searchFrom < bytesRead) {
        const segment = Buffer.from(buf.subarray(searchFrom, bytesRead));
        lineBuffers.push(segment);
        lineBytes += segment.length;
      }
    }
    return {
      newOffset: lineStartOffset,
      pendingTail: lineBuffers.length === 0
        ? ''
        : (lineBuffers.length === 1 ? lineBuffers[0] : Buffer.concat(lineBuffers, lineBytes)).toString('utf8'),
    };
  } catch (error) {
    opts.onError?.(error);
    return null;
  }
}

/** Scan a JSONL stream from a caller-owned regular file descriptor. The fd is
 *  never closed here; ownership stays with the caller. */
export function scanJsonlFromFd(fd: number, fromOffset: number, opts: JsonlScanOptions = {}): JsonlCursor | null {
  return scanJsonlFromOpenFd(fd, fromOffset, opts);
}

/**
 * Scan an append-only JSONL file from `fromOffset` using chunked reads. Calls
 * `onLine` for each COMPLETE line, and returns the durable byte frontier plus
 * any trailing partial line text left after the last newline. One logical line
 * is accumulated linearly, so memory remains proportional to that line length.
 */
export function scanJsonlFromOffset(path: string, fromOffset: number, opts: JsonlScanOptions = {}): JsonlCursor | null {
  let fd: number | null = null;
  try {
    // O_NONBLOCK prevents an untrusted transcript path swapped to a FIFO from
    // hanging the daemon. Validate the opened fd (rather than only the path)
    // so directories/devices and the stat→open replacement window fail closed.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) {
      throw new Error(`JSONL source is not a regular file: ${path}`);
    }
    return scanJsonlFromOpenFd(fd, fromOffset, opts);
  } catch (error) {
    opts.onError?.(error);
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Return a baseline cursor for an append-only JSONL file without parsing the
 * historical content. This is used when attaching to an existing transcript:
 * old lines are history, so the caller only needs to start future reads after
 * the last complete newline.
 */
export function baselineJsonlCursor(path: string): JsonlCursor {
  if (!existsSync(path)) return { newOffset: 0, pendingTail: '' };

  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { newOffset: 0, pendingTail: '' };
  }
  if (size === 0) return { newOffset: 0, pendingTail: '' };

  const len = Math.min(size, TAIL_PROBE_BYTES);
  const start = size - len;
  const buf = Buffer.alloc(len);
  let read = 0;
  const fd = openSync(path, 'r');
  try {
    read = readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }

  const probe = buf.subarray(0, read);
  const lastNl = probe.lastIndexOf(0x0a);
  if (lastNl < 0) {
    // A single very long partial line. Treat it as historical and skip it
    // rather than allocating/parsing the whole file just to preserve a tail.
    return { newOffset: size, pendingTail: '' };
  }

  const pendingTail = probe.subarray(lastNl + 1).toString('utf8');
  return {
    newOffset: start + lastNl + 1,
    pendingTail,
  };
}

// ---------------------------------------------------------------------------
// Whole-window forward drain
//
// The `drain*Transcript` functions of the structured-bridge CLIs (claude /
// codex / traex / antigravity / ebsd / omp / pi / grok) all open with the same
// preamble: stat the file, decide what a shrunk file means, read
// `[start, size)` in one go, cut it at the last '\n' and walk the complete
// lines with a running byte cursor. It lives here so the contract (byte-offset
// frontier, partial tail, offset arithmetic for non-ASCII lines) has exactly
// one implementation. Cursor is the exception: its mirror truncates and
// rewrites a trailing status footer, so a stale offset can land inside a
// multi-byte character — drainCursorTranscript walks raw 0x0a positions
// instead of re-encoding decoded text.
//
// Deliberately kept apart from `scanJsonlFromOffset`: that scanner is chunked,
// opens with O_NONBLOCK and fails closed to `null`; these drains read the
// whole stat-bounded window and let fs errors propagate, exactly like the
// per-file copies they replaced.
// ---------------------------------------------------------------------------

export interface JsonlDrainWindow {
  /** First byte read: `fromOffset`, or 0 after a truncation reset. */
  start: number;
  /** File size observed by the stat that bounded the read. */
  size: number;
  /** Complete lines only — ends with '\n', or '' when no '\n' was read. */
  completeText: string;
  /** Text after the last '\n' (a half-written line, or the whole window when
   *  it holds no '\n'). Never parsed; the next drain re-reads it. */
  pendingTail: string;
  /** `start` + UTF-8 byte length of `completeText`: the durable frontier. */
  newOffset: number;
}

/** Read `[start, size)` of `path` and cut it at the last '\n'. When the file
 *  has nothing past `start` the window is empty and `newOffset` stays `start`.
 *  fs errors propagate to the caller. */
export function readJsonlWindow(path: string, start: number, size: number): JsonlDrainWindow {
  if (size <= start) {
    return { start, size, completeText: '', pendingTail: '', newOffset: start };
  }
  const len = size - start;
  const buf = Buffer.alloc(len);
  let read = 0;
  const fd = openSync(path, 'r');
  try {
    read = readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  // `subarray(0, read)`: a short read (file truncated between stat and read)
  // must not leak the zero-filled remainder of `buf` into the text.
  const text = buf.subarray(0, read).toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  const completeText = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
  const pendingTail = lastNl >= 0 ? text.slice(lastNl + 1) : text;
  return {
    start,
    size,
    completeText,
    pendingTail,
    newOffset: start + Buffer.byteLength(completeText, 'utf8'),
  };
}

export interface JsonlDrainOptions {
  /** What `size < fromOffset` (rotated / rewritten file) means.
   *  - 'reset' (default): re-read from byte 0.
   *  - 'hold': read nothing and keep `fromOffset`, waiting for the file to
   *    grow past the consumed byte (for mirrors that briefly shrink while
   *    they rewrite, where replaying history would pollute attribution). */
  onShrink?: 'reset' | 'hold';
  /** Offset reported when the file does not exist. 'zero' (default) tells the
   *  caller "nothing yet"; 'keep' echoes `fromOffset`. */
  missingOffset?: 'zero' | 'keep';
}

export type JsonlDrainStep =
  /** New bytes were read; `window` holds the split text. */
  | { kind: 'read'; start: number; reset: boolean; window: JsonlDrainWindow }
  /** The file is caught up (`size === start`); `window` is empty. Callers that
   *  have idle-time work (releasing a held candidate) branch on this. */
  | { kind: 'idle'; start: number; reset: boolean; window: JsonlDrainWindow; newOffset: number }
  /** Nothing readable: file missing, stat failed, or shrunk under 'hold'.
   *  `newOffset` is the offset the caller should report back. */
  | { kind: 'skip'; reason: 'missing' | 'unreadable' | 'shrunk'; newOffset: number };

/** Shared preamble of the `drain*` functions: existence check, stat, shrink
 *  policy, then {@link readJsonlWindow}. fs errors from the read propagate. */
export function beginJsonlDrain(path: string, fromOffset: number, opts: JsonlDrainOptions = {}): JsonlDrainStep {
  if (!existsSync(path)) {
    return { kind: 'skip', reason: 'missing', newOffset: opts.missingOffset === 'keep' ? fromOffset : 0 };
  }
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { kind: 'skip', reason: 'unreadable', newOffset: fromOffset };
  }
  let start = fromOffset;
  let reset = false;
  if (size < start) {
    if (opts.onShrink === 'hold') return { kind: 'skip', reason: 'shrunk', newOffset: fromOffset };
    start = 0;
    reset = true;
  }
  const window = readJsonlWindow(path, start, size);
  return size === start
    ? { kind: 'idle', start, reset, window, newOffset: start }
    : { kind: 'read', start, reset, window };
}

export interface JsonlLine {
  /** Non-empty line text without its '\n'. */
  line: string;
  /** Absolute byte offset of the line's first byte. */
  lineStart: number;
  /** Absolute byte offset just past the line's '\n'. */
  lineEnd: number;
}

/** Walk the complete lines of a {@link JsonlDrainWindow} with a running byte
 *  cursor. Empty lines advance the cursor but are not yielded. Offsets use
 *  `Buffer.byteLength` of the decoded line, matching `newOffset`'s arithmetic. */
export function* iterateJsonlLines(completeText: string, start: number): Generator<JsonlLine> {
  let cursor = start;
  for (const line of completeText.split('\n')) {
    if (line.length === 0) {
      cursor += 1; // the '\n' after an empty line (and the split's trailing '')
      continue;
    }
    const lineStart = cursor;
    cursor += Buffer.byteLength(line, 'utf8') + 1; // include '\n'
    yield { line, lineStart, lineEnd: cursor };
  }
}

// ---------------------------------------------------------------------------
// Backward (newest-first) scan
// ---------------------------------------------------------------------------

export interface JsonlBackwardScanOptions {
  /** Scan the byte range `[floor, endOffset)`. `endOffset` must sit on a line
   *  boundary (one past a '\n', or EOF). */
  endOffset: number;
  /** Lowest byte offset to read. Default 0. */
  floor?: number;
  /** Read granularity. Default 64 KiB. */
  chunkBytes?: number;
  /** Treat the leading fragment at a non-zero `floor` as a truncated
   *  historical partial and drop it instead of reporting it as a line. Use for
   *  byte-capped scans whose floor is an arbitrary offset; leave unset when
   *  `floor` is a known line boundary (e.g. a turn start). At `floor === 0`
   *  the first record is always complete and is always reported. */
  dropPartialAtFloor?: boolean;
  /** Called newest-first with each non-empty line's bytes and absolute start
   *  offset. Return `true` to stop the scan. */
  onLine: (line: Buffer, lineStart: number) => boolean | void;
}

/**
 * Backward scan over a caller-owned regular-file descriptor (the fd is never
 * closed here). Use this when the caller needs fd-level hardening of its own —
 * O_NOFOLLOW / O_NONBLOCK, `fstat` on the opened fd, sizing the range from that
 * fstat — before scanning. See {@link scanJsonlBackward} for the contract.
 *
 * @returns `true` if `onLine` stopped the scan, `false` if the range was
 *          exhausted.
 */
export function scanJsonlBackwardFd(fd: number, opts: JsonlBackwardScanOptions): boolean {
  const floor = Math.max(0, opts.floor ?? 0);
  const chunkBytes = opts.chunkBytes ?? JSONL_SCAN_CHUNK_BYTES;
  let end = opts.endOffset;
  let carry: Buffer = Buffer.alloc(0);
  while (end > floor) {
    const start = Math.max(floor, end - chunkBytes);
    const chunk = Buffer.alloc(end - start);
    readSync(fd, chunk, 0, chunk.length, start);
    const block = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
    let lineEnd = block.length;
    let carryEnd = lineEnd;
    for (let i = lineEnd - 1; i >= 0; i--) {
      if (block[i] !== 0x0a) continue;
      if (lineEnd > i + 1 && opts.onLine(block.subarray(i + 1, lineEnd), start + i + 1) === true) return true;
      lineEnd = i;
      carryEnd = i;
    }
    carry = start === floor && floor > 0 && opts.dropPartialAtFloor
      ? Buffer.alloc(0)
      : block.subarray(0, carryEnd);
    end = start;
  }
  // Whatever precedes the first '\n' of the range starts at `floor`.
  return carry.length > 0 && opts.onLine(carry, floor) === true;
}

/**
 * Read a JSONL file backwards in fixed-size chunks, handing complete lines to
 * `onLine` newest-first. Memory is bounded by one chunk plus the longest line
 * crossing a chunk edge, so an arbitrarily large rollout is never loaded whole.
 *
 * Opens with a plain read-only fd and closes it before returning. fs errors
 * propagate — callers decide what a failed scan means (empty result, partial
 * result) in their own `catch`, which is what the hand-rolled loops did.
 *
 * @returns `true` if `onLine` stopped the scan, `false` if the range was
 *          exhausted.
 */
export function scanJsonlBackward(path: string, opts: JsonlBackwardScanOptions): boolean {
  const fd = openSync(path, 'r');
  try {
    return scanJsonlBackwardFd(fd, opts);
  } finally {
    closeSync(fd);
  }
}
