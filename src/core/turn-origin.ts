/**
 * How the turn that is executing right now came to exist, as the daemon
 * itself recorded it. Consumed by `botmux execution current --json` so an
 * external shim can tell "a person asked" from "a scheduled task fired"
 * without parsing turn-id prefixes.
 *
 * Every input is daemon state: the attested live turn id (worker private IPC,
 * daemon-minted), the session's per-turn registries and recovery markers, and
 * the trigger registry below. Nothing comes from the requesting process, its
 * environment or files it can write.
 */
import type { DaemonSession } from './types.js';
import { TRIGGER_SOURCE_TYPES, type TriggerSourceType } from '../services/trigger-types.js';
import { parseScheduledTurnId } from './scheduled-turn-provenance.js';
import { registryEntryProvesHumanSender, registryTurnMayAuthenticateHuman } from './reply-target.js';

export const TURN_ORIGINS = ['im', 'dispatch', 'schedule', 'trigger', 'recovery', 'unknown'] as const;
export type TurnOrigin = typeof TURN_ORIGINS[number];

/** The daemon-side origin table is the SAME runtime constant the trigger
 *  validator admits requests with (services/trigger-types), not a second
 *  hand-written list: a connector kind accepted at the edge can always be
 *  represented here. The CLI bundle keeps its own literal (it must not import
 *  daemon modules); the K4 consistency test pins the two lists together. */
export const TRIGGER_SOURCES = TRIGGER_SOURCE_TYPES;
// Compile-time guard for the statement above: if TRIGGER_SOURCES ever becomes
// a separate hand-written list and misses a TriggerSourceType, tsc fails here
// (TS2322). No type annotation on TRIGGER_SOURCES — widening it to
// `readonly TriggerSourceType[]` would defeat this check. Exported so the
// guard binding is not flagged as unused.
export const _triggerSourcesExhaustive:
  Exclude<TriggerSourceType, typeof TRIGGER_SOURCES[number]> extends never ? true : never = true;

export interface TurnOriginFacts {
  origin: TurnOrigin;
  /** Only with origin `schedule`: the task this turn was fired for. */
  scheduleTaskId?: string;
  /** Only with origin `trigger`: the connector kind that submitted it. */
  triggerSource?: TriggerSourceType;
}

// Trigger turns carry no human sender and no per-turn session record, so the
// admission path registers them here when it mints the id. In memory only:
// after a daemon restart the live execution proof is re-established from
// scratch and a turn the registry no longer knows reads as `unknown`.
const TRIGGER_TURN_LIMIT = 4096;
const triggerTurns = new Map<string, TriggerSourceType>();

export function rememberTriggerTurn(turnId: string, source: TriggerSourceType): void {
  if (!turnId) return;
  triggerTurns.delete(turnId);
  triggerTurns.set(turnId, source);
  while (triggerTurns.size > TRIGGER_TURN_LIMIT) {
    const oldest = triggerTurns.keys().next().value;
    if (oldest === undefined) break;
    triggerTurns.delete(oldest);
  }
}

export function __testOnly_resetTriggerTurns(): void {
  triggerTurns.clear();
}

type OriginSession = Pick<DaemonSession, 'activeInteractiveTurn'> & {
  session: Pick<DaemonSession['session'],
    'replyTargets' | 'ordinaryTurnRecovery' | 'failedTurnRecovery' | 'readonlyTaskContinuation'>;
};

/**
 * Classify one exact turn. Order matters:
 *  1. schedule — `schedule:<task>:<uuid>` is minted only by the daemon, per
 *     fire; its semantic-recovery continuations keep the prefix on purpose, so
 *     a scheduled task's retry still reads as the scheduled task.
 *  2. trigger — registered at admission.
 *  3. recovery — a continuation the daemon issued for an earlier turn
 *     (ordinary / failed-turn / read-only task continuation). Not a new human
 *     request even though it may inherit the original reply context.
 *  4. im / dispatch — the inbound message's sender: the live interactive turn
 *     record first, then the durable per-turn registry under the same rule the
 *     identity checks use (a person only when the registry proves a non-bot
 *     sender).
 *  5. unknown — anything else (local CLI input, worker-minted ids, a turn the
 *     daemon has no record for). Never guessed into `im`.
 */
export function resolveTurnOrigin(ds: OriginSession, turnId: string): TurnOriginFacts {
  const scheduleTaskId = parseScheduledTurnId(turnId);
  if (scheduleTaskId) return { origin: 'schedule', scheduleTaskId };

  const triggerSource = triggerTurns.get(turnId);
  if (triggerSource) return { origin: 'trigger', triggerSource };

  const s = ds.session;
  const ordinary = s.ordinaryTurnRecovery;
  const readonly = s.readonlyTaskContinuation;
  if ((ordinary && ordinary.currentTurnId === turnId && ordinary.logicalTurnId !== turnId)
    || s.failedTurnRecovery?.turnId === turnId
    || (readonly && readonly.currentTurnId === turnId && readonly.logicalTurnId !== turnId)) {
    return { origin: 'recovery' };
  }

  const interactive = ds.activeInteractiveTurn;
  if (interactive?.turnId === turnId && !interactive.caller.source) {
    if (interactive.caller.senderType === 'user') return { origin: 'im' };
    if (interactive.caller.senderType === 'bot') return { origin: 'dispatch' };
  }

  const entry = s.replyTargets?.[turnId];
  if (entry && registryTurnMayAuthenticateHuman(s, turnId)) {
    if (registryEntryProvesHumanSender(entry)) return { origin: 'im' };
    const sender = entry.senderOpenId;
    if (sender && entry.participants?.some(p => p.openId === sender && p.isBot === true)) {
      return { origin: 'dispatch' };
    }
  }
  return { origin: 'unknown' };
}
