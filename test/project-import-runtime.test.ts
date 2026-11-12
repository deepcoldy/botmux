import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProjectImportRuntime,
  installProjectImportRuntime,
  projectImportRegistrationOutcome,
  PROJECT_IMPORT_COORDINATORS_ROUTE,
  PROJECT_IMPORT_DELIVER_ROUTE,
  type ProjectImportRecoverableSession,
  type ProjectImportRuntimeDeps,
  type ProjectImportRuntimeSource,
} from '../src/services/project-import-runtime.js';
import { projectImportSnapshotFromSource } from '../src/services/project-import-snapshot.js';
import {
  projectImportOperationId,
  type ProjectImportCoordinator,
} from '../src/services/project-import-notifications.js';
import type { GroupCollaborationModeConfig } from '../src/services/group-collaboration-mode-store.js';
import type { ProjectGroupState } from '../src/services/project-group-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-project-import-runtime-'));
  roots.push(dataDir);
  let clock = 1_800_000_000_000;
  let mode: GroupCollaborationModeConfig | undefined = {
    schemaVersion: 1, chatId: 'oc_project', mode: 'project', coordinatorAppId: 'cli_main',
    workerAppIds: ['cli_worker'], importedSessionPolicy: 'notify',
    createdAt: 'mode-v1', updatedAt: 'mode-v1',
  };
  let project: ProjectGroupState | undefined = {
    schemaVersion: 1, revision: 1, chatId: 'oc_project', larkAppId: 'cli_main',
    coordinatorSessionId: 'main_one', title: 'project', goal: 'goal',
    phase: 'phase', focus: 'focus', status: 'active', blockers: [],
    workstreams: [], milestones: [], createdAt: 'project-v1', updatedAt: 'project-v1',
  };
  let source: ProjectImportRuntimeSource | undefined = {
    sessionId: 'source_one', larkAppId: 'cli_worker', chatId: 'oc_project',
    rootMessageId: 'om_source', scope: 'thread', status: 'active',
    routeRevision: 1, source: 'relay', ordinary: true,
    reportCapability: 'verified', chatType: 'group', ownerKey: 'union:owner',
    title: 'must-not-transmit-this-title',
  };
  let sessions: ProjectImportRecoverableSession[] = [{
    sessionId: 'source_one', larkAppId: 'cli_worker', chatId: 'oc_project',
    rootMessageId: 'om_source', scope: 'thread', status: 'active', chatType: 'group',
    projectRouteRevision: 1, projectImportSource: 'relay', projectImportPending: true,
  }];
  let coordinator: ProjectImportCoordinator | undefined = {
    sessionId: 'main_one', larkAppId: 'cli_main', chatId: 'oc_project', scope: 'chat', status: 'active',
  };
  const fetchIpc = vi.fn<ProjectImportRuntimeDeps['fetchIpc']>(async (_port, path) => {
    if (path === PROJECT_IMPORT_COORDINATORS_ROUTE) return jsonResponse({ ok: true, coordinators: [coordinator] });
    if (path === PROJECT_IMPORT_DELIVER_ROUTE) return jsonResponse({ ok: true, delivered: true });
    if (path.includes('/trigger-registration')) return jsonResponse({
      ok: true, schemaVersion: 1, larkAppId: coordinator?.larkAppId, sessionId: coordinator?.sessionId,
      state: 'registered', inputCommitted: { state: 'observed' },
    });
    return jsonResponse({ ok: true, state: 'unknown' });
  });
  const getSource = vi.fn(async () => source);
  const markEnqueued = vi.fn();
  const deps: ProjectImportRuntimeDeps = {
    dataDir, getMode: () => mode, getProject: () => project,
    getSource, listRecoverableSessions: () => sessions,
    localCoordinator: () => coordinator,
    findDaemon: () => ({ ipcPort: 12345 }),
    fetchIpc, markEnqueued, now: () => clock,
  };
  const runtime = createProjectImportRuntime(deps);
  return {
    dataDir, deps, runtime, fetchIpc, getSource, markEnqueued,
    mode: () => mode!, project: () => project!, source: () => source!, sessions: () => sessions,
    coordinator: () => coordinator!,
    setMode: (value: GroupCollaborationModeConfig | undefined) => { mode = value; },
    setProject: (value: ProjectGroupState | undefined) => { project = value; },
    setSource: (value: ProjectImportRuntimeSource | undefined) => { source = value; },
    setSessions: (value: ProjectImportRecoverableSession[]) => { sessions = value; },
    setCoordinator: (value: ProjectImportCoordinator | undefined) => { coordinator = value; },
    tick: (ms = 10_000) => { clock += ms; },
  };
}

