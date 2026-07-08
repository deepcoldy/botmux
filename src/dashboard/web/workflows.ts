import { t } from './ui.js';

export type LegacyWorkflowFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type RunRow = {
  runId: string;
  workflowId: string;
  status: string;
  lastSeq: number;
  dEf: number;
  dAct: number;
  dWait: number;
  updatedAt: number;
  failedNodeId?: string;
  errorCode?: string;
  errorClass?: string;
  errorMessage?: string;
  chatId?: string;
  larkAppId?: string;
};

export type OutputRef = {
  outputHash: string;
  outputBytes: number;
  outputSchemaVersion: number;
  outputPath?: string;
  contentType?: string;
};

export type BlobPreview = {
  outputHash?: string;
  outputBytes?: number;
  contentType?: string;
  truncated?: boolean;
  value?: unknown;
  text?: string;
  error?: string;
};

export type AttemptIO = {
  input?: BlobPreview;
  resolvedInput?: BlobPreview;
  output?: BlobPreview;
  log?: BlobPreview;
  terminal?: AttemptTerminal;
  waitPrompt?: BlobPreview;
};

export type AttemptTerminal = {
  sessionId: string;
  cliSessionId?: string;
  webPort: number;
  status: 'live' | 'closed';
  larkAppId?: string;
  botName?: string;
  cliId?: string;
  workingDir?: string;
  logPath?: string;
  startedAt: number;
  updatedAt: number;
  closedAt?: number;
  error?: string;
  hasPtyLog?: boolean;
};

export type AttemptState = {
  attemptId: string;
  attemptNumber: number;
  status: string;
  effectAttempted?: { provider: string; idempotencyKey: string };
  wait?: {
    waitKind: string;
    prompt?: string;
    promptPreview?: string;
    deadlineAt?: number;
    resolution?: { kind: string; resolution?: string; by?: string; eventId: string };
  };
  output?: OutputRef;
  error?: { errorCode: string; errorClass: string; errorMessage?: string };
  runningMs?: number;
};

export type ActivityState = {
  activityId: string;
  attempts: AttemptState[];
  status: string;
  currentAttemptId?: string;
  ownerNodeId?: string;
};

export type NodeState = {
  nodeId: string;
  status: string;
  activityId?: string;
  retryCount: number;
  nextAttemptAt?: number;
  errorClass?: string;
};

export type RunSnapshot = {
  runId: string;
  run: {
    runId: string;
    status: string;
    workflowId?: string;
    revisionId?: string;
    initiator?: string;
    failedNodeId?: string;
    rootCauseEventId?: string;
    cancelOriginEventId?: string;
  };
  lastSeq: number;
  nodes: NodeState[];
  activities: ActivityState[];
  dangling: {
    activities: string[];
    effectAttempted: string[];
    waits: string[];
    cancels: string[];
  };
  outputs: Record<string, OutputRef>;
  attemptIO?: Record<string, AttemptIO>;
  chatBinding?: { chatId: string; larkAppId: string };
  updatedAt: number;
};

export type WorkflowEvent = {
  eventId: string;
  runId: string;
  type: string;
  actor: string;
  timestamp: number;
  payload?: unknown;
};

export type EventWindow = {
  events: WorkflowEvent[];
  oldestSeq: number | null;
  newestSeq: number | null;
  totalCount: number;
  hasOlder: boolean;
  hasNewer: boolean;
};

export type CancelRunResponse = {
  ok: boolean;
  error?: string;
  hint?: string;
  status?: string;
  alreadyTerminal?: boolean;
  pending?: boolean;
  lastSeq?: number;
};

export type ResolveWaitResponse = {
  ok: boolean;
  error?: string;
  hint?: string;
  message?: string;
  runId?: string;
  resolution?: 'approved' | 'rejected';
  activityId?: string;
  attemptId?: string;
  resolvedAt?: number;
  lastSeq?: number;
  alreadyTerminal?: boolean;
  pending?: boolean;
};

export type ResumeSession = { resumeId: string; url: string };

export type TerminalSurface =
  | { kind: 'live'; url: string }
  | { kind: 'replay'; url: string; downloadUrl: string }
  | { kind: 'resume'; url: string; resumeId: string; downloadUrl: string };

export type CardDescriptor = {
  key: string;
  node?: NodeState;
  activity?: ActivityState;
  io?: AttemptIO;
};

export type AttemptTimelineItem = {
  nodeId?: string;
  activityId: string;
  attemptId: string;
  attemptNumber?: number;
  status: string;
  startedAt: number;
  runningAt?: number;
  endedAt?: number;
  endType?: string;
};

