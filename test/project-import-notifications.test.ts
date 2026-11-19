import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProjectImportNotifications,
  type ProjectImportCoordinator,
  type ProjectImportEvent,
  type ProjectImportNotification,
  type ProjectImportNotificationDeps,
  type ProjectImportPolicy,
  type ProjectImportSnapshot,
} from '../src/services/project-import-notifications.js';

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-project-import-test-'));
  roots.push(dataDir);
  let time = 1_800_000_000_000;
  const source: ProjectImportSnapshot = {
    sessionId: 'source_one', larkAppId: 'cli_worker', chatId: 'oc_project',
    rootMessageId: 'om_source', chatType: 'group', scope: 'thread', status: 'active',
    routeRevision: 1, ordinary: true, source: 'relay',
  };
  let policy: ProjectImportPolicy = {
    mode: 'project', importedSessionPolicy: 'notify', projectExists: true,
    projectGeneration: 'project-v1', coordinatorAppId: 'cli_main', workerAppIds: ['cli_worker'],
  };
  let current: ProjectImportSnapshot | undefined = { ...source };
  let coordinators: ProjectImportCoordinator[] = [{
    sessionId: 'main_one', larkAppId: 'cli_main', chatId: 'oc_project', scope: 'chat', status: 'active',
  }];
  const deliver = vi.fn<ProjectImportNotificationDeps['deliver']>(async (_notification, input) => {
    await input.beforeDeliver();
    return 'delivered';
  });
  const deps: ProjectImportNotificationDeps = {
    dataDir, getPolicy: () => policy, getCurrent: async () => current,
    getCoordinator: async () => coordinators, deliver, now: () => time,
    leaseMs: 10_000,
  };
  const runtime = createProjectImportNotifications(deps);
  const event: ProjectImportEvent = { operationId: 'operation-1', snapshot: source };
  return {
    dataDir, source, deps, runtime, event, deliver,
    setPolicy: (value: ProjectImportPolicy) => { policy = value; },
    policy: () => policy,
    setCurrent: (value: ProjectImportSnapshot | undefined) => { current = value; },
    current: () => current,
    setCoordinators: (value: ProjectImportCoordinator[]) => { coordinators = value; },
    coordinators: () => coordinators,
    tick: (milliseconds = 10_000) => { time += milliseconds; },
  };
}

