/**
 * Decisions behind the failure card's "purge tiny images and continue" action,
 * kept free of worker state so every branch is testable.
 *
 * The action has two phases with different failure contracts:
 *  1. Before anything is torn down (`planPurgeRequest`): any reason not to
 *     proceed declines the click — the CLI keeps running, nothing restarts, and
 *     the daemon refunds the retry cooldown.
 *  2. After the CLI was killed (`runPurgeMaintenance`): the restart must go on
 *     no matter what, so failures become an outcome instead of an exception.
 *     What the user is told, and whether the continuation is delivered, waits
 *     for the respawn (`purgeOutcomeNotice`): only a complete purge followed by
 *     a running replacement continues. Replaying the continuation over history
 *     that may still hold the bad image would just hit the same 400 again.
 */
import type { PurgeReport, PurgeResumeTarget } from './transcript-image-purge.js';
import type { RetryAttemptReceipt } from './failed-turn-retry.js';

/** `turn_input_rejected` reason for a continuation whose purge did not happen. */
export const PURGE_IMAGES_NOT_APPLIED = 'purge_images_not_applied';
/** `turn_input_rejected` reason for a continuation withheld after the purge
 *  changed the transcript. Either way the continuation never reached the CLI,
 *  so the daemon rolls the click back the same way. */
export const PURGE_CONTINUATION_WITHHELD = 'purge_continuation_withheld';

export type PurgeRequestPlan =
  | { kind: 'decline'; noticeKey: string; logReason: string }
  | { kind: 'proceed'; target: PurgeResumeTarget; preserveScratchTree: boolean; report: PurgeReport };

export interface PurgeRequestInput {
  cliId: string | undefined;
  /** Adopted panes and remote backends have no worker-owned local transcript. */
  localOwnedSession: boolean;
  target: PurgeResumeTarget | undefined;
  restartInProgress: boolean;
  childPid: number | null | undefined;
  /** Sandbox mode resolved for the running CLI ('off' | 'oncall' | 'scratch'). */
  sandboxMode: string | undefined;
  platform: NodeJS.Platform;
  /** Read-only scan of the target; only called once every cheap gate passed. */
  scan: (target: PurgeResumeTarget) => PurgeReport;
}

export function planPurgeRequest(input: PurgeRequestInput): PurgeRequestPlan {
  if (input.cliId !== 'claude-code' || !input.localOwnedSession || !input.target) {
    return { kind: 'decline', noticeKey: 'worker.purge_images_unsupported', logReason: 'no worker-owned local Claude Code transcript' };
  }
  if (input.restartInProgress) {
    return { kind: 'decline', noticeKey: 'worker.purge_images_busy', logReason: 'a CLI restart is already in progress' };
  }
  // Only the Linux overlay can be re-prepared around the repaired view. Other
  // sandbox modes keep the transcript outside the per-session tree, so an
  // ordinary restart leaves it in place.
  const scratch = input.sandboxMode === 'scratch';
  if (scratch && input.platform !== 'linux') {
    return { kind: 'decline', noticeKey: 'worker.purge_images_sandbox_unsupported', logReason: `scratch sandbox on ${input.platform} cannot reuse its view` };
  }
  if (!input.childPid || input.childPid <= 0) {
    return { kind: 'decline', noticeKey: 'worker.purge_images_exit_unproven', logReason: 'no CLI pid to prove its exit with' };
  }
  const report = input.scan(input.target);
  if (report.removed === 0) {
    return { kind: 'decline', noticeKey: unpurgedNoticeKey(report), logReason: 'nothing removable' };
  }
  return { kind: 'proceed', target: input.target, preserveScratchTree: scratch, report };
}

/** Explain a scan that found nothing to remove, most actionable cause first. */
export function unpurgedNoticeKey(report: PurgeReport): string {
  if (report.failedFiles.length > 0) return 'worker.purge_images_failed';
  if (report.unmeasurable.length > 0) return 'worker.purge_images_unmeasurable';
  if (report.skippedSourceTypes.length > 0) return 'worker.purge_images_unsupported_source';
  if (report.imageBlocks === 0) return 'worker.purge_images_no_images';
  return 'worker.purge_images_not_found';
}

export type PurgeMaintenanceOutcome =
  | { kind: 'purged'; report: PurgeReport }
  /** Something was removed, but an image the purge examined is still
   *  unsettled (unmeasurable, not embedded, or in a file it could not handle). */
  | { kind: 'partial'; report: PurgeReport }
  | { kind: 'nothing_removed'; report: PurgeReport }
  | { kind: 'not_quiescent'; detail: string }
  | { kind: 'failed'; detail: string };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs between killing the CLI and respawning it. Never throws. */
