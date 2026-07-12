import { readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { config } from '../config.js';
import {
  attributeResources,
  type CliMarkerInfo,
  type PreviousSessionStat,
  type ResourceDaemonSeed,
  type ResourceSessionSeed,
} from '../core/resource-monitor/attribution.js';
import { sampleProcfs as defaultSampleProcfs } from '../core/resource-monitor/procfs.js';
import { NumericRingSeries } from '../core/resource-monitor/ring-buffer.js';
import { buildRuntimeMonitorSummary } from '../core/resource-monitor/runtime.js';
import { selectTrackedSessions } from '../core/resource-monitor/top-selector.js';
import type {
  HostResourceCurrent,
  ProcessResourceSample,
  ProcfsSample,
  ResourceBotCurrent,
  ResourceCurrentSnapshot,
  ResourceHistorySnapshot,
  ResourceHistorySeries,
  ResourceSessionCurrent,
  RuntimeMonitorSummary,
} from '../core/resource-monitor/types.js';

export interface ResourceMonitorDeps {
  intervalMs?: number;
  topSessionLimit?: number;
  sessionHistoryMs?: number;
  aggregateHistoryMs?: number;
  topGraceMs?: number;
  listSessions: () => ResourceSessionSeed[];
  listDaemons: () => ResourceDaemonSeed[];
  listBotmuxPids?: () => number[];
  sampleProcfs?: (nowMs: number) => ProcfsSample;
  readCliMarkers?: () => Map<number, CliMarkerInfo>;
  nowMs?: () => number;
}

export interface ResourceMonitorService {
  start(): void;
  stop(): void;
  sampleOnce(): void;
  current(): ResourceCurrentSnapshot;
  history(range: '1h' | '3h' | '24h'): ResourceHistorySnapshot;
}

export interface ResourceMonitorDashboardSessionRow {
  sessionId?: unknown;
  larkAppId?: unknown;
  botName?: unknown;
  title?: unknown;
  status?: unknown;
  spawnedAt?: unknown;
  lastMessageAt?: unknown;
  agentAttention?: { kind?: unknown; reason?: unknown; at?: unknown } | null;
  workerPid?: unknown;
  adoptCliPid?: unknown;
}

export interface ResourceMonitorDashboardDaemonRow {
  larkAppId?: unknown;
  botName?: unknown;
  pid?: unknown;
}

export interface ResourceMonitorBotConfigRow {
  larkAppId?: unknown;
  displayName?: unknown;
  name?: unknown;
}

export function toResourceMonitorSessionSeed(row: ResourceMonitorDashboardSessionRow, botNameOverride?: string): ResourceSessionSeed {
  const larkAppId = String(row.larkAppId ?? '');
  const workerPid = typeof row.workerPid === 'number' ? row.workerPid : undefined;
  const adoptCliPid = typeof row.adoptCliPid === 'number' ? row.adoptCliPid : undefined;
  const spawnedAt = typeof row.spawnedAt === 'number' ? row.spawnedAt : undefined;
  const lastMessageAt = typeof row.lastMessageAt === 'number' ? row.lastMessageAt : undefined;
  const attention = row.agentAttention && typeof row.agentAttention.at === 'number'
    ? {
      kind: String(row.agentAttention.kind ?? ''),
      reason: String(row.agentAttention.reason ?? ''),
      at: row.agentAttention.at,
    }
    : undefined;

  return {
    sessionId: String(row.sessionId),
    larkAppId,
    botName: String(botNameOverride ?? row.botName ?? larkAppId),
    title: typeof row.title === 'string' ? row.title : undefined,
    status: String(row.status ?? 'unknown'),
    ...(spawnedAt !== undefined ? { spawnedAt } : {}),
    ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    ...(attention !== undefined ? { agentAttention: attention } : {}),
    ...(workerPid !== undefined ? { workerPid } : {}),
    ...(adoptCliPid !== undefined ? { adoptCliPid } : {}),
  };
}

export function toResourceMonitorDaemonSeed(row: ResourceMonitorDashboardDaemonRow): ResourceDaemonSeed {
  const larkAppId = String(row.larkAppId ?? '');
  const pid = typeof row.pid === 'number' ? row.pid : undefined;

  return {
    larkAppId,
    botName: String(row.botName ?? larkAppId),
    ...(pid !== undefined ? { pid } : {}),
    status: pid ? 'online' : 'offline',
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function buildResourceMonitorDaemonSeeds(
  configs: ResourceMonitorBotConfigRow[],
  onlineRows: ResourceMonitorDashboardDaemonRow[],
): ResourceDaemonSeed[] {
  const onlineByAppId = new Map<string, ResourceMonitorDashboardDaemonRow>();
  for (const row of onlineRows) {
    const larkAppId = nonEmptyString(row.larkAppId);
    if (larkAppId) onlineByAppId.set(larkAppId, row);
  }

  return configs.flatMap((cfg) => {
    const larkAppId = nonEmptyString(cfg.larkAppId);
    if (!larkAppId) return [];
    const online = onlineByAppId.get(larkAppId);
    return [toResourceMonitorDaemonSeed({
      larkAppId,
      botName: nonEmptyString(online?.botName)
        ?? nonEmptyString(cfg.displayName)
        ?? nonEmptyString(cfg.name)
        ?? larkAppId,
      ...(typeof online?.pid === 'number' ? { pid: online.pid } : {}),
    })];
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseHistoryRange(raw: string | null): '1h' | '3h' | '24h' {
  return raw === '1h' || raw === '3h' || raw === '24h' ? raw : '3h';
}

export async function handleResourceMonitorApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: ResourceMonitorService,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/resources/current') {
    json(res, 200, service.current());
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/resources/history') {
    json(res, 200, service.history(parseHistoryRange(url.searchParams.get('range'))));
    return true;
  }
  return false;
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TOP_SESSION_LIMIT = 30;
const DEFAULT_SESSION_HISTORY_MS = 3 * 60 * 60_000;
const DEFAULT_AGGREGATE_HISTORY_MS = 24 * 60 * 60_000;
const DEFAULT_TOP_GRACE_MS = 15 * 60_000;

function emptyCurrent(sampledAt: number, intervalMs: number, supported = false): ResourceCurrentSnapshot {
  return {
    ok: true,
    supported,
    cpuReady: false,
    sampledAt,
    intervalMs,
    ...(supported ? {} : { reason: 'procfs_unavailable' as const }),
    bots: [],
    sessions: [],
    runtime: buildRuntimeMonitorSummary({
      supported,
      sampledAt,
      intervalMs,
      nowMs: sampledAt,
      bots: [],
      sessions: [],
    }),
    rankings: { topCpu: [], topRss: [], topGrowth: [], tracked: [] },
  };
}

function rangeMs(range: '1h' | '3h' | '24h'): number {
  if (range === '1h') return 60 * 60_000;
  if (range === '3h') return 3 * 60 * 60_000;
  return 24 * 60 * 60_000;
}

function capacityFor(historyMs: number, intervalMs: number): number {
  return Math.max(1, Math.ceil(historyMs / intervalMs) + 1);
}

function hostCpuPct(sample: ProcfsSample, previousTotalCpuTicks: number | undefined, previousIdleCpuTicks: number | undefined): number {
  if (previousTotalCpuTicks === undefined || previousIdleCpuTicks === undefined) return 0;
  const totalDelta = Math.max(0, sample.totalCpuTicks - previousTotalCpuTicks);
  const idleDelta = Math.max(0, sample.idleCpuTicks - previousIdleCpuTicks);
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
}

function hostCurrent(sample: ProcfsSample, previousTotalCpuTicks: number | undefined, previousIdleCpuTicks: number | undefined): HostResourceCurrent {
  const memTotalBytes = sample.mem.memTotalBytes;
  const memAvailableBytes = sample.mem.memAvailableBytes;
  const swapUsedBytes = Math.max(0, sample.mem.swapTotalBytes - sample.mem.swapFreeBytes);
  return {
    cpuPct: hostCpuPct(sample, previousTotalCpuTicks, previousIdleCpuTicks),
    load1: sample.loadavg.load1,
    load5: sample.loadavg.load5,
    load15: sample.loadavg.load15,
    memTotalBytes,
    memAvailableBytes,
    memUsedPct: memTotalBytes > 0 ? ((memTotalBytes - memAvailableBytes) / memTotalBytes) * 100 : 0,
    swapUsedPct: sample.mem.swapTotalBytes > 0 ? (swapUsedBytes / sample.mem.swapTotalBytes) * 100 : 0,
  };
}

function processCpuPct(
  processes: ProcessResourceSample[],
  previousProcessTicks: Map<number, number>,
  totalDelta: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (totalDelta <= 0) return out;
  for (const proc of processes) {
    const prev = previousProcessTicks.get(proc.pid);
    if (prev === undefined) continue;
    const delta = Math.max(0, proc.cpuTicks - prev);
    out.set(proc.pid, (delta / totalDelta) * 100);
  }
  return out;
}

function snapshotProcessTicks(processes: ProcessResourceSample[]): Map<number, number> {
  return new Map(processes.map(proc => [proc.pid, proc.cpuTicks]));
}

function markerFromRaw(raw: string): CliMarkerInfo | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { sessionId?: unknown; procStart?: unknown };
    return typeof parsed.sessionId === 'string' && parsed.sessionId
      ? {
        sessionId: parsed.sessionId,
        ...(typeof parsed.procStart === 'string' && parsed.procStart ? { procStart: parsed.procStart } : {}),
      }
      : null;
  } catch {
    return { sessionId: trimmed };
  }
}

export function readCliPidMarkers(dataDir = config.session.dataDir): Map<number, CliMarkerInfo> {
  const out = new Map<number, CliMarkerInfo>();
  const dir = join(dataDir, '.botmux-cli-pids');
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of files) {
    if (!/^\d+$/.test(file)) continue;
    try {
      const marker = markerFromRaw(readFileSync(join(dir, file), 'utf8'));
      if (marker) out.set(Number(file), marker);
    } catch {
      // Ignore stale or corrupt markers; attribution remains unknown.
    }
  }
  return out;
}

export function createResourceMonitorService(deps: ResourceMonitorDeps): ResourceMonitorService {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const topSessionLimit = deps.topSessionLimit ?? DEFAULT_TOP_SESSION_LIMIT;
  const sessionHistoryMs = deps.sessionHistoryMs ?? DEFAULT_SESSION_HISTORY_MS;
  const aggregateHistoryMs = deps.aggregateHistoryMs ?? DEFAULT_AGGREGATE_HISTORY_MS;
  const topGraceMs = deps.topGraceMs ?? DEFAULT_TOP_GRACE_MS;
  const sampleProcfs = deps.sampleProcfs ?? defaultSampleProcfs;
  const readCliMarkers = deps.readCliMarkers ?? (() => readCliPidMarkers());
  const listBotmuxPids = deps.listBotmuxPids ?? (() => [process.pid]);
  const nowMs = deps.nowMs ?? (() => Date.now());
  const hostSeries = new NumericRingSeries(capacityFor(aggregateHistoryMs, intervalMs), ['cpuPct', 'memUsedPct']);
  const botmuxSeries = new NumericRingSeries(capacityFor(aggregateHistoryMs, intervalMs), ['cpuPct', 'rssBytes']);
  const botSeries = new Map<string, { meta: Pick<ResourceBotCurrent, 'larkAppId' | 'botName'>; series: NumericRingSeries }>();
  const sessionSeries = new Map<string, { meta: Pick<ResourceSessionCurrent, 'sessionId' | 'larkAppId' | 'botName' | 'title'>; series: NumericRingSeries }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let currentSnapshot = emptyCurrent(nowMs(), intervalMs);
  let previousTotalCpuTicks: number | undefined;
  let previousIdleCpuTicks: number | undefined;
  let previousProcessTicks = new Map<number, number>();
  let previousSessionStats = new Map<string, PreviousSessionStat>();
  let trackedLastAt = new Map<string, number>();

  function botHistory(bot: ResourceBotCurrent): NumericRingSeries {
    const existing = botSeries.get(bot.larkAppId);
    if (existing) {
      existing.meta.botName = bot.botName;
      return existing.series;
    }
    const series = new NumericRingSeries(capacityFor(aggregateHistoryMs, intervalMs), ['cpuPct', 'rssBytes']);
    botSeries.set(bot.larkAppId, { meta: { larkAppId: bot.larkAppId, botName: bot.botName }, series });
    return series;
  }

  function trackedSessionHistory(session: ResourceSessionCurrent): NumericRingSeries {
    const existing = sessionSeries.get(session.sessionId);
    if (existing) {
      existing.meta.larkAppId = session.larkAppId;
      existing.meta.botName = session.botName;
      existing.meta.title = session.title;
      return existing.series;
    }
    const series = new NumericRingSeries(capacityFor(sessionHistoryMs, intervalMs), ['cpuPct', 'rssBytes', 'rssGrowth5mBytes']);
    sessionSeries.set(session.sessionId, {
      meta: {
        sessionId: session.sessionId,
        larkAppId: session.larkAppId,
        botName: session.botName,
        title: session.title,
      },
      series,
    });
    return series;
  }

  function appendHistory(sampledAt: number, cpuReady: boolean, host: HostResourceCurrent, botmux: { cpuPct: number; rssBytes: number }, bots: ResourceBotCurrent[], sessions: ResourceSessionCurrent[]): void {
    const push = cpuReady ? 'push' : 'pushSparse';
    hostSeries[push](sampledAt, { cpuPct: cpuReady ? host.cpuPct : undefined, memUsedPct: host.memUsedPct });
    botmuxSeries[push](sampledAt, { cpuPct: cpuReady ? botmux.cpuPct : undefined, rssBytes: botmux.rssBytes });
    for (const bot of bots) {
      botHistory(bot)[push](sampledAt, { cpuPct: cpuReady ? bot.total.cpuPct : undefined, rssBytes: bot.total.rssBytes });
    }
    for (const session of sessions) {
      if (!session.tracked) continue;
      trackedSessionHistory(session)[push](sampledAt, {
        cpuPct: cpuReady ? session.current.cpu1mPct : undefined,
        rssBytes: session.current.rssBytes,
        rssGrowth5mBytes: session.current.rssGrowth5mBytes,
      });
    }
  }

  function pruneInactiveHistory(bots: ResourceBotCurrent[], sessions: ResourceSessionCurrent[]): void {
    const activeBotIds = new Set(bots.map(bot => bot.larkAppId));
    for (const id of botSeries.keys()) {
      if (!activeBotIds.has(id)) botSeries.delete(id);
    }

    const trackedSessionIds = new Set(sessions.filter(session => session.tracked).map(session => session.sessionId));
    for (const id of sessionSeries.keys()) {
      if (!trackedSessionIds.has(id)) sessionSeries.delete(id);
    }
  }

  function runtimeSummaryFromSeeds(supported: boolean, sampledAt: number, now: number): RuntimeMonitorSummary {
    return buildRuntimeMonitorSummary({
      supported,
      sampledAt,
      intervalMs,
      nowMs: now,
      bots: deps.listDaemons().map(daemon => ({
        larkAppId: daemon.larkAppId,
        botName: daemon.botName ?? daemon.larkAppId,
        daemonStatus: daemon.status ?? (daemon.pid ? 'unknown' : 'offline'),
      })),
      sessions: deps.listSessions().map(session => ({
        sessionId: session.sessionId,
        larkAppId: session.larkAppId,
        botName: session.botName ?? session.larkAppId,
        title: session.title,
        status: session.status,
        spawnedAt: session.spawnedAt,
        lastMessageAt: session.lastMessageAt,
        agentAttention: session.agentAttention,
        confidence: 'unknown',
      })),
    });
  }

  function sampleOnce(): void {
    const now = nowMs();
    const sample = sampleProcfs(now);
    if (!sample.supported) {
      const sampledAt = sample.sampledAt || now;
      currentSnapshot = {
        ...emptyCurrent(sampledAt, intervalMs),
        runtime: runtimeSummaryFromSeeds(false, sampledAt, now),
      };
      previousTotalCpuTicks = undefined;
      previousIdleCpuTicks = undefined;
      previousProcessTicks = new Map();
      previousSessionStats = new Map();
      trackedLastAt = new Map();
      return;
    }

    const prevTotalCpuTicks = previousTotalCpuTicks;
    const prevIdleCpuTicks = previousIdleCpuTicks;
    const hasCpuBaseline = prevTotalCpuTicks !== undefined && prevIdleCpuTicks !== undefined;
    const totalDelta = hasCpuBaseline ? Math.max(0, sample.totalCpuTicks - prevTotalCpuTicks) : 0;
    const cpuReady = hasCpuBaseline && totalDelta > 0;
    const cpuByPid = processCpuPct(sample.processes, previousProcessTicks, totalDelta);
    const attribution = attributeResources({
      processes: sample.processes,
      processCpuPct: cpuByPid,
      sessions: deps.listSessions(),
      daemons: deps.listDaemons(),
      botmuxPids: listBotmuxPids(),
      cliMarkers: readCliMarkers(),
      previousSessionStats,
      nowMs: now,
    });
    const selection = selectTrackedSessions({
      rows: attribution.sessions,
      previous: trackedLastAt,
      nowMs: now,
      limit: topSessionLimit,
      graceMs: topGraceMs,
      perReasonLimit: topSessionLimit,
    });
    const trackedIds = new Set(selection.trackedIds);
    trackedLastAt = new Map([...trackedLastAt].filter(([id, lastAt]) => trackedIds.has(id) || now - lastAt <= topGraceMs));
    for (const id of trackedIds) trackedLastAt.set(id, now);

    const sessions = attribution.sessions.map(session => ({
      ...session,
      tracked: trackedIds.has(session.sessionId),
      rankReasons: selection.reasonsBySession.get(session.sessionId) ?? [],
    }));
    const host = hostCurrent(sample, previousTotalCpuTicks, previousIdleCpuTicks);
    const sampledAt = sample.sampledAt || now;
    currentSnapshot = {
      ok: true,
      supported: true,
      cpuReady,
      sampledAt,
      intervalMs,
      host,
      botmux: attribution.botmux,
      botmuxBreakdown: attribution.botmuxBreakdown,
      bots: attribution.bots,
      sessions,
      runtime: buildRuntimeMonitorSummary({
        supported: true,
        sampledAt,
        intervalMs,
        nowMs: now,
        bots: attribution.bots,
        sessions,
      }),
      rankings: {
        topCpu: selection.topCpu,
        topRss: selection.topRss,
        topGrowth: selection.topGrowth,
        tracked: selection.trackedIds,
      },
    };
    appendHistory(currentSnapshot.sampledAt, cpuReady, host, attribution.botmux, attribution.bots, sessions);
    pruneInactiveHistory(attribution.bots, sessions);
    previousTotalCpuTicks = sample.totalCpuTicks;
    previousIdleCpuTicks = sample.idleCpuTicks;
    previousProcessTicks = snapshotProcessTicks(sample.processes);
    previousSessionStats = attribution.nextSessionStats;
  }

  function history(range: '1h' | '3h' | '24h'): ResourceHistorySnapshot {
    const now = nowMs();
    const since = now - rangeMs(range);
    if (!currentSnapshot.supported) {
      return { ok: true, supported: false, sampledAt: currentSnapshot.sampledAt, range, bots: [], sessions: [] };
    }
    const tracked = new Set(currentSnapshot.rankings.tracked);
    const sessions = currentSnapshot.sessions
      .filter(session => tracked.has(session.sessionId))
      .map(session => {
        const historyEntry = sessionSeries.get(session.sessionId);
        const series = historyEntry?.series.toJSON(since) as ResourceHistorySeries | undefined;
        return {
          sessionId: session.sessionId,
          larkAppId: session.larkAppId,
          botName: session.botName,
          title: session.title,
          series: series ?? { timestamps: [] },
        };
      });
    return {
      ok: true,
      supported: true,
      sampledAt: currentSnapshot.sampledAt,
      range,
      host: hostSeries.toJSON(since) as ResourceHistorySeries,
      botmux: botmuxSeries.toJSON(since) as ResourceHistorySeries,
      bots: [...botSeries.values()].map(entry => ({
        ...entry.meta,
        series: entry.series.toJSON(since) as ResourceHistorySeries,
      })),
      sessions,
    };
  }

  return {
    start() {
      if (timer) return;
      sampleOnce();
      timer = setInterval(sampleOnce, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
    sampleOnce,
    current: () => currentSnapshot,
    history,
  };
}
