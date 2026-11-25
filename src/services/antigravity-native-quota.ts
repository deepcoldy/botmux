import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { antigravitySessionLogPath } from './antigravity-session-fork.js';

const NATIVE_LOG_CHUNK_BYTES = 256 * 1024;
const NATIVE_LOG_FRONTIER_BYTES = 64 * 1024;
const USER_INPUT_FILE_MARKER = 'input_loop.go:';
const USER_INPUT_CALL_MARKER = 'HandleUserInput called with text: ';
const EXECUTOR_ERROR_MARKER = 'agent executor error:';
const TRANSPORT_EXHAUSTED_MARKER = 'transport error (ResourceExhausted, HTTP 429)';
const RESOURCE_EXHAUSTED_CODE_MARKER = 'RESOURCE_EXHAUSTED (code 429)';
const QUOTA_TEXT_MARKER = 'Individual quota reached.';
const GLOG_TIMESTAMP_RE = /^([A-Z](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d+))/;

export interface AntigravityNativeQuotaRefusal {
  readonly nativeEpisodeKey: `log:${string}`;
  /** Substring starting at `Individual quota reached.` for reset-duration parsing. */
  readonly text: string;
  /** Monotonic `HandleUserInput` sequence number observed before this refusal. */
  readonly inputSequence: number;
  /** Epoch milliseconds parsed from the glog timestamp (local time, closest year). */
  readonly refusalAtMs?: number;
}

