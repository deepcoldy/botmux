import {
  cliIdForComm,
  findLaunchedCliPid,
  readComm,
  scheduleWrapperRealCliPid,
  snapshotChildPids,
  type WrapperRealPidResolveDeps,
} from './session-discovery.js';

/**
 * Locating the real TRAE process under a launcher.
 *
 * Under the file sandbox / credential-only bwrap / Forge, the pane process is a
 * launcher; only the `traex` leaf holds the rollout fd the submit-ownership gate
 * (findTraexRolloutSetByPid) reads. Until the leaf is bound, every submit is
 * confirmed WITHOUT a session id, the transcript bridge never attaches, and the
 * turn is retired when its pre-start lease expires — the reply is lost.
 *
 * Depth: the network-policy sandbox stacks the most layers. Measured on a real
 * launch (unshare + slirp4netns + bwrap), counting from the pane's first child:
 *   scope payload: sandbox-network-runner → unshare → runner --inside
 *   → network-filter sh → its pipeline subshell (exec'd to the isolation sh)
 *   → isolation subshell (exec'd to bwrap) → bwrap pid-ns init → traex
 * puts traex at depth 7 below the session-scope supervisor and 8 below an OSC
 * relay in front of it, past the generic 6-level wrapper search. The bound
 * leaves headroom for one more wrapper (e.g. a wrapperCli in the sandbox).
 */
const TRAEX_LEAF_SEARCH_DEPTH = 16;

/**
 * The launcher may need far longer than a wrapperCli to fork TRAE: the network
 * runner alone waits up to 10s each for its namespace and its slirp link, and
 * bwrap/scratch setup comes on top. Keep looking for as long as the same backend
 * still runs the same pane child (the shared stale-backend fence ends the loop
 * on close / respawn); the cap only bounds a launcher that never forks TRAE.
 */
const TRAEX_LEAF_RETRY_INTERVAL_MS = 500;
const TRAEX_LEAF_RETRY_MAX_ATTEMPTS = 600;

export interface TraexLeafProbes {
  childrenOf?: (pid: number) => number[];
  commOf?: (pid: number) => string | undefined;
}

export function isTraexProcess(pid: number, commOf: TraexLeafProbes['commOf'] = readComm): boolean {
  const comm = commOf(pid);
  return comm !== undefined && cliIdForComm(comm, 'traex') === 'traex';
}

/** Shallowest `traex` descendant of `launcherPid` (null until it is forked).
 *  One process-table read per call regardless of chain depth. */
export function findTraexLeafPid(launcherPid: number, probes: TraexLeafProbes = {}): number | null {
  return findLaunchedCliPid(launcherPid, 'traex', TRAEX_LEAF_SEARCH_DEPTH, {
    childrenOf: probes.childrenOf ?? snapshotChildPids(),
    ...(probes.commOf ? { commOf: probes.commOf } : {}),
  });
}

/** The pid the TRAE ownership gate must read. Outside launcher shapes the
 *  candidate is returned unchanged; a candidate that already IS TRAE is kept
 *  (a deeper TRAE child, if any, is not this session's root). Otherwise descend
 *  to the leaf, failing closed to the candidate while it is not forked yet. */
export function resolveTraexOwnershipPid(
  candidatePid: number,
  launcherActive: boolean,
  probes: TraexLeafProbes = {},
): number {
  if (!launcherActive || !candidatePid) return candidatePid;
  if (isTraexProcess(candidatePid, probes.commOf)) return candidatePid;
  return findTraexLeafPid(candidatePid, probes) ?? candidatePid;
}

export type TraexLeafResolveDeps = Omit<WrapperRealPidResolveDeps, 'findRealPid' | 'intervalMs' | 'maxAttempts'> & {
  probes?: TraexLeafProbes;
};

/** Retry loop binding the TRAE leaf under `launcherPid` (see the budget note). */
export function scheduleTraexLeafPidResolve(launcherPid: number, deps: TraexLeafResolveDeps): void {
  const { probes, ...rest } = deps;
  scheduleWrapperRealCliPid(launcherPid, {
    ...rest,
    findRealPid: lp => findTraexLeafPid(lp, probes),
    intervalMs: TRAEX_LEAF_RETRY_INTERVAL_MS,
    maxAttempts: TRAEX_LEAF_RETRY_MAX_ATTEMPTS,
  });
}
