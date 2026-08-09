/**
 * Shared helpers for sessions backed by a persistent multiplexer
 * (tmux / herdr / zellij / zmx). These backends keep the CLI alive across worker
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
import { isRemoteBackendId } from './remote-cli-ids.js';
import { TmuxBackend } from '../adapters/backend/tmux-backend.js';
import { HerdrBackend } from '../adapters/backend/herdr-backend.js';
import { ZellijBackend } from '../adapters/backend/zellij-backend.js';
import { ZmxBackend } from '../adapters/backend/zmx-backend.js';
import type { BackendType, PersistentBackendTarget, SessionProbe } from '../adapters/backend/types.js';
import type { DaemonSession } from './types.js';
import type { Session } from '../types.js';

export type PersistentBackendType = Extract<BackendType, 'tmux' | 'herdr' | 'zellij' | 'zmx'>;

/**
 * Decide whether a post-kill probe still blocks a cold replacement.
 *
 * ZMX owns sessions by labels + frozen PID, so an inconclusive confirmation
 * must remain fail-closed. The older mux backends only have best-effort
 * process/session probes: after a successful kill, `unknown` is not proof that
 * the target survived (notably zellij reports zero live sessions with exit 1).
 */
export function shouldRejectPersistentPostKillProbe(
  backendType: PersistentBackendType,
  probe: SessionProbe,
): boolean {
  return probe === 'exists' || (backendType === 'zmx' && probe === 'unknown');
}

