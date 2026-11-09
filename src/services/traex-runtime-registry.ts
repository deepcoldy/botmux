/**
 * Cross-process registry of managed TRAE runtimes sharing one physical skills
 * cache domain (see traex-runtime-domain.ts).
 *
 * The registry is the ONLY authority for "may a new CLI of content X start
 * while old runtimes are alive". It is deliberately small and updated only
 * inside a short flock(2) critical section:
 *
 *   - same domain + same content  -> allowed to run in parallel
 *   - same domain + different/unknown content -> blocked until the old
 *     runtime proves it exited
 *   - lock/read/write failure -> fail closed (never "assume compatible")
 *
 * Occupancy outlives a daemon crash. A daemon restart must not delete a record
 * that may still describe a live CLI: release requires the recorded CLI/worker
 * to be provably gone, not merely absent from one scan. On platforms without a
 * provable process-birth source, the lease + `kill(pid, 0)` policy is used and
 * an unprovable record keeps occupying the domain.
 */
import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withExclusiveFileLock } from '../utils/file-flock.js';
import { pidNotProvablyGone } from '../utils/process-alive.js';
import {
  findProcessesRunningUnder,
  isLinuxZombie,
  readLinuxBootIdentity,
  readProcessStartIdentity,
} from '../utils/process-identity.js';
import {
  TRAEX_RUNTIME_LOCK_TIMEOUT_MS,
  type TraexRuntimeDomain,
} from './traex-runtime-domain.js';

export const TRAEX_RUNTIME_REGISTRY_VERSION = 1;
/** A starting/running occupant renews this lease. It is only used where the
 *  process-birth source is unavailable; on Linux pid+starttime is authoritative. */
export const TRAEX_RUNTIME_LEASE_MS = 60_000;

export type TraexOccupantPhase = 'starting' | 'running' | 'draining';

export interface TraexRuntimeOccupant {
  occupantId: string;
  /** `''` means the content identity could not be proven. Unknown is never
   *  compatible with anything — it blocks like a different version. */
  comboKey: string;
  /** Cheap filesystem signature of the install entry used for a daemon-side
   *  pre-check. It is NOT the authority: only `comboKey` (content) decides the
   *  worker gate. Equal signatures merely avoid a pointless defer. */
  installSignature?: string;
  snapshotDir?: string;
  phase: TraexOccupantPhase;
  workerPid: number;
  workerStart?: string;
  daemonPid: number;
  daemonStart?: string;
  cliPid?: number;
  cliStart?: string;
  bootId?: string;
  /** The operator pinned this runtime to an explicit old executable. It still
   *  occupies the domain and passes the gate; it is never auto-switched. */
  fixedPath?: boolean;
  /** Registered from an already-alive runtime this worker did not exec
   *  (adopt/reattach/endpoint). It is never superseded by a later new exec from
   *  the same worker pid: it describes a different process. */
  occupancyOnly?: boolean;
  createdAt: number;
  heartbeatAt: number;
  leaseUntil: number;
}

interface TraexRuntimeRegistryFile {
  version: number;
  occupants: TraexRuntimeOccupant[];
}

export interface TraexStartRequest {
  occupantId: string;
  comboKey: string;
  installSignature?: string;
  /** Private snapshot directory this runtime execs from, when one is used.
   *  Recorded at `starting` so a daemon crash before `markRunning` can still be
   *  reconciled by scanning for a live process under it. */
  snapshotDir?: string;
  workerPid: number;
  workerStart?: string;
  daemonPid: number;
  daemonStart?: string;
  fixedPath?: boolean;
  /** Register occupancy without demanding compatibility. Used ONLY for runtimes
   *  that are already alive and were not started by this worker
   *  (adopt/reattach/existing endpoint). New execs — including wrapper/forge —
   *  must NOT set this. */
  force?: boolean;
  /** Marks the record as an already-alive runtime (see TraexRuntimeOccupant). */
  occupancyOnly?: boolean;
  now?: number;
}

export interface TraexRuntimeBlocker {
  occupantId: string;
  comboKey: string;
  phase: TraexOccupantPhase;
  fixedPath: boolean;
  pid?: number;
}

export type TraexGateDecision =
  | { decision: 'start'; occupantId: string; pruned: string[] }
  | { decision: 'blocked'; blockers: TraexRuntimeBlocker[]; pruned: string[] }
  /** The gate could not be consulted. Callers MUST refuse to start. */
  | { decision: 'error'; reason: 'lock-timeout' | 'lock-unavailable' | 'lock-error' | 'registry-corrupt' | 'registry-unreadable'; detail?: string };

