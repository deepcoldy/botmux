/**
 * Start gate for managed TRAE runtimes that share one physical skills cache.
 *
 * Authority lives here (not in the daemon) because this is the module the
 * worker calls immediately before it execs a CLI. The same call therefore
 * covers a daemon-driven fork AND an in-worker `restartCliProcess`: there is no
 * second spawn site that could bypass the gate.
 *
 * The gate never "waits for the tail": it only answers "may content X start in
 * this domain right now". Input that must survive a refusal is held by the
 * caller (daemon queue / scheduler deferred record); this module only reports
 * the blockers so the caller can show a precise state.
 *
 * Order is deliberate and fail-closed:
 *   1. resolve the physical domain      (unavailable -> refuse)
 *   2. materialise the content snapshot (any failure -> refuse)
 *   3. reserve `starting` in the registry (lock failure -> refuse)
 * Only after all three succeed may the caller exec the CLI.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';

import { readProcessStartIdentity } from '../utils/process-identity.js';
import {
  resolveTraexRuntimeDomain,
  traexHomeForDomain,
  type TraexDomainResolution,
  type TraexRuntimeDomain,
} from './traex-runtime-domain.js';
import {
  abandonTraexRuntime,
  acquireTraexRuntimeStart,
  describeTraexRuntimeBlockers,
  heartbeatTraexRuntime,
  markTraexRuntimeRunning,
  occupantLiveness,
  readTraexRuntimeOccupants,
  releaseTraexRuntime,
  type TraexRuntimeBlocker,
} from './traex-runtime-registry.js';
import {
  captureTraexExecutableIdentity,
  defaultTraexSnapshotRoot,
  materializeTraexSnapshot,
  releaseDirForExecutable,
  type TraexRuntimeContent,
} from './traex-runtime-snapshot.js';

export interface TraexRuntimeGateInput {
  /** Defaults to the worker's own TRAE_HOME. */
  traeHome?: string;
  /** Directory holding `traex`, `traex-code-mode-host`, `trae-installation.json`. */
  releaseDir: string;
  /** Resolved leaf executable. When present it is the object whose content is
   *  hashed; `releaseDir` must be its directory. Keeping it explicit stops the
   *  gate from re-resolving a path that may have switched after the caller's
   *  own resolution. */
  executablePath?: string;
  workerPid: number;
  workerStart?: string;
  daemonPid: number;
  daemonStart?: string;
  /** Operator pinned an explicit executable: still occupies the domain and is
   *  still gated, it is only exempt from automatic switching. */
  fixedPath?: boolean;
  /** The pinned executable itself (required for fixedPath when `releaseDir`
   *  is not already that path). */
  fixedExecutablePath?: string;
  /** Override the default: snapshots are materialised unless fixedPath is set. */
  materialize?: boolean;
  snapshotsRoot?: string;
  /** How long a start may wait for an incompatible runtime to exit. 0 means a
   *  single attempt; the caller then holds the input and retries later.
   *  `Infinity` waits until the domain frees or `abort` fires. */
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  /** Invoked once per distinct blocker signature while waiting, so the caller
   *  can surface a precise "waiting for old runtime" state without spamming. */
  onBlocked?: (blockers: TraexRuntimeBlocker[], detail: string) => void;
  /** Polled before every attempt. A non-empty return aborts the wait (the
   *  caller's spawn generation changed) and nothing is reserved or released. */
  abort?: () => string | undefined;
}

export interface TraexRuntimeLease {
  occupantId: string;
  domain: TraexRuntimeDomain;
  snapshot: TraexRuntimeContent;
  /** Attach the real CLI birth identity after exec. Never releases the slot. */
  markRunning(cliPid: number, cliStart?: string): Promise<void>;
  heartbeat(): Promise<void>;
  /** Only call once the CLI this lease started is provably gone. A CLI that
   *  cannot be proven gone is marked `draining` and keeps occupying. */
  release(): Promise<void>;
  /** Spawn failed before any CLI existed. Explicit owner assertion. */
  abandon(): Promise<void>;
}

export type TraexGateAcquireResult =
  | { kind: 'granted'; lease: TraexRuntimeLease }
  | { kind: 'blocked'; blockers: TraexRuntimeBlocker[]; detail: string }
  /** The caller cancelled the wait (spawn superseded / shutting down). */
  | { kind: 'aborted'; reason: string }
  | {
      kind: 'error';
      reason:
        | 'uncoordinated'
        | 'snapshot-failed'
        | 'lock-timeout'
        | 'lock-unavailable'
        | 'lock-error'
        | 'registry-corrupt'
        | 'registry-unreadable';
      detail?: string;
    };

