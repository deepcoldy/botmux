/**
 * Desired state of each WeCom connection under the fleet supervisor:
 * `~/.botmux/wecom/fleet-desired.json`
 *
 *   { "version": 1, "connections": { "<configId>": { "desired": "running" | "stopped", "updatedAt": "<ISO>", "reason"?: "<stop reason>" } } }
 *
 * Only a connection whose desired state is `running` becomes a fleet member, so a
 * connection stopped from the Dashboard or the CLI stays stopped across
 * `botmux restart`, autostart and auto-update. That intent has to outlive every
 * process, hence a file.
 *
 * Three answers are kept apart on purpose:
 *  - `running` / `stopped`: recorded intent;
 *  - `unrecorded`: the file (or the connection's entry) does not exist yet. The
 *    upgrade migration decides these and must be able to tell them from
 *    `stopped`;
 *  - an UNAVAILABLE file (unreadable, not JSON, wrong shape): nobody knows the
 *    intent. Readers get `{ status: 'unavailable' }` instead of an empty map, so
 *    a damaged file can never be read as "every connection is stopped", and
 *    writers refuse to write rather than replace it with a partial map that
 *    would turn every other connection into `unrecorded`. Recovery is manual:
 *    move the file away, after which every connection is `unrecorded`.
 *
 * A `stopped` record may carry a `reason`: the connection was not stopped by a
 * person but by its own gateway, on a failure retrying cannot fix (another
 * client took over the BotID, the platform rejected the bot, …). The gateway
 * records it as soon as it knows the reason, before stopping its core, so
 * `botmux restart`, autostart and crash recovery leave the connection stopped
 * until someone starts it again. Any later write of the connection's state
 * replaces the record and with it the reason: starting it, or an operator's
 * plain stop. The gateway's write is conditional — only over the record it
 * started under — so it never replaces an intent recorded after that.
 *
 * Writes are a locked read-modify-write with an atomic, durable replace.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { withFileLockSync } from '../../../utils/file-lock.js';
import { wecomRoot } from './discovery.js';

export type WecomDesiredState = 'running' | 'stopped';

/**
 * Why a gateway stopped its own connection. Exactly the gateway exit reasons
 * that are not worth retrying (they map to the no-restart exit code when the
 * gateway runs as a fleet member).
 */
export const WECOM_DESIRED_STOP_REASONS = [
  'replaced',
  'authentication_failed',
  'invalid_configuration',
  /** The configuration names a credential environment variable (`secretEnv`)
   *  that is unset or empty in the gateway's environment. Not a broken
   *  configuration: the same file runs where the variable is set. */
  'credential_env_missing',
  'not_configured',
  'instance_busy',
] as const;

export type WecomDesiredStopReason = typeof WECOM_DESIRED_STOP_REASONS[number];

export function isWecomDesiredStopReason(value: unknown): value is WecomDesiredStopReason {
  return (WECOM_DESIRED_STOP_REASONS as readonly unknown[]).includes(value);
}

export interface WecomDesiredRecord {
  desired: WecomDesiredState;
  updatedAt: string;
  /** Only on `stopped`: the connection's gateway stopped it (see the module doc).
   *  Absent: a person stopped it, or it is `running`. */
  reason?: WecomDesiredStopReason;
}

export type WecomDesiredStateSnapshot =
  | { status: 'ok'; connections: ReadonlyMap<string, WecomDesiredRecord> }
  | { status: 'unavailable'; reason: string };

/** Thrown by writers (and by readers that need an answer) when the file exists
 *  but cannot be trusted. */
export class WecomFleetDesiredStateUnavailableError extends Error {
  readonly code = 'WECOM_FLEET_DESIRED_STATE_UNAVAILABLE';

  constructor(readonly path: string, readonly reason: string) {
    super(`wecom_fleet_desired_state_unavailable: ${path} (${reason})`);
    this.name = 'WecomFleetDesiredStateUnavailableError';
  }
}

