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
 *     Only a successful purge delivers the continuation; replaying it over the
 *     untouched history would just hit the same 400 again.
 */
import type { PurgeReport, PurgeResumeTarget } from './transcript-image-purge.js';
import type { RetryAttemptReceipt } from './failed-turn-retry.js';

/** `turn_input_rejected` reason for a continuation whose purge did not happen.
 *  The daemon refunds the retry cooldown for it: nothing was changed. */
export const PURGE_IMAGES_NOT_APPLIED = 'purge_images_not_applied';

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
  if (report.removed > 0) return { kind: 'purged', report };
  if (report.failedFiles.length > 0) {
    return { kind: 'failed', detail: report.failedFiles.map(entry => `${entry.file}: ${entry.reason}`).join('; ') };
  }
  return { kind: 'nothing_removed', report };
}

export interface PurgeOutcomeNotice {
  key: string;
  params?: Record<string, string>;
  deliverContinuation: boolean;
}

export function purgeOutcomeNotice(outcome: PurgeMaintenanceOutcome): PurgeOutcomeNotice {
  switch (outcome.kind) {
    case 'purged':
      return {
        key: 'worker.purge_images_done',
        params: { files: String(outcome.report.files.length), removed: String(outcome.report.removed) },
        deliverContinuation: true,
      };
    case 'nothing_removed':
      return { key: unpurgedNoticeKey(outcome.report), deliverContinuation: false };
    case 'not_quiescent':
      return { key: 'worker.purge_images_exit_unproven', deliverContinuation: false };
    case 'failed':
      return { key: 'worker.purge_images_failed', deliverContinuation: false };
  }
}

/** What a purge click changed on the daemon session, held until the worker
 *  either takes the continuation or rejects it. A rejection means neither the
 *  purge nor the continuation ran, so the click gives back its cooldown stamp
 *  and the turn state it overwrote. */
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
