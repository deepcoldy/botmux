export const DASHBOARD_SUMMARY_SCHEMA_VERSION = 1 as const;

export interface DashboardSummary {
  schemaVersion: typeof DASHBOARD_SUMMARY_SCHEMA_VERSION;
  generatedAt: string;
  service: { status: 'healthy' | 'degraded' };
  bots: { online: number };
  sessions: { active: number; attention: number };
  schedules: { enabled: number; nextRunAt: string | null };
  dashboard: { href: '/' };
}

interface DashboardSummarySessionRow {
  status?: unknown;
  pendingRepo?: unknown;
  tuiPromptActive?: unknown;
  agentAttention?: unknown;
}

interface DashboardSummaryScheduleRow {
  enabled?: unknown;
  nextRunAt?: unknown;
}

const DASHBOARD_SUMMARY_SESSION_STATUSES = new Set([
  'working',
  'idle',
  'analyzing',
  'limited',
  'stalled',
  'starting',
  'closed',
  'dormant',
]);

function objectRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the minimal daemon row shape consumed by the public projection.
 * Rejecting malformed live data keeps the endpoint from publishing plausible
 * but invented operational counts. */
export function parseDashboardSummaryRows(input: {
  sessions: unknown;
  schedules: unknown;
}): {
  sessions: readonly DashboardSummarySessionRow[];
  schedules: readonly DashboardSummaryScheduleRow[];
} {
  if (!Array.isArray(input.sessions)) throw new Error('dashboard summary sessions must be an array');
  if (!Array.isArray(input.schedules)) throw new Error('dashboard summary schedules must be an array');
  for (const row of input.sessions) {
    if (!objectRow(row)
      || typeof row.status !== 'string'
      || !DASHBOARD_SUMMARY_SESSION_STATUSES.has(row.status)) {
      throw new Error('dashboard summary session status is invalid');
    }
    if (row.pendingRepo !== undefined && typeof row.pendingRepo !== 'boolean') {
      throw new Error('dashboard summary session pendingRepo must be a boolean');
    }
    if (row.tuiPromptActive !== undefined && typeof row.tuiPromptActive !== 'boolean') {
      throw new Error('dashboard summary session tuiPromptActive must be a boolean');
    }
    if (row.agentAttention !== undefined && row.agentAttention !== null && !objectRow(row.agentAttention)) {
      throw new Error('dashboard summary session agentAttention must be an object or null');
    }
  }
  for (const row of input.schedules) {
    if (!objectRow(row) || typeof row.enabled !== 'boolean') {
      throw new Error('dashboard summary schedule enabled must be a boolean');
    }
    if (row.nextRunAt !== undefined
      && (typeof row.nextRunAt !== 'string' || !Number.isFinite(Date.parse(row.nextRunAt)))) {
      throw new Error('dashboard summary schedule nextRunAt must be a valid timestamp');
    }
  }
  return {
    sessions: input.sessions as DashboardSummarySessionRow[],
    schedules: input.schedules as DashboardSummaryScheduleRow[],
  };
}

/**
 * Reduce the dashboard's rich internal read model to a deliberately tiny
 * public summary contract. Keep the projection here as a positive allowlist:
 * adding a field to a session, schedule, bot descriptor, or dashboard API can
 * never make it appear in this response by accident.
 */
export function buildDashboardSummary(input: {
  generatedAt: Date;
  configuredBotAppIds: readonly string[];
  onlineBotAppIds: readonly string[];
  sessions: readonly DashboardSummarySessionRow[];
  schedules: readonly DashboardSummaryScheduleRow[];
}): DashboardSummary {
  const onlineBotAppIds = new Set(input.onlineBotAppIds);
  const configuredFleetOnline = input.configuredBotAppIds.every(appId => onlineBotAppIds.has(appId));
  const activeSessions = input.sessions.filter(row => row.status !== 'closed');
  const attentionSessions = activeSessions.filter(row => (
    !!row.agentAttention
    || !!row.pendingRepo
    || !!row.tuiPromptActive
    || row.status === 'limited'
    || row.status === 'stalled'
  ));
  const enabledSchedules = input.schedules.filter(row => row.enabled === true);
  const nextRunMs = enabledSchedules.reduce<number | null>((earliest, row) => {
    if (typeof row.nextRunAt !== 'string') return earliest;
    const candidate = Date.parse(row.nextRunAt);
    if (!Number.isFinite(candidate)) return earliest;
    return earliest === null || candidate < earliest ? candidate : earliest;
  }, null);

  return {
    schemaVersion: DASHBOARD_SUMMARY_SCHEMA_VERSION,
    generatedAt: input.generatedAt.toISOString(),
    service: {
      status: configuredFleetOnline ? 'healthy' : 'degraded',
    },
    bots: { online: input.onlineBotAppIds.length },
    sessions: {
      active: activeSessions.length,
      attention: attentionSessions.length,
    },
    schedules: {
      enabled: enabledSchedules.length,
      nextRunAt: nextRunMs === null ? null : new Date(nextRunMs).toISOString(),
    },
    dashboard: { href: '/' },
  };
}

/** Minimal, still-whitelisted body for an upstream snapshot failure. Counts
 * are intentionally absent: returning plausible zeroes would turn missing
 * daemon state into false operational health. The HTTP handler pairs this with
 * 503 so consumers can render an unavailable state. */
export function unavailableDashboardSummary(generatedAt: Date): Pick<DashboardSummary, 'schemaVersion' | 'generatedAt' | 'service'> {
  return {
    schemaVersion: DASHBOARD_SUMMARY_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    service: { status: 'degraded' },
  };
}
