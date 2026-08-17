import {
  appendFileSync,
  chmodSync,
  close,
  createWriteStream,
  fchmod,
  open,
  mkdirSync,
  type WriteStream,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Deliberately narrow audit vocabulary.  A record identifies who acted on
 * which session and when, but can never carry terminal bytes, URLs, cookies,
 * authorization codes, or capability tokens. `audit.dropped` is the sink's own
 * bookkeeping: it marks that N earlier best-effort records were discarded under
 * backpressure, so gaps in the file are visible instead of silent.
 */
export type ControlAuditAction =
  | 'auth.login'
  | 'auth.login_denied'
  | 'auth.logout'
  | 'terminal.takeover'
  | 'terminal.takeover_reused'
  | 'terminal.release'
  | 'terminal.expired'
  | 'terminal.disconnected'
  | 'terminal.input'
  | 'preview.unlock'
  | 'preview.activity'
  | 'preview.lock'
  | 'preview.idle_relock'
  | 'preview.session_relock'
  /** P1-13：预览目标本身失效（worker 换代 / 会话关闭 / 端口易主）导致的收回。 */
  | 'preview.target_relock'
  | 'audit.dropped';

export interface ControlAuditRecord {
  timestamp: string;
  user: string;
  session: string;
  action: ControlAuditAction;
  /** Optional non-sensitive count for input auditing. Input content is never retained. */
  bytes?: number;
  /** Only on `audit.dropped` markers: how many queued records were discarded. */
  dropped?: number;
}

export interface ControlAuditSink {
  append(record: ControlAuditRecord): void;
}

export interface FileControlAuditSinkOptions {
  path?: string;
}

export function defaultControlAuditPath(): string {
  return process.env.BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH?.trim()
    || join(homedir(), '.botmux', 'audit', 'dashboard-control.ndjson');
}

function safeAuditIdentity(value: string, fallback: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\r\n\0]/.test(normalized)) return fallback;
  return normalized;
}

export function controlAuditRecord(
  user: string,
  session: string,
  action: ControlAuditAction,
  opts: { now?: Date; bytes?: number } = {},
): ControlAuditRecord {
  const bytes = opts.bytes;
  return {
    timestamp: (opts.now ?? new Date()).toISOString(),
    user: safeAuditIdentity(user, 'unknown'),
    session: safeAuditIdentity(session, 'dashboard'),
    action,
    ...(Number.isSafeInteger(bytes) && (bytes as number) >= 0 ? { bytes } : {}),
  };
}

/**
 * Append-only 0600 NDJSON sink. `appendFileSync` issues one O_APPEND write per
 * compact record, so workers may safely share the file without a read/modify/
 * rename race. Audit failures are intentionally non-fatal to terminal I/O;
 * callers may inject a strict sink in deployments that require fail-closed
 * accounting.
 */
export class FileControlAuditSink implements ControlAuditSink {
  private readonly path: string;

  constructor(opts: FileControlAuditSinkOptions = {}) {
    this.path = opts.path ?? defaultControlAuditPath();
  }

  append(record: ControlAuditRecord): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(this.path, 0o600); } catch { /* best effort after append */ }
  }
}

/**
 * Backpressure cap for the async sink's in-memory queue. While the stream is
 * still opening or `write()` has signalled backpressure, at most this many
 * records wait in memory; older ones are dropped (and counted) first, so a
 * slow/NFS disk under sustained terminal input can never turn into unbounded
 * heap growth.
 */
export const AUDIT_ASYNC_MAX_PENDING = 2_000;

/** The minimal stream surface the async sink relies on. Structurally satisfied
 *  by `fs.WriteStream`; tests inject a hand-rolled fake to steer `write()`'s
 *  return value and fire `drain` deterministically. */