describe('project import notifications', () => {
  it('does nothing on the missing/default-off policy, including no storage creation', async () => {
    const f = fixture();
    f.setPolicy({ ...f.policy(), importedSessionPolicy: undefined });
    expect(f.runtime.enqueue(f.event)).toEqual({ queued: false, reason: 'notifications_disabled' });
    expect(f.runtime.list()).toEqual([]);
    expect(readdirSync(f.dataDir)).toEqual([]);
    expect(await f.runtime.flush()).toEqual({ delivered: 0, pending: 0, cancelled: 0 });
  });

  it.each([
    { mode: 'standard' as const },
    { projectExists: false },
    { coordinatorAppId: undefined },
    { coordinatorAppId: 'cli_worker' },
    { workerAppIds: ['cli_other'] },
  ])('rejects ineligible project policy %j', patch => {
    const f = fixture();
    f.setPolicy({ ...f.policy(), ...patch });
    expect(f.runtime.enqueue(f.event).queued).toBe(false);
    expect(readdirSync(f.dataDir)).toEqual([]);
  });

  it.each([
    { chatType: 'p2p' as const },
    { scope: 'chat' as const },
    { status: 'closed' },
    { ordinary: false },
  ])('does not register unrelated/transient sources %j', patch => {
    const f = fixture();
    expect(f.runtime.enqueue({ ...f.event, snapshot: { ...f.source, ...patch } }).queued).toBe(false);
  });

  it('stores metadata only, dropping raw context, titles, cwd and identities', async () => {
    const f = fixture();
    f.runtime.enqueue({
      ...f.event,
      snapshot: { ...f.source, title: 'PRIVATE TITLE', cwd: '/private/cwd',
        transcript: 'PRIVATE TRANSCRIPT', ownerOpenId: 'PRIVATE OWNER' } as ProjectImportSnapshot,
    });
    const directory = join(f.dataDir, '.dashboard-secret.project-imports');
    const filename = readdirSync(directory).find(name => name.endsWith('.json'))!;
    const body = readFileSync(join(directory, filename), 'utf8');
    expect(body).not.toContain('PRIVATE');
    expect(body).not.toContain('cwd');
    expect(f.runtime.list()[0]?.snapshot).toEqual(f.source);
    expect(lstatSync(join(directory, filename)).mode & 0o777).toBe(0o600);
    await f.runtime.flush();
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.runtime.list()[0]?.state).toBe('delivered');
  });

  it('deduplicates the same operation after delivery and preserves its audit record', async () => {
    const f = fixture();
    const first = f.runtime.enqueue(f.event);
    expect(f.runtime.enqueue(f.event)).toMatchObject({ id: first.id, reason: 'duplicate' });
    await f.runtime.flush();
    expect(f.runtime.enqueue(f.event)).toMatchObject({ id: first.id, queued: false });
    expect(f.runtime.list()).toHaveLength(1);
    expect(await f.runtime.flush()).toEqual({ delivered: 0, pending: 0, cancelled: 0 });
    expect(f.deliver).toHaveBeenCalledOnce();
  });

  it('refuses reuse of one operation id for a different route incarnation', () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    expect(() => f.runtime.enqueue({
      ...f.event, snapshot: { ...f.source, routeRevision: 2 },
    })).toThrow('project_import_operation_conflict');
  });

  it('cancels the stale event after A→B→A and delivers the real second import', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    const second = { ...f.source, routeRevision: 3 };
    f.setCurrent(second);
    f.runtime.enqueue({ operationId: 'operation-3', snapshot: second });
    const result = await f.runtime.flush();
    expect(result).toEqual({ delivered: 1, cancelled: 1, pending: 0 });
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.deliver.mock.calls[0]![0].snapshot.routeRevision).toBe(3);
  });

  it.each([
    { rootMessageId: 'om_moved' },
    { chatId: 'oc_moved' },
    { status: 'closed' },
    { ordinary: false },
  ])('cancels a definitively moved/closed source %j', async patch => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    f.setCurrent({ ...f.source, ...patch });
    expect(await f.runtime.flush()).toMatchObject({ cancelled: 1 });
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it('keeps an offline source pending and safely resumes after restart', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    f.setCurrent(undefined);
    expect(await f.runtime.flush()).toMatchObject({ pending: 1 });
    f.tick();
    f.setCurrent(f.source);
    const restarted = createProjectImportNotifications(f.deps);
    expect(await restarted.flush()).toMatchObject({ delivered: 1 });
    expect(f.deliver).toHaveBeenCalledOnce();
  });

  it('retries when coordinator absent; does not choose a new one from an ambiguous roster', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    f.setCoordinators([]);
    expect(await f.runtime.flush()).toMatchObject({ pending: 1 });
    f.tick();
    f.setCoordinators([
      { sessionId: 'main_two', larkAppId: 'cli_main', chatId: 'oc_project', scope: 'chat', status: 'active' },
      { sessionId: 'main_three', larkAppId: 'cli_main', chatId: 'oc_project', scope: 'chat', status: 'active' },
    ]);
    expect(await f.runtime.flush()).toMatchObject({ pending: 1 });
    f.tick();
    f.setCoordinators([f.coordinators()[0]!]);
    expect(await f.runtime.flush()).toMatchObject({ delivered: 1 });
    expect(f.deliver.mock.calls[0]![1].target.sessionId).toBe('main_two');
  });

  it('filters foreign, closed, and thread-scope coordinator sessions', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    f.setCoordinators([
      { sessionId: 'closed_main', larkAppId: 'cli_main', chatId: 'oc_project', scope: 'chat', status: 'closed' },
      { sessionId: 'thread_main', larkAppId: 'cli_main', chatId: 'oc_project', scope: 'thread', status: 'active' },
      { sessionId: 'foreign_main', larkAppId: 'cli_main', chatId: 'oc_foreign', scope: 'chat', status: 'active' },
    ]);
    expect(await f.runtime.flush()).toMatchObject({ pending: 1 });
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it.each([
    { importedSessionPolicy: 'ignore' as const },
    { mode: 'standard' as const },
    { projectGeneration: 'project-recreated' },
    { coordinatorAppId: 'cli_replacement' },
  ])('cancels pending events after policy/incarnation changes %j', async patch => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    f.setPolicy({ ...f.policy(), ...patch });
    expect(await f.runtime.flush()).toMatchObject({ cancelled: 1 });
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it('rechecks policy after an awaited source lookup', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    f.deps.getCurrent = async () => {
      f.setPolicy({ ...f.policy(), importedSessionPolicy: 'ignore' });
      return f.source;
    };
    expect(await f.runtime.flush()).toMatchObject({ cancelled: 1 });
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it('rechecks source at the transport dispatch boundary', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    let sent = false;
    f.deliver.mockImplementation(async (_notification, input) => {
      f.setCurrent({ ...f.source, rootMessageId: 'om_moved' });
      await input.beforeDeliver();
      sent = true;
      return 'delivered';
    });
    expect(await f.runtime.flush()).toMatchObject({ cancelled: 1 });
    expect(sent).toBe(false);
  });

  it('does not use a source association changed during awaited coordinator lookup', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    let lookups = 0;
    f.deps.getCoordinator = async () => {
      if (++lookups === 2) f.setCurrent({ ...f.source, routeRevision: 2 });
      return f.coordinators();
    };
    expect(await f.runtime.flush()).toMatchObject({ cancelled: 1 });
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it('retries an unknown/lost response with the same target and exact idempotency key', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    f.deliver.mockResolvedValueOnce('unknown');
    expect(await f.runtime.flush()).toMatchObject({ pending: 1 });
    const key = f.deliver.mock.calls[0]![1].idempotencyKey;
    f.tick();
    const restarted = createProjectImportNotifications(f.deps);
    expect(await restarted.flush()).toMatchObject({ delivered: 1 });
    expect(f.deliver.mock.calls[1]![1].idempotencyKey).toBe(key);
    expect(f.deliver.mock.calls[1]![1].target).toEqual(f.deliver.mock.calls[0]![1].target);
  });

  it('does not blindly retarget an outcome-unknown delivery after the main session changes', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    f.deliver.mockResolvedValueOnce('unknown');
    await f.runtime.flush();
    f.setCoordinators([{ ...f.coordinators()[0]!, sessionId: 'main_two' }]);
    f.tick();
    expect(await f.runtime.flush()).toMatchObject({ pending: 1 });
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.runtime.list()[0]?.delivery?.target.sessionId).toBe('main_one');
  });

  it('does not discard an old uncertain delivery after a retry reports a new pre-delivery failure', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    f.deliver.mockResolvedValueOnce('unknown').mockResolvedValueOnce('retry');
    await f.runtime.flush();
    f.tick();
    await f.runtime.flush();
    expect(f.runtime.list()[0]?.delivery?.target.sessionId).toBe('main_one');
    f.setCoordinators([{ ...f.coordinators()[0]!, sessionId: 'main_two' }]);
    f.tick();
    expect(await f.runtime.flush()).toMatchObject({ pending: 1 });
    expect(f.deliver).toHaveBeenCalledTimes(2);
  });

  it('marks a reconciled old delivery done without sending to a successor', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    f.deliver.mockResolvedValueOnce('unknown');
    await f.runtime.flush();
    f.setCoordinators([{ ...f.coordinators()[0]!, sessionId: 'main_two' }]);
    f.deps.reconcileDelivery = async () => 'delivered';
    f.tick();
    expect(await f.runtime.flush()).toMatchObject({ delivered: 1 });
    expect(f.deliver).toHaveBeenCalledOnce();
  });

  it('retargets only after definitive non-delivery and uses a successor-specific key', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    f.deliver.mockResolvedValueOnce('unknown');
    await f.runtime.flush();
    const key = f.deliver.mock.calls[0]![1].idempotencyKey;
    f.setCoordinators([{ ...f.coordinators()[0]!, sessionId: 'main_two' }]);
    f.deps.reconcileDelivery = async () => 'not_delivered';
    f.tick();
    expect(await f.runtime.flush()).toMatchObject({ delivered: 1 });
    expect(f.deliver.mock.calls[1]![1].target.sessionId).toBe('main_two');
    expect(f.deliver.mock.calls[1]![1].idempotencyKey).not.toBe(key);
  });

  it('releases target binding after a definitive pre-delivery failure', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    f.deliver.mockResolvedValueOnce('retry');
    await f.runtime.flush();
    expect(f.runtime.list()[0]?.delivery).toBeUndefined();
    f.setCoordinators([{ ...f.coordinators()[0]!, sessionId: 'main_two' }]);
    f.tick();
    expect(await f.runtime.flush()).toMatchObject({ delivered: 1 });
  });

  it('serializes flushes and leases delivery across two runtime instances', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    f.deliver.mockImplementation(async (_notification, input) => {
      await input.beforeDeliver();
      await paused;
      return 'delivered';
    });
    const first = f.runtime.flush();
    const same = f.runtime.flush();
    const other = createProjectImportNotifications(f.deps);
    const contender = other.flush();
    expect(same).toBe(first);
    await contender;
    release();
    expect(await first).toMatchObject({ delivered: 1 });
    expect(f.deliver).toHaveBeenCalledOnce();
  });

  it('handles lease expiry without repeating the target-specific delivery identity', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const acceptedKeys = new Set<string>();
    let accepted = 0;
    f.deliver.mockImplementation(async (_notification, input) => {
      await input.beforeDeliver();
      if (!acceptedKeys.has(input.idempotencyKey)) { acceptedKeys.add(input.idempotencyKey); accepted++; }
      if (f.deliver.mock.calls.length === 1) await paused;
      return 'delivered';
    });
    const first = f.runtime.flush();
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
    f.tick(20_000);
    const recovered = createProjectImportNotifications(f.deps);
    expect(await recovered.flush()).toMatchObject({ delivered: 1 });
    release();
    await first;
    expect(accepted).toBe(1);
    expect(f.runtime.list()[0]?.state).toBe('delivered');
  });

  it('bounds each batch and avoids starving newer events behind offline sources', async () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    f.setCurrent(undefined);
    await f.runtime.flush({ limit: 1 });
    const newer = { ...f.source, sessionId: 'source_two', rootMessageId: 'om_second' };
    f.runtime.enqueue({ operationId: 'operation-2', snapshot: newer });
    f.deps.getCurrent = async (_app, sessionId) => sessionId === 'source_two' ? newer : undefined;
    expect(await f.runtime.flush({ limit: 1 })).toMatchObject({ delivered: 1 });
    expect(f.runtime.list().filter(r => r.state === 'pending')).toHaveLength(1);
  });

  it('refuses a symlinked authority directory and does not touch its target', () => {
    const f = fixture();
    const target = mkdtempSync(join(tmpdir(), 'botmux-import-symlink-target-'));
    roots.push(target);
    symlinkSync(target, join(f.dataDir, '.dashboard-secret.project-imports'));
    expect(() => f.runtime.enqueue(f.event)).toThrow('unsafe_project_import_directory');
    expect(readdirSync(target)).toEqual([]);
  });

  it('refuses a symlinked event leaf', () => {
    const f = fixture();
    const queued = f.runtime.enqueue(f.event);
    const filename = join(f.dataDir, '.dashboard-secret.project-imports', `${queued.id}.json`);
    const external = join(f.dataDir, 'external.txt');
    writeFileSync(external, 'untouched');
    rmSync(filename);
    symlinkSync(external, filename);
    expect(() => f.runtime.list()).toThrow();
    expect(readFileSync(external, 'utf8')).toBe('untouched');
  });

  it('fails closed on corrupted event authority rather than delivering or rewriting it', () => {
    const f = fixture();
    const queued = f.runtime.enqueue(f.event);
    const filename = join(f.dataDir, '.dashboard-secret.project-imports', `${queued.id}.json`);
    const entry = f.runtime.list()[0]!;
    writeFileSync(filename, JSON.stringify({ ...entry, id: 'wrong-id' }), { mode: 0o600 });
    expect(() => f.runtime.list()).toThrow('invalid_project_import_record');
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it('drops generic transport error details instead of persisting/logging raw context', async () => {
    const f = fixture();
    const log = vi.fn();
    f.deps.log = log;
    f.runtime.enqueue(f.event);
    f.deliver.mockRejectedValueOnce(new Error('PRIVATE RAW REQUEST'));
    await f.runtime.flush();
    expect(f.runtime.list()[0]?.reason).toBe('delivery_outcome_unknown');
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
  });

  it('supports each approved import source without interpreting it as a new business task', () => {
    const f = fixture();
    for (const source of ['relay', 'bind', 'adopt', 'resume_import', 'fork'] as const) {
      expect(f.runtime.enqueue({
        operationId: `event-${source}`, snapshot: { ...f.source, source },
      }).queued).toBe(true);
    }
    expect(f.runtime.list()).toHaveLength(5);
    expect(f.runtime.list().every(r => r.state === 'pending')).toBe(true);
  });

  it('does not leak a released secure store capability through notification values', () => {
    const f = fixture();
    f.runtime.enqueue(f.event);
    const returned = f.runtime.list()[0] as ProjectImportNotification & { path?: string };
    expect(returned.path).toBeUndefined();
    returned.snapshot.rootMessageId = 'om_changed_by_caller';
    expect(f.runtime.list()[0]?.snapshot.rootMessageId).toBe('om_source');
  });
});
