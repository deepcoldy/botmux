export interface SessionListMarkers {
  suspendedColdResume?: boolean;
  cliId?: unknown;
  lastCliInput?: unknown;
  adoptedFrom?: unknown;
}

export type SessionListDisposition = 'keep' | 'prune_real' | 'prune_scratch';

/**
 * Decide whether `botmux list` may auto-prune a non-adopt session whose
 * process/backing-session probes have already been evaluated by the caller.
 *
 * A cap-suspended session deliberately has neither a process PID nor a backing
 * tmux/herdr/zellij session: that is how its memory is reclaimed. The persisted
 * cold-resume marker is therefore authoritative and must beat the generic
 * zombie heuristic.
 */
export function sessionListDisposition(
  session: SessionListMarkers,
  runtime: { hasPid: boolean; hasBackingSession: boolean },
): SessionListDisposition {
  if (runtime.hasPid || runtime.hasBackingSession) return 'keep';
  if (session.suspendedColdResume === true) return 'keep';
  return session.cliId || session.lastCliInput || session.adoptedFrom
    ? 'prune_real'
    : 'prune_scratch';
}

export function isColdResumeDormant(session: SessionListMarkers): boolean {
  return session.suspendedColdResume === true;
}
