import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listDurableVcMeetingImRoutingCandidates,
  listSealedVcMeetingImRoutingCandidates,
  resolveDurableVcMeetingImRouting,
  runBoundedVcMeetingImCatchUp,
  selectVcMeetingImRoutingCandidate,
  type VcMeetingImRoutingCandidate,
} from '../src/services/vc-meeting-im-routing.js';
import {
  applyVcMeetingMemberProjection,
  type VcMeetingMemberProjectionInput,
} from '../src/services/vc-meeting-delivery-store.js';
import {
  applyVcMeetingHubMemberProjection,
  freezeVcMeetingHubDeliveryAssignment,
  observeVcMeetingHubReceiverReceipt,
  updateVcMeetingHubCloseState,
} from '../src/services/vc-meeting-delivery-hub-store.js';
import {
  recordVcMeetingRuntimeSession,
  type VcMeetingRuntimeSelectedAgent,
} from '../src/services/vc-meeting-runtime-store.js';
import {
  MAX_VC_MEETING_LISTENER_MESSAGES,
  listVcMeetingListenerMessageIds,
  recordVcMeetingListenerMessage,
} from '../src/services/vc-meeting-listener-message-store.js';

const LISTENER = 'listener-app';
const CHAT = 'listener-chat';
const AGENT = 'agent-app';

function candidate(
  meetingId: string,
  overrides: Partial<VcMeetingImRoutingCandidate> = {},
): VcMeetingImRoutingCandidate {
  return {
    lifecycle: 'active',
    listenerAppId: LISTENER,
    listenerChatId: CHAT,
    meetingId,
    meetingNo: `no-${meetingId}`,
    topic: `Topic ${meetingId}`,
    memberId: `member-${meetingId}`,
    memberEpoch: 1,
    ownerBootId: 'owner-boot-1',
    ownerEpoch: 1,
    membershipGeneration: 1,
    sinkOwnerGeneration: 1,
    agentAppId: AGENT,
    receiverSessionId: `receiver-${meetingId}`,
    responseMode: 'silent',
    knownListenerMessageIds: [`card-${meetingId}`],
    ...overrides,
  };
}

function sealHubMeeting(dir: string, meetingId: string, closedAt = 2_000): void {
  expect(applyVcMeetingHubMemberProjection(dir, {
    listenerAppId: LISTENER,
    meetingId,
    memberId: `member-${meetingId}`,
    memberEpoch: 1,
    ownerBootId: 'owner-boot-1',
    ownerEpoch: 1,
    agentAppId: AGENT,
    role: 'minutes',
    deliveryProfileHash: `sha256:${'a'.repeat(64)}`,
    membershipGeneration: 1,
    status: 'active',
    responseMode: 'silent',
    capabilities: ['meeting.read'],
    ownedSinks: [],
    sinkOwnerGeneration: 1,
    joinedAtIngestSeq: 0,
    receiverSessionId: `receiver-${meetingId}`,
    outputChatId: CHAT,
  }, 1_000)).toMatchObject({ ok: true });
  const deliveryKey = `vc_${'f'.repeat(47)}`;
  const inputHash = `sha256:${'b'.repeat(64)}`;
  expect(freezeVcMeetingHubDeliveryAssignment(dir, {
    listenerAppId: LISTENER,
    meetingId,
    memberId: `member-${meetingId}`,
    memberEpoch: 1,
    ownerBootId: 'owner-boot-1',
    ownerEpoch: 1,
    membershipGeneration: 1,
    deliveryKey,
    inputHash,
    fromSeq: 1,
    toSeq: 1,
    batchId: `final-${meetingId}`,
    final: true,
    entries: [{
      deliverySeq: 1,
      kind: 'final',
      renderedTextHash: `sha256:${'c'.repeat(64)}`,
    }],
    renderContext: { timeZone: 'Asia/Singapore', authorizedActorIds: [] },
    instructionVersion: 'vc-delivery-v1',
    target: { sessionId: `receiver-${meetingId}`, chatId: CHAT },
  }, 1_100)).toMatchObject({ kind: 'frozen' });
  expect(observeVcMeetingHubReceiverReceipt(dir, {
    listenerAppId: LISTENER,
    meetingId,
    memberId: `member-${meetingId}`,
    memberEpoch: 1,
    ownerBootId: 'owner-boot-1',
    ownerEpoch: 1,
    deliveryKey,
    inputHash,
    fromSeq: 1,
    toSeq: 1,
    status: 'completed',
    receiverCommittedThrough: 1,
  }, 1_200)).toMatchObject({ ok: true, kind: 'acked' });
  for (const phase of ['data_closing', 'finalizing', 'closed'] as const) {
    expect(updateVcMeetingHubCloseState(dir, {
      listenerAppId: LISTENER,
      meetingId,
      ownerBootId: 'owner-boot-1',
      ownerEpoch: 1,
      phase,
    }, phase === 'closed' ? closedAt : closedAt - (phase === 'finalizing' ? 100 : 200)))
      .toMatchObject({ ok: true });
  }
}