type ReadResult =
  | { kind: 'ok'; registry: TraexRuntimeRegistryFile }
  | { kind: 'corrupt'; detail: string }
  | { kind: 'unreadable'; detail: string };

function emptyRegistry(): TraexRuntimeRegistryFile {
  return { version: TRAEX_RUNTIME_REGISTRY_VERSION, occupants: [] };
}

function readRegistry(domain: TraexRuntimeDomain): ReadResult {
  let raw: string;
  try {
    raw = readFileSync(domain.registryPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'ok', registry: emptyRegistry() };
    return { kind: 'unreadable', detail: errorText(err) };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return { kind: 'corrupt', detail: 'not an object' };
    const occupants = (parsed as { occupants?: unknown }).occupants;
    if (!Array.isArray(occupants)) return { kind: 'corrupt', detail: 'occupants is not an array' };
    const cleaned: TraexRuntimeOccupant[] = [];
    for (let index = 0; index < occupants.length; index += 1) {
      const occupant = normalizeOccupant(occupants[index]);
      // A row we cannot parse may still describe a live writer. Dropping it
      // would make the domain look empty and let an incompatible runtime
      // start, so the whole registry is treated as corrupt and the gate fails
      // closed until the row is repaired or its owner releases it.
      if (!occupant) {
        return { kind: 'corrupt', detail: `occupant ${index} cannot be normalized` };
      }
      cleaned.push(occupant);
    }
    return { kind: 'ok', registry: { version: TRAEX_RUNTIME_REGISTRY_VERSION, occupants: cleaned } };
  } catch (err) {
    return { kind: 'corrupt', detail: errorText(err) };
  }
}

function normalizeOccupant(value: unknown): TraexRuntimeOccupant | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.occupantId !== 'string' || v.occupantId.length === 0) return undefined;
  if (typeof v.workerPid !== 'number' || !Number.isSafeInteger(v.workerPid)) return undefined;
  if (typeof v.daemonPid !== 'number' || !Number.isSafeInteger(v.daemonPid)) return undefined;
  const phase = v.phase === 'starting' || v.phase === 'running' || v.phase === 'draining'
    ? v.phase
    : 'starting';
  return {
    occupantId: v.occupantId,
    comboKey: typeof v.comboKey === 'string' ? v.comboKey : '',
    ...(typeof v.installSignature === 'string' ? { installSignature: v.installSignature } : {}),
    ...(typeof v.snapshotDir === 'string' ? { snapshotDir: v.snapshotDir } : {}),
    phase,
    workerPid: v.workerPid,
    ...(typeof v.workerStart === 'string' ? { workerStart: v.workerStart } : {}),
    daemonPid: v.daemonPid,
    ...(typeof v.daemonStart === 'string' ? { daemonStart: v.daemonStart } : {}),
    ...(typeof v.cliPid === 'number' ? { cliPid: v.cliPid } : {}),
    ...(typeof v.cliStart === 'string' ? { cliStart: v.cliStart } : {}),
    ...(typeof v.bootId === 'string' ? { bootId: v.bootId } : {}),
    ...(v.fixedPath === true ? { fixedPath: true } : {}),
    ...(v.occupancyOnly === true ? { occupancyOnly: true } : {}),
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
    heartbeatAt: typeof v.heartbeatAt === 'number' ? v.heartbeatAt : 0,
    leaseUntil: typeof v.leaseUntil === 'number' ? v.leaseUntil : 0,
  };
}

