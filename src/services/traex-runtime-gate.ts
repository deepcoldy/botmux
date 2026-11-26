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
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TRAEX_DOMAIN_KEY_ENV_KEY, TRAEX_OCCUPANT_ID_ENV_KEY } from '../utils/child-env.js';

import { readProcessStartIdentity } from '../utils/process-identity.js';
import {
  resolveInstallIdentity,
  sameExecutableObject,
  type ExecutableIdentity,
} from './cli-install-identity.js';
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
  markTraexRuntimeDeathUnproven,
  markTraexRuntimeRunning,
  markTraexRuntimeUnknown,
  occupantLiveness,
  readTraexRuntimeOccupants,
  reconcileTraexStartingOrphans,
  releaseTraexRuntime,
  type TraexRuntimeBlocker,
} from './traex-runtime-registry.js';
export type { TraexRuntimeBlocker } from './traex-runtime-registry.js';
import {
  captureTraexExecutableIdentity,
  defaultTraexSnapshotRoot,
  materializeTraexSnapshot,
  readTraexSnapshotProvenance,
  releaseDirForExecutable,
  type TraexRuntimeContent,
  type TraexReleaseIdentity,
} from './traex-runtime-snapshot.js';

/** Wrapper and Forge launches do not expose a content identity BotMux can
 * verify before exec. They deliberately retain their pre-handoff behaviour
 * instead of registering an unknown occupant that would serialise every
 * session sharing the same TRAE_HOME. Direct launches and existing-runtime
 * reattachment without those launch modes remain coordinated. */
export function traexLaunchUsesSharedRuntimeGate(launch: {
  wrapperCli?: string | null;
  cliLaunchMode?: string | null;
}): boolean {
  return !launch.wrapperCli?.trim() && launch.cliLaunchMode !== 'forge-traex';
}

export interface TraexRuntimeGateInput {
  /** Defaults to the worker's own TRAE_HOME. */
  traeHome?: string;
  /** Directory holding `traex`, `traex-code-mode-host`, `trae-installation.json`. */
  releaseDir: string;
  /** Updatable install entry (the operator-selected / PATH-resolved alias, NOT
   *  realpath'd). When present the gate re-resolves it on every wait iteration,
   *  so a symlink switched A→B while this start waits is materialised as B
   *  instead of the release that happened to be current when the call began.
   *  `releaseDir` is then ignored. */
  entryPath?: string;
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
  /** Test seam forwarded to materializeTraexSnapshot for deterministic source
   *  mutation between capture and copy. Production callers omit it. */
  __testOnly_onCaptured?: (identity: TraexReleaseIdentity, attempt: number) => Promise<void> | void;
  /** `false` materialises a frozen copy WITHOUT taking the cross-process
   *  domain lease. Used only for session-private caches (scratch COW), where
   *  this runtime cannot contend with another bot's process. */
  coordinate?: boolean;
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
  /** Capture-time source identity registered with this exact occupant. */
  installSignature?: string;
  /** This lease only reserves the domain for a runtime this worker did not
   *  exec (adopt/reattach). Its content identity is unknown until backfilled,
   *  so it blocks incompatible starts and must never authorize one. */
  occupancyOnly?: boolean;
  /** Attach the real CLI birth identity after exec. Never releases the slot.
   *  `identity` backfills content and source-install proof for a record
   *  registered without them (adopt/reattach); it never replaces a proven key. */
  markRunning(
    cliPid: number,
    cliStart?: string,
    identity?: { comboKey?: string; installSignature?: string },
  ): Promise<void>;
  /** The process behind this lease does not run the object we registered.
   *  Downgrade the occupant to unknown so it blocks instead of authorizing a
   *  parallel start with an unproven identity. */
  markUnknown(cliPid?: number, cliStart?: string): Promise<void>;
  /** Persist that the leaf was reported dead but its process group was not
   *  proven gone. Pruning must keep blocking until the group is empty. */
  markDeathUnproven(cliPid: number): Promise<void>;
  /** False for a session-private scratch runtime. Such processes receive a
   *  distinct private ownership marker so coordinated domains can exclude them
   *  without treating every sanitized descendant as unrelated. */
  coordinate?: boolean;
  heartbeat(): Promise<void>;
  /** Only call once the CLI this lease started is provably gone. A CLI that
   *  cannot be proven gone is marked `draining` and keeps occupying. */
  release(): Promise<void>;
  /** Spawn failed before any CLI existed. Explicit owner assertion. */
  abandon(): Promise<void>;
}

