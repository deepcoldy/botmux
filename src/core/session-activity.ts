// src/core/session-activity.ts
//
// Small helper for keeping dashboard activity timestamps durable.  The
// DaemonSession fields are process-local and get rebuilt after a daemon
// restart, so user-visible activity time must also be persisted on Session.
import * as sessionStore from '../services/session-store.js';
import { dashboardEventBus } from './dashboard-events.js';
import { composeRowFromActive, composeRowFromClosed, composeRowFromPersistedActive } from './dashboard-rows.js';
import { buildSessionMessagePreview } from './session-message-preview.js';
import { holdLastTurnThrough, isMaintenanceTurnId, turnStartedAt } from './turn-outcome.js';
import type { DaemonSession } from './types.js';
import type { Session } from '../types.js';
import { emitSessionTaskEvent } from './session-task-events.js';

/**
 * Stamp `lastHumanMessageAt` on a session that is being created by a human
 * message, before it has a DaemonSession. The caller persists the session.
 */
export function stampHumanActivity(session: Session, at: number): void {
  session.lastHumanMessageAt = new Date(at).toISOString();
}

export function markSessionActivity(
  ds: DaemonSession,
  at: number = Date.now(),
  opts: { human?: boolean } = {},
): void {
  ds.lastMessageAt = at;
  const iso = new Date(at).toISOString();
  let dirty = false;
  if (ds.session.lastMessageAt !== iso) {
    ds.session.lastMessageAt = iso;
    dirty = true;
  }
  // Human-only clock, kept separately so a bot's own turns (and scheduled
  // fires) never count as "someone is here" — see Session.lastHumanMessageAt.
  if (opts.human) {
    ds.lastHumanMessageAt = at;
    if (ds.session.lastHumanMessageAt !== iso) {
      ds.session.lastHumanMessageAt = iso;
      dirty = true;
    }
  }
  if (dirty) sessionStore.updateSession(ds.session);
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId: ds.session.sessionId,
      patch: {
        lastMessageAt: at,
      },
    },
  });
}

/**
 * Bump session activity once a passthrough command reached the worker. A
 * daemon-issued maintenance turn (auto-compact) is not a new task: extend the
 * still-current turn result through this moment first, or the bump would make
 * it stale.
 */
export function markPassthroughActivity(ds: DaemonSession, turnId: string, at: number = Date.now()): void {
  if (isMaintenanceTurnId(turnId)) holdLastTurnThrough(ds, at);
  markSessionActivity(ds, at);
}

/** Refresh the latest user/bot exchange after its append-only source file has
 * been written. Some inbound routes mark activity before appending to queues,
 * so keeping this explicit avoids publishing the previous turn's preview. */
export function publishSessionMessagePreviewPatch(ds: DaemonSession): void {
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId: ds.session.sessionId,
      patch: buildSessionMessagePreview(ds.session),
    },
  });
}

/** Publish the persisted close state and explicitly clear message previews.
 *
 * Dashboard clients merge `session.update` patches into their current row.
 * Deleting the turn-send marker therefore is not enough: every live close
 * entrypoint must overwrite preview fields or an already-open dashboard keeps
 * rendering the last private exchange until its next full hydrate.
 */
export function publishClosedSessionPatch(
  sessionId: string,
  closedAt?: number,
  extraPatch?: { tokenUsage: unknown },
): void {
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId,
      patch: {
        status: 'closed',
        closedAt: closedAt ?? Date.now(),
        ...extraPatch,
        previewUserText: null,
        previewBotText: null,
        previewUserFullText: null,
        previewBotFullText: null,
        previewUserAt: null,
        previewBotAt: null,
        previewBotState: null,
      },
    },
  });
}

/** Publish the latest inbound sender kind after quoteTarget* has been updated.
 *
 * `markSessionActivity()` runs before some routing paths finish writing their
 * quote provenance, so folding this field into its timestamp patch would race
 * with the old value. Keep the patch explicit and call it immediately after
 * assigning `quoteTargetSenderIsBot`.
 */
export function publishLastInputFromBotPatch(ds: DaemonSession): void {
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId: ds.session.sessionId,
      patch: { lastInputFromBot: ds.session.quoteTargetSenderIsBot === true },
    },
  });
}

/**
 * Immediately project a newly learned native topic id into the Dashboard's
 * cached row. `markSessionActivity()` intentionally publishes only timestamp
 * data, so it cannot make a first-time `larkThreadId` visible to a dashboard
 * that has already hydrated this session.
 *
 * The row composer owns the brand-aware AppLink and validates the `omt_...`
 * id again. Returning false keeps accidental callers with a chat/invalid id
 * from publishing a misleading patch.
 */
export function publishNativeTopicLinkPatch(ds: DaemonSession): boolean {
  return publishNativeTopicLinkPatchForSession(ds.session, () => composeRowFromActive(ds).feishuThreadLink);
}

