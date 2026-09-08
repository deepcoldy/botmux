/**
 * The single row-level apply for session commands.
 *
 * A session row changes only by having a command applied to it, and every
 * host applies a command the same way: the owning daemon on its in-memory row
 * (`session-store.closeSession`, the `/whiteboard` IPC route), and a host CLI
 * or the dashboard process on the durable row while no daemon holds the store
 * (`session-store.applySessionCommandUnowned` behind
 * `session-command-host.ts`). There is no second field list anywhere else.
 *
 * `applySessionRowCommand` performs no filesystem, process or network access:
 * every I/O-derived input (the close-time token snapshot) arrives on the
 * command. It runs inside the store's `BEGIN IMMEDIATE` / file lock on the
 * unowned path, so anything it does is lock-hold time — keep it O(row).
 *
 * Daemon-only close options (`tokenUsage`, `parkMojoLineage`,
 * `parkLocalResidual`, `clearRiffParentTaskId`, `clearMojoCloseJournal`) are
 * typed away from hosts via {@link HostSessionCommand}: a host cannot prove a
 * remote cancel or sample a transcript it may not be able to resolve, so it
 * cannot name the actions that depend on either.
 *
 * Design: docs/design/2026-08-12-session-restage-store-first.md §1, §3 Stage 2.
 */
import { hasProtectedSessionMutationOwnership } from '../core/session-mutation-guard.js';
import type { LarkAttachment, Session } from '../types.js';

/** Close inputs only the owning daemon can produce. */
type DaemonCloseOptions = {
  /**
   * Close-time token snapshot, sampled by the caller BEFORE the write (the
   * daemon's transcript scan, never run under the store lock). Omit to leave
   * the row's field untouched — a host that cannot resolve the transcript must
   * not pin a permanent `null` the dashboard would then trust over a live read.
   * `null` = sampled, nothing found: writes `null` only when the row carries no
   * snapshot yet.
   */
  tokenUsage?: NonNullable<Session['tokenUsage']> | null;
  /**
   * Park an uncancellable mojo lineage as PART of this transition. Merged here,
   * against the row being committed, so "closed + parked" is atomic.
   */
  parkMojoLineage?: string;
  /**
   * Park a LOCAL-subtree residual as PART of this transition, so an idempotent
   * re-close of the already-closed row still reports `closed_with_residual`.
   */
  parkLocalResidual?: Session['mojoLocalResidual'];
  /** Riff cancellation completed before this transition; drop its retry handle. */
  clearRiffParentTaskId?: boolean;
  /**
   * Wipe the mojo cancellation journal. Only the daemon's own store close —
   * after its explicit prepare has resolved the journal into a park — may name
   * it; every other close keeps the fence on the closed row.
   */
  clearMojoCloseJournal?: boolean;
};

export type SessionCloseCommand = { type: 'close' } & DaemonCloseOptions;
/** Close only when the row owns no work an ordinary mutation may abandon. */
export type SessionPruneCommand = { type: 'prune' };
/** Bind (`string`) or unbind (`null`) the session's whiteboard, optionally
 *  compare-and-set against the binding the caller observed. */
export type SessionWhiteboardCommand = {
  type: 'whiteboard';
  whiteboardId: string | null;
  expectWhiteboardId?: string;
};
/** Record that the exact worker `pid` is gone (offline abandon checkpoint). */
export type SessionWorkerExitedCommand = { type: 'worker-exited'; pid: number };

export type SessionRowCommand =
  | SessionCloseCommand
  | SessionPruneCommand
  | SessionWhiteboardCommand
  | SessionWorkerExitedCommand;

/** The commands a non-owning host may apply: the daemon-only close inputs are
 *  typed out (`never`), so a host cannot pass them even from a wider value. */
export type HostSessionCommand =
  | ({ type: 'close' } & { [K in keyof DaemonCloseOptions]?: never })
  | SessionPruneCommand
  | SessionWhiteboardCommand
  | SessionWorkerExitedCommand;

type Assert<T extends true> = T;
/** Compile-time proof of the host boundary (checked by the build's `tsc`):
 *  a daemon close command must never be assignable to a host command, so no
 *  daemon-only option can become nameable by a host. Widening
 *  `HostSessionCommand` turns this into a TS2344 error. */
type _HostCloseCannotNameDaemonOptions =
  Assert<SessionCloseCommand extends HostSessionCommand ? false : true>;

export type SessionRowRefusal =
  /** prune: the row still owns a dispatch/activation/setup an ordinary mutation may not abandon. */
  | 'protected_ownership'
  /** whiteboard: `expectWhiteboardId` no longer matches the row. */
  | 'whiteboard_changed'
  /** worker-exited: the row's pid is not the one that exited. */
  | 'worker_changed';

/** Handles a close erased from the row; the caller owns their cleanup once the
 *  row is committed (the daemon and the host both delete the materialised
 *  dashboard images, the same way, after their respective commits). */
export type SessionRowReleased = {
  dashboardAttachments?: LarkAttachment[];
};

