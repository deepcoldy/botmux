import type { Session } from '../types.js';
import * as sessionStore from '../services/session-store.js';
import { dashboardEventBus } from './dashboard-events.js';
import { normalizeSessionTitle } from './session-board.js';

export type SessionTitleSource = 'initial' | 'user' | 'agent' | 'cli' | 'dashboard' | 'system';

export type SessionTitleUpdateResult =
  | { ok: true; title: string; updatedAt: string; source: SessionTitleSource }
  | { ok: false; error: 'bad_title' };

export function normalizeSessionTitleSource(value: unknown, fallback: SessionTitleSource): SessionTitleSource {
  if (
    value === 'initial' ||
    value === 'user' ||
    value === 'agent' ||
    value === 'cli' ||
    value === 'dashboard' ||
    value === 'system'
  ) {
    return value;
  }
  return fallback;
}

export function updateSessionTitle(
  session: Session,
  rawTitle: unknown,
  source: SessionTitleSource,
): SessionTitleUpdateResult {
  const title = normalizeSessionTitle(rawTitle);
  if (!title) return { ok: false, error: 'bad_title' };

  const updatedAt = new Date().toISOString();
  session.title = title;
  session.titleUpdatedAt = updatedAt;
  session.titleSource = source;
  sessionStore.updateSession(session);
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId: session.sessionId,
      patch: { title, titleUpdatedAt: updatedAt, titleSource: source },
    },
  });
  return { ok: true, title, updatedAt, source };
}