function selectedAgent(
  meetingId: string,
  status: VcMeetingRuntimeSelectedAgent['status'] = 'active',
): VcMeetingRuntimeSelectedAgent {
  return {
    profileId: `profile-${meetingId}`,
    memberId: `member-${meetingId}`,
    agentAppId: AGENT,
    role: 'minutes',
    status,
    responseMode: 'silent',
    capabilities: ['meeting.read'],
    ownedSinks: [],
  };
}

function projection(
  meetingId: string,
  overrides: Partial<VcMeetingMemberProjectionInput> = {},
): VcMeetingMemberProjectionInput {
  return {
    listenerAppId: LISTENER,
    meetingId,
    ownerBootId: 'owner-boot-1',
    ownerEpoch: 1,
    memberId: `member-${meetingId}`,
    agentAppId: AGENT,
    role: 'minutes',
    memberEpoch: 1,
    membershipGeneration: 1,
    status: 'active',
    responseMode: 'silent',
    capabilities: ['meeting.read'],
    ownedSinks: [],
    sinkOwnerGeneration: 1,
    joinedAtIngestSeq: 0,
    receiverSessionId: `receiver-${meetingId}`,
    outputChatId: CHAT,
    ...overrides,
  };
}

describe('vc meeting IM routing', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-vc-im-routing-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('durable membership discovery', () => {
    function persistRuntime(
      meetingId: string,
      opts: { status?: VcMeetingRuntimeSelectedAgent['status']; cardId?: string; now?: number } = {},
    ): void {
      recordVcMeetingRuntimeSession(dir, {
        larkAppId: LISTENER,
        meeting: { id: meetingId, meetingNo: `no-${meetingId}`, topic: `Topic ${meetingId}` },
        listenerChatId: CHAT,
        consumerMode: 'agent',
        selectedAgents: [selectedAgent(meetingId, opts.status)],
        ...(opts.cardId ? { consumerCardMessageId: opts.cardId } : {}),
      }, opts.now ?? 1_000);
    }

    it('requires runtime and latest receiver projection to agree, and returns a stable order', () => {
      // Deliberately make z newer: routing order must not be "latest wins".
      persistRuntime('z-meeting', { now: 9_000, cardId: 'card-z' });
      persistRuntime('a-meeting', { now: 1_000, cardId: 'card-a' });
      expect(applyVcMeetingMemberProjection(dir, projection('z-meeting'), 9_000)).toMatchObject({ ok: true });
      expect(applyVcMeetingMemberProjection(dir, projection('a-meeting'), 1_000)).toMatchObject({ ok: true });

      const found = listDurableVcMeetingImRoutingCandidates(
        dir,
        { listenerChatId: CHAT, agentAppId: AGENT },
        10_000,
      );
      expect(found.map(item => item.meetingId)).toEqual(['a-meeting', 'z-meeting']);
      expect(found[0]).toMatchObject({
        receiverSessionId: 'receiver-a-meeting',
        knownListenerMessageIds: ['card-a'],
      });
    });

    it('indexes ordinary meeting-owned outputs for quote disambiguation in the listener chat', () => {
      persistRuntime('m1', { cardId: 'card-m1' });
      persistRuntime('m2', { cardId: 'card-m2' });
      expect(applyVcMeetingMemberProjection(dir, projection('m1'), 1_000)).toMatchObject({ ok: true });
      expect(applyVcMeetingMemberProjection(dir, projection('m2'), 1_000)).toMatchObject({ ok: true });
      expect(recordVcMeetingListenerMessage(dir, {
        listenerAppId: LISTENER,
        meetingId: 'm2',
        targetChatId: CHAT,
        messageId: 'om_m2_ordinary_output',
      }, 1_100)).toMatchObject({ ok: true, kind: 'recorded' });
      // A detoured output may be durable, but it cannot claim ownership in the
      // listener chat used by this routing candidate.
      expect(recordVcMeetingListenerMessage(dir, {
        listenerAppId: LISTENER,
        meetingId: 'm1',
        targetChatId: 'different-chat',
        messageId: 'om_m1_elsewhere',
      }, 1_200)).toMatchObject({ ok: true });

      const found = listDurableVcMeetingImRoutingCandidates(
        dir,
        { listenerChatId: CHAT, agentAppId: AGENT },
        2_000,
      );
      expect(found.find(item => item.meetingId === 'm2')?.knownListenerMessageIds)
        .toEqual(['card-m2', 'om_m2_ordinary_output']);
      expect(found.find(item => item.meetingId === 'm1')?.knownListenerMessageIds)
        .not.toContain('om_m1_elsewhere');
      expect(selectVcMeetingImRoutingCandidate(found, {
        quotedMessageId: 'om_m2_ordinary_output',
      })).toMatchObject({
        kind: 'receiver', selectedBy: 'quote', candidate: { meetingId: 'm2' },
      });
    });

    it('keeps the listener-message index bounded, deduplicated, and ownership-stable', () => {
      const owner = { listenerAppId: LISTENER, meetingId: 'm1', targetChatId: CHAT };
      expect(recordVcMeetingListenerMessage(dir, { ...owner, messageId: 'om_same' }, 1))
        .toMatchObject({ ok: true, kind: 'recorded' });
      expect(recordVcMeetingListenerMessage(dir, { ...owner, messageId: 'om_same' }, 2))
        .toMatchObject({ ok: true, kind: 'existing' });
      expect(recordVcMeetingListenerMessage(dir, {
        ...owner,
        meetingId: 'm2',
        messageId: 'om_same',
      }, 3)).toEqual({ ok: false, reason: 'owner_conflict' });
      for (let index = 0; index < MAX_VC_MEETING_LISTENER_MESSAGES + 2; index += 1) {
        expect(recordVcMeetingListenerMessage(dir, {
          ...owner,
          messageId: `om_bounded_${index}`,
        }, 10 + index)).toMatchObject({ ok: true });
      }
      const ids = listVcMeetingListenerMessageIds(dir, owner);
      expect(ids).toHaveLength(MAX_VC_MEETING_LISTENER_MESSAGES);
      expect(ids).not.toContain('om_same');
      expect(ids).not.toContain('om_bounded_0');
      expect(ids).toContain(`om_bounded_${MAX_VC_MEETING_LISTENER_MESSAGES + 1}`);
    });

    it('fails closed without overwriting a corrupt listener-message index', () => {
      const owner = { listenerAppId: LISTENER, meetingId: 'm1', targetChatId: CHAT };
      expect(recordVcMeetingListenerMessage(dir, { ...owner, messageId: 'om_first' }, 1))
        .toMatchObject({ ok: true });
      const file = join(
        dir,
        'vc-meeting-listener-messages',
        `${LISTENER}__${CHAT}.json`,
      );
      writeFileSync(file, '{corrupt');
      expect(() => listVcMeetingListenerMessageIds(dir, owner)).toThrow(/index is unreadable/);
      expect(() => recordVcMeetingListenerMessage(
        dir,
        { ...owner, messageId: 'om_must_not_replace' },
        2,
      )).toThrow(/index is unreadable/);
      expect(readFileSync(file, 'utf8')).toBe('{corrupt');
    });

    it('excludes runtime-only, paused, mismatched-chat, and superseded memberships', () => {
      persistRuntime('runtime-only');

      persistRuntime('paused', { status: 'paused' });
      expect(applyVcMeetingMemberProjection(dir, projection('paused'), 1_000)).toMatchObject({ ok: true });

      persistRuntime('wrong-chat');
      expect(applyVcMeetingMemberProjection(
        dir,
        projection('wrong-chat', { outputChatId: 'different-chat' }),
        1_000,
      )).toMatchObject({ ok: true });

      persistRuntime('removed');
      expect(applyVcMeetingMemberProjection(dir, projection('removed'), 1_000)).toMatchObject({ ok: true });
      expect(applyVcMeetingMemberProjection(dir, projection('removed', {
        memberEpoch: 2,
        membershipGeneration: 2,
        status: 'removed',
        receiverSessionId: 'receiver-removed-v2',
      }), 2_000)).toMatchObject({ ok: true });

      // Select the latest epoch before checking agent identity. Otherwise an
      // old active epoch for AGENT could be revived after member reassignment.
      persistRuntime('reassigned');
      expect(applyVcMeetingMemberProjection(dir, projection('reassigned'), 1_000)).toMatchObject({ ok: true });
      expect(applyVcMeetingMemberProjection(dir, projection('reassigned', {
        memberEpoch: 2,
        membershipGeneration: 2,
        agentAppId: 'different-agent',
        receiverSessionId: 'receiver-reassigned-v2',
      }), 2_000)).toMatchObject({ ok: true });

      expect(listDurableVcMeetingImRoutingCandidates(
        dir,
        { listenerChatId: CHAT, agentAppId: AGENT },
        3_000,
      )).toEqual([]);
    });

    it('resolves directly from durable stores without consulting daemon sessions', () => {
      persistRuntime('m1');
      expect(applyVcMeetingMemberProjection(dir, projection('m1'), 1_000)).toMatchObject({ ok: true });

      expect(resolveDurableVcMeetingImRouting(dir, {
        listenerChatId: CHAT,
        agentAppId: AGENT,
      }, 2_000)).toMatchObject({
        kind: 'receiver',
        selectedBy: 'only_active',
        candidate: { meetingId: 'm1', receiverSessionId: 'receiver-m1' },
        meetingContextMayLag: true,
        catchUpStatus: 'not_attempted',
      });
    });

    it('keeps the legacy single-consumer membership routable', () => {
      recordVcMeetingRuntimeSession(dir, {
        larkAppId: LISTENER,
        meeting: { id: 'legacy' },
        listenerChatId: CHAT,
        consumerMode: 'agent',
        selectedAgentAppId: AGENT,
      }, 1_000);
      expect(applyVcMeetingMemberProjection(dir, {
        listenerAppId: LISTENER,
        meetingId: 'legacy',
        ownerBootId: 'owner-boot-1',
        ownerEpoch: 1,
        memberId: 'meeting_assistant',
        agentAppId: AGENT,
        role: 'meeting_assistant',
        memberEpoch: 1,
        membershipGeneration: 1,
        status: 'active',
        responseMode: 'listener_thread',
        joinedAtIngestSeq: 0,
        receiverSessionId: 'receiver-legacy',
        outputChatId: CHAT,
      }, 1_000)).toMatchObject({ ok: true });

      expect(listDurableVcMeetingImRoutingCandidates(
        dir,
        { listenerChatId: CHAT, agentAppId: AGENT },
        2_000,
      )).toMatchObject([{
        meetingId: 'legacy',
        memberId: 'meeting_assistant',
        receiverSessionId: 'receiver-legacy',
      }]);
    });

    it('derives a sealed route only from an active dedicated session plus final-acked closed hub state', () => {
      const meetingId = 'sealed';
      expect(applyVcMeetingMemberProjection(dir, projection(meetingId), 1_000))
        .toMatchObject({ ok: true });
      expect(recordVcMeetingListenerMessage(dir, {
        listenerAppId: LISTENER,
        meetingId,
        targetChatId: CHAT,
        messageId: 'om_sealed_output',
      }, 1_500)).toMatchObject({ ok: true });
      sealHubMeeting(dir, meetingId, 2_000);
      const binding = {
        listenerAppId: LISTENER,
        listenerChatId: CHAT,
        meetingId,
        memberId: `member-${meetingId}`,
        memberEpoch: 1,
        agentAppId: AGENT,
        receiverSessionId: `receiver-${meetingId}`,
      };

      expect(listSealedVcMeetingImRoutingCandidates(dir, {
        listenerChatId: CHAT,
        agentAppId: AGENT,
        receiverSessions: [binding],
      }, 2_500)).toMatchObject([{
        lifecycle: 'sealed',
        meetingId,
        receiverSessionId: `receiver-${meetingId}`,
        knownListenerMessageIds: ['om_sealed_output'],
      }]);
      expect(resolveDurableVcMeetingImRouting(dir, {
        listenerChatId: CHAT,
        agentAppId: AGENT,
        sealedReceiverSessions: [binding],
      }, 2_500)).toMatchObject({
        kind: 'receiver',
        selectedBy: 'only_sealed',
        candidate: { lifecycle: 'sealed', meetingId },
      });

      // The sealed capture expires after the historical runtime routing TTL.
      expect(listSealedVcMeetingImRoutingCandidates(dir, {
        listenerChatId: CHAT,
        agentAppId: AGENT,
        receiverSessions: [binding],
      }, 3_001, 1_000)).toEqual([]);
      // Session/projection identity mismatch fails closed.
      expect(listSealedVcMeetingImRoutingCandidates(dir, {
        listenerChatId: CHAT,
        agentAppId: AGENT,
        receiverSessions: [{ ...binding, memberEpoch: 2 }],
      }, 2_500)).toEqual([]);
    });

    it('keeps a live runtime membership ahead of sealed history in the same listener chat', () => {
      persistRuntime('live');
      expect(applyVcMeetingMemberProjection(dir, projection('live'), 1_000))
        .toMatchObject({ ok: true });
      expect(applyVcMeetingMemberProjection(dir, projection('sealed'), 1_000))
        .toMatchObject({ ok: true });
      sealHubMeeting(dir, 'sealed', 2_000);

      expect(resolveDurableVcMeetingImRouting(dir, {
        listenerChatId: CHAT,
        agentAppId: AGENT,
        sealedReceiverSessions: [{
          listenerAppId: LISTENER,
          listenerChatId: CHAT,
          meetingId: 'sealed',
          memberId: 'member-sealed',
          memberEpoch: 1,
          agentAppId: AGENT,
          receiverSessionId: 'receiver-sealed',
        }],
      }, 2_500)).toMatchObject({
        kind: 'receiver',
        selectedBy: 'only_active',
        candidate: { lifecycle: 'active', meetingId: 'live' },
      });
    });

    it('treats a hub-closed runtime residue as sealed instead of attempting live catch-up', () => {
      persistRuntime('crash-residue');
      expect(applyVcMeetingMemberProjection(dir, projection('crash-residue'), 1_000))
        .toMatchObject({ ok: true });
      sealHubMeeting(dir, 'crash-residue', 2_000);

      expect(resolveDurableVcMeetingImRouting(dir, {
        listenerChatId: CHAT,
        agentAppId: AGENT,
        sealedReceiverSessions: [{
          listenerAppId: LISTENER,
          listenerChatId: CHAT,
          meetingId: 'crash-residue',
          memberId: 'member-crash-residue',
          memberEpoch: 1,
          agentAppId: AGENT,
          receiverSessionId: 'receiver-crash-residue',
        }],
      }, 2_500)).toMatchObject({
        kind: 'receiver',
        selectedBy: 'only_sealed',
        candidate: { lifecycle: 'sealed', meetingId: 'crash-residue' },
      });
    });
  });

  describe('deterministic disambiguation', () => {
    it('keeps ordinary routing with no active membership', () => {
      expect(selectVcMeetingImRoutingCandidate([])).toEqual({
        kind: 'ordinary',
        reason: 'no_active_membership',
        candidates: [],
      });
    });

    it('routes the only active membership and defaults to lag-honest metadata', () => {
      expect(selectVcMeetingImRoutingCandidate([candidate('m1')])).toMatchObject({
        kind: 'receiver',
        selectedBy: 'only_active',
        candidate: { meetingId: 'm1' },
        meetingContextMayLag: true,
        catchUpStatus: 'not_attempted',
      });
    });

    it('never silently chooses a recent/first membership when multiple are active', () => {
      const route = selectVcMeetingImRoutingCandidate([candidate('z'), candidate('a')]);
      expect(route).toMatchObject({ kind: 'ambiguous', reason: 'multiple_active' });
      if (route.kind === 'ambiguous') {
        expect(route.candidates.map(item => item.meetingId)).toEqual(['a', 'z']);
      }
    });

    it('never silently chooses among multiple sealed meeting contexts', () => {
      const route = selectVcMeetingImRoutingCandidate([
        candidate('z', { lifecycle: 'sealed' }),
        candidate('a', { lifecycle: 'sealed' }),
      ]);
      expect(route).toMatchObject({ kind: 'ambiguous', reason: 'multiple_sealed' });
    });

    it('selects by a recognized quoted listener message or resolved quote meeting id', () => {
      const candidates = [candidate('m1'), candidate('m2')];
      expect(selectVcMeetingImRoutingCandidate(candidates, {
        quotedMessageId: 'card-m2',
      })).toMatchObject({
        kind: 'receiver', selectedBy: 'quote', candidate: { meetingId: 'm2' },
      });
      expect(selectVcMeetingImRoutingCandidate(candidates, {
        quotedMeetingId: 'm1',
      })).toMatchObject({
        kind: 'receiver', selectedBy: 'quote', candidate: { meetingId: 'm1' },
      });
    });

    it('selects by explicit id, meeting number, or an exact text token', () => {
      const candidates = [
        candidate('meeting-123', { meetingNo: '987654321' }),
        candidate('meeting-456', { meetingNo: '123456789' }),
      ];
      expect(selectVcMeetingImRoutingCandidate(candidates, {
        explicitMeetingId: '123456789',
      })).toMatchObject({
        kind: 'receiver', selectedBy: 'meeting_reference', candidate: { meetingId: 'meeting-456' },
      });
      expect(selectVcMeetingImRoutingCandidate(candidates, {
        messageText: '@agent 请总结 meeting-123 的决定',
      })).toMatchObject({
        kind: 'receiver', selectedBy: 'meeting_reference', candidate: { meetingId: 'meeting-123' },
      });
      expect(selectVcMeetingImRoutingCandidate(candidates, {
        messageText: '这不是完整 id: xmeeting-123y',
      })).toMatchObject({ kind: 'ambiguous', reason: 'multiple_active' });
    });

    it('blocks unknown, non-unique, and conflicting explicit references', () => {
      const candidates = [candidate('m1'), candidate('m2')];
      expect(selectVcMeetingImRoutingCandidate(candidates, {
        explicitMeetingId: 'missing',
      })).toMatchObject({ kind: 'ambiguous', reason: 'reference_not_found' });
      expect(selectVcMeetingImRoutingCandidate([
        candidate('same', { memberId: 'member-a', receiverSessionId: 'receiver-a' }),
        candidate('same', { memberId: 'member-b', receiverSessionId: 'receiver-b' }),
      ], {
        explicitMeetingId: 'same',
      })).toMatchObject({ kind: 'ambiguous', reason: 'reference_not_unique' });
      expect(selectVcMeetingImRoutingCandidate(candidates, {
        quotedMessageId: 'card-m1',
        explicitMeetingId: 'm2',
      })).toMatchObject({ kind: 'ambiguous', reason: 'conflicting_references' });
    });

    it('does not treat an unrelated quote as meeting disambiguation', () => {
      expect(selectVcMeetingImRoutingCandidate([candidate('m1'), candidate('m2')], {
        quotedMessageId: 'ordinary-human-message',
      })).toMatchObject({ kind: 'ambiguous', reason: 'multiple_active' });
    });
  });

  describe('bounded catch-up decision', () => {
    it('does not catch up a final-acked sealed receiver', async () => {
      const selected = selectVcMeetingImRoutingCandidate([
        candidate('sealed', { lifecycle: 'sealed' }),
      ]);
      const catchUp = vi.fn(async () => ({ ok: false, error: 'must_not_run' }));
      await expect(runBoundedVcMeetingImCatchUp(selected, catchUp, 100)).resolves.toMatchObject({
        kind: 'receiver',
        selectedBy: 'only_sealed',
        meetingContextMayLag: false,
        catchUpStatus: 'succeeded',
      });
      expect(catchUp).not.toHaveBeenCalled();
    });

    it('marks context current only after successful catch-up', async () => {
      const selected = selectVcMeetingImRoutingCandidate([candidate('m1')]);
      const catchUp = vi.fn(async () => ({ ok: true }));
      await expect(runBoundedVcMeetingImCatchUp(selected, catchUp, 100)).resolves.toMatchObject({
        kind: 'receiver',
        meetingContextMayLag: false,
        catchUpStatus: 'succeeded',
      });
      expect(catchUp).toHaveBeenCalledWith(
        expect.objectContaining({ meetingId: 'm1' }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('preserves the route but marks lag on negative result or exception', async () => {
      const selected = selectVcMeetingImRoutingCandidate([candidate('m1')]);
      await expect(runBoundedVcMeetingImCatchUp(
        selected,
        async () => ({ ok: false, error: 'hub_offline' }),
        100,
      )).resolves.toMatchObject({
        kind: 'receiver', meetingContextMayLag: true, catchUpStatus: 'failed', catchUpError: 'hub_offline',
      });
      await expect(runBoundedVcMeetingImCatchUp(
        selected,
        async () => { throw new Error('transport_failed'); },
        100,
      )).resolves.toMatchObject({
        kind: 'receiver', meetingContextMayLag: true, catchUpStatus: 'failed', catchUpError: 'transport_failed',
      });
    });

    it('returns on timeout, aborts best-effort, and marks context as possibly stale', async () => {
      const selected = selectVcMeetingImRoutingCandidate([candidate('m1')]);
      let signal: AbortSignal | undefined;
      const pending = runBoundedVcMeetingImCatchUp(selected, async (_candidate, context) => {
        signal = context.signal;
        return await new Promise<boolean>(() => { /* intentionally never settles */ });
      }, 5);
      await expect(pending).resolves.toMatchObject({
        kind: 'receiver',
        meetingContextMayLag: true,
        catchUpStatus: 'timed_out',
        catchUpError: 'catch_up_timeout',
      });
      expect(signal?.aborted).toBe(true);
    });

    it('does not invoke catch-up for ordinary or ambiguous routing', async () => {
      const catchUp = vi.fn(async () => true);
      const ordinary = selectVcMeetingImRoutingCandidate([]);
      const ambiguous = selectVcMeetingImRoutingCandidate([candidate('m1'), candidate('m2')]);
      await expect(runBoundedVcMeetingImCatchUp(ordinary, catchUp)).resolves.toBe(ordinary);
      await expect(runBoundedVcMeetingImCatchUp(ambiguous, catchUp)).resolves.toBe(ambiguous);
      expect(catchUp).not.toHaveBeenCalled();
    });
  });
});
