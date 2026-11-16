import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { traexHistoryMatchDelta } from './traex-transcript.js';

/** Below Linux's per-argument limit and macOS's total exec limit, leaving room
 * for the ordinary launch flags. The worker also checks the final environment. */
export const TRAEX_INITIAL_ARG_MAX_BYTES = 64 * 1024;
const MAX_EXEC_BYTES = 192 * 1024;

export interface TraexInitialDeliveryDecision {
  version?: string;
  platform: string;
  backend: string;
  prompt?: string;
  turnId?: string;
  dataDir?: string;
  resume?: boolean;
  fork?: boolean;
  adopt?: boolean;
  reattach?: boolean;
  startupWork?: boolean;
  wrapper?: boolean;
  sandbox?: boolean;
  durable?: boolean;
  rpc?: boolean;
  quota?: boolean;
  extraArgs?: boolean;
}

/** Opt in only to the native releases exercised by the first-submit probes.
 * Unknown launchers/versions stay on terminal admission; never guess support. */
export function useTraexInitialArg(opts: TraexInitialDeliveryDecision): boolean {
  return ['0.214.1', '0.215.0'].includes(opts.version ?? '')
    && ['linux', 'darwin'].includes(opts.platform)
    && ['pty', 'tmux'].includes(opts.backend)
    && !!opts.prompt && !!opts.turnId && !!opts.dataDir
    && !opts.resume && !opts.fork && !opts.adopt && !opts.reattach
    && !opts.startupWork && !opts.wrapper && !opts.sandbox && !opts.durable
    && !opts.rpc && !opts.quota && !opts.extraArgs
    // Reserve room for the delivery identity, which is added after selection.
    && Buffer.byteLength(opts.prompt, 'utf8') + 512 <= TRAEX_INITIAL_ARG_MAX_BYTES;
}

export function traexInitialExecFits(args: readonly string[], env: NodeJS.ProcessEnv): boolean {
  const sizes = args.map(arg => Buffer.byteLength(arg, 'utf8') + 1);
  const envSizes = Object.entries(env).filter(([, value]) => value !== undefined)
    .map(([key, value]) => Buffer.byteLength(`${key}=${value}`, 'utf8') + 1);
  return [...sizes, ...envSizes].every(size => size < 128 * 1024)
    && [...sizes, ...envSizes].reduce((total, size) => total + size + 8, 0) < MAX_EXEC_BYTES;
}

export interface TraexInitialDeliveryRecord {
  version: 1;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  spawnGeneration: number;
  deliveryId: string;
  promptHash: string;
  /** Includes an unguessable per-delivery marker; never written to logs. */
  content: string;
  historyPath: string;
  historyIdentity?: string;
  baseline: number;
  dispatchedAtMs: number;
  state: 'dispatched' | 'unknown' | 'confirmed';
  cliSessionId?: string;
}

function hash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