const CONFIG_ID = /^[0-9a-f]{64}$/;

/** Longest a writer waits for the file's lock before it gives up with FILE_LOCK_TIMEOUT. */
export const WECOM_FLEET_DESIRED_STATE_LOCK_WAIT_MS = 5_000;

export function wecomFleetDesiredStatePath(root = wecomRoot()): string {
  return join(root, 'fleet-desired.json');
}

function parseDesiredStateFile(text: string): ReadonlyMap<string, WecomDesiredRecord> | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'not valid JSON';
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not a JSON object';
  const file = raw as Record<string, unknown>;
  if (file.version !== 1) return 'unsupported version';
  const connections = file.connections;
  if (!connections || typeof connections !== 'object' || Array.isArray(connections)) {
    return 'connections is not an object';
  }
  const result = new Map<string, WecomDesiredRecord>();
  for (const [configId, value] of Object.entries(connections as Record<string, unknown>)) {
    if (!CONFIG_ID.test(configId)) return 'invalid connection id';
    const record = value as Record<string, unknown> | null;
    if (!record || typeof record !== 'object'
      || (record.desired !== 'running' && record.desired !== 'stopped')
      || typeof record.updatedAt !== 'string') {
      return `invalid record for ${configId.slice(0, 12)}`;
    }
    // A reason this version does not know (a newer writer, a hand edit) is read
    // as "no reason" rather than making the whole file unavailable: the intent
    // itself, `stopped`, is still known and still honoured.
    const reason = record.desired === 'stopped' && isWecomDesiredStopReason(record.reason) ? record.reason : undefined;
    result.set(configId, {
      desired: record.desired,
      updatedAt: record.updatedAt,
      ...(reason ? { reason } : {}),
    });
  }
  return result;
}

