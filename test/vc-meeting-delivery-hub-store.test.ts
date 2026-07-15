import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyVcMeetingHubMemberProjection,
  freezeVcMeetingHubDeliveryAssignment,
  getVcMeetingHubCloseState,
  getVcMeetingHubDeliveryAssignment,
  getVcMeetingHubMember,
  listVcMeetingHubMembers,
  observeVcMeetingHubReceiverReceipt,
  updateVcMeetingHubCloseState,
  type VcMeetingHubFreezeInput,
  type VcMeetingHubMemberProjectionInput,
  type VcMeetingHubReceiptObservationInput,
} from '../src/services/vc-meeting-delivery-hub-store.js';
import { logger } from '../src/utils/logger.js';

const LISTENER = 'cli_listener';
const MEETING = '7657000000000000999';
const MEMBER = 'minutes';
const KEY = { listenerAppId: LISTENER, meetingId: MEETING, memberId: MEMBER, memberEpoch: 1 };

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function deliveryKey(seed = 'a'): string {
  return `vc_${seed.repeat(47).slice(0, 47)}`;
}

function projection(
  overrides: Partial<VcMeetingHubMemberProjectionInput> = {},
): VcMeetingHubMemberProjectionInput {
  return {
    listenerAppId: LISTENER,
    meetingId: MEETING,
    memberId: MEMBER,
    memberEpoch: 1,
    ownerBootId: 'hub-boot-a',
    ownerEpoch: 1,
    agentAppId: 'cli_agent',
    role: 'minutes',
    deliveryProfileHash: hash('profile:minutes:all-items'),
    membershipGeneration: 1,
    status: 'active',
    responseMode: 'silent',
    capabilities: ['listener.output.request', 'meeting.read'],
    ownedSinks: [],
    sinkOwnerGeneration: 1,
    joinedAtIngestSeq: 0,
    receiverSessionId: 'receiver-session-1',
    outputChatId: 'oc_listener',
    ...overrides,
  };
}

function assignment(overrides: Partial<VcMeetingHubFreezeInput> = {}): VcMeetingHubFreezeInput {
  return {
    ...KEY,
    ownerBootId: 'hub-boot-a',
    ownerEpoch: 1,
    membershipGeneration: 1,
    deliveryKey: deliveryKey('a'),
    inputHash: hash('envelope-1'),
    fromSeq: 1,
    toSeq: 2,
    batchId: 'batch-1',
    final: false,
    entries: [
      {
        deliverySeq: 1,
        ingestSeq: 11,
        itemVersionKey: 'sentence-1:r1',
        contentHash: hash('source one'),
        renderedTextHash: hash('render one'),
        kind: 'item',
      },
      {
        deliverySeq: 2,
        ingestSeq: 15,
        itemVersionKey: 'chat-9:r1',
        contentHash: hash('source two'),
        renderedTextHash: hash('render two'),
        kind: 'item',
      },
    ],
    renderContext: { timeZone: 'Asia/Singapore', authorizedActorIds: ['alice', 'owner'] },
    instructionVersion: 'vc-delivery-v1',
    target: { sessionId: 'receiver-session-1', chatId: 'oc_listener' },
    ...overrides,
  };
}

function observation(
  overrides: Partial<VcMeetingHubReceiptObservationInput> = {},
): VcMeetingHubReceiptObservationInput {
  return {
    ...KEY,
    ownerBootId: 'hub-boot-a',
    ownerEpoch: 1,
    deliveryKey: deliveryKey('a'),
    inputHash: hash('envelope-1'),
    fromSeq: 1,
    toSeq: 2,
    status: 'completed',
    receiverCommittedThrough: 2,
    ...overrides,
  };
}

