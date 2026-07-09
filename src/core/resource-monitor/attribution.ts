import type {
  ProcessResourceSample,
  ResourceAttributionConfidence,
  ResourceBotCurrent,
  ResourceSessionCurrent,
} from './types.js';
import { sessionRuntimeBucket } from './runtime.js';

export interface ResourceSessionSeed {
  sessionId: string;
  larkAppId: string;
  botName?: string;
  title?: string;
  status?: string;
  spawnedAt?: number;
  lastMessageAt?: number;
  agentAttention?: { kind: string; reason: string; at: number };
  workerPid?: number;
  adoptCliPid?: number;
}

export interface ResourceDaemonSeed {
  larkAppId: string;
  botName?: string;
  pid?: number;
  status?: 'online' | 'offline' | 'unknown';
}

export interface CliMarkerInfo {
  sessionId: string;
}

export interface PreviousSessionStat {
  cpu1mPct: number;
  cpu5mPct: number;
  rssSamples: Array<{ t: number; rssBytes: number }>;
}

export interface AttributionInput {
  processes: ProcessResourceSample[];
  processCpuPct: Map<number, number>;
  sessions: ResourceSessionSeed[];
  daemons: ResourceDaemonSeed[];
  botmuxPids?: number[];
  cliMarkers: Map<number, CliMarkerInfo>;
  previousSessionStats: Map<string, PreviousSessionStat>;
  nowMs: number;
}

export interface AttributionResult {
  sessions: ResourceSessionCurrent[];
  bots: ResourceBotCurrent[];
  botmux: { rssBytes: number; cpuPct: number };
  nextSessionStats: Map<string, PreviousSessionStat>;
}

interface CandidateSet {
  session: ResourceSessionSeed;
  pids: Set<number>;
  workerPid?: number;
  cliPids: number[];
  confidence: ResourceAttributionConfidence;
}

function collectChildren(processes: ProcessResourceSample[]): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const proc of processes) {
    const arr = children.get(proc.ppid) ?? [];
    arr.push(proc.pid);
    children.set(proc.ppid, arr);
  }
  return children;
}

function collectSubtree(rootPid: number | undefined, children: Map<number, number[]>): Set<number> {
  const out = new Set<number>();
  if (!rootPid || rootPid <= 0) return out;
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (!pid || out.has(pid)) continue;
    out.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return out;
}

function addPidTree(target: Set<number>, rootPid: number | undefined, children: Map<number, number[]>): void {
  for (const pid of collectSubtree(rootPid, children)) target.add(pid);
}

function metricFor(pids: Iterable<number>, byPid: Map<number, ProcessResourceSample>, processCpuPct: Map<number, number>): { rssBytes: number; cpuPct: number } {
  let rssBytes = 0;
  let cpuPct = 0;
  for (const pid of pids) {
    const proc = byPid.get(pid);
    if (!proc) continue;
    rssBytes += proc.rssBytes;
    cpuPct += processCpuPct.get(pid) ?? 0;
  }
  return { rssBytes, cpuPct };
}

function nextEma(prev: number | undefined, current: number, alpha: number): number {
  if (!prev || prev <= 0) return current;
  return alpha * current + (1 - alpha) * prev;
}

function rssGrowth5m(samples: Array<{ t: number; rssBytes: number }>, nowMs: number, currentRssBytes: number): number {
  const cutoff = nowMs - 5 * 60_000;
  const base = samples.find(sample => sample.t >= cutoff) ?? samples[0];
  return base ? currentRssBytes - base.rssBytes : 0;
}

function removeAmbiguousPids(candidates: CandidateSet[]): void {
  const owners = new Map<number, Set<string>>();
  for (const candidate of candidates) {
    for (const pid of candidate.pids) {
      const set = owners.get(pid) ?? new Set<string>();
      set.add(candidate.session.sessionId);
      owners.set(pid, set);
    }
  }
  for (const [pid, sessionIds] of owners) {
    if (sessionIds.size <= 1) continue;
    for (const candidate of candidates) candidate.pids.delete(pid);
  }
}

