import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalStatusCardController, buildGoalStatusCard, goalElapsedSeconds, goalStatusCardOrigin, type GoalStatusCardRecord } from '../src/core/goal-status-card.js';
import type { NativeGoalState } from '../src/services/native-goal-state.js';

const active: NativeGoalState = { objective: '修复登录并通过测试', status: 'active', createdAt: 1_700_000_000, updatedAt: 1_700_000_010, timeUsedSeconds: 10 };
function fixture(initial?: GoalStatusCardRecord, isTerminalError?: (error: unknown) => boolean) {
  let state: GoalStatusCardRecord | undefined = initial;
  let owns = true;
  const post = vi.fn(async () => 'om_goal_card');
  const patch = vi.fn(async () => {});
  const save = (record: GoalStatusCardRecord) => { state = record; };
  const deps = { read: () => state, save, post, patch, owns: () => owns, warn: vi.fn(), now: () => Date.now(),
    ...(isTerminalError ? { isTerminalError } : {}) };
  const controller = new GoalStatusCardController(deps);
  return { deps, controller, post, patch, state: () => state, retire: () => { owns = false; } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_700_000_010_000); });
afterEach(() => vi.useRealTimers());

describe('native goal status card', () => {
  it('posts once, animates the same card, then completes it and stops ticking', async () => {
    const f = fixture();
    f.controller.update(active, 'om_start'); await f.controller.settled();
    expect(f.post).toHaveBeenCalledTimes(1);
    const initial = JSON.parse(f.patch.mock.calls[0][1]);
    expect(initial.header.title.content).toContain('目标进行中');
    await vi.advanceTimersByTimeAsync(2000);
    const animated = JSON.parse(f.patch.mock.calls.at(-1)![1]);
    expect(animated.header.title.content).not.toBe(initial.header.title.content);
    expect(animated.body.elements[1].content).toBe('已运行：00:00:10');
    f.controller.update({ ...active, status: 'complete', updatedAt: active.updatedAt + 5, timeUsedSeconds: 15 });
    await f.controller.settled();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.patch.mock.calls.every(call => call[0] === 'om_goal_card')).toBe(true);
    const completed = JSON.parse(f.patch.mock.calls.at(-1)![1]);
    expect(completed.header.title.content).toContain('目标已完成');
    expect(completed.header.template).toBe('green');
    expect(completed.body.elements[1].content).toBe('已运行：00:00:15');
    const count = f.patch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.patch).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
    f.controller.dispose();
  });
  it('names every status the native goal store can hold instead of the unknown-status fallback', () => {
    // thread_goals.status CHECK constraint in Codex/TRAE goals_1.sqlite.
    const statuses = ['active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete'];
    const fallback = (locale: 'zh' | 'en') => JSON.parse(buildGoalStatusCard({ ...active, status: 'unknown' }, Date.now(), locale)).header.title.content.split(' — ')[1];
    for (const locale of ['zh', 'en'] as const) {
      const labels = statuses.map(status => JSON.parse(buildGoalStatusCard({ ...active, status }, Date.now(), locale)).header.title.content.split(' — ')[1].replace(/ ·+$/, ''));
      expect(labels).not.toContain(fallback(locale));
      expect(new Set(labels).size).toBe(statuses.length);
    }
  });
  it('uses the CLI counter instead of inferring elapsed time from the local clock', () => {
    expect(goalElapsedSeconds(active)).toBe(10);
    expect(JSON.parse(buildGoalStatusCard(active, Date.now() + 90_000)).body.elements[1].content).toBe('已运行：00:00:10');
  });
  it('applies completion arriving during the first POST to the original message', async () => {
    const f = fixture();
    let release!: (id: string) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.post.mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = resolve; }); });
    f.controller.update(active); await started;
    f.controller.update({ ...active, status: 'complete', updatedAt: active.updatedAt + 1, timeUsedSeconds: 11 });
    release('om_goal_card'); await f.controller.settled();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.patch.mock.calls.at(-1)![1]).header.title.content).toContain('目标已完成');
    f.controller.dispose();
  });
  it('recovers a known card after restart without posting a second card', async () => {
    const f = fixture({ goal: active, uuid: 'uuid', messageId: 'om_existing', postState: 'sent', pendingPatch: false });
    f.controller.update({ ...active, status: 'complete', updatedAt: active.updatedAt + 1, timeUsedSeconds: 11 });
    await f.controller.settled();
    expect(f.post).not.toHaveBeenCalled();
    expect(f.patch).toHaveBeenCalledWith('om_existing', expect.any(String), expect.any(Number), expect.any(String));
    f.controller.dispose();
  });
  it('does not duplicate an uncertain POST across restart or timer ticks', async () => {
    const f = fixture();
    f.post.mockRejectedValueOnce(new Error('response unknown'));
    f.controller.update(active); await f.controller.settled();
    expect(f.state()?.postState).toBe('uncertain');
    f.controller.dispose();
    const restored = new GoalStatusCardController(f.deps);
    restored.update({ ...active, updatedAt: active.updatedAt + 1 }); await restored.settled();
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.post).toHaveBeenCalledTimes(1);
    restored.dispose();
  });
  it('retries a failed completion PATCH on the same card and then stops', async () => {
    const f = fixture({ goal: active, uuid: 'uuid', messageId: 'om_existing', postState: 'sent', pendingPatch: false });
    f.patch.mockRejectedValueOnce(new Error('temporary failure'));
    f.controller.update({ ...active, status: 'complete', updatedAt: active.updatedAt + 1, timeUsedSeconds: 11 });
    await f.controller.settled();
    expect(f.state()?.pendingPatch).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.patch).toHaveBeenCalledTimes(2);
    expect(f.state()?.pendingPatch).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    f.controller.dispose();
  });
  it('rejects stale active events after a completed goal', async () => {
    const f = fixture();
    const completed = { ...active, status: 'complete', updatedAt: active.updatedAt + 1, timeUsedSeconds: 11 };
    f.controller.update(completed); await f.controller.settled();
    f.controller.update(active); await f.controller.settled();
    expect(f.state()?.goal.status).toBe('complete');
    expect(f.post).toHaveBeenCalledTimes(1);
    f.controller.dispose();
  });
  it('serializes replacement-controller writes behind an old in-flight PATCH', async () => {
    const f = fixture({ goal: active, uuid: 'uuid', messageId: 'om_existing', postState: 'sent', pendingPatch: false });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.patch.mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = resolve; }); });
    f.controller.update(active); await started;
    f.retire();
    const nextPatch = vi.fn(async () => {});
    const next = new GoalStatusCardController({ ...f.deps, owns: () => true, patch: nextPatch });
    next.update({ ...active, status: 'complete', updatedAt: active.updatedAt + 1, timeUsedSeconds: 11 });
    expect(nextPatch).not.toHaveBeenCalled();
    release(); await next.settled();
    expect(JSON.parse(nextPatch.mock.calls[0][1]).header.title.content).toContain('目标已完成');
    f.controller.dispose(); next.dispose();
  });
  it('stops rendering when the worker no longer owns the session', async () => {
    const f = fixture(); f.controller.update(active); await f.controller.settled();
    f.retire(); const count = f.patch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.patch).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
    f.controller.dispose();
  });
  it('leaves a withdrawn card as it is: no retry and no repost of the same goal', async () => {
    class TerminalCardError extends Error {}
    const f = fixture(undefined, (error: unknown) => error instanceof TerminalCardError);
    f.controller.update(active); await f.controller.settled();
    f.patch.mockImplementation(async () => { throw new TerminalCardError('withdrawn'); });
    f.controller.update({ ...active, status: 'complete', updatedAt: active.updatedAt + 1, timeUsedSeconds: 11 });
    await f.controller.settled();
    const patches = f.patch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000); await f.controller.settled();
    expect(f.patch).toHaveBeenCalledTimes(patches);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.state()).toMatchObject({ messageId: 'om_goal_card', dead: true, pendingPatch: false });
    expect(vi.getTimerCount()).toBe(0);
    // Later reports of the same goal (edits, a replacement worker) stay off the dead card.
    f.controller.update({ ...active, status: 'complete', objective: 'edited', updatedAt: active.updatedAt + 2, timeUsedSeconds: 12 });
    await f.controller.settled(); await vi.advanceTimersByTimeAsync(4000);
    expect(f.post).toHaveBeenCalledTimes(1); expect(f.patch).toHaveBeenCalledTimes(patches);
    f.controller.dispose();
  });
  it('stops animating an active goal once its card is withdrawn', async () => {
    class TerminalCardError extends Error {}
    const f = fixture(undefined, (error: unknown) => error instanceof TerminalCardError);
    f.controller.update(active); await f.controller.settled();
    f.patch.mockImplementation(async () => { throw new TerminalCardError('withdrawn'); });
    await vi.advanceTimersByTimeAsync(2000); await f.controller.settled();
    const patches = f.patch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000); await f.controller.settled();
    expect(f.patch).toHaveBeenCalledTimes(patches);
    expect(f.state()?.dead).toBe(true); expect(vi.getTimerCount()).toBe(0);
    f.controller.dispose();
  });
  it('does not stall an active card over occasional failures between successful writes', async () => {
    const f = fixture(); f.controller.update(active); await f.controller.settled();
    let tick = 0;
    f.patch.mockImplementation(async () => { if (tick++ % 2 === 0) throw new Error('transient'); });
    await vi.advanceTimersByTimeAsync(24_000); await f.controller.settled();
    // Every 2 s tick still writes: a success clears the failure backoff.
    expect(f.patch.mock.calls.length).toBeGreaterThanOrEqual(12);
    expect(vi.getTimerCount()).toBe(1);
    f.controller.dispose();
  });
  it('gives a different goal its own card once the previous card is dead', async () => {
    class TerminalCardError extends Error {}
    const f = fixture({ goal: { ...active, goalId: 'g1' }, uuid: 'old', messageId: 'om_dead', postState: 'sent', pendingPatch: false, dead: true },
      (error: unknown) => error instanceof TerminalCardError);
    f.post.mockResolvedValueOnce('om_next');
    f.controller.update({ ...active, goalId: 'g2', objective: 'next goal', createdAt: active.createdAt + 50, updatedAt: active.updatedAt + 50 }, 'om_turn2');
    await f.controller.settled();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.post.mock.calls[0][1]).not.toBe('old');
    expect(f.post.mock.calls[0][2]).toBe('om_turn2');
    expect(f.patch.mock.calls.every(call => call[0] === 'om_next')).toBe(true);
    expect(f.state()?.dead).toBeUndefined();
    f.controller.dispose();
  });
  it('backs off a persistently failing completion PATCH and delivers it once Feishu recovers', async () => {
    const f = fixture({ goal: active, uuid: 'uuid', messageId: 'om_existing', postState: 'sent', pendingPatch: false });
    f.patch.mockImplementation(async () => { throw new Error('service unavailable'); });
    f.controller.update({ ...active, status: 'complete', updatedAt: active.updatedAt + 1, timeUsedSeconds: 11 });
    await f.controller.settled();
    await vi.advanceTimersByTimeAsync(10 * 60_000); await f.controller.settled();
    // Doubling delays: a handful of calls in ten minutes instead of one per 2 s tick.
    const attempts = f.patch.mock.calls.length;
    expect(attempts).toBeGreaterThan(3); expect(attempts).toBeLessThan(15);
    expect(f.state()?.pendingPatch).toBe(true);
    // No new goal event will come for a finished goal; the retry alone must land it.
    f.patch.mockImplementation(async () => {});
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 2000); await f.controller.settled();
    expect(f.patch).toHaveBeenCalledTimes(attempts + 1);
    expect(JSON.parse(f.patch.mock.calls.at(-1)![1]).header.title.content).toContain('目标已完成');
    expect(f.state()?.pendingPatch).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    f.controller.dispose();
  });
  it('backs off an active card that cannot be written, and retries at once on the next goal change', async () => {
    const f = fixture({ goal: active, uuid: 'uuid', messageId: 'om_existing', postState: 'sent', pendingPatch: false });
    f.patch.mockImplementation(async () => { throw new Error('past the edit window'); });
    f.controller.update({ ...active, updatedAt: active.updatedAt + 1, timeUsedSeconds: 11 });
    await vi.advanceTimersByTimeAsync(10 * 60_000); await f.controller.settled();
    const attempts = f.patch.mock.calls.length;
    expect(attempts).toBeLessThan(15);
    f.patch.mockImplementation(async () => {});
    f.controller.update({ ...active, updatedAt: active.updatedAt + 2, timeUsedSeconds: 12 });
    await f.controller.settled();
    expect(f.patch).toHaveBeenCalledTimes(attempts + 1);
    await vi.advanceTimersByTimeAsync(4000); await f.controller.settled();
    expect(f.patch.mock.calls.length).toBeGreaterThan(attempts + 1);
    f.controller.dispose();
  });
  it('does not pile up writes behind a slow failing PATCH', async () => {
    const f = fixture({ goal: active, uuid: 'slow', messageId: 'om_existing', postState: 'sent', pendingPatch: false });
    f.patch.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000)));
    f.controller.update({ ...active, updatedAt: active.updatedAt + 1, timeUsedSeconds: 11 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // Unbounded queueing would issue one write per 2 s tick (~50 here).
    expect(f.patch.mock.calls.length).toBeLessThan(12);
    f.controller.dispose();
    await vi.advanceTimersByTimeAsync(10_000); await f.controller.settled();
  });
  it('gives a new goal its own card when the old card turns out withdrawn on the first write of the new goal', async () => {
    class TerminalCardError extends Error {}
    const f = fixture(undefined, (error: unknown) => error instanceof TerminalCardError);
    f.post.mockResolvedValueOnce('om_a');
    f.controller.update({ ...active, goalId: 'g1' }, 'om_turn_a'); await f.controller.settled();
    f.controller.update({ ...active, goalId: 'g1', status: 'complete', updatedAt: active.updatedAt + 5, timeUsedSeconds: 15 });
    await f.controller.settled();
    f.post.mockClear();
    // Goal A's card is recalled afterwards; goal B's first write discovers it.
    f.patch.mockImplementationOnce(async () => { throw new TerminalCardError('withdrawn'); });
    f.post.mockResolvedValueOnce('om_b');
    const next = { ...active, goalId: 'g2', objective: 'goal B', createdAt: active.createdAt + 50, updatedAt: active.updatedAt + 50 };
    f.controller.update(next, 'om_turn_b'); await f.controller.settled();
    await vi.advanceTimersByTimeAsync(2000); await f.controller.settled();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.post.mock.calls[0][1]).not.toBe('old'); expect(f.post.mock.calls[0][2]).toBe('om_turn_b');
    expect(f.state()).toMatchObject({ messageId: 'om_b', goal: { goalId: 'g2' } });
    expect(f.state()?.dead).toBeUndefined();
    f.controller.dispose();
  });
  it('does not repost a goal the withdrawn card had already shown', async () => {
    class TerminalCardError extends Error {}
    const f = fixture(undefined, (error: unknown) => error instanceof TerminalCardError);
    f.controller.update({ ...active, goalId: 'g1' }); await f.controller.settled();
    const next = { ...active, goalId: 'g2', objective: 'goal B', createdAt: active.createdAt + 50, updatedAt: active.updatedAt + 50 };
    f.controller.update(next); await f.controller.settled();
    f.patch.mockImplementation(async () => { throw new TerminalCardError('withdrawn'); });
    f.controller.update({ ...next, status: 'complete', updatedAt: next.updatedAt + 1 }); await f.controller.settled();
    await vi.advanceTimersByTimeAsync(4000); await f.controller.settled();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.state()).toMatchObject({ dead: true, goal: { goalId: 'g2' } });
    f.controller.dispose();
  });
  it('remembers a goal shown by a write that landed while a newer update was queued', async () => {
    class TerminalCardError extends Error {}
    const f = fixture(undefined, (error: unknown) => error instanceof TerminalCardError);
    f.controller.update({ ...active, goalId: 'g1' }); await f.controller.settled();
    const next = { ...active, goalId: 'g2', objective: 'goal B', createdAt: active.createdAt + 50, updatedAt: active.updatedAt + 50 };
    let land!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.patch.mockImplementationOnce(() => { entered(); return new Promise<void>(resolve => { land = resolve; }); });
    f.controller.update(next); await started;
    f.controller.update({ ...next, updatedAt: next.updatedAt + 1, timeUsedSeconds: 61 });
    f.patch.mockImplementation(async () => { throw new TerminalCardError('withdrawn'); });
    land(); await f.controller.settled(); await vi.advanceTimersByTimeAsync(4000); await f.controller.settled();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.state()).toMatchObject({ dead: true, goal: { goalId: 'g2' } });
    f.controller.dispose();
  });
  it('knows a freshly posted card showed its goal even when the follow-up write failed', async () => {
    class TerminalCardError extends Error {}
    const f = fixture(undefined, (error: unknown) => error instanceof TerminalCardError);
    f.post.mockResolvedValueOnce('om_a');
    f.patch.mockImplementationOnce(async () => { throw new Error('transient'); });
    f.controller.update({ ...active, goalId: 'g1' }); await f.controller.settled();
    f.patch.mockImplementationOnce(async () => { throw new TerminalCardError('withdrawn'); });
    f.post.mockResolvedValueOnce('om_b');
    f.controller.update({ ...active, goalId: 'g2', objective: 'goal B', createdAt: active.createdAt + 50, updatedAt: active.updatedAt + 50 });
    await f.controller.settled(); await vi.advanceTimersByTimeAsync(2000); await f.controller.settled();
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.state()).toMatchObject({ messageId: 'om_b', goal: { goalId: 'g2' } });
    f.controller.dispose();
  });
  it('gives a goal its own card when it replaced the goal of a first POST that then failed', async () => {
    const f = fixture();
    let fail!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.post.mockImplementationOnce(() => { entered(); return new Promise<string>((_, reject) => { fail = () => reject(new Error('response unknown')); }); });
    f.controller.update({ ...active, goalId: 'g1' }); await started;
    const next = { ...active, goalId: 'g2', objective: 'goal B', createdAt: active.createdAt + 50, updatedAt: active.updatedAt + 50 };
    f.controller.update(next);
    fail(); await f.controller.settled();
    expect(f.state()?.postState).toBe('uncertain');
    f.post.mockResolvedValueOnce('om_b');
    f.controller.update({ ...next, updatedAt: next.updatedAt + 1 }); await f.controller.settled();
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.state()).toMatchObject({ messageId: 'om_b', goal: { goalId: 'g2' } });
    f.controller.dispose();
  });
  it('coalesces rapid goal changes behind a slow write and still lands the last state', async () => {
    const f = fixture({ goal: active, uuid: 'coalesce', messageId: 'om_existing', postState: 'sent', pendingPatch: false });
    f.patch.mockImplementation(() => new Promise<void>(resolve => setTimeout(resolve, 6000)));
    for (let i = 1; i <= 40; i++) {
      f.controller.update({ ...active, updatedAt: active.updatedAt + i, timeUsedSeconds: 10 + i });
      await vi.advanceTimersByTimeAsync(500);
    }
    f.controller.update({ ...active, status: 'paused', updatedAt: active.updatedAt + 100, timeUsedSeconds: 60 });
    await vi.advanceTimersByTimeAsync(30_000); await f.controller.settled();
    // Queued flushes read the latest state and skip identical frames, so the
    // backlog collapses instead of replaying 41 stale writes 6 s apart.
    expect(f.patch.mock.calls.length).toBeLessThan(12);
    expect(JSON.parse(f.patch.mock.calls.at(-1)![1]).header.title.content).toContain('目标已暂停');
    expect(f.state()?.pendingPatch).toBe(false);
    f.controller.dispose();
  });
  it('gives a new goal its own card after a POST whose outcome was never confirmed', async () => {
    const f = fixture({ goal: { ...active, goalId: 'g1' }, uuid: 'old', postState: 'uncertain', pendingPatch: true });
    f.post.mockResolvedValueOnce('om_b');
    f.controller.update({ ...active, goalId: 'g1', updatedAt: active.updatedAt + 1 }); await f.controller.settled();
    expect(f.post).not.toHaveBeenCalled();
    f.controller.update({ ...active, goalId: 'g2', createdAt: active.createdAt + 50, updatedAt: active.updatedAt + 50 }, 'om_turn_b');
    await f.controller.settled();
    expect(f.post).toHaveBeenCalledTimes(1); expect(f.post.mock.calls[0][1]).not.toBe('old');
    f.controller.dispose();
  });
  it('does not write a withdrawn card again for a change queued behind the failing write', async () => {
    class TerminalCardError extends Error {}
    const f = fixture({ goal: active, uuid: 'uuid', messageId: 'om_existing', postState: 'sent', pendingPatch: false },
      (error: unknown) => error instanceof TerminalCardError);
    let fail!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.patch.mockImplementationOnce(() => { entered(); return new Promise((_, reject) => { fail = () => reject(new TerminalCardError('withdrawn')); }); });
    f.controller.update({ ...active, updatedAt: active.updatedAt + 1, timeUsedSeconds: 11 }); await started;
    f.controller.update({ ...active, updatedAt: active.updatedAt + 2, timeUsedSeconds: 12 });
    fail(); await f.controller.settled(); await vi.advanceTimersByTimeAsync(4000);
    expect(f.patch).toHaveBeenCalledTimes(1);
    expect(f.state()).toMatchObject({ dead: true, goal: { timeUsedSeconds: 12 } });
    f.controller.dispose();
  });
  it('does not re-PATCH a settled card when a replacement worker re-reports the same goal', async () => {
    const complete = { ...active, goalId: 'g1', status: 'complete', updatedAt: active.updatedAt + 5, timeUsedSeconds: 15 };
    const f = fixture({ goal: complete, uuid: 'uuid', messageId: 'om_existing', postState: 'sent', pendingPatch: false, sequence: 4 });
    f.controller.update({ ...complete }); await f.controller.settled();
    expect(f.patch).not.toHaveBeenCalled();
    vi.setSystemTime(1_700_000_100_000);
    f.controller.update(null); await f.controller.settled();
    expect(f.patch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.patch.mock.calls[0][1]).header.title.content).toContain('目标已清除');
    f.controller.dispose();
    vi.setSystemTime(1_700_000_200_000);
    const restored = new GoalStatusCardController(f.deps);
    restored.update(null); await restored.settled();
    expect(f.patch).toHaveBeenCalledTimes(1); expect(f.post).not.toHaveBeenCalled();
    restored.dispose();
  });
  it('a replacement worker still delivers a card update that was left behind', async () => {
    const complete = { ...active, status: 'complete', updatedAt: active.updatedAt + 5, timeUsedSeconds: 15 };
    const f = fixture({ goal: complete, uuid: 'uuid', messageId: 'om_existing', postState: 'sent', pendingPatch: true, sequence: 4 });
    f.controller.update({ ...complete }); await f.controller.settled();
    expect(f.patch).toHaveBeenCalledWith('om_existing', expect.any(String), 5, 'uuid-5');
    expect(f.state()?.pendingPatch).toBe(false);
    f.controller.dispose();
  });
});

