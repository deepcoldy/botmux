import { describe, expect, it } from 'vitest';
import {
  mergeQueuedCliInput,
  pendingInputMayFlush,
  pendingInputAllowsTypeAhead,
  shouldDeferArgsBakedDurablePrompt,
  shouldStopPendingBatch,
  terminalReleasesDurableTurn,
} from '../src/utils/pending-input-queue.js';

const imOrigin = {
  listenerAppId: 'listener', meetingId: 'meeting', memberId: 'member',
  memberEpoch: 1, agentAppId: 'agent', ownerBootId: 'boot', ownerEpoch: 1,
  membershipGeneration: 1, sinkOwnerGeneration: 1,
  receiverSessionId: 'receiver', larkMessageId: 'im-1',
};

describe('mergeQueuedCliInput', () => {
  it('returns false when there is no queued message to merge into', () => {
    const pending: Array<{ content: string; turnId?: string }> = [];

    expect(mergeQueuedCliInput(pending, { content: 'next', turnId: 't2' })).toBe(false);
    expect(pending).toEqual([]);
  });

  it('merges incremental queued messages into the pending tail', () => {
    const pending = [{ content: 'first', turnId: 't1' }];

    expect(mergeQueuedCliInput(pending, { content: 'second', turnId: 't2' })).toBe(true);

    expect(pending).toEqual([{ content: 'first\n\nsecond', turnId: 't2' }]);
  });

  it('never merges across a durable envelope boundary in either direction', () => {
    const durableTail = [{ content: 'meeting envelope', turnId: 'delivery', dispatchAttempt: 1 }];
    expect(mergeQueuedCliInput(durableTail, { content: 'human follow-up', turnId: 'im-1' })).toBe(false);
    expect(durableTail).toEqual([{ content: 'meeting envelope', turnId: 'delivery', dispatchAttempt: 1 }]);

    const ordinaryTail = [{ content: 'human turn', turnId: 'im-1' }];
    expect(mergeQueuedCliInput(ordinaryTail, {
      content: 'meeting envelope', turnId: 'delivery', dispatchAttempt: 1,
    })).toBe(false);
    expect(ordinaryTail).toEqual([{ content: 'human turn', turnId: 'im-1' }]);
  });

  it('never merges queued explicit meeting IM turns or batches them on one live origin', () => {
    const pending = [{ content: 'human A', turnId: 'im-1', vcMeetingImTurnOrigin: imOrigin }];
    expect(mergeQueuedCliInput(pending, {
      content: 'human B',
      turnId: 'im-2',
      vcMeetingImTurnOrigin: { ...imOrigin, larkMessageId: 'im-2' },
    })).toBe(false);
    expect(pending).toHaveLength(1);

    expect(pendingInputAllowsTypeAhead(true, false, pending[0])).toBe(false);
    expect(shouldStopPendingBatch(pending[0], {
      content: 'human B',
      turnId: 'im-2',
      vcMeetingImTurnOrigin: { ...imOrigin, larkMessageId: 'im-2' },
    })).toBe(true);
  });
});

