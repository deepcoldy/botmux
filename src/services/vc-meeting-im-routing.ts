import type { VcMeetingRuntimeSessionRecord } from './vc-meeting-runtime-store.js';
import { listVcMeetingRuntimeSessionsByListenerAndAgent } from './vc-meeting-runtime-store.js';
import type { VcMeetingMemberProjectionRecord } from './vc-meeting-delivery-store.js';
import {
  listVcMeetingActiveProjectionsForReceiverSession,
  listVcMeetingMemberProjections,
} from './vc-meeting-delivery-store.js';
import {
  getVcMeetingHubCloseState,
  getVcMeetingHubMember,
} from './vc-meeting-delivery-hub-store.js';
import { listVcMeetingListenerMessageIds } from './vc-meeting-listener-message-store.js';

/**
 * Durable listener-chat -> receiver-session routing for explicit human IM turns.
 *
 * This module deliberately does not inspect daemon memory. A receiver session is
 * routable only when both durable sources agree:
 *
 * 1. the runtime meeting record still selects this agent as active; and
 * 2. the latest receiver projection for that selected member is active and is
 *    bound to the same listener chat / agent.
 *
 * Keeping selection pure and deterministic is important here: `updatedAt` is
 * never a tie-breaker. Multiple active meetings require an explicit quote or
 * meeting reference, otherwise callers must show a disambiguation UI.
 */

export const DEFAULT_VC_MEETING_IM_CATCH_UP_TIMEOUT_MS = 8_000;
export const MAX_VC_MEETING_IM_CATCH_UP_TIMEOUT_MS = 30_000;
/** Match the historical runtime-route retention window. After this horizon a
 * deliberately still-open receiver no longer captures ordinary chat turns. */
export const DEFAULT_VC_MEETING_SEALED_IM_ROUTE_TTL_MS = 24 * 60 * 60 * 1000;

export interface VcMeetingSealedReceiverSessionBinding {
  listenerAppId: string;
  listenerChatId: string;
  meetingId: string;
  memberId: string;
  memberEpoch: number;
  agentAppId: string;
  receiverSessionId: string;
}

export interface VcMeetingImRoutingCandidate {
  lifecycle: 'active' | 'sealed';
  listenerAppId: string;
  listenerChatId: string;
  meetingId: string;
  meetingNo?: string;
  topic?: string;
  memberId: string;
  memberEpoch: number;
  ownerBootId: string;
  ownerEpoch: number;
  membershipGeneration: number;
  sinkOwnerGeneration: number;
  agentAppId: string;
  receiverSessionId: string;
  responseMode: 'silent' | 'listener_thread';
  /**
   * Durable listener messages that unambiguously belong to this meeting.
   * This combines the runtime consumer card with the bounded primary-output
   * ledger maintained by meeting receiver send paths.
   */
  knownListenerMessageIds: string[];
}

export interface VcMeetingImDisambiguation {
  /** Raw Lark parent_id. It is matched only against known listener messages. */
  quotedMessageId?: string;
  /** Meeting id resolved by a durable listener-message index. */
  quotedMeetingId?: string;
  /** Explicit meeting id / meeting number extracted by the caller. */
  explicitMeetingId?: string;
  /** Raw mention-stripped IM text; exact candidate ids/numbers are detected. */
  messageText?: string;
}

export type VcMeetingImCatchUpStatus =
  | 'not_attempted'
  | 'succeeded'
  | 'failed'
  | 'timed_out';

export type VcMeetingImRoutingResult =
  | {
      kind: 'ordinary';
      reason: 'no_active_membership';
      candidates: [];
    }
  | {
      kind: 'receiver';
      selectedBy: 'only_active' | 'only_sealed' | 'quote' | 'meeting_reference';
      candidate: VcMeetingImRoutingCandidate;
      /** Fail-honest default until bounded catch-up proves the stream current. */
      meetingContextMayLag: boolean;
      catchUpStatus: VcMeetingImCatchUpStatus;
      catchUpError?: string;
    }
  | {
      kind: 'ambiguous';
      reason:
        | 'multiple_active'
        | 'multiple_sealed'
        | 'reference_not_found'
        | 'reference_not_unique'
        | 'conflicting_references';
      candidates: VcMeetingImRoutingCandidate[];
    };