export function applyTraexRuntimeOwnershipEnv(
  env: NodeJS.ProcessEnv,
  lease: TraexRuntimeLease | undefined,
): void {
  // Nested daemon/worker environments can carry an older occupant. Clear it
  // first, then stamp only a coordinated NEW exec in its own domain.
  delete env[TRAEX_OCCUPANT_ID_ENV_KEY];
  delete env[TRAEX_DOMAIN_KEY_ENV_KEY];
  if (!lease || lease.occupancyOnly === true || !lease.occupantId || !lease.domain.registryPath) return;
  if (lease.coordinate === false) {
    env[TRAEX_OCCUPANT_ID_ENV_KEY] = `private-${lease.occupantId}`;
    env[TRAEX_DOMAIN_KEY_ENV_KEY] = 'private';
    return;
  }
  env[TRAEX_OCCUPANT_ID_ENV_KEY] = lease.occupantId;
  env[TRAEX_DOMAIN_KEY_ENV_KEY] = lease.domain.domainKey;
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
export function computeTraexInstallSignature(releaseDir: string, executablePath?: string): string | undefined {
  const parts: string[] = [];
  const mainExecutable = executablePath ?? join(releaseDir, 'traex');
  for (const name of RELEASE_FILES) {
    try {
      const st = statSync(name === 'traex' ? mainExecutable : join(releaseDir, name), { bigint: true });
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

/** Resolve the physical leaf, keeping the lexical path when the entry is gone.
 *  The caller still materialises/hashes it, so a vanished entry fails closed
 *  there instead of silently retargeting. */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function leaseFor(
  domain: TraexRuntimeDomain,
  snapshot: TraexRuntimeContent,
  occupantId: string,
  occupancyOnly = false,
  coordinated = true,
): TraexRuntimeLease {
  let releaseCalled = false;
  let abandonCalled = false;
  return {
    occupantId,
    domain,
    snapshot,
    coordinate: coordinated,
    ...(occupancyOnly ? { occupancyOnly: true } : {}),
    async markRunning(
      cliPid: number,
      cliStart?: string,
      identity?: { comboKey?: string; installSignature?: string },
    ): Promise<void> {
      await markTraexRuntimeRunning(domain, occupantId, {
        cliPid,
        ...(cliStart ? { cliStart } : {}),
        ...(snapshot.dir ? { snapshotDir: snapshot.dir } : {}),
        ...(identity?.comboKey ? { comboKey: identity.comboKey } : {}),
        ...(identity?.comboKey && identity.installSignature
          ? { installSignature: identity.installSignature } : {}),
      });
      if (identity?.comboKey && snapshot.comboKey === '') snapshot.comboKey = identity.comboKey;
    },
    async markUnknown(cliPid?: number, cliStart?: string): Promise<void> {
      await markTraexRuntimeUnknown(domain, occupantId, {
        ...(cliPid !== undefined ? { cliPid } : {}),
        ...(cliStart ? { cliStart } : {}),
        ...(snapshot.dir ? { snapshotDir: snapshot.dir } : {}),
      });
    },
    async markDeathUnproven(cliPid: number): Promise<void> {
      await markTraexRuntimeDeathUnproven(domain, occupantId, cliPid);
    },
    async heartbeat(): Promise<void> {
      await heartbeatTraexRuntime(domain, occupantId);
    },
    async release(): Promise<void> {
      if (releaseCalled) return;
      // A release may run before the kernel has reaped the CLI (exit handlers
      // fire in the same tick). Retry a bounded number of times; only a
      // proven release stops the lease. Otherwise the record stays and keeps
      // the domain, which is the fail-closed outcome.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (await releaseTraexRuntime(domain, occupantId, { requireCliGone: true })) {
          releaseCalled = true;
          return;
        }
        await sleep(100 * (attempt + 1));
      }
      throw new Error(`TRAE runtime ${occupantId} could not prove process exit; lease retained for retry`);
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
  const coordinate = input.coordinate !== false;
  let domain: TraexRuntimeDomain | undefined;
  if (coordinate) {
    const traeHome = input.traeHome ?? traexHomeForDomain();
    const resolution: TraexDomainResolution = resolveTraexRuntimeDomain(traeHome);
    if (resolution.kind !== 'ready') {
      return {
        kind: 'error',
        reason: 'uncoordinated',
        detail: `${resolution.reason}${resolution.detail ? `: ${resolution.detail}` : ''}`,
      };
    }
    domain = resolution.domain;
  }

  const fixedExecutable = input.fixedPath === true
    ? (input.fixedExecutablePath ?? input.executablePath)
    : undefined;
  const shouldMaterialize = input.materialize ?? true;
  /**
   * Resolve the object this attempt would exec. Called once per wait iteration
   * when `entryPath` is given so a symlink switch (A→B→C) is observed instead
   * of being frozen at the start of the wait. A pinned fixed path is never
   * re-resolved: the operator chose that exact file.
   */
  const resolveLaunchTarget = (): { executablePath?: string; releaseDir: string } => {
    if (fixedExecutable) {
      return { executablePath: fixedExecutable, releaseDir: releaseDirForExecutable(fixedExecutable) };
    }
    if (input.entryPath) {
      const resolved = realpathOrSelf(input.entryPath);
      return { executablePath: resolved, releaseDir: releaseDirForExecutable(resolved) };
    }
    if (input.executablePath) {
      return {
        executablePath: input.executablePath,
        releaseDir: releaseDirForExecutable(input.executablePath),
      };
    }
    return { releaseDir: input.releaseDir };
  };
  const initialTarget = resolveLaunchTarget();
  const occupantId = [
    input.workerPid,
    input.workerStart ?? 'nostart',
    now(),
    Math.random().toString(36).slice(2, 10),
  ].join('-');
  if (!shouldMaterialize && !initialTarget.executablePath) {
    return {
      kind: 'error',
      reason: 'snapshot-failed',
      detail: 'an executable path is required to hash a non-materialised runtime',
    };
  }

  if (!coordinate) {
    // Session-private cache: freeze the object so a later install switch cannot
    // change what this runtime loads, but do not take a shared-domain lease.
    const aborted = input.abort?.();
    if (aborted) return { kind: 'aborted', reason: aborted };
    try {
      const snapshot = shouldMaterialize
        ? await materializeTraexSnapshot({
            releaseDir: initialTarget.releaseDir,
            ...(initialTarget.executablePath ? { executablePath: initialTarget.executablePath } : {}),
            snapshotsRoot: input.snapshotsRoot ?? defaultTraexSnapshotRoot(),
          })
        : await captureTraexExecutableIdentity(initialTarget.executablePath!);
      return {
        kind: 'granted',
        lease: {
          occupantId,
          coordinate: false,
          domain: {
            domainKey: 'private',
            skillsDir: '',
            registryPath: 'private',
            lockPath: '',
          },
          snapshot,
          occupancyOnly: false,
          async markRunning() { /* private cache: nothing to record */ },
          async markUnknown() { /* private cache: nothing to record */ },
    async markDeathUnproven() { /* private cache: nothing to record */ },
          async heartbeat() { /* private cache: nothing to record */ },
          async release() { /* private cache: nothing to record */ },
          async abandon() { /* private cache: nothing to record */ },
        },
      };
    } catch (err) {
      return { kind: 'error', reason: 'snapshot-failed', detail: errorText(err) };
    }
  }

  if (!domain) {
    return { kind: 'error', reason: 'uncoordinated', detail: 'domain was not resolved' };
  }

  const deadline = now() + Math.max(0, input.waitMs ?? 0);
  const pollMs = Math.max(50, input.pollMs ?? 500);
  let reportedSignature: string | undefined;
  let snapshot: TraexRuntimeContent | undefined;
  let snapshotSignature: string | undefined;
  let installSignature: string | undefined;

  for (;;) {
    const aborted = input.abort?.();
    if (aborted) return { kind: 'aborted', reason: aborted };
    // Re-read the mutable entry AFTER `abort` (which may itself be the point
    // where an upgrade lands) and re-materialise whenever it moved. The
    // registered `comboKey` therefore always names the bytes we are about to
    // exec, never the content that happened to be on disk earlier.
    const target = resolveLaunchTarget();
    const currentSignature = computeTraexInstallSignature(target.releaseDir, target.executablePath);
    if (!snapshot || currentSignature !== snapshotSignature) {
      try {
        snapshot = shouldMaterialize
          ? await materializeTraexSnapshot({
              releaseDir: target.releaseDir,
              ...(target.executablePath ? { executablePath: target.executablePath } : {}),
              snapshotsRoot: input.snapshotsRoot ?? defaultTraexSnapshotRoot(),
              __testOnly_onCaptured: input.__testOnly_onCaptured,
            })
          : await captureTraexExecutableIdentity(target.executablePath!);
        snapshotSignature = snapshot.sourceSignature ?? currentSignature;
        installSignature = snapshot.sourceSignature ?? currentSignature;
      } catch (err) {
        return { kind: 'error', reason: 'snapshot-failed', detail: errorText(err) };
      }
    }
    const decision = await acquireTraexRuntimeStart(domain, {
      occupantId,
      comboKey: snapshot.comboKey,
      ownershipDomainKey: domain.domainKey,
      ...(installSignature ? { installSignature } : {}),
      ...(snapshot.snapshot ? { snapshotDir: snapshot.dir } : {}),
      workerPid: input.workerPid,
      ...(input.workerStart ? { workerStart: input.workerStart } : {}),
      daemonPid: input.daemonPid,
      ...(input.daemonStart ? { daemonStart: input.daemonStart } : {}),
      ...(input.fixedPath ? { fixedPath: true } : {}),
      now: now(),
    });
    if (decision.decision === 'start') {
      const lease = leaseFor(domain, snapshot, occupantId, false, input.coordinate !== false);
      lease.installSignature = installSignature;
      return { kind: 'granted', lease };
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

export interface TraexRuntimeOccupancyInput {
  /** Defaults to the worker's own TRAE_HOME. */
  traeHome?: string;
  /** Configured release entry; used for status only, never as content proof. */
  releaseDir: string;
  /** The target CLI pid, when already known (adopt/reattach). Only pass it
   *  when it is proven to be the CLI; it becomes the record's prune identity. */
  cliPid?: number;
  cliStart?: string;
  workerPid: number;
  workerStart?: string;
  daemonPid: number;
  daemonStart?: string;
  fixedPath?: boolean;
  /**
   * `true` registers a runtime this worker did NOT exec: an adopted pane, a
   * persistent reattach, or an already-running app-server endpoint. It may be
   * registered beside an occupant because it is already alive; it is recorded
   * as unknown so it blocks every later start.
   *
   * `false`/undefined is the low-level fail-closed reservation for a NEW exec
   * whose content cannot be proven. The worker's wrapper/forge launch modes do
   * not call this API: they are excluded by traexLaunchUsesSharedRuntimeGate.
   */
  existingRuntime?: boolean;
  /** `false` for a session-private cache (scratch COW): freeze nothing and take
   *  no cross-process domain lease. */
  coordinate?: boolean;
  /** How long a new exec may wait for incompatible occupants to exit. 0 means a
   *  single attempt; the caller then keeps its input and retries later. */
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  onBlocked?: (blockers: TraexRuntimeBlocker[], detail: string) => void;
  abort?: () => string | undefined;
}

function privateOccupancyLease(releaseDir: string): TraexRuntimeLease {
  return {
    occupantId: '',
    domain: { domainKey: 'private', skillsDir: '', registryPath: '', lockPath: '' },
    snapshot: { comboKey: '', dir: '', traexPath: releaseDir, reused: false, snapshot: false },
    occupancyOnly: true,
    async markRunning() { /* private cache: nothing to record */ },
    async markUnknown() { /* private cache: nothing to record */ },
    async markDeathUnproven() { /* private cache: nothing to record */ },
    async heartbeat() { /* private cache: nothing to record */ },
    async release() { /* private cache: nothing to record */ },
    async abandon() { /* private cache: nothing to record */ },
  };
}

export interface TraexRuntimePeerLeaseInput {
  workerPid: number;
  workerStart?: string;
  daemonPid: number;
  daemonStart?: string;
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  onBlocked?: (blockers: TraexRuntimeBlocker[], detail: string) => void;
  abort?: () => string | undefined;
}

/** Register a second real process against an already-frozen compatible runtime.
 * The peer shares content/snapshot facts, never the parent's scalar cliPid. */
export async function acquireTraexRuntimePeerLease(
  parent: TraexRuntimeLease,
  input: TraexRuntimePeerLeaseInput,
): Promise<TraexGateAcquireResult> {
  if (parent.occupancyOnly || !parent.snapshot.comboKey) {
    return { kind: 'error', reason: 'uncoordinated', detail: 'peer requires a proven coordinated lease' };
  }
  const now = input.now ?? Date.now;
  const occupantId = [input.workerPid, input.workerStart ?? 'nostart', now(), Math.random().toString(36).slice(2, 10)].join('-');
  const installSignature = parent.installSignature ?? parent.snapshot.sourceSignature ?? parent.snapshot.manifest?.sourceSignature;
  const deadline = now() + Math.max(0, input.waitMs ?? 0);
  const pollMs = Math.max(50, input.pollMs ?? 500);
  let reportedSignature: string | undefined;
  for (;;) {
    const aborted = input.abort?.();
    if (aborted) return { kind: 'aborted', reason: aborted };
    const decision = await acquireTraexRuntimeStart(parent.domain, {
      occupantId,
      comboKey: parent.snapshot.comboKey,
      ownershipDomainKey: parent.domain.domainKey,
      ...(installSignature ? { installSignature } : {}),
      ...(parent.snapshot.snapshot ? { snapshotDir: parent.snapshot.dir } : {}),
      workerPid: input.workerPid,
      ...(input.workerStart ? { workerStart: input.workerStart } : {}),
      daemonPid: input.daemonPid,
      ...(input.daemonStart ? { daemonStart: input.daemonStart } : {}),
      ...(parent.snapshot.snapshot === false ? { fixedPath: true } : {}),
      now: now(),
    });
    if (decision.decision === 'start') {
      const lease = leaseFor(parent.domain, parent.snapshot, occupantId);
      lease.installSignature = installSignature;
      return { kind: 'granted', lease };
    }
    if (decision.decision === 'blocked') {
      const signature = decision.blockers.map(blocker => `${blocker.occupantId}:${blocker.comboKey}:${blocker.phase}`).sort().join('|');
      if (signature !== reportedSignature) {
        reportedSignature = signature;
        input.onBlocked?.(decision.blockers, describeTraexRuntimeBlockers(decision.blockers));
      }
      if (now() >= deadline) {
        return { kind: 'blocked', blockers: decision.blockers, detail: describeTraexRuntimeBlockers(decision.blockers) };
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      continue;
    }
    return { kind: 'error', reason: decision.reason, detail: decision.detail };
  }
}

/**
 * Reserve the domain for a runtime this worker did NOT exec.
 *
 * Adopted panes, persistent reattaches and existing app-server endpoints are
 * already running: they are registered as UNKNOWN (`comboKey: ''`) without
 * demanding compatibility (`existingRuntime: true`). They never authorize a
 * parallel start, and a newer content waits for them to be proven gone. They
 * are never killed or retargeted.
 *
 * The worker's wrapper/forge modes are excluded before reaching this function;
 * see traexLaunchUsesSharedRuntimeGate. This API's unknown-new-exec branch stays
 * fail-closed for any other low-level caller.
 */
export async function acquireTraexRuntimeOccupancy(
  input: TraexRuntimeOccupancyInput,
): Promise<TraexGateAcquireResult> {
  const now = input.now ?? Date.now;
  const coordinate = input.coordinate !== false;
  if (!coordinate) {
    const aborted = input.abort?.();
    if (aborted) return { kind: 'aborted', reason: aborted };
    return { kind: 'granted', lease: privateOccupancyLease(input.releaseDir) };
  }
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
      comboKey: '',
      force: input.existingRuntime === true,
      occupancyOnly: input.existingRuntime === true,
      ...(input.releaseDir ? { traexPath: input.releaseDir } : {}),
      ...(input.cliPid !== undefined ? { cliPid: input.cliPid } : {}),
      ...(input.cliStart ? { cliStart: input.cliStart } : {}),
      workerPid: input.workerPid,
      ...(input.workerStart ? { workerStart: input.workerStart } : {}),
      daemonPid: input.daemonPid,
      ...(input.daemonStart ? { daemonStart: input.daemonStart } : {}),
      ...(input.fixedPath ? { fixedPath: true } : {}),
      now: now(),
    });
    if (decision.decision === 'start') {
      const snapshot: TraexRuntimeContent = {
        comboKey: '',
        dir: '',
        traexPath: input.releaseDir,
        reused: false,
        snapshot: false,
      };
      return { kind: 'granted', lease: leaseFor(domain, snapshot, occupantId, true, input.coordinate !== false) };
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
  const reconciled = reconcileTraexStartingOrphans(occupants, now);
  const alive = reconciled.occupants.filter((occupant) => occupantLiveness(occupant, now) !== 'dead');
  if (alive.length === 0) return { state: 'free' };
  const releaseDir = input.executablePath
    ? releaseDirForExecutable(input.executablePath)
    : input.releaseDir;
  const signature = computeTraexInstallSignature(releaseDir, input.executablePath);
  const blockers: TraexRuntimeBlocker[] = [];
  for (const occupant of alive) {
    // An occupant whose content was never proven can never be "the same
    // version": an equal stat signature says nothing about what it runs.
    if (occupant.comboKey.length === 0) {
      blockers.push({
        occupantId: occupant.occupantId,
        comboKey: occupant.comboKey,
        phase: occupant.phase,
        fixedPath: occupant.fixedPath === true,
        ...(occupant.cliPid !== undefined ? { pid: occupant.cliPid } : {}),
      });
      continue;
    }
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

/** Recover both content and cheap scheduling identity for an already-running
 * executable. The display path is only a hint: prove it still names the same
 * object the kernel reported before hashing it. An unlink+in-place replacement
 * therefore stays unknown instead of relabelling old process bytes as new. */
export async function captureTraexRunningContentIdentity(
  running: ExecutableIdentity,
): Promise<{ comboKey: string; installSignature?: string } | undefined> {
  if (!sameExecutableObject(running, resolveInstallIdentity(running.path))) return undefined;
  const provenance = readTraexSnapshotProvenance(running.path);
  if (provenance) {
    return {
      comboKey: provenance.manifest.comboKey,
      ...(provenance.sourceSignature ? { installSignature: provenance.sourceSignature } : {}),
    };
  }
  const comboKey = (await captureTraexExecutableIdentity(running.path)).comboKey;
  if (!comboKey) return undefined;
  const installSignature = computeTraexInstallSignature(releaseDirForExecutable(running.path), running.path);
  return {
    comboKey,
    ...(installSignature ? { installSignature } : {}),
  };
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
