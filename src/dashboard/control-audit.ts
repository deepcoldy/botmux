import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
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
  now?: () => Date;
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

let defaultSink: ControlAuditSink | undefined;

export function appendControlAudit(record: ControlAuditRecord): void {
  try {
    (defaultSink ??= new FileControlAuditSink()).append(record);
  } catch {
    // Never include the record or underlying error in logs: either could carry
    // an operator-controlled path/identifier. Runtime remains available.
  }
}

/** Test seam; production code should use the default append-only file sink. */
export function setDefaultControlAuditSinkForTest(sink: ControlAuditSink | undefined): void {
  defaultSink = sink;
}
