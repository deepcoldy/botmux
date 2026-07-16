/**
 * Durable two-phase ownership fence for one v3 attempt's outer worker.
 *
 * The daemon publishes `armed` before fork, closing the journal-dispatch →
 * spawn publication gap. After fork it atomically transitions that exact
 * owner-bound record to `active` with the child PID + process-start identity.
 * A recovering daemon must treat `armed` as unknown even when the owner is
 * dead: the old daemon may have forked a child and died before it could publish
 * that child's identity. Convergence from that state requires an out-of-band
 * orphan discovery/drain policy; neither owner death nor a missing sidecar is
 * proof that no worker exists.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';

import { readProcessStartIdentity } from '../../core/session-marker.js';
import { fsyncDirectorySyncPortable, fsyncRegularFileSync } from '../../utils/fs-durability.js';
import { withFileLockSync } from '../../utils/file-lock.js';

export const V3_ATTEMPT_WORKER_FENCE_FILE = '.worker-fence.json';
export const V3_ATTEMPT_WORKER_FENCE_SCHEMA_VERSION = 1 as const;

const MAX_FENCE_BYTES = 16 * 1024;
const MAX_RUN_ID_LENGTH = 256;
const MAX_ATTEMPT_ID_LENGTH = 1_024;
const MAX_PROC_START_LENGTH = 256;
const ARMED_KEYS = ['attemptId', 'ownerPid', 'ownerProcStart', 'phase', 'runId', 'schemaVersion'] as const;
const ACTIVE_KEYS = [...ARMED_KEYS, 'workerPid', 'workerProcStart'].sort();
const CLOSED_NO_SPAWN_KEYS = [...ARMED_KEYS, 'reason'].sort();
const NO_WORKER_SPAWN_REASONS = new Set<V3NoWorkerSpawnReason>([
  'pre_aborted',
  'secret_missing',
  'setup_failed',
  'spawn_threw',
]);

interface V3AttemptWorkerFenceBase {
  schemaVersion: typeof V3_ATTEMPT_WORKER_FENCE_SCHEMA_VERSION;
  runId: string;
  attemptId: string;
  ownerPid: number;
  ownerProcStart: string;
}

export interface V3ArmedAttemptWorkerFence extends V3AttemptWorkerFenceBase {
  phase: 'armed';
}

export type V3NoWorkerSpawnReason = 'pre_aborted' | 'secret_missing' | 'setup_failed' | 'spawn_threw';

export interface V3ClosedNoSpawnAttemptWorkerFence extends V3AttemptWorkerFenceBase {
  phase: 'closed_no_spawn';
  reason: V3NoWorkerSpawnReason;
}

export interface V3ActiveAttemptWorkerFence extends V3AttemptWorkerFenceBase {
  phase: 'active';
  workerPid: number;
  workerProcStart: string;
}

export interface V3ClosedAttemptWorkerFence extends V3AttemptWorkerFenceBase {
  phase: 'closed';
  workerPid: number;
  workerProcStart: string;
}

export type V3AttemptWorkerFence =
  | V3ArmedAttemptWorkerFence
  | V3ClosedNoSpawnAttemptWorkerFence
  | V3ActiveAttemptWorkerFence
  | V3ClosedAttemptWorkerFence;

export interface V3AttemptWorkerFenceBinding {
  runId: string;
  attemptId: string;
}

export type V3AttemptWorkerFenceProbe =
  | { status: 'missing' }
  | {
      status: 'unknown';
      fence: V3AttemptWorkerFence;
      reason: 'armed_without_worker_identity' | 'process_identity_unavailable' | 'process_probe_denied';
    }
  | { status: 'alive'; fence: V3ActiveAttemptWorkerFence }
  | {
      status: 'dead';
      fence: V3ClosedNoSpawnAttemptWorkerFence | V3ActiveAttemptWorkerFence | V3ClosedAttemptWorkerFence;
      reason: 'no_worker_spawned' | 'outer_process_closed' | 'process_missing' | 'process_identity_mismatch';
    };

export type V3AttemptWorkerSignal = 'SIGINT' | 'SIGKILL';

export type V3AttemptWorkerSignalResult =
  | { status: 'signalled'; fence: V3ActiveAttemptWorkerFence; signal: V3AttemptWorkerSignal }
  | Exclude<V3AttemptWorkerFenceProbe, { status: 'alive' }>;

export type V3AttemptWorkerFenceRemoval = 'missing' | 'mismatch' | 'removed';

export interface V3DiscoveredAttemptWorker {
  pid: number;
  procStart: string;
}

export type V3AttemptWorkerDiscovery =
  | { status: 'unsupported' }
  | { status: 'none' }
  | { status: 'one'; worker: V3DiscoveredAttemptWorker }
  | {
      status: 'ambiguous';
      workers: V3DiscoveredAttemptWorker[];
      unverifiablePids: number[];
      reason: 'multiple_or_unverifiable' | 'candidate_changed';
    };

export type V3ArmedFenceRecoveryResult =
  | { status: 'recovered'; fence: V3ActiveAttemptWorkerFence }
  | { status: 'already_active'; fence: V3ActiveAttemptWorkerFence }
  | { status: 'already_closed'; fence: V3ClosedAttemptWorkerFence }
  | { status: 'already_closed_no_spawn'; fence: V3ClosedNoSpawnAttemptWorkerFence }
  | { status: 'owner_alive' | 'owner_unknown' | 'missing' }
  | Exclude<V3AttemptWorkerDiscovery, { status: 'one' }>;

export interface V3AttemptWorkerProcessLike {
  readonly pid?: number;
  on(event: 'close', listener: (code: number | null) => void): unknown;
}

export class V3AttemptWorkerFenceIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V3AttemptWorkerFenceIntegrityError';
  }
}

function errnoCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err
    ? String((err as NodeJS.ErrnoException).code)
    : undefined;
}

function validateBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) {
    throw new V3AttemptWorkerFenceIntegrityError(`invalid v3 attempt worker fence ${label}`);
  }
  return value;
}

function validatePid(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 1 || (value as number) > 0x7fff_ffff) {
    throw new V3AttemptWorkerFenceIntegrityError(`invalid v3 attempt worker fence ${label}`);
  }
  return value as number;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseFence(raw: string, filePath: string): V3AttemptWorkerFence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new V3AttemptWorkerFenceIntegrityError(`malformed v3 attempt worker fence: ${filePath}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new V3AttemptWorkerFenceIntegrityError(`invalid v3 attempt worker fence object: ${filePath}`);
  }
  const record = parsed as Record<string, unknown>;
  const expectedKeys = record.phase === 'armed'
    ? ARMED_KEYS
    : record.phase === 'closed_no_spawn'
      ? CLOSED_NO_SPAWN_KEYS
    : record.phase === 'active' || record.phase === 'closed'
      ? ACTIVE_KEYS
      : [];
  if (!hasExactKeys(record, expectedKeys)) {
    throw new V3AttemptWorkerFenceIntegrityError(`unknown or missing v3 attempt worker fence field: ${filePath}`);
  }
  if (record.schemaVersion !== V3_ATTEMPT_WORKER_FENCE_SCHEMA_VERSION) {
    throw new V3AttemptWorkerFenceIntegrityError(`unsupported v3 attempt worker fence schema: ${filePath}`);
  }

  const base: V3AttemptWorkerFenceBase = {
    schemaVersion: V3_ATTEMPT_WORKER_FENCE_SCHEMA_VERSION,
    runId: validateBoundedString(record.runId, 'runId', MAX_RUN_ID_LENGTH),
    attemptId: validateBoundedString(record.attemptId, 'attemptId', MAX_ATTEMPT_ID_LENGTH),
    ownerPid: validatePid(record.ownerPid, 'ownerPid'),
    ownerProcStart: validateBoundedString(record.ownerProcStart, 'ownerProcStart', MAX_PROC_START_LENGTH),
  };
  if (record.phase === 'armed') return { ...base, phase: 'armed' };
  if (record.phase === 'closed_no_spawn') {
    if (!NO_WORKER_SPAWN_REASONS.has(record.reason as V3NoWorkerSpawnReason)) {
      throw new V3AttemptWorkerFenceIntegrityError(`invalid v3 no-worker-spawn reason: ${filePath}`);
    }
    return { ...base, phase: 'closed_no_spawn', reason: record.reason as V3NoWorkerSpawnReason };
  }
  if (record.phase !== 'active' && record.phase !== 'closed') {
    throw new V3AttemptWorkerFenceIntegrityError(`invalid v3 attempt worker fence phase: ${filePath}`);
  }
  return {
    ...base,
    phase: record.phase,
    workerPid: validatePid(record.workerPid, 'workerPid'),
    workerProcStart: validateBoundedString(record.workerProcStart, 'workerProcStart', MAX_PROC_START_LENGTH),
  };
}

function sameFence(a: V3AttemptWorkerFence, b: V3AttemptWorkerFence): boolean {
  return a.schemaVersion === b.schemaVersion
    && a.runId === b.runId
    && a.attemptId === b.attemptId
    && a.ownerPid === b.ownerPid
    && a.ownerProcStart === b.ownerProcStart
    && a.phase === b.phase
    && (a.phase === 'armed'
      ? b.phase === 'armed'
      : a.phase === 'closed_no_spawn'
        ? b.phase === 'closed_no_spawn' && a.reason === b.reason
      : b.phase === a.phase
        && a.workerPid === b.workerPid
        && a.workerProcStart === b.workerProcStart);
}

function sameOwner(a: V3AttemptWorkerFence, b: V3AttemptWorkerFenceBase): boolean {
  return a.runId === b.runId
    && a.attemptId === b.attemptId
    && a.ownerPid === b.ownerPid
    && a.ownerProcStart === b.ownerProcStart;
}

function sameWorkerIdentity(
  a: V3ActiveAttemptWorkerFence | V3ClosedAttemptWorkerFence,
  b: V3ActiveAttemptWorkerFence | V3ClosedAttemptWorkerFence,
): boolean {
  return sameOwner(a, b)
    && a.workerPid === b.workerPid
    && a.workerProcStart === b.workerProcStart;
}

function assertBinding(fence: V3AttemptWorkerFence, expected: V3AttemptWorkerFenceBinding, filePath: string): void {
  if (fence.runId !== expected.runId || fence.attemptId !== expected.attemptId) {
    throw new V3AttemptWorkerFenceIntegrityError(`v3 attempt worker fence binding mismatch: ${filePath}`);
  }
}

export function v3AttemptWorkerFencePath(attemptDir: string): string {
  return join(attemptDir, V3_ATTEMPT_WORKER_FENCE_FILE);
}

/** Missing is distinct from invalid; every malformed/unexpected shape fails closed. */
export function readV3AttemptWorkerFence(
  attemptDir: string,
  expected: V3AttemptWorkerFenceBinding,
): V3AttemptWorkerFence | null {
  const filePath = v3AttemptWorkerFencePath(attemptDir);
  let pathStat;
  try {
    pathStat = lstatSync(filePath);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return null;
    throw err;
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new V3AttemptWorkerFenceIntegrityError(`v3 attempt worker fence must be a regular file: ${filePath}`);
  }
  if (pathStat.size > MAX_FENCE_BYTES) {
    throw new V3AttemptWorkerFenceIntegrityError(`v3 attempt worker fence is too large: ${filePath}`);
  }

  let fd: number | undefined;
  try {
    fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStat = fstatSync(fd);
    if (!openedStat.isFile()) {
      throw new V3AttemptWorkerFenceIntegrityError(`v3 attempt worker fence must remain a regular file: ${filePath}`);
    }
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new V3AttemptWorkerFenceIntegrityError(`v3 attempt worker fence changed while opening: ${filePath}`);
    }
    if (openedStat.size > MAX_FENCE_BYTES) {
      throw new V3AttemptWorkerFenceIntegrityError(`v3 attempt worker fence is too large: ${filePath}`);
    }
    const fence = parseFence(readFileSync(fd, 'utf8'), filePath);
    assertBinding(fence, expected, filePath);
    return fence;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return null;
    if (errnoCode(err) === 'ELOOP') {
      throw new V3AttemptWorkerFenceIntegrityError(`v3 attempt worker fence must not be a symlink: ${filePath}`);
    }
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeFsyncedTemp(filePath: string, fence: V3AttemptWorkerFence): string {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(fence, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    return tmpPath;
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

function publishCreateOnce(attemptDir: string, fence: V3AttemptWorkerFence): V3AttemptWorkerFence {
  const filePath = v3AttemptWorkerFencePath(attemptDir);
  return withFileLockSync(filePath, () => {
    const existing = readV3AttemptWorkerFence(attemptDir, fence);
    if (existing) {
      if (!sameFence(existing, fence)) {
        throw new V3AttemptWorkerFenceIntegrityError(`v3 attempt worker fence already exists: ${filePath}`);
      }
      fsyncRegularFileSync(filePath);
      fsyncDirectorySyncPortable(attemptDir);
      return existing;
    }

    const tmpPath = writeFsyncedTemp(filePath, fence);
    try {
      linkSync(tmpPath, filePath);
      unlinkSync(tmpPath);
      fsyncDirectorySyncPortable(attemptDir);
      return fence;
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* best-effort */ }
      throw err;
    }
  });
}

function replaceFence(attemptDir: string, fence: V3AttemptWorkerFence): void {
  const filePath = v3AttemptWorkerFencePath(attemptDir);
  const before = lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new V3AttemptWorkerFenceIntegrityError(`v3 attempt worker fence must remain a regular file: ${filePath}`);
  }
  const tmpPath = writeFsyncedTemp(filePath, fence);
  try {
    // Re-check immediately before rename; the file lock serializes all
    // cooperating transitions and this rejects non-regular replacement.
    const latest = lstatSync(filePath);
    if (!latest.isFile() || latest.isSymbolicLink() || latest.dev !== before.dev || latest.ino !== before.ino) {
      throw new V3AttemptWorkerFenceIntegrityError(`v3 attempt worker fence changed before transition: ${filePath}`);
    }
    renameSync(tmpPath, filePath);
    fsyncDirectorySyncPortable(attemptDir);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

/** Publish the daemon-owned pre-fork fence. Call this before factory.spawn(). */
export function armV3AttemptWorkerFence(input: {
  attemptDir: string;
  runId: string;
  attemptId: string;
}): V3ArmedAttemptWorkerFence {
  const ownerProcStart = readProcessStartIdentity(process.pid);
  if (!ownerProcStart) {
    throw new V3AttemptWorkerFenceIntegrityError('cannot capture v3 worker-fence owner process identity');
  }
  const fence: V3ArmedAttemptWorkerFence = {
    schemaVersion: V3_ATTEMPT_WORKER_FENCE_SCHEMA_VERSION,
    runId: validateBoundedString(input.runId, 'runId', MAX_RUN_ID_LENGTH),
    attemptId: validateBoundedString(input.attemptId, 'attemptId', MAX_ATTEMPT_ID_LENGTH),
    ownerPid: process.pid,
    ownerProcStart: validateBoundedString(ownerProcStart, 'ownerProcStart', MAX_PROC_START_LENGTH),
    phase: 'armed',
  };
  return publishCreateOnce(input.attemptDir, fence) as V3ArmedAttemptWorkerFence;
}

/** Atomically bind an exact armed fence to the newly-forked worker identity. */
export function activateV3AttemptWorkerFence(input: {
  attemptDir: string;
  armed: V3ArmedAttemptWorkerFence;
  workerPid: number;
}): V3ActiveAttemptWorkerFence {
  if (input.armed.ownerPid !== process.pid
    || readProcessStartIdentity(process.pid) !== input.armed.ownerProcStart) {
    throw new V3AttemptWorkerFenceIntegrityError('only the live arming daemon may activate a v3 worker fence');
  }
  const workerPid = validatePid(input.workerPid, 'workerPid');
  const filePath = v3AttemptWorkerFencePath(input.attemptDir);

  return withFileLockSync(filePath, () => {
    const current = readV3AttemptWorkerFence(input.attemptDir, input.armed);
    if (!current || !sameOwner(current, input.armed)) {
      throw new V3AttemptWorkerFenceIntegrityError('v3 attempt worker fence owner changed before activation');
    }
    const workerProcStart = readProcessStartIdentity(workerPid);
    if (!workerProcStart) {
      throw new V3AttemptWorkerFenceIntegrityError(`cannot capture worker process identity for pid ${workerPid}`);
    }
    // Idempotent replay after the active transition was already durable.
    if (current.phase === 'active') {
      if (current.workerPid !== workerPid || current.workerProcStart !== workerProcStart) {
        throw new V3AttemptWorkerFenceIntegrityError('v3 attempt worker fence already binds another worker');
      }
      return current;
    }
    if (current.phase === 'closed') {
      throw new V3AttemptWorkerFenceIntegrityError('v3 attempt worker fence is already closed');
    }
    if (current.phase === 'closed_no_spawn') {
      throw new V3AttemptWorkerFenceIntegrityError('v3 attempt worker fence was closed without spawn');
    }
    if (!sameFence(current, input.armed)) {
      throw new V3AttemptWorkerFenceIntegrityError('v3 attempt worker armed identity changed before activation');
    }

    const active: V3ActiveAttemptWorkerFence = {
      ...input.armed,
      phase: 'active',
      workerPid,
      workerProcStart: validateBoundedString(workerProcStart, 'workerProcStart', MAX_PROC_START_LENGTH),
    };
    replaceFence(input.attemptDir, active);
    return active;
  });
}

/**
 * Durable proof that the armed pre-fork path ended without creating a child.
 * Only the still-live daemon that armed the fence may make this assertion.
 */
export function closeV3ArmedFenceWithoutSpawn(
  attemptDir: string,
  armed: V3ArmedAttemptWorkerFence,
  reason: V3NoWorkerSpawnReason,
): V3ClosedNoSpawnAttemptWorkerFence {
  if (!NO_WORKER_SPAWN_REASONS.has(reason)) {
    throw new V3AttemptWorkerFenceIntegrityError(`invalid v3 no-worker-spawn reason: ${String(reason)}`);
  }
  if (armed.ownerPid !== process.pid || readProcessStartIdentity(process.pid) !== armed.ownerProcStart) {
    throw new V3AttemptWorkerFenceIntegrityError('only the live arming daemon may close a no-spawn fence');
  }
  const filePath = v3AttemptWorkerFencePath(attemptDir);
  return withFileLockSync(filePath, () => {
    const current = readV3AttemptWorkerFence(attemptDir, armed);
    if (!current || !sameOwner(current, armed)) {
      throw new V3AttemptWorkerFenceIntegrityError('v3 attempt worker fence owner changed before no-spawn close');
    }
    if (current.phase === 'closed_no_spawn') {
      if (current.reason !== reason) {
        throw new V3AttemptWorkerFenceIntegrityError('v3 no-worker-spawn fence already records another reason');
      }
      return current;
    }
    if (current.phase !== 'armed' || !sameFence(current, armed)) {
      throw new V3AttemptWorkerFenceIntegrityError('v3 attempt worker fence is not armed for no-spawn close');
    }
    const closed: V3ClosedNoSpawnAttemptWorkerFence = {
      ...current,
      phase: 'closed_no_spawn',
      reason,
    };
    replaceFence(attemptDir, closed);
    return closed;
  });
}

function processExists(pid: number): 'exists' | 'missing' | 'denied' {
  try {
    process.kill(pid, 0);
    return 'exists';
  } catch (err) {
    if (errnoCode(err) === 'ESRCH') return 'missing';
    return 'denied';
  }
}

function recordedProcessStatus(pid: number, procStart: string): 'alive' | 'dead' | 'unknown' {
  const liveStart = readProcessStartIdentity(pid);
  if (liveStart === procStart) return 'alive';
  if (liveStart !== undefined) return 'dead';
  const existence = processExists(pid);
  if (existence === 'missing') return 'dead';
  return 'unknown';
}

const ATTEMPT_DIR_ENV = 'BOTMUX_GOAL_ATTEMPT_DIR';
const WORKER_ENTRY_BASENAMES = new Set(['worker.js', 'worker.ts']);

function isBotmuxWorkerCommandLine(raw: Buffer): boolean {
  const args = raw.toString('utf8').split('\0').filter(Boolean);
  // Production executes dist/worker.js; source/dev mode intentionally falls
  // back to src/worker.ts. Recovery must recognize both or it could treat a
  // live source worker as an empty legacy attempt and publish runCancelled.
  return args.some((arg) => WORKER_ENTRY_BASENAMES.has(basename(arg)));
}

function isGoneProcError(err: unknown): boolean {
  const code = errnoCode(err);
  return code === 'ENOENT' || code === 'ESRCH';
}

/**
 * Linux-only conservative orphan discovery for the armed fork gap and legacy
 * runs without a fence. Both the exact attempt-dir environment binding and a
 * worker.js/worker.ts command-line argument are required. Same-uid unreadable matches
 * make the result ambiguous rather than being silently treated as absent.
 */
export function discoverV3AttemptWorker(attemptDir: string): V3AttemptWorkerDiscovery {
  if (process.platform !== 'linux') return { status: 'unsupported' };
  if (!isAbsolute(attemptDir) || attemptDir.length === 0 || attemptDir.length > 4_096 || attemptDir.includes('\0')) {
    throw new V3AttemptWorkerFenceIntegrityError('v3 attempt worker discovery requires an absolute attemptDir');
  }

  const expectedEnv = `${ATTEMPT_DIR_ENV}=${attemptDir}`;
  const workers: V3DiscoveredAttemptWorker[] = [];
  const unverifiablePids: number[] = [];
  const ownUid = process.getuid?.();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    const procDir = join('/proc', name);
    if (ownUid !== undefined) {
      try {
        if (lstatSync(procDir).uid !== ownUid) continue;
      } catch (err) {
        if (isGoneProcError(err)) continue;
        unverifiablePids.push(pid);
        continue;
      }
    }

    let envMatches = false;
    try {
      envMatches = readFileSync(join(procDir, 'environ'))
        .toString('utf8')
        .split('\0')
        .some((entry) => entry === expectedEnv);
    } catch (err) {
      if (isGoneProcError(err)) continue;
      // We cannot know whether an unreadable same-uid process carries the
      // exact binding, so fail closed instead of returning a false `none`.
      unverifiablePids.push(pid);
      continue;
    }
    if (!envMatches) continue;

    try {
      if (!isBotmuxWorkerCommandLine(readFileSync(join(procDir, 'cmdline')))) continue;
    } catch (err) {
      if (isGoneProcError(err)) continue;
      unverifiablePids.push(pid);
      continue;
    }
    const procStart = readProcessStartIdentity(pid);
    if (!procStart) {
      if (processExists(pid) !== 'missing') unverifiablePids.push(pid);
      continue;
    }
    workers.push({ pid, procStart });
  }

  workers.sort((a, b) => a.pid - b.pid);
  unverifiablePids.sort((a, b) => a - b);
  if (workers.length === 1 && unverifiablePids.length === 0) return { status: 'one', worker: workers[0]! };
  if (workers.length === 0 && unverifiablePids.length === 0) return { status: 'none' };
  return { status: 'ambiguous', workers, unverifiablePids, reason: 'multiple_or_unverifiable' };
}

/**
 * Recover armed → active only after the recorded owner is provably gone and a
 * single exact attempt-bound worker is discoverable. The owner proof and scan
 * are repeated under the fence lock before publication.
 */
export function recoverV3ArmedFenceWorker(input: {
  attemptDir: string;
  armed: V3ArmedAttemptWorkerFence;
}): V3ArmedFenceRecoveryResult {
  const filePath = v3AttemptWorkerFencePath(input.attemptDir);
  return withFileLockSync(filePath, () => {
    const current = readV3AttemptWorkerFence(input.attemptDir, input.armed);
    if (!current) return { status: 'missing' };
    if (!sameOwner(current, input.armed)) {
      throw new V3AttemptWorkerFenceIntegrityError('v3 attempt worker fence owner changed before recovery');
    }
    if (current.phase === 'active') return { status: 'already_active', fence: current };
    if (current.phase === 'closed') return { status: 'already_closed', fence: current };
    if (current.phase === 'closed_no_spawn') return { status: 'already_closed_no_spawn', fence: current };
    if (!sameFence(current, input.armed)) {
      throw new V3AttemptWorkerFenceIntegrityError('v3 attempt worker armed identity changed before recovery');
    }

    const ownerStatus = recordedProcessStatus(current.ownerPid, current.ownerProcStart);
    if (ownerStatus === 'alive') return { status: 'owner_alive' };
    if (ownerStatus === 'unknown') return { status: 'owner_unknown' };

    const discovery = discoverV3AttemptWorker(input.attemptDir);
    if (discovery.status !== 'one') return discovery;
    const liveStart = readProcessStartIdentity(discovery.worker.pid);
    if (liveStart !== discovery.worker.procStart) {
      return {
        status: 'ambiguous',
        workers: [discovery.worker],
        unverifiablePids: [],
        reason: 'candidate_changed',
      };
    }
    const active: V3ActiveAttemptWorkerFence = {
      ...current,
      phase: 'active',
      workerPid: discovery.worker.pid,
      workerProcStart: discovery.worker.procStart,
    };
    replaceFence(input.attemptDir, active);
    return { status: 'recovered', fence: active };
  });
}

function probeActiveProcess(fence: V3ActiveAttemptWorkerFence): Exclude<V3AttemptWorkerFenceProbe, { status: 'missing' }> {
  const liveStart = readProcessStartIdentity(fence.workerPid);
  if (liveStart === fence.workerProcStart) return { status: 'alive', fence };
  if (liveStart !== undefined) return { status: 'dead', fence, reason: 'process_identity_mismatch' };
  const existence = processExists(fence.workerPid);
  if (existence === 'missing') return { status: 'dead', fence, reason: 'process_missing' };
  return {
    status: 'unknown',
    fence,
    reason: existence === 'denied' ? 'process_probe_denied' : 'process_identity_unavailable',
  };
}

/**
 * Armed is always unknown (including after owner death); missing remains
 * distinct so runtime can apply its explicit legacy/drain fail-safe policy.
 */
export function probeV3AttemptWorkerFence(
  attemptDir: string,
  expected: V3AttemptWorkerFenceBinding,
): V3AttemptWorkerFenceProbe {
  const fence = readV3AttemptWorkerFence(attemptDir, expected);
  if (!fence) return { status: 'missing' };
  if (fence.phase === 'closed_no_spawn') {
    return { status: 'dead', fence, reason: 'no_worker_spawned' };
  }
  if (fence.phase === 'armed') {
    return { status: 'unknown', fence, reason: 'armed_without_worker_identity' };
  }
  if (fence.phase === 'closed') {
    return { status: 'dead', fence, reason: 'outer_process_closed' };
  }
  return probeActiveProcess(fence);
}

/** Signal only the exact active fence after rechecking its live start identity. */
export function signalV3AttemptWorker(
  attemptDir: string,
  expected: V3ActiveAttemptWorkerFence,
  signal: V3AttemptWorkerSignal,
): V3AttemptWorkerSignalResult {
  if (signal !== 'SIGINT' && signal !== 'SIGKILL') {
    throw new V3AttemptWorkerFenceIntegrityError(`unsupported v3 attempt worker signal: ${String(signal)}`);
  }
  return withFileLockSync(v3AttemptWorkerFencePath(attemptDir), () => {
    const current = readV3AttemptWorkerFence(attemptDir, expected);
    if (!current) return { status: 'missing' };
    if (current.phase === 'closed' && sameWorkerIdentity(current, expected)) {
      return { status: 'dead', fence: current, reason: 'outer_process_closed' };
    }
    if (current.phase !== 'active' || !sameFence(current, expected)) {
      throw new V3AttemptWorkerFenceIntegrityError('v3 attempt worker fence identity mismatch before signal');
    }
    const first = probeActiveProcess(current);
    if (first.status !== 'alive') return first;

    const latest = readV3AttemptWorkerFence(attemptDir, expected);
    if (!latest || latest.phase !== 'active' || !sameFence(first.fence, latest)) {
      throw new V3AttemptWorkerFenceIntegrityError('v3 attempt worker fence changed before signal');
    }
    const latestStart = readProcessStartIdentity(latest.workerPid);
    if (latestStart !== latest.workerProcStart) {
      if (latestStart !== undefined) return { status: 'dead', fence: latest, reason: 'process_identity_mismatch' };
      const existence = processExists(latest.workerPid);
      return existence === 'missing'
        ? { status: 'dead', fence: latest, reason: 'process_missing' }
        : {
            status: 'unknown',
            fence: latest,
            reason: existence === 'denied' ? 'process_probe_denied' : 'process_identity_unavailable',
          };
    }

    try {
      process.kill(latest.workerPid, signal);
      return { status: 'signalled', fence: latest, signal };
    } catch (err) {
      if (errnoCode(err) === 'ESRCH') return { status: 'dead', fence: latest, reason: 'process_missing' };
      if (errnoCode(err) === 'EPERM') return { status: 'unknown', fence: latest, reason: 'process_probe_denied' };
      throw err;
    }
  });
}


/** Durable active → closed tombstone transition performed on ChildProcess close. */
export function closeV3AttemptWorkerFence(
  attemptDir: string,
  expected: V3ActiveAttemptWorkerFence,
): V3ClosedAttemptWorkerFence {
  const filePath = v3AttemptWorkerFencePath(attemptDir);
  return withFileLockSync(filePath, () => {
    const current = readV3AttemptWorkerFence(attemptDir, expected);
    if (!current) {
      throw new V3AttemptWorkerFenceIntegrityError('v3 attempt worker fence disappeared before close');
    }
    if (current.phase === 'closed' && sameWorkerIdentity(current, expected)) return current;
    if (current.phase !== 'active' || !sameFence(current, expected)) {
      throw new V3AttemptWorkerFenceIntegrityError('v3 attempt worker fence changed before close');
    }
    const closed: V3ClosedAttemptWorkerFence = { ...current, phase: 'closed' };
    replaceFence(attemptDir, closed);
    return closed;
  });
}

/** Exact-identity removal after the journal has durably settled the attempt. */
export function removeV3AttemptWorkerFence(
  attemptDir: string,
  expected: V3AttemptWorkerFence,
): V3AttemptWorkerFenceRemoval {
  const filePath = v3AttemptWorkerFencePath(attemptDir);
  return withFileLockSync(filePath, () => {
    const current = readV3AttemptWorkerFence(attemptDir, expected);
    if (!current) return 'missing';
    if (!sameFence(current, expected)) return 'mismatch';
    try {
      unlinkSync(filePath);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return 'missing';
      throw err;
    }
    fsyncDirectorySyncPortable(attemptDir);
    return 'removed';
  });
}

/**
 * Activate and bind a durable tombstone transition to ChildProcess `close`
 * only. `exit` is not a
 * resource fence: stdio/IPC (and descendants holding them) may still be open.
 * The listener is installed before activation and replays cleanup if close
 * races the durable active transition.
 */
export function bindV3AttemptWorkerFence(input: {
  worker: V3AttemptWorkerProcessLike;
  attemptDir: string;
  armed: V3ArmedAttemptWorkerFence;
  onCleanupError?: (error: unknown) => void;
}): V3ActiveAttemptWorkerFence {
  if (!input.worker.pid) {
    throw new V3AttemptWorkerFenceIntegrityError('v3 attempt worker has no pid to fence');
  }
  let active: V3ActiveAttemptWorkerFence | undefined;
  let closeSeen = false;
  let closeComplete = false;
  const markClosed = (): void => {
    closeSeen = true;
    if (!active || closeComplete) return;
    try {
      closeV3AttemptWorkerFence(input.attemptDir, active);
      closeComplete = true;
    } catch (err) {
      if (input.onCleanupError) input.onCleanupError(err);
      else process.emitWarning(
        `failed to clean v3 attempt worker fence: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  input.worker.on('close', markClosed);
  active = activateV3AttemptWorkerFence({
    attemptDir: input.attemptDir,
    armed: input.armed,
    workerPid: input.worker.pid,
  });
  if (closeSeen) markClosed();
  return active;
}
