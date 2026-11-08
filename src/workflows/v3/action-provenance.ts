/**
 * Who decided a run mutation, and why (design 2026-11-03 §13.6, M3).
 *
 * `botmux workflow retry | edit | ask-human` record the main bot's own
 * decisions as `by: 'main_bot'` with the reason in `auto: { reason }`; a
 * human's turn keeps today's record. The caller is authenticated before it
 * reaches here — by the CLI from the process-tree marker on the host path, by
 * the daemon from its own live session record on the relay path — so nothing
 * in this module decides authority; it only shapes what the journal records.
 *
 * Pure: no IO.
 */

import type { V3AutoProvenance } from './event-contract.js';

/** Longest `--reason` the daemon accepts (the IPC body bound). */
export const V3_ACTION_REASON_MAX = 500;

/** The authenticated turn a mutation came from. */
export interface V3ActionCaller {
  /** `runEvent`: the main bot decided on its own (a turn this run's events
   *  woke, that wake turn after a newer message of the initiator overtook
   *  it, or the initiator's scheduled turn); `human`: the caller's own turn. */
  origin: 'human' | 'runEvent';
  /** Authenticated open_id of the turn (the initiator for a wake turn). */
  openId?: string;
  /** The process runs inside a `workflow-event:` turn (verified, or overtaken
   *  by a newer message). Only these turns must give a reason (§13.6). */
  wakeTurn?: boolean;
  /** The turn id (audit only). */
  turnId?: string;
}

/** Why the request is refused for lack of a reason, or undefined. Only a
 *  wake turn must explain itself; a human turn may leave it out and gets
 *  exactly today's behaviour. */
export function v3ReasonRequiredProblem(
  caller: V3ActionCaller | undefined,
  reason: string | undefined,
): string | undefined {
  if (!caller?.wakeTurn || (reason !== undefined && reason.trim().length > 0)) return undefined;
  return '这一回合由工作流事件唤醒：自动重试、改派、重做或交给人都要用 --reason "<为什么>" 写明理由';
}

/** The record fields of a retry / reassignment. A turn the main bot decided
 *  is `main_bot` (with its reason); a human turn that gave a reason records
 *  who gave it and the reason as a note; anything else adds nothing — the
 *  event keeps its original bytes. */
export function v3ActionRecord(
  caller: V3ActionCaller | undefined,
  reason: string | undefined,
): { by?: string; auto?: V3AutoProvenance; note?: string } {
  const text = reason?.trim();
  if (caller?.origin === 'runEvent') return { by: 'main_bot', ...(text ? { auto: { reason: text } } : {}) };
  if (caller && text && caller.openId) return { by: caller.openId, note: text };
  return {};
}

/** Who a hand-over is recorded as: `main_bot` for the main bot's own
 *  decision, otherwise the authenticated caller (the initiator). */
export function v3ActionActor(caller: V3ActionCaller): string {
  return caller.origin === 'runEvent' ? 'main_bot' : caller.openId ?? 'unknown';
}
