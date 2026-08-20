import { closeSync, existsSync, openSync, readSync, statSync, type Stats } from 'node:fs';

/**
 * PM2-client-free log tailing for `botmux logs`.
 *
 * `pm2 logs` is a PM2 client, and any PM2 client invoked with no live God
 * lazily births one (pm2 Client.start → pingDaemon false → launchDaemon).
 * That made the read command a check/use race against `restart
 * --include-pm2`: a God observed under the fleet lock could be retired after
 * the lock released but before the spawned client connected, and the
 * connecting client would then create a replacement God inside the
 * kill→start window. Tailing the log FILES pm2 itself writes removes the PM2
 * client entirely — no interleaving of this command can create a God, and
 * logs keep working while the fleet is stopped.
 */

export interface LogTailSource {
  /** Display label, e.g. the PM2 process name. */
  label: string;
  stream: 'out' | 'err';
  file: string;
}

export function formatLogLine(source: LogTailSource, line: string): string {
  return `${source.label}${source.stream === 'err' ? ' (err)' : ''} | ${line}`;
}

/** Last `n` complete lines of a text chunk (trailing newline ignored). */
export function lastLinesOfChunk(chunk: string, n: number): string[] {
  if (n <= 0) return [];
  const all = chunk.split('\n');
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  return all.slice(Math.max(0, all.length - n));
}

// Initial `--lines` window: start small and grow until the window holds
// enough complete lines (or the whole file / a hard cap), so a large N is
// honored instead of silently clipped by a fixed window.
const INITIAL_TAIL_WINDOW_BYTES = 64 * 1024;
const MAX_TAIL_WINDOW_BYTES = 8 * 1024 * 1024;

function readFileRange(file: string, start: number, end: number): string {
  const length = end - start;
  if (length <= 0) return '';
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Tail window ending at `size`, aligned to a line start (or BOF). */
function readAlignedTailWindow(file: string, size: number, wantLines: number): string {
  for (let window = INITIAL_TAIL_WINDOW_BYTES; ; window *= 2) {
    const start = Math.max(0, size - window);
    const chunk = readFileRange(file, start, size);
    if (start === 0) return chunk;
    const newlineCount = chunk.split('\n').length - 1;
    // Need wantLines complete lines AFTER dropping the leading partial line a
    // mid-file window start produces (plus a possible unterminated tail).
    if (newlineCount > wantLines + 1 || window >= MAX_TAIL_WINDOW_BYTES) {
      return chunk.slice(chunk.indexOf('\n') + 1);
    }
  }
}

interface FollowState {
  source: LogTailSource;
  /** Next byte offset to read from; undefined until the file first appears. */
  offset: number | undefined;
  /** Trailing partial (unterminated) line carried between polls. */
  partial: string;
  /** File generation identity; a change means the path was atomically
   *  replaced (rotation) even when the new size passes every offset check. */
  dev: number | undefined;
  ino: number | undefined;
}

export interface LogFileFollowerOptions {
  sources: readonly LogTailSource[];
  writeLine: (formatted: string) => void;
  pollIntervalMs?: number;
}

/**
 * Print the last N lines of every existing source, then follow appends.
 * Correctness boundaries this models explicitly:
 *  - An unterminated trailing line is NEVER emitted as a line; it is carried
 *    as `partial` (from the initial tail too) and emitted once completed, so
 *    "abc" + later "def\n" prints one "abcdef" line.
 *  - Atomic rotation (rename + recreate at the same path) is detected by
 *    dev+ino generation identity, not by size heuristics — a new file whose
 *    size already exceeds the old offset would otherwise be read mid-stream.
 *    (On filesystems reporting ino=0 this degrades to the size checks.)
 *  - In-place truncation (`pm2 flush`) resets to the top of the new content.
 *  - Files may appear later (fleet starts while tailing) or disappear.
 */
export class LogFileFollower {
  private readonly states: FollowState[];
  private readonly writeLine: (formatted: string) => void;
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: LogFileFollowerOptions) {
    this.states = opts.sources.map(source => ({
      source, offset: undefined, partial: '', dev: undefined, ino: undefined,
    }));
    this.writeLine = opts.writeLine;
    this.pollIntervalMs = opts.pollIntervalMs ?? 300;
  }

  /** Emit the initial `--lines` window and position offsets at end-of-file. */
  printInitialTail(lines: number): void {
    for (const state of this.states) {
      if (!existsSync(state.source.file)) continue;
      let stats: Stats;
      try { stats = statSync(state.source.file); } catch { continue; }
      let chunk: string;
      try { chunk = readAlignedTailWindow(state.source.file, stats.size, lines); } catch { continue; }
      let complete = chunk;
      if (chunk.length > 0 && !chunk.endsWith('\n')) {
        const cut = chunk.lastIndexOf('\n');
        state.partial = chunk.slice(cut + 1);
        complete = cut >= 0 ? chunk.slice(0, cut + 1) : '';
      }
      for (const line of lastLinesOfChunk(complete, lines)) {
        this.writeLine(formatLogLine(state.source, line));
      }
      state.offset = stats.size;
      state.dev = stats.dev;
      state.ino = stats.ino;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pollOnce(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll pass; exposed so tests can drive it deterministically. */
  pollOnce(): void {
    for (const state of this.states) {
      let stats: Stats;
      try {
        stats = statSync(state.source.file);
      } catch {
        // Absent (not yet created, or rotated away): forget position so the
        // file is picked up from its start when it (re)appears.
        state.offset = undefined;
        state.partial = '';
        state.dev = undefined;
        state.ino = undefined;
        continue;
      }
      const sameGeneration = state.dev === stats.dev && state.ino === stats.ino;
      if (state.offset === undefined || !sameGeneration) {
        // Newly appeared file, or an atomic replace under the same path:
        // this is a different byte stream, so any carried position/partial
        // belongs to the OLD generation and must be dropped unconditionally.
        state.offset = 0;
        state.partial = '';
      } else if (stats.size < state.offset) {
        // Truncated in place (pm2 flush): restart from the top of the new
        // content instead of replaying or reading past EOF.
        state.offset = 0;
        state.partial = '';
      }
      state.dev = stats.dev;
      state.ino = stats.ino;
      if (stats.size === state.offset) continue;
      let chunk: string;
      try { chunk = readFileRange(state.source.file, state.offset, stats.size); } catch { continue; }
      state.offset = stats.size;
      const combined = state.partial + chunk;
      const parts = combined.split('\n');
      state.partial = parts.pop() ?? '';
      for (const line of parts) {
        this.writeLine(formatLogLine(state.source, line));
      }
    }
  }
}
