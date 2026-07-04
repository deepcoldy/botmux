import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

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

/**
 * Scan an append-only JSONL file from `fromOffset` using bounded-memory chunked
 * reads. Calls `onLine` for each COMPLETE line, and returns the durable byte
 * frontier plus any trailing partial line text left after the last newline.
 */
export function scanJsonlFromOffset(path: string, fromOffset: number, opts: JsonlScanOptions = {}): JsonlCursor | null {
  const endOffset = opts.endOffset;
  const chunkSize = Math.max(1, opts.chunkSize ?? JSONL_SCAN_CHUNK_BYTES);
  let fd: number | null = null;
  let nextReadOffset = Math.max(0, fromOffset);
  let lineStartOffset = nextReadOffset;
  let carry = '';
  const decoder = new StringDecoder('utf8');
  const buf = Buffer.alloc(chunkSize);

  try {
    fd = openSync(path, 'r');
    while (true) {
      const remaining = endOffset === undefined ? chunkSize : endOffset - nextReadOffset;
      if (remaining <= 0) break;
      const toRead = Math.min(chunkSize, remaining);
      const bytesRead = readSync(fd, buf, 0, toRead, nextReadOffset);
      if (bytesRead <= 0) break;
      nextReadOffset += bytesRead;

      const decoded = decoder.write(buf.subarray(0, bytesRead));
      const text = carry + decoded;
      let searchFrom = 0;
      let currentLineStart = lineStartOffset;
      // carry never contains '\n', so newlines can only appear at or after
      // carry.length — starting there avoids re-scanning a growing carry on
      // every chunk when a single record spans many chunks.
      let nl = text.indexOf('\n', carry.length);
      while (nl >= 0) {
        const line = text.slice(searchFrom, nl);
        opts.onLine?.(line, currentLineStart);
        currentLineStart += Buffer.byteLength(line, 'utf8') + 1;
        searchFrom = nl + 1;
        nl = text.indexOf('\n', searchFrom);
      }
      carry = text.slice(searchFrom);
      lineStartOffset = currentLineStart;
    }
    return {
      newOffset: lineStartOffset,
      pendingTail: carry + decoder.end(),
    };
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
