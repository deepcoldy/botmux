// Thin CLI/TS façade for the canonical worker/session observe seam.
//
// Contract:
// - Only source of runtime facts is the daemon loopback IPC (GET /api/sessions
//   and GET /api/sessions/:id). Nothing else is probed — no PtyBackend, tmux
//   introspection, /proc scan, session-store re-derivation. That is the entire
//   point of the seam: the daemon has already composed the SessionRow.
// - Probe failures never fall back to a cached SessionRow or persisted store.
//   The envelope surfaces a non-`ok` probe status and an empty session list;
//   for a session-specific probe, the returned ObserveSession carries the
//   failure marker while emitting the identity we were asked to look up.
// - `normalizeSessionRow` is imported by both this façade and any in-process
//   TypeScript caller. The CLI is a stdout shim over the same function; there
//   is no CLI-only re-derivation.

import {
  fetchDaemonIpc,
  loadDaemonIpcSecret,
} from '../core/daemon-ipc-auth.js';
import {
  listOnlineDaemons,
  type OnlineDaemonInfo,
} from '../utils/daemon-discovery.js';
import {
  OBSERVE_SCHEMA_VERSION,
  normalizeSessionRow,
  type ObserveDaemonEnvelope,
  type ObserveProbe,
  type ObserveProbeStatus,
  type ObserveSession,
  type ObserveSnapshot,
  type RawSessionRow,
} from './session-observe.js';

/** Product-facing query options shared by every façade entry point. */
export interface ObserveFetchQuery {
  /** Restrict to a single daemon by its Lark app id; otherwise every online
   *  daemon is probed and its envelope aggregated. */
  larkAppId?: string;
  /** Include the raw SessionRow beneath `session.raw` for diagnostics. Off by
   *  default because callers typically consume only the canonical fields. */
  includeRaw?: boolean;
}

type DaemonIpcFetch = (
  port: number,
  path: string,
  init?: RequestInit,
  secret?: string,
) => Promise<Response>;

export interface ObserveFetchDependencies {
  now?: () => number;
  secret?: string;
  dataDir?: string;
  fetch?: DaemonIpcFetch;
  discover?: (dataDir?: string) => OnlineDaemonInfo[];
  timeoutMs?: number;
}

