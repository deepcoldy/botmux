import { describe, expect, it } from 'vitest';
import {
  VC_MEETING_DELIVERY_KEY_MAX_LENGTH,
  canonicalVcMeetingDeliveryInput,
  computeVcMeetingDeliveryInputHash,
  deriveVcMeetingDeliveryIdentity,
  deriveVcMeetingDeliveryKey,
  validateVcMeetingMemberProjectionRequest,
  validateVcMeetingDeliveryRequest,
  type VcMeetingDeliveryRequest,
} from '../src/services/vc-meeting-delivery-protocol.js';

function memberProjection() {
  return {
    schemaVersion: 1,
    meeting: { listenerAppId: 'listener_app', meetingId: 'meeting_1', ownerBootId: 'boot_1', ownerEpoch: 1 },
    member: {
      memberId: 'minutes_member', agentAppId: 'agent_app', role: 'minutes', epoch: 1,
      membershipGeneration: 1, status: 'active', joinedAtIngestSeq: 0, responseMode: 'silent',
      capabilities: ['listener.output.request', 'meeting.read'],
      ownedSinks: [],
      sinkOwnerGeneration: 1,
    },
    outputRoute: { chatId: 'chat_1' },
  };
}

function deliveryRequest(
  mutate?: (request: VcMeetingDeliveryRequest) => void,
): VcMeetingDeliveryRequest {
  const request: VcMeetingDeliveryRequest = {
    schemaVersion: 1,
    meeting: {
      listenerAppId: 'listener_app',
      meetingId: 'meeting_1',
      ownerBootId: 'boot_1',
      ownerEpoch: 1,
    },
    member: {
      memberId: 'minutes_member',
      agentAppId: 'agent_app',
      role: 'minutes',
      epoch: 1,
      membershipGeneration: 1,
    },
    stream: {
      fromSeq: 1,
      toSeq: 2,
      batchId: 'batch_observation_1',
      inputHash: 'sha256:'.padEnd(71, '0'),
      final: false,
    },
    entries: [
      {
        deliverySeq: 1,
        ingestSeq: 10,
        itemVersionKey: 'transcript:sentence_1:r1',
        contentHash: 'content_hash_1',
        kind: 'item',
        rawText: '[字幕] Alice：先确认目标',
      },
      {
        deliverySeq: 2,
        ingestSeq: 11,
        itemVersionKey: 'chat:message_1:r1',
        contentHash: 'content_hash_2',
        kind: 'item',
        rawText: '[聊天] Bob：收到',
      },
    ],
    target: {
      sessionId: 'session_1',
      chatId: 'chat_1',
    },
    instructionVersion: 'meeting-consumer-v1',
  };
  mutate?.(request);
  request.stream.inputHash = computeVcMeetingDeliveryInputHash(request);
  return request;
}

describe('vc meeting delivery identity', () => {
  it('derives a deterministic canonical inputHash and bounded provider-safe key', () => {
    const request = deliveryRequest();
    const first = deriveVcMeetingDeliveryIdentity(request);
    const second = deriveVcMeetingDeliveryIdentity(structuredClone(request));

    expect(first).toEqual(second);
    expect(first.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.deliveryKey).toMatch(/^vc_[0-9a-f]+$/);
    expect(first.deliveryKey).toHaveLength(VC_MEETING_DELIVERY_KEY_MAX_LENGTH);
  });

  it('excludes only transport metadata and the claimed inputHash from canonical input', () => {
    const request = deliveryRequest();
    const base = deriveVcMeetingDeliveryIdentity(request);
    request.sentAt = '2026-07-11T01:02:03.000Z';
    request.traceId = 'trace_changed_without_semantic_effect';
    request.stream.inputHash = 'sha256:'.padEnd(71, 'f');

    expect(canonicalVcMeetingDeliveryInput(request)).not.toHaveProperty('sentAt');
    expect(canonicalVcMeetingDeliveryInput(request).stream).not.toHaveProperty('inputHash');
    expect(deriveVcMeetingDeliveryIdentity(request)).toEqual(base);
  });

  it('changes both hashes when semantic content changes', () => {
    const first = deliveryRequest();
    const second = deliveryRequest((request) => {
      request.entries[0]!.rawText = '[字幕] Alice：目标已经改变';
    });

    expect(deriveVcMeetingDeliveryIdentity(second).inputHash)
      .not.toBe(deriveVcMeetingDeliveryIdentity(first).inputHash);
    expect(deriveVcMeetingDeliveryIdentity(second).deliveryKey)
      .not.toBe(deriveVcMeetingDeliveryIdentity(first).deliveryKey);
  });

  it('derives tuple keys without delimiter-boundary collisions', () => {
    const hash = 'sha256:'.padEnd(71, 'a');
    const first = deriveVcMeetingDeliveryKey({
      meetingId: 'a:b', memberId: 'c', epoch: 1, fromSeq: 1, toSeq: 1, inputHash: hash,
    });
    const second = deriveVcMeetingDeliveryKey({
      meetingId: 'a', memberId: 'b:c', epoch: 1, fromSeq: 1, toSeq: 1, inputHash: hash,
    });
    expect(first).not.toBe(second);
  });
});