export async function runPurgeMaintenance(deps: {
  waitForQuiescence: () => Promise<void>;
  purge: () => PurgeReport;
}): Promise<PurgeMaintenanceOutcome> {
  try {
    await deps.waitForQuiescence();
  } catch (err) {
    return { kind: 'not_quiescent', detail: errorText(err) };
  }
  let report: PurgeReport;
  try {
    report = deps.purge();
  } catch (err) {
    return { kind: 'failed', detail: errorText(err) };
  }
  if (report.removed > 0) {
    const unsettled = report.unmeasurable.length > 0 || report.skippedSourceTypes.length > 0 || report.failedFiles.length > 0;
    return { kind: unsettled ? 'partial' : 'purged', report };
  }
  if (report.failedFiles.length > 0) {
    return { kind: 'failed', detail: report.failedFiles.map(entry => `${entry.file}: ${entry.reason}`).join('; ') };
  }
  return { kind: 'nothing_removed', report };
}

/** How the restart around the purge ended. */
export type PurgeRespawnResult = 'spawned' | 'failed' | 'superseded';

export type PurgeOutcomeNotice = { key?: string; params?: Record<string, string> } & (
  | { deliverContinuation: true }
  | { deliverContinuation: false; rejectReason: string }
);

/** Decided once the respawn settled: a failed spawn exits the worker, so a
 *  continuation queued for a replacement that never came would be lost while
 *  the user had already been told it was running. `outcome` is undefined when
 *  the restart died before maintenance ran; the worker's fatal error explains
 *  that, so there is no notice of our own. */
export function purgeOutcomeNotice(
  outcome: PurgeMaintenanceOutcome | undefined,
  respawn: PurgeRespawnResult,
): PurgeOutcomeNotice {
  if (!outcome) return { deliverContinuation: false, rejectReason: PURGE_IMAGES_NOT_APPLIED };
  switch (outcome.kind) {
    case 'purged':
    case 'partial': {
      const params = { files: String(outcome.report.files.length), removed: String(outcome.report.removed) };
      const withheld = (key: string): PurgeOutcomeNotice => (
        { key, params, deliverContinuation: false, rejectReason: PURGE_CONTINUATION_WITHHELD }
      );
      if (respawn === 'failed') return withheld('worker.purge_images_restart_failed');
      if (respawn === 'superseded') return withheld('worker.purge_images_superseded');
      if (outcome.kind === 'partial') return withheld('worker.purge_images_partial');
      return { key: 'worker.purge_images_done', params, deliverContinuation: true };
    }
    case 'nothing_removed':
      return { key: unpurgedNoticeKey(outcome.report), deliverContinuation: false, rejectReason: PURGE_IMAGES_NOT_APPLIED };
    case 'not_quiescent':
      return { key: 'worker.purge_images_exit_unproven', deliverContinuation: false, rejectReason: PURGE_IMAGES_NOT_APPLIED };
    case 'failed':
      return { key: 'worker.purge_images_failed', deliverContinuation: false, rejectReason: PURGE_IMAGES_NOT_APPLIED };
  }
}

/** What a purge click changed on the daemon session, held until the worker
 *  either takes the continuation or rejects it. A rejection means the
 *  continuation never ran, so the click gives back its cooldown stamp and the
 *  turn state it overwrote. */
export interface PurgeClickRollback {
  receipt?: RetryAttemptReceipt;
  restoreTurnState: () => void;
}

const MAX_HELD_CLICKS_PER_SESSION = 8;
const heldClickRollbacks = new WeakMap<object, Map<string, PurgeClickRollback>>();

export function holdPurgeClickRollback(owner: object, turnId: string, rollback: PurgeClickRollback): void {
  let held = heldClickRollbacks.get(owner);
  if (!held) heldClickRollbacks.set(owner, held = new Map());
  held.set(turnId, rollback);
  for (const stale of held.keys()) {
    if (held.size <= MAX_HELD_CLICKS_PER_SESSION) break;
    held.delete(stale);
  }
}

/** One-shot: the held rollback for exactly this continuation turn, if any. */
export function takePurgeClickRollback(owner: object, turnId: string): PurgeClickRollback | undefined {
  const held = heldClickRollbacks.get(owner);
  const rollback = held?.get(turnId);
  held?.delete(turnId);
  return rollback;
}