function historyIdentity(path: string): { identity?: string; size: number } {
  try {
    const stat = statSync(path);
    return { identity: `${stat.dev}:${stat.ino}`, size: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { size: 0 };
    throw error;
  }
}

/** A write-ahead receipt, not a second input queue. Presence forbids another
 * initial dispatch, including when the process died between fsync and spawn.
 * Existing unsent-input/inflight queues retain ownership of all OTHER inputs. */
export class TraexInitialDelivery {
  readonly path: string;
  private value?: TraexInitialDeliveryRecord;
  private confirmation?: TraexInitialDeliveryRecord;

  constructor(dataDir: string, readonly sessionId: string) {
    this.path = join(dataDir, 'turn-marks', `${sessionId}.traex-initial.json`);
    this.value = this.readReceipt();
  }

  private readReceipt(): TraexInitialDeliveryRecord | undefined {
    let raw: string;
    try { raw = readFileSync(this.path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const parsed = JSON.parse(raw) as TraexInitialDeliveryRecord;
    if (parsed.version !== 1 || parsed.sessionId !== this.sessionId
      || !['dispatched', 'unknown', 'confirmed'].includes(parsed.state)
      || typeof parsed.content !== 'string' || typeof parsed.turnId !== 'string'
      || typeof parsed.deliveryId !== 'string' || typeof parsed.historyPath !== 'string'
      || typeof parsed.promptHash !== 'string' || !Number.isSafeInteger(parsed.spawnGeneration)
      || !Number.isSafeInteger(parsed.baseline) || parsed.baseline < 0
      || !parsed.content.includes(`[BotMux delivery ${parsed.deliveryId}]`)
      || (parsed.state === 'confirmed' && !parsed.cliSessionId)) {
      throw new Error('Invalid TRAE initial-delivery receipt; automatic replay refused');
    }
    return parsed;
  }

  get record(): Readonly<TraexInitialDeliveryRecord> | undefined { return this.value; }
  get pending(): boolean { return !!this.value && this.value.state !== 'confirmed'; }

  owns(prompt: string | undefined, turnId: string | undefined): boolean {
    return !!prompt && !!this.value && turnId === this.value.turnId && hash(prompt) === this.value.promptHash;
  }

  prepare(prompt: string, turnId: string, generation: number, historyPath: string): TraexInitialDeliveryRecord {
    if (this.value) throw new Error('TRAE initial prompt already dispatched; automatic replay refused');
    const baseline = historyIdentity(historyPath);
    const deliveryId = randomUUID();
    return {
      version: 1, sessionId: this.sessionId, turnId, spawnGeneration: generation,
      deliveryId, promptHash: hash(prompt),
      content: `${prompt}\n\n[BotMux delivery ${deliveryId}]`,
      historyPath, historyIdentity: baseline.identity, baseline: baseline.size,
      dispatchedAtMs: Date.now(), state: 'dispatched',
    };
  }

  /** Must complete before invoking a backend that might start the CLI. */
  dispatch(record: TraexInitialDeliveryRecord): void {
    if (this.value || record.sessionId !== this.sessionId) {
      throw new Error('TRAE initial prompt already dispatched; automatic replay refused');
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Two workers can have read "absent" before either one dispatches. Claim
    // the final leaf exclusively, not with last-writer-wins rename. A crash
    // during this first write leaves a partial receipt and fails closed on
    // recovery; it never makes the input eligible for a second dispatch.
    const fd = openSync(this.path, 'wx', 0o600);
    this.value = record;
    try {
      writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const directory = openSync(dirname(this.path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }

  markUnknown(deliveryId: string): void {
    if (!this.value || this.value.deliveryId !== deliveryId || !this.pending) return;
    // A confirmation may already have replaced the leaf before directory
    // fsync failed. Never erase that evidence, including from a stale reader.
    if (this.confirmation) return;
    const persisted = this.readReceipt();
    if (!persisted || persisted.deliveryId !== deliveryId) {
      throw new Error('TRAE initial-delivery receipt changed; state update refused');
    }
    if (persisted.state === 'confirmed') {
      this.confirmation = persisted;
      return;
    }
    this.save({ ...this.value, state: 'unknown' });
  }

  /** Read-only evidence check followed by a durable confirmation. The unique
   * marker + full content match binds a shared-history entry to this dispatch,
   * even on macOS without /proc. Rotation may lose evidence, never authorize
   * replay. A replaced/truncated file starts at zero because the marker is unique. */
  confirm(deliveryId: string): string | undefined {
    const record = this.value;
    if (!record || record.deliveryId !== deliveryId) return;
    if (record.state === 'confirmed') return record.cliSessionId;
    if (this.confirmation) {
      this.save(this.confirmation);
      const nativeId = this.confirmation.cliSessionId;
      this.confirmation = undefined;
      return nativeId;
    }
    const current = historyIdentity(record.historyPath);
    const baseline = current.identity === record.historyIdentity && current.size >= record.baseline
      ? record.baseline : 0;
    const match = traexHistoryMatchDelta(record.historyPath, baseline, record.content);
    if (!match.found || !match.cliSessionId) return;
    // Keep positive evidence across any persistence failure. History may
    // rotate before the retry; the exact match must not be forgotten.
    this.confirmation = { ...record, state: 'confirmed', cliSessionId: match.cliSessionId };
    this.save(this.confirmation);
    this.confirmation = undefined;
    return match.cliSessionId;
  }

  private save(record: TraexInitialDeliveryRecord): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(this.path, `${JSON.stringify(record)}\n`, {
      mode: 0o600, durable: true, followTargetSymlink: false,
    });
    this.value = record;
  }
}