interface DaemonProbeContext {
  daemon: OnlineDaemonInfo;
  fetch: DaemonIpcFetch;
  secret: string | undefined;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function nowFn(dependencies: ObserveFetchDependencies): () => number {
  return dependencies.now ?? Date.now;
}

function loadSecretSafely(dependencies: ObserveFetchDependencies): string | undefined {
  if (typeof dependencies.secret === 'string') return dependencies.secret;
  try { return loadDaemonIpcSecret(); }
  catch { return undefined; }
}

function probeFrom(status: ObserveProbeStatus, daemon: OnlineDaemonInfo, error?: string): ObserveProbe {
  const probe: ObserveProbe = { status, source: 'daemon-ipc' };
  if (daemon.larkAppId) probe.larkAppId = daemon.larkAppId;
  if (error) probe.error = error;
  return probe;
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`daemon_ipc_timeout_${ms}ms`));
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyHttpStatus(status: number): ObserveProbeStatus {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'unreachable';
  return 'unreachable';
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

/**
 * List every session behind a specific daemon (or every online daemon when no
 * larkAppId is provided). One envelope per daemon; each envelope carries its
 * own probe outcome so a partial failure never contaminates other daemons.
 */
export async function fetchObserveSnapshotImplementation(
  options: ObserveFetchQuery = {},
  dependencies: ObserveFetchDependencies = {},
): Promise<ObserveSnapshot> {
  const now = nowFn(dependencies);
  const observedAt = now();
  const discover = dependencies.discover ?? listOnlineDaemons;
  const fetchFn = dependencies.fetch ?? (fetchDaemonIpc as DaemonIpcFetch);
  const secret = loadSecretSafely(dependencies);
  const timeoutMs = Number.isFinite(dependencies.timeoutMs) && (dependencies.timeoutMs ?? 0) > 0
    ? Number(dependencies.timeoutMs)
    : DEFAULT_TIMEOUT_MS;

  const online = discover(dependencies.dataDir);
  const targets = options.larkAppId
    ? online.filter(d => d.larkAppId === options.larkAppId)
    : online;

  if (options.larkAppId && targets.length === 0) {
    // Named daemon is not online → surface a dedicated envelope so the caller
    // sees the identity, not an empty snapshot.
    return {
      schemaVersion: OBSERVE_SCHEMA_VERSION,
      observedAt,
      daemons: [{
        larkAppId: options.larkAppId,
        probe: {
          status: 'daemon_offline',
          source: 'daemon-ipc',
          larkAppId: options.larkAppId,
        },
        sessions: [],
      }],
    };
  }

  const envelopes = await Promise.all(targets.map(async (daemon): Promise<ObserveDaemonEnvelope> => {
    const ctx: DaemonProbeContext = { daemon, fetch: fetchFn, secret, timeoutMs };
    return await probeDaemonList(ctx, observedAt, options.includeRaw === true);
  }));

  return {
    schemaVersion: OBSERVE_SCHEMA_VERSION,
    observedAt,
    daemons: envelopes,
  };
}

async function probeDaemonList(
  ctx: DaemonProbeContext,
  observedAt: number,
  includeRaw: boolean,
): Promise<ObserveDaemonEnvelope> {
  const envelopeBase: ObserveDaemonEnvelope = {
    larkAppId: ctx.daemon.larkAppId,
    probe: probeFrom('ok', ctx.daemon),
    sessions: [],
  };

  try {
    const { res, body } = await withTimeout(async signal => {
      const res = await ctx.fetch(ctx.daemon.ipcPort, '/api/sessions', { method: 'GET', signal }, ctx.secret);
      return { res, body: res.ok ? await readJson(res) : undefined };
    },
      ctx.timeoutMs,
    );
    if (!res.ok) {
      const status = classifyHttpStatus(res.status);
      envelopeBase.probe = probeFrom(status, ctx.daemon, `HTTP ${res.status}`);
      return envelopeBase;
    }
    const rows = extractSessionRows(body);
    if (!rows) {
      envelopeBase.probe = probeFrom('unreachable', ctx.daemon, 'malformed_body');
      return envelopeBase;
    }
    envelopeBase.sessions = rows.map(row => normalizeSessionRow(row, {
      observedAt,
      probe: probeFrom('ok', ctx.daemon),
      includeRaw,
    }));
    return envelopeBase;
  } catch (err) {
    envelopeBase.probe = probeFrom('unreachable', ctx.daemon, err instanceof Error ? err.message : String(err));
    return envelopeBase;
  }
}

function extractSessionRows(body: unknown): RawSessionRow[] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const raw = (body as { sessions?: unknown }).sessions;
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((r): r is RawSessionRow => r !== null && typeof r === 'object');
}

/** Session-level probe. Resolves the owning daemon (by explicit `larkAppId`
 *  when provided, otherwise by fanning across every online daemon and picking
 *  the first `ok` hit). Returns an ObserveSession whose probe reflects the
 *  outcome; a `not_found` result still populates identity.sessionId so
 *  consumers can attach it to the right task without re-deriving. */
