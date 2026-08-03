import type { DaemonSession } from './types.js';

// Turn-exact suppression of the daemon-rendered final_output for loud external
// triggers whose owner opted into "no trailing final notice" (connector
// suppressFinalOutput). Unlike silent scheduled fires this leaves the streaming
// card and start notice alone — only the transcript-driven final_output reply
// is dropped. Keyed on the trigger's turn id so a normal user turn queued on the
// same session can neither inherit nor un-hush the suppression. Entries outlive
// turn_terminal briefly to cover trailing worker events and are pruned by
// age/size when new suppressions are armed.
const SUPPRESS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SUPPRESSED_TURNS_PER_SESSION = 256;

/** Bound on the per-turn reply-target map, mirroring reply-target.ts's own
 *  REPLY_TARGETS_MAX so an inherited trigger anchor can never grow the map
 *  past what the normal IM path allows. */
const REPLY_TARGETS_MAX = 32;

/**
 * Give a synthetic trigger turn the session's CURRENT fold-back anchor.
 *
 * `turnId` here is a daemon-minted `trg_<uuid>`, not an accepted Lark message
 * id, but the daemon's chat-scope send chokepoint (daemon.ts sessionReply →
 * `resolveSessionReplyTarget(ds, fallbackTurnId(ds, turnId))`) treats ANY
 * explicit turnId as "this caller knows its own turn" and therefore skips the
 * fallback to `currentReplyTarget`. Without an entry of its own, a loud trigger
 * that folds into a `shared`-mode chat-scope session would resolve to
 * `mode:'plain'` and post this turn's streaming card / notices at the group top
 * level instead of inside the shared topic — the exact leak reply-target.ts
 * documents (and e619250d already fixed once) for turn-less daemon sends.
 *
 * Inheriting the anchor keeps the suppression key turn-exact while making the
 * routing answer identical to what the same turn got before it carried an id.
 * No anchor (flat chat session, or a thread-scope session that never uses this
 * map) → nothing registered, so behavior is unchanged.
 */
export function inheritTriggerReplyAnchor(
  ds: DaemonSession,
  turnId: string,
  nowIso = new Date().toISOString(),
): void {
  if (ds.scope !== 'chat') return;
  const anchor = ds.currentReplyTarget ?? ds.session.currentReplyTarget;
  if (!anchor?.rootMessageId) return;
  const targets = { ...(ds.session.replyTargets ?? {}) };
  if (targets[turnId]) return;
  targets[turnId] = {
    rootMessageId: anchor.rootMessageId,
    updatedAt: nowIso,
    ...(anchor.quoteOnly ? { quoteOnly: true } : {}),
    ...(anchor.substitute ? { substitute: true } : {}),
  };
  const keys = Object.keys(targets);
  if (keys.length > REPLY_TARGETS_MAX) {
    keys
      .sort((a, b) => (targets[a].updatedAt < targets[b].updatedAt ? -1 : 1))
      .slice(0, keys.length - REPLY_TARGETS_MAX)
      .forEach(k => { delete targets[k]; });
  }
  ds.session.replyTargets = targets;
}

function pruneTriggerFinalSuppression(ds: DaemonSession, now: number): void {
  const turns = ds.suppressedTriggerFinalTurns;
  if (!turns) return;
  for (const [turnId, armedAt] of turns) {
    if (now - armedAt > SUPPRESS_TTL_MS) turns.delete(turnId);
  }
  while (turns.size >= MAX_SUPPRESSED_TURNS_PER_SESSION) {
    const oldest = turns.keys().next().value as string | undefined;
    if (!oldest) break;
    turns.delete(oldest);
  }
  if (turns.size === 0) ds.suppressedTriggerFinalTurns = undefined;
}

export function armTriggerFinalSuppression(
  ds: DaemonSession,
  turnId: string,
  now = Date.now(),
): void {
  pruneTriggerFinalSuppression(ds, now);
  const turns = ds.suppressedTriggerFinalTurns ??= new Map<string, number>();
  turns.set(turnId, now);
}

export function isTriggerFinalSuppressed(
  ds: DaemonSession,
  turnId?: string,
  now = Date.now(),
): boolean {
  if (!turnId) return false;
  const armedAt = ds.suppressedTriggerFinalTurns?.get(turnId);
  if (armedAt === undefined) return false;
  if (now - armedAt <= SUPPRESS_TTL_MS) return true;
  ds.suppressedTriggerFinalTurns?.delete(turnId);
  if (ds.suppressedTriggerFinalTurns?.size === 0) ds.suppressedTriggerFinalTurns = undefined;
  return false;
}

export function disarmTriggerFinalSuppression(ds: DaemonSession, turnId: string): void {
  ds.suppressedTriggerFinalTurns?.delete(turnId);
  if (ds.suppressedTriggerFinalTurns?.size === 0) ds.suppressedTriggerFinalTurns = undefined;
}
