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
  it('reposts one replacement card when a PATCH hits a terminal error, then stops retrying the dead message', async () => {
    class TerminalCardError extends Error {}
    const f = fixture(undefined, (error: unknown) => error instanceof TerminalCardError);
    f.controller.update(active); await f.controller.settled();
    expect(f.post).toHaveBeenCalledTimes(1);
    f.post.mockResolvedValueOnce('om_replacement');
    f.patch.mockImplementationOnce(async () => { throw new TerminalCardError('withdrawn'); });
    f.controller.update({ ...active, status: 'complete', updatedAt: active.updatedAt + 1, timeUsedSeconds: 11 });
    await f.controller.settled();
    // The replacement is driven by the next 2s refresh tick, not inline.
    await vi.advanceTimersByTimeAsync(2000);
    await f.controller.settled();
    // The dead message id is abandoned and exactly one replacement card is posted.
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.patch.mock.calls.at(-1)![0]).toBe('om_replacement');
    const callsAfterRepost = f.patch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.patch).toHaveBeenCalledTimes(callsAfterRepost);
    expect(f.state()?.postState).toBe('sent');
    expect(vi.getTimerCount()).toBe(0);
    f.controller.dispose();
  });
  it('disarms the timer when both the terminal PATCH and its replacement POST fail', async () => {
    class TerminalCardError extends Error {}
    const f = fixture(undefined, (error: unknown) => error instanceof TerminalCardError);
    f.controller.update(active); await f.controller.settled();
    f.patch.mockImplementationOnce(async () => { throw new TerminalCardError('withdrawn'); });
    f.post.mockRejectedValueOnce(new TerminalCardError('topic unavailable'));
    f.controller.update({ ...active, status: 'complete', updatedAt: active.updatedAt + 1, timeUsedSeconds: 11 });
    await f.controller.settled();
    await vi.advanceTimersByTimeAsync(2000);
    await f.controller.settled();
    expect(f.state()?.postState).toBe('uncertain');
    const posts = f.post.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.post).toHaveBeenCalledTimes(posts);
    expect(vi.getTimerCount()).toBe(0);
    f.controller.dispose();
  });
  it('reposts at most once: a second terminal failure disarms instead of alternating POST and PATCH forever', async () => {
    class TerminalCardError extends Error {}
    const f = fixture(undefined, (error: unknown) => error instanceof TerminalCardError);
    let postSeq = 0;
    f.post.mockImplementation(async () => postSeq++ === 0 ? 'om_goal_card' : 'om_replacement');
    f.controller.update(active); await f.controller.settled();
    f.patch.mockImplementation(async () => { throw new TerminalCardError('withdrawn'); });
    f.controller.update({ ...active, status: 'complete', updatedAt: active.updatedAt + 1, timeUsedSeconds: 11 });
    await f.controller.settled();
    await vi.advanceTimersByTimeAsync(10000);
    await f.controller.settled();
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.state()?.postState).toBe('sent');
    expect(f.state()?.pendingPatch).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
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
