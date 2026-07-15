import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  finishVcMeetingImReply,
  prepareVcMeetingImReply,
} from '../src/services/vc-meeting-im-reply.js';
import type { VcMeetingImTurnOrigin } from '../src/types.js';

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

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vc-im-reply-')); });
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

    const mismatch = prepareVcMeetingImReply(dir, origin, {
      ...output,
      content: '{"schema":"2.0","body":{"elements":[{"tag":"markdown","content":"changed"}]}}',
    }, 102);
    expect(mismatch).toMatchObject({ kind: 'conflict', reason: 'output_mismatch' });
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
