/**
 * Locate one session by id: ask a live daemon first, read the store only
 * when no daemon answered.
 *
 * A 404 from the OWNING daemon (the one `BOTMUX_LARK_APP_ID` names) is
 * authoritative absence — never fall back to the store. Without an appId the
 * resolver enumerates every online daemon; each answers only for its own bot,
 * so a 404 there says nothing about other bots' stores and the store is still
 * read afterwards. Connection failure / no descriptor / unread secret
 * (isolated CLI) fall back to the snapshot, including the unmigrated probe.
 */
import { fetchDaemonIpc, loadDaemonIpcSecret } from '../core/daemon-ipc-auth.js';
import {
  classifyStorePresence,
  loadAllSessionsSnapshot,
  type SessionsSnapshot,
} from '../services/session-store.js';
import type { Session } from '../types.js';
import { formatUnmigratedMessage, isSessionScopedCliProcess } from '../services/session-store-copy.js';
import { knownBotAppIds } from '../services/known-bot-app-ids.js';
import { findOnlineDaemon, listOnlineDaemons, type OnlineDaemonInfo } from '../utils/daemon-discovery.js';
import { daemonVersionDiffersFromDisk, stripBotmuxVersionPrefix } from '../utils/daemon-version-display.js';

export type ResolveSessionByIdOk = { ok: true; session: Session; source: 'daemon' | 'store' };
export type ResolveSessionByIdErr = {
  ok: false;
  reason: 'not_found' | 'unmigrated' | 'app_id_mismatch' | 'session_id_mismatch';
  message: string;
  /** Who was asked and what the store says, for the caller's diagnostic line. */
  diagnostics?: ResolveSessionDiagnostics;
};

export type ResolveSessionDiagnostics = {
  /** Daemons queried, with the version each advertises in its descriptor. */
  askedDaemons: Array<{ appId: string; version?: string }>;
  /** App the session belongs to per the session store, read after an
   *  authoritative 404 (absent when the store has no such row). */
  ownerAppId?: string;
};
export type ResolveSessionByIdResult = ResolveSessionByIdOk | ResolveSessionByIdErr;

export type ResolveSessionByIdDeps = {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  findDaemon?: typeof findOnlineDaemon;
  listDaemons?: typeof listOnlineDaemons;
  fetchIpc?: typeof fetchDaemonIpc;
  loadSecret?: typeof loadDaemonIpcSecret;
  loadSnapshot?: typeof loadAllSessionsSnapshot;
  /** Bots that still exist (configured / online / own); leftover JSON of any
   *  other app id is abandoned data, not `unmigrated`. Computed when omitted. */
  knownAppIds?: ReadonlySet<string>;
  /** Version of this CLI, to flag a daemon still running another build. */
  cliVersion?: string;
};

function asSession(row: unknown): Session | undefined {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
  const session = row as Session;
  if (typeof session.sessionId !== 'string' || !session.sessionId) return undefined;
  return session;
}

function mismatch(
  reason: 'app_id_mismatch' | 'session_id_mismatch',
  message: string,
): ResolveSessionByIdErr {
  return { ok: false, reason, message };
}

function checkReturnedRow(
  session: Session,
  sessionId: string,
  envAppId: string | undefined,
): ResolveSessionByIdErr | undefined {
  if (session.sessionId !== sessionId) {
    return mismatch('session_id_mismatch', `daemon 返回的 sessionId 与请求不一致`);
  }
  if (envAppId && session.larkAppId && session.larkAppId !== envAppId) {
    return mismatch('app_id_mismatch', `daemon 返回的 larkAppId 与 BOTMUX_LARK_APP_ID 不一致`);
  }
  return undefined;
}

async function askDaemon(
  daemon: OnlineDaemonInfo,
  sessionId: string,
  deps: ResolveSessionByIdDeps,
): Promise<
  | { status: 'ok'; session: Session }
  | { status: 'not_found' }
  | { status: 'unreachable' }
  | { status: 'rejected'; err: ResolveSessionByIdErr }
> {
  let secret: string;
  try {
    secret = (deps.loadSecret ?? loadDaemonIpcSecret)();
  } catch {
    return { status: 'unreachable' };
  }
  let res: Response;
  try {
    res = await (deps.fetchIpc ?? fetchDaemonIpc)(
      daemon.ipcPort,
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'GET' },
      secret,
    );
  } catch {
    return { status: 'unreachable' };
  }
  if (res.status === 404) return { status: 'not_found' };
  if (!res.ok) return { status: 'unreachable' };
  let body: unknown;
  try { body = await res.json(); } catch { return { status: 'unreachable' }; }
  const row = asSession(
    body && typeof body === 'object' && 'session' in body
      ? (body as { session: unknown }).session
      : body,
  );
  if (!row) return { status: 'unreachable' };
  const bad = checkReturnedRow(row, sessionId, deps.env?.BOTMUX_LARK_APP_ID);
  if (bad) return { status: 'rejected', err: bad };
  return { status: 'ok', session: row };
}

