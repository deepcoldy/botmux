/**
 * Unit tests for scheduler.toggleDelivery() — the dashboard entry point that
 * flips a scheduled task between 'origin' (reply in original thread) and
 * 'new-topic' (open a brand-new topic + fresh session every fire).
 *
 * The schedule store and dashboard event bus are mocked so the test exercises
 * only the flip logic + persistence call + event emission.
 *
 * Run:  pnpm vitest run test/scheduler-toggle-delivery.test.ts
 */
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

function seed(deliver?: ScheduledTask['deliver']): string {
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
  });
  return id;
}

beforeEach(() => {
  store.clear();
  publish.mockClear();
});

describe('scheduler.toggleDelivery', () => {
  it('flips origin → new-topic', async () => {
    const { toggleDelivery } = await import('../src/core/scheduler.js');
    const id = seed('origin');
    const r = toggleDelivery(id);
    expect(r).toEqual({ ok: true, deliver: 'new-topic' });
    expect(store.get(id)!.deliver).toBe('new-topic');
  });

  it('flips new-topic → origin', async () => {
    const { toggleDelivery } = await import('../src/core/scheduler.js');
    const id = seed('new-topic');
    const r = toggleDelivery(id);
    expect(r).toEqual({ ok: true, deliver: 'origin' });
    expect(store.get(id)!.deliver).toBe('origin');
  });

  it('treats undefined deliver as origin → flips to new-topic', async () => {
    const { toggleDelivery } = await import('../src/core/scheduler.js');
    const id = seed(undefined);
    const r = toggleDelivery(id);
    expect(r.deliver).toBe('new-topic');
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

  it('publishes a schedule.updated event with the new deliver', async () => {
    const { toggleDelivery } = await import('../src/core/scheduler.js');
    const id = seed('origin');
    toggleDelivery(id);
    expect(publish).toHaveBeenCalledWith({
      type: 'schedule.updated',
      body: { id, patch: { deliver: 'new-topic' } },
    });
  });

  it('returns not_found for an unknown id without publishing', async () => {
    const { toggleDelivery } = await import('../src/core/scheduler.js');
    const r = toggleDelivery('missing');
    expect(r).toEqual({ ok: false, error: 'not_found' });
    expect(publish).not.toHaveBeenCalled();
  });
});
