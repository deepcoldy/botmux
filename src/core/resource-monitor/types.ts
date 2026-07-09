export type ResourceAttributionConfidence = 'exact' | 'marker' | 'adopted' | 'descendant' | 'unknown';
export type ResourceRankReason = 'cpu' | 'rss' | 'rssGrowth' | 'grace';
export type RuntimeSampleStatus = 'fresh' | 'stale' | 'unsupported';
export type RuntimeSessionBucket = 'working' | 'starting' | 'idle' | 'waiting' | 'unknown';
export type RuntimeDaemonStatus = 'online' | 'offline' | 'unknown';

export interface RuntimeSessionRef {
  sessionId: string;
  larkAppId: string;
  botName: string;
  title?: string;
  status?: string;
  durationMs: number;
}

export interface RuntimeMonitorSummary {
  sampleHealth: {
    status: RuntimeSampleStatus;
    sampledAt: number;
    ageMs: number;
    intervalMs: number;
  };
  daemons: {
    total: number;
    online: number;
    offline: number;
  };
  sessions: {
    total: number;
    working: number;
    starting: number;
    idle: number;
    waiting: number;
    unknown: number;
    unattributed: number;
    longestRunning?: RuntimeSessionRef;
    longestWaiting?: RuntimeSessionRef;
  };
}

export interface ResourceBotRuntime {
  daemonStatus: RuntimeDaemonStatus;
  sessions: {
    total: number;
    working: number;
    starting: number;
    waiting: number;
  };
}

export interface HostResourceCurrent {
  cpuPct: number;
  load1: number;
  load5: number;
  load15: number;
  memTotalBytes: number;
  memAvailableBytes: number;
  memUsedPct: number;
  swapUsedPct: number;
}

export interface ResourceMetricCurrent {
  rssBytes: number;
  cpuPct: number;
}

export interface ResourceSessionCurrent {
  sessionId: string;
  larkAppId: string;
  botName: string;
  title?: string;
  status: string;
  spawnedAt?: number;
  lastMessageAt?: number;
  agentAttention?: { kind: string; reason: string; at: number };
  current: {
    rssBytes: number;
    cpuPct: number;
    cpu1mPct: number;
    cpu5mPct: number;
    rssGrowth5mBytes: number;
  };
  tracked: boolean;
  rankReasons: ResourceRankReason[];
  confidence: ResourceAttributionConfidence;
  pids: {
    workerPid?: number;
    cliPids?: number[];
    sampledPids: number;
  };
}

export interface ResourceBotCurrent {
  larkAppId: string;
  botName: string;
  daemonPid?: number;
  daemonStatus: RuntimeDaemonStatus;
  daemon: ResourceMetricCurrent;
  sessions: ResourceMetricCurrent & { count: number };
  runtime: ResourceBotRuntime;
  total: ResourceMetricCurrent;
}

export interface ResourceCurrentSnapshot {
  ok: true;
  supported: boolean;
  cpuReady?: boolean;
  sampledAt: number;
  intervalMs: number;
  reason?: 'procfs_unavailable';
  host?: HostResourceCurrent;
  botmux?: ResourceMetricCurrent;
  bots: ResourceBotCurrent[];
  sessions: ResourceSessionCurrent[];
  runtime: RuntimeMonitorSummary;
  rankings: {
    topCpu: string[];
    topRss: string[];
    topGrowth: string[];
    tracked: string[];
  };
}

export interface ResourceHistorySeries {
  timestamps: number[];
  cpuPct?: number[];
  rssBytes?: number[];
  memUsedPct?: number[];
  rssGrowth5mBytes?: number[];
}

export interface ResourceHistorySnapshot {
  ok: true;
  supported: boolean;
  sampledAt: number;
  range: '1h' | '3h' | '24h';
  host?: ResourceHistorySeries;
  botmux?: ResourceHistorySeries;
  bots: Array<{ larkAppId: string; botName: string; series: ResourceHistorySeries }>;
  sessions: Array<{ sessionId: string; larkAppId: string; botName: string; title?: string; series: ResourceHistorySeries }>;
}

export interface ProcessResourceSample {
  pid: number;
  ppid: number;
  rssBytes: number;
  cpuTicks: number;
  cmd?: string;
}

export interface ProcfsSample {
  supported: boolean;
  sampledAt: number;
  reason?: 'procfs_unavailable';
  totalCpuTicks: number;
  idleCpuTicks: number;
  loadavg: { load1: number; load5: number; load15: number };
  mem: {
    memTotalBytes: number;
    memAvailableBytes: number;
    swapTotalBytes: number;
    swapFreeBytes: number;
  };
  processes: ProcessResourceSample[];
}