export function attributeResources(input: AttributionInput): AttributionResult {
  const byPid = new Map(input.processes.map(proc => [proc.pid, proc]));
  const children = collectChildren(input.processes);
  const markerPidsBySession = new Map<string, number[]>();
  for (const [pid, marker] of input.cliMarkers) {
    const arr = markerPidsBySession.get(marker.sessionId) ?? [];
    arr.push(pid);
    markerPidsBySession.set(marker.sessionId, arr);
  }

  const candidates: CandidateSet[] = input.sessions.map(session => {
    const pids = new Set<number>();
    const markerPids = markerPidsBySession.get(session.sessionId) ?? [];
    const cliPids = [...markerPids];
    let confidence: ResourceAttributionConfidence = 'unknown';

    if (session.workerPid) {
      addPidTree(pids, session.workerPid, children);
      if (pids.size > 0) confidence = 'descendant';
    }
    for (const markerPid of markerPids) {
      addPidTree(pids, markerPid, children);
      if (byPid.has(markerPid)) pids.add(markerPid);
      if (byPid.has(markerPid)) confidence = 'marker';
    }
    if (session.adoptCliPid) {
      cliPids.push(session.adoptCliPid);
      addPidTree(pids, session.adoptCliPid, children);
      if (byPid.has(session.adoptCliPid)) pids.add(session.adoptCliPid);
      if (byPid.has(session.adoptCliPid)) confidence = 'adopted';
    }

    return { session, pids, workerPid: session.workerPid, cliPids, confidence };
  });

  removeAmbiguousPids(candidates);

  const nextSessionStats = new Map<string, PreviousSessionStat>();
  const sessionPidsByBot = new Map<string, Set<number>>();
  const sessions = candidates.map(candidate => {
    const currentMetric = metricFor(candidate.pids, byPid, input.processCpuPct);
    const prev = input.previousSessionStats.get(candidate.session.sessionId);
    const rssSamples = [...(prev?.rssSamples ?? []), { t: input.nowMs, rssBytes: currentMetric.rssBytes }]
      .filter(sample => input.nowMs - sample.t <= 5 * 60_000);
    const stat: PreviousSessionStat = {
      cpu1mPct: nextEma(prev?.cpu1mPct, currentMetric.cpuPct, 0.3),
      cpu5mPct: nextEma(prev?.cpu5mPct, currentMetric.cpuPct, 0.08),
      rssSamples,
    };
    nextSessionStats.set(candidate.session.sessionId, stat);

    const botPids = sessionPidsByBot.get(candidate.session.larkAppId) ?? new Set<number>();
    for (const pid of candidate.pids) botPids.add(pid);
    sessionPidsByBot.set(candidate.session.larkAppId, botPids);

    return {
      sessionId: candidate.session.sessionId,
      larkAppId: candidate.session.larkAppId,
      botName: candidate.session.botName ?? candidate.session.larkAppId,
      title: candidate.session.title,
      status: candidate.session.status ?? 'unknown',
      spawnedAt: candidate.session.spawnedAt,
      lastMessageAt: candidate.session.lastMessageAt,
      agentAttention: candidate.session.agentAttention,
      current: {
        rssBytes: currentMetric.rssBytes,
        cpuPct: currentMetric.cpuPct,
        cpu1mPct: stat.cpu1mPct,
        cpu5mPct: stat.cpu5mPct,
        rssGrowth5mBytes: rssGrowth5m(rssSamples, input.nowMs, currentMetric.rssBytes),
      },
      tracked: false,
      rankReasons: [],
      confidence: candidate.pids.size > 0 ? candidate.confidence : 'unknown',
      pids: {
        workerPid: candidate.workerPid,
        cliPids: candidate.cliPids,
        sampledPids: candidate.pids.size,
      },
    } satisfies ResourceSessionCurrent;
  });

  const bots = input.daemons.map(daemon => {
    const daemonPids = new Set<number>();
    if (daemon.pid && byPid.has(daemon.pid)) daemonPids.add(daemon.pid);
    const daemonMetric = metricFor(daemonPids, byPid, input.processCpuPct);
    const sessionMetric = metricFor(sessionPidsByBot.get(daemon.larkAppId) ?? [], byPid, input.processCpuPct);
    const botSessions = sessions.filter(session => session.larkAppId === daemon.larkAppId);
    const count = botSessions.length;
    const runtimeSessions = { total: count, working: 0, starting: 0, waiting: 0 };
    for (const session of botSessions) {
      const bucket = sessionRuntimeBucket(session);
      if (bucket === 'working' || bucket === 'starting' || bucket === 'waiting') runtimeSessions[bucket] += 1;
    }
    const daemonStatus = daemon.status ?? (daemon.pid !== undefined && byPid.has(daemon.pid) ? 'online' : 'offline');
    return {
      larkAppId: daemon.larkAppId,
      botName: daemon.botName ?? daemon.larkAppId,
      daemonPid: daemon.pid,
      daemonStatus,
      daemon: daemonMetric,
      sessions: { ...sessionMetric, count },
      runtime: {
        daemonStatus,
        sessions: runtimeSessions,
      },
      total: {
        rssBytes: daemonMetric.rssBytes + sessionMetric.rssBytes,
        cpuPct: daemonMetric.cpuPct + sessionMetric.cpuPct,
      },
    } satisfies ResourceBotCurrent;
  });

  const botmuxPids = new Set<number>(input.botmuxPids ?? []);
  for (const bot of bots) if (bot.daemonPid) botmuxPids.add(bot.daemonPid);
  for (const pids of sessionPidsByBot.values()) {
    for (const pid of pids) botmuxPids.add(pid);
  }

  return {
    sessions,
    bots,
    botmux: metricFor(botmuxPids, byPid, input.processCpuPct),
    nextSessionStats,
  };
}
