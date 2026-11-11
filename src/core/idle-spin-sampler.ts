import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cpus, platform } from 'node:os';
import { parseProcessStat } from './resource-monitor/procfs.js';
import type { CliMarkerInfo } from './resource-monitor/attribution.js';

/**
 * CPU attribution for the idle-spin policy.
 *
 * Why this is not `sampleProcfs()`: the daemon already runs 50+ times on one
 * host. A full `/proc` sweep per daemon per tick would make the fix itself a
 * load source. This sampler only walks the process subtrees of candidate
 * sessions, and it prefers the worker's private-IPC attestation over the
 * child-writable `.botmux-cli-pids` marker.
 *
 * Attribution rules:
 *  - attestation present → cliPid subtree ∪ enginePid subtree ∪ worker pid
 *    subtree. A stale workerGeneration or procStart fails the session closed.
 *  - attestation absent → marker pids for the session (procStart validated)
 *    ∪ worker pid subtree. No marker → fail closed.
 *  - a pid claimed by more than one session is removed from all of them
 *    (ambiguous ownership must never authorize a suspend).
 *  - a subtree that exceeds the pid/thread caps fails closed instead of being
 *    truncated (truncation would under-count CPU and could miss a spinner).
 *
 * `cpuPercent` is PERCENT OF ONE LOGICAL CORE (100 = one full core), derived
 * from this interval's process CPU ticks divided by the host's total ticks
 * across all cores.
 */

export interface IdleSpinAttestation {
  workerGeneration?: number;
  cliPid?: number;
  cliProcStart?: string;
  enginePid?: number;
  engineProcStart?: string;
}

export interface IdleSpinTarget {
  sessionId: string;
  workerPid?: number;
  workerGeneration?: number;
  attestation?: IdleSpinAttestation;
}

export type IdleSpinConfidence = 'attestation' | 'marker' | 'worker';

export interface IdleSpinSessionSample {
  sessionId: string;
  /** Percent of one logical core. */
  cpuPercent: number;
  pids: number;
  confidence: IdleSpinConfidence;
}

export interface IdleSpinSample {
  supported: boolean;
  sampledAt: number;
  cpuCount: number;
  /** Host-wide CPU utilization, 0..100. */
  hostCpuPct: number;
  sessions: Map<string, IdleSpinSessionSample>;
  invalid: Map<string, string>;
}

export interface IdleSpinSamplerOptions {
  procRoot?: string;
  cpuCount?: number;
  platform?: NodeJS.Platform;
  /** Full thread scan every N samples; other samples scan the main thread and
   *  the threads that previously produced children. Default 10. */
  fullThreadScanEverySamples?: number;
  maxPidsPerSession?: number;
  maxThreadsPerProcess?: number;
  /**
   * Whether `/proc/<pid>/task/<tid>/children` is available. Default probes
   * `/proc/<this pid>/task/<this pid>/children`. When absent (kernel without
   * CONFIG_PROC_CHILDREN, hidepid, old kernel), the sampler falls back to one
   * full `/proc/<pid>/stat` ppid scan for that tick instead of silently
   * treating every process as childless.
   */
  childrenSupported?: boolean;
  now?: () => number;
}

export interface IdleSpinSampler {
  sample(
    targets: readonly IdleSpinTarget[],
    markers?: ReadonlyMap<number, CliMarkerInfo>,
  ): Promise<IdleSpinSample>;
  /**
   * Live direct child processes of each target's CLI roots (attestation
   * `cliPid` / `enginePid`, or stamped markers when attestation is absent),
   * excluding the other roots of the same session and the worker. Read fresh
   * (full thread scan, no cache) because it gates a destructive action.
   *
   * A CLI child is a tool shell, a background task (TRAE `background_shell`,
   * dev server, build, watcher), an MCP server, …: work a suspend would kill.
   * botmux has no structured background-task signal for most CLIs (TRAE
   * included), so a positive count must veto an automatic suspend.
   *
   * `null` = the roots cannot be proven or their children cannot be read
   * (missing/recycled root, unreadable task dir, thread cap, non-Linux): the
   * caller must fail closed.
   */
  liveCliChildren(
    targets: readonly IdleSpinTarget[],
    markers?: ReadonlyMap<number, CliMarkerInfo>,
  ): Map<string, number | null>;
  reset(): void;
}

