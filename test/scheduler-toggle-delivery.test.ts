/** Unit tests for the task-level topic → top-level → new-topic position cycle. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScheduledTask } from '../src/types.js';

const store = new Map<string, ScheduledTask>();
const publish = vi.fn();

vi.mock('../src/services/schedule-store.js', () => ({
  getTask: (id: string) => store.get(id),
  updateTask: (id: string, updates: Partial<ScheduledTask>) => {
    const t = store.get(id);
    if (t) Object.assign(t, updates);
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
  it('switches a topic task to group top-level while retaining its root', async () => {
    const { toggleDelivery } = await import('../src/core/scheduler.js');
    const id = seed('origin', { scope: 'thread', rootMessageId: 'om_root' });
    expect(toggleDelivery(id)).toEqual({
      ok: true,
      deliver: 'origin',
      executionPosition: 'top-level',
    });
    expect(store.get(id)).toMatchObject({ scope: 'chat', rootMessageId: 'om_root' });
    expect(publish).toHaveBeenCalledWith({
      type: 'schedule.updated',
      body: { id, patch: { scope: 'chat', executionPosition: 'top-level' } },
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

  it('switches a fresh-topic task back to its retained topic root', async () => {
    const { toggleDelivery } = await import('../src/core/scheduler.js');
    const id = seed('origin', { scope: 'chat', executionPosition: 'new-topic', rootMessageId: 'om_root' });
    expect(toggleDelivery(id)).toEqual({ ok: true, deliver: 'origin', executionPosition: 'topic' });
    expect(store.get(id)).toMatchObject({ scope: 'thread', executionPosition: 'topic', rootMessageId: 'om_root' });
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
