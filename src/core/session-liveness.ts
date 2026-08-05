/**
 * Shared "is this session a stopped zombie?" predicate — the same notion the
 * `botmux delete stopped` CLI subcommand and the host-overload "清僵尸" button
 * use, factored out so they can't drift apart.
 *
 * The invariant (shared with `botmux list`'s auto-prune, see
 * cli/session-list-liveness.ts): a missing pid/backing is NEVER, on its own,
 * grounds to permanently close a REAL managed session. A real managed session
 * (one that ever ran a CLI, took a turn, or adopted a process) has a resumable
 * CLI transcript on disk, so whatever removed its live process — a plain CLI
 * exit, botmux's own idle-worker cap-suspend, or a whole-host reboot that wiped
 * every multiplexer pane at once — the next message cold-resumes it (and if the
 * transcript is genuinely gone, the worker's resume→fresh fallback spawns a
 * clean session with a user-visible notice). It is dormant, not a zombie.
 *
 * A zombie here is therefore only a DISPOSABLE SCRATCH: a row that never became
 * a real CLI session (an unconfirmed /adopt picker, /help, an abandoned /relay
 * picker) and now has no live process. Adopted sessions are the one case whose
 * external pid is authoritative — we never spawned a botmux worker and hold no
 * transcript of our own, so a dead adopted pid IS a real stop.
 *
 * Why we no longer probe the multiplexer backing: botmux shares the default
 * tmux socket with the operator's own terminal, so a co-tenant reviving the
 * server made a reboot read as N solo zombies → 239 live sessions mass-closed
 * after a single reboot. The transcript on disk — not a co-tenant-poisoned
 * "is the pane alive?" probe — is the authoritative recoverability signal.
 *
 * Callers still gate on `status === 'active'`.
 */
import type { Session } from '../types.js';
import { isRealManagedSession } from '../cli/session-list-liveness.js';

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

function adoptedCliPid(s: Session): number | undefined {
  const pid = s.adoptedFrom && typeof s.adoptedFrom === 'object'
    ? (s.adoptedFrom as { originalCliPid?: number }).originalCliPid
    : undefined;
  return typeof pid === 'number' && pid > 0 ? pid : undefined;
}

/**
 * True when a session record is a stopped zombie: no live process AND it is not
 * a real managed session that could cold-resume. See the module doc for the
 * full rationale. For adopted sessions the original CLI pid is authoritative
 * (we never spawned a botmux worker). Caller is responsible for the
 * `status === 'active'` gate.
 */
export function isSessionStopped(s: Session): boolean {
  // Adopt: the wrapped foreign CLI's own pid is authoritative — we hold no
  // transcript of our own to resume, so a dead adopted pid IS a real stop.
  const originalPid = adoptedCliPid(s);
  if (originalPid !== undefined) {
    return !isProcessAlive(originalPid);
  }
  // A live worker pid alone proves the session isn't a zombie.
  if (s.pid && isProcessAlive(s.pid)) return false;
  // botmux cap-suspended a session on purpose (pid cleared + backing destroyed
  // to reclaim memory): the marker beats the heuristic. Subsumed by the
  // real-managed check below, but kept explicit as the authoritative signal.
  if (s.suspendedColdResume === true) return false;
  // No live process. A real managed session is dormant-recoverable (transcript
  // on disk), NOT a closeable zombie — regardless of backend or whether its
  // multiplexer pane survived. Only a scratch that never became a real CLI
  // session is a true stop. This is the host-reboot fix: `restoreActiveSessions`
  // keeps these rows, and the sweep must not re-close them.
  return !isRealManagedSession(s);
}