interface ProcTickRow {
  pid: number;
  ppid: number;
  cpuTicks: number;
  startTicks: string;
}

interface ThreadScanCacheEntry {
  startTicks: string;
  childThreads: Set<number>;
}

type MarkerWithPid = CliMarkerInfo & { pid: number };

const DEFAULT_MAX_PIDS_PER_SESSION = 512;
const DEFAULT_MAX_THREADS_PER_PROCESS = 256;
const DEFAULT_FULL_THREAD_SCAN_EVERY = 10;
const YIELD_EVERY_PIDS = 64;

function emptySample(sampledAt: number, cpuCount: number, supported: boolean): IdleSpinSample {
  return {
    supported,
    sampledAt,
    cpuCount,
    hostCpuPct: 0,
    sessions: new Map(),
    invalid: new Map(),
  };
}

function parseNumericList(raw: string): number[] {
  const out: number[] = [];
  for (const token of raw.trim().split(/\s+/)) {
    if (!token) continue;
    const value = Number(token);
    if (Number.isSafeInteger(value) && value > 0) out.push(value);
  }
  return out;
}

export function createIdleSpinSampler(opts: IdleSpinSamplerOptions = {}): IdleSpinSampler {
  const procRoot = opts.procRoot ?? '/proc';
  const cpuCount = opts.cpuCount ?? Math.max(1, cpus().length);
  const runtimePlatform = opts.platform ?? platform();
  const fullThreadScanEverySamples = Math.max(1, opts.fullThreadScanEverySamples ?? DEFAULT_FULL_THREAD_SCAN_EVERY);
  const maxPidsPerSession = Math.max(1, opts.maxPidsPerSession ?? DEFAULT_MAX_PIDS_PER_SESSION);
  const maxThreadsPerProcess = Math.max(1, opts.maxThreadsPerProcess ?? DEFAULT_MAX_THREADS_PER_PROCESS);
  const now = opts.now ?? (() => Date.now());
  const childrenSupported = opts.childrenSupported ?? (
    procRoot === '/proc'
      ? existsSync(`${procRoot}/${process.pid}/task/${process.pid}/children`)
      : true
  );

  const threadCache = new Map<string, ThreadScanCacheEntry>();
  /**
   * Per-session subtree cache. Re-walking a 68-thread traex tree every 30s for
   * every candidate is the dominant sampling cost; the pid set is stable while
   * the CLI is idle, so ordinary samples only read the cached pids' stat rows.
   * The tree is re-walked every `treeRefreshEverySamples` ticks (or earlier on
   * a root change / missing pid / start-stamp change), so a forked tool process
   * is discovered within a bounded window.
   */
  const treeCache = new Map<string, {
    rootsKey: string;
    pids: number[];
    startTicks: Map<number, string>;
    checkedAtSample: number;
  }>();
  const treeRefreshEverySamples = Math.max(1, opts.fullThreadScanEverySamples ?? DEFAULT_FULL_THREAD_SCAN_EVERY);
  let sampleCount = 0;
  let previousTotalCpuTicks: number | undefined;
  let previousIdleCpuTicks: number | undefined;
  let previousPids = new Map<number, ProcTickRow>();
  /** Per-sample lazy ppid map for the no-children-file fallback. */
  let fallbackChildren: Map<number, number[]> | null | undefined;

  function readStatRow(pid: number): ProcTickRow | null {
    try {
      const raw = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
      const parsed = parseProcessStat(raw);
      if (!parsed) return null;
      return {
        pid,
        ppid: parsed.ppid,
        cpuTicks: parsed.cpuTicks,
        startTicks: String(parsed.startTicks),
      };
    } catch {
      return null;
    }
  }

  function readSystemCpu(): { total: number; idle: number } | null {
    try {
      const raw = readFileSync(`${procRoot}/stat`, 'utf8');
      const line = raw.split('\n').find(part => part.startsWith('cpu '));
      if (!line) return null;
      const values = line.trim().split(/\s+/).slice(1).map(value => Number(value) || 0);
      return {
        total: values.reduce((sum, value) => sum + value, 0),
        idle: (values[3] || 0) + (values[4] || 0),
      };
    } catch {
      return null;
    }
  }

  function readThreadIds(pid: number): number[] | null {
    try {
      const tids: number[] = [];
      for (const entry of readdirSync(`${procRoot}/${pid}/task`)) {
        if (!/^\d+$/.test(entry)) continue;
        tids.push(Number(entry));
      }
      return tids;
    } catch {
      return null;
    }
  }

  type ChildrenRead = { children: number[] } | { error: NodeJS.ErrnoException };

  function readChildrenForThread(pid: number, tid: number): ChildrenRead {
    try {
      return { children: parseNumericList(readFileSync(`${procRoot}/${pid}/task/${tid}/children`, 'utf8')) };
    } catch (err) {
      return { error: err as NodeJS.ErrnoException };
    }
  }

  /**
   * Full `/proc` ppid scan used only when the kernel does not expose
   * per-thread `children` files. One stat read per process; no cmdline / smaps.
   * Returns null on failure so the caller fails closed instead of under-counting.
   */
  function buildFallbackChildren(): Map<number, number[]> | null {
    try {
      const children = new Map<number, number[]>();
      for (const entry of readdirSync(procRoot)) {
        if (!/^\d+$/.test(entry)) continue;
        const row = readStatRow(Number(entry));
        if (!row) continue;
        const siblings = children.get(row.ppid) ?? [];
        siblings.push(row.pid);
        children.set(row.ppid, siblings);
      }
      return children;
    } catch {
      return null;
    }
  }

  /**
   * Direct children of `pid`, using `/proc/<pid>/task/<tid>/children`.
   *
   * Scanning all threads every sample costs ~0.17ms for a 68-thread traex;
   * with dozens of candidates that is measurable. The cache remembers which
   * threads produced children and only rescans those on ordinary samples;
   * every `fullThreadScanEverySamples` ticks it scans all threads so a child
   * forked by a newly-created thread is discovered within a bounded window.
   */
  function readChildren(pid: number, fullThreadScan: boolean): number[] | null {
    // Kernels without per-thread `children` (or hidepid) must not look like
    // "this process has no children": that under-counts CPU and can miss the
    // spinner entirely. Fall back to one ppid scan for this tick; if even that
    // is unavailable, fail closed.
    if (!childrenSupported) {
      if (!fallbackChildren) fallbackChildren = buildFallbackChildren();
      return fallbackChildren ? (fallbackChildren.get(pid) ?? []) : null;
    }

    const tids = readThreadIds(pid);
    if (tids === null) return null;
    if (tids.length > maxThreadsPerProcess) return null;

    const cacheKey = String(pid);
    const row = readStatRow(pid);
    if (!row) return null;
    const cached = threadCache.get(cacheKey);
    const validCache = cached && cached.startTicks === row.startTicks ? cached : undefined;
    const cacheEntry: ThreadScanCacheEntry = validCache ?? {
      startTicks: row.startTicks,
      childThreads: new Set<number>(),
    };

    const scanTids = new Set<number>();
    scanTids.add(pid);
    if (fullThreadScan) {
      for (const tid of tids) scanTids.add(tid);
    } else {
      for (const tid of cacheEntry.childThreads) {
        if (tids.includes(tid)) scanTids.add(tid);
      }
    }

    const children: number[] = [];
    for (const tid of scanTids) {
      const direct = readChildrenForThread(pid, tid);
      if ('error' in direct) {
        // ENOENT is a thread/process that disappeared between readdir and read;
        // anything else (EACCES, EPERM, hidepid) is unreadable ownership and
        // must fail the session closed rather than under-count.
        if (direct.error.code === 'ENOENT') continue;
        return null;
      }
      if (direct.children.length > 0) {
        cacheEntry.childThreads.add(tid);
        children.push(...direct.children);
      } else if (!fullThreadScan && tid !== pid) {
        cacheEntry.childThreads.delete(tid);
      }
    }
    threadCache.set(cacheKey, cacheEntry);
    return children;
  }

  function collectSubtree(rootPid: number, fullThreadScan: boolean): Set<number> | null {
    const seen = new Set<number>();
    const stack = [rootPid];
    while (stack.length > 0) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (seen.size > maxPidsPerSession) return null;
      const children = readChildren(pid, fullThreadScan);
      // Unreadable task dir / thread-cap overflow: fail the whole session
      // closed rather than silently under-counting its CPU.
      if (children === null) return null;
      for (const child of children) {
        if (!seen.has(child)) stack.push(child);
      }
    }
    return seen;
  }

  function rootsForTarget(
    target: IdleSpinTarget,
    markersBySession: Map<string, MarkerWithPid[]>,
  ): { roots: Array<{ pid: number; procStart?: string; worker?: true }>; confidence: IdleSpinConfidence } | { invalid: string } {
    const roots: Array<{ pid: number; procStart?: string; worker?: true }> = [];
    let confidence: IdleSpinConfidence = 'worker';

    if (target.attestation) {
      const att = target.attestation;
      if (att.workerGeneration !== undefined && target.workerGeneration !== undefined
        && att.workerGeneration !== target.workerGeneration) {
        return { invalid: 'attestation_generation_mismatch' };
      }
      if (att.cliPid !== undefined) {
        // The worker always publishes the birth stamp with the pid. A missing
        // stamp is an unprovable identity, not a reason to trust the pid.
        if (!att.cliProcStart) return { invalid: 'attestation_missing_proc_start' };
        roots.push({ pid: att.cliPid, procStart: att.cliProcStart });
      }
      if (att.enginePid !== undefined) {
        if (!att.engineProcStart) return { invalid: 'attestation_missing_proc_start' };
        roots.push({ pid: att.enginePid, procStart: att.engineProcStart });
      }
      if (roots.length === 0) return { invalid: 'attestation_without_pid' };
      confidence = 'attestation';
    } else {
      const markers = markersBySession.get(target.sessionId) ?? [];
      for (const marker of markers) {
        // Legacy markers without a birth stamp are unprovable: a recycled pid
        // could point at an unrelated process. Skip them (and fail closed if
        // no stamped marker remains).
        if (!marker.procStart) continue;
        roots.push({ pid: marker.pid, procStart: marker.procStart });
      }
      if (roots.length === 0) return { invalid: 'no_attestation_or_marker' };
      confidence = 'marker';
    }

    if (target.workerPid !== undefined) {
      roots.push({ pid: target.workerPid, worker: true });
    }
    return { roots, confidence };
  }

  function groupMarkersBySession(
    markers: ReadonlyMap<number, CliMarkerInfo> | undefined,
  ): Map<string, MarkerWithPid[]> {
    const markersBySession = new Map<string, MarkerWithPid[]>();
    if (markers) {
      for (const [pid, marker] of markers) {
        const list = markersBySession.get(marker.sessionId) ?? [];
        list.push({ ...marker, pid });
        markersBySession.set(marker.sessionId, list);
      }
    }
    return markersBySession;
  }

  function liveCliChildren(
    targets: readonly IdleSpinTarget[],
    markers?: ReadonlyMap<number, CliMarkerInfo>,
  ): Map<string, number | null> {
    const out = new Map<string, number | null>();
    if (runtimePlatform !== 'linux') {
      for (const target of targets) out.set(target.sessionId, null);
      return out;
    }
    // Fresh per call: the no-children-file fallback must not reuse a ppid map
    // built for an earlier sample.
    fallbackChildren = undefined;
    const markersBySession = groupMarkersBySession(markers);
    for (const target of targets) {
      const rootInfo = rootsForTarget(target, markersBySession);
      if ('invalid' in rootInfo) {
        out.set(target.sessionId, null);
        continue;
      }
      const cliRoots = rootInfo.roots.filter(root => !root.worker);
      const rootPids = new Set(rootInfo.roots.map(root => root.pid));
      let total = 0;
      let provable = cliRoots.length > 0;
      for (const root of cliRoots) {
        const row = readStatRow(root.pid);
        // A vanished or recycled root proves nothing about the CLI's children.
        const children = row && (root.procStart === undefined || row.startTicks === root.procStart)
          ? readChildren(root.pid, true)
          : null;
        if (children === null) {
          provable = false;
          break;
        }
        total += children.filter(pid => !rootPids.has(pid)).length;
      }
      out.set(target.sessionId, provable ? total : null);
    }
    return out;
  }

  async function sample(
    targets: readonly IdleSpinTarget[],
    markers?: ReadonlyMap<number, CliMarkerInfo>,
  ): Promise<IdleSpinSample> {
    const sampledAt = now();
    if (runtimePlatform !== 'linux') return emptySample(sampledAt, cpuCount, false);
    fallbackChildren = undefined;

    const system = readSystemCpu();
    if (!system) return emptySample(sampledAt, cpuCount, false);

    const totalDelta = previousTotalCpuTicks === undefined
      ? 0
      : Math.max(0, system.total - previousTotalCpuTicks);
    const idleDelta = previousIdleCpuTicks === undefined
      ? 0
      : Math.max(0, system.idle - previousIdleCpuTicks);
    const hostCpuPct = totalDelta > 0
      ? Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100))
      : 0;

    if (targets.length === 0) {
      previousTotalCpuTicks = system.total;
      previousIdleCpuTicks = system.idle;
      // A host-only sample moves the host baseline; per-pid deltas measured
      // against an OLDER pid baseline would then be divided by this shorter
      // host window and inflate session CPU. Drop the pid baseline with it.
      previousPids = new Map();
      return {
        supported: true,
        sampledAt,
        cpuCount,
        hostCpuPct,
        sessions: new Map(),
        invalid: new Map(),
      };
    }

    sampleCount += 1;
    const fullThreadScan = sampleCount % fullThreadScanEverySamples === 1;

    const markersBySession = groupMarkersBySession(markers);

    const invalid = new Map<string, string>();
    const currentRows = new Map<number, ProcTickRow>();
    const sessionPids = new Map<string, Set<number>>();
    const sessionConfidence = new Map<string, IdleSpinConfidence>();

    for (const target of targets) {
      const rootInfo = rootsForTarget(target, markersBySession);
      if ('invalid' in rootInfo) {
        invalid.set(target.sessionId, rootInfo.invalid);
        treeCache.delete(target.sessionId);
        continue;
      }
      const rootsKey = rootInfo.roots
        .map(root => `${root.pid}:${root.procStart ?? ''}`)
        .sort()
        .join('|');
      const cached = treeCache.get(target.sessionId);
      let pids: Set<number> | undefined;
      let failed: string | undefined;

      // Fast path: reuse the cached pid set when it is fresh and every cached
      // pid still has the same birth stamp. A missing/reused pid forces a walk.
      if (cached
        && cached.rootsKey === rootsKey
        && sampleCount - cached.checkedAtSample < treeRefreshEverySamples) {
        const cachedPids = new Set<number>();
        let cacheValid = true;
        for (const pid of cached.pids) {
          const row = readStatRow(pid);
          if (!row || row.startTicks !== cached.startTicks.get(pid)) {
            cacheValid = false;
            break;
          }
          currentRows.set(pid, row);
          cachedPids.add(pid);
        }
        if (cacheValid) pids = cachedPids;
      }

      if (!pids) {
        pids = new Set<number>();
        for (const root of rootInfo.roots) {
          const row = readStatRow(root.pid);
          if (!row) {
            // A missing root is not proof of zero CPU; fail closed for this tick.
            failed = 'root_pid_missing';
            break;
          }
          if (root.procStart !== undefined && row.startTicks !== root.procStart) {
            failed = 'proc_start_mismatch';
            break;
          }
          currentRows.set(row.pid, row);
          const subtree = collectSubtree(root.pid, fullThreadScan);
          if (subtree === null) {
            failed = 'process_tree_overflow';
            break;
          }
          for (const pid of subtree) {
            pids.add(pid);
            if (!currentRows.has(pid)) {
              const childRow = readStatRow(pid);
              if (childRow) currentRows.set(pid, childRow);
            }
          }
        }
        if (!failed && pids.size > 0) {
          treeCache.set(target.sessionId, {
            rootsKey,
            pids: [...pids],
            startTicks: new Map(
              [...pids]
                .map(pid => [pid, currentRows.get(pid)?.startTicks] as const)
                .filter((entry): entry is [number, string] => entry[1] !== undefined),
            ),
            checkedAtSample: sampleCount,
          });
        }
      }

      if (failed) {
        invalid.set(target.sessionId, failed);
        treeCache.delete(target.sessionId);
        continue;
      }
      if (pids.size === 0) {
        invalid.set(target.sessionId, 'no_attributable_pid');
        treeCache.delete(target.sessionId);
        continue;
      }
      sessionPids.set(target.sessionId, pids);
      sessionConfidence.set(target.sessionId, rootInfo.confidence);
    }
    // Drop cache entries for sessions that are no longer candidates.
    if (treeCache.size > targets.length * 2) {
      const activeIds = new Set(targets.map(target => target.sessionId));
      for (const sessionId of treeCache.keys()) {
        if (!activeIds.has(sessionId)) treeCache.delete(sessionId);
      }
    }

    // Ambiguous ownership: a pid claimed by two sessions (shared marker dir,
    // stale attestation, reused pid) must not contribute to either.
    const owners = new Map<number, Set<string>>();
    for (const [sessionId, pids] of sessionPids) {
      for (const pid of pids) {
        const set = owners.get(pid) ?? new Set<string>();
        set.add(sessionId);
        owners.set(pid, set);
      }
    }
    for (const [pid, sessionIds] of owners) {
      if (sessionIds.size <= 1) continue;
      for (const sessionId of sessionIds) sessionPids.get(sessionId)?.delete(pid);
    }

    const sessions = new Map<string, IdleSpinSessionSample>();
    let scanned = 0;
    for (const [sessionId, pids] of sessionPids) {
      if (pids.size === 0) {
        invalid.set(sessionId, 'ambiguous_pid');
        continue;
      }
      let deltaTicks = 0;
      for (const pid of pids) {
        const current = currentRows.get(pid);
        const previous = previousPids.get(pid);
        if (!current || !previous) continue;
        if (previous.startTicks !== current.startTicks) continue;
        deltaTicks += Math.max(0, current.cpuTicks - previous.cpuTicks);
      }
      if (totalDelta > 0) {
        sessions.set(sessionId, {
          sessionId,
          cpuPercent: (deltaTicks / totalDelta) * cpuCount * 100,
          pids: pids.size,
          confidence: sessionConfidence.get(sessionId) ?? 'worker',
        });
      }
      scanned += pids.size;
      if (scanned >= YIELD_EVERY_PIDS) {
        scanned = 0;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }

    previousTotalCpuTicks = system.total;
    previousIdleCpuTicks = system.idle;
    previousPids = currentRows;

    return {
      supported: true,
      sampledAt,
      cpuCount,
      hostCpuPct,
      sessions,
      invalid,
    };
  }

  return {
    sample,
    liveCliChildren,
    reset() {
      threadCache.clear();
      treeCache.clear();
      previousTotalCpuTicks = undefined;
      previousIdleCpuTicks = undefined;
      previousPids = new Map();
      sampleCount = 0;
    },
  };
}