export interface VcMeetingImCatchUpResult {
  ok: boolean;
  error?: string;
}

export type VcMeetingImCatchUp = (
  candidate: VcMeetingImRoutingCandidate,
  context: { signal: AbortSignal },
) => Promise<boolean | VcMeetingImCatchUpResult>;

function trim(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function candidateKey(candidate: VcMeetingImRoutingCandidate): string {
  return [
    candidate.listenerAppId,
    candidate.meetingId,
    candidate.memberId,
    String(candidate.memberEpoch),
    candidate.receiverSessionId,
  ].join('\u0000');
}

function sortCandidates(
  candidates: readonly VcMeetingImRoutingCandidate[],
): VcMeetingImRoutingCandidate[] {
  return [...candidates].sort((a, b) =>
    a.listenerAppId.localeCompare(b.listenerAppId)
    || a.meetingId.localeCompare(b.meetingId)
    || a.memberId.localeCompare(b.memberId)
    || a.memberEpoch - b.memberEpoch
    || a.receiverSessionId.localeCompare(b.receiverSessionId));
}

function latestProjectionForSelectedMember(
  record: VcMeetingRuntimeSessionRecord,
  memberId: string,
  agentAppId: string,
  projections: readonly VcMeetingMemberProjectionRecord[],
): VcMeetingMemberProjectionRecord | undefined {
  let latest: VcMeetingMemberProjectionRecord | undefined;
  for (const projection of projections) {
    if (projection.listenerAppId !== record.larkAppId
      || projection.meetingId !== record.meeting.id
      || projection.memberId !== memberId) continue;
    if (!latest || projection.memberEpoch > latest.memberEpoch) latest = projection;
  }
  if (!latest
    || latest.status !== 'active'
    || latest.agentAppId !== agentAppId
    || latest.outputChatId !== record.listenerChatId
    || !latest.receiverSessionId.trim()) return undefined;
  return latest;
}

/**
 * Load durable active memberships for one listener chat and one addressed bot.
 * Runtime-only or projection-only residue is intentionally not routable.
 */
export function listDurableVcMeetingImRoutingCandidates(
  dataDir: string,
  input: { listenerChatId: string; agentAppId: string },
  now = Date.now(),
): VcMeetingImRoutingCandidate[] {
  const listenerChatId = input.listenerChatId.trim();
  const agentAppId = input.agentAppId.trim();
  if (!listenerChatId || !agentAppId) return [];

  const candidates: VcMeetingImRoutingCandidate[] = [];
  for (const record of listVcMeetingRuntimeSessionsByListenerAndAgent(
    dataDir,
    { listenerChatId, agentAppId },
    now,
  )) {
    // A crash may leave the runtime record behind after the hub's closed audit
    // became durable. It is no longer a live route; excluding it here lets the
    // sealed receiver proof below take over without a pointless catch-up.
    if (getVcMeetingHubCloseState(dataDir, {
      listenerAppId: record.larkAppId,
      meetingId: record.meeting.id,
    })?.phase === 'closed') continue;
    const projections = listVcMeetingMemberProjections(dataDir, {
      listenerAppId: record.larkAppId,
      meetingId: record.meeting.id,
    });
    const selectedAgents = record.selectedAgents ?? [];
    const selectedMembers = selectedAgents.length > 0
      ? selectedAgents
      : record.selectedAgentAppId === agentAppId
        ? [{
            memberId: 'meeting_assistant',
            agentAppId,
            status: 'active' as const,
          }]
        : [];
    for (const selected of selectedMembers) {
      if (selected.status !== 'active' || selected.agentAppId !== agentAppId) continue;
      const projection = latestProjectionForSelectedMember(
        record,
        selected.memberId,
        agentAppId,
        projections,
      );
      if (!projection) continue;
      const sinkOwnerGeneration = projection.sinkOwnerGeneration;
      if (!Number.isSafeInteger(sinkOwnerGeneration) || (sinkOwnerGeneration ?? 0) < 1) continue;
      const knownListenerMessageIds = new Set(listVcMeetingListenerMessageIds(dataDir, {
        listenerAppId: record.larkAppId,
        meetingId: record.meeting.id,
        targetChatId: record.listenerChatId,
      }));
      if (record.consumerCardMessageId) knownListenerMessageIds.add(record.consumerCardMessageId);
      candidates.push({
        lifecycle: 'active',
        listenerAppId: record.larkAppId,
        listenerChatId: record.listenerChatId,
        meetingId: record.meeting.id,
        ...(record.meeting.meetingNo ? { meetingNo: record.meeting.meetingNo } : {}),
        ...(record.meeting.topic ? { topic: record.meeting.topic } : {}),
        memberId: projection.memberId,
        memberEpoch: projection.memberEpoch,
        ownerBootId: projection.ownerBootId,
        ownerEpoch: projection.ownerEpoch,
        membershipGeneration: projection.membershipGeneration,
        sinkOwnerGeneration: sinkOwnerGeneration!,
        agentAppId: projection.agentAppId,
        receiverSessionId: projection.receiverSessionId,
        responseMode: projection.responseMode,
        knownListenerMessageIds: [...knownListenerMessageIds].sort(),
      });
    }
  }

  const unique = new Map<string, VcMeetingImRoutingCandidate>();
  for (const candidate of candidates) unique.set(candidateKey(candidate), candidate);
  return sortCandidates([...unique.values()]);
}

/**
 * Reconstruct a post-meeting route from three independent durable facts:
 *
 * 1. the dedicated botmux Session is still active (supplied by its owner);
 * 2. its latest receiver projection still matches the exact member epoch; and
 * 3. the hub has durably closed that meeting after this member final-ACKed.
 *
 * This is intentionally a fallback, not a replacement for live runtime
 * selection. A stale projection or an ended tombstone alone can never capture
 * an ordinary chat turn.
 */
export function listSealedVcMeetingImRoutingCandidates(
  dataDir: string,
  input: {
    listenerChatId: string;
    agentAppId: string;
    receiverSessions: readonly VcMeetingSealedReceiverSessionBinding[];
  },
  now = Date.now(),
  ttlMs = DEFAULT_VC_MEETING_SEALED_IM_ROUTE_TTL_MS,
): VcMeetingImRoutingCandidate[] {
  const listenerChatId = input.listenerChatId.trim();
  const agentAppId = input.agentAppId.trim();
  if (!listenerChatId || !agentAppId || ttlMs <= 0) return [];

  const candidates: VcMeetingImRoutingCandidate[] = [];
  for (const binding of input.receiverSessions) {
    if (binding.listenerChatId !== listenerChatId
      || binding.agentAppId !== agentAppId
      || !binding.receiverSessionId.trim()) continue;
    const close = getVcMeetingHubCloseState(dataDir, {
      listenerAppId: binding.listenerAppId,
      meetingId: binding.meetingId,
    });
    if (close?.phase !== 'closed') continue;
    const closedAt = close.closedAt ?? close.updatedAt;
    if (!Number.isFinite(closedAt) || closedAt + ttlMs <= now) continue;

    const projections = listVcMeetingActiveProjectionsForReceiverSession(
      dataDir,
      binding.receiverSessionId,
    );
    // Dedicated receiver sessions are one member epoch. Fail closed if legacy
    // residue makes that identity non-unique instead of guessing a projection.
    if (projections.length !== 1) continue;
    const projection = projections[0]!;
    if (projection.listenerAppId !== binding.listenerAppId
      || projection.meetingId !== binding.meetingId
      || projection.memberId !== binding.memberId
      || projection.memberEpoch !== binding.memberEpoch
      || projection.agentAppId !== agentAppId
      || projection.receiverSessionId !== binding.receiverSessionId
      || projection.outputChatId !== listenerChatId) continue;

    const member = getVcMeetingHubMember(dataDir, {
      listenerAppId: binding.listenerAppId,
      meetingId: binding.meetingId,
      memberId: binding.memberId,
      memberEpoch: binding.memberEpoch,
    });
    if (!member
      || member.status !== 'active'
      || member.finalAckedAt === undefined
      || member.agentAppId !== agentAppId
      || member.receiverSessionId !== binding.receiverSessionId
      || member.outputChatId !== listenerChatId
      || member.ownerBootId !== projection.ownerBootId
      || member.ownerEpoch !== projection.ownerEpoch
      || member.membershipGeneration !== projection.membershipGeneration
      || member.sinkOwnerGeneration !== projection.sinkOwnerGeneration) continue;

    const sinkOwnerGeneration = projection.sinkOwnerGeneration;
    if (!Number.isSafeInteger(sinkOwnerGeneration) || (sinkOwnerGeneration ?? 0) < 1) continue;
    const knownListenerMessageIds = listVcMeetingListenerMessageIds(dataDir, {
      listenerAppId: projection.listenerAppId,
      meetingId: projection.meetingId,
      targetChatId: listenerChatId,
    }).sort();
    candidates.push({
      lifecycle: 'sealed',
      listenerAppId: projection.listenerAppId,
      listenerChatId,
      meetingId: projection.meetingId,
      memberId: projection.memberId,
      memberEpoch: projection.memberEpoch,
      ownerBootId: projection.ownerBootId,
      ownerEpoch: projection.ownerEpoch,
      membershipGeneration: projection.membershipGeneration,
      sinkOwnerGeneration: sinkOwnerGeneration!,
      agentAppId: projection.agentAppId,
      receiverSessionId: projection.receiverSessionId,
      responseMode: projection.responseMode,
      knownListenerMessageIds,
    });
  }

  const unique = new Map<string, VcMeetingImRoutingCandidate>();
  for (const candidate of candidates) unique.set(candidateKey(candidate), candidate);
  return sortCandidates([...unique.values()]);
}

function matchesMeetingReference(
  candidate: VcMeetingImRoutingCandidate,
  reference: string,
): boolean {
  const normalized = reference.trim();
  return normalized === candidate.meetingId
    || (!!candidate.meetingNo && normalized === candidate.meetingNo);
}

function isReferenceWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_-]/.test(char);
}