describe('project import runtime wiring', () => {
  it('installs with composition-root pool callbacks without starting a timer or scanning at import', async () => {
    const listActiveSessions = vi.fn(() => []);
    const findActiveBySessionId = vi.fn(() => undefined);
    const installed = installProjectImportRuntime({ listActiveSessions, findActiveBySessionId });
    expect(listActiveSessions).not.toHaveBeenCalled();
    expect(findActiveBySessionId).not.toHaveBeenCalled();
    expect(await installed.tick()).toEqual({ recovered: 0, delivered: 0, pending: 0, cancelled: 0 });
    expect(listActiveSessions).toHaveBeenCalledOnce();
    expect(findActiveBySessionId).not.toHaveBeenCalled();
  });

  it('the default-off gate avoids source lookups, peer/network work and outbox creation', async () => {
    const f = fixture();
    f.setMode({ ...f.mode(), importedSessionPolicy: undefined });
    expect(await f.runtime.tick()).toEqual({ recovered: 0, delivered: 0, pending: 0, cancelled: 0 });
    expect(f.getSource).not.toHaveBeenCalled();
    expect(f.fetchIpc).not.toHaveBeenCalled();
    expect(f.markEnqueued).toHaveBeenCalledWith(f.sessions()[0], 'skipped');
    expect(readdirSync(f.dataDir)).toEqual([]);
  });

  it.each(['standard', 'no-project', 'not-worker', 'different-main'])(
    'does not recover or notify an ineligible project: %s', async kind => {
      const f = fixture();
      if (kind === 'standard') f.setMode({ ...f.mode(), mode: 'standard' });
      if (kind === 'no-project') f.setProject(undefined);
      if (kind === 'not-worker') f.setMode({ ...f.mode(), workerAppIds: [] });
      if (kind === 'different-main') f.setProject({ ...f.project(), larkAppId: 'cli_other' });
      await f.runtime.tick();
      expect(f.getSource).not.toHaveBeenCalled();
      expect(f.fetchIpc).not.toHaveBeenCalled();
      expect(f.markEnqueued).toHaveBeenCalledWith(f.sessions()[0], 'skipped');
    },
  );

  it('does not rediscover arbitrary historical imports without a pending marker', async () => {
    const f = fixture();
    f.setSessions([{ ...f.sessions()[0]!, projectImportPending: undefined }]);
    await f.runtime.tick();
    expect(f.getSource).not.toHaveBeenCalled();
    expect(f.fetchIpc).not.toHaveBeenCalled();
    expect(f.markEnqueued).not.toHaveBeenCalled();
  });

  it('recovers a committed import once, clears only that marker and sends metadata only', async () => {
    const f = fixture();
    expect(await f.runtime.tick()).toMatchObject({ recovered: 1, delivered: 1 });
    expect(f.markEnqueued).toHaveBeenCalledWith(f.sessions()[0], 'queued');
    const request = f.fetchIpc.mock.calls.find(call => call[1] === PROJECT_IMPORT_DELIVER_ROUTE)!;
    const body = JSON.parse(String(request[2]?.body));
    expect(body.notification.snapshot).not.toHaveProperty('title');
    expect(body.notification.snapshot).not.toHaveProperty('ownerKey');
    expect(JSON.stringify(body)).not.toContain('must-not-transmit');
    expect(body.target.sessionId).toBe('main_one');
    expect(await f.runtime.tick()).toMatchObject({ recovered: 0, delivered: 0 });
    expect(f.fetchIpc.mock.calls.filter(call => call[1] === PROJECT_IMPORT_DELIVER_ROUTE)).toHaveLength(1);
  });

  it('hot recorder and recovery use one stable operation identity per revision', async () => {
    const f = fixture();
    const snapshot = projectImportSnapshotFromSource(f.source())!;
    f.runtime.notifications.enqueue({ operationId: projectImportOperationId(snapshot), snapshot });
    expect(await f.runtime.tick()).toMatchObject({ recovered: 0, delivered: 1 });
    expect(f.runtime.notifications.list()).toHaveLength(1);
    expect(projectImportOperationId({ ...snapshot, routeRevision: 2 })).not.toBe(projectImportOperationId(snapshot));
  });

  it('keeps the recovery marker when source daemon is unavailable or route changed', async () => {
    const f = fixture();
    f.setSource(undefined);
    await f.runtime.tick();
    expect(f.markEnqueued).not.toHaveBeenCalled();
    f.setSource({ ...f.source(), sessionId: 'source_one', routeRevision: 2 });
    await f.runtime.tick();
    expect(f.markEnqueued).not.toHaveBeenCalled();
  });

  it('does not notify workflow/transient sessions or legacy peers without chatType proof', async () => {
    const f = fixture();
    f.setSource({ ...f.source(), ordinary: false });
    await f.runtime.tick();
    expect(f.fetchIpc).not.toHaveBeenCalled();
    expect(f.markEnqueued).toHaveBeenCalledWith(f.sessions()[0], 'skipped');
    f.markEnqueued.mockClear();
    f.setSource({ ...f.source(), ordinary: true, chatType: undefined });
    await f.runtime.tick();
    expect(f.fetchIpc).not.toHaveBeenCalled();
    expect(f.markEnqueued).not.toHaveBeenCalled();
  });

  it('remote coordinator lookup is exact session/app/chat and ignores wrong peers', async () => {
    const f = fixture();
    f.deps.localCoordinator = () => undefined;
    f.fetchIpc.mockImplementation(async (_port, path, init) => {
      if (path === PROJECT_IMPORT_COORDINATORS_ROUTE) {
        expect(JSON.parse(String(init?.body))).toEqual({
          chatId: 'oc_project', coordinatorLarkAppId: 'cli_main', coordinatorSessionId: 'main_one',
        });
        return jsonResponse({ ok: true, coordinators: [
          { ...f.coordinator(), sessionId: 'wrong-main' },
          { ...f.coordinator(), chatId: 'oc_elsewhere' },
          { ...f.coordinator(), larkAppId: 'cli_other' },
        ] });
      }
      throw new Error('must not send');
    });
    expect(await f.runtime.tick()).toMatchObject({ recovered: 1, pending: 1 });
    expect(f.fetchIpc.mock.calls.every(call => call[1] === PROJECT_IMPORT_COORDINATORS_ROUTE)).toBe(true);
  });

  it('delivers through an exact remote coordinator when local daemon does not own it', async () => {
    const f = fixture();
    f.deps.localCoordinator = () => undefined;
    expect(await f.runtime.tick()).toMatchObject({ delivered: 1 });
    expect(f.fetchIpc.mock.calls.some(call => call[1] === PROJECT_IMPORT_COORDINATORS_ROUTE)).toBe(true);
  });

  it('does not auto-start a missing coordinator; a later tick retries the same source', async () => {
    const f = fixture();
    f.setCoordinator(undefined);
    f.deps.findDaemon = () => undefined;
    expect(await f.runtime.tick()).toMatchObject({ pending: 1 });
    expect(f.fetchIpc).not.toHaveBeenCalled();
    f.tick();
    f.setCoordinator({ sessionId: 'main_one', larkAppId: 'cli_main', chatId: 'oc_project', scope: 'chat', status: 'active' });
    f.deps.findDaemon = () => ({ ipcPort: 12345 });
    expect(await f.runtime.tick()).toMatchObject({ delivered: 1, recovered: 0 });
  });

  it('uses durable input-commit evidence to recover an unknown HTTP outcome', async () => {
    const f = fixture();
    f.fetchIpc.mockImplementation(async (_port, path) => {
      if (path === PROJECT_IMPORT_DELIVER_ROUTE) return jsonResponse({ ok: false, error: 'trigger_failed' }, 500);
      return jsonResponse({
        ok: true, schemaVersion: 1, larkAppId: 'cli_main', sessionId: 'main_one', state: 'registered',
        inputCommitted: { state: 'observed' },
      });
    });
    expect(await f.runtime.tick()).toMatchObject({ delivered: 1 });
    const lookup = f.fetchIpc.mock.calls.find(call => call[1].includes('/trigger-registration'));
    expect(lookup?.[1]).toContain('turnIdempotencyKey=project-import%3A');
  });

  it('does not treat registered/accepted without input commit as delivered', async () => {
    const f = fixture();
    f.fetchIpc.mockImplementation(async (_port, path) => path === PROJECT_IMPORT_DELIVER_ROUTE
      ? jsonResponse({ ok: true, action: 'queued' })
      : jsonResponse({
        ok: true, schemaVersion: 1, larkAppId: 'cli_main', sessionId: 'main_one', state: 'registered',
        inputCommitted: { state: 'unknown' },
      }));
    expect(await f.runtime.tick()).toMatchObject({ pending: 1 });
    expect(f.runtime.notifications.list()[0]?.delivery?.target.sessionId).toBe('main_one');
  });

  it('does not complete an outbox from a successful delivered receipt without durable input proof', async () => {
    const f = fixture();
    f.fetchIpc.mockImplementation(async (_port, path) => path === PROJECT_IMPORT_DELIVER_ROUTE
      ? jsonResponse({ ok: true, delivered: true })
      : jsonResponse({
        ok: true, schemaVersion: 1, larkAppId: 'cli_main', sessionId: 'main_one',
        state: 'registered', inputCommitted: { state: 'unknown' },
      }));
    expect(await f.runtime.tick()).toMatchObject({ pending: 1, delivered: 0 });
    expect(f.runtime.notifications.list()[0]?.state).toBe('pending');
  });

  it('an untyped or post-commit failure remains unknown and keeps its target', async () => {
    const f = fixture();
    f.fetchIpc.mockImplementation(async (_port, path) => path === PROJECT_IMPORT_DELIVER_ROUTE
      ? jsonResponse({ ok: false, error: 'source_changed' }, 409)
      : jsonResponse({ ok: true, state: 'unknown' }));
    expect(await f.runtime.tick()).toMatchObject({ pending: 1 });
    expect(f.runtime.notifications.list()[0]?.delivery).toBeDefined();
  });

  it('a typed pre-dispatch failure allows a later coordinator retry', async () => {
    const f = fixture();
    f.fetchIpc.mockResolvedValueOnce(jsonResponse({
      ok: false, error: 'source_changed', preDispatch: true,
    }, 409));
    expect(await f.runtime.tick()).toMatchObject({ pending: 1 });
    expect(f.runtime.notifications.list()[0]?.delivery).toBeUndefined();
  });

  it('a failed transport does not lose a durable notification', async () => {
    const f = fixture();
    f.fetchIpc.mockRejectedValue(new Error('network failure'));
    expect(await f.runtime.tick()).toMatchObject({ pending: 1 });
    const entry = f.runtime.notifications.list()[0]!;
    expect(entry.state).toBe('pending');
    expect(entry.delivery?.target.sessionId).toBe('main_one');
    expect(f.markEnqueued).toHaveBeenCalledWith(f.sessions()[0], 'queued');
  });

  it('never retargets a stale unknown delivery solely because main session changed', async () => {
    const f = fixture();
    f.fetchIpc.mockImplementation(async (_port, path) => path === PROJECT_IMPORT_DELIVER_ROUTE
      ? jsonResponse({ ok: true, unknown: true }) : jsonResponse({ ok: true, state: 'unknown' }));
    await f.runtime.tick();
    f.tick();
    f.setProject({ ...f.project(), coordinatorSessionId: 'main_two' });
    f.setCoordinator({ ...f.coordinator(), sessionId: 'main_two' });
    await f.runtime.tick();
    const deliveries = f.fetchIpc.mock.calls.filter(call => call[1] === PROJECT_IMPORT_DELIVER_ROUTE);
    expect(deliveries).toHaveLength(1);
    expect(f.runtime.notifications.list()[0]?.delivery?.target.sessionId).toBe('main_one');
  });

  it('default disable cancels a previously queued notification before sending', async () => {
    const f = fixture();
    f.setCoordinator(undefined);
    await f.runtime.tick();
    f.tick();
    f.setMode({ ...f.mode(), importedSessionPolicy: 'ignore' });
    f.setCoordinator({ sessionId: 'main_one', larkAppId: 'cli_main', chatId: 'oc_project', scope: 'chat', status: 'active' });
    expect(await f.runtime.tick()).toMatchObject({ cancelled: 1 });
    expect(f.fetchIpc.mock.calls.filter(call => call[1] === PROJECT_IMPORT_DELIVER_ROUTE)).toHaveLength(0);
  });

  it('a recreated project cancels its old pending import', async () => {
    const f = fixture();
    f.setCoordinator(undefined);
    await f.runtime.tick();
    f.tick();
    f.setProject({ ...f.project(), createdAt: 'project-v2' });
    f.setSessions([]);
    expect(await f.runtime.tick()).toMatchObject({ cancelled: 1 });
  });

  it('a single tick has a finite recovery budget even with many pending imports', async () => {
    const f = fixture();
    f.setSessions(Array.from({ length: 75 }, (_, index) => ({
      ...f.sessions()[0]!, sessionId: `source_${index}`, rootMessageId: `om_source_${index}`,
    })));
    f.deps.getSource = async (_app, sessionId) => ({
      ...f.source(), sessionId, rootMessageId: `om_source_${sessionId.split('_')[1]}`,
    });
    const result = await f.runtime.tick();
    expect(result.recovered).toBe(50);
    expect(result.delivered).toBe(10);
    expect(f.markEnqueued).toHaveBeenCalledTimes(50);
  });

  it('rotates recovery batches so unavailable old markers cannot starve newer sessions', async () => {
    const f = fixture();
    const template = f.sessions()[0]!;
    f.setSessions(Array.from({ length: 60 }, (_, index) => ({
      ...template, sessionId: `source_${index}`, rootMessageId: `om_source_${index}`,
    })));
    f.deps.getSource = async (_app, sessionId) => sessionId === 'source_59'
      ? { ...f.source(), sessionId, rootMessageId: 'om_source_59' } : undefined;
    expect(await f.runtime.tick()).toMatchObject({ recovered: 0 });
    expect(await f.runtime.tick()).toMatchObject({ recovered: 1, delivered: 1 });
  });

  it('reentrant ticks return one promise without repeating lookups or delivery', async () => {
    const f = fixture();
    let release!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; });
    f.getSource.mockImplementationOnce(async () => { await pause; return f.source(); });
    const first = f.runtime.tick();
    const second = f.runtime.tick();
    expect(second).toBe(first);
    release();
    expect(await first).toMatchObject({ recovered: 1, delivered: 1 });
    expect(f.fetchIpc.mock.calls.filter(call => call[1] === PROJECT_IMPORT_DELIVER_ROUTE)).toHaveLength(1);
  });

  it('exposes only the current-source metadata snapshot to notifications', () => {
    const f = fixture();
    const snapshot = projectImportSnapshotFromSource(f.source())!;
    expect(snapshot).toEqual({
      sessionId: 'source_one', larkAppId: 'cli_worker', chatId: 'oc_project',
      rootMessageId: 'om_source', scope: 'thread', status: 'active', chatType: 'group',
      routeRevision: 1, ordinary: true, source: 'relay',
    });
    expect(projectImportSnapshotFromSource({ ...f.source(), source: 'manual' })).toBeUndefined();
  });

  it('registration evidence is exact app/session and does not infer commit from success', () => {
    const target = fixture().coordinator();
    const registered = {
      ok: true, schemaVersion: 1, larkAppId: target.larkAppId, sessionId: target.sessionId,
      state: 'registered', inputCommitted: { state: 'observed' },
    };
    expect(projectImportRegistrationOutcome(registered, target)).toBe('delivered');
    expect(projectImportRegistrationOutcome({ ...registered, sessionId: 'wrong' }, target)).toBe('unknown');
    expect(projectImportRegistrationOutcome({ ...registered, larkAppId: 'cli_wrong' }, target)).toBe('unknown');
    expect(projectImportRegistrationOutcome({ ...registered, inputCommitted: undefined }, target)).toBe('unknown');
    expect(projectImportRegistrationOutcome({ ok: true, delivered: true }, target)).toBe('unknown');
  });
});