/** Read the desired-state file. A missing file is an empty, valid snapshot. */
export function readWecomFleetDesiredState(root = wecomRoot()): WecomDesiredStateSnapshot {
  const path = wecomFleetDesiredStatePath(root);
  if (!existsSync(path)) return { status: 'ok', connections: new Map() };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'ok', connections: new Map() };
    return { status: 'unavailable', reason: `unreadable (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  const parsed = parseDesiredStateFile(text);
  return typeof parsed === 'string'
    ? { status: 'unavailable', reason: parsed }
    : { status: 'ok', connections: parsed };
}

/** The recorded intent of one connection in a readable snapshot. */
export function wecomDesiredStateOf(
  snapshot: Extract<WecomDesiredStateSnapshot, { status: 'ok' }>,
  configId: string,
): WecomDesiredState | 'unrecorded' {
  return snapshot.connections.get(configId)?.desired ?? 'unrecorded';
}

/** Whether two records are the same write: same state, time and reason. */
export function sameWecomDesiredRecord(a: WecomDesiredRecord | undefined, b: WecomDesiredRecord | undefined): boolean {
  if (!a || !b) {
    return a === b;
  }
  return a.desired === b.desired && a.updatedAt === b.updatedAt && a.reason === b.reason;
}

/**
 * Locked read-modify-write. `mutate` edits a copy of the current records (absent
 * file → empty map); the result is validated and atomically written. A `mutate`
 * that returns `false` leaves the file untouched. Throws
 * {@link WecomFleetDesiredStateUnavailableError} — without writing — when the
 * current file cannot be read.
 */
export function updateWecomFleetDesiredState(
  mutate: (connections: Map<string, WecomDesiredRecord>) => void | false,
  options: { root?: string } = {},
): ReadonlyMap<string, WecomDesiredRecord> {
  const root = options.root ?? wecomRoot();
  const path = wecomFleetDesiredStatePath(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLockSync(path, () => {
    const current = readWecomFleetDesiredState(root);
    if (current.status !== 'ok') throw new WecomFleetDesiredStateUnavailableError(path, current.reason);
    const next = new Map(current.connections);
    if (mutate(next) === false) {
      return current.connections;
    }
    const connections: Record<string, WecomDesiredRecord> = {};
    for (const [configId, record] of [...next].sort(([a], [b]) => a.localeCompare(b))) {
      if (!CONFIG_ID.test(configId)) throw new Error(`wecom_fleet_desired_invalid_connection_id: ${configId}`);
      if (record.desired !== 'running' && record.desired !== 'stopped') {
        throw new Error(`wecom_fleet_desired_invalid_state: ${String(record.desired)}`);
      }
      if (record.reason !== undefined
        && (record.desired !== 'stopped' || !isWecomDesiredStopReason(record.reason))) {
        throw new Error(`wecom_fleet_desired_invalid_reason: ${String(record.reason)}`);
      }
      connections[configId] = {
        desired: record.desired,
        updatedAt: record.updatedAt,
        ...(record.reason !== undefined ? { reason: record.reason } : {}),
      };
    }
    atomicWriteFileSync(path, `${JSON.stringify({ version: 1, connections }, null, 2)}\n`, {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
    return next;
  }, { maxWaitMs: WECOM_FLEET_DESIRED_STATE_LOCK_WAIT_MS });
}

/** Record one connection's intent as set by a person (Dashboard, CLI,
 *  migration). Replaces the whole record, so a reason a gateway left on an
 *  earlier `stopped` is cleared. */
export function setWecomFleetDesiredState(
  configId: string,
  desired: WecomDesiredState,
  options: { root?: string; now?: () => Date } = {},
): void {
  writeRecord(configId, { desired }, { root: options.root, now: options.now });
}

/** What {@link setWecomFleetDesiredStopped} did. */
export type WecomDesiredStopWrite =
  | { written: true; record: WecomDesiredRecord }
  /** `expected` no longer matched: `current` is what the file holds (undefined: no record). */
  | { written: false; current: WecomDesiredRecord | undefined };

/**
 * Record that the connection's own gateway stopped it for `reason` (a
 * supervised gateway, as soon as it knows the reason). Synchronous, under the
 * file lock, one atomic write.
 *
 * With `expected`, the write is a compare-and-set: it happens only while the
 * connection's record is still exactly `expected.record` (`undefined`: no
 * record), compared and written under the same lock. Anything written since —
 * a person's start, stop or restart — stays, and the result says so.
 *
 * Throws on an invalid id or reason, on an unavailable file and on a lock
 * timeout; the caller decides whether going on without the record is
 * acceptable.
 */
export function setWecomFleetDesiredStopped(
  configId: string,
  reason: WecomDesiredStopReason,
  options: { root?: string; now?: () => Date; expected?: { record: WecomDesiredRecord | undefined } } = {},
): WecomDesiredStopWrite {
  if (!isWecomDesiredStopReason(reason)) throw new Error(`wecom_fleet_desired_invalid_reason: ${String(reason)}`);
  return writeRecord(configId, { desired: 'stopped', reason }, options);
}

function writeRecord(
  configId: string,
  record: Omit<WecomDesiredRecord, 'updatedAt'>,
  options: { root?: string; now?: () => Date; expected?: { record: WecomDesiredRecord | undefined } },
): WecomDesiredStopWrite {
  if (!CONFIG_ID.test(configId)) throw new Error(`wecom_fleet_desired_invalid_connection_id: ${configId}`);
  let outcome: WecomDesiredStopWrite | undefined;
  updateWecomFleetDesiredState(connections => {
    const current = connections.get(configId);
    if (options.expected && !sameWecomDesiredRecord(current, options.expected.record)) {
      outcome = { written: false, current };
      return false;
    }
    // Stamped under the lock: a record never carries a time earlier than the one it replaced
    // was written (a writer may have waited seconds for the lock).
    const written: WecomDesiredRecord = { ...record, updatedAt: (options.now ?? (() => new Date()))().toISOString() };
    connections.set(configId, written);
    outcome = { written: true, record: written };
    return undefined;
  }, { root: options.root });
  return outcome!;
}
