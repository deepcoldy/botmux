import { createHash } from 'node:crypto';
import type { DaemonSession } from './types.js';
import { deriveSessionOwnerReminderStates, sessionOwnerReminderObservationFingerprint, type SessionOwnerReminderState } from './session-owner-reminder.js';
export interface CoreOnlyReminderState {
  sessionId: string; triggerId: string; workerGeneration: number;
  active: boolean; states: SessionOwnerReminderState[]; fingerprint: string; lastActivityAt: number;
}
/** Identity and API-only transport scope are checked by the authenticated host
 * route. This projection contains runtime facts, never any platform owner ID. */
export function projectCoreOnlyReminderState(ds: DaemonSession, triggerId: string, latestVerifiedTriggerId = ds.latestAsyncTriggerId): CoreOnlyReminderState | undefined {
  if (!triggerId || latestVerifiedTriggerId !== triggerId) return;
  const workerGeneration = ds.workerGeneration ?? ds.session.workerGeneration ?? 0;
  if (!workerGeneration && (ds.worker || !ds.pendingRepo)) return;
  const states = ds.session.status === 'active' && !ds.session.queued ? deriveSessionOwnerReminderStates(ds).filter(value => value !== 'tui_prompt') : [];
  return { sessionId: ds.session.sessionId, triggerId, workerGeneration,
    active: ds.session.status === 'active' && !ds.session.queued,
    states, fingerprint: createHash('sha256').update(sessionOwnerReminderObservationFingerprint(ds, states)).digest('hex'),
    lastActivityAt: Number.isFinite(ds.lastMessageAt) ? ds.lastMessageAt : 0 };
}