describe('goal card delivery and source guards', () => {
  it.each(['active', 'paused', 'blocked'])('does not downgrade completion to stale %s with an equal timestamp', async status => {
    const f = fixture();
    const goal = { ...active, status: 'complete', updatedAt: active.updatedAt + 1 };
    f.controller.update(goal); await f.controller.settled();
    f.controller.update({ ...goal, status }); await f.controller.settled();
    expect(f.state()?.goal.status).toBe('complete');
    f.controller.dispose();
  });
  it('does not keep an inert interval after an uncertain POST and completion', async () => {
    const f = fixture(); f.post.mockRejectedValueOnce(new Error('unknown'));
    f.controller.update(active); await f.controller.settled();
    f.controller.update({ ...active, status: 'complete', updatedAt: active.updatedAt + 1 }); await f.controller.settled();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.post).toHaveBeenCalledTimes(1);
    f.controller.dispose();
  });
  it('does not write a goal card when its source is hidden', async () => {
    const f = fixture();
    const controller = new GoalStatusCardController({ ...f.deps, canDisplay: () => false });
    controller.update(active); await controller.settled();
    expect(f.post).not.toHaveBeenCalled(); expect(f.state()).toBeUndefined();
    controller.dispose(); f.controller.dispose();
  });
  it('stops animation if a source becomes hidden and resumes on a new visible update', async () => {
    const f = fixture(); let display = true;
    const controller = new GoalStatusCardController({ ...f.deps, canDisplay: () => display });
    controller.update(active); await controller.settled();
    display = false; const count = f.patch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.patch).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0);
    display = true; controller.update({ ...active, updatedAt: active.updatedAt + 2, timeUsedSeconds: 12 }); await controller.settled();
    expect(f.patch.mock.calls.length).toBeGreaterThan(count);
    controller.dispose(); f.controller.dispose();
  });
  it('does not patch a previous app/chat binding with a new binding', async () => {
    const f = fixture({ goal: active, uuid: 'old', messageId: 'om_old_chat', binding: 'old', postState: 'sent', pendingPatch: false });
    const controller = new GoalStatusCardController({ ...f.deps, binding: 'new' });
    controller.update(active); await controller.settled();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.patch.mock.calls.some(call => call[0] === 'om_old_chat')).toBe(false);
    controller.dispose(); f.controller.dispose();
  });
  it('persists increasing sequence numbers so delayed frames cannot overwrite newer states', async () => {
    const f = fixture(); f.controller.update(active); await f.controller.settled();
    await vi.advanceTimersByTimeAsync(2000);
    f.controller.update({ ...active, status: 'complete', updatedAt: active.updatedAt + 2, timeUsedSeconds: 12 }); await f.controller.settled();
    const sequences = f.patch.mock.calls.map(call => call[2]);
    expect(sequences.every((value, index) => index === 0 || value > sequences[index - 1])).toBe(true);
    expect(f.state()?.sequence).toBe(sequences.at(-1));
    f.controller.dispose();
  });
  it('keeps a hidden goal hidden when a later normal turn updates its CLI metrics', () => {
    const hidden = goalStatusCardOrigin(undefined, active, { binding: 'b', turnId: 'silent', hidden: true });
    const next = goalStatusCardOrigin(hidden, { ...active, goalId: 'g', timeUsedSeconds: 12 }, { binding: 'b', turnId: 'human', hidden: false });
    expect(next.hidden).toBe(true); expect(next.turnId).toBe('silent');
  });
  it('permits a new public goal without inheriting an unrelated hidden goal', () => {
    const hidden = goalStatusCardOrigin(undefined, active, { binding: 'old', turnId: 'silent', hidden: true });
    const next = goalStatusCardOrigin(hidden, { ...active, goalId: 'new', objective: 'public goal', createdAt: 112 }, { binding: 'new', turnId: 'human', hidden: false });
    expect(next.hidden).toBe(false); expect(next.turnId).toBe('human');
  });
});

