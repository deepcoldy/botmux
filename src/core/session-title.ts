import type { Session } from '../types.js';
import * as sessionStore from '../services/session-store.js';
import { dashboardEventBus } from './dashboard-events.js';
import { normalizeSessionTitle } from './session-board.js';

export type SessionTitleUpdateResult =
  | { ok: true; title: string }
  | { ok: false; error: 'bad_title' };

/** Persist a display-title change and keep dashboard subscribers in sync. */
export function updateSessionTitle(session: Session, rawTitle: unknown): SessionTitleUpdateResult {
  const title = normalizeSessionTitle(rawTitle);
  if (!title) return { ok: false, error: 'bad_title' };

  session.title = title;
  sessionStore.updateSession(session);
  dashboardEventBus.publish({
    type: 'session.update',
    body: { sessionId: session.sessionId, patch: { title } },
  });
  return { ok: true, title };
}