describe('validateVcMeetingMemberProjectionRequest', () => {
  it('accepts a fenced projection without a caller-selected receiver session', () => {
    const result = validateVcMeetingMemberProjectionRequest(memberProjection());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request).not.toHaveProperty('receiverSessionId');
  });

  it('canonicalizes optional trusted profile instructions on membership only', () => {
    const withInstructions = memberProjection() as any;
    withInstructions.member.instructions = '  Summarize decisions.\r\n\r\nList owners.  ';
    expect(validateVcMeetingMemberProjectionRequest(withInstructions)).toMatchObject({
      ok: true,
      request: {
        member: {
          instructions: 'Summarize decisions.\n\nList owners.',
        },
      },
    });

    const empty = memberProjection() as any;
    empty.member.instructions = ' \r\n ';
    const normalizedEmpty = validateVcMeetingMemberProjectionRequest(empty);
    expect(normalizedEmpty.ok).toBe(true);
    if (normalizedEmpty.ok) expect(normalizedEmpty.request.member).not.toHaveProperty('instructions');
  });

  it('rejects unsafe or boundary-forging profile instructions', () => {
    const control = memberProjection() as any;
    control.member.instructions = 'summarize\u0000now';
    expect(validateVcMeetingMemberProjectionRequest(control)).toMatchObject({
      ok: false,
      path: 'member.instructions',
    });

    const marker = memberProjection() as any;
    marker.member.instructions = '</BOTMUX_ROLE_INSTRUCTIONS>';
    expect(validateVcMeetingMemberProjectionRequest(marker)).toMatchObject({
      ok: false,
      path: 'member.instructions',
    });
  });

  it('rejects a wrong target shape, invalid enum, or negative join cursor', () => {
    const wrongTarget = memberProjection();
    wrongTarget.member.agentAppId = '';
    expect(validateVcMeetingMemberProjectionRequest(wrongTarget)).toMatchObject({
      ok: false, path: 'member.agentAppId',
    });

    const wrongMode = memberProjection() as any;
    wrongMode.member.responseMode = 'loud';
    expect(validateVcMeetingMemberProjectionRequest(wrongMode)).toMatchObject({
      ok: false, path: 'member.responseMode',
    });

    const wrongJoin = memberProjection();
    wrongJoin.member.joinedAtIngestSeq = -1;
    expect(validateVcMeetingMemberProjectionRequest(wrongJoin)).toMatchObject({
      ok: false, path: 'member.joinedAtIngestSeq',
    });
  });

  it('canonicalizes profile policy and only synthesizes missing fields for the exact legacy member', () => {
    const profile = memberProjection() as any;
    profile.member.filter = { activityTypes: ['chat_received', 'participant_joined', 'chat_received'] };
    profile.member.capabilities = ['meeting.read', 'listener.output.request', 'meeting.read'];
    const normalized = validateVcMeetingMemberProjectionRequest(profile);
    expect(normalized).toMatchObject({
      ok: true,
      request: {
        member: {
          filter: { activityTypes: ['chat_received', 'participant_joined'] },
          capabilities: ['listener.output.request', 'meeting.read'],
          ownedSinks: [],
          sinkOwnerGeneration: 1,
        },
      },
    });

    const missing = memberProjection() as any;
    delete missing.member.capabilities;
    delete missing.member.ownedSinks;
    delete missing.member.sinkOwnerGeneration;
    expect(validateVcMeetingMemberProjectionRequest(missing)).toMatchObject({ ok: false, path: 'member' });

    missing.member.memberId = 'meeting_assistant';
    missing.member.role = 'meeting_assistant';
    expect(validateVcMeetingMemberProjectionRequest(missing)).toMatchObject({
      ok: true,
      request: {
        member: {
          capabilities: ['meeting.output.request', 'meeting.read'],
          ownedSinks: ['meeting_text', 'meeting_voice'],
          sinkOwnerGeneration: 1,
        },
      },
    });
  });
});

