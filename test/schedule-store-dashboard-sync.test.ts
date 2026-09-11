import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DashboardEvent } from '../src/core/dashboard-events.js';

let tempDir: string;
const watcher = vi.hoisted(() => ({ callback: undefined as undefined | ((event: string, filename: string | null) => void) }));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  watch: vi.fn((_path, _options, callback) => { watcher.callback = callback; }),
}));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return join(tempDir, 'data'); } } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const app = 'cli_schedule_sync_test';
const params = {
  id: 'task', name: 'Daily report', schedule: '0 12 * * *',
  parsed: { kind: 'cron' as const, expr: '0 12 * * *', display: 'daily' },
  prompt: 'Report public news', workingDir: '/workspace', chatId: 'oc_test', larkAppId: app,
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'schedule-dashboard-sync-'));
  watcher.callback = undefined;
  vi.resetModules();
});
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

async function setup() {
  const store = await import('../src/services/schedule-store.js');
  const { dashboardEventBus } = await import('../src/core/dashboard-events.js');
  const { Aggregator } = await import('../src/dashboard/aggregator.js');
  store.setScheduleScope(app);
  store.createTask(params);
  const agg = new Aggregator();
  agg.hydrateSchedules(app, store.listTasks());
  store.startExternalWriteWatcher();
  const events: DashboardEvent[] = [];
  dashboardEventBus.subscribe(event => {
    events.push(event);
    // Use the actual wire representation: undefined fields disappear in SSE.
    agg.applyEvent(app, JSON.parse(JSON.stringify(event)));
  });
  const flush = () => watcher.callback!('rename', 'schedules.json');
  const replace = (rows: unknown) => {
    const file = store.scheduleFilePathFor(app);
    writeFileSync(file + '.test', JSON.stringify(rows));
    renameSync(file + '.test', file);
  };
  return { store, agg, events, flush, replace };
}

describe('schedule store → dashboard notifications', () => {
  it('publishes an in-process deletion even after the store cache advances', async () => {
    const { store, agg, events, flush } = await setup();
    store.removeTask('task');
    expect(store.listTasks()).toEqual([]);
    flush();
    expect(agg.getSchedules()).toEqual([]);
    expect(events.map(e => e.type)).toEqual(['schedule.deleted']);
  });

  it('publishes create, pause, resume and dispatch status from in-process writes', async () => {
    const { store, agg, flush } = await setup();
    store.createTask({ ...params, id: 'second' });
    flush();
    expect(agg.getSchedules()).toHaveLength(2);
    store.updateTask('task', { enabled: false });
    flush();
    expect(agg.getSchedules().find(t => t.id === 'task')?.enabled).toBe(false);
    store.updateTask('task', { enabled: true, nextRunAt: '2030-01-01T04:00:00.000Z' });
    store.markRun('task', true);
    flush();
    expect(agg.getSchedules().find(t => t.id === 'task')).toMatchObject({
      enabled: true, nextRunAt: '2030-01-01T04:00:00.000Z', lastStatus: 'ok', lastRunAt: expect.any(String),
    });
  });

  it('does not lose an external deletion when a read refreshes the cache first', async () => {
    const { store, agg, events, flush, replace } = await setup();
    replace({});
    expect(store.listTasks()).toEqual([]);
    flush();
    expect(agg.getSchedules()).toEqual([]);
    expect(events.map(e => e.type)).toEqual(['schedule.deleted']);
  });

  it('publishes external changes without a prior read and ignores repeated watcher callbacks', async () => {
    const { agg, events, flush, replace } = await setup();
    replace({});
    flush();
    flush();
    expect(agg.getSchedules()).toEqual([]);
    expect(events.map(e => e.type)).toEqual(['schedule.deleted']);
  });

  it('clears removed fields across JSON transport and keeps precondition references private', async () => {
    const { store, agg, events, flush } = await setup();
    store.updateTask('task', { lastError: 'previous failure', preconditionRef: 'private-reference' });
    flush();
    expect(agg.getSchedules()[0]).toMatchObject({ lastError: 'previous failure', hasPrecondition: true });
    store.updateTask('task', { lastError: undefined, preconditionRef: undefined });
    flush();
    expect(agg.getSchedules()[0]).toMatchObject({ lastError: null, hasPrecondition: false });
    expect(JSON.stringify(events)).not.toContain('private-reference');
    expect(JSON.stringify(events)).not.toContain('preconditionRef');
  });

  it('publishes only the final state of a synchronous rollback', async () => {
    const { store, agg, events, flush } = await setup();
    store.updateTask('task', { chatId: 'oc_temporary' });
    store.updateTask('task', { chatId: params.chatId });
    flush();
    expect(events).toEqual([]);
    expect(agg.getSchedules()[0].chatId).toBe(params.chatId);
  });

  it('notifies automatic removal after the last scheduled repetition', async () => {
    const { store, agg, flush } = await setup();
    store.updateTask('task', { repeat: { times: 1, completed: 0 } });
    flush();
    store.markRun('task', true);
    flush();
    expect(agg.getSchedules()).toEqual([]);
  });

  it('preserves enriched rows already announced by the dashboard create endpoint', async () => {
    const { store, agg, events, flush } = await setup();
    const { dashboardEventBus } = await import('../src/core/dashboard-events.js');
    const task = store.createTask({ ...params, id: 'dashboard-created' });
    dashboardEventBus.publish({
      type: 'schedule.created',
      body: { schedule: { ...task, botName: 'Reporter', preconditionSource: 'inline' } },
    });
    store.updateTask(task.id, { enabled: false });
    flush();
    expect(agg.getSchedules().find(t => t.id === task.id)).toMatchObject({
      botName: 'Reporter', preconditionSource: 'inline', enabled: false,
    });
    expect(events.filter(e => e.type === 'schedule.created')).toHaveLength(1);
  });

  it('does not publish sibling bot changes', async () => {
    const { store, agg, events, flush } = await setup();
    store.createTask({ ...params, id: 'sibling', larkAppId: 'cli_schedule_sync_other' });
    flush();
    expect(events).toEqual([]);
    expect(agg.getSchedules().map(t => t.id)).toEqual(['task']);
  });
});