/** Match a meeting id as a complete token, not as a substring of another id. */
function textContainsMeetingReference(text: string, reference: string): boolean {
  let from = 0;
  while (from <= text.length - reference.length) {
    const index = text.indexOf(reference, from);
    if (index < 0) return false;
    const before = index > 0 ? text[index - 1] : undefined;
    const afterIndex = index + reference.length;
    const after = afterIndex < text.length ? text[afterIndex] : undefined;
    if (!isReferenceWordChar(before) && !isReferenceWordChar(after)) return true;
    from = index + 1;
  }
  return false;
}

function uniqueMatches(
  candidates: readonly VcMeetingImRoutingCandidate[],
  predicate: (candidate: VcMeetingImRoutingCandidate) => boolean,
): VcMeetingImRoutingCandidate[] {
  const matches = new Map<string, VcMeetingImRoutingCandidate>();
  for (const candidate of candidates) {
    if (predicate(candidate)) matches.set(candidateKey(candidate), candidate);
  }
  return [...matches.values()];
}

type ReferenceResolution =
  | { kind: 'none' }
  | { kind: 'one'; candidate: VcMeetingImRoutingCandidate; selectedBy: 'quote' | 'meeting_reference' }
  | { kind: 'error'; reason: 'reference_not_found' | 'reference_not_unique' | 'conflicting_references' };