function readFromStore(
  sessionId: string,
  deps: ResolveSessionByIdDeps,
): ResolveSessionByIdResult {
  const env = deps.env ?? process.env;
  const envAppId = env.BOTMUX_LARK_APP_ID;
  if (envAppId && classifyStorePresence(envAppId, deps.dataDir) === 'unmigrated') {
    return {
      ok: false,
      reason: 'unmigrated',
      message: formatUnmigratedMessage({ sessionScoped: isSessionScopedCliProcess(env) }),
    };
  }
  const snapshot: SessionsSnapshot = (deps.loadSnapshot ?? loadAllSessionsSnapshot)({
    dataDir: deps.dataDir,
    fallbackAppId: envAppId,
    knownAppIds: deps.knownAppIds ?? knownBotAppIds({ dataDir: deps.dataDir, env }),
  });
  const hit = snapshot.get(sessionId);
  if (hit) {
    const bad = checkReturnedRow(hit, sessionId, envAppId);
    if (bad) return bad;
    return { ok: true, session: hit, source: 'store' };
  }
  const unmigrated = snapshot.unmigratedAppIds ?? [];
  if (unmigrated.length > 0 && !hit) {
    // No row in ready stores, and at least one bot is still on JSON — the
    // session may live there. Fail with unmigrated rather than a silent miss.
    if (!envAppId || unmigrated.includes(envAppId)) {
      return {
        ok: false,
        reason: 'unmigrated',
        message: formatUnmigratedMessage({ sessionScoped: isSessionScopedCliProcess(env) }),
      };
    }
  }
  return { ok: false, reason: 'not_found', message: `未找到 session ${sessionId}` };
}

export async function resolveSessionById(
  sessionId: string,
  deps: ResolveSessionByIdDeps,
): Promise<ResolveSessionByIdResult> {
  const env = deps.env ?? process.env;
  const findDaemon = deps.findDaemon ?? findOnlineDaemon;
  const listDaemons = deps.listDaemons ?? listOnlineDaemons;
  const envAppId = env.BOTMUX_LARK_APP_ID;

  const candidates: OnlineDaemonInfo[] = [];
  if (envAppId) {
    try {
      const one = findDaemon(envAppId, deps.dataDir);
      if (one) candidates.push(one);
    } catch { /* unreadable registry → store fallback */ }
  } else {
    try { candidates.push(...listDaemons(deps.dataDir)); } catch { /* store fallback */ }
  }

  let sawAuthoritativeMiss = false;
  for (const daemon of candidates) {
    const asked = await askDaemon(daemon, sessionId, { ...deps, env });
    if (asked.status === 'ok') return { ok: true, session: asked.session, source: 'daemon' };
    if (asked.status === 'rejected') return asked.err;
    if (asked.status === 'not_found') {
      // Only the owning daemon's 404 is authoritative. A 404 from a daemon
      // reached by enumeration covers just that bot's store — keep asking,
      // then read the store (an offline bot's rows live only on disk).
      if (envAppId) { sawAuthoritativeMiss = true; break; }
    }
  }
  const askedDaemons = candidates.map(d => ({
    appId: d.larkAppId,
    ...(d.botmuxVersion ? { version: d.botmuxVersion } : {}),
  }));
  if (sawAuthoritativeMiss) {
    return authoritativeMiss(sessionId, envAppId!, askedDaemons, { ...deps, env });
  }
  const fromStore = readFromStore(sessionId, { ...deps, env });
  if (fromStore.ok) return fromStore;
  const stale = fromStore.reason === 'not_found'
    ? staleDaemonNote(askedDaemons, deps.cliVersion, env)
    : undefined;
  return {
    ...fromStore,
    ...(stale ? { message: `${fromStore.message}（${stale}）` } : {}),
    diagnostics: { askedDaemons },
  };
}

function staleDaemonNote(
  askedDaemons: ResolveSessionDiagnostics['askedDaemons'],
  cliVersion: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const stale = askedDaemons.find(d => daemonVersionDiffersFromDisk(d.version, cliVersion));
  if (!stale) return undefined;
  // Design doc 2026-08-12 §3.6: a session subprocess (an unsandboxed session
  // shell IS the host) gets STATE ONLY — no fleet-level command and no pid /
  // port / version numbers, because an agent that follows a `botmux restart`
  // hint would restart the very fleet its own daemon runs in. The operator
  // wording (versions + command) is for host shells only.
  if (isSessionScopedCliProcess(env)) {
    return '被问的 daemon 与当前 CLI 版本不一致，本次未做任何修改';
  }
  return `被问的 daemon（${stale.appId}）版本 v${stripBotmuxVersionPrefix(stale.version!)} `
    + `与当前 CLI v${stripBotmuxVersionPrefix(cliVersion!)} 不一致，请在宿主终端执行 botmux restart 后重试`;
}

/**
 * The owning daemon said 404. That stays the answer, but say why where we can:
 * a row in the store under ANOTHER app means the session id was sent with the
 * wrong bot identity, and a daemon still on another build may simply not know
 * the lookup this CLI performs.
 */
function authoritativeMiss(
  sessionId: string,
  envAppId: string,
  askedDaemons: ResolveSessionDiagnostics['askedDaemons'],
  deps: ResolveSessionByIdDeps,
): ResolveSessionByIdErr {
  let ownerAppId: string | undefined;
  try {
    const snapshot = (deps.loadSnapshot ?? loadAllSessionsSnapshot)({
      dataDir: deps.dataDir,
      knownAppIds: deps.knownAppIds ?? knownBotAppIds({ dataDir: deps.dataDir, env: deps.env ?? process.env }),
    });
    ownerAppId = snapshot.get(sessionId)?.larkAppId || undefined;
  } catch { /* unreadable store (sandbox): the 404 alone stands */ }
  const notes: string[] = [];
  if (ownerAppId && ownerAppId !== envAppId) {
    notes.push(`该会话属于 app ${ownerAppId}，不属于当前 BOTMUX_LARK_APP_ID=${envAppId}`);
  }
  const stale = staleDaemonNote(askedDaemons, deps.cliVersion, deps.env ?? process.env);
  if (stale) notes.push(stale);
  return {
    ok: false,
    reason: 'not_found',
    message: `未找到 session ${sessionId}${notes.length ? `（${notes.join('；')}）` : ''}`,
    diagnostics: { askedDaemons, ...(ownerAppId ? { ownerAppId } : {}) },
  };
}
