import { describe, expect, it } from 'vitest';
import { mergeQueuedCliInput } from '../src/utils/pending-input-queue.js';

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
});