describe('durable turn queue boundary', () => {
  it('routes an args-baked cold durable prompt through the owned queue', () => {
    expect(shouldDeferArgsBakedDurablePrompt({
      passesInitialPromptViaArgs: true,
      adoptMode: false,
      dispatchAttempt: 1,
    })).toBe(true);
    expect(shouldDeferArgsBakedDurablePrompt({
      passesInitialPromptViaArgs: true,
      adoptMode: false,
    })).toBe(false);
    expect(shouldDeferArgsBakedDurablePrompt({
      passesInitialPromptViaArgs: false,
      adoptMode: false,
      dispatchAttempt: 1,
    })).toBe(false);
    expect(shouldDeferArgsBakedDurablePrompt({
      passesInitialPromptViaArgs: true,
      adoptMode: true,
      dispatchAttempt: 1,
    })).toBe(false);
  });

  it('disables type-ahead while either the active or next turn is durable', () => {
    expect(pendingInputAllowsTypeAhead(true, false, { content: 'im' })).toBe(true);
    expect(pendingInputAllowsTypeAhead(true, true, { content: 'im' })).toBe(false);
    expect(pendingInputAllowsTypeAhead(true, false, { content: 'delivery', dispatchAttempt: 1 })).toBe(false);
  });

  it('forces separate idle edges on both sides of a durable attempt', () => {
    expect(shouldStopPendingBatch(
      { content: 'delivery', dispatchAttempt: 1 },
      { content: 'user follow-up' },
    )).toBe(true);
    expect(shouldStopPendingBatch(
      { content: 'user turn' },
      { content: 'delivery', dispatchAttempt: 1 },
    )).toBe(true);
    expect(shouldStopPendingBatch({ content: 'user 1' }, { content: 'user 2' })).toBe(false);
  });

  it('does not cross an unresolved durable boundary on a screen-idle edge', () => {
    expect(pendingInputMayFlush(true)).toBe(false);
    expect(pendingInputMayFlush(false)).toBe(true);
  });

  it('only lets the exact current attempt release the durable queue', () => {
    const current = { turnId: 'delivery', dispatchAttempt: 2 };
    expect(terminalReleasesDurableTurn(current, { turnId: 'delivery', dispatchAttempt: 1 })).toBe(false);
    expect(terminalReleasesDurableTurn(current, { turnId: 'other', dispatchAttempt: 2 })).toBe(false);
    expect(terminalReleasesDurableTurn(current, { turnId: 'delivery', dispatchAttempt: 2 })).toBe(true);
  });

  it('never merges structured Codex App turns because context is per-message', () => {
    const pending = [{
      content: 'legacy-1',
      turnId: 't1',
      codexAppInput: { text: 'clean-1' },
    }];
    const next = {
      content: 'legacy-2',
      turnId: 't2',
      codexAppInput: { text: 'clean-2' },
    };
    expect(mergeQueuedCliInput(pending, next)).toBe(false);
    expect(pending).toHaveLength(1);
    expect(pending[0].codexAppInput.text).toBe('clean-1');
  });

  it('never merges a clean sidecar across a durable or explicit-IM boundary', () => {
    const cleanDurable = [{
      content: 'legacy delivery',
      turnId: 'delivery',
      dispatchAttempt: 2,
      codexAppInput: { text: 'external event' },
    }];
    expect(mergeQueuedCliInput(cleanDurable, {
      content: 'legacy IM',
      turnId: 'im-1',
      codexAppInput: { text: 'human follow-up' },
    })).toBe(false);
    expect(cleanDurable).toEqual([{
      content: 'legacy delivery',
      turnId: 'delivery',
      dispatchAttempt: 2,
      codexAppInput: { text: 'external event' },
    }]);

    const cleanIm = [{
      content: 'legacy IM',
      turnId: 'im-1',
      vcMeetingImTurnOrigin: imOrigin,
      codexAppInput: { text: 'human follow-up' },
    }];
    expect(mergeQueuedCliInput(cleanIm, {
      content: 'legacy delivery',
      turnId: 'delivery',
      dispatchAttempt: 3,
      codexAppInput: { text: 'external event' },
    })).toBe(false);
    expect(cleanIm).toEqual([{
      content: 'legacy IM',
      turnId: 'im-1',
      vcMeetingImTurnOrigin: imOrigin,
      codexAppInput: { text: 'human follow-up' },
    }]);
  });

  it('never merges when only one side carries a clean sidecar', () => {
    const structuredTail = [{
      content: 'legacy-1',
      turnId: 't1',
      codexAppInput: { text: 'clean-1' },
    }];
    expect(mergeQueuedCliInput(structuredTail, {
      content: 'legacy-2',
      turnId: 't2',
    })).toBe(false);
    expect(structuredTail).toEqual([{
      content: 'legacy-1',
      turnId: 't1',
      codexAppInput: { text: 'clean-1' },
    }]);

    const ordinaryTail = [{ content: 'legacy-1', turnId: 't1' }];
    expect(mergeQueuedCliInput(ordinaryTail, {
      content: 'legacy-2',
      turnId: 't2',
      codexAppInput: { text: 'clean-2' },
    })).toBe(false);
    expect(ordinaryTail).toEqual([{ content: 'legacy-1', turnId: 't1' }]);
  });
});
