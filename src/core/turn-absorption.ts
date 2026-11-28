/**
 * Deterministic merged-turn membership for turns that a CLI folded mid-turn
 * into an already-running host turn (Claude `attachment(queued_command)`).
 *
 * All links come strictly from worker transcript/settlement proof — never from
 * queue order, timestamps, or other heuristics. Independent turns (including
 * unabsorbed type-ahead turns queued behind a running turn) never enter this
 * table, so cross-turn isolation stays strict.
 */
import type { DaemonSession } from './types.js';
import { parseReplyMessageTarget } from './reply-message.js';
import { replyTargetKey } from './reply-target.js';

export type AbsorbedTurnCoverage = 'settled' | 'host_execution' | 'pre_send_unmarked';

export interface AbsorbedTurnHost {
  hostTurnId: string;
  hostDispatchAttempt?: number;
}

const MAX_ABSORBED_ENTRIES_PER_SESSION = 128;

const absorbedBySession = new WeakMap<DaemonSession, Map<string, AbsorbedTurnHost>>();

function resolveRootHost(
  map: ReadonlyMap<string, AbsorbedTurnHost>,
  startTurnId: string,
): AbsorbedTurnHost | undefined {
  let current = map.get(startTurnId);
  if (!current) return undefined;
  const visited = new Set<string>([startTurnId]);
  while (current) {
    if (visited.has(current.hostTurnId)) return undefined;
    visited.add(current.hostTurnId);
    const parent = map.get(current.hostTurnId);
    if (!parent) return current;
    current = parent;
  }
  return undefined;
}

/** Record that `memberTurnId` was deterministically folded into `hostTurnId`. */
export function recordTurnAbsorption(
  ds: DaemonSession,
  memberTurnId: string | undefined,
  hostTurnId: string | undefined,
  hostDispatchAttempt?: number,
): boolean {
  if (!memberTurnId || !hostTurnId || memberTurnId === hostTurnId) return false;
  let map = absorbedBySession.get(ds);
  if (!map) {
    map = new Map();
    absorbedBySession.set(ds, map);
  }
  // Resolve through any existing parent chain and reject cycles back to member.
  let rootHostId = hostTurnId;
  let rootAttempt = hostDispatchAttempt;
  const visited = new Set<string>([memberTurnId]);
  while (true) {
    if (visited.has(rootHostId)) return false;
    visited.add(rootHostId);
    const parent = map.get(rootHostId);
    if (!parent) break;
    rootHostId = parent.hostTurnId;
    rootAttempt = parent.hostDispatchAttempt;
  }
  const entry: AbsorbedTurnHost = {
    hostTurnId: rootHostId,
    ...(rootAttempt !== undefined ? { hostDispatchAttempt: rootAttempt } : {}),
  };
  map.delete(memberTurnId);
  map.set(memberTurnId, entry);
  // Collapse any existing children pointing directly to memberTurnId so future
  // evictions of memberTurnId cannot strand transitive links.
  for (const [childId, childHost] of map) {
    if (childId !== memberTurnId && childHost.hostTurnId === memberTurnId) {
      map.set(childId, { ...entry });
    }
  }
  while (map.size > MAX_ABSORBED_ENTRIES_PER_SESSION) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  return true;
}

/** Record multiple absorbed member turn IDs under one host turn. */
export function recordTurnAbsorbedMembers(
  ds: DaemonSession,
  hostTurnId: string | undefined,
  memberTurnIds: readonly string[] | undefined,
  hostDispatchAttempt?: number,
): void {
  if (!hostTurnId || !memberTurnIds?.length) return;
  for (const memberId of memberTurnIds) {
    recordTurnAbsorption(ds, memberId, hostTurnId, hostDispatchAttempt);
  }
}

/** Detach a previously recorded mid-turn absorption link when settlement proves
 *  this turn was NOT covered by its host (e.g. #3880 TOCTOU or gate refusal). */
export function clearTurnAbsorption(ds: DaemonSession, memberTurnId: string | undefined): void {
  if (!memberTurnId) return;
  const map = absorbedBySession.get(ds);
  if (!map) return;
  map.delete(memberTurnId);
  if (map.size === 0) absorbedBySession.delete(ds);
}