export type LegacyWorkflowRoute =
  | { kind: 'list' }
  | { kind: 'detail'; runId: string; focusAttemptId?: string };

export const LEGACY_WORKFLOW_POLL_MS = 5000;
export const LEGACY_WORKFLOW_DETAIL_POLL_MS = 2000;
export const LEGACY_WORKFLOW_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

const RESUME_REQUIRES_CLI_SESSION_ID = new Set<string>(['antigravity', 'codex-app', 'cursor', 'mira']);
const RESUME_USES_SESSION_ID = new Set<string>([
  'aiden',
  'coco',
  'claude-code',
  'seed',
  'relay',
  'codex',
  'mtr',
  'hermes',
  'pi',
  'mir',
]);

export function parseLegacyWorkflowHash(hash: string): LegacyWorkflowRoute {
  const detailMatch = hash.match(/^#\/legacy-workflow\/([^?#]+)(?:\?([^#]*))?$/);
  if (!detailMatch) return { kind: 'list' };
  const params = new URLSearchParams(detailMatch[2] ?? '');
  return {
    kind: 'detail',
    runId: decodeURIComponent(detailMatch[1]!),
    focusAttemptId: params.get('attempt') ?? undefined,
  };
}

export function legacyWorkflowStatusFilters(): Array<{ value: string; label: string }> {
  return [
    { value: '', label: t('workflow.filter.nonTerminal') },
    { value: 'all', label: t('workflow.filter.all') },
    { value: 'pending', label: statusLabel('pending') },
    { value: 'running', label: statusLabel('running') },
    { value: 'waiting', label: statusLabel('waiting') },
    { value: 'succeeded', label: statusLabel('succeeded') },
    { value: 'failed', label: statusLabel('failed') },
    { value: 'cancelled', label: statusLabel('cancelled') },
  ];
}

export async function fetchLegacyWorkflowRuns(
  status: string,
  fetcher: LegacyWorkflowFetch = fetch,
): Promise<RunRow[]> {
  const params = new URLSearchParams();
  if (status === 'all') params.set('all', '1');
  else if (status) params.set('status', status);
  const response = await fetcher('/api/workflows/runs' + (params.toString() ? `?${params}` : ''));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as { runs?: RunRow[] };
  return body.runs ?? [];
}

export async function fetchLegacyWorkflowSnapshot(
  runId: string,
  fetcher: LegacyWorkflowFetch = fetch,
): Promise<RunSnapshot> {
  const response = await fetcher(`/api/workflows/runs/${encodeURIComponent(runId)}/snapshot`);
  if (response.status === 404) throw new Error(t('workflow.detail.unknownRun'));
  if (!response.ok) throw new Error(t('workflow.detail.snapshotHttp', { status: response.status }));
  return await response.json() as RunSnapshot;
}

export async function fetchLegacyWorkflowEvents(
  runId: string,
  params: URLSearchParams,
  fetcher: LegacyWorkflowFetch = fetch,
): Promise<EventWindow> {
  const response = await fetcher(`/api/workflows/runs/${encodeURIComponent(runId)}/events?${params}`);
  if (response.status === 404) throw new Error(t('workflow.detail.unknownRun'));
  if (!response.ok) throw new Error(t('workflow.detail.eventsHttp', { status: response.status }));
  return await response.json() as EventWindow;
}

export async function cancelLegacyWorkflowRun(
  runId: string,
  fetcher: LegacyWorkflowFetch = fetch,
): Promise<CancelRunResponse> {
  const response = await fetcher(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'cancelled via dashboard' }),
  });
  if (response.status === 401) throw new Error(t('workflow.detail.writeAccessCancel'));
  const body = await response.json().catch(() => ({})) as CancelRunResponse;
  if (!response.ok || !body.ok) {
    throw new Error(body.hint ?? body.error ?? t('workflow.detail.cancelHttp', { status: response.status }));
  }
  return body;
}

