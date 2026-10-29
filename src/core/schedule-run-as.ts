/**
 * Which identity a scheduled task's turns run as.
 *
 * Two sources, in this order:
 *   1. `runAsClaim` — a person who claimed the task from the claim card. The
 *      daemon writes it from the Lark-verified card-callback operator, so it is
 *      never derived from model input.
 *   2. The creator (`ownerOpenId` / `ownerUnionId`), captured when a human
 *      created the task.
 *
 * A claim outranks the creator because it is the later, explicit decision: the
 * card is only offered once the creator is missing or has lost access. Either
 * way this only names the candidate; the fire path still re-checks it against
 * the bot's live access before publishing any credential.
 *
 * Kept free of runtime imports: both the JSON projection loader
 * (services/schedule-store) and the provenance readers depend on it.
 */
import type { ScheduledTask, ScheduleRunAsClaim } from '../types.js';

const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
const UNION_ID = /^on_[A-Za-z0-9_-]+$/;

/** Shape check for a persisted claim. A malformed claim is dropped, which
 *  leaves the task exactly where it was before anyone claimed it. */
export function parseScheduleRunAsClaim(raw: unknown): ScheduleRunAsClaim | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.openId !== 'string' || !OPEN_ID.test(r.openId)) return undefined;
  if (typeof r.unionId !== 'string' || !UNION_ID.test(r.unionId)) return undefined;
  if (typeof r.larkAppId !== 'string' || !r.larkAppId) return undefined;
  if (typeof r.claimedAt !== 'string' || Number.isNaN(Date.parse(r.claimedAt))) return undefined;
  return { openId: r.openId, unionId: r.unionId, larkAppId: r.larkAppId, claimedAt: r.claimedAt };
}

export interface ScheduledTaskRunAs {
  source: 'claim' | 'creator';
  /** Absent for a creator recorded by union_id only. */
  openId?: string;
  unionId: string;
  /** App the open_id belongs to. */
  larkAppId: string;
  claimedAt?: string;
}

/**
 * The candidate run-as identity, or undefined when the task has neither a
 * claim nor a creator union_id (legacy, bot-created, platform-created tasks).
 * `fallbackLarkAppId` is the executing bot, used for rows that predate the
 * per-task app binding.
 */
export function scheduledTaskRunAs(
  task: ScheduledTask,
  fallbackLarkAppId: string,
): ScheduledTaskRunAs | undefined {
  const claim = parseScheduleRunAsClaim(task.runAsClaim);
  if (claim) {
    return {
      source: 'claim',
      openId: claim.openId,
      unionId: claim.unionId,
      larkAppId: claim.larkAppId,
      claimedAt: claim.claimedAt,
    };
  }
  if (!task.ownerUnionId) return undefined;
  return {
    source: 'creator',
    ...(task.ownerOpenId ? { openId: task.ownerOpenId } : {}),
    unionId: task.ownerUnionId,
    larkAppId: task.creatorLarkAppId ?? task.larkAppId ?? fallbackLarkAppId,
  };
}
