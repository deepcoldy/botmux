import type { Session } from '../types.js';
import type { DaemonSession } from './types.js';

/**
 * A BotMux shared-adopt session has a source conversation that BotMux must not
 * own, migrate, restart, or terminate:
 *
 * - traditional `/adopt`: an external tmux / zellij / Herdr CLI pane;
 * - Codex App `/adopt`: a second official `codex --remote` client attached to
 *   an existing development-machine App Server thread.
 *
 * Both forms intentionally expose a "disconnect BotMux" action rather than a
 * "close/restart the source session" action.
 */
export function isSharedAdoptPersistedSession(
  session: Pick<Session, 'adoptedFrom' | 'existingAppServerEndpoint'>,
): boolean {
  return !!session.adoptedFrom || !!session.existingAppServerEndpoint;
}

/** True when BotMux owns a remote TUI client but does NOT own the App Server
 * behind it. Unlike a traditional adopted tmux pane, that client is safe—and
 * required—to clean up when the BotMux share is disconnected. */
export function isExistingAppServerSharedAdoptPersistedSession(
  session: Pick<Session, 'existingAppServerEndpoint'>,
): boolean {
  return !!session.existingAppServerEndpoint;
}

export function isSharedAdoptSession(
  ds: Pick<DaemonSession, 'session' | 'adoptedFrom' | 'initConfig'>,
): boolean {
  return !!ds.adoptedFrom
    || ds.initConfig?.adoptMode === true
    || isSharedAdoptPersistedSession(ds.session);
}