/** Return all member turn IDs currently linked to `hostTurnId`. */
export function absorbedMembersOfHost(
  ds: DaemonSession,
  hostTurnId: string | undefined,
): string[] {
  if (!hostTurnId) return [];
  const map = absorbedBySession.get(ds);
  if (!map) return [];
  const members: string[] = [];
  for (const memberId of map.keys()) {
    if (resolveRootHost(map, memberId)?.hostTurnId === hostTurnId) {
      members.push(memberId);
    }
  }
  return members;
}

/** Return the canonical host for an absorbed member turn, or undefined. */
export function absorbedHostForTurn(
  ds: DaemonSession,
  turnId: string | undefined,
): AbsorbedTurnHost | undefined {
  if (!turnId) return undefined;
  const map = absorbedBySession.get(ds);
  if (!map) return undefined;
  return resolveRootHost(map, turnId);
}

/** Canonical host turn ID for `turnId` (its absorption host, or itself). */
export function canonicalMergedHostTurnId(
  ds: DaemonSession,
  turnId: string | undefined,
): string | undefined {
  if (!turnId) return undefined;
  return absorbedHostForTurn(ds, turnId)?.hostTurnId ?? turnId;
}

/** True iff `turnA` and `turnB` are the same turn or deterministically belong
 *  to the same merged/absorbed execution group. */
export function sameMergedTurnGroup(
  ds: DaemonSession,
  turnA: string | undefined,
  turnB: string | undefined,
): boolean {
  if (!turnA || !turnB) return false;
  if (turnA === turnB) return true;
  const hostA = canonicalMergedHostTurnId(ds, turnA);
  const hostB = canonicalMergedHostTurnId(ds, turnB);
  return hostA !== undefined && hostA === hostB;
}

/** Whether two turns in a chat-scope session address the exact same Lark reply
 *  destination. Thread-scope sessions share one root thread and always return
 *  true; missing chat-scope metadata fails closed (false). */
export function sameChatReplyDestination(
  ds: Pick<DaemonSession, 'scope' | 'session'>,
  hostTurnId: string,
  memberTurnId: string,
): boolean {
  if (ds.scope === 'thread') return true;
  const hostTarget = parseReplyMessageTarget(ds.session.turnReplyContexts?.[hostTurnId]?.target);
  const memberTarget = parseReplyMessageTarget(ds.session.turnReplyContexts?.[memberTurnId]?.target);
  if (!hostTarget || !memberTarget) return false;
  return replyTargetKey(hostTarget) === replyTargetKey(memberTarget);
}

/** Whether two turns in a private-reply session belong to the exact same human
 *  recipient. Missing sender metadata fails closed (false). */
export function samePrivateReplySender(
  ds: Pick<DaemonSession, 'session'>,
  hostTurnId: string,
  memberTurnId: string,
): boolean {
  const senderOf = (turnId: string): string | undefined =>
    ds.session.replyTargets?.[turnId]?.senderOpenId
    ?? ds.session.turnReplyContexts?.[turnId]?.replyTargetSenderOpenId;
  const hostSender = senderOf(hostTurnId);
  const memberSender = senderOf(memberTurnId);
  return !!hostSender && !!memberSender && hostSender === memberSender;
}

export interface AbsorbedTurnCoverageInput {
  turnId: string;
  turnDispatchAttempt?: number;
  turnMarkTimeMs?: number;
  hostTurnId: string | undefined;
  hostDispatchAttempt?: number;
  /** Whether the host turn is a synthesised local/scheduled turn (`local-*`, `scheduled-*`). */
  hostIsLocal?: boolean;
  /** This absorbed turn delivered its own explicit final or final_output. */
  hasOwnFinal: boolean;
  /** Host turn delivered (or has ledger evidence of) an explicit `botmux send --response-kind final`. */
  hostHasExplicitFinal: boolean;
  /** Host's explicit final durably settled this turn (#3880 settledAbsorbedTurnIds / legacy marker). */
  settledByHostFinal: boolean;
  /** Ledger lookup status for the host turn's explicit final. */
  ledgerKind?: 'ledger' | 'legacy' | 'unknown';
  /** Timestamp at which the host turn's explicit final was sent. */
  hostFinalSentAtMs?: number;
  /** Delivery kind recorded on the host final's bridge/ledger marker. */
  hostFinalDeliveryKind?: string;
  /** True when the host's explicit final carried flags that forbid settling
   *  absorbed follow-ups (e.g. `--reply-to`, `--quote`, routing override, excluded send kind). */
  hostFinalSettlementIneligible?: boolean;
  /** Wall-clock ms sampled BEFORE the worker persisted `absorbedIntoTurnId` on
   *  the PID marker for this turn. When `<= hostFinalSentAtMs`, `cli.ts` already
   *  evaluated this turn through #3880's settlement gate; omission from
   *  `settledByHostFinal` then means an explicit gate refusal that must stay fail-closed. */
  absorbedMarkerWrittenAtMs?: number;
  /** Cross-principal isolation detected incompatible or unproven principals between host and member. */
  crossPrincipalMismatch?: boolean;
}