export function isSuspendableBackendType(
  backendType: BackendType | undefined,
): backendType is PersistentBackendType {
  return backendType === 'tmux' || backendType === 'herdr' || backendType === 'zellij' || backendType === 'zmx';
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
 * CLIs that are NOT local processes: they have an empty `resolvedBin` and their
 * backend translates write() into remote API / headless-CLI calls. For each of
 * these the cliId and the backendType share a name and must stay paired.
 *
 * Adding a remote CLI means adding it here — the alternative (another
 * hardcoded `=== 'riff'` chain in every helper below) is exactly what made this
 * generalization necessary.
 */
// The set itself now lives in the dependency-free core/remote-cli-ids leaf so
// light consumers (e.g. the Lark card builder) can share it without pulling in
// every PTY backend class through this module.

/** True for a backend that runs the agent off-box (no local PTY to own). */
export function isRemoteBackendType(type: BackendType): boolean {
  return isRemoteBackendId(type);
}

export { isRemoteCliId } from './remote-cli-ids.js';

/**
 * Enforce the `cliId === <remote> ⇔ backendType === <remote>` pairing invariant
 * at the ONE spawn chokepoint, so every config entry point (dashboard, `/config
 * set cli|backendType`, `botmux setup`, hand-edited bots.json) converges:
 *   - a remote CLI on a local backend → force its own backend (a pty/tmux spawn
 *     would fail on the empty resolvedBin);
 *   - a non-remote CLI on a remote backend → fall back to the daemon default
 *     (the CLI's PTY chunked writes would otherwise fan out into remote tasks).
 * Manual pty/tmux/herdr/zellij overrides for local CLIs pass through.
 *
 * NOTE: kept under its historical name `reconcileRiffBackendType` on purpose —
 * it is imported by name in several modules and renaming it would bloat this
 * behaviour-preserving refactor into a cross-cutting rename.
 */
export function reconcileRiffBackendType(
  cliId: string,
  resolved: BackendType,
  defaultType: BackendType,
): BackendType {
  // A remote CLI dictates its own backend (same name by construction).
  if (isRemoteBackendId(cliId)) return cliId as BackendType;
  // defaultType 本身被误配成远端后端时兜底到确定可用的本地后端（pty 无外部依赖）。
  if (isRemoteBackendType(resolved)) {
    return !isRemoteBackendType(defaultType) ? defaultType : 'pty';
  }
  return resolved;
}

/** Resolve the frozen/live/default backend precedence and then enforce the
 * Riff CLI/backend pairing. Keep spawn-time callers on this single helper so
 * worktree push decisions cannot drift from the backend forkWorker will use. */
export function resolvePairedSpawnBackendType(
  cliId: string,
  sessionStamp: BackendType | undefined,
  botType: BackendType | undefined,
  defaultType: BackendType,
): BackendType {
  return reconcileRiffBackendType(
    cliId,
    resolveSpawnBackendType(sessionStamp, botType, defaultType),
    defaultType,
  );
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
  // 远端后端（riff / mojo）：远端会话独立于本地进程存活。daemon shutdown 走
  // 'close' 会经 worker 的 destroySession() 取消远端会话——重启不该杀它（血缘已
  // 持久化，重启后 follow-up 续上，agent 的 botmux send 照常送达）。
  // detach = 仅 SIGTERM worker。
  const frozen = ds.initConfig?.backendType ?? ds.session.backendType;
  if (frozen && isRemoteBackendType(frozen)) return 'detach';
  return getSessionPersistentBackendType(ds) ? 'detach' : 'close';
}

/** Deterministic backing-session name (`bmx-<sid8>`, same rule across backends). */
export function persistentSessionName(backendType: PersistentBackendType, sessionId: string): string {
  if (backendType === 'tmux') return TmuxBackend.sessionName(sessionId);
  if (backendType === 'zellij') return ZellijBackend.sessionName(sessionId);
  if (backendType === 'zmx') return ZmxBackend.sessionName(sessionId);
  return HerdrBackend.sessionName(sessionId);
}

/**
 * Resolve the exact backing resource for daemon lifecycle work. The persisted
 * worker-selected target wins only when it still matches the frozen backend;
 * legacy rows fall back to the historical deterministic whole-session target.
 */
export function resolvePersistentBackendTarget(
  backendType: PersistentBackendType,
  sessionId: string,
  persisted?: PersistentBackendTarget,
): PersistentBackendTarget {
  if (persisted?.backendType === backendType && persisted.sessionName.trim()) {
    if (persisted.backendType !== 'herdr' || persisted.agentName === undefined || persisted.agentName.trim()) {
      return persisted;
    }
  }
  return { backendType, sessionName: persistentSessionName(backendType, sessionId) };
}

export function persistentBackendTargetForSession(ds: DaemonSession): PersistentBackendTarget | undefined {
  const backendType = getSessionPersistentBackendType(ds);
  if (!backendType) return undefined;
  return resolvePersistentBackendTarget(
    backendType,
    ds.session.sessionId,
    ds.session.persistentBackendTarget,
  );
}

/** Exact managed resources to remove when a single-bot CLI changes.
 * Adopted panes are user-owned; machine-wide Herdr agents must be returned as
 * agent-scoped targets rather than collapsing to the shared host session. */
export function managedTargetsForCliChange(
  backendType: PersistentBackendType,
  sessions: readonly Pick<Session, 'sessionId' | 'adoptedFrom' | 'persistentBackendTarget'>[],
): PersistentBackendTarget[] {
  return sessions
    .filter(session => !session.adoptedFrom)
    .map(session => resolvePersistentBackendTarget(
      backendType,
      session.sessionId,
      session.persistentBackendTarget,
    ));
}

export function probePersistentBackendTarget(target: PersistentBackendTarget): SessionProbe {
  if (target.backendType === 'herdr' && target.agentName) {
    return HerdrBackend.probeAgent(target.sessionName, target.agentName);
  }
  return probePersistentSession(target.backendType, target.sessionName);
}

/**
 * `sessionId` is REQUIRED for ZMX: its destruction is identity-verified against
 * the botmux labels stamped on the session, and `killPersistentSession` refuses
 * a name-only ZMX kill rather than risk destroying a same-named user session.
 * Callers that hold the owning session must always pass it through.
 */
export function killPersistentBackendTarget(
  target: PersistentBackendTarget,
  sessionId?: string,
): void {
  if (target.backendType === 'herdr' && target.agentName) {
    HerdrBackend.killAgent(target.sessionName, target.agentName);
    return;
  }
  killPersistentSession(target.backendType, target.sessionName, sessionId);
}

export function probePersistentSession(backendType: PersistentBackendType, name: string): SessionProbe {
  if (backendType === 'tmux') return TmuxBackend.probeSession(name);
  if (backendType === 'zellij') return ZellijBackend.probeSession(name);
  if (backendType === 'zmx') return ZmxBackend.probeSession(name);
  return HerdrBackend.probeSession(name);
}

/**
 * Take one liveness snapshot for a set of backing-session names.
 *
 * ZMX and Zellij expose all session states in one command, so probing each row
 * separately would repeatedly scan the same control plane (and makes `botmux
 * list` quadratic for ZMX). tmux and Herdr keep their established per-session
 * probes, but duplicate names are still coalesced here.
 */
export function probePersistentSessions(
  backendType: PersistentBackendType,
  names: Iterable<string>,
): ReadonlyMap<string, SessionProbe> {
  const uniqueNames = [...new Set(names)];
  const result = new Map<string, SessionProbe>();

  if (backendType === 'zmx') {
    const snapshot = ZmxBackend.probeSessions();
    for (const name of uniqueNames) {
      result.set(
        name,
        !snapshot.ok
          ? 'unknown'
          : snapshot.sessions.includes(name)
            ? 'exists'
            : snapshot.unhealthySessions.includes(name)
              ? 'unknown'
              : 'missing',
      );
    }
    return result;
  }

  if (backendType === 'zellij') {
    const snapshot = ZellijBackend.probeLiveSessions();
    for (const name of uniqueNames) {
      result.set(name, !snapshot.ok ? 'unknown' : snapshot.sessions.includes(name) ? 'exists' : 'missing');
    }
    return result;
  }

  for (const name of uniqueNames) {
    result.set(name, probePersistentSession(backendType, name));
  }
  return result;
}

/**
 * Kill a backing session. ZMX additionally requires the complete botmux UUID:
 * its public name contains only eight UUID characters, so name-only deletion
 * could destroy a different session after a prefix collision.
 */
export function killPersistentSession(
  backendType: PersistentBackendType,
  name: string,
  sessionId?: string,
): void {
  if (backendType === 'tmux') TmuxBackend.killSession(name);
  else if (backendType === 'zellij') ZellijBackend.killSession(name);
  else if (backendType === 'zmx') {
    if (!sessionId) throw new Error(`refusing name-only ZMX kill for ${name}`);
    ZmxBackend.killManagedSession(name, sessionId);
  }
  else HerdrBackend.killSession(name);
}