/** Files that make up one release identity, in a fixed order. */
const RELEASE_FILES = ['traex', 'traex-code-mode-host', 'trae-installation.json'] as const;

/**
 * Cheap (stat-only) signature of the release entry. It is used for daemon-side
 * pre-checks only — it can never authorize an overlap; the content `comboKey`
 * from the snapshot is the authority.
 */
export function computeTraexInstallSignature(releaseDir: string): string | undefined {
  const parts: string[] = [];
  for (const name of RELEASE_FILES) {
    try {
      const st = statSync(join(releaseDir, name), { bigint: true });
      parts.push(`${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`);
    } catch {
      // A release without the helper/installation file is legitimate; mark the
      // slot absent rather than failing the whole signature.
      parts.push('-');
    }
  }
  return parts.some((part) => part !== '-') ? parts.join('|') : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function leaseFor(
  domain: TraexRuntimeDomain,
  snapshot: TraexRuntimeContent,
  occupantId: string,
): TraexRuntimeLease {
  let releaseCalled = false;
  let abandonCalled = false;
  return {
    occupantId,
    domain,
    snapshot,
    async markRunning(cliPid: number, cliStart?: string): Promise<void> {
      await markTraexRuntimeRunning(domain, occupantId, {
        cliPid,
        ...(cliStart ? { cliStart } : {}),
        snapshotDir: snapshot.dir,
      });
    },
    async heartbeat(): Promise<void> {
      await heartbeatTraexRuntime(domain, occupantId);
    },
    async release(): Promise<void> {
      if (releaseCalled) return;
      releaseCalled = true;
      await releaseTraexRuntime(domain, occupantId, { requireCliGone: true });
    },
    async abandon(): Promise<void> {
      if (abandonCalled) return;
      abandonCalled = true;
      await abandonTraexRuntime(domain, occupantId);
    },
  };
}

/**
 * Reserve the right to exec the release currently at `releaseDir`.
 *
 * `blocked` means an incompatible runtime still occupies the shared cache. The
 * caller MUST keep the input and retry; it must not substitute a different
 * binary. `error` means the gate could not be consulted and the caller MUST
 * refuse to start.
 */
export async function acquireTraexRuntimeLease(
  input: TraexRuntimeGateInput,
): Promise<TraexGateAcquireResult> {
  const now = input.now ?? Date.now;
  const traeHome = input.traeHome ?? traexHomeForDomain();
  const resolution: TraexDomainResolution = resolveTraexRuntimeDomain(traeHome);
  if (resolution.kind !== 'ready') {
    return {
      kind: 'error',
      reason: 'uncoordinated',
      detail: `${resolution.reason}${resolution.detail ? `: ${resolution.detail}` : ''}`,
    };
  }
  const domain = resolution.domain;

  let snapshot: TraexRuntimeContent;
  const fixedExecutable = input.fixedPath === true
    ? (input.fixedExecutablePath ?? input.releaseDir)
    : undefined;
  const executablePath = fixedExecutable ?? input.executablePath;
  const releaseDir = executablePath ? releaseDirForExecutable(executablePath) : input.releaseDir;
  try {
    const shouldMaterialize = input.materialize ?? fixedExecutable === undefined;
    if (shouldMaterialize) {
      snapshot = await materializeTraexSnapshot({
        releaseDir,
        snapshotsRoot: input.snapshotsRoot ?? defaultTraexSnapshotRoot(),
      });
    } else {
      if (!executablePath) {
        return {
          kind: 'error',
          reason: 'snapshot-failed',
          detail: 'an executable path is required to hash a non-materialised runtime',
        };
      }
      snapshot = await captureTraexExecutableIdentity(executablePath);
    }
  } catch (err) {
    return { kind: 'error', reason: 'snapshot-failed', detail: errorText(err) };
  }

  const installSignature = computeTraexInstallSignature(releaseDir);
  const occupantId = [
    input.workerPid,
    input.workerStart ?? 'nostart',
    now(),
    Math.random().toString(36).slice(2, 10),
  ].join('-');
  const deadline = now() + Math.max(0, input.waitMs ?? 0);
  const pollMs = Math.max(50, input.pollMs ?? 500);
  let reportedSignature: string | undefined;

  for (;;) {
    const aborted = input.abort?.();
    if (aborted) return { kind: 'aborted', reason: aborted };
    const decision = await acquireTraexRuntimeStart(domain, {
      occupantId,
      comboKey: snapshot.comboKey,
      ...(installSignature ? { installSignature } : {}),
      workerPid: input.workerPid,
      ...(input.workerStart ? { workerStart: input.workerStart } : {}),
      daemonPid: input.daemonPid,
      ...(input.daemonStart ? { daemonStart: input.daemonStart } : {}),
      ...(input.fixedPath ? { fixedPath: true } : {}),
      now: now(),
    });
    if (decision.decision === 'start') {
      return { kind: 'granted', lease: leaseFor(domain, snapshot, occupantId) };
    }
    if (decision.decision === 'blocked') {
      const signature = decision.blockers
        .map((blocker) => `${blocker.occupantId}:${blocker.comboKey}:${blocker.phase}`)
        .sort()
        .join('|');
      if (signature !== reportedSignature) {
        reportedSignature = signature;
        input.onBlocked?.(decision.blockers, describeTraexRuntimeBlockers(decision.blockers));
      }
      if (now() >= deadline) {
        return {
          kind: 'blocked',
          blockers: decision.blockers,
          detail: describeTraexRuntimeBlockers(decision.blockers),
        };
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      continue;
    }
    return { kind: 'error', reason: decision.reason, detail: decision.detail };
  }
}

export type TraexRuntimePrecheck =
  | { state: 'free' }
  /** Same proven content is already running; a start is safe in parallel. */
  | { state: 'compatible'; occupants: string[] }
  | { state: 'blocked'; blockers: TraexRuntimeBlocker[]; detail: string }
  /** The registry could not be read. Treat as blocked for scheduling. */
  | { state: 'unknown'; detail: string };

/**
 * Read-only daemon-side pre-check.
 *
 * This deliberately does NOT hash the install (that is the worker's job before
 * exec). It compares the cheap install signature: if every occupant was
 * recorded from the same release signature, a new start is very likely the same
 * content; anything else is `blocked` so the scheduler defers instead of
 * spawning into a possible overlap. A false `blocked` only delays a run; a
 * false `compatible` would break the guarantee, hence unknown signatures are
 * never compatible.
 */
export function precheckTraexRuntime(input: {
  traeHome?: string;
  releaseDir: string;
  executablePath?: string;
  now?: number;
}): TraexRuntimePrecheck {
  const traeHome = input.traeHome ?? traexHomeForDomain();
  const resolution = resolveTraexRuntimeDomain(traeHome);
  if (resolution.kind !== 'ready') {
    return { state: 'unknown', detail: `${resolution.reason}${resolution.detail ? `: ${resolution.detail}` : ''}` };
  }
  const occupants = readTraexRuntimeOccupants(resolution.domain);
  if (!occupants) return { state: 'unknown', detail: 'registry unreadable' };
  const now = input.now ?? Date.now();
  const alive = occupants.filter((occupant) => occupantLiveness(occupant, now) !== 'dead');
  if (alive.length === 0) return { state: 'free' };
  const releaseDir = input.executablePath
    ? releaseDirForExecutable(input.executablePath)
    : input.releaseDir;
  const signature = computeTraexInstallSignature(releaseDir);
  const blockers: TraexRuntimeBlocker[] = [];
  for (const occupant of alive) {
    const sameSignature = signature !== undefined
      && occupant.installSignature !== undefined
      && occupant.installSignature === signature;
    // Equal signatures are only "very likely the same content"; they never
    // authorize anything on their own. A missing signature on either side is
    // treated as incompatible so the scheduler defers rather than risks an
    // overlap.
    if (sameSignature) continue;
    blockers.push({
      occupantId: occupant.occupantId,
      comboKey: occupant.comboKey,
      phase: occupant.phase,
      fixedPath: occupant.fixedPath === true,
      ...(occupant.cliPid !== undefined ? { pid: occupant.cliPid } : {}),
    });
  }
  if (blockers.length > 0) {
    return { state: 'blocked', blockers, detail: describeTraexRuntimeBlockers(blockers) };
  }
  return { state: 'compatible', occupants: alive.map((occupant) => occupant.occupantId) };
}

/** Birth token for the worker's own daemon parent (used when reserving). */
export function daemonBirthIdentity(): { daemonPid: number; daemonStart?: string } {
  const daemonPid = process.ppid;
  const daemonStart = readProcessStartIdentity(daemonPid);
  return { daemonPid, ...(daemonStart ? { daemonStart } : {}) };
}

/** Test seam: the gate itself keeps no state; exported for symmetry. */
export function __testOnly_gateDomainKey(traeHome: string): string | undefined {
  const resolution = resolveTraexRuntimeDomain(traeHome);
  return resolution.kind === 'ready' ? resolution.domain.domainKey : undefined;
}
