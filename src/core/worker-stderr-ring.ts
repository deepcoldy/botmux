/**
 * Per-worker bounded in-memory ring of worker stderr lines.
 *
 * When a worker dies at startup the only death cause is whatever it wrote to
 * stderr; piping that straight to the daemon log (see logWorkerStderr in
 * worker-pool.ts) leaves the Lark card with a bare exit code. Each forked
 * worker therefore owns one ring (closure-held, GC'd with the worker):
 *
 *   - normal lines are bounded BOTH by line count (200) and total chars
 *     (~8KB); overflow drops the OLDEST normal lines;
 *   - marker lines (containing WORKER_ERROR_MARKER, or delivered via the
 *     `worker_fatal` IPC) are pinned separately on top with their own bounds
 *     (20 / ~2KB), so a flood of banner/progress output can never evict the
 *     actual fault;
 *   - render() returns cleaned plaintext (ANSI stripped): marker lines first,
 *     then the recent normal tail, with per-call line/char caps.
 *
 * No third-party deps; the stripping itself lives in utils/crash-log.ts.
 */
import { stripAnsiForLog, tailChars } from '../utils/crash-log.js';

export const WORKER_ERROR_MARKER = '[botmux-worker-error]';

export const MAX_NORMAL_LINES = 200;
export const MAX_NORMAL_CHARS = 8192;
export const MAX_MARKER_LINES = 20;
export const MAX_MARKER_CHARS = 2048;

export interface WorkerStderrRenderOptions {
  /** Cap on the NORMAL tail; pinned marker lines are rendered on top
   *  independently of this cap. Defaults to the storage line bound. */
  maxLines?: number;
  /** Total rendered-text char cap; normal lines are trimmed oldest-first
   *  before pinned marker lines. Defaults to the normal storage char bound. */
  maxChars?: number;
}

export interface WorkerStderrRing {
  /** Buffer one stderr line; lines carrying WORKER_ERROR_MARKER are pinned. */
  push(line: string): void;
  /** Buffer a line as a pinned marker without needing the marker literal
   *  (e.g. a structured `worker_fatal` IPC message). */
  pushMarker(line: string): void;
  /** Render pinned markers first, then the recent normal tail. */
  render(options?: WorkerStderrRenderOptions): string;
}

/**
 * Enforce both bounds on a FIFO line store, dropping oldest lines first.
 * A single oversized line is never evicted into an empty store: the render
 * char cap is what truncates it, and dropping the only line would lose the
 * fault entirely.
 */
function enforceCap(lines: string[], maxLines: number, maxChars: number): void {
  while (lines.length > maxLines) lines.shift();
  let total = lines.reduce((sum, line) => sum + line.length, 0);
  while (lines.length > 1 && total > maxChars) {
    total -= lines.shift()!.length;
  }
}

export function createWorkerStderrRing(): WorkerStderrRing {
  const normals: string[] = [];
  const markers: string[] = [];

  function push(line: string): void {
    const trimmed = line?.trim();
    if (!trimmed) return;
    if (trimmed.includes(WORKER_ERROR_MARKER)) {
      pushMarker(trimmed);
      return;
    }
    normals.push(trimmed);
    enforceCap(normals, MAX_NORMAL_LINES, MAX_NORMAL_CHARS);
  }

  function pushMarker(line: string): void {
    const trimmed = line?.trim();
    if (!trimmed) return;
    markers.push(trimmed);
    enforceCap(markers, MAX_MARKER_LINES, MAX_MARKER_CHARS);
  }

  function render(options: WorkerStderrRenderOptions = {}): string {
    const maxLines = options.maxLines ?? MAX_NORMAL_LINES;
    const maxChars = options.maxChars ?? MAX_NORMAL_CHARS;

    const markerLines = markers
      .map(stripAnsiForLog)
      .flatMap(text => (text ? text.split('\n') : []));
    const normalLines = normals
      .slice(-maxLines)
      .map(stripAnsiForLog)
      .flatMap(text => (text ? text.split('\n') : []));

    const join = (): string =>
      [...markerLines, ...normalLines].filter(Boolean).join('\n');

    let out = join();
    // Total char cap: sacrifice oldest NORMAL lines first so pinned markers
    // survive as long as possible.
    while (normalLines.length > 1 && out.length > maxChars) {
      normalLines.shift();
      out = join();
    }
    // One oversized normal line left: drop it outright when markers survive
    // anyway; with no markers, keep it and let the tailChars guard truncate.
    if (normalLines.length === 1 && markerLines.length > 0 && out.length > maxChars) {
      normalLines.shift();
      out = join();
    }
    // Markers alone overflow (many/large pinned faults): drop oldest markers,
    // but keep at least one — a single oversized line is truncated by the
    // tailChars guard below rather than discarded outright.
    while (markerLines.length > 1 && out.length > maxChars) {
      markerLines.shift();
      out = join();
    }
    // A single oversized surviving line: hard-tail the finished text.
    if (out.length > maxChars) out = tailChars(out, maxChars);
    return out;
  }

  return { push, pushMarker, render };
}
