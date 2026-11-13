/**
 * Unit tests for the harness message-aware `waitFor` (related to #3455).
 *
 * The waiter re-runs the condition as soon as a worker IPC message arrives
 * instead of only on a 50 ms polling tick. This is a latency refinement, not a
 * change in satisfiability: the predicate, deadline and exit guard decide the
 * outcome, and a report the worker never sends still fails. The fake-timer tests
 * pin the message wake-up, the polling fallback, the deadline/exit guards and the
 * timer-ownership edge cases, so removing any piece fails deterministically
 * without needing a loaded runner.
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

  it('rejects on the child-exit guard without advancing any timer to the deadline', async () => {
    vi.useFakeTimers();
    const child = fakeMessageChild(1);
    const waitFor = createMessageAwareWaiter(child, () => 'snapshot');
    // A 60 s deadline that is never advanced. With the exitCode guard removed the
    // waiter would park on its 50 ms timer indefinitely, so settling here proves
    // the guard — not the deadline — rejected it.
    const pending = waitFor(() => false, 'an exit that never clears', 60_000);
    await Promise.resolve();
    await expect(pending).rejects.toThrow('an exit that never clears');
    expect(child.messageListenerCount()).toBe(0);
  });

  it('keeps waking immediately on a later message after an unrelated message reset the round', async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const child = fakeMessageChild();
    const waitFor = createMessageAwareWaiter(child, () => 'snapshot');
    let satisfied = false;
    const settledAt: number[] = [];
    const wait = waitFor(() => satisfied, 'the reported identity', 10_000);
    const pending = wait.then(() => settledAt.push(Date.now() - t0));
    await Promise.resolve();
    // t=20: an unrelated report wakes one check and arms a fresh round. The
    // previous round's 50 ms timer (due t=50) must be cleared so it cannot null
    // the new round's wake.
    setTimeout(() => child.emitMessage({ type: 'screen_update' }), 20);
    // t=55: the decisive report arrives before the t=70 poll. It must resolve at
    // 55 on the message, not wait for the timer.
    setTimeout(() => { satisfied = true; child.emitMessage({ type: 'runtime_binding' }); }, 55);
    await vi.advanceTimersByTimeAsync(55);
    await Promise.resolve();
    await Promise.resolve();
    await expect(wait).resolves.toBeUndefined();
    await pending;
    expect(settledAt[0]).toBe(55);
  });

  it('fails fast when a message wakes the check after the deadline has passed', async () => {
    vi.useFakeTimers();
    const child = fakeMessageChild();
    const waitFor = createMessageAwareWaiter(child, () => 'snapshot');
    let satisfied = false;
    // 990 ms deadline: the last pre-deadline poll is t=950, the next tick t=1000.
    const pending = waitFor(() => satisfied, 'a late report', 990);
    const outcome = pending.then(() => 'resolved', () => 'rejected');
    await Promise.resolve();
    // An unrelated message at t=995 (past the deadline) forces an immediate
    // re-check; the predicate only flips true at t=997, which pure polling would
    // not observe until its t=1000 tick. The event-driven waiter fails fast.
    setTimeout(() => child.emitMessage({ type: 'screen_update' }), 995);
    setTimeout(() => { satisfied = true; }, 997);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBe('rejected');
    expect(child.messageListenerCount()).toBe(0);
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