function writeRegistry(domain: TraexRuntimeDomain, registry: TraexRuntimeRegistryFile): void {
  atomicWriteFileSync(domain.registryPath, JSON.stringify(registry), {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

export type OccupantLiveness = 'alive' | 'dead' | 'unknown';

/**
 * Is the process a record names still the same process?
 *
 * A recorded birth token that no longer matches is a reused pid: the original
 * process is gone. When no birth token can be read (macOS, permission), the
 * answer is `unknown` — never `dead` — unless the lease has also expired.
 */
function pidLiveness(pid: number | undefined, expectedStart: string | undefined): OccupantLiveness {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return 'unknown';
  const currentStart = readProcessStartIdentity(pid);
  if (currentStart !== undefined) {
    if (expectedStart !== undefined && currentStart !== expectedStart) return 'dead';
    if (isLinuxZombie(pid)) return 'dead';
    return 'alive';
  }
  // No birth token could be read. Distinguish "gone" (kill(2) -> ESRCH, which
  // is authoritative on every POSIX platform) from "cannot tell" (EPERM or an
  // unexpected error). Never call an unreadable-but-existing pid dead.
  if (!pidNotProvablyGone(pid)) return 'dead';
  return 'unknown';
}

/**
 * `alive` if ANY recorded process (CLI, worker/launcher) may still run.
 *
 * The CLI is the only process that writes the shared cache, so once its birth
 * identity is recorded it alone decides liveness: a bot daemon that outlived
 * its worker/CLI must not keep the domain occupied forever. Before the CLI is
 * attached the worker is still a possible future writer, so a live worker keeps
 * the slot; a dead worker does NOT prove the CLI is gone (the exec can happen
 * before the record is updated), hence `unknown` rather than `dead`.
 *
 * A record created in a previous boot names pids that may now belong to
 * unrelated processes; it can never describe a live runtime.
 */
export function occupantLiveness(occupant: TraexRuntimeOccupant, now = Date.now()): OccupantLiveness {
  void now; // liveness is pid/birth based; the lease is only a status hint
  const boot = readLinuxBootIdentity();
  if (occupant.bootId !== undefined && boot !== undefined && occupant.bootId !== boot) return 'dead';
  if (occupant.cliPid !== undefined) {
    const cli = traexCliLiveness(occupant);
    if (cli !== 'dead') return cli;
    // The leaf is gone, but a launcher/helper from the same snapshot can still
    // be alive and writing the shared cache. `undefined` means the platform
    // cannot answer (macOS); fall back to the CLI verdict rather than blocking
    // the domain forever.
    if (occupant.snapshotDir) {
      const writers = findProcessesRunningUnder(occupant.snapshotDir);
      if (writers !== undefined && writers.length > 0) return 'alive';
    }
    return 'dead';
  }
  const worker = pidLiveness(occupant.workerPid, occupant.workerStart);
  return worker === 'alive' ? 'alive' : 'unknown';
}

/**
 * Recover `starting` records whose worker died before attaching the CLI.
 *
 * A daemon crash in the spawn window leaves a reservation with no `cliPid`. If
 * a process is provably running the recorded snapshot, that process IS the
 * runtime this record reserved — adopt its birth identity so the normal
 * liveness path can release it once it exits. When nothing is found the record
 * stays: a forked launcher may not have exec'd yet, and "not visible now" is
 * not proof that no writer will appear.
 */
function reconcileStartingOrphans(occupants: TraexRuntimeOccupant[], now: number): {
  occupants: TraexRuntimeOccupant[];
  changed: boolean;
} {
  let changed = false;
  const next = occupants.map((occupant) => {
    if (occupant.phase !== 'starting' || occupant.cliPid !== undefined || !occupant.snapshotDir) return occupant;
    if (pidLiveness(occupant.workerPid, occupant.workerStart) !== 'dead') return occupant;
    const writers = findProcessesRunningUnder(occupant.snapshotDir);
    if (!writers || writers.length === 0) return occupant;
    const cliPid = writers[0];
    const cliStart = readProcessStartIdentity(cliPid);
    changed = true;
    return {
      ...occupant,
      phase: 'running' as const,
      cliPid,
      ...(cliStart ? { cliStart } : {}),
      heartbeatAt: now,
    };
  });
  return { occupants: next, changed };
}

/**
 * A previous start attempt by the very same worker (same pid and birth token)
 * that never attached a CLI cannot be a concurrent runtime: that worker only
 * execs one CLI per spawn generation, and the new reservation supersedes the
 * old one. A record with a recorded CLI is never superseded here — the normal
 * liveness/prune path decides, so a live old CLI still blocks.
 */
function supersedableSameOwner(
  occupant: TraexRuntimeOccupant,
  request: TraexStartRequest,
): boolean {
  if (occupant.occupancyOnly === true) return false;
  if (occupant.workerPid !== request.workerPid) return false;
  if ((occupant.workerStart ?? undefined) !== (request.workerStart ?? undefined)) return false;
  if (occupant.phase !== 'starting') return false;
  if (occupant.cliPid !== undefined) return traexCliLiveness(occupant) === 'dead';
  return true;
}

function pruneDead(registry: TraexRuntimeRegistryFile, now: number): { occupants: TraexRuntimeOccupant[]; pruned: string[] } {
  const kept: TraexRuntimeOccupant[] = [];
  const pruned: string[] = [];
  for (const occupant of registry.occupants) {
    if (occupantLiveness(occupant, now) === 'dead') pruned.push(occupant.occupantId);
    else kept.push(occupant);
  }
  return { occupants: kept, pruned };
}

function blockersFor(occupants: readonly TraexRuntimeOccupant[], requestedComboKey: string): TraexRuntimeBlocker[] {
  return occupants
    .filter((occupant) => !contentCompatible(occupant.comboKey, requestedComboKey))
    .map((occupant) => ({
      occupantId: occupant.occupantId,
      comboKey: occupant.comboKey,
      phase: occupant.phase,
      fixedPath: occupant.fixedPath === true,
      ...(occupant.cliPid !== undefined ? { pid: occupant.cliPid } : {}),
    }));
}

/**
 * Two runtimes may overlap only when BOTH content identities are proven and
 * equal. Unknown (`''`) is never compatible — not even with another unknown.
 */
export function contentCompatible(a: string, b: string): boolean {
  return a.length > 0 && b.length > 0 && a === b;
}

export function describeTraexRuntimeBlockers(blockers: readonly TraexRuntimeBlocker[]): string {
  return blockers.map((blocker) => {
    const version = blocker.comboKey ? `content ${blocker.comboKey.slice(0, 12)}` : 'unknown content';
    const pid = blocker.pid !== undefined ? `, pid ${blocker.pid}` : '';
    const pinned = blocker.fixedPath ? ', pinned old executable' : '';
    return `${version} (${blocker.phase}${pid}${pinned})`;
  }).join('; ');
}

/**
 * Try to reserve a starting slot for content `comboKey`.
 *
 * The reservation is written BEFORE the CLI is exec'd ("starting" has no pid
 * yet) so a daemon crash in the spawn window still occupies the domain. A
 * later `markTraexRuntimeRunning` attaches the real CLI birth identity.
 */
export async function acquireTraexRuntimeStart(
  domain: TraexRuntimeDomain,
  request: TraexStartRequest,
): Promise<TraexGateDecision> {
  const now = request.now ?? Date.now();
  const locked = await withExclusiveFileLock(domain.lockPath, TRAEX_RUNTIME_LOCK_TIMEOUT_MS, () => {
    const read = readRegistry(domain);
    if (read.kind !== 'ok') return { kind: 'read-failed', read } as const;
    const reconciled = reconcileStartingOrphans(read.registry.occupants, now);
    const base = reconciled.changed
      ? { version: TRAEX_RUNTIME_REGISTRY_VERSION, occupants: reconciled.occupants }
      : read.registry;
    const pruned = pruneDead(base, now);
    // The same worker retrying a start supersedes its own unfinished
    // reservation. Without this a worker that rewrote the install between
    // capture and exec would be blocked by its own `starting` record.
    const superseded: string[] = [];
    const remaining = pruned.occupants.filter((occupant) => {
      if (occupant.occupantId === request.occupantId) return false;
      if (!supersedableSameOwner(occupant, request)) return true;
      superseded.push(occupant.occupantId);
      return false;
    });
    // `force` registers occupancy without asserting content compatibility.
    // Used only for runtimes this worker did not start (adopt/reattach/...),
    // which must still make an incompatible start wait.
    const blockers = request.force === true ? [] : blockersFor(remaining, request.comboKey);
    if (blockers.length > 0) {
      if (pruned.pruned.length > 0 || superseded.length > 0 || reconciled.changed) {
        writeRegistry(domain, { version: TRAEX_RUNTIME_REGISTRY_VERSION, occupants: remaining });
      }
      return { kind: 'blocked', blockers, pruned: [...pruned.pruned, ...superseded] } as const;
    }
    const bootId = readLinuxBootIdentity();
    const occupant: TraexRuntimeOccupant = {
      occupantId: request.occupantId,
      comboKey: request.comboKey,
      ...(request.installSignature ? { installSignature: request.installSignature } : {}),
      ...(request.snapshotDir ? { snapshotDir: request.snapshotDir } : {}),
      phase: 'starting',
      workerPid: request.workerPid,
      ...(request.workerStart ? { workerStart: request.workerStart } : {}),
      daemonPid: request.daemonPid,
      ...(request.daemonStart ? { daemonStart: request.daemonStart } : {}),
      ...(bootId ? { bootId } : {}),
      ...(request.fixedPath ? { fixedPath: true } : {}),
      ...(request.occupancyOnly ? { occupancyOnly: true } : {}),
      createdAt: now,
      heartbeatAt: now,
      leaseUntil: now + TRAEX_RUNTIME_LEASE_MS,
    };
    writeRegistry(domain, {
      version: TRAEX_RUNTIME_REGISTRY_VERSION,
      occupants: [...remaining.filter((existing) => existing.occupantId !== occupant.occupantId), occupant],
    });
    return { kind: 'started', pruned: [...pruned.pruned, ...superseded] } as const;
  });
  if (!locked.acquired) {
    return locked.reason === 'timeout'
      ? { decision: 'error', reason: 'lock-timeout' }
      : locked.reason === 'unavailable'
        ? { decision: 'error', reason: 'lock-unavailable' }
        : { decision: 'error', reason: 'lock-error', detail: locked.detail };
  }
  const outcome = locked.value;
  if (outcome.kind === 'blocked') {
    return { decision: 'blocked', blockers: outcome.blockers, pruned: [...outcome.pruned] };
  }
  if (outcome.kind === 'started') {
    return { decision: 'start', occupantId: request.occupantId, pruned: [...outcome.pruned] };
  }
  return outcome.read.kind === 'corrupt'
    ? { decision: 'error', reason: 'registry-corrupt', detail: outcome.read.detail }
    : { decision: 'error', reason: 'registry-unreadable', detail: outcome.read.detail };
}

/**
 * Attach the real CLI birth identity after exec. A failed update is logged by
 * the caller but never releases the slot: the worker pid already occupies it,
 * and the gate fails closed rather than forget a live runtime.
 */
export async function markTraexRuntimeRunning(
  domain: TraexRuntimeDomain,
  occupantId: string,
  detail: { cliPid: number; cliStart?: string; snapshotDir?: string; now?: number },
): Promise<boolean> {
  return mutateOccupant(domain, occupantId, (occupant, now) => ({
    ...occupant,
    phase: 'running',
    cliPid: detail.cliPid,
    ...(detail.cliStart ? { cliStart: detail.cliStart } : {}),
    ...(detail.snapshotDir ? { snapshotDir: detail.snapshotDir } : {}),
    heartbeatAt: now,
    leaseUntil: now + TRAEX_RUNTIME_LEASE_MS,
  }));
}

/**
 * Downgrade an occupant whose exec target could not be proven to be the
 * snapshot this worker registered.
 *
 * Keeping the previously computed `comboKey` would let another runtime treat
 * it as compatible and start in parallel with unknown bytes. Clearing the key
 * makes it block every start until its process tree is proven gone. The
 * `installSignature` is dropped too: an equal stat signature must never
 * re-upgrade an unproven occupant.
 */
export async function markTraexRuntimeUnknown(
  domain: TraexRuntimeDomain,
  occupantId: string,
  detail: { cliPid?: number; cliStart?: string; snapshotDir?: string; now?: number } = {},
): Promise<boolean> {
  return mutateOccupant(domain, occupantId, (occupant, now) => {
    const { installSignature: _dropped, ...rest } = occupant;
    void _dropped;
    return {
      ...rest,
      comboKey: '',
      ...(detail.cliPid !== undefined ? { cliPid: detail.cliPid } : {}),
      ...(detail.cliStart ? { cliStart: detail.cliStart } : {}),
      ...(detail.snapshotDir ? { snapshotDir: detail.snapshotDir } : {}),
      heartbeatAt: now,
      leaseUntil: now + TRAEX_RUNTIME_LEASE_MS,
    };
  }, detail.now ?? Date.now());
}

export async function heartbeatTraexRuntime(
  domain: TraexRuntimeDomain,
  occupantId: string,
  now = Date.now(),
): Promise<boolean> {
  return mutateOccupant(domain, occupantId, (occupant) => ({
    ...occupant,
    heartbeatAt: now,
    leaseUntil: now + TRAEX_RUNTIME_LEASE_MS,
  }), now);
}

/**
 * Liveness of the CLI this record actually exec'd.
 *
 * Once `cliPid` is recorded it is the only process that writes the shared
 * cache, so it alone decides whether the slot may be released. `undefined`
 * means the record is still `starting` and no CLI has been proven yet.
 */
export function traexCliLiveness(occupant: TraexRuntimeOccupant): OccupantLiveness {
  const boot = readLinuxBootIdentity();
  if (occupant.bootId !== undefined && boot !== undefined && occupant.bootId !== boot) return 'dead';
  return pidLiveness(occupant.cliPid, occupant.cliStart);
}

/** Release one occupant. Only the process that owns it should call this; a
 *  crashed daemon leaves the record for the next start's prune to prove dead. */
export async function releaseTraexRuntime(
  domain: TraexRuntimeDomain,
  occupantId: string,
  options: { requireCliGone?: boolean; now?: number } = {},
): Promise<boolean> {
  const requireCliGone = options.requireCliGone === true;
  const locked = await withExclusiveFileLock(domain.lockPath, TRAEX_RUNTIME_LOCK_TIMEOUT_MS, () => {
    const read = readRegistry(domain);
    if (read.kind !== 'ok') return false;
    const target = read.registry.occupants.find((occupant) => occupant.occupantId === occupantId);
    if (!target) return true;
    if (requireCliGone) {
      // A recorded CLI that cannot be proven dead keeps the domain. Mark it
      // `draining` so status messages explain why a newer content waits, and
      // let a later prune/release finish once the kernel proves it gone.
      // `starting` without a CLI pid is NOT releasable this way: the worker
      // may have exec'd before recording it, so only the explicit
      // `abandonTraexRuntime` (spawn failure) may drop it.
      //
      // The CLI leaf alone is not the whole writer tree: a launcher/helper of
      // the same private snapshot can outlive it. On Linux, scan `/proc/*/exe`
      // for any process still running from the recorded snapshot. `undefined`
      // means the platform cannot answer (macOS); fall back to the CLI verdict
      // rather than blocking forever, matching `occupantLiveness`.
      const cli = traexCliLiveness(target);
      const writers = target.snapshotDir
        ? findProcessesRunningUnder(target.snapshotDir)
        : undefined;
      const writersGone = writers === undefined || writers.length === 0;
      if (cli !== 'dead' || !writersGone) {
        if (target.phase !== 'draining') {
          const now = options.now ?? Date.now();
          writeRegistry(domain, {
            version: TRAEX_RUNTIME_REGISTRY_VERSION,
            occupants: read.registry.occupants.map((occupant) => occupant.occupantId === occupantId
              ? { ...occupant, phase: 'draining', heartbeatAt: now, leaseUntil: now + TRAEX_RUNTIME_LEASE_MS }
              : occupant),
          });
        }
        return false;
      }
    }
    const next = read.registry.occupants.filter((occupant) => occupant.occupantId !== occupantId);
    if (next.length === read.registry.occupants.length) return true;
    writeRegistry(domain, { version: TRAEX_RUNTIME_REGISTRY_VERSION, occupants: next });
    return true;
  });
  return locked.acquired && locked.value;
}

/**
 * Drop a record the owner knows never exec'd a CLI (spawn failed, or the
 * reservation was superseded before the exec point). Never use this while a
 * CLI may be running — that is what `releaseTraexRuntime({requireCliGone})`
 * and the dead-prune are for.
 */
export async function abandonTraexRuntime(
  domain: TraexRuntimeDomain,
  occupantId: string,
): Promise<boolean> {
  return releaseTraexRuntime(domain, occupantId);
}

async function mutateOccupant(
  domain: TraexRuntimeDomain,
  occupantId: string,
  mutate: (occupant: TraexRuntimeOccupant, now: number) => TraexRuntimeOccupant,
  now = Date.now(),
): Promise<boolean> {
  const locked = await withExclusiveFileLock(domain.lockPath, TRAEX_RUNTIME_LOCK_TIMEOUT_MS, () => {
    const read = readRegistry(domain);
    if (read.kind !== 'ok') return false;
    let found = false;
    const occupants = read.registry.occupants.map((occupant) => {
      if (occupant.occupantId !== occupantId) return occupant;
      found = true;
      return mutate(occupant, now);
    });
    if (!found) return false;
    writeRegistry(domain, { version: TRAEX_RUNTIME_REGISTRY_VERSION, occupants });
    return true;
  });
  return locked.acquired && locked.value;
}

/** Read-only snapshot for status messages and tests. Never mutates. */
export function readTraexRuntimeOccupants(domain: TraexRuntimeDomain): TraexRuntimeOccupant[] | undefined {
  if (!existsSync(domain.registryPath)) return [];
  const read = readRegistry(domain);
  return read.kind === 'ok' ? read.registry.occupants : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
