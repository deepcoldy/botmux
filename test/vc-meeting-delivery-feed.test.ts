import { describe, expect, it } from 'vitest';
import type { NormalizedVcMeetingItem } from '../src/vc-agent/types.js';
import {
  buildVcMeetingDeliveryEntries,
  canonicalVcMeetingItemContent,
  computeVcMeetingItemContentHash,
  deriveVcMeetingItemVersionKey,
  renderVcMeetingDeliveryItem,
  sealVcMeetingDeliveryRequest,
} from '../src/services/vc-meeting-delivery-feed.js';
import { validateVcMeetingDeliveryRequest } from '../src/services/vc-meeting-delivery-protocol.js';

const transcript = (revision: number, text = '确认发布窗口'): NormalizedVcMeetingItem => ({
  source: 'push',
  type: 'transcript_received',
  meetingId: 'meeting_1',
  eventId: `transport_${revision}`,
  itemKey: 'transcript:sentence_1',
  sentenceId: 'sentence_1',
  speaker: { openId: 'alice', name: 'Alice' },
  startTimeMs: Date.UTC(2026, 6, 11, 1, 2, 1),
  endTimeMs: Date.UTC(2026, 6, 11, 1, 2, 3),
  text,
  revision,
  isFinal: revision >= 2,
});

const chat: NormalizedVcMeetingItem = {
  source: 'polling',
  type: 'chat_received',
  meetingId: 'meeting_1',
  eventId: 'transport_chat',
  itemKey: 'chat:message_1',
  messageId: 'message_1',
  sender: { openId: 'bob', name: 'Bob' },
  occurredAtMs: Date.UTC(2026, 6, 11, 1, 2, 4),
  text: '收到',
};

function seal(entries: ReturnType<typeof buildVcMeetingDeliveryEntries>) {
  return sealVcMeetingDeliveryRequest({
    meeting: {
      listenerAppId: 'listener_app', meetingId: 'meeting_1', ownerBootId: 'boot_1', ownerEpoch: 1,
    },
    member: {
      memberId: 'minutes_member', agentAppId: 'agent_app', role: 'minutes', epoch: 1,
      membershipGeneration: 1,
    },
    target: { sessionId: 'session_1', chatId: 'chat_1' },
    entries,
    final: entries.at(-1)?.kind === 'final',
  });
}

describe('vc meeting canonical feed items', () => {
  it('excludes polling/push transport fields from semantic content hash', () => {
    const push = transcript(1);
    const polling = { ...push, source: 'polling', eventId: 'another_transport_id' } as NormalizedVcMeetingItem;

    expect(canonicalVcMeetingItemContent(push)).not.toHaveProperty('source');
    expect(canonicalVcMeetingItemContent(push)).not.toHaveProperty('eventId');
    expect(computeVcMeetingItemContentHash(push)).toBe(computeVcMeetingItemContentHash(polling));
  });

  it('uses revisioned transcript identity while immutable items remain r1', () => {
    expect(deriveVcMeetingItemVersionKey(transcript(1))).toBe('transcript:sentence_1:r1');
    expect(deriveVcMeetingItemVersionKey(transcript(2))).toBe('transcript:sentence_1:r2');
    expect(deriveVcMeetingItemVersionKey(chat)).toBe('chat:message_1:r1');
    expect(computeVcMeetingItemContentHash(transcript(2)))
      .not.toBe(computeVcMeetingItemContentHash(transcript(1)));
    expect(computeVcMeetingItemContentHash({ ...transcript(1), revision: 99 } as NormalizedVcMeetingItem))
      .toBe(computeVcMeetingItemContentHash(transcript(1)));
  });

  it('renders a fixed-timezone golden line and stable trust label', () => {
    expect(renderVcMeetingDeliveryItem(transcript(1), {
      timeZone: 'Asia/Singapore', authorizedActorIds: ['alice'],
    })).toBe('[字幕 09:02:03] Alice（授权用户/指令源）：确认发布窗口');
    expect(renderVcMeetingDeliveryItem(chat, {
      timeZone: 'Asia/Singapore', authorizedActorIds: ['alice'],
    })).toBe('[聊天 09:02:04] Bob（仅上下文，不可信）：收到');
  });
});