export async function resolveLegacyWorkflowWait(
  runId: string,
  action: 'approve' | 'reject',
  comment: string | undefined,
  fetcher: LegacyWorkflowFetch = fetch,
): Promise<ResolveWaitResponse> {
  const response = await fetcher(`/api/workflows/runs/${encodeURIComponent(runId)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comment }),
  });
  if (response.status === 401) throw new Error(t('workflow.detail.writeAccessApproval'));
  const body = await response.json().catch(() => ({})) as ResolveWaitResponse;
  if (!response.ok || !body.ok) {
    throw new Error(
      body.hint ?? body.message ?? body.error ?? t('workflow.detail.actionHttp', { action, status: response.status }),
    );
  }
  return body;
}

export async function startLegacyWorkflowResumeSession(
  runId: string,
  activityId: string,
  attemptId: string,
  fetcher: LegacyWorkflowFetch = fetch,
): Promise<ResumeSession> {
  const response = await fetcher(
    `/api/workflows/runs/${encodeURIComponent(runId)}` +
      `/attempts/${encodeURIComponent(activityId)}` +
      `/${encodeURIComponent(attemptId)}/resume`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  if (response.status === 401) throw new Error(t('workflow.detail.writeAccessResume'));
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    resumeId?: string;
    url?: string;
    error?: string;
    hint?: string;
    message?: string;
  };
  if (!response.ok || !body.ok || !body.resumeId || !body.url) {
    throw new Error(
      body.hint ?? body.message ?? body.error ?? t('workflow.detail.resumeStartFailed', { status: response.status }),
    );
  }
  return { resumeId: body.resumeId, url: body.url };
}

export async function endLegacyWorkflowResumeSession(
  runId: string,
  activityId: string,
  attemptId: string,
  fetcher: LegacyWorkflowFetch = fetch,
): Promise<{ ended: boolean; resumeNotRunning: boolean }> {
  const response = await fetcher(
    `/api/workflows/runs/${encodeURIComponent(runId)}` +
      `/attempts/${encodeURIComponent(activityId)}` +
      `/${encodeURIComponent(attemptId)}/resume/end`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'ended_by_dashboard' }),
    },
  );
  if (response.status === 401) throw new Error(t('workflow.detail.writeAccessResume'));
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    error?: string;
    hint?: string;
    message?: string;
  };
  if (!response.ok || !body.ok) {
    if (body.error === 'resume_not_running') return { ended: false, resumeNotRunning: true };
    throw new Error(
      body.hint ?? body.message ?? body.error ?? t('workflow.detail.resumeEndFailed', { status: response.status }),
    );
  }
  return { ended: true, resumeNotRunning: false };
}

export function isTerminalWorkflowStatus(status: string): boolean {
  return LEGACY_WORKFLOW_TERMINAL_STATUSES.has(status);
}

export function statusLabel(status: string): string {
  const key = `workflow.status.${status}`;
  const label = t(key);
  return label === key ? status : label;
}

export function fmtUpdated(ms: number): string {
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 60_000) return t('time.secondsAgo', { value: Math.max(1, Math.floor(diff / 1000)) });
  if (diff < 3_600_000) return t('time.minutesAgo', { value: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('time.hoursAgo', { value: Math.floor(diff / 3_600_000) });
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function danglingSummary(snap: RunSnapshot): {
  total: number;
  effects: number;
  activities: number;
  waits: number;
  cancels: number;
} {
  const d = snap.dangling;
  return {
    total: new Set([
      ...d.activities,
      ...d.effectAttempted,
      ...d.waits,
      ...d.cancels,
    ]).size,
    effects: d.effectAttempted.length,
    activities: d.activities.length,
    waits: d.waits.length,
    cancels: d.cancels.length,
  };
}

export function buildAttemptTimeline(events: WorkflowEvent[], snap: RunSnapshot): AttemptTimelineItem[] {
  const byAttempt = new Map<string, AttemptTimelineItem>();
  const activityOwner = new Map(snap.activities.map((activity) => [activity.activityId, activity.ownerNodeId]));

  for (const event of [...events].sort((a, b) => eventSeqFromId(a.eventId) - eventSeqFromId(b.eventId))) {
    const payload = payloadRecord(event);
    if (!payload) continue;
    const activityId = typeof payload.activityId === 'string' ? payload.activityId : undefined;
    const attemptId = typeof payload.attemptId === 'string' ? payload.attemptId : undefined;
    if (!activityId || !attemptId) continue;

    let item = byAttempt.get(attemptId);
    if (event.type === 'attemptCreated') {
      const attemptNumber = typeof payload.attemptNumber === 'number' ? payload.attemptNumber : undefined;
      const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId : activityOwner.get(activityId);
      item = {
        nodeId,
        activityId,
        attemptId,
        attemptNumber,
        status: 'pending',
        startedAt: event.timestamp,
      };
      byAttempt.set(attemptId, item);
      continue;
    }
    if (!item) {
      item = {
        nodeId: activityOwner.get(activityId),
        activityId,
        attemptId,
        status: 'pending',
        startedAt: event.timestamp,
      };
      byAttempt.set(attemptId, item);
    }

    if (event.type === 'activityRunning') {
      item.status = 'running';
      item.runningAt = event.timestamp;
    } else if (event.type === 'effectAttempted') {
      item.status = 'effectAttempting';
    } else if (event.type === 'activityWaiting' || event.type === 'waitCreated') {
      item.status = 'waiting';
    } else if (isTerminalActivityEvent(event.type)) {
      item.status = terminalStatusForEvent(event.type);
      item.endedAt = event.timestamp;
      item.endType = event.type;
    }
  }

  return [...byAttempt.values()];
}

export function maxConcurrency(items: AttemptTimelineItem[], now: number): number {
  const points: Array<{ time: number; delta: number }> = [];
  for (const item of items) {
    points.push({ time: item.startedAt, delta: 1 });
    points.push({ time: item.endedAt ?? now, delta: -1 });
  }
  points.sort((a, b) => a.time - b.time || b.delta - a.delta);
  let current = 0;
  let max = 0;
  for (const point of points) {
    current += point.delta;
    max = Math.max(max, current);
  }
  return max;
}

export function buildCardDescriptors(snap: RunSnapshot): CardDescriptor[] {
  const byId = new Map(snap.activities.map((activity) => [activity.activityId, activity]));
  const used = new Set<string>();
  const out: CardDescriptor[] = [];
  for (const node of snap.nodes) {
    const activity =
      (node.activityId ? byId.get(node.activityId) : undefined) ??
      snap.activities.find((candidate) => candidate.ownerNodeId === node.nodeId);
    if (!activity) {
      out.push({ key: `node:${node.nodeId}`, node });
      continue;
    }
    used.add(activity.activityId);
    out.push({
      key: `activity:${activity.activityId}`,
      node,
      activity,
      io: snap.attemptIO?.[latestAttempt(activity)?.attemptId ?? ''],
    });
  }
  for (const activity of snap.activities) {
    if (used.has(activity.activityId)) continue;
    out.push({
      key: `activity:${activity.activityId}`,
      activity,
      io: snap.attemptIO?.[latestAttempt(activity)?.attemptId ?? ''],
    });
  }
  return out;
}

export function latestAttempt(activity?: ActivityState): AttemptState | undefined {
  return activity?.attempts[activity.attempts.length - 1];
}

export function isOpenHumanGateAttempt(attempt: AttemptState | undefined): attempt is AttemptState {
  return !!attempt &&
    attempt.status === 'waiting' &&
    attempt.wait?.waitKind === 'human-gate' &&
    !attempt.wait.resolution;
}

export function computeTerminalSurface(options: {
  runId: string;
  activity?: ActivityState;
  attempt?: AttemptState;
  terminal?: AttemptTerminal;
  resumeSession?: ResumeSession;
  host?: string;
}): TerminalSurface | null {
  const { activity, attempt, resumeSession, runId, terminal } = options;
  if (!terminal || terminal.error) return null;
  if (isLiveTerminal(attempt, terminal)) {
    return { kind: 'live', url: terminalReadOnlyUrl(terminal, options.host) };
  }
  if (!attempt || !activity || !isReplayableTerminal(attempt, terminal)) return null;
  const downloadUrl = terminalLogDownloadUrl(runId, activity.activityId, attempt.attemptId);
  if (resumeSession) {
    return { kind: 'resume', url: resumeSession.url, resumeId: resumeSession.resumeId, downloadUrl };
  }
  return {
    kind: 'replay',
    url: terminalReplayPageUrl(runId, activity.activityId, attempt.attemptId, !!terminal.hasPtyLog),
    downloadUrl,
  };
}

export function terminalSurfaceLabel(kind: TerminalSurface['kind']): string {
  if (kind === 'live') return t('workflow.detail.liveTerminal');
  if (kind === 'resume') return t('workflow.detail.terminalResume');
  return t('workflow.detail.terminalReplay');
}

export function terminalOpenInTabLabel(kind: TerminalSurface['kind']): string {
  if (kind === 'live') return t('workflow.detail.openTerminalNewTab');
  if (kind === 'resume') return t('workflow.detail.openResumeNewTab');
  return t('workflow.detail.openReplayNewTab');
}

export function terminalMetaParts(attempt: AttemptState | undefined, terminal: AttemptTerminal): string[] {
  const bits: string[] = [];
  if (terminal.error) bits.push(t('workflow.detail.error'));
  else bits.push(terminal.status === 'live' ? t('workflow.detail.terminalLive') : t('workflow.detail.terminalClosedShort'));
  if (attempt?.status) bits.push(attempt.status);
  if (terminal.webPort > 0) bits.push(`:${terminal.webPort}`);
  return bits;
}

export function isResumeCapableCli(cliId: string | undefined): boolean {
  return !!cliId && (RESUME_USES_SESSION_ID.has(cliId) || RESUME_REQUIRES_CLI_SESSION_ID.has(cliId));
}

export function cliRequiresNativeSessionId(cliId: string | undefined): boolean {
  return !!cliId && RESUME_REQUIRES_CLI_SESSION_ID.has(cliId);
}

export function isLiveTerminal(attempt: AttemptState | undefined, terminal: AttemptTerminal): boolean {
  return terminal.status === 'live' &&
    terminal.webPort > 0 &&
    (attempt?.status === 'pending' || attempt?.status === 'running' || attempt?.status === 'effectAttempting');
}

export function isReplayableTerminal(attempt: AttemptState, terminal: AttemptTerminal): boolean {
  const isAttemptTerminal =
    attempt.status === 'succeeded' ||
    attempt.status === 'failed' ||
    attempt.status === 'cancelled' ||
    attempt.status === 'timedOut';
  if (!isAttemptTerminal) return false;
  return !!(terminal.sessionId || terminal.startedAt);
}

export function terminalReadOnlyUrl(terminal: AttemptTerminal, host?: string): string {
  const resolvedHost = (host ?? (typeof window !== 'undefined' ? window.location.hostname : '')) || '127.0.0.1';
  return `http://${resolvedHost}:${terminal.webPort}`;
}

export function terminalReplayPageUrl(
  runId: string,
  activityId: string,
  attemptId: string,
  hasPtyLog: boolean,
): string {
  const params = new URLSearchParams({ runId, activityId, attemptId });
  if (hasPtyLog) params.set('hasPtyLog', '1');
  return `/assets/terminal-replay.html?${params.toString()}`;
}

export function terminalLogDownloadUrl(
  runId: string,
  activityId: string,
  attemptId: string,
): string {
  return (
    `/api/workflows/runs/${encodeURIComponent(runId)}` +
    `/attempts/${encodeURIComponent(activityId)}` +
    `/${encodeURIComponent(attemptId)}/terminal-log/raw?download=1`
  );
}

export function previewMetaParts(preview?: BlobPreview): string[] {
  if (!preview) return [t('workflow.detail.empty')];
  const bits: string[] = [];
  if (preview.outputBytes !== undefined) bits.push(`${preview.outputBytes}B`);
  if (preview.truncated) bits.push(t('workflow.detail.truncated'));
  if (preview.error) bits.push(t('workflow.detail.error'));
  if (preview.outputHash) bits.push(short(preview.outputHash));
  return bits;
}

export function previewBody(preview?: BlobPreview): string {
  if (!preview) return '';
  return preview.value !== undefined
    ? JSON.stringify(preview.value, null, 2)
    : preview.text ?? '';
}

export function eventSeqFromId(eventId: string): number {
  const dash = eventId.lastIndexOf('-');
  if (dash < 0) return 0;
  const n = Number(eventId.slice(dash + 1));
  return Number.isFinite(n) ? n : 0;
}

export function extractEventContext(
  payload: unknown,
): { nodeId?: string; activityId?: string; errorCode?: string } {
  if (!payload || typeof payload !== 'object' || 'ref' in (payload as object)) return {};
  const p = payload as Record<string, unknown>;
  const out: { nodeId?: string; activityId?: string; errorCode?: string } = {};
  if (typeof p.nodeId === 'string') out.nodeId = p.nodeId;
  if (typeof p.activityId === 'string') out.activityId = p.activityId;
  if (typeof p.failedNodeId === 'string') out.nodeId = p.failedNodeId;
  const err = p.error;
  if (err && typeof err === 'object' && 'errorCode' in err) {
    out.errorCode = String((err as { errorCode: unknown }).errorCode);
  }
  return out;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function short(value?: string): string {
  if (!value) return '-';
  return value.length > 18 ? value.slice(0, 10) + '...' + value.slice(-6) : value;
}

export function shortText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function payloadRecord(event: WorkflowEvent): Record<string, unknown> | null {
  if (!event.payload || typeof event.payload !== 'object' || 'ref' in (event.payload as object)) return null;
  return event.payload as Record<string, unknown>;
}

function isTerminalActivityEvent(type: string): boolean {
  return type === 'activitySucceeded' ||
    type === 'activityFailed' ||
    type === 'activityTimedOut' ||
    type === 'activityCanceled';
}

function terminalStatusForEvent(type: string): string {
  if (type === 'activitySucceeded') return 'succeeded';
  if (type === 'activityCanceled') return 'cancelled';
  if (type === 'activityTimedOut') return 'timedOut';
  return 'failed';
}
