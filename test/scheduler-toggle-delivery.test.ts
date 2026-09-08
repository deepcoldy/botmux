/** Unit tests for the task-level topic → top-level → new-topic position cycle. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScheduledTask } from '../src/types.js';

const store = new Map<string, ScheduledTask>();
const publish = vi.fn();

vi.mock('../src/services/schedule-store.js', () => ({
  canonicalScheduleInput: (task: ScheduledTask) => task,
  getTask: (id: string) => store.get(id),
  normalizeScheduleChatTargets: ({ chatId, chatIds }: { chatId: string; chatIds?: readonly string[] | null }) => {
    if (chatIds === undefined || chatIds === null) return { chatId };
    const unique = [...new Set(chatIds)];
    if (unique.length === 0) throw new TypeError('chat_id_required');
    return unique.length === 1 ? { chatId: unique[0] } : { chatId: unique[0], chatIds: unique };
  },
  updateTask: (id: string, updates: Partial<ScheduledTask>) => {
    const t = store.get(id);
    if (t) {
      Object.assign(t, updates);
      if ('chatIds' in updates && updates.chatIds === undefined) delete t.chatIds;
    }
  },
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: (...args: unknown[]) => publish(...args) },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function seed(deliver?: ScheduledTask['deliver'], overrides: Partial<ScheduledTask> = {}): string {
  const id = 'task-1';
  store.set(id, {
    id,
    name: 'demo',
    schedule: '0 9 * * *',
    parsed: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
    prompt: 'do it',
    workingDir: '/tmp',
    chatId: 'oc_x',
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    deliver,
    ...overrides,
  });
  return id;
}

beforeEach(() => {
  store.clear();
  publish.mockClear();
});

describe('scheduler.toggleDelivery', () => {
  it('switches a topic task to group top level and clears its retained root', async () => {
    // Parking at top level clears the root bookmark so no later toggle or
    // stale cache can re-enter the originating (e.g. adopted) topic.
    const { toggleDelivery } = await import('../src/core/scheduler.js');
    const id = seed('origin', { scope: 'thread', rootMessageId: 'om_root' });
    expect(toggleDelivery(id)).toEqual({
      ok: true,
      deliver: 'origin',
      executionPosition: 'top-level',
    });
    expect(store.get(id)).toMatchObject({ scope: 'chat', rootMessageId: undefined });
    expect(publish).toHaveBeenCalledWith({
      type: 'schedule.updated',
      body: { id, patch: { scope: 'chat', executionPosition: 'top-level', rootMessageId: null } },
    });
  });

  it('switches a top-level task to a fresh topic on every run', async () => {
    const { toggleDelivery } = await import('../src/core/scheduler.js');
    const id = seed('origin', { scope: 'chat', rootMessageId: 'om_root' });
    expect(toggleDelivery(id)).toEqual({
      ok: true,
      deliver: 'new-topic',
      executionPosition: 'new-topic',
    });
    expect(store.get(id)).toMatchObject({ scope: 'chat', rootMessageId: 'om_root', executionPosition: 'new-topic' });
  });

  it('allows a rootless top-level task to switch to a fresh topic', async () => {
    const { toggleDelivery } = await import('../src/core/scheduler.js');
    const id = seed('origin', { scope: 'chat' });
    expect(toggleDelivery(id)).toEqual({ ok: true, deliver: 'new-topic', executionPosition: 'new-topic' });
    expect(store.get(id)).toMatchObject({ scope: 'chat', executionPosition: 'new-topic' });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('parks a fresh-topic task at top level instead of re-entering its retained root', async () => {
    // The retained root may belong to the adopted topic the task was born in;
    // cycling back into it would deliver results to the wrong topic.
    const { toggleDelivery } = await import('../src/core/scheduler.js');
    const id = seed('origin', { scope: 'chat', executionPosition: 'new-topic', rootMessageId: 'om_root' });
    expect(toggleDelivery(id)).toEqual({ ok: true, deliver: 'origin', executionPosition: 'top-level' });
    expect(store.get(id)).toMatchObject({ scope: 'chat', executionPosition: 'top-level', rootMessageId: undefined });
  });

  it('switches a rootless fresh-topic task back to group top-level', async () => {
    const { toggleDelivery } = await import('../src/core/scheduler.js');
    const id = seed('origin', { scope: 'chat', executionPosition: 'new-topic' });
    expect(toggleDelivery(id)).toEqual({ ok: true, deliver: 'origin', executionPosition: 'top-level' });
    expect(store.get(id)).toMatchObject({ scope: 'chat', executionPosition: 'top-level' });
  });

  it('REFUSES to toggle a local task (Codex P3: never clobber log-only)', async () => {
    const { toggleDelivery } = await import('../src/core/scheduler.js');
    const id = seed('local');
    const r = toggleDelivery(id);
    expect(r).toEqual({ ok: false, error: 'local_not_toggleable' });
    // unchanged + no event
    expect(store.get(id)!.deliver).toBe('local');
    expect(publish).not.toHaveBeenCalled();
  });

  it('allows silent tasks to switch positions', async () => {
    const { toggleDelivery } = await import('../src/core/scheduler.js');
    const id = seed('origin', { scope: 'chat', rootMessageId: 'om_root', silent: true });
    const r = toggleDelivery(id);
    expect(r).toMatchObject({ ok: true, executionPosition: 'new-topic' });
    expect(store.get(id)!.scope).toBe('chat');
    expect(store.get(id)!.silent).toBe(true);
  });

  it('returns not_found for an unknown id without publishing', async () => {
    const { toggleDelivery } = await import('../src/core/scheduler.js');
    const r = toggleDelivery('missing');
    expect(r).toEqual({ ok: false, error: 'not_found' });
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('scheduler.updateTask', () => {
  it('publishes silent:false when disabling silent so dashboard caches clear stale true', async () => {
    const { updateTask } = await import('../src/core/scheduler.js');
    const id = seed('origin', { silent: true });

    expect(updateTask(id, { silent: false })).toEqual({ ok: true });

    expect(store.get(id)!.silent).toBeUndefined();
    expect(publish).toHaveBeenCalledWith({
      type: 'schedule.updated',
      body: { id, patch: { silent: false } },
    });
  });

  it('normalizes a multi-chat update and publishes the complete target patch', async () => {
    const { updateTask } = await import('../src/core/scheduler.js');
    const id = seed('origin', { scope: 'chat' });

    expect(updateTask(id, { chatIds: ['oc_two', 'oc_three', 'oc_two'] })).toEqual({ ok: true });
    expect(store.get(id)).toMatchObject({
      chatId: 'oc_two',
      chatIds: ['oc_two', 'oc_three'],
    });
    expect(publish).toHaveBeenCalledWith({
      type: 'schedule.updated',
      body: {
        id,
        patch: { chatId: 'oc_two', chatIds: ['oc_two', 'oc_three'] },
      },
    });
  });

  it('rejects a six-chat update without mutating or publishing', async () => {
    const { updateTask } = await import('../src/core/scheduler.js');
    const id = seed('origin', { scope: 'chat' });
    expect(updateTask(id, {
      name: 'must not change',
      chatIds: ['oc_one', 'oc_two', 'oc_three', 'oc_four', 'oc_five', 'oc_six'],
    })).toEqual({ ok: false, error: 'too_many_target_chats' });
    expect(store.get(id)).toMatchObject({ name: 'demo', chatId: 'oc_x' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps an unchanged legacy six-chat binding editable but rejects oversized changes', async () => {
    const { updateTask } = await import('../src/core/scheduler.js');
    const chatIds = ['oc_one', 'oc_two', 'oc_three', 'oc_four', 'oc_five', 'oc_six'];
    const id = seed('origin', { scope: 'chat', chatId: chatIds[0], chatIds });
    expect(updateTask(id, { name: 'renamed', chatIds: [...chatIds] })).toEqual({ ok: true });
    expect(updateTask(id, { silent: true })).toEqual({ ok: true });
    expect(store.get(id)).toMatchObject({ name: 'renamed', silent: true, chatIds });
    publish.mockClear();

    expect(updateTask(id, { chatIds: [...chatIds].reverse() }))
      .toEqual({ ok: false, error: 'too_many_target_chats' });
    expect(publish).not.toHaveBeenCalled();
    expect(updateTask(id, { chatIds: chatIds.slice(0, 5) })).toEqual({ ok: true });
    expect(store.get(id)?.chatIds).toEqual(chatIds.slice(0, 5));
  });

  it('collapses multi-chat to one and publishes null so Dashboard clears its cached array', async () => {
    const { updateTask } = await import('../src/core/scheduler.js');
    const id = seed('origin', {
      chatId: 'oc_one',
      chatIds: ['oc_one', 'oc_two'],
      scope: 'chat',
    });

    expect(updateTask(id, { chatIds: ['oc_two'] })).toEqual({ ok: true });
    expect(store.get(id)).toMatchObject({ chatId: 'oc_two' });
    expect(store.get(id)?.chatIds).toBeUndefined();
    expect(publish).toHaveBeenCalledWith({
      type: 'schedule.updated',
      body: { id, patch: { chatId: 'oc_two', chatIds: null } },
    });
  });

  it('rejects multiple chats for a retained topic without mutating or publishing', async () => {
    const { updateTask } = await import('../src/core/scheduler.js');
    const id = seed('origin', {
      scope: 'thread',
      executionPosition: 'topic',
      rootMessageId: 'om_old',
    });

    expect(updateTask(id, { chatIds: ['oc_one', 'oc_two'] })).toEqual({
      ok: false,
      error: 'multiple_chats_topic_unsupported',
    });
    expect(store.get(id)).toMatchObject({ chatId: 'oc_x', rootMessageId: 'om_old' });
    expect(store.get(id)?.chatIds).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it('requires a newly supplied topic root when its primary chat changes', async () => {
    const { updateTask } = await import('../src/core/scheduler.js');
    const id = seed('origin', {
      scope: 'thread',
      executionPosition: 'topic',
      rootMessageId: 'om_old',
    });

    expect(updateTask(id, { chatIds: ['oc_new'] })).toEqual({
      ok: false,
      error: 'topic_root_required',
    });
    expect(updateTask(id, { chatIds: ['oc_new'], rootMessageId: 'om_new' })).toEqual({ ok: true });
    expect(store.get(id)).toMatchObject({ chatId: 'oc_new', rootMessageId: 'om_new' });
  });
});
