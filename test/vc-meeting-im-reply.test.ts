import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  finishVcMeetingImReply,
  prepareVcMeetingImReply,
} from '../src/services/vc-meeting-im-reply.js';
import type { VcMeetingImTurnOrigin } from '../src/types.js';
import {
  applyVcMeetingMemberProjection,
  type VcMeetingMemberProjectionInput,
} from '../src/services/vc-meeting-delivery-store.js';

let dir: string;

const origin: VcMeetingImTurnOrigin = {
  listenerAppId: 'listener',
  meetingId: 'meeting',
  memberId: 'minutes',
  memberEpoch: 1,
  agentAppId: 'agent',
  ownerBootId: 'boot',
  ownerEpoch: 1,
  membershipGeneration: 1,
  sinkOwnerGeneration: 1,
  receiverSessionId: 'receiver-session',
  larkMessageId: 'om_human_a',
};

const output = {
  targetChatId: 'oc_listener',
  quoteTargetId: 'om_human_a',
  msgType: 'interactive',
  content: '{"schema":"2.0","body":{"elements":[]}}',
};

function project(overrides: Partial<VcMeetingMemberProjectionInput> = {}): void {
  expect(applyVcMeetingMemberProjection(dir, {
    listenerAppId: origin.listenerAppId,
    meetingId: origin.meetingId,
    memberId: origin.memberId,
    memberEpoch: origin.memberEpoch,
    agentAppId: origin.agentAppId,
    ownerBootId: origin.ownerBootId,
    ownerEpoch: origin.ownerEpoch,
    role: 'minutes',
    membershipGeneration: origin.membershipGeneration,
    status: 'active',
    responseMode: 'silent',
    capabilities: ['meeting.read'],
    ownedSinks: [],
    sinkOwnerGeneration: origin.sinkOwnerGeneration,
    joinedAtIngestSeq: 0,
    receiverSessionId: origin.receiverSessionId,
    outputChatId: output.targetChatId,
    ...overrides,
  })).toMatchObject({ ok: true });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-im-reply-'));
  project();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('VC explicit IM assistant reply ledger', () => {
  it('locks the first output and reuses one provider UUID across ambiguous replay', () => {
    const first = prepareVcMeetingImReply(dir, origin, output, 100);
    expect(first).toMatchObject({ kind: 'send', replay: false });
    if (first.kind !== 'send') throw new Error('expected first send claim');
    expect(first.providerKey).toMatch(/^vcp_[0-9a-f]+$/);
    expect(first.providerKey.length).toBeLessThanOrEqual(50);

    const replay = prepareVcMeetingImReply(dir, origin, output, 101);
    expect(replay).toMatchObject({
      kind: 'send',
      replay: true,
      providerKey: first.providerKey,
    });

    const changedOutput = {
      ...output,
      content: '{"schema":"2.0","body":{"elements":[{"tag":"markdown","content":"changed"}]}}',
    };
    const mismatch = prepareVcMeetingImReply(dir, origin, changedOutput, 102);
    expect(mismatch).toMatchObject({
      kind: 'send',
      replay: true,
      providerKey: first.providerKey,
      outputMismatch: true,
      canonicalOutput: output,
    });
    if (mismatch.kind === 'send') {
      expect(mismatch.canonicalOutput.content).not.toBe(changedOutput.content);
    }
  });

  it('refuses a late replay after the member is removed or ownership changes', () => {
    expect(prepareVcMeetingImReply(dir, origin, output, 100)).toMatchObject({ kind: 'send' });
    project({ membershipGeneration: 2, status: 'removed' });
    expect(prepareVcMeetingImReply(dir, origin, output, 101)).toMatchObject({
      kind: 'conflict',
      reason: 'invalid_origin',
    });

    project({
      memberEpoch: 2,
      membershipGeneration: 3,
      sinkOwnerGeneration: 2,
    });
    expect(prepareVcMeetingImReply(dir, origin, output, 102)).toMatchObject({
      kind: 'conflict',
      reason: 'invalid_origin',
    });
  });

  it('refuses to bind a canonical reply outside the projected listener chat', () => {
    expect(prepareVcMeetingImReply(dir, origin, {
      ...output,
      targetChatId: 'oc_elsewhere',
    })).toMatchObject({ kind: 'conflict', reason: 'invalid_origin' });
  });

  it('returns the committed provider result without sending a second answer', () => {
    const first = prepareVcMeetingImReply(dir, origin, output, 100);
    if (first.kind !== 'send') throw new Error('expected first send claim');
    finishVcMeetingImReply(dir, first.ref, 'om_assistant_reply', 110);

    expect(prepareVcMeetingImReply(dir, origin, output, 120)).toMatchObject({
      kind: 'succeeded',
      providerKey: first.providerKey,
      messageId: 'om_assistant_reply',
    });
  });

  it('uses a different identity for the next human IM turn', () => {
    const first = prepareVcMeetingImReply(dir, origin, output);
    const secondOrigin = { ...origin, larkMessageId: 'om_human_b' };
    const second = prepareVcMeetingImReply(dir, secondOrigin, {
      ...output,
      quoteTargetId: 'om_human_b',
    });
    expect(first.kind).toBe('send');
    expect(second.kind).toBe('send');
    if (first.kind === 'send' && second.kind === 'send') {
      expect(second.providerKey).not.toBe(first.providerKey);
    }
  });
});