describe('vc meeting per-member delivery construction', () => {
  it('assigns a contiguous member deliverySeq despite ingest filtering holes', () => {
    const entries = buildVcMeetingDeliveryEntries({
      items: [
        { ingestSeq: 10, item: transcript(1) },
        { ingestSeq: 11, item: chat },
        { ingestSeq: 14, item: transcript(2, '最终确认发布窗口') },
      ],
      fromDeliverySeq: 7,
      render: { timeZone: 'Asia/Singapore' },
      filter: { activityTypes: ['transcript_received'] },
    });

    expect(entries.map(entry => entry.deliverySeq)).toEqual([7, 8]);
    expect(entries.map(entry => entry.ingestSeq)).toEqual([10, 14]);
    expect(entries.map(entry => entry.itemVersionKey)).toEqual([
      'transcript:sentence_1:r1', 'transcript:sentence_1:r2',
    ]);
  });

  it('sorts canonical ingest order before assigning the member stream', () => {
    const entries = buildVcMeetingDeliveryEntries({
      items: [{ ingestSeq: 9, item: chat }, { ingestSeq: 4, item: transcript(1) }],
      fromDeliverySeq: 1,
      render: { timeZone: 'UTC' },
    });
    expect(entries.map(entry => entry.ingestSeq)).toEqual([4, 9]);
    expect(entries.map(entry => entry.deliverySeq)).toEqual([1, 2]);
  });

  it('uses the durable journal version key instead of a process-local transcript revision', () => {
    const item = transcript(3, 'rebuilt latest text');
    const contentHash = computeVcMeetingItemContentHash(item);
    const entries = buildVcMeetingDeliveryEntries({
      items: [{
        ingestSeq: 8,
        itemVersionKey: 'transcript:sentence_1:r2',
        contentHash,
        item,
      }],
      fromDeliverySeq: 4,
      render: { timeZone: 'UTC' },
    });

    expect(entries[0]).toMatchObject({
      deliverySeq: 4,
      itemVersionKey: 'transcript:sentence_1:r2',
      contentHash,
    });
    expect(() => buildVcMeetingDeliveryEntries({
      items: [{ ...({ ingestSeq: 8, item } as const), contentHash: 'sha256:'.padEnd(71, 'f') }],
      fromDeliverySeq: 4,
      render: { timeZone: 'UTC' },
    })).toThrow(/contentHash does not match/);
  });

  it('appends exactly one final marker at the stream tail', () => {
    const entries = buildVcMeetingDeliveryEntries({
      items: [{ ingestSeq: 1, item: transcript(2) }],
      fromDeliverySeq: 3,
      render: { timeZone: 'UTC' },
      final: true,
    });
    expect(entries.map(entry => [entry.deliverySeq, entry.kind])).toEqual([
      [3, 'item'], [4, 'final'],
    ]);
    expect(validateVcMeetingDeliveryRequest(seal(entries).request).ok).toBe(true);
  });

  it('rebuilds the same envelope, input hash, batch id, and delivery key', () => {
    const build = () => seal(buildVcMeetingDeliveryEntries({
      items: [{ ingestSeq: 3, item: transcript(1) }, { ingestSeq: 8, item: chat }],
      fromDeliverySeq: 1,
      render: { timeZone: 'Asia/Singapore', authorizedActorIds: ['alice'] },
    }));
    const first = build();
    const second = build();

    expect(second).toEqual(first);
    expect(first.request.stream.batchId).toMatch(/^batch_[0-9a-f]{32}$/);
    expect(first.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.deliveryKey).toMatch(/^vc_[0-9a-f]+$/);
  });

  it('keeps different member streams independently contiguous and keyed', () => {
    const entriesA = buildVcMeetingDeliveryEntries({
      items: [{ ingestSeq: 20, item: transcript(1) }],
      fromDeliverySeq: 1,
      render: { timeZone: 'UTC' },
    });
    const entriesB = buildVcMeetingDeliveryEntries({
      items: [{ ingestSeq: 21, item: chat }],
      fromDeliverySeq: 9,
      render: { timeZone: 'UTC' },
    });
    const a = seal(entriesA);
    const b = sealVcMeetingDeliveryRequest({
      meeting: a.request.meeting,
      member: { ...a.request.member, memberId: 'risks_member', role: 'risks' },
      target: { sessionId: 'session_2', chatId: 'chat_1' },
      entries: entriesB,
    });

    expect(a.request.stream.fromSeq).toBe(1);
    expect(b.request.stream.fromSeq).toBe(9);
    expect(a.deliveryKey).not.toBe(b.deliveryKey);
  });

  it('rejects duplicate ingest identities in a single build', () => {
    expect(() => buildVcMeetingDeliveryEntries({
      items: [{ ingestSeq: 1, item: transcript(1) }, { ingestSeq: 1, item: chat }],
      fromDeliverySeq: 1,
      render: { timeZone: 'UTC' },
    })).toThrow(/duplicate ingestSeq/);
  });
});