export interface AuditStreamLike {
  write(chunk: string, encoding: BufferEncoding): boolean;
  once(event: 'drain', listener: () => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

export interface AsyncFileControlAuditSinkOptions extends FileControlAuditSinkOptions {
  /** Queue cap override (tests use a small value). Defaults to {@link AUDIT_ASYNC_MAX_PENDING}. */
  maxPending?: number;
  /** Test seam: bypass the filesystem and adopt the provided stream instead. */
  streamFactory?: () => Promise<AuditStreamLike | undefined>;
}

/**
 * High-frequency, best-effort sink for terminal input counters. Directory and
 * permissions are established exactly once, then compact records are queued to
 * one O_APPEND stream so a slow/NFS home directory never blocks the worker's
 * PTY event loop for every keystroke. Security-boundary actions keep using the
 * synchronous FileControlAuditSink above so takeover can remain fail-closed.
 *
 * Backpressure contract: `append()` always returns synchronously (the audit is
 * a fire-and-forget side channel — it must never block or slow the caller).
 * When `write()` returns false the sink stops writing until `drain`; arriving
 * records queue up to {@link AUDIT_ASYNC_MAX_PENDING}, beyond which the oldest
 * are dropped and counted. Once writing resumes, an `audit.dropped` marker
 * record lands first so the gap is visible in the file.
 */
export class AsyncFileControlAuditSink implements ControlAuditSink {
  private readonly path: string;
  private readonly maxPending: number;
  private readonly streamFactory?: () => Promise<AuditStreamLike | undefined>;
  private stream: AuditStreamLike | undefined;
  private opening: Promise<AuditStreamLike | undefined> | undefined;
  private pending: string[] = [];
  private droppedCount = 0;
  private waitingDrain = false;
  private unavailable = false;

  constructor(opts: AsyncFileControlAuditSinkOptions = {}) {
    this.path = opts.path ?? defaultControlAuditPath();
    this.maxPending = Math.max(1, Math.floor(opts.maxPending ?? AUDIT_ASYNC_MAX_PENDING));
    this.streamFactory = opts.streamFactory;
  }

  append(record: ControlAuditRecord): void {
    if (this.unavailable) return;
    this.enqueue(`${JSON.stringify(record)}\n`);
    if (this.stream) {
      this.flush();
      return;
    }
    void (this.opening ??= this.openStream()).then(() => this.flush());
  }

  /** Queue with the cap enforced: drop-oldest keeps the freshest records and
   *  bounds memory no matter how long the disk stalls. */
  private enqueue(line: string): void {
    this.pending.push(line);
    while (this.pending.length > this.maxPending) {
      this.pending.shift();
      this.droppedCount += 1;
    }
  }

  /** Drain the queue onto the stream until it pushes back. Synchronous; safe to
   *  call at any time (no-ops while unavailable, still opening, or awaiting
   *  `drain`). The dropped-marker goes out first — everything it accounts for
   *  is older than every surviving queued record. */
  private flush(): void {
    const stream = this.stream;
    if (!stream || this.unavailable || this.waitingDrain) return;
    while (this.droppedCount > 0 || this.pending.length > 0) {
      const line = this.droppedCount > 0 ? this.takeDroppedMarker() : this.pending.shift()!;
      // Node buffers the chunk even when write() returns false, so `line` is
      // never lost here — false only means "stop sending until drain".
      if (!stream.write(line, 'utf8')) {
        this.waitingDrain = true;
        stream.once('drain', () => {
          this.waitingDrain = false;
          this.flush();
        });
        return;
      }
    }
  }

  private takeDroppedMarker(): string {
    const dropped = this.droppedCount;
    this.droppedCount = 0;
    const marker: ControlAuditRecord = {
      timestamp: new Date().toISOString(),
      user: 'system',
      session: 'audit',
      action: 'audit.dropped',
      dropped,
    };
    return `${JSON.stringify(marker)}\n`;
  }

  private markUnavailable(): void {
    this.unavailable = true;
    // Free the queue: nothing will ever drain it once the sink is dead.
    this.pending.length = 0;
    this.droppedCount = 0;
  }

  private async openStream(): Promise<AuditStreamLike | undefined> {
    try {
      const stream = this.streamFactory ? await this.streamFactory() : await this.openFileStream();
      if (!stream) {
        this.markUnavailable();
        return undefined;
      }
      stream.on('error', () => {
        this.markUnavailable();
        // autoClose owns the descriptor once the stream is constructed.
        // Closing it again here can race the stream's own error cleanup.
      });
      this.stream = stream;
      return stream;
    } catch {
      this.markUnavailable();
      return undefined;
    }
  }

  private async openFileStream(): Promise<WriteStream> {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const fd = await new Promise<number>((resolve, reject) => {
      open(this.path, 'a', 0o600, (error, value) => error ? reject(error) : resolve(value));
    });
    await new Promise<void>((resolve, reject) => {
      fchmod(fd, 0o600, error => error ? reject(error) : resolve());
    }).catch(error => {
      close(fd, () => {});
      throw error;
    });
    return createWriteStream(this.path, {
      fd,
      flags: 'a',
      autoClose: true,
      encoding: 'utf8',
    });
  }
}

let defaultSink: ControlAuditSink | undefined;

export function appendControlAudit(record: ControlAuditRecord): void {
  try {
    (defaultSink ??= new AsyncFileControlAuditSink()).append(record);
  } catch {
    // Never include the record or underlying error in logs: either could carry
    // an operator-controlled path/identifier. Runtime remains available.
  }
}

/** Test seam; production code should use the default append-only file sink. */
export function setDefaultControlAuditSinkForTest(sink: ControlAuditSink | undefined): void {
  defaultSink = sink;
}