export interface AntigravityNativeLogState {
  inputSequence: number;
  latestInput?: { readonly sequence: number; readonly text: string };
  quota?: AntigravityNativeQuotaRefusal;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function parseNativeUserInput(line: string): string | undefined {
  if (!line.includes(USER_INPUT_FILE_MARKER)) return undefined;
  const idx = line.indexOf(USER_INPUT_CALL_MARKER);
  if (idx < 0) return undefined;
  const rawJson = line.slice(idx + USER_INPUT_CALL_MARKER.length).trim();
  if (!rawJson.startsWith('"')) return undefined;
  try {
    const parsed = JSON.parse(rawJson);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseGlogTimestampMs(match: RegExpExecArray, nowMs = Date.now()): number | undefined {
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fracStr = (match[7] ?? '').slice(0, 3).padEnd(3, '0');
  const ms = Number(fracStr);
  if (
    month < 1 || month > 12 || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59 || !Number.isFinite(ms)
  ) {
    return undefined;
  }
  const nowYear = new Date(nowMs).getFullYear();
  let bestMs: number | undefined;
  let bestDelta = Infinity;
  for (const year of [nowYear - 1, nowYear, nowYear + 1]) {
    const candidate = new Date(year, month - 1, day, hour, minute, second, ms);
    if (candidate.getMonth() !== month - 1 || candidate.getDate() !== day) continue;
    const t = candidate.getTime();
    const delta = Math.abs(t - nowMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestMs = t;
    }
  }
  return bestMs;
}

function parseNativeQuotaRefusal(
  line: string,
  inputSequence: number,
  nowMs = Date.now(),
): AntigravityNativeQuotaRefusal | undefined {
  if (
    !line.includes(EXECUTOR_ERROR_MARKER)
    || !line.includes(TRANSPORT_EXHAUSTED_MARKER)
    || !line.includes(RESOURCE_EXHAUSTED_CODE_MARKER)
  ) {
    return undefined;
  }
  const quotaIdx = line.indexOf(QUOTA_TEXT_MARKER);
  if (quotaIdx < 0) return undefined;
  const tsMatch = GLOG_TIMESTAMP_RE.exec(line);
  if (!tsMatch) return undefined;
  const refusalAtMs = parseGlogTimestampMs(tsMatch, nowMs);
  return {
    nativeEpisodeKey: `log:${tsMatch[1]!}`,
    text: line.slice(quotaIdx).trim(),
    inputSequence,
    ...(refusalAtMs !== undefined ? { refusalAtMs } : {}),
  };
}

/** Pure line reducer for `agy --log-file` glog lines. */
export function ingestAntigravityNativeLogLine(
  state: AntigravityNativeLogState,
  rawLine: string,
): void {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (!line) return;

  const userInput = parseNativeUserInput(line);
  if (userInput !== undefined) {
    state.inputSequence += 1;
    state.latestInput = { sequence: state.inputSequence, text: userInput };
    state.quota = undefined;
    return;
  }

  const quota = parseNativeQuotaRefusal(line, state.inputSequence);
  if (quota) {
    state.quota = quota;
  }
}

/** Correlate the latest executor quota refusal with the latest native user input
 *  (and, when known by the worker, the exact CRLF-normalized written input). */
export function currentAntigravityNativeQuota(
  state: Readonly<AntigravityNativeLogState>,
  currentInput?: string,
): AntigravityNativeQuotaRefusal | undefined {
  const { quota, latestInput } = state;
  if (!quota || !latestInput) return undefined;
  if (quota.inputSequence !== latestInput.sequence) return undefined;
  if (
    currentInput !== undefined
    && normalizeLineEndings(latestInput.text) !== normalizeLineEndings(currentInput)
  ) {
    return undefined;
  }
  return quota;
}

/** Process-scoped incremental reader for `agy --log-file`.
 *
 *  Starts at byte 0 on initial/reset read and drains to EOF in 256 KiB chunks
 *  using a persistent `StringDecoder('utf8')` so multi-byte characters split
 *  across chunk boundaries never corrupt `HandleUserInput` payloads. Resets
 *  unconditionally on inode change, truncation (`size < offset`), a changed
 *  consumed-byte frontier, or an mtime/ctime generation change at unchanged EOF
 *  (the latter catches same-size rewrites whose tail happens to match), plus
 *  explicit `reset()` on process spawn/kill. */
export class AntigravityNativeQuotaLog {
  readonly path: string;
  private inode: string | undefined;
  private offset = 0;
  private tail = '';
  private decoder = new StringDecoder('utf8');
  private frontier = Buffer.alloc(0);
  private observedVersion: { mtimeNs: bigint; ctimeNs: bigint } | undefined;
  private state: AntigravityNativeLogState = { inputSequence: 0 };

  constructor(sessionId: string, root?: string) {
    this.path = antigravitySessionLogPath(sessionId, root);
  }

  private restart(inode?: string): void {
    this.inode = inode;
    this.offset = 0;
    this.tail = '';
    this.decoder = new StringDecoder('utf8');
    this.frontier = Buffer.alloc(0);
    this.observedVersion = undefined;
    this.state = { inputSequence: 0 };
  }

  reset(): void {
    this.restart();
  }

  /** Verify bytes immediately before the consumed offset on the same opened fd.
   * Size alone cannot detect copytruncate/O_TRUNC followed by rapid regrow. */
  private frontierMatches(fd: number): boolean {
    if (this.offset === 0) return this.frontier.length === 0;
    const expected = this.frontier;
    if (expected.length === 0) return false;
    const actual = Buffer.allocUnsafe(expected.length);
    const position = this.offset - expected.length;
    let filled = 0;
    while (filled < expected.length) {
      const n = readSync(fd, actual, filled, expected.length - filled, position + filled);
      if (n <= 0) return false;
      filled += n;
    }
    return actual.equals(expected);
  }

  private rememberFrontier(bytes: Buffer): void {
    if (bytes.length >= NATIVE_LOG_FRONTIER_BYTES) {
      this.frontier = Buffer.from(bytes.subarray(bytes.length - NATIVE_LOG_FRONTIER_BYTES));
      return;
    }
    const combined = Buffer.concat([this.frontier, bytes]);
    this.frontier = combined.length > NATIVE_LOG_FRONTIER_BYTES
      ? Buffer.from(combined.subarray(combined.length - NATIVE_LOG_FRONTIER_BYTES))
      : combined;
  }

  read(): Readonly<AntigravityNativeLogState> {
    let fd: number | undefined;
    try {
      fd = openSync(this.path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile()) return this.state;
      const size = Number(stat.size);
      if (!Number.isSafeInteger(size) || size < 0) {
        this.restart(`${stat.dev}:${stat.ino}`);
        return this.state;
      }

      const inode = `${stat.dev}:${stat.ino}`;
      const version = { mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
      const rewrittenWithoutGrowth = size === this.offset && this.offset > 0
        && this.observedVersion !== undefined
        && (version.mtimeNs !== this.observedVersion.mtimeNs
          || version.ctimeNs !== this.observedVersion.ctimeNs);
      if (inode !== this.inode || size < this.offset || rewrittenWithoutGrowth) {
        this.restart(inode);
      } else if (this.offset > 0 && !this.frontierMatches(fd)) {
        this.restart(inode);
      }
      this.observedVersion = version;

      if (size === this.offset) return this.state;

      const chunkBuf = Buffer.allocUnsafe(Math.min(NATIVE_LOG_CHUNK_BYTES, Math.max(1, size - this.offset)));
      while (this.offset < size) {
        const toRead = Math.min(chunkBuf.length, size - this.offset);
        const bytesRead = readSync(fd, chunkBuf, 0, toRead, this.offset);
        if (bytesRead <= 0) break;
        const bytes = chunkBuf.subarray(0, bytesRead);
        this.offset += bytesRead;
        this.rememberFrontier(bytes);
        const decoded = this.decoder.write(bytes);
        if (!decoded) continue;
        const lines = (this.tail + decoded).split('\n');
        this.tail = lines.pop() ?? '';
        for (const line of lines) {
          ingestAntigravityNativeLogLine(this.state, line);
        }
      }
    } catch {
      // Log file may not exist yet or may be mid-rotation.
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
    return this.state;
  }
}
