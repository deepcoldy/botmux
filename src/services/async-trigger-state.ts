/**
 * Pure four-state resolution for `GET /api/sessions/:id/trigger-result`
 * (async dispatch design A). Kept free of daemon/registry imports so it can be
 * unit-tested directly; dashboard-ipc-server gathers the three inputs (live
 * session, on-disk session record, persisted async result) and calls this.
 *
 * State contract (see docs/developer/platform/botmux-async-dispatch-design.md):
 *  - completed: final output captured (mem OR durable) → output.content + finishedAt
 *  - running:   live session in flight, or a session record still open
 *  - failed:    session record closed with no captured output (no_output; soft
 *               terminal — may be a genuine failure OR a caller-initiated close)
 *  - not_found: no session record anywhere (never existed / invalid id)
 *
 * Restart guarantee: as long as EITHER a session record OR a persisted result
 * exists, this never returns not_found — an already-completed turn resolves to
 * completed even after the in-memory Map is gone.
 */
import type { TriggerResponse } from './trigger-types.js';

/** Fail-closed / positive-proof cross-bot ownership gate for trigger-result.
 *
 *  sessionStore.getSession() scans EVERY bot's sessions-*.json and the async
 *  store is a machine-wide shared directory, so a request routed to daemon A
 *  carrying a sessionId owned by bot B could read B's record / persisted output.
 *  This decides which of the two shared-store sources daemon `owner` may trust.
 *
 *  A source is kept ONLY with POSITIVE proof of ownership — "not known-foreign"
 *  is deliberately insufficient, so a legacy unstamped persisted file with no
 *  owned session (unprovable owner) is dropped rather than leaked.
 *
 *   - live ds:   always ours (in THIS daemon's registry) → caller passes liveDs.
 *   - stored:    keep iff there's a live ds OR its larkAppId == owner.
 *   - persisted: keep iff stamped with owner, OR (unstamped legacy) corroborated
 *                by an owned session context for the same id.
 *
 *  Returns which sources survive, plus `foreignLeak` = raw data existed but none
 *  of it is attributable to us (→ caller returns a clean not_found miss). */
export interface OwnershipInputs {
  owner: string;                    // this daemon's larkAppId (cachedLarkAppId)
  liveDs: boolean;                  // a live DaemonSession exists in this registry
  storedOwner?: string;             // larkAppId on the (possibly cross-scanned) stored record
  storedExists: boolean;            // a stored session record was found at all
  persistedOwner?: string;          // ownerLarkAppId stamped on the persisted file
  persistedExists: boolean;         // a persisted result was found at all
}
export interface OwnershipDecision {
  keepStored: boolean;
  keepPersisted: boolean;
  foreignLeak: boolean;
}
export function decideAsyncOwnership(inp: OwnershipInputs): OwnershipDecision {
  const keepStored = inp.storedExists && (inp.liveDs || (!!inp.owner && inp.storedOwner === inp.owner));
  const ownedSessionForId = inp.liveDs || keepStored;
  const keepPersisted = inp.persistedExists && (
    (!!inp.owner && inp.persistedOwner === inp.owner) ||
    (inp.persistedOwner === undefined && ownedSessionForId)
  );
  // Raw data surfaced from the shared stores, but nothing is attributable to us.
  const foreignLeak =
    !inp.liveDs && !keepStored && !keepPersisted && (inp.storedExists || inp.persistedExists);
  return { keepStored, keepPersisted, foreignLeak };
}