export type SessionRowCommandResult =
  | { outcome: 'applied'; released: SessionRowReleased }
  /** Already in the commanded state (a closed row, an identical binding). */
  | { outcome: 'noop' }
  | { outcome: 'refused'; reason: SessionRowRefusal };

/**
 * Apply `command` to `row` IN PLACE. Returns whether anything changed; the
 * caller persists the row (and merges it back into any live alias) only on
 * `applied`. A re-applied close never refreshes `closedAt`. A host close of an
 * already-closed row with no leftover runtime fields is `noop`; daemon-only
 * parks / journal wipe still apply when they change the row (a concurrent
 * second close that lost the status race must not drop a residual).
 */
export function applySessionRowCommand(
  row: Session,
  command: SessionRowCommand,
  ctx: { now: Date },
): SessionRowCommandResult {
  switch (command.type) {
    case 'close':
      return applyClose(row, command, ctx.now);
    case 'prune':
      if (row.status === 'closed') return { outcome: 'noop' };
      if (hasProtectedSessionMutationOwnership(row)) {
        return { outcome: 'refused', reason: 'protected_ownership' };
      }
      return applyClose(row, { type: 'close' }, ctx.now);
    case 'whiteboard': {
      if (command.expectWhiteboardId !== undefined
          && row.whiteboardId !== command.expectWhiteboardId) {
        return { outcome: 'refused', reason: 'whiteboard_changed' };
      }
      const next = command.whiteboardId ?? undefined;
      if (row.whiteboardId === next) return { outcome: 'noop' };
      row.whiteboardId = next;
      return { outcome: 'applied', released: {} };
    }
    case 'worker-exited':
      if (row.pid !== command.pid) return { outcome: 'refused', reason: 'worker_changed' };
      row.pid = undefined;
      return { outcome: 'applied', released: {} };
  }
}

function applyClose(row: Session, command: SessionCloseCommand, now: Date): SessionRowCommandResult {
  const alreadyClosed = row.status === 'closed';
  let changed = false;
  // The materialised images are cleaned up AFTER the row commits, so the list
  // is handed back before it is dropped from the row.
  const released: SessionRowReleased = {};

  if (!alreadyClosed) {
    if (row.dashboardAttachments?.length) {
      released.dashboardAttachments = row.dashboardAttachments;
    }
    row.status = 'closed';
    row.closedAt = now.toISOString();
    if (command.tokenUsage !== undefined) {
      if (command.tokenUsage !== null) row.tokenUsage = command.tokenUsage;
      else if (row.tokenUsage === undefined) row.tokenUsage = null;
    }
    row.dashboardAttachments = undefined;
    row.queuedAttachments = undefined;
    changed = true;
  } else if (row.dashboardAttachments?.length) {
    // A row closed by an older build can still carry leftover images; re-close
    // must not refresh closedAt, but the caller still needs the list to delete
    // the directory.
    released.dashboardAttachments = row.dashboardAttachments;
    row.dashboardAttachments = undefined;
    changed = true;
  }
  if (alreadyClosed && row.queuedAttachments !== undefined) {
    row.queuedAttachments = undefined;
    changed = true;
  }

  // `previewTarget` is a live loopback (host, port) the session's agent
  // registered with `botmux preview <port>` for its CURRENT worker generation —
  // routing state, not a durable property of the conversation. A closed
  // session owns no port any more, and the OS is free to hand that number to
  // an unrelated local server; the preview proxy dials a target by host/port
  // alone, so a retained value would let a later reader (resume, an offline
  // row copy, a dashboard snapshot) proxy the user into someone else's
  // service. Drop it on every close, including re-close of a legacy closed row.
  if (row.previewTarget !== undefined) {
    row.previewTarget = undefined;
    changed = true;
  }

  if (command.clearMojoCloseJournal && row.mojoCloseJournal !== undefined) {
    row.mojoCloseJournal = undefined;
    changed = true;
  }
  // Survives close on purpose — the containment handle is still in the durable
  // store, so the row must keep reporting the residual until the handle clears.
  if (command.parkLocalResidual && row.mojoLocalResidual !== command.parkLocalResidual) {
    row.mojoLocalResidual = command.parkLocalResidual;
    changed = true;
  }
  if (command.parkMojoLineage) {
    // Keep both ids when a different one was already parked: each is the only
    // handle left for manual cleanup of its remote session.
    const already = row.mojoQuarantinedLineage;
    const next = already && already !== command.parkMojoLineage
      ? `${already},${command.parkMojoLineage}`
      : command.parkMojoLineage;
    if (next !== already) {
      row.mojoQuarantinedLineage = next;
      row.mojoQuarantineNoticePending = true;
      changed = true;
    }
  }
  // Riff cancellation has already completed before this durable transition.
  // Clear its retry handle in the same atomic save as status='closed'.
  if (command.clearRiffParentTaskId && row.riffParentTaskId !== undefined) {
    row.riffParentTaskId = undefined;
    changed = true;
  }

  if (!changed) return { outcome: 'noop' };
  return { outcome: 'applied', released };
}
