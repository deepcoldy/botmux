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
