// Canonical worker/session observe projection.
//
// External consumers use this shape as the single, machine-readable fact source
// about a botmux session's runtime. Every consumer, CLI or in-process TS,
// resolves through the same normalizer so that no downstream code re-derives
// liveness/turn/phase/queued from raw SessionRow fields.
//
// The normalizer is pure: it takes a raw daemon `SessionRow` (from
// GET /api/sessions{,/:id}) plus an observation timestamp and emits an
// `ObserveSession`. Probe failures never fall back to older cached facts —
// callers surface an envelope with `probe.status !== 'ok'` and no sessions,
// or (for session-level lookups) an `ObserveSession` whose `probe.status` is
// `not_found`/`unauthorized`/`unreachable`.
//
// Design intent:
// - liveness only asserts `alive`/`closed` when we can prove it. `dormant`
//   (cap-suspended, park, or persisted-active with unproven teardown) maps to
//   `not_running` — the CLI worker is not resident but the on-disk transcript
//   is resumable. Anything unrecognized is `unknown`.
// - phase is always `unknown`: idle-detector only publishes screen-derived
//   working/idle edges, which are not a reliable thinking/tool/input source.
// - queued is `boolean | 'unknown'`; the daemon never publishes a queue length
//   and the observe contract will not synthesize one.
// - rawStatus/raw fields let diagnostics keep the original SessionRow view
//   without any consumer re-inferring canonical fields.

export const OBSERVE_SCHEMA_VERSION = 1 as const;

export type ObserveLiveness = 'alive' | 'not_running' | 'closed' | 'unknown';

export type ObserveTurn =
  | 'working'
  | 'idle'
  | 'starting'
  | 'analyzing'
  | 'limited'
  | 'stalled'
  | 'interrupted'
  | 'unknown';

export type ObservePhase = 'unknown';

export type ObserveQueued = boolean | 'unknown';
export type ObserveBoolean = boolean | 'unknown';

export type ObserveProbeStatus =
  | 'ok'
  | 'unauthorized'
  | 'unreachable'
  | 'not_found'
  | 'daemon_offline';

export interface ObserveProbe {
  status: ObserveProbeStatus;
  source: 'daemon-ipc';
  larkAppId?: string;
  error?: string;
}

export interface ObserveSession {
  schemaVersion: typeof OBSERVE_SCHEMA_VERSION;
  observedAt: number;
  probe: ObserveProbe;
  identity: {
    sessionId: string;
    larkAppId?: string;
    chatId?: string;
    chatType?: 'group' | 'p2p';
    rootMessageId?: string;
    scope?: 'thread' | 'chat';
    threadId?: string;
    botName?: string;
    feishuChatLink?: string;
    feishuThreadLink?: string;
  };
  cli: {
    id?: string;
    runtimeId?: string;
    runtimeDisplayName?: string;
    version?: string;
    instanceId?: string;
  };
  backend: {
    type?: string;
    sessionName?: string;
    adopted: ObserveBoolean;
    workerPid?: number;
    adoptCliPid?: number;
  };
  liveness: ObserveLiveness;
  turn: ObserveTurn;
  phase: ObservePhase;
  queued: ObserveQueued;
  pendingRepo?: boolean;
  tuiPromptActive?: boolean;
  attention?: { kind: string; reason: string; at: number };
  lastActivityAt?: number;
  workingDirectory?: string;
  parkedOrSuspended: ObserveBoolean;
  closed: ObserveBoolean;
  rawStatus?: string;
  raw?: unknown;
}

export interface ObserveDaemonEnvelope {
  larkAppId?: string;
  probe: ObserveProbe;
  sessions: ObserveSession[];
}

export interface ObserveSnapshot {
  schemaVersion: typeof OBSERVE_SCHEMA_VERSION;
  observedAt: number;
  daemons: ObserveDaemonEnvelope[];
}

const ROW_TURN_STATUSES = new Set<ObserveTurn>([
  'working',
  'idle',
  'starting',
  'analyzing',
  'limited',
  'stalled',
  'interrupted',
]);

/**
 * Normalize a raw daemon SessionRow (whatever shape `GET /api/sessions` emits)
 * into the canonical ObserveSession. Never inspects live processes, backends,
 * or transcripts — the daemon has already resolved that on our behalf, and any
 * downstream re-derivation would defeat the "single fact source" contract.
 *
 * `probe` defaults to `{status:'ok', source:'daemon-ipc'}` because the input
 * is by definition the daemon's already-computed row. Session-level failure
 * modes (`not_found`) are set by the caller before this normalizer runs on a
 * synthesized minimal row.
 */