function resolveDisambiguation(
  candidates: readonly VcMeetingImRoutingCandidate[],
  input: VcMeetingImDisambiguation,
): ReferenceResolution {
  const selectors: Array<{
    selectedBy: 'quote' | 'meeting_reference';
    required: boolean;
    matches: VcMeetingImRoutingCandidate[];
  }> = [];

  const quotedMeetingId = trim(input.quotedMeetingId);
  if (quotedMeetingId) {
    selectors.push({
      selectedBy: 'quote',
      required: true,
      matches: uniqueMatches(candidates, candidate => matchesMeetingReference(candidate, quotedMeetingId)),
    });
  }
  const quotedMessageId = trim(input.quotedMessageId);
  if (quotedMessageId) {
    const matches = uniqueMatches(
      candidates,
      candidate => candidate.knownListenerMessageIds.includes(quotedMessageId),
    );
    // A quote can target an ordinary human message. It is a selector only when
    // the durable listener-message index recognizes it.
    if (matches.length > 0) selectors.push({ selectedBy: 'quote', required: false, matches });
  }

  const explicitMeetingId = trim(input.explicitMeetingId);
  if (explicitMeetingId) {
    selectors.push({
      selectedBy: 'meeting_reference',
      required: true,
      matches: uniqueMatches(candidates, candidate => matchesMeetingReference(candidate, explicitMeetingId)),
    });
  }
  const messageText = trim(input.messageText);
  if (messageText) {
    const matches = uniqueMatches(candidates, candidate =>
      textContainsMeetingReference(messageText, candidate.meetingId)
      || (!!candidate.meetingNo && textContainsMeetingReference(messageText, candidate.meetingNo)));
    if (matches.length > 0) {
      selectors.push({ selectedBy: 'meeting_reference', required: false, matches });
    }
  }

  if (selectors.length === 0) return { kind: 'none' };
  for (const selector of selectors) {
    if (selector.matches.length === 0 && selector.required) {
      return { kind: 'error', reason: 'reference_not_found' };
    }
    if (selector.matches.length > 1) {
      return { kind: 'error', reason: 'reference_not_unique' };
    }
  }

  const resolved = selectors.filter(selector => selector.matches.length === 1);
  if (resolved.length === 0) return { kind: 'none' };
  const first = resolved[0]!;
  const firstKey = candidateKey(first.matches[0]!);
  if (resolved.some(selector => candidateKey(selector.matches[0]!) !== firstKey)) {
    return { kind: 'error', reason: 'conflicting_references' };
  }
  return {
    kind: 'one',
    candidate: first.matches[0]!,
    selectedBy: resolved.some(selector => selector.selectedBy === 'quote')
      ? 'quote'
      : 'meeting_reference',
  };
}

