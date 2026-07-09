import type {
  RuntimeDaemonStatus,
  RuntimeMonitorSummary,
  RuntimeSessionBucket,
  RuntimeSessionRef,
} from './types.js';

export interface RuntimeSessionInput {
  sessionId: string;
  larkAppId: string;
  botName: string;
  title?: string;
  status?: string;
  spawnedAt?: number;
  lastMessageAt?: number;
  agentAttention?: { kind: string; reason: string; at: number };
  confidence?: string;
}

export interface RuntimeBotInput {
  larkAppId: string;
  botName: string;
  daemonStatus?: RuntimeDaemonStatus;
}

const WORKING_STATUSES = new Set(['working', 'analyzing', 'active']);
const STARTING_STATUSES = new Set(['starting', 'queued']);
const IDLE_STATUSES = new Set(['idle', 'dormant']);

export function sessionRuntimeBucket(session: Pick<RuntimeSessionInput, 'status' | 'agentAttention'>): RuntimeSessionBucket {
  const status = String(session.status ?? '').toLowerCase();
  if (session.agentAttention || status.includes('waiting')) return 'waiting';
  if (WORKING_STATUSES.has(status)) return 'working';
  if (STARTING_STATUSES.has(status)) return 'starting';
  if (IDLE_STATUSES.has(status)) return 'idle';
  return 'unknown';
}

function sessionRef(session: RuntimeSessionInput, durationMs: number): RuntimeSessionRef {
  return {
    sessionId: session.sessionId,
    larkAppId: session.larkAppId,
    botName: session.botName,
    title: session.title,
    status: session.status,
    durationMs,
  };
}

function longestRunning(sessions: RuntimeSessionInput[], nowMs: number): RuntimeSessionRef | undefined {
  let best: RuntimeSessionRef | undefined;
  for (const session of sessions) {
    const start = Number(session.spawnedAt ?? 0);
    if (!Number.isFinite(start) || start <= 0) continue;
    const ref = sessionRef(session, Math.max(0, nowMs - start));
    if (!best || ref.durationMs > best.durationMs) best = ref;
  }
  return best;
}

function longestWaiting(sessions: RuntimeSessionInput[], nowMs: number): RuntimeSessionRef | undefined {
  let best: RuntimeSessionRef | undefined;
  for (const session of sessions) {
    if (sessionRuntimeBucket(session) !== 'waiting') continue;
    const start = Number(session.agentAttention?.at ?? session.lastMessageAt ?? session.spawnedAt ?? 0);
    if (!Number.isFinite(start) || start <= 0) continue;
    const ref = sessionRef(session, Math.max(0, nowMs - start));
    if (!best || ref.durationMs > best.durationMs) best = ref;
  }
  return best;
}

export function buildRuntimeMonitorSummary(input: {
  supported: boolean;
  sampledAt: number;
  intervalMs: number;
  nowMs: number;
  bots: RuntimeBotInput[];
  sessions: RuntimeSessionInput[];
}): RuntimeMonitorSummary {
  const ageMs = Math.max(0, input.nowMs - input.sampledAt);
  const staleMs = Math.max(input.intervalMs * 3, 30_000);
  const sampleStatus = !input.supported ? 'unsupported' : ageMs > staleMs ? 'stale' : 'fresh';
  const buckets = {
    working: 0,
    starting: 0,
    idle: 0,
    waiting: 0,
    unknown: 0,
  };
  let unattributed = 0;

  for (const session of input.sessions) {
    buckets[sessionRuntimeBucket(session)] += 1;
    if (session.confidence === 'unknown') unattributed += 1;
  }

  const online = input.bots.filter(bot => bot.daemonStatus === 'online').length;
  const offline = input.bots.filter(bot => bot.daemonStatus === 'offline').length;

  return {
    sampleHealth: {
      status: sampleStatus,
      sampledAt: input.sampledAt,
      ageMs,
      intervalMs: input.intervalMs,
    },
    daemons: {
      total: input.bots.length,
      online,
      offline,
    },
    sessions: {
      total: input.sessions.length,
      ...buckets,
      unattributed,
      longestRunning: longestRunning(input.sessions, input.nowMs),
      longestWaiting: longestWaiting(input.sessions, input.nowMs),
    },
  };
}
