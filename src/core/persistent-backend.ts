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
 * Resolve which persistent backend (if any) backs a session.
 *
 * Precedence, most authoritative first:
 *   1. `ds.initConfig?.backendType` — the live worker's resolved backend this run.
 *   2. `ds.session.backendType` — the backend stamped on the persisted session
 *      at spawn time (survives daemon restart; see Session.backendType).
 *   3. An explicit per-bot `backendType` — authoritative even for legacy
 *      sessions, since the bot's choice didn't change across the PTY退役 flip.
 *
 * If NONE of those resolve, the session predates backendType stamping AND its
 * bot pins no backend, so it ran on the OLD probe-based daemon default — which
 * could have been PTY on a tmux-less host. We deliberately do NOT fall back to
 * the current `config.daemon.backendType` (now always tmux): doing so would
 * make `restoreActiveSessions` probe for a `bmx-<sid>` pane that never existed,
 * find it 'missing', and zombie-close a perfectly recoverable session. Treating
 * it as non-persistent keeps the worker-less active record for lazy resume; a
 * genuinely surviving tmux pane still reattaches lazily on the next message
 * (and gets stamped then).
 */
export function getSessionPersistentBackendType(ds: DaemonSession): PersistentBackendType | undefined {
  let backendType: BackendType | undefined = ds.initConfig?.backendType ?? ds.session.backendType;
  if (!backendType) {
    try {
      backendType = getBot(ds.larkAppId).config.backendType;
    } catch { /* bot deregistered */ }
  }
  return isSuspendableBackendType(backendType) ? backendType : undefined;
}

/**
 * Freeze-once backend resolution for a forkWorker spawn. An already-running
 * session keeps the backend stamped at its FIRST spawn (`sessionStamp`); only a
 * brand-new session (no stamp) resolves from the bot's live config, then the
 * daemon default. worker-pool's forkWorker calls this so a live dashboard
 * backendType edit only affects NEW sessions and never re-derives a running
 * session onto a different backend (which would strand its persistent pane).
 */
export function resolveSpawnBackendType(
  sessionStamp: BackendType | undefined,
  botType: BackendType | undefined,
  defaultType: BackendType,
): BackendType {
  return sessionStamp ?? botType ?? defaultType;
}

/**
 * Enforce the `cliId === 'riff' ⇔ backendType === 'riff'` pairing invariant at
 * the ONE spawn chokepoint, so every config entry point (dashboard, `/config
 * set cli|backendType`, `botmux setup`, hand-edited bots.json) converges:
 *   - riff CLI on a local backend → force 'riff' (a pty/tmux spawn would fail
 *     on the empty resolvedBin);
 *   - non-riff CLI on the riff backend → fall back to the daemon default (the
 *     CLI's PTY chunked writes would otherwise fan out into riff tasks).
 * Manual pty/tmux/herdr/zellij overrides for non-riff CLIs pass through.
 */
export function reconcileRiffBackendType(
  cliId: string,
  resolved: BackendType,
  defaultType: BackendType,
): BackendType {
  if (cliId === 'riff') return 'riff';
  // defaultType 本身被误配成 riff 时兜底到确定可用的本地后端（pty 无外部依赖）。
  if (resolved === 'riff') return defaultType !== 'riff' ? defaultType : 'pty';
  return resolved;
}

/**
 * How a session's worker is torn down at daemon shutdown, branched on the
 * session's FROZEN backend (via getSessionPersistentBackendType), NOT live config:
 *   'detach' — persistent backend (tmux/herdr/zellij): SIGTERM the worker only,
 *              leaving the multiplexer session alive for re-attach.
 *   'close'  — non-persistent (frozen pty, or unresolvable legacy): killWorker.
 * Freezing here stops a live backendType edit from changing how a running session
 * tears down — e.g. detach-preserving a "herdr" session whose real pane is tmux.
 */
export function shutdownBackendDisposition(ds: DaemonSession): 'detach' | 'close' {
  // riff：远端任务独立于本地进程存活。daemon shutdown 走 'close' 会经 worker 的
  // destroySession() 取消远端任务——重启不该杀任务（血缘已持久化，重启后
  // follow-up 续上，agent 的 botmux send 照常送达）。detach = 仅 SIGTERM worker。
  const frozen = ds.initConfig?.backendType ?? ds.session.backendType;
  if (frozen === 'riff') return 'detach';
  return getSessionPersistentBackendType(ds) ? 'detach' : 'close';
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

/**
 * Tri-state liveness of the backend's multiplexer SERVER itself (not one
 * session). The restore path consults this when a session probes 'missing' to
 * tell apart a true solo zombie (server up, this one pane gone → close) from a
 * machine reboot (server gone, every pane wiped at once → keep for lazy resume,
 * since the CLI transcript on disk is still resumable). See
 * TmuxBackend.serverState for the full rationale.
 *
 * herdr has no cheap server-liveness probe, so it returns 'unknown' →
 * the restore gate falls back to the prior (close-on-missing) behaviour for it.
 */
export function probePersistentBackendServer(
  backendType: PersistentBackendType,
): 'running' | 'down' | 'unknown' {
  if (backendType === 'tmux') return TmuxBackend.serverState();
  if (backendType === 'zellij') return ZellijBackend.serverState();
  return 'unknown';
}

/** Kill a backing session (each backend's killSession is a no-op when absent). */
export function killPersistentSession(backendType: PersistentBackendType, name: string): void {
  if (backendType === 'tmux') TmuxBackend.killSession(name);
  else if (backendType === 'zellij') ZellijBackend.killSession(name);
  else HerdrBackend.killSession(name);
}