export function normalizeSessionRow(
  row: RawSessionRow,
  options: { observedAt: number; probe?: ObserveProbe; includeRaw?: boolean },
): ObserveSession {
  const status = typeof row.status === 'string' ? row.status : undefined;
  const closed = status === 'closed';
  const dormant = status === 'dormant';
  const queuedFlag = row.queued;
  const queued: ObserveQueued = typeof queuedFlag === 'boolean' ? queuedFlag : 'unknown';

  const liveness: ObserveLiveness = closed
    ? 'closed'
    : dormant || queued === true
      ? 'not_running'
      : status && ROW_TURN_STATUSES.has(status as ObserveTurn)
        ? 'alive'
        : 'unknown';

  const turn: ObserveTurn = closed || dormant
    ? 'unknown'
    : queued === true
      ? 'idle'
      : status && ROW_TURN_STATUSES.has(status as ObserveTurn)
        ? (status as ObserveTurn)
        : 'unknown';

  const identity: ObserveSession['identity'] = { sessionId: String(row.sessionId ?? '') };
  if (typeof row.larkAppId === 'string' && row.larkAppId) identity.larkAppId = row.larkAppId;
  if (typeof row.chatId === 'string' && row.chatId) identity.chatId = row.chatId;
  if (row.chatType === 'group' || row.chatType === 'p2p') identity.chatType = row.chatType;
  if (typeof row.rootMessageId === 'string' && row.rootMessageId) identity.rootMessageId = row.rootMessageId;
  if (row.scope === 'thread' || row.scope === 'chat') identity.scope = row.scope;
  if (typeof row.threadId === 'string' && row.threadId) identity.threadId = row.threadId;
  if (typeof row.botName === 'string' && row.botName) identity.botName = row.botName;
  if (typeof row.feishuChatLink === 'string' && row.feishuChatLink) identity.feishuChatLink = row.feishuChatLink;
  if (typeof row.feishuThreadLink === 'string' && row.feishuThreadLink) identity.feishuThreadLink = row.feishuThreadLink;

  const cli: ObserveSession['cli'] = {};
  if (typeof row.cliId === 'string' && row.cliId && row.cliId !== 'unknown') cli.id = row.cliId;
  if (typeof row.runtimeId === 'string' && row.runtimeId) cli.runtimeId = row.runtimeId;
  if (typeof row.runtimeDisplayName === 'string' && row.runtimeDisplayName) {
    cli.runtimeDisplayName = row.runtimeDisplayName;
  }
  if (typeof row.cliVersion === 'string' && row.cliVersion) cli.version = row.cliVersion;
  if (typeof row.cliInstanceId === 'string' && row.cliInstanceId) cli.instanceId = row.cliInstanceId;

  const backend: ObserveSession['backend'] = { adopted: row.adopt === true };
  if (typeof row.backendType === 'string' && row.backendType) backend.type = row.backendType;
  if (typeof row.backendSessionName === 'string' && row.backendSessionName) {
    backend.sessionName = row.backendSessionName;
  }
  if (typeof row.workerPid === 'number' && Number.isFinite(row.workerPid)) backend.workerPid = row.workerPid;
  if (typeof row.adoptCliPid === 'number' && Number.isFinite(row.adoptCliPid)) backend.adoptCliPid = row.adoptCliPid;

  const observe: ObserveSession = {
    schemaVersion: OBSERVE_SCHEMA_VERSION,
    observedAt: options.observedAt,
    probe: options.probe ?? { status: 'ok', source: 'daemon-ipc' },
    identity,
    cli,
    backend,
    liveness,
    turn,
    phase: 'unknown',
    queued,
    parkedOrSuspended: dormant || queued === true,
    closed,
  };

  if (typeof row.pendingRepo === 'boolean') observe.pendingRepo = row.pendingRepo;
  if (typeof row.tuiPromptActive === 'boolean') observe.tuiPromptActive = row.tuiPromptActive;
  if (row.agentAttention && typeof row.agentAttention === 'object') {
    const att = row.agentAttention as { kind?: unknown; reason?: unknown; at?: unknown };
    if (typeof att.kind === 'string' && typeof att.reason === 'string' && typeof att.at === 'number') {
      observe.attention = { kind: att.kind, reason: att.reason, at: att.at };
    }
  }
  if (typeof row.lastMessageAt === 'number' && row.lastMessageAt > 0) {
    observe.lastActivityAt = row.lastMessageAt;
  }
  if (typeof row.workingDir === 'string' && row.workingDir) observe.workingDirectory = row.workingDir;
  if (status) observe.rawStatus = status;
  if (options.includeRaw) observe.raw = row;

  return observe;
}

export interface RawSessionRow {
  sessionId?: unknown;
  larkAppId?: unknown;
  botName?: unknown;
  chatId?: unknown;
  chatType?: unknown;
  rootMessageId?: unknown;
  scope?: unknown;
  threadId?: unknown;
  feishuChatLink?: unknown;
  feishuThreadLink?: unknown;
  status?: unknown;
  cliId?: unknown;
  runtimeId?: unknown;
  runtimeDisplayName?: unknown;
  cliVersion?: unknown;
  cliInstanceId?: unknown;
  backendType?: unknown;
  backendSessionName?: unknown;
  workerPid?: unknown;
  adoptCliPid?: unknown;
  adopt?: unknown;
  queued?: unknown;
  pendingRepo?: unknown;
  tuiPromptActive?: unknown;
  agentAttention?: unknown;
  lastMessageAt?: unknown;
  workingDir?: unknown;
  [key: string]: unknown;
}