/** Also supports closed and persisted-active rows, which have no DaemonSession. */
export function publishNativeTopicLinkPatchForSession(session: Session, activeLink?: () => string | undefined): boolean {
  const feishuThreadLink = activeLink?.()
    ?? (session.status === 'closed'
      ? composeRowFromClosed(session).feishuThreadLink
      : composeRowFromPersistedActive(session).feishuThreadLink);
  if (!feishuThreadLink) return false;
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId: session.sessionId,
      patch: { feishuThreadLink },
    },
  });
  return true;
}

const emittedAttention = new WeakMap<DaemonSession, number>();

/** Tell the steward about a raise only when it is a new one, i.e. it has a new
 *  `at`. Pushes that repeat the same raise (delivery retries keep the first
 *  `at`, see raiseDaemonAttention) stay quiet. Don't dedupe on the reason: a
 *  later turn can fail the same way with its own `at`, and the steward's alert
 *  key is the raise time. */
function noteAttentionEvent(ds: DaemonSession): void {
  const raised = ds.agentAttention;
  if (!raised) {
    emittedAttention.delete(ds);
    return;
  }
  if (emittedAttention.get(ds) === raised.at) return;
  emittedAttention.set(ds, raised.at);
  if (ds.session.chatId) emitSessionTaskEvent({ chatId: ds.session.chatId, sessionId: ds.session.sessionId });
}

/** Push the current attention signals (repo-selection pending / TUI prompt
 *  open) to the dashboard. Call after mutating `ds.pendingRepo` or
 *  `ds.tuiPromptCardId` so the board view's needs-you column tracks live
 *  state. Idempotent — patches are derived from the session, never toggled
 *  blindly. */
export function publishAttentionPatch(ds: DaemonSession): void {
  noteAttentionEvent(ds);
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId: ds.session.sessionId,
      patch: {
        pendingRepo: !!ds.pendingRepo,
        tuiPromptActive: !!ds.tuiPromptCardId,
        // Object when raised, null to clear — SSE consumers merge the patch, so
        // null overwrites the prior value and drops the row out of needs-you.
        agentAttention: ds.agentAttention
          ? {
              kind: ds.agentAttention.kind,
              reason: ds.agentAttention.reason,
              at: ds.agentAttention.at,
              ...(ds.agentAttention.source ? { source: ds.agentAttention.source } : {}),
            }
          : null,
      },
    },
  });
}

/** Raise the daemon's own hand for `turnId`'s delivery that keeps failing.
 *  Pending deliveries of every unsettled turn are retried every few seconds,
 *  long after newer turns started. While a daemon raise is up, keep its
 *  original `at` so the board, owner reminders and steward alerts see one raise,
 *  not a fresh one per retry. Only a failing turn that started after that raise
 *  gets its own `at`: the board reads a raise older than a newer turn's start as
 *  superseded (bot-only groups never clear it), so the newer failure must not
 *  inherit it, and an older turn's retry must not push it past the newer turn.
 *  Returns whether anything changed. */
export function raiseDaemonAttention(
  ds: DaemonSession,
  kind: string,
  reason: string,
  turnId: string | undefined,
  now: number = Date.now(),
): boolean {
  const current = ds.agentAttention;
  const startedAt = turnId ? turnStartedAt(ds, turnId) : undefined;
  if (current && current.source !== 'agent' && !(startedAt !== undefined && startedAt > current.at)) {
    if (current.kind === kind && current.reason === reason) return false;
    ds.agentAttention = { kind, reason, at: current.at };
    return true;
  }
  ds.agentAttention = { kind, reason, at: now };
  return true;
}

export function clearAgentAttention(ds: DaemonSession): boolean {
  if (!ds.agentAttention) return false;
  ds.agentAttention = undefined;
  publishAttentionPatch(ds);
  return true;
}

export function announceSessionRow(ds: DaemonSession): void {
  dashboardEventBus.publish({
    type: 'session.spawned',
    body: { session: composeRowFromActive(ds) },
  });
}

/** Announce a repo-selection-pending session to dashboard SSE subscribers.
 *
 *  `session.spawned` is normally published when the worker process spawns —
 *  but a pendingRepo session has NO worker yet (it sits in activeSessions
 *  waiting for a card click), so SSE-only dashboard clients never learn it
 *  exists until the next full hydrate. Call this right after registering such
 *  a session. No-op when the session isn't actually pending, so callers on
 *  mixed paths (`pendingRepo: !pinnedWorkingDir`) can call unconditionally —
 *  the non-pending branch is announced by the real spawn moments later. */
export function announcePendingRepoSession(ds: DaemonSession): void {
  if (!ds.pendingRepo) return;
  announceSessionRow(ds);
}
