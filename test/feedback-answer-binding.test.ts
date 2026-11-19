import { describe, expect, it } from 'vitest';
import { feedbackAnswerGroups } from '../src/services/feedback-answer-binding.js';
import type { CompatibleFeedbackStore } from '../src/services/feedback-storage-types.js';

type Delivery = NonNullable<Awaited<ReturnType<CompatibleFeedbackStore['findDeliveryById']>>>;
const delivery = (turnId: string, messageId: string, status: string): Delivery => ({
  botAppId: 'app', sessionId: 'session', turnId, platformMessageId: messageId, status,
} as Delivery);

describe('logical feedback answer ordering', () => {
  it('waits for an earlier answer terminal instead of numbering a later completed turn first', () => {
    expect(feedbackAnswerGroups([delivery('first', 'a', 'delivered'), delivery('second', 'b', 'completed')])).toEqual([]);
    expect(feedbackAnswerGroups([delivery('first', 'a', 'completed'), delivery('second', 'b', 'completed')])
      .map(group => [group.round, group.delivery.platformMessageId])).toEqual([[1, 'a'], [2, 'b']]);
  });
  it('groups a multi-message answer into a single round and retains every message reference', () => {
    const groups = feedbackAnswerGroups([delivery('first', 'a', 'completed'), delivery('first', 'b', 'completed'), delivery('second', 'c', 'completed')]);
    expect(groups.map(group => group.round)).toEqual([1, 2]);
    expect(groups[0].messageIds).toEqual(['a', 'b']);
  });
});
