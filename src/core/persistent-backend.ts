/**
 * Shared helpers for sessions backed by a persistent multiplexer
 * (tmux / herdr / zellij). These backends keep the CLI alive across worker
 * exits BY DESIGN (idle-suspend, lazy restore), so several daemon paths must
 * resolve / name / probe / kill the backing session WITHOUT a live worker:
 * the restore-time zombie sweep and terminal wake (session-manager.ts), and
 * the /close teardown of orphaned sessions (worker-pool.ts killWorker).
 *
 * This module owns the backend dispatch so those paths can't drift apart.
 * It must stay dependency-light (backends + registry + config only) — both
 * worker-pool and session-manager import it, and those two already form an
 * import cycle with each other.
 */
import { config } from '../config.js';
import { getBot } from '../bot-registry.js';
import { TmuxBackend } from '../adapters/backend/tmux-backend.js';
import { HerdrBackend } from '../adapters/backend/herdr-backend.js';
import { ZellijBackend } from '../adapters/backend/zellij-backend.js';
import type { BackendType, SessionProbe } from '../adapters/backend/types.js';
import type { DaemonSession } from './types.js';

export type PersistentBackendType = Exclude<BackendType, 'pty'>;

export function isSuspendableBackendType(
  backendType: BackendType | undefined,
): backendType is PersistentBackendType {
  return backendType === 'tmux' || backendType === 'herdr' || backendType === 'zellij';
}

/**
 * Resolve which persistent backend (if any) backs a session: prefer the
 * worker's stored init config — the per-session truth captured at spawn time,
 * which survives idle-suspend and tracks bot-config drift — then the bot
 * config, then the daemon default (covers lazy-restored sessions that never
 * forked a worker, where initConfig is unset).
 */
export function getSessionPersistentBackendType(ds: DaemonSession): PersistentBackendType | undefined {
  let backendType: BackendType | undefined = ds.initConfig?.backendType;
  if (!backendType) {
    backendType = config.daemon.backendType;
    try {
      backendType = getBot(ds.larkAppId).config.backendType ?? backendType;
    } catch { /* bot deregistered — keep daemon default */ }
  }
  return isSuspendableBackendType(backendType) ? backendType : undefined;
}

/** Deterministic backing-session name (`bmx-<sid8>`, same rule across backends). */
export function persistentSessionName(backendType: PersistentBackendType, sessionId: string): string {
  if (backendType === 'tmux') return TmuxBackend.sessionName(sessionId);
  if (backendType === 'zellij') return ZellijBackend.sessionName(sessionId);
  return HerdrBackend.sessionName(sessionId);
}

export function probePersistentSession(backendType: PersistentBackendType, name: string): SessionProbe {
  if (backendType === 'tmux') return TmuxBackend.probeSession(name);
  if (backendType === 'zellij') return ZellijBackend.probeSession(name);
  return HerdrBackend.probeSession(name);
}

/** Kill a backing session (each backend's killSession is a no-op when absent). */
export function killPersistentSession(backendType: PersistentBackendType, name: string): void {
  if (backendType === 'tmux') TmuxBackend.killSession(name);
  else if (backendType === 'zellij') ZellijBackend.killSession(name);
  else HerdrBackend.killSession(name);
}
