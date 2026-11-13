/**
 * Unit tests for the harness event-driven `waitFor` (issue #3455).
 *
 * The integration wait must resolve when the worker's IPC report arrives, not
 * when a fixed polling tick happens to run inside a time window — on a saturated
 * CI runner the timer stretches and the report's arrival can outlast the tick
 * budget even though IPC delivered it. These tests pin that message-event
 * wake-up with fake timers, so removing the event subscription fails
 * deterministically without needing a loaded runner.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageAwareWaiter, fakeMessageChild } from './helpers/claude-worker-harness.js';

afterEach(() => vi.useRealTimers());

describe('createMessageAwareWaiter', () => {
  it('resolves on a worker message without advancing any timer', async () => {
    vi.useFakeTimers();
    const child = fakeMessageChild();
    const waitFor = createMessageAwareWaiter(child, () => 'snapshot');
    let satisfied = false;
    const pending = waitFor(() => satisfied, 'the reported identity', 5_000);
    // Let the waiter subscribe and enter its first await.
    await Promise.resolve();
    expect(child.messageListenerCount()).toBe(1);

    // The IPC report arrives. Flip the condition, then emit the message. The
    // waiter must wake from the event alone; no fake timer is ever advanced.
    satisfied = true;
    child.emitMessage({ type: 'runtime_binding', identity: { nativeSessionId: 'sess-1' } });
    await Promise.resolve();
    await Promise.resolve();

    await expect(pending).resolves.toBeUndefined();
    // The subscription is torn down once the wait settles.
    expect(child.messageListenerCount()).toBe(0);
  });

  it('keeps waiting across messages that do not yet satisfy the condition', async () => {
    vi.useFakeTimers();
    const child = fakeMessageChild();
    const waitFor = createMessageAwareWaiter(child, () => 'snapshot');
    let satisfied = false;
    const pending = waitFor(() => satisfied, 'the reported identity', 5_000);
    await Promise.resolve();

    // An unrelated report wakes the check but the condition stays false.
    child.emitMessage({ type: 'screen_update' });
    await Promise.resolve();
    expect(child.messageListenerCount()).toBe(1);

    // The decisive report later resolves it, still with no timer advance.
    satisfied = true;
    child.emitMessage({ type: 'runtime_binding' });
    await Promise.resolve();
    await Promise.resolve();
    await expect(pending).resolves.toBeUndefined();
  });

  it('honours the deadline via the timer fallback when no message satisfies it', async () => {
    vi.useFakeTimers();
    const child = fakeMessageChild();
    const waitFor = createMessageAwareWaiter(child, () => 'snapshot');
    const pending = waitFor(() => false, 'a report that never comes', 1_000);
    // Attach the handler before advancing timers so the rejection produced on the
    // deadline is never observed as an unhandled rejection.
    const rejection = pending.then(() => undefined, error => error);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_100);
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain('timed out waiting for a report that never comes');
    expect(child.messageListenerCount()).toBe(0);
  });

  it('fails immediately when the worker child has already exited', async () => {
    const child = fakeMessageChild(1);
    const waitFor = createMessageAwareWaiter(child, () => 'snapshot');
    await expect(waitFor(() => false, 'an exit that never clears', 5_000)).rejects.toThrow();
  });

  it('still resolves a condition backed by no message through the polling fallback', async () => {
    vi.useFakeTimers();
    const child = fakeMessageChild();
    const waitFor = createMessageAwareWaiter(child, () => 'snapshot');
    let satisfied = false;
    const pending = waitFor(() => satisfied, 'a file-based condition', 1_000);
    await Promise.resolve();
    // No message is emitted; the 50 ms poll is the only thing that re-checks.
    setTimeout(() => { satisfied = true; }, 120);
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toBeUndefined();
  });
});