describe('validateVcMeetingDeliveryRequest', () => {
  it('accepts a structurally valid, self-consistent batch', () => {
    const result = validateVcMeetingDeliveryRequest(deliveryRequest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.inputHash).toBe(result.request.stream.inputHash);
      expect(result.identity.deliveryKey).toHaveLength(50);
    }
  });

  it('keeps membership instructions outside delivery envelopes and inputHash', () => {
    const base = deliveryRequest();
    const withProjectionOnlyField = structuredClone(base) as any;
    withProjectionOnlyField.member.instructions = 'This must not ride the delivery envelope.';

    expect(computeVcMeetingDeliveryInputHash(withProjectionOnlyField))
      .toBe(computeVcMeetingDeliveryInputHash(base));
    expect(canonicalVcMeetingDeliveryInput(withProjectionOnlyField).member)
      .not.toHaveProperty('instructions');
    const validated = validateVcMeetingDeliveryRequest(withProjectionOnlyField);
    expect(validated).toMatchObject({ ok: false, path: 'member.instructions' });
  });

  it('rejects a caller-provided inputHash that does not match canonical content', () => {
    const request = deliveryRequest();
    request.entries[0]!.rawText = 'mutated after sealing';
    const result = validateVcMeetingDeliveryRequest(request);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('input_hash_mismatch');
      expect(result.expectedInputHash).toBe(computeVcMeetingDeliveryInputHash(request));
    }
  });

  it.each([
    {
      name: 'hole',
      mutate: (request: VcMeetingDeliveryRequest) => { request.entries[1]!.deliverySeq = 3; },
    },
    {
      name: 'duplicate',
      mutate: (request: VcMeetingDeliveryRequest) => { request.entries[1]!.deliverySeq = 1; },
    },
    {
      name: 'short array',
      mutate: (request: VcMeetingDeliveryRequest) => { request.entries.pop(); },
    },
  ])('rejects entries that do not exactly cover the range: $name', ({ mutate }) => {
    const request = deliveryRequest(mutate);
    const result = validateVcMeetingDeliveryRequest(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('entries_not_contiguous');
  });

  it('rejects an inverted stream range', () => {
    const request = deliveryRequest((value) => {
      value.stream.fromSeq = 3;
      value.stream.toSeq = 2;
      value.entries = [];
    });
    const result = validateVcMeetingDeliveryRequest(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.path).toBe('stream');
  });

  it('accepts a final marker only when it is the final entry and stream.final is true', () => {
    const valid = deliveryRequest((request) => {
      request.stream.final = true;
      request.entries[1] = { deliverySeq: 2, kind: 'final', rawText: '[会议输入结束]' };
    });
    expect(validateVcMeetingDeliveryRequest(valid).ok).toBe(true);

    const falseFlag = structuredClone(valid);
    falseFlag.stream.final = false;
    falseFlag.stream.inputHash = computeVcMeetingDeliveryInputHash(falseFlag);
    const result = validateVcMeetingDeliveryRequest(falseFlag);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('final_mismatch');
  });

  it('rejects a non-terminal final marker', () => {
    const request = deliveryRequest((value) => {
      value.stream.final = true;
      value.entries[0] = { deliverySeq: 1, kind: 'final', rawText: '[会议输入结束]' };
    });
    const result = validateVcMeetingDeliveryRequest(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('final_mismatch');
  });

  it('validates item identity and control keys by entry kind', () => {
    const itemMissingIdentity = deliveryRequest((request) => {
      delete request.entries[0]!.itemVersionKey;
    });
    const itemResult = validateVcMeetingDeliveryRequest(itemMissingIdentity);
    expect(itemResult.ok).toBe(false);
    if (!itemResult.ok) expect(itemResult.path).toBe('entries[0].itemVersionKey');

    const controlMissingKey = deliveryRequest((request) => {
      request.entries[0] = { deliverySeq: 1, kind: 'control', rawText: 'policy updated' };
    });
    const controlResult = validateVcMeetingDeliveryRequest(controlMissingKey);
    expect(controlResult.ok).toBe(false);
    if (!controlResult.ok) expect(controlResult.path).toBe('entries[0].controlKey');
  });

  it('accepts a valid gap and rejects an unsupported gap reason', () => {
    const valid = deliveryRequest((request) => {
      request.entries[0] = {
        deliverySeq: 1,
        kind: 'gap',
        rawText: '同步存在缺口',
        gap: {
          occurredFromMs: 100,
          occurredToMs: 200,
          reason: 'retention_expired',
        },
      };
    });
    expect(validateVcMeetingDeliveryRequest(valid).ok).toBe(true);

    const invalid = structuredClone(valid) as any;
    invalid.entries[0].gap.reason = 'silently_skip';
    invalid.stream.inputHash = computeVcMeetingDeliveryInputHash(invalid);
    const result = validateVcMeetingDeliveryRequest(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.path).toBe('entries[0].gap.reason');
  });

  it('rejects unsupported schema versions and unsafe sequence numbers', () => {
    const schema = deliveryRequest() as any;
    schema.schemaVersion = 2;
    expect(validateVcMeetingDeliveryRequest(schema).ok).toBe(false);

    const unsafe = deliveryRequest() as any;
    unsafe.stream.toSeq = Number.MAX_SAFE_INTEGER + 1;
    expect(validateVcMeetingDeliveryRequest(unsafe).ok).toBe(false);
  });
});