/**
 * Deterministically select a receiver session. Multiple candidates are never
 * reduced by recency or array order.
 */
export function selectVcMeetingImRoutingCandidate(
  inputCandidates: readonly VcMeetingImRoutingCandidate[],
  disambiguation: VcMeetingImDisambiguation = {},
): VcMeetingImRoutingResult {
  const candidates = sortCandidates(inputCandidates);
  if (candidates.length === 0) {
    return { kind: 'ordinary', reason: 'no_active_membership', candidates: [] };
  }
  if (candidates.length === 1) {
    return {
      kind: 'receiver',
      selectedBy: candidates[0]!.lifecycle === 'sealed' ? 'only_sealed' : 'only_active',
      candidate: candidates[0]!,
      meetingContextMayLag: true,
      catchUpStatus: 'not_attempted',
    };
  }

  const resolved = resolveDisambiguation(candidates, disambiguation);
  if (resolved.kind === 'error') {
    return { kind: 'ambiguous', reason: resolved.reason, candidates };
  }
  if (resolved.kind === 'none') {
    return {
      kind: 'ambiguous',
      reason: candidates.every(candidate => candidate.lifecycle === 'sealed')
        ? 'multiple_sealed'
        : 'multiple_active',
      candidates,
    };
  }
  return {
    kind: 'receiver',
    selectedBy: resolved.selectedBy,
    candidate: resolved.candidate,
    meetingContextMayLag: true,
    catchUpStatus: 'not_attempted',
  };
}

