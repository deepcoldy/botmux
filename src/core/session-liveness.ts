/**
 * Shared "is this session a stopped zombie?" predicate — the same notion the
 * `botmux delete stopped` CLI subcommand uses (dead CLI process + no exact
 * persistent backing), factored out so the host-overload alert's "清僵尸"
 * button can reuse the exact semantics server-side without duplicating (or
 * drifting from) the CLI logic.
 *
 * A zombie = a session the store still marks `active`, but whose CLI process is
 * gone and has no recoverable backing target — i.e. nothing is actually
 * running, it's just a stale record holding a slot. Intentionally-suspended sessions are NOT
 * zombies: they're worker-less on purpose and cold-resume on the next message.
 * botmux's own cap-suspend deliberately clears the pid AND destroys the backing
 * CLI/backend (that's how it reclaims memory), so the pid/backend probe alone can't
 * tell such a session apart from a true zombie — it would classify the just-
 * suspended session as stopped and let the sweep permanently close it. The
 * persisted `suspendedColdResume` marker is therefore authoritative and short-
 * circuits to "not stopped", matching the CLI `list` prune guard
 * (session-list-liveness.ts). Callers still gate on `status === 'active'`.
 */
import { execFileSync } from 'node:child_process';
import type { Session } from '../types.js';
import {
  isSuspendableBackendType,
  probePersistentBackendTarget,
  resolvePersistentBackendTarget,
} from './persistent-backend.js';

/** Liveness check for an arbitrary pid without signalling it (signal 0). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM = exists but not ours to signal (still alive); ESRCH = gone.
    return err?.code === 'EPERM';
  }
}

/** True when a `bmx-<prefix>` legacy tmux session exists. Best-effort; tmux missing
 *  or any error → treated as "no pane". */
export function tmuxSessionExists(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function adoptedCliPid(s: Session): number | undefined {
  const pid = s.adoptedFrom && typeof s.adoptedFrom === 'object'
    ? (s.adoptedFrom as { originalCliPid?: number }).originalCliPid
    : undefined;
  return typeof pid === 'number' && pid > 0 ? pid : undefined;
}

/**
 * True when a session record is a stopped zombie: no live CLI process and no
 * recoverable backing target. Mirrors cli.ts `delete stopped`. For adopted
 * sessions the original CLI pid is authoritative (we never spawned a botmux
 * worker); for normal sessions, both the recorded worker pid and the exact
 * persisted backend target must be gone. Caller is responsible for the
 * `status === 'active'` gate.
 */
export function isSessionStopped(s: Session): boolean {
  // botmux cap-suspended a session on purpose: pid cleared + backing CLI/tmux
  // destroyed, cold-resumes on the next message. The marker beats the generic
  // zombie heuristic so the "清僵尸" sweep can't permanently close it.
  if (s.suspendedColdResume === true) return false;
  const originalPid = adoptedCliPid(s);
  if (originalPid !== undefined) {
    return !isProcessAlive(originalPid);
  }
  // A live worker pid alone proves the session isn't a zombie — short-circuit
  // before touching tmux so the (synchronous, up-to-3s) tmux probe only ever
  // runs for sessions whose pid is already dead. Keeps counts/sweep from
  // spawning a tmux child per live session and stalling the daemon loop.
  if (s.pid && isProcessAlive(s.pid)) return false;

  // Remote Riff tasks have no local worker/backing process to prove dead.
  // ZMX likewise owns one independent daemon per session: a missing backing
  // daemon can mean a normal process/host restart, and the transcript-backed
  // row remains recoverable by a lazy cold-resume. Neither backend is safe to
  // permanently close from this local zombie heuristic.
  if (s.backendType === 'riff' || s.backendType === 'zmx') return false;
  if (s.backendType === 'pty') return true;

  // Rows created before backend stamping used tmux as their only externally
  // recoverable backing. Preserve that compatibility probe.
  if (s.backendType === undefined) {
    return !tmuxSessionExists(`bmx-${s.sessionId.substring(0, 8)}`);
  }

  if (!isSuspendableBackendType(s.backendType)) return true;
  const target = resolvePersistentBackendTarget(
    s.backendType,
    s.sessionId,
    s.persistentBackendTarget,
  );
  // Only positive absence is safe to sweep. A transient backend/control-plane
  // failure must not turn a live persistent CLI into a destructive "zombie".
  return probePersistentBackendTarget(target) === 'missing';
}
