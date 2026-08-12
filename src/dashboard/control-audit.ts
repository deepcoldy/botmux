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
 * authorization codes, or capability tokens.
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
  | 'preview.session_relock';

export interface ControlAuditRecord {
  timestamp: string;
  user: string;
  session: string;
  action: ControlAuditAction;
  /** Optional non-sensitive count for input auditing. Input content is never retained. */
  bytes?: number;
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
 * High-frequency, best-effort sink for terminal input counters. Directory and
 * permissions are established exactly once, then compact records are queued to
 * one O_APPEND stream so a slow/NFS home directory never blocks the worker's
 * PTY event loop for every keystroke. Security-boundary actions keep using the
 * synchronous FileControlAuditSink above so takeover can remain fail-closed.
 */
export class AsyncFileControlAuditSink implements ControlAuditSink {
  private readonly path: string;
  private stream: WriteStream | undefined;
  private opening: Promise<WriteStream | undefined> | undefined;
  private pending: string[] = [];
  private unavailable = false;

  constructor(opts: FileControlAuditSinkOptions = {}) {
    this.path = opts.path ?? defaultControlAuditPath();
  }

  append(record: ControlAuditRecord): void {
    if (this.unavailable) return;
    const line = `${JSON.stringify(record)}\n`;
    if (this.stream) {
      this.stream.write(line, 'utf8');
      return;
    }
    this.pending.push(line);
    void (this.opening ??= this.openStream()).then(stream => {
      if (!stream) return;
      for (const item of this.pending.splice(0)) stream.write(item, 'utf8');
    });
  }

  private async openStream(): Promise<WriteStream | undefined> {
    try {
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
      const stream = createWriteStream(this.path, {
        fd,
        flags: 'a',
        autoClose: true,
        encoding: 'utf8',
      });
      stream.on('error', () => {
        this.unavailable = true;
        // autoClose owns the descriptor once the stream is constructed.
        // Closing it again here can race the stream's own error cleanup.
      });
      this.stream = stream;
      return stream;
    } catch {
      this.unavailable = true;
      this.pending.length = 0;
      return undefined;
    }
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
