// src/core/session-activity.ts
//
// Small helper for keeping dashboard activity timestamps durable.  The
// DaemonSession fields are process-local and get rebuilt after a daemon
// restart, so user-visible activity time must also be persisted on Session.
import * as sessionStore from '../services/session-store.js';
import { dashboardEventBus } from './dashboard-events.js';
import { composeRowFromActive } from './dashboard-rows.js';
import type { DaemonSession } from './types.js';

export function markSessionActivity(ds: DaemonSession, at: number = Date.now()): void {
  ds.lastMessageAt = at;
  const iso = new Date(at).toISOString();
  if (ds.session.lastMessageAt !== iso) {
    ds.session.lastMessageAt = iso;
    sessionStore.updateSession(ds.session);
  }
  dashboardEventBus.publish({
    type: 'session.update',
    body: { sessionId: ds.session.sessionId, patch: { lastMessageAt: at } },
  });
}

/** Push the current attention signals (repo-selection pending / TUI prompt
 *  open) to the dashboard. Call after mutating `ds.pendingRepo` or
 *  `ds.tuiPromptCardId` so the board view's needs-you column tracks live
 *  state. Idempotent — patches are derived from the session, never toggled
 *  blindly. */
export function publishAttentionPatch(ds: DaemonSession): void {
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
          ? { kind: ds.agentAttention.kind, reason: ds.agentAttention.reason, at: ds.agentAttention.at }
          : null,
      },
    },
  });
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