export interface TurnUsageBuckets {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface AsyncStateInputs {
  sessionId: string;
  /** Whether a live DaemonSession is currently registered for this id. */
  liveActive: boolean;
  /** chatId from the live session or the stored record, if known. */
  chatId?: string;
  /** In-memory async result for the resolved trigger, if the session is live. */
  memResult?: { status: 'pending' | 'completed'; content?: string; completedAt?: number; usage?: TurnUsageBuckets };
  /** triggerId the in-memory result is keyed under (latest or explicit). */
  memTriggerId?: string;
  /** Durable persisted result (survives restart), if any. */
  persisted?: {
    triggerId: string;
    result: { status: 'pending' | 'completed'; content?: string; completedAt?: number; usage?: TurnUsageBuckets };
  };
  /** On-disk session record status: 'open' (active), 'closed', or absent. */
  storedStatus?: 'open' | 'closed';
  /** closedAt ISO string from the stored record, for failed/finishedAt. */
  closedAt?: string;
  /** triggerId from the request query, if the caller pinned one. */
  requestedTriggerId?: string;
}

export function resolveAsyncTriggerState(inp: AsyncStateInputs): TriggerResponse {
  const { sessionId, chatId } = inp;

  // Precise-triggerId miss: the caller pinned ?triggerId= but no record (in
  // memory or durable) matches it, AND a session context exists for this id.
  // Preserve the legacy bad_request semantics — do NOT fall through to session
  // open/closed and misreport running/failed for a trigger this session never
  // had. (The caller only passes memResult/persisted that actually match the
  // requested id, so "both absent + session exists" == precise miss.) When no
  // session exists at all, this falls through to the not_found branch below.
  const sessionExists = inp.liveActive || inp.storedStatus !== undefined;
  if (inp.requestedTriggerId && !inp.memResult && !inp.persisted && sessionExists) {
    // No `state`: this is a request-shape error (the caller pinned a triggerId
    // this session never had), NOT one of the four task-lifecycle states. Keep
    // it distinct from the public `state:"not_found"` (ok:true, session absent)
    // so callers don't conflate "bad request" with "no such session".
    return {
      ok: false,
      triggerId: inp.requestedTriggerId,
      errorCode: 'bad_request',
      error: `async trigger not found for session: ${inp.requestedTriggerId}`,
      message: 'requested triggerId not found for this session',
    };
  }

  const completed =
    (inp.memResult?.status === 'completed' && inp.memTriggerId
      ? { triggerId: inp.memTriggerId, content: inp.memResult.content, completedAt: inp.memResult.completedAt, usage: inp.memResult.usage }
      : undefined) ??
    (inp.persisted?.result.status === 'completed'
      ? { triggerId: inp.persisted.triggerId, content: inp.persisted.result.content, completedAt: inp.persisted.result.completedAt, usage: inp.persisted.result.usage }
      : undefined);

  if (completed) {
    const finishedAt = completed.completedAt ? new Date(completed.completedAt).toISOString() : undefined;
    return {
      ok: true,
      state: 'completed',
      triggerId: completed.triggerId,
      action: 'completed',
      target: { kind: 'turn', sessionId, chatId },
      output: completed.content !== undefined ? { content: completed.content } : undefined,
      ...(completed.usage ? { usage: completed.usage } : {}),
      finishedAt,
      async: { status: 'completed', sessionId, completedAt: finishedAt },
      message: 'async trigger completed',
    };
  }

  // Closed record with no captured output → soft-terminal failed. Checked
  // BEFORE the durable-pending running branch: a closed session whose persisted
  // record is still `pending` was armed but never completed (a cancel/close or a
  // genuine failure), so it must resolve to failed, not loop as running forever.
  // The caller distinguishes its own cancel via intent, not this signal.
  if (inp.storedStatus === 'closed') {
    return {
      ok: true,
      state: 'failed',
      triggerId: inp.persisted?.triggerId ?? inp.requestedTriggerId,
      target: { kind: 'turn', sessionId, chatId },
      errorCode: 'no_output',
      error: '会话已终止但未捕获最终产出（可能失败或被取消）',
      finishedAt: inp.closedAt ?? undefined,
      message: 'async trigger terminated without output',
    };
  }

  // Running: a live session (worker in flight), a still-open session record,
  // or a durable pending result with NO session record on disk (restart edge:
  // the trigger was armed but its session file is momentarily unavailable —
  // never downgrade this to not_found).
  if (inp.liveActive || inp.storedStatus === 'open' || inp.persisted?.result.status === 'pending') {
    return {
      ok: true,
      state: 'running',
      triggerId: inp.persisted?.triggerId ?? inp.requestedTriggerId,
      action: 'queued',
      target: { kind: 'turn', sessionId, chatId },
      async: { status: 'pending', sessionId },
      message: 'async trigger running',
    };
  }

  // No session record anywhere, no persisted result.
  return {
    ok: true,
    state: 'not_found',
    triggerId: inp.requestedTriggerId,
    errorCode: 'session_not_found',
    error: `no session record for: ${sessionId}`,
    message: 'no session found',
  };
}