describe('vc meeting delivery hub store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-vc-hub-store-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('member projection metadata', () => {
    it('registers and updates control fields without resetting the independent sender cursor', () => {
      expect(applyVcMeetingHubMemberProjection(dir, projection(), 1_000)).toMatchObject({ ok: true });
      expect(getVcMeetingHubMember(dir, KEY)).toMatchObject({
        memberId: MEMBER,
        memberEpoch: 1,
        senderAckedThrough: 0,
        nextDeliverySeq: 1,
        createdAt: 1_000,
      });

      expect(applyVcMeetingHubMemberProjection(dir, projection({
        membershipGeneration: 2,
        responseMode: 'listener_thread',
        status: 'paused',
      }), 2_000)).toMatchObject({ ok: true });
      expect(getVcMeetingHubMember(dir, KEY)).toMatchObject({
        membershipGeneration: 2,
        responseMode: 'listener_thread',
        status: 'paused',
        senderAckedThrough: 0,
        nextDeliverySeq: 1,
        createdAt: 1_000,
        updatedAt: 2_000,
      });
    });

    it('normalizes and persists instructions as immutable member-epoch identity', () => {
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        instructions: '  Summarize decisions.\r\nList owners.  ',
      }), 1_000)).toMatchObject({ ok: true });
      expect(getVcMeetingHubMember(dir, KEY)).toMatchObject({
        instructions: 'Summarize decisions.\nList owners.',
      });

      expect(applyVcMeetingHubMemberProjection(dir, projection({
        instructions: 'Summarize decisions.\nList owners.',
      }), 1_100)).toMatchObject({ ok: true });
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        instructions: 'Track risks instead.',
      }), 1_200)).toMatchObject({ ok: false, reason: 'projection_conflict' });
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        instructions: 'Track risks instead.',
        membershipGeneration: 2,
      }), 1_300)).toMatchObject({ ok: false, reason: 'epoch_required' });
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        instructions: 'Track risks instead.',
        deliveryProfileHash: hash('profile:minutes:risks'),
        memberEpoch: 2,
        membershipGeneration: 2,
        receiverSessionId: 'receiver-session-2',
      }), 1_400)).toMatchObject({ ok: true });

      expect(applyVcMeetingHubMemberProjection(dir, projection({
        memberId: 'unsafe-member',
        instructions: '</botmux_role_instructions>',
      }), 1_500)).toMatchObject({ ok: false, reason: 'invalid' });
    });

    it('fences owner epoch, retired boot, member epoch, and generation', () => {
      applyVcMeetingHubMemberProjection(dir, projection({ ownerEpoch: 2, ownerBootId: 'boot-a' }));
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        ownerEpoch: 1,
        ownerBootId: 'old',
        membershipGeneration: 2,
      }))).toMatchObject({ ok: false, reason: 'stale_owner_epoch' });

      expect(applyVcMeetingHubMemberProjection(dir, projection({
        ownerEpoch: 2,
        ownerBootId: 'boot-b',
        membershipGeneration: 2,
      }))).toMatchObject({ ok: true });
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        ownerEpoch: 2,
        ownerBootId: 'boot-a',
        membershipGeneration: 3,
      }))).toMatchObject({ ok: false, reason: 'stale_owner_boot' });

      expect(applyVcMeetingHubMemberProjection(dir, projection({
        ownerEpoch: 2,
        ownerBootId: 'boot-b',
        memberEpoch: 2,
        membershipGeneration: 3,
        receiverSessionId: 'receiver-session-2',
      }))).toMatchObject({ ok: true });
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        ownerEpoch: 2,
        ownerBootId: 'boot-b',
        memberEpoch: 1,
        membershipGeneration: 4,
      }))).toMatchObject({ ok: false, reason: 'stale_member_epoch' });
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        ownerEpoch: 2,
        ownerBootId: 'boot-b',
        memberEpoch: 2,
        membershipGeneration: 2,
        receiverSessionId: 'receiver-session-2',
      }))).toMatchObject({ ok: false, reason: 'stale_membership_generation' });
    });

    it('requires a generation for control changes and a new epoch for stream identity changes', () => {
      applyVcMeetingHubMemberProjection(dir, projection());
      expect(applyVcMeetingHubMemberProjection(dir, projection({ status: 'paused' })))
        .toMatchObject({ ok: false, reason: 'projection_conflict' });
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        membershipGeneration: 2,
        receiverSessionId: 'hijack',
      }))).toMatchObject({ ok: false, reason: 'epoch_required' });
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        membershipGeneration: 2,
        deliveryProfileHash: hash('profile:minutes:chat-only'),
      }))).toMatchObject({ ok: false, reason: 'epoch_required' });
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        memberEpoch: 2,
        membershipGeneration: 2,
        receiverSessionId: 'receiver-session-2',
      }))).toMatchObject({ ok: true });
    });

    it('fences filter semantics and sink ownership generation separately', () => {
      const outputCapabilities = ['listener.output.request', 'meeting.output.request', 'meeting.read'];
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        filter: { activityTypes: ['participant_joined', 'chat_received'] },
        capabilities: outputCapabilities,
      }))).toMatchObject({ ok: true });
      expect(getVcMeetingHubMember(dir, KEY)).toMatchObject({
        filter: { activityTypes: ['chat_received', 'participant_joined'] },
        capabilities: ['listener.output.request', 'meeting.output.request', 'meeting.read'],
      });
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        membershipGeneration: 2,
        filter: { activityTypes: ['participant_joined', 'chat_received'] },
        capabilities: outputCapabilities,
        ownedSinks: ['meeting_text'],
        sinkOwnerGeneration: 1,
      }))).toMatchObject({ ok: false, reason: 'stale_sink_owner_generation' });
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        membershipGeneration: 2,
        filter: { activityTypes: ['participant_joined', 'chat_received'] },
        capabilities: outputCapabilities,
        ownedSinks: ['meeting_text'],
        sinkOwnerGeneration: 2,
      }))).toMatchObject({ ok: true });
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        membershipGeneration: 3,
        filter: { activityTypes: ['chat_received'] },
        capabilities: outputCapabilities,
        ownedSinks: ['meeting_text'],
        sinkOwnerGeneration: 2,
      }))).toMatchObject({ ok: false, reason: 'epoch_required' });
    });

    it('enforces one durable profile owner per sink and synthesizes only exact legacy policy', () => {
      const owner = projection({
        capabilities: ['meeting.output.request', 'meeting.read'],
        ownedSinks: ['meeting_text'],
      });
      expect(applyVcMeetingHubMemberProjection(dir, owner)).toMatchObject({ ok: true });
      const contender = projection({
        memberId: 'actions',
        agentAppId: 'cli_actions',
        role: 'actions',
        deliveryProfileHash: hash('profile:actions'),
        receiverSessionId: 'receiver-actions',
        capabilities: ['meeting.output.request', 'meeting.read'],
        ownedSinks: ['meeting_text'],
      });
      expect(applyVcMeetingHubMemberProjection(dir, contender))
        .toMatchObject({ ok: false, reason: 'sink_owner_conflict' });
      expect(applyVcMeetingHubMemberProjection(dir, {
        ...owner,
        membershipGeneration: 2,
        status: 'removed',
      })).toMatchObject({ ok: true });
      expect(applyVcMeetingHubMemberProjection(dir, contender)).toMatchObject({ ok: true });

      const legacy = projection({
        memberId: 'meeting_assistant',
        agentAppId: 'cli_legacy',
        role: 'meeting_assistant',
        deliveryProfileHash: hash('legacy'),
        receiverSessionId: 'receiver-legacy',
        capabilities: undefined,
        ownedSinks: undefined,
        sinkOwnerGeneration: undefined,
      });
      // The active contender owns meeting_text, but exact P0 legacy epochs are
      // temporarily exempt from the profile-mode uniqueness migration.
      expect(applyVcMeetingHubMemberProjection(dir, legacy)).toMatchObject({
        ok: true,
        record: {
          capabilities: ['meeting.output.request', 'meeting.read'],
          ownedSinks: ['meeting_text', 'meeting_voice'],
          sinkOwnerGeneration: 1,
        },
      });
    });

    it('lets a new epoch supersede the same member sink owner without weakening cross-member conflicts', () => {
      const sinkOwner = projection({
        capabilities: ['meeting.output.request', 'meeting.read'],
        ownedSinks: ['meeting_text'],
      });
      expect(applyVcMeetingHubMemberProjection(dir, sinkOwner)).toMatchObject({ ok: true });

      const successor = projection({
        memberEpoch: 2,
        membershipGeneration: 2,
        receiverSessionId: 'receiver-session-2',
        capabilities: ['meeting.output.request', 'meeting.read'],
        ownedSinks: ['meeting_text'],
      });
      expect(applyVcMeetingHubMemberProjection(dir, successor)).toMatchObject({
        ok: true,
        record: { memberId: MEMBER, memberEpoch: 2, ownedSinks: ['meeting_text'] },
      });

      const trueContender = projection({
        memberId: 'actions',
        agentAppId: 'cli_actions',
        role: 'actions',
        deliveryProfileHash: hash('profile:actions'),
        receiverSessionId: 'receiver-actions',
        capabilities: ['meeting.output.request', 'meeting.read'],
        ownedSinks: ['meeting_text'],
      });
      expect(applyVcMeetingHubMemberProjection(dir, trueContender)).toMatchObject({
        ok: false,
        reason: 'sink_owner_conflict',
        detail: `meeting_text is already owned by ${MEMBER}@2`,
      });
    });

    it('keeps a removed epoch dead and validates inputs strictly', () => {
      applyVcMeetingHubMemberProjection(dir, projection());
      applyVcMeetingHubMemberProjection(dir, projection({ membershipGeneration: 2, status: 'removed' }));
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        membershipGeneration: 3,
        status: 'active',
      }))).toMatchObject({ ok: false, reason: 'epoch_removed' });
      expect(applyVcMeetingHubMemberProjection(dir, projection({ memberEpoch: 0 })))
        .toMatchObject({ ok: false, reason: 'invalid' });
      expect(applyVcMeetingHubMemberProjection(dir, projection({ memberId: ' padded ' })))
        .toMatchObject({ ok: false, reason: 'invalid' });
      expect(applyVcMeetingHubMemberProjection(dir, projection({ status: 'broken' as never })))
        .toMatchObject({ ok: false, reason: 'invalid' });
    });
  });

  describe('frozen assignments', () => {
    beforeEach(() => {
      applyVcMeetingHubMemberProjection(dir, projection(), 100);
    });

    it('freezes exactly one metadata-only envelope and replays it idempotently', () => {
      const withUntrustedRaw = assignment();
      (withUntrustedRaw.entries[0] as unknown as { rawText: string }).rawText = 'TOP SECRET TRANSCRIPT';
      expect(freezeVcMeetingHubDeliveryAssignment(dir, withUntrustedRaw, 150))
        .toMatchObject({ kind: 'conflict', reason: 'invalid' });

      const first = freezeVcMeetingHubDeliveryAssignment(dir, assignment(), 200);
      expect(first).toMatchObject({ kind: 'frozen', senderAckedThrough: 0 });
      expect(getVcMeetingHubMember(dir, KEY)).toMatchObject({
        senderAckedThrough: 0,
        nextDeliverySeq: 3,
        inFlight: { fromSeq: 1, toSeq: 2, instructionVersion: 'vc-delivery-v1' },
      });

      const second = freezeVcMeetingHubDeliveryAssignment(dir, assignment(), 300);
      expect(second).toMatchObject({ kind: 'existing', assignment: { createdAt: 200 } });

      const storeFile = join(dir, 'vc-meeting-delivery-hub', `${LISTENER}__${MEETING}.json`);
      const persisted = readFileSync(storeFile, 'utf8');
      expect(persisted).not.toContain('TOP SECRET TRANSCRIPT');
      expect(persisted).not.toContain('rawText');
      expect(persisted).toContain(hash('render one'));
      expect(statSync(storeFile).mode & 0o777).toBe(0o600);
    });

    it('rejects mutation of a frozen key and a second stream head', () => {
      freezeVcMeetingHubDeliveryAssignment(dir, assignment());
      expect(freezeVcMeetingHubDeliveryAssignment(dir, assignment({ instructionVersion: 'changed' })))
        .toMatchObject({ kind: 'conflict', reason: 'assignment_conflict' });
      expect(freezeVcMeetingHubDeliveryAssignment(dir, assignment({
        deliveryKey: deliveryKey('b'),
        inputHash: hash('envelope-2'),
      }))).toMatchObject({
        kind: 'conflict',
        reason: 'delivery_in_flight',
        activeDeliveryKey: deliveryKey('a'),
      });
    });

    it('keeps a frozen old-boot identity replayable while the current boot settles its ACK', () => {
      freezeVcMeetingHubDeliveryAssignment(dir, assignment(), 200);
      expect(applyVcMeetingHubMemberProjection(dir, projection({
        ownerBootId: 'hub-boot-b',
      }), 250)).toMatchObject({ ok: true });

      // Reconstruct the immutable envelope from this record: changing its
      // ownerBootId would also change inputHash/deliveryKey.
      expect(getVcMeetingHubDeliveryAssignment(dir, KEY)).toMatchObject({
        ownerBootId: 'hub-boot-a',
        deliveryKey: deliveryKey('a'),
      });
      expect(observeVcMeetingHubReceiverReceipt(dir, observation({
        ownerBootId: 'hub-boot-b',
      }), 300)).toMatchObject({ ok: true, kind: 'acked', senderAckedThrough: 2 });
    });

    it('requires the exact current owner, member generation, and receiver target', () => {
      expect(freezeVcMeetingHubDeliveryAssignment(dir, assignment({ ownerBootId: 'old' })))
        .toMatchObject({ kind: 'conflict', reason: 'stale_owner_boot' });
      expect(freezeVcMeetingHubDeliveryAssignment(dir, assignment({ ownerEpoch: 2 })))
        .toMatchObject({ kind: 'conflict', reason: 'owner_epoch_not_registered' });
      expect(freezeVcMeetingHubDeliveryAssignment(dir, assignment({ membershipGeneration: 2 })))
        .toMatchObject({ kind: 'conflict', reason: 'membership_generation_not_registered' });
      expect(freezeVcMeetingHubDeliveryAssignment(dir, assignment({
        target: { sessionId: 'wrong', chatId: 'oc_listener' },
      }))).toMatchObject({ kind: 'conflict', reason: 'target_mismatch' });

      applyVcMeetingHubMemberProjection(dir, projection({ membershipGeneration: 2, status: 'paused' }));
      expect(freezeVcMeetingHubDeliveryAssignment(dir, assignment({ membershipGeneration: 2 })))
        .toMatchObject({ kind: 'conflict', reason: 'membership_paused' });
    });

    it('enforces contiguous ranges, per-entry hashes, and final marker consistency', () => {
      expect(freezeVcMeetingHubDeliveryAssignment(dir, assignment({ fromSeq: 2, toSeq: 3,
        entries: assignment().entries.map((entry, index) => ({ ...entry, deliverySeq: index + 2 })),
      }))).toMatchObject({ kind: 'conflict', reason: 'delivery_gap', expectedFromSeq: 1 });

      expect(freezeVcMeetingHubDeliveryAssignment(dir, assignment({
        entries: [{ ...assignment().entries[0], renderedTextHash: 'not-a-hash' }, assignment().entries[1]],
      }))).toMatchObject({ kind: 'conflict', reason: 'invalid' });
      expect(freezeVcMeetingHubDeliveryAssignment(dir, assignment({ final: true })))
        .toMatchObject({ kind: 'conflict', reason: 'invalid' });

      const final = assignment({
        toSeq: 3,
        final: true,
        entries: [
          ...assignment().entries,
          { deliverySeq: 3, kind: 'final', renderedTextHash: hash('final render') },
        ],
      });
      expect(freezeVcMeetingHubDeliveryAssignment(dir, final)).toMatchObject({ kind: 'frozen' });
      expect(getVcMeetingHubMember(dir, KEY)?.finalAssignedSeq).toBe(3);
    });
  });

  describe('receiver observation and ACK', () => {
    beforeEach(() => {
      applyVcMeetingHubMemberProjection(dir, projection());
      freezeVcMeetingHubDeliveryAssignment(dir, assignment(), 100);
    });

    it('records non-terminal status but does not advance or release the sender cursor', () => {
      expect(observeVcMeetingHubReceiverReceipt(dir, observation({
        status: 'dispatched',
        receiverCommittedThrough: 0,
      }), 200)).toMatchObject({ ok: true, kind: 'observed', senderAckedThrough: 0 });
      expect(getVcMeetingHubMember(dir, KEY)).toMatchObject({
        senderAckedThrough: 0,
        nextDeliverySeq: 3,
        inFlight: { lastObservation: { status: 'dispatched', receiverCommittedThrough: 0 } },
      });
    });

    it('advances atomically only after completed has committed the whole frozen range', () => {
      expect(observeVcMeetingHubReceiverReceipt(dir, observation({ receiverCommittedThrough: 1 })))
        .toMatchObject({ ok: false, reason: 'receiver_cursor_short' });
      expect(getVcMeetingHubMember(dir, KEY)).toMatchObject({ senderAckedThrough: 0, inFlight: {} });

      expect(observeVcMeetingHubReceiverReceipt(dir, observation(), 300))
        .toMatchObject({ ok: true, kind: 'acked', senderAckedThrough: 2 });
      expect(getVcMeetingHubMember(dir, KEY)).toMatchObject({
        senderAckedThrough: 2,
        nextDeliverySeq: 3,
        lastAckedAssignment: { deliveryKey: deliveryKey('a'), toSeq: 2, ackedAt: 300 },
        ackedItemVersions: [
          { ingestSeq: 11, itemVersionKey: 'sentence-1:r1', deliverySeq: 1, ackedAt: 300 },
          { ingestSeq: 15, itemVersionKey: 'chat-9:r1', deliverySeq: 2, ackedAt: 300 },
        ],
      });
      expect(getVcMeetingHubDeliveryAssignment(dir, KEY)).toBeUndefined();
    });

    it('accepts duplicate with a cursor beyond toSeq but never skips an unassigned sender seq', () => {
      expect(observeVcMeetingHubReceiverReceipt(dir, observation({
        status: 'duplicate',
        receiverCommittedThrough: 9,
      }))).toMatchObject({ ok: true, kind: 'acked', senderAckedThrough: 2 });
      expect(getVcMeetingHubMember(dir, KEY)?.senderAckedThrough).toBe(2);
    });

    it('rejects mismatched receipt identity, range, owner, and cursor regression', () => {
      expect(observeVcMeetingHubReceiverReceipt(dir, observation({ deliveryKey: deliveryKey('b') })))
        .toMatchObject({ ok: false, reason: 'delivery_key_mismatch' });
      expect(observeVcMeetingHubReceiverReceipt(dir, observation({ inputHash: hash('wrong') })))
        .toMatchObject({ ok: false, reason: 'input_hash_mismatch' });
      expect(observeVcMeetingHubReceiverReceipt(dir, observation({ toSeq: 3, receiverCommittedThrough: 3 })))
        .toMatchObject({ ok: false, reason: 'range_mismatch' });
      expect(observeVcMeetingHubReceiverReceipt(dir, observation({ ownerBootId: 'old' })))
        .toMatchObject({ ok: false, reason: 'stale_owner_boot' });
      expect(observeVcMeetingHubReceiverReceipt(dir, observation({
        status: 'dispatched',
        receiverCommittedThrough: -1,
      }))).toMatchObject({ ok: false, reason: 'invalid' });
    });

    it('makes lost hub ACK responses and assignment retries idempotent', () => {
      observeVcMeetingHubReceiverReceipt(dir, observation(), 200);
      expect(observeVcMeetingHubReceiverReceipt(dir, observation(), 300))
        .toMatchObject({ ok: true, kind: 'already_acked', senderAckedThrough: 2 });
      expect(freezeVcMeetingHubDeliveryAssignment(dir, assignment(), 400))
        .toMatchObject({ kind: 'already_acked', senderAckedThrough: 2 });

      const next = assignment({
        deliveryKey: deliveryKey('b'),
        inputHash: hash('envelope-2'),
        fromSeq: 3,
        toSeq: 3,
        batchId: 'batch-2',
        entries: [{
          deliverySeq: 3,
          ingestSeq: 16,
          itemVersionKey: 'sentence-2:r1',
          contentHash: hash('source three'),
          renderedTextHash: hash('render three'),
          kind: 'item',
        }],
      });
      expect(freezeVcMeetingHubDeliveryAssignment(dir, next)).toMatchObject({ kind: 'frozen' });
      expect(observeVcMeetingHubReceiverReceipt(dir, observation({
        deliveryKey: deliveryKey('b'),
        inputHash: hash('envelope-2'),
        fromSeq: 3,
        toSeq: 3,
        receiverCommittedThrough: 3,
      }), 500)).toMatchObject({ ok: true, kind: 'acked' });
      expect(getVcMeetingHubMember(dir, KEY)?.ackedItemVersions.map(item => item.itemVersionKey))
        .toEqual(['sentence-1:r1', 'chat-9:r1', 'sentence-2:r1']);

      const replayAsNewSeq = assignment({
        deliveryKey: deliveryKey('c'),
        inputHash: hash('envelope-replayed-as-new'),
        fromSeq: 4,
        toSeq: 4,
        batchId: 'batch-replayed-as-new',
        entries: [{ ...assignment().entries[0]!, deliverySeq: 4 }],
      });
      expect(freezeVcMeetingHubDeliveryAssignment(dir, replayAsNewSeq))
        .toMatchObject({ kind: 'conflict', reason: 'item_already_acked' });
    });
  });

  it('keeps sequence allocation and blocking independent per member', () => {
    applyVcMeetingHubMemberProjection(dir, projection());
    applyVcMeetingHubMemberProjection(dir, projection({
      memberId: 'actions',
      agentAppId: 'cli_actions',
      role: 'action-items',
      receiverSessionId: 'receiver-actions',
      membershipGeneration: 1,
    }));
    freezeVcMeetingHubDeliveryAssignment(dir, assignment());

    const other = assignment({
      memberId: 'actions',
      deliveryKey: deliveryKey('b'),
      inputHash: hash('action envelope'),
      toSeq: 1,
      entries: [{
        deliverySeq: 1,
        ingestSeq: 11,
        itemVersionKey: 'sentence-1:r1',
        contentHash: hash('source one'),
        renderedTextHash: hash('action render'),
        kind: 'item',
      }],
      target: { sessionId: 'receiver-actions', chatId: 'oc_listener' },
    });
    expect(freezeVcMeetingHubDeliveryAssignment(dir, other)).toMatchObject({ kind: 'frozen' });
    expect(listVcMeetingHubMembers(dir, { listenerAppId: LISTENER, meetingId: MEETING }))
      .toMatchObject([
        { memberId: 'actions', nextDeliverySeq: 2 },
        { memberId: 'minutes', nextDeliverySeq: 3 },
      ]);
  });

  describe('close and final metadata', () => {
    beforeEach(() => applyVcMeetingHubMemberProjection(dir, projection(), 100));

    it('tracks monotonic close phases with current-owner fencing', () => {
      expect(updateVcMeetingHubCloseState(dir, {
        listenerAppId: LISTENER,
        meetingId: MEETING,
        ownerBootId: 'hub-boot-a',
        ownerEpoch: 1,
        phase: 'data_closing',
        finalizationDeadlineAt: 9_000,
      }, 200)).toMatchObject({ ok: true, close: { phase: 'data_closing' } });
      expect(updateVcMeetingHubCloseState(dir, {
        listenerAppId: LISTENER,
        meetingId: MEETING,
        ownerBootId: 'old',
        ownerEpoch: 1,
        phase: 'finalizing',
      })).toMatchObject({ ok: false, reason: 'stale_owner_boot' });
      expect(updateVcMeetingHubCloseState(dir, {
        listenerAppId: LISTENER,
        meetingId: MEETING,
        ownerBootId: 'hub-boot-a',
        ownerEpoch: 1,
        phase: 'active',
      })).toMatchObject({ ok: false, reason: 'close_phase_regression' });
      expect(updateVcMeetingHubCloseState(dir, {
        listenerAppId: LISTENER,
        meetingId: MEETING,
        ownerBootId: 'hub-boot-a',
        ownerEpoch: 1,
        phase: 'closed',
        reason: 'final deadline reached',
      }, 500)).toMatchObject({ ok: false, reason: 'close_phase_jump' });
      expect(updateVcMeetingHubCloseState(dir, {
        listenerAppId: LISTENER,
        meetingId: MEETING,
        ownerBootId: 'hub-boot-a',
        ownerEpoch: 1,
        phase: 'finalizing',
      }, 400)).toMatchObject({ ok: true, close: { phase: 'finalizing' } });
      expect(updateVcMeetingHubCloseState(dir, {
        listenerAppId: LISTENER,
        meetingId: MEETING,
        ownerBootId: 'hub-boot-a',
        ownerEpoch: 1,
        phase: 'closed',
        reason: 'final deadline reached',
      }, 500)).toMatchObject({ ok: false, reason: 'final_not_acked' });

      const final = assignment({
        deliveryKey: deliveryKey('f'),
        inputHash: hash('close-final-envelope'),
        fromSeq: 1,
        toSeq: 1,
        final: true,
        entries: [{ deliverySeq: 1, kind: 'final', renderedTextHash: hash('close final') }],
      });
      freezeVcMeetingHubDeliveryAssignment(dir, final, 550);
      observeVcMeetingHubReceiverReceipt(dir, observation({
        deliveryKey: deliveryKey('f'),
        inputHash: hash('close-final-envelope'),
        toSeq: 1,
        receiverCommittedThrough: 1,
      }), 575);
      expect(updateVcMeetingHubCloseState(dir, {
        listenerAppId: LISTENER,
        meetingId: MEETING,
        ownerBootId: 'hub-boot-a',
        ownerEpoch: 1,
        phase: 'closed',
        reason: 'final committed',
      }, 600)).toMatchObject({ ok: true, close: { phase: 'closed', closedAt: 600 } });
      expect(getVcMeetingHubCloseState(dir, { listenerAppId: LISTENER, meetingId: MEETING }))
        .toMatchObject({ phase: 'closed', finalizationDeadlineAt: 9_000, reason: 'final committed' });
      expect(freezeVcMeetingHubDeliveryAssignment(dir, assignment()))
        .toMatchObject({ kind: 'conflict', reason: 'meeting_closed' });
      expect(applyVcMeetingHubMemberProjection(dir, projection({ membershipGeneration: 2 })))
        .toMatchObject({ ok: false, reason: 'meeting_closed' });
    });

    it('marks final assigned and final ACK separately', () => {
      const final = assignment({
        deliveryKey: deliveryKey('f'),
        inputHash: hash('final envelope'),
        fromSeq: 1,
        toSeq: 1,
        final: true,
        entries: [{ deliverySeq: 1, kind: 'final', renderedTextHash: hash('final') }],
      });
      freezeVcMeetingHubDeliveryAssignment(dir, final, 200);
      expect(getVcMeetingHubMember(dir, KEY)).toMatchObject({ finalAssignedSeq: 1 });
      expect(getVcMeetingHubMember(dir, KEY)?.finalAckedAt).toBeUndefined();
      observeVcMeetingHubReceiverReceipt(dir, observation({
        deliveryKey: deliveryKey('f'),
        inputHash: hash('final envelope'),
        toSeq: 1,
        receiverCommittedThrough: 1,
      }), 300);
      expect(getVcMeetingHubMember(dir, KEY)).toMatchObject({
        senderAckedThrough: 1,
        finalAssignedSeq: 1,
        finalAckedAt: 300,
      });

      expect(freezeVcMeetingHubDeliveryAssignment(dir, assignment({
        deliveryKey: deliveryKey('c'),
        inputHash: hash('illegal post-final item'),
        fromSeq: 2,
        toSeq: 2,
        batchId: 'post-final-item',
        entries: [{ ...assignment().entries[0]!, deliverySeq: 2 }],
      }))).toMatchObject({ kind: 'conflict', reason: 'stream_finalized' });
    });

    it('does not close with a post-final control still in flight or a prototype phase', () => {
      updateVcMeetingHubCloseState(dir, {
        listenerAppId: LISTENER, meetingId: MEETING, ownerBootId: 'hub-boot-a', ownerEpoch: 1,
        phase: 'data_closing',
      });
      const final = assignment({
        deliveryKey: deliveryKey('f'), inputHash: hash('final'), fromSeq: 1, toSeq: 1,
        final: true, entries: [{ deliverySeq: 1, kind: 'final', renderedTextHash: hash('final') }],
      });
      freezeVcMeetingHubDeliveryAssignment(dir, final);
      observeVcMeetingHubReceiverReceipt(dir, observation({
        deliveryKey: deliveryKey('f'), inputHash: hash('final'), toSeq: 1, receiverCommittedThrough: 1,
      }));
      updateVcMeetingHubCloseState(dir, {
        listenerAppId: LISTENER, meetingId: MEETING, ownerBootId: 'hub-boot-a', ownerEpoch: 1,
        phase: 'finalizing',
      });
      expect(freezeVcMeetingHubDeliveryAssignment(dir, assignment({
        deliveryKey: deliveryKey('e'), inputHash: hash('effect'), fromSeq: 2, toSeq: 2,
        batchId: 'effect', entries: [{
          deliverySeq: 2, kind: 'effect_result', controlKey: 'effect_1', renderedTextHash: hash('effect'),
        }],
      }))).toMatchObject({ kind: 'frozen' });
      expect(updateVcMeetingHubCloseState(dir, {
        listenerAppId: LISTENER, meetingId: MEETING, ownerBootId: 'hub-boot-a', ownerEpoch: 1,
        phase: 'closed',
      })).toMatchObject({ ok: false, reason: 'in_flight_not_settled' });
      expect(updateVcMeetingHubCloseState(dir, {
        listenerAppId: LISTENER, meetingId: MEETING, ownerBootId: 'hub-boot-a', ownerEpoch: 1,
        phase: 'toString' as never,
      })).toMatchObject({ ok: false, reason: 'invalid' });
    });
  });

  it('quarantines schema-invalid state instead of trusting or silently overwriting it', () => {
    applyVcMeetingHubMemberProjection(dir, projection());
    const storeDir = join(dir, 'vc-meeting-delivery-hub');
    const storeFile = join(storeDir, `${LISTENER}__${MEETING}.json`);
    const malformed = JSON.parse(readFileSync(storeFile, 'utf8')) as Record<string, unknown>;
    const members = malformed.members as Record<string, any>;
    members[MEMBER].epochs['1'].senderAckedThrough = 999;
    writeFileSync(storeFile, JSON.stringify(malformed), { mode: 0o600 });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(() => getVcMeetingHubMember(dir, KEY)).toThrow(/hub state is corrupt/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt state'));
    expect(readdirSync(storeDir).some((name) => name.includes('.corrupt.'))).toBe(true);

    // The same call that discovers corruption must not reinterpret it as a
    // missing/cursor-zero state. The quarantined evidence requires explicit
    // operator reconciliation before a fresh projection can be created.
    expect(readdirSync(storeDir).some(name => name.endsWith('.json'))).toBe(false);
    expect(() => applyVcMeetingHubMemberProjection(dir, projection({ ownerBootId: 'hub-boot-new' })))
      .toThrow(/quarantined evidence/);
  });
});
