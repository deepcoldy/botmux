/**
 * Which of THIS daemon's live sessions may be suspended so the botmux tmux
 * server can empty out and be replaced by the upgraded binary.
 *
 * A tmux server only picks up a new binary when it is recreated, and it exits
 * by itself once its last session is gone. Suspending a session is the
 * existing, non-destructive way to take it off the server: the CLI stops, the
 * conversation is kept, and the next message resumes it on whatever server
 * `new-session` reaches — the new one, once the old server has emptied.
 *
 * Selection is exactly the strict idle selector the overload card and
 * `botmux suspend --idle` already use (never mid-turn, never with queued or
 * unsettled input, background tasks, keep-alives, locks, adopts, …), narrowed
 * to tmux sessions on the one server being replaced.
 */
import type { DaemonSession } from './types.js';
import { selectIdleSuspendCandidates, type IdleSuspendCandidate } from './idle-worker-sweeper.js';
import { persistentBackendTargetForSession } from './persistent-backend.js';

/** True when the session's frozen tmux target is the server named `socketName`
 *  (`undefined` = the default server). */
export function sessionOnTmuxSocket(ds: DaemonSession, socketName: string | undefined): boolean {
  const target = persistentBackendTargetForSession(ds);
  if (!target || target.backendType !== 'tmux') return false;
  return (target.socketName ?? undefined) === socketName;
}

export function selectTmuxSwitchCandidates(
  registry: Map<string, DaemonSession>,
  opts: { socketName: string | undefined; olderThanMs: number; now?: number },
): IdleSuspendCandidate[] {
  const bySessionId = new Map<string, DaemonSession>();
  for (const ds of registry.values()) bySessionId.set(ds.session.sessionId, ds);
  return selectIdleSuspendCandidates(registry, { olderThanMs: opts.olderThanMs, now: opts.now ?? Date.now() })
    .filter(candidate => {
      const ds = bySessionId.get(candidate.sessionId);
      return !!ds && candidate.backendType === 'tmux' && sessionOnTmuxSocket(ds, opts.socketName);
    });
}

/** Wire shape of `POST /api/tmux-upgrade/suspend-idle`. */
export interface TmuxSwitchSuspendRequest {
  /** null = default server. */
  socketName: string | null;
  olderThanMs: number;
  dryRun: boolean;
}

export function parseTmuxSwitchSuspendRequest(body: unknown): TmuxSwitchSuspendRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const socketName = b.socketName === null ? null
    : typeof b.socketName === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(b.socketName) ? b.socketName
      : undefined;
  if (socketName === undefined) return null;
  const olderThanMs = typeof b.olderThanMs === 'number' && Number.isFinite(b.olderThanMs) && b.olderThanMs >= 1
    ? Math.floor(b.olderThanMs)
    : null;
  if (olderThanMs === null) return null;
  if (typeof b.dryRun !== 'boolean') return null;
  return { socketName, olderThanMs, dryRun: b.dryRun };
}