describe('native goal identity retains display policy', () => {
  it('keeps a silent goal hidden after the session moves to another chat', () => {
    // Session transfer rewrites chatId/rootMessageId on the same session, so the
    // binding changes while the native goal stays the same.
    const goal = { ...active, goalId: 'g1' };
    const origin = goalStatusCardOrigin(undefined, goal, { binding: 'app:oc_a:om_a:s', turnId: 'silent', hidden: true });
    const moved = goalStatusCardOrigin(origin, { ...goal, timeUsedSeconds: 30 }, { binding: 'app:oc_b:om_b:s', turnId: 'human', hidden: false });
    expect(moved.hidden).toBe(true); expect(moved.binding).toBe('app:oc_b:om_b:s');
  });
  it('keeps a silent goal hidden across a normal objective edit with the same native ID', () => {
    const goal = { ...active, goalId: 'g1' };
    const origin = goalStatusCardOrigin(undefined, goal, { binding: 'b', turnId: 'silent', hidden: true });
    const edited = goalStatusCardOrigin(origin, { ...goal, objective: 'edited goal' }, { binding: 'b', turnId: 'human', hidden: false });
    expect(edited.hidden).toBe(true); expect(edited.turnId).toBe('silent');
  });
  it('does not expose a public goal after a suppressed edit inserts private content', () => {
    const goal = { ...active, goalId: 'g1' };
    const origin = goalStatusCardOrigin(undefined, goal, { binding: 'b', turnId: 'human', hidden: false });
    const hidden = goalStatusCardOrigin(origin, { ...goal, objective: 'private edit' }, { binding: 'b', turnId: 'silent', hidden: true });
    const restored = goalStatusCardOrigin(hidden, { ...goal, objective: 'private edit', timeUsedSeconds: 12 }, { binding: 'b', turnId: 'human', hidden: false });
    expect(hidden.hidden).toBe(true); expect(restored.hidden).toBe(true);
  });
});