/** Convenience loader + pure selector used by daemon routing. */
export function resolveDurableVcMeetingImRouting(
  dataDir: string,
  input: {
    listenerChatId: string;
    agentAppId: string;
    disambiguation?: VcMeetingImDisambiguation;
    /** Active, dedicated Session bindings owned by this agent daemon. Used
     * only when no live runtime membership exists. */
    sealedReceiverSessions?: readonly VcMeetingSealedReceiverSessionBinding[];
  },
  now = Date.now(),
): VcMeetingImRoutingResult {
  const active = listDurableVcMeetingImRoutingCandidates(dataDir, input, now);
  if (active.length > 0) {
    return selectVcMeetingImRoutingCandidate(active, input.disambiguation);
  }
  return selectVcMeetingImRoutingCandidate(listSealedVcMeetingImRoutingCandidates(
    dataDir,
    {
      listenerChatId: input.listenerChatId,
      agentAppId: input.agentAppId,
      receiverSessions: input.sealedReceiverSessions ?? [],
    },
    now,
  ), input.disambiguation);
}

function catchUpErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error ?? '').trim();
  return text || 'catch_up_failed';
}

/**
 * Attempt the selected meeting's seal/wake catch-up within a strict budget.
 * Failure and timeout still return the receiver route, but with the explicit
 * `meetingContextMayLag=true` contract required by the IM prompt/turn metadata.
 */
export async function runBoundedVcMeetingImCatchUp(
  route: VcMeetingImRoutingResult,
  catchUp: VcMeetingImCatchUp | undefined,
  timeoutMs = DEFAULT_VC_MEETING_IM_CATCH_UP_TIMEOUT_MS,
): Promise<VcMeetingImRoutingResult> {
  if (route.kind !== 'receiver') return route;
  if (route.candidate.lifecycle === 'sealed') {
    return {
      ...route,
      meetingContextMayLag: false,
      catchUpStatus: 'succeeded',
      catchUpError: undefined,
    };
  }
  if (!catchUp) return route;
  const budgetMs = Number.isFinite(timeoutMs)
    ? Math.min(MAX_VC_MEETING_IM_CATCH_UP_TIMEOUT_MS, Math.max(0, Math.floor(timeoutMs)))
    : DEFAULT_VC_MEETING_IM_CATCH_UP_TIMEOUT_MS;
  if (budgetMs === 0) {
    return {
      ...route,
      meetingContextMayLag: true,
      catchUpStatus: 'timed_out',
      catchUpError: 'catch_up_timeout',
    };
  }

  const controller = new AbortController();
  const work = Promise.resolve()
    .then(() => catchUp(route.candidate, { signal: controller.signal }))
    .then(result => {
      const normalized = typeof result === 'boolean' ? { ok: result } : result;
      return normalized.ok
        ? { kind: 'succeeded' as const }
        : { kind: 'failed' as const, error: normalized.error ?? 'catch_up_failed' };
    })
    .catch(error => ({ kind: 'failed' as const, error: catchUpErrorMessage(error) }));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: 'timed_out' }>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timed_out' }), budgetMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  const outcome = await Promise.race([work, timeout]);
  if (timer) clearTimeout(timer);

  if (outcome.kind === 'succeeded') {
    return {
      ...route,
      meetingContextMayLag: false,
      catchUpStatus: 'succeeded',
      catchUpError: undefined,
    };
  }
  if (outcome.kind === 'timed_out') {
    controller.abort();
    return {
      ...route,
      meetingContextMayLag: true,
      catchUpStatus: 'timed_out',
      catchUpError: 'catch_up_timeout',
    };
  }
  return {
    ...route,
    meetingContextMayLag: true,
    catchUpStatus: 'failed',
    catchUpError: outcome.error,
  };
}
