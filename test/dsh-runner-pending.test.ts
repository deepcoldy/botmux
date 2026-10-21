import { describe, it, expect } from 'vitest';
import { appendPendingNotification, MAX_PENDING_NOTIFICATIONS } from '../src/dsh-runner-pending.js';

describe('appendPendingNotification', () => {
  it('appends while below the cap', () => {
    const pending: number[] = [];
    appendPendingNotification(pending, 1);
    appendPendingNotification(pending, 2);
    expect(pending).toEqual([1, 2]);
  });

  it('caps the buffer length and drops the oldest entry', () => {
    const pending: number[] = [];
    for (let i = 0; i < MAX_PENDING_NOTIFICATIONS + 5; i++) appendPendingNotification(pending, i);
    expect(pending).toHaveLength(MAX_PENDING_NOTIFICATIONS);
    // CAP+5 pushes with 5 overflows drop entries 0..4; the rest survive in order.
    expect(pending[0]).toBe(5);
    expect(pending[pending.length - 1]).toBe(MAX_PENDING_NOTIFICATIONS + 4);
  });
});