export async function fetchObserveSessionImplementation(
  sessionId: string,
  options: ObserveFetchQuery = {},
  dependencies: ObserveFetchDependencies = {},
): Promise<ObserveSession> {
  const now = nowFn(dependencies);
  const observedAt = now();
  const discover = dependencies.discover ?? listOnlineDaemons;
  const fetchFn = dependencies.fetch ?? (fetchDaemonIpc as DaemonIpcFetch);
  const secret = loadSecretSafely(dependencies);
  const timeoutMs = Number.isFinite(dependencies.timeoutMs) && (dependencies.timeoutMs ?? 0) > 0
    ? Number(dependencies.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const includeRaw = options.includeRaw === true;

  const online = discover(dependencies.dataDir);
  const targets = options.larkAppId
    ? online.filter(d => d.larkAppId === options.larkAppId)
    : online;

  if (options.larkAppId && targets.length === 0) {
    return synthesizeMissingSession(sessionId, observedAt, {
      status: 'daemon_offline',
      source: 'daemon-ipc',
      larkAppId: options.larkAppId,
    });
  }
  if (targets.length === 0) {
    return synthesizeMissingSession(sessionId, observedAt, {
      status: 'daemon_offline',
      source: 'daemon-ipc',
    });
  }

  const outcomes = await Promise.all(targets.map(async daemon => {
    const ctx: DaemonProbeContext = { daemon, fetch: fetchFn, secret, timeoutMs };
    return await probeDaemonSession(ctx, sessionId, observedAt, includeRaw);
  }));
  const hit = outcomes.find((outcome): outcome is Extract<SessionProbeOutcome, { kind: 'ok' }> => (
    outcome.kind === 'ok'
  ));
  if (hit) return hit.session;
  const failures = outcomes.filter((outcome): outcome is Exclude<SessionProbeOutcome, { kind: 'ok' }> => (
    outcome.kind !== 'ok'
  ));
  const failurePrecedence: ObserveProbeStatus[] = [
    'unauthorized',
    'unreachable',
    'not_found',
    'daemon_offline',
  ];
  const selectedFailure = failurePrecedence
    .map(status => failures.filter(outcome => outcome.probe.status === status).at(-1))
    .find((outcome): outcome is Exclude<SessionProbeOutcome, { kind: 'ok' }> => outcome !== undefined);

  return synthesizeMissingSession(sessionId, observedAt, selectedFailure?.probe ?? {
    status: 'not_found',
    source: 'daemon-ipc',
  });
}

type SessionProbeOutcome =
  | { kind: 'ok'; session: ObserveSession }
  | { kind: 'not_found'; probe: ObserveProbe }
  | { kind: 'error'; probe: ObserveProbe };

async function probeDaemonSession(
  ctx: DaemonProbeContext,
  sessionId: string,
  observedAt: number,
  includeRaw: boolean,
): Promise<SessionProbeOutcome> {
  const encoded = encodeURIComponent(sessionId);
  try {
    const { res, body } = await withTimeout(async signal => {
      const res = await ctx.fetch(
        ctx.daemon.ipcPort,
        `/api/sessions/${encoded}`,
        { method: 'GET', signal },
        ctx.secret,
      );
      return { res, body: res.ok ? await readJson(res) : undefined };
    },
      ctx.timeoutMs,
    );
    if (res.status === 404) {
      return { kind: 'not_found', probe: probeFrom('not_found', ctx.daemon) };
    }
    if (!res.ok) {
      return { kind: 'error', probe: probeFrom(classifyHttpStatus(res.status), ctx.daemon, `HTTP ${res.status}`) };
    }
    const row = extractSessionRow(body);
    if (!row) return { kind: 'error', probe: probeFrom('unreachable', ctx.daemon, 'malformed_body') };
    return {
      kind: 'ok',
      session: normalizeSessionRow(row, {
        observedAt,
        probe: probeFrom('ok', ctx.daemon),
        includeRaw,
      }),
    };
  } catch (err) {
    return {
      kind: 'error',
      probe: probeFrom('unreachable', ctx.daemon, err instanceof Error ? err.message : String(err)),
    };
  }
}

function extractSessionRow(body: unknown): RawSessionRow | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const raw = (body as { session?: unknown }).session;
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as RawSessionRow;
}

function synthesizeMissingSession(
  sessionId: string,
  observedAt: number,
  probe: ObserveProbe,
): ObserveSession {
  return {
    schemaVersion: OBSERVE_SCHEMA_VERSION,
    observedAt,
    probe,
    identity: { sessionId },
    cli: {},
    backend: { adopted: 'unknown' },
    liveness: 'unknown',
    turn: 'unknown',
    phase: 'unknown',
    queued: 'unknown',
    parkedOrSuspended: 'unknown',
    closed: 'unknown',
  };
}
