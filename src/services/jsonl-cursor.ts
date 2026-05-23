import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

export interface JsonlCursor {
  newOffset: number;
  pendingTail: string;
}

const TAIL_PROBE_BYTES = 64 * 1024;

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

  const text = buf.subarray(0, read).toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) {
    // A single very long partial line. Treat it as historical and skip it
    // rather than allocating/parsing the whole file just to preserve a tail.
    return { newOffset: size, pendingTail: '' };
  }

  const pendingTail = text.slice(lastNl + 1);
  return {
    newOffset: start + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8'),
    pendingTail,
  };
}
