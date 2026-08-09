export interface SessionListMarkers {
  suspendedColdResume?: boolean;
  cliId?: unknown;
  lastCliInput?: unknown;
  adoptedFrom?: unknown;
  codexAppDispatchLedger?: readonly unknown[];
}

export type SessionListDisposition = 'keep' | 'prune_scratch';

/**
 * A "real" managed session is one that ever ran a CLI (frozen `cliId`), took a
 * turn (`lastCliInput`), or adopted a foreign process (`adoptedFrom`). Its CLI
 * transcript on disk is resumable, so the daemon can always cold-resume it and,
 * if the transcript is genuinely gone, fall back to a fresh session with a
 * user-visible notice — never a dead end. A row with none of these markers
 * never became a real CLI session (an unconfirmed /adopt picker, /help, an
 * abandoned /relay picker): it is a disposable scratch, safe to prune silently.
 */
export function isRealManagedSession(session: SessionListMarkers): boolean {
  return !!(session.cliId || session.lastCliInput || session.adoptedFrom);
}

/**
 * Decide whether `botmux list` may auto-prune a non-adopt session whose
 * process/backing-session probes have already been evaluated by the caller.
 *
 * The invariant (shared with the server-side `isSessionStopped` sweep): a
 * missing pid/backing is NEVER, on its own, grounds to permanently close a real
 * managed session. Whether the CLI process merely exited, the idle-worker
 * sweeper reclaimed it (cap-suspend), or a whole-host reboot wiped every backing
 * pane at once, the on-disk transcript is still resumable — so the row is kept
 * dormant and cold-resumes on the next message. `list` is a READ command and
 * must not double as a destructive sweep that undoes what restore just kept.
 *
 * Only two things are pruned: a deliberate cap-suspension is redundant to keep
 * distinct here (already `keep` via the marker below), and a disposable scratch
 * that never became a real CLI session is closed silently. Explicit teardown
 * (`botmux delete <id>` / `delete stopped` / `/close`) is a separate, intended
 * path and is unaffected.
 */
export function sessionListDisposition(
  session: SessionListMarkers,
  runtime: { hasPid: boolean; hasBackingSession: boolean },
): SessionListDisposition {
  if (runtime.hasPid || runtime.hasBackingSession) return 'keep';
  if (session.suspendedColdResume === true) return 'keep';
  // PR #597: a Codex App session with an in-flight dispatch ledger is kept even
  // before it qualifies as a "real managed" session below — the accepted→
  // prepared→settled FIFO is the authoritative in-flight-turn signal and must
  // beat the generic prune so a mid-dispatch owner is never abandoned.
  if ((session.codexAppDispatchLedger?.length ?? 0) > 0) return 'keep';
  // A real managed session with neither a live pid nor a surviving backing pane
  // is dormant, not a zombie: keep it for lazy cold-resume instead of pruning.
  // This is the host-reboot fix — `restoreActiveSessions` keeps these rows, and
  // a subsequent `botmux list` must not re-close them (the co-tenant-poisoned
  // "is the backing gone?" signal is no longer a close trigger anywhere).
  if (isRealManagedSession(session)) return 'keep';
  return 'prune_scratch';
}

export function isColdResumeDormant(session: SessionListMarkers): boolean {
  return session.suspendedColdResume === true;
}
