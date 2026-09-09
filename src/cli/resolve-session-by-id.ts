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
import { findOnlineDaemon, listOnlineDaemons, type OnlineDaemonInfo } from '../utils/daemon-discovery.js';

export type ResolveSessionByIdOk = { ok: true; session: Session; source: 'daemon' | 'store' };
export type ResolveSessionByIdErr = {
  ok: false;
  reason: 'not_found' | 'unmigrated' | 'app_id_mismatch' | 'session_id_mismatch';
  message: string;
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
    if (!envAppId || unmigrated.includes(envAppId) || unmigrated.includes('')) {
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
  if (sawAuthoritativeMiss) {
    return { ok: false, reason: 'not_found', message: `未找到 session ${sessionId}` };
  }
  return readFromStore(sessionId, { ...deps, env });
}