/** Worker-side deterministic classification of whether an absorbed turn was
 *  covered by its host turn's execution/final, or must remain standalone. */
export function resolveAbsorbedTurnCoverage(
  input: AbsorbedTurnCoverageInput,
): AbsorbedTurnCoverage | undefined {
  if (!input.hostTurnId || input.hostTurnId === input.turnId) return undefined;
  if (input.hasOwnFinal) return undefined;
  // Non-Lark / local / scheduled hosts have no unified Lark reply card and may
  // suppress output/failure terminals; never fold a real Lark turn into them.
  if (input.hostIsLocal === true || !input.hostTurnId.startsWith('om_')) return undefined;
  if (input.turnDispatchAttempt !== undefined || input.hostDispatchAttempt !== undefined) return undefined;
  if (input.turnId.startsWith('schedule:') || input.turnId.startsWith('wf:')) return undefined;
  if (input.crossPrincipalMismatch) return undefined;
  if (!input.hostHasExplicitFinal) return 'host_execution';
  if (input.settledByHostFinal) return 'settled';
  if (input.ledgerKind === 'unknown') return undefined;
  if (input.hostFinalSettlementIneligible) return undefined;
  if (input.hostFinalDeliveryKind !== undefined && input.hostFinalDeliveryKind !== 'current_session_send') {
    return undefined;
  }
  if (input.turnMarkTimeMs === undefined || input.hostFinalSentAtMs === undefined) return undefined;
  // TOCTOU: input was folded AFTER host's final was sent; host's answer could
  // not have addressed it.
  if (input.turnMarkTimeMs > input.hostFinalSentAtMs) return undefined;
  if (input.ledgerKind === 'legacy') return 'pre_send_unmarked';
  // Ledger exists and did NOT settle this turn: if the PID marker already carried
  // `absorbedIntoTurnId` before the send, #3880's gate explicitly refused settlement
  // (e.g. --reply-to, destination mismatch, privateReply, XPI). Stay fail-closed.
  if (input.absorbedMarkerWrittenAtMs !== undefined && input.absorbedMarkerWrittenAtMs <= input.hostFinalSentAtMs) {
    return undefined;
  }
  return 'pre_send_unmarked';
}

export interface DaemonAbsorbedFoldInput {
  turnId: string;
  absorbedIntoTurnId?: string;
  absorbedCoverage?: AbsorbedTurnCoverage;
  /** Whether the daemon session's scope is `'thread'` or `'chat'`. */
  scope?: 'chat' | 'thread';
  /** Whether private-reply mode is active on this session. */
  privateReply: boolean;
  /** Required when `privateReply` is true (verified via host ledger or matching sender). */
  samePrivateReplyRecipient?: boolean;
  /** Whether the member turn came from a cross-chat followed thread. */
  memberHasCrossChatOrigin: boolean;
  /** Whether this turn has its own final card, externalFinal, carrier, or ledger final. */
  hasOwnFinal: boolean;
  /** Fail-closed #3911 rule: IM sink required an answer and neither this turn nor
   *  its host proved delivery. */
  requiresReplyUnanswered: boolean;
  /** Whether host and member share the same reply destination (or host ledger settled member). */
  sameDestination: boolean;
}

/** Daemon-side deterministic verdict for whether an absorbed member's terminal
 *  should silently fold into its host turn instead of creating/settling a
 *  standalone unified reply card or legacy receipt strip. */
export function shouldFoldAbsorbedTurnReplyCard(input: DaemonAbsorbedFoldInput): boolean {
  if (!input.absorbedIntoTurnId || input.absorbedIntoTurnId === input.turnId) return false;
  if (!input.absorbedCoverage) return false;
  if (input.hasOwnFinal || input.requiresReplyUnanswered) return false;
  if (input.memberHasCrossChatOrigin) return false;
  if (input.privateReply && input.samePrivateReplyRecipient !== true) return false;
  if (!input.sameDestination) return false;
  if (input.absorbedCoverage === 'pre_send_unmarked') {
    return input.scope === 'thread';
  }
  return true;
}
