import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDispatchReportBinding } from '../src/core/dispatch-report-binding.js';

const mocks = vi.hoisted(() => ({
  live: new Map<string, any>(),
  stored: new Map<string, any>(),
  union: vi.fn(),
  daemon: vi.fn(),
  ipc: vi.fn(),
  mode: vi.fn(),
  project: vi.fn(),
  record: vi.fn(),
  secret: vi.fn(),
  issueBinding: vi.fn(),
  factory: vi.fn(),
  instances: [] as any[],
  dataDir: '/synthetic-state',
  configAvailable: false,
  configReads: 0,
  serviceDeps: undefined as any,
}));
vi.mock('../src/config.js', () => ({ config: { session: {
  get dataDir() {
    mocks.configReads += 1;
    if (!mocks.configAvailable) throw new ReferenceError('synthetic fixture dataDir is not initialized');
    return mocks.dataDir;
  },
} } }));
vi.mock('../src/services/session-store.js', () => ({
  getOwnedSession: (id: string) => mocks.stored.get(id),
}));
vi.mock('../src/utils/daemon-discovery.js', () => ({ findOnlineDaemon: mocks.daemon }));
vi.mock('../src/core/daemon-ipc-auth.js', () => ({ fetchDaemonIpc: mocks.ipc }));
vi.mock('../src/im/lark/client.js', () => ({
  resolveUnionIdFromOpenIdStrict: mocks.union,
  lookupMessageChatId: vi.fn(),
}));
vi.mock('../src/services/group-collaboration-mode-store.js', () => ({
  readGroupCollaborationMode: mocks.mode,
}));
vi.mock('../src/services/project-group-store.js', () => ({
  readProjectGroup: mocks.project,
}));
vi.mock('../src/services/issue-board-store.js', () => ({ getBinding: mocks.issueBinding }));
vi.mock('../src/services/project-coordinator-runtime.js', () => ({
  projectCoordinator: { run: vi.fn() },
}));
vi.mock('../src/core/dispatch-report-binding.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/dispatch-report-binding.js')>(),
  loadOrCreateDispatchReportBindingSecret: mocks.secret,
}));
vi.mock('../src/services/project-workstream-attachments.js', () => ({
  readProjectAttachmentRecord: mocks.record,
  createProjectWorkstreamAttachments: (deps: any) => {
    mocks.factory(deps);
    mocks.serviceDeps = deps;
    const instance = Object.fromEntries(['inspect', 'attach', 'update', 'rename', 'reconcile', 'observe']
      .map(method => [method, vi.fn().mockResolvedValue({ method, dataDir: deps.dataDir })]));
    mocks.instances.push(instance);
    return instance;
  },
}));

import {
  getProjectAttachmentSource,
  localProjectAttachmentSource,
  projectHumanCallerKey,
  projectSessionOwnerKey,
  projectAttachmentActorAllowed,
  projectWorkstreamAttachments,
  setProjectWorkstreamPool,
  validateProjectAttachmentReport,
} from '../src/services/project-workstream-runtime.js';

const configReadsAtImport = mocks.configReads;

const SECRET = 'synthetic-runtime-binding-secret';
const ROOT = 'om_source_root';
const SOURCE_ID = 'source-session';
const SOURCE_APP = 'cli_worker';
const OWNER = 'union:on_owner';

function sourceSession(patch: Record<string, unknown> = {}) {
  return {
    sessionId: SOURCE_ID, larkAppId: SOURCE_APP, chatId: 'oc_project',
    rootMessageId: ROOT, scope: 'thread', status: 'active',
    ownerUnionId: 'on_owner', ownerOpenId: 'ou_owner',
    projectRouteRevision: 1, projectImportSource: 'relay', cliSessionId: 'native-source',
    title: '普通任务', ...patch,
  };
}

function importedFixture() {
  const source = sourceSession();
  mocks.live.set(SOURCE_ID, { session: source, cliReady: true });
  mocks.live.set('main-session', {
    session: sourceSession({
      sessionId: 'main-session', larkAppId: 'cli_main', scope: 'chat',
      rootMessageId: 'om_main', cliSessionId: 'native-main',
    }),
    cliReady: true,
  });
  const record = {
    phase: 'active', state: 'active', revision: 1,
    chatId: 'oc_project', rootMessageId: ROOT, projectGeneration: 'generation-1',
    coordinatorLarkAppId: 'cli_main', coordinatorSessionId: 'main-session', coordinatorOwnerKey: OWNER,
    source: {
      sessionId: SOURCE_ID, larkAppId: SOURCE_APP, routeRevision: 1, ownerKey: OWNER,
    },
  };
  mocks.record.mockReturnValue(record);
  mocks.mode.mockReturnValue({ mode: 'project', coordinatorAppId: 'cli_main', workerAppIds: [SOURCE_APP] });
  mocks.project.mockReturnValue({
    createdAt: 'generation-1', coordinatorSessionId: 'main-session', larkAppId: 'cli_main',
    workstreams: [{ dispatchRoot: ROOT }],
  });
  const reportBinding = createDispatchReportBinding(SECRET, {
    dispatchRoot: ROOT, targetLarkAppId: 'cli_main', targetSessionId: 'main-session',
    targetChatId: 'oc_project', targetScope: 'chat', sourceName: '任务', issuedAt: '2026-11-11T00:00:00.000Z',
    attachment: {
      sourceSessionId: SOURCE_ID, sourceLarkAppId: SOURCE_APP, ownerKey: OWNER,
      sourceRouteRevision: 1, revision: 1, state: 'active', reportCapability: 'verified',
    },
  });
  const registry = { [ROOT]: { reportBinding } };
  const validate = () => validateProjectAttachmentReport(registry, ROOT, SOURCE_APP, SOURCE_ID);
  return { source, record, registry, validate };
}

beforeEach(() => {
  setProjectWorkstreamPool({ findActiveBySessionId: (id: string) => mocks.live.get(id) });
  mocks.configAvailable = true;
  mocks.dataDir = '/synthetic-state';
  mocks.factory.mockClear();
  mocks.issueBinding.mockReset().mockReturnValue(undefined);
  mocks.live.clear();
  mocks.stored.clear();
  mocks.union.mockReset().mockResolvedValue({ status: 'unavailable' });
  mocks.daemon.mockReset().mockReturnValue(undefined);
  mocks.ipc.mockReset();
  mocks.mode.mockReset();
  mocks.project.mockReset();
  mocks.record.mockReset().mockReturnValue(undefined);
  mocks.secret.mockReset().mockReturnValue(SECRET);
});

describe('project workstream runtime owner identity', () => {
  it('uses a persisted verified union without resolving another namespace', async () => {
    expect(await projectSessionOwnerKey({ larkAppId: 'cli_worker', ownerUnionId: 'on_owner' })).toBe(OWNER);
    expect(mocks.union).not.toHaveBeenCalled();
  });

  it('resolves a legacy open id using the source app, without persisting a backfill', async () => {
    mocks.union.mockResolvedValue({ status: 'resolved', unionId: 'on_owner' });
    const identity = { larkAppId: 'cli_worker', ownerOpenId: 'ou_source' };
    expect(await projectSessionOwnerKey(identity)).toBe(OWNER);
    expect(mocks.union).toHaveBeenCalledWith('cli_worker', 'ou_source');
    expect(identity).toEqual({ larkAppId: 'cli_worker', ownerOpenId: 'ou_source' });
  });

  it('retains only an app-scoped identity on lookup failure and never borrows another app id', async () => {
    mocks.union.mockRejectedValue(new Error('synthetic network failure'));
    expect(await projectSessionOwnerKey({ larkAppId: 'cli_worker', ownerOpenId: 'ou_owner' }))
      .toBe('app:cli_worker:ou_owner');
    expect(await projectSessionOwnerKey({ larkAppId: 'cli_other', ownerOpenId: 'ou_owner' }))
      .toBe('app:cli_other:ou_owner');
    expect(await projectSessionOwnerKey({ larkAppId: 'cli_worker' })).toBeUndefined();
    expect(await projectSessionOwnerKey({ larkAppId: undefined, ownerUnionId: 'on_owner' })).toBeUndefined();
  });

  it('does not resolve a bot, unknown, scheduled or failed-recovery caller as a human', async () => {
    const base = { requestLarkAppId: 'cli_main', requestUserOpenId: 'ou_actor' };
    for (const caller of [
      { ...base, senderType: 'bot' as const },
      { ...base },
      { ...base, senderType: 'user' as const, source: 'schedule_creator' as const },
      { ...base, senderType: 'user' as const, source: 'failed_turn_recovery' as const },
    ]) expect(await projectHumanCallerKey(caller)).toBeUndefined();
    expect(mocks.union).not.toHaveBeenCalled();
  });

  it('uses only the actual human turn identity for a caller key', async () => {
    mocks.union.mockResolvedValue({ status: 'resolved', unionId: 'on_actor' });
    expect(await projectHumanCallerKey({
      senderType: 'user', requestLarkAppId: 'cli_main', requestUserOpenId: 'ou_actor',
    })).toBe('union:on_actor');
    expect(mocks.union).toHaveBeenCalledWith('cli_main', 'ou_actor');
  });
});

describe('project workstream runtime lazy facade', () => {
  const actor = {
    sessionId: 'main-session', larkAppId: 'cli_main', chatId: 'oc_project',
    scope: 'chat' as const, ownerKey: OWNER, turnId: 'turn-current',
  };
  const request = {
    sourceSessionId: SOURCE_ID, sourceLarkAppId: SOURCE_APP, rootMessageId: ROOT, title: '任务',
  };

  it('does not read dataDir when the module is imported before fixture initialization', () => {
    expect(configReadsAtImport).toBe(0);
  });

  it('fails closed before the composition root installs a live pool', async () => {
    const f = importedFixture();
    mocks.stored.set(SOURCE_ID, f.source);
    setProjectWorkstreamPool(undefined);
    expect(projectAttachmentActorAllowed(actor)).toBe(false);
    expect(await localProjectAttachmentSource(SOURCE_APP, SOURCE_ID)).toMatchObject({
      reportCapability: 'unavailable',
    });
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it('uses the currently installed pool without eagerly constructing or replacing it', async () => {
    const first = vi.fn(() => undefined);
    setProjectWorkstreamPool({ findActiveBySessionId: first });
    expect(await localProjectAttachmentSource(SOURCE_APP, SOURCE_ID)).toBeUndefined();
    expect(first).toHaveBeenCalledWith(SOURCE_ID);
    const second = vi.fn(() => ({ session: sourceSession(), cliReady: true }) as any);
    setProjectWorkstreamPool({ findActiveBySessionId: second });
    expect(await localProjectAttachmentSource(SOURCE_APP, SOURCE_ID)).toMatchObject({
      sessionId: SOURCE_ID, reportCapability: 'verified',
    });
    expect(second).toHaveBeenCalledWith(SOURCE_ID);
  });

  it('creates the service upon first use and reuses it across facade methods', async () => {
    mocks.dataDir = '/synthetic-lazy-one';
    const inspected = await projectWorkstreamAttachments.inspect(actor, request);
    expect(inspected).toEqual({ method: 'inspect', dataDir: mocks.dataDir });
    await projectWorkstreamAttachments.attach(actor, request);
    await projectWorkstreamAttachments.rename(actor, { rootMessageId: ROOT, title: '新任务名' });
    await projectWorkstreamAttachments.update(actor, { rootMessageId: ROOT, status: 'completed', content: '完成' });
    await projectWorkstreamAttachments.reconcile(actor, { rootMessageId: ROOT });
    await projectWorkstreamAttachments.observe({
      sessionId: SOURCE_ID, larkAppId: SOURCE_APP, chatId: actor.chatId, rootMessageId: ROOT,
      scope: 'thread', status: 'active', ownerKey: OWNER, routeRevision: 1,
      source: 'relay', ordinary: true, reportCapability: 'verified',
    });
    expect(mocks.factory).toHaveBeenCalledTimes(1);
    const instance = mocks.instances.at(-1)!;
    expect(instance.inspect).toHaveBeenCalledWith(actor, request);
    expect(instance.attach).toHaveBeenCalledWith(actor, request);
    expect(instance.rename).toHaveBeenCalledTimes(1);
    expect(instance.update).toHaveBeenCalledTimes(1);
    expect(instance.reconcile).toHaveBeenCalledTimes(1);
    expect(instance.observe).toHaveBeenCalledTimes(1);
  });

  it('rebinds after the selected data root changes without changing facade identity', async () => {
    const facade = projectWorkstreamAttachments;
    mocks.dataDir = '/synthetic-lazy-before';
    await facade.inspect(actor, request);
    const oldDeps = mocks.serviceDeps;
    mocks.dataDir = '/synthetic-lazy-after';
    expect(await facade.inspect(actor, request)).toEqual({ method: 'inspect', dataDir: mocks.dataDir });
    expect(facade).toBe(projectWorkstreamAttachments);
    expect(mocks.factory).toHaveBeenCalledTimes(2);
    // A service already in use stays pinned to its original authority root.
    oldDeps.getMode('oc_project');
    expect(mocks.mode).toHaveBeenLastCalledWith('/synthetic-lazy-before', 'oc_project');
  });

  it('keeps method properties spyable for IPC route tests', async () => {
    const spy = vi.spyOn(projectWorkstreamAttachments, 'inspect');
    try {
      mocks.dataDir = '/synthetic-lazy-spy';
      await projectWorkstreamAttachments.inspect(actor, request);
      expect(spy).toHaveBeenCalledWith(actor, request);
    } finally { spy.mockRestore(); }
  });
});

describe('project workstream runtime source projection', () => {
  it('requires the same live chat-scope managed turn for attachment mutations', () => {
    mocks.live.set('main-session', {
      larkAppId: 'cli_main', chatId: 'oc_project', scope: 'chat',
      managedTurnOrigin: { turnId: 'turn-current' },
    });
    const actor = {
      sessionId: 'main-session', larkAppId: 'cli_main', chatId: 'oc_project',
      scope: 'chat' as const, ownerKey: OWNER, turnId: 'turn-current',
    };
    expect(projectAttachmentActorAllowed(actor)).toBe(true);
    expect(projectAttachmentActorAllowed({ ...actor, turnId: undefined })).toBe(false);
    expect(projectAttachmentActorAllowed({ ...actor, turnId: 'turn-old' })).toBe(false);
    expect(projectAttachmentActorAllowed({ ...actor, larkAppId: 'cli_other' })).toBe(false);
    expect(projectAttachmentActorAllowed({ ...actor, chatId: 'oc_other' })).toBe(false);
    mocks.live.get('main-session').scope = 'thread';
    expect(projectAttachmentActorAllowed(actor)).toBe(false);
  });

  it('projects metadata and readiness without transcript or raw terminal content', async () => {
    mocks.live.set(SOURCE_ID, { session: sourceSession(), cliReady: true, lastScreenContent: 'private raw terminal' });
    expect(await localProjectAttachmentSource(SOURCE_APP, SOURCE_ID)).toMatchObject({
      sessionId: SOURCE_ID, larkAppId: SOURCE_APP, chatId: 'oc_project',
      rootMessageId: ROOT, routeRevision: 1, ownerKey: OWNER, ordinary: true, reportCapability: 'verified',
    });
    const source = await localProjectAttachmentSource(SOURCE_APP, SOURCE_ID);
    expect(source).not.toHaveProperty('transcript');
    expect(source).not.toHaveProperty('lastScreenContent');
  });

  it('does not expose a session under another source app', async () => {
    mocks.live.set(SOURCE_ID, { session: sourceSession(), cliReady: true });
    expect(await localProjectAttachmentSource('cli_other', SOURCE_ID)).toBeUndefined();
  });

  it.each([
    { projectRouteRevision: 2 },
    { rootMessageId: 'om_other' },
    { chatId: 'oc_other' },
    { ownerUnionId: 'on_other' },
    { status: 'closed' },
  ])('rejects source changes while legacy owner identity is being resolved', async changed => {
    const source = sourceSession({ ownerUnionId: undefined });
    mocks.live.set(SOURCE_ID, { session: source, cliReady: true });
    mocks.union.mockImplementation(async () => {
      Object.assign(source, changed);
      return { status: 'resolved', unionId: 'on_owner' };
    });
    expect(await localProjectAttachmentSource(SOURCE_APP, SOURCE_ID)).toBeUndefined();
  });

  it.each([
    { adoptedFrom: { source: 'tmux' }, expected: 'manual' },
    { pendingForkSession: true, expected: 'unavailable' },
    { cliSessionId: undefined, expected: 'unavailable' },
  ])('does not promise reporting before the source capability is available', patch => {
    const { expected, ...changed } = patch;
    mocks.live.set(SOURCE_ID, { session: sourceSession(changed), cliReady: true });
    return expect(localProjectAttachmentSource(SOURCE_APP, SOURCE_ID)).resolves.toMatchObject({ reportCapability: expected });
  });

  it.each(['workflowNode', 'vcMeetingReceiver', 'messageListenerRun', 'deferredScheduleRun'])(
    'excludes specialized source ownership %s', field => {
      mocks.live.set(SOURCE_ID, { session: sourceSession({ [field]: {} }), cliReady: true });
      return expect(localProjectAttachmentSource(SOURCE_APP, SOURCE_ID)).resolves.toMatchObject({ ordinary: false });
    },
  );

  it('does not treat a stored inactive source as report-ready', async () => {
    mocks.stored.set(SOURCE_ID, sourceSession({ status: 'closed' }));
    expect(await localProjectAttachmentSource(SOURCE_APP, SOURCE_ID))
      .toMatchObject({ status: 'closed', reportCapability: 'unavailable' });
  });

  it('rejects a remote source response with different session or app identity', async () => {
    mocks.daemon.mockReturnValue({ ipcPort: 12345 });
    mocks.ipc.mockResolvedValue({ ok: true, json: async () => ({ source: { sessionId: 'other', larkAppId: SOURCE_APP } }) });
    expect(await getProjectAttachmentSource(SOURCE_APP, SOURCE_ID)).toBeUndefined();
    mocks.ipc.mockResolvedValue({ ok: true, json: async () => ({ source: { sessionId: SOURCE_ID, larkAppId: 'cli_other' } }) });
    expect(await getProjectAttachmentSource(SOURCE_APP, SOURCE_ID)).toBeUndefined();
  });
});

describe('project workstream runtime report freshness', () => {
  it('proves an imported report against host journal, current source and current coordinator', async () => {
    const f = importedFixture();
    expect(await f.validate()).toEqual({ ok: true, ownerKey: OWNER, routeRevision: 1 });
  });

  it('rejects removal of signed imported fields while the host attachment journal exists', async () => {
    const f = importedFixture();
    f.registry[ROOT].reportBinding = createDispatchReportBinding(SECRET, {
      dispatchRoot: ROOT, targetLarkAppId: 'cli_main', targetSessionId: 'main-session',
      sourceName: 'legacy', issuedAt: '2026-11-11T00:00:00.000Z',
    });
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it('keeps the legacy path unchanged when no host attachment journal exists', async () => {
    expect(await validateProjectAttachmentReport({}, ROOT, SOURCE_APP, SOURCE_ID)).toEqual({ ok: true });
  });

  it.each([
    { phase: 'pending' }, { state: 'moved' }, { state: 'closed' }, { revision: 2 },
    { projectGeneration: 'recreated-project' },
  ])('rejects stale, pending, moved or replaced host journal state', async changed => {
    const f = importedFixture();
    Object.assign(f.record, changed);
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it.each([
    { projectRouteRevision: 3 }, { rootMessageId: 'om_moved' }, { chatId: 'oc_other' },
    { ownerUnionId: 'on_other' }, { status: 'closed' }, { pendingForkSession: true },
    { adoptedFrom: { source: 'tmux' } }, { workflowNode: {} },
  ])('rejects a moved, re-owned or no-longer-ready source', async changed => {
    const f = importedFixture();
    Object.assign(f.source, changed);
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it.each([
    { status: 'closed' }, { chatId: 'oc_other' }, { scope: 'thread' }, { ownerUnionId: 'on_other' },
  ])('rejects changed coordinator route or ownership', async changed => {
    const f = importedFixture();
    Object.assign(mocks.live.get('main-session').session, changed);
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it('rejects a project switched out of project mode or a removed workstream', async () => {
    const f = importedFixture();
    mocks.mode.mockReturnValue({ mode: 'standard' });
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    mocks.mode.mockReturnValue({ mode: 'project', coordinatorAppId: 'cli_main', workerAppIds: [SOURCE_APP] });
    mocks.project.mockReturnValue({ createdAt: 'generation-1', workstreams: [] });
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it('does not deliver to an old still-live coordinator after the project target is replaced', async () => {
    const f = importedFixture();
    mocks.project.mockReturnValue({
      createdAt: 'generation-1', larkAppId: 'cli_main', coordinatorSessionId: 'main-successor',
      workstreams: [{ dispatchRoot: ROOT }],
    });
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it('rechecks the source after awaiting a coordinator owner lookup', async () => {
    const f = importedFixture();
    mocks.live.get('main-session').session.ownerUnionId = undefined;
    mocks.union.mockImplementation(async () => {
      f.source.projectRouteRevision = 3;
      return { status: 'resolved', unionId: 'on_owner' };
    });
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it('rechecks project mode after awaiting a coordinator owner lookup', async () => {
    const f = importedFixture();
    mocks.live.get('main-session').session.ownerUnionId = undefined;
    mocks.union.mockImplementation(async () => {
      mocks.mode.mockReturnValue({ mode: 'standard' });
      return { status: 'resolved', unionId: 'on_owner' };
    });
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it('refuses reports when the source is no longer an enrolled project worker', async () => {
    const f = importedFixture();
    mocks.mode.mockReturnValue({ mode: 'project', coordinatorAppId: 'cli_main', workerAppIds: [] });
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it('rechecks worker membership after the final coordinator lookup', async () => {
    const f = importedFixture();
    mocks.live.get('main-session').session.ownerUnionId = undefined;
    let lookups = 0;
    mocks.union.mockImplementation(async () => {
      lookups += 1;
      if (lookups === 2) {
        mocks.mode.mockReturnValue({ mode: 'project', coordinatorAppId: 'cli_main', workerAppIds: [] });
      }
      return { status: 'resolved', unionId: 'on_owner' };
    });
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    expect(lookups).toBe(2);
  });

  it('rejects a coordinator that closes during the final source query', async () => {
    const f = importedFixture();
    f.source.ownerUnionId = undefined;
    let lookups = 0;
    mocks.union.mockImplementation(async () => {
      lookups += 1;
      if (lookups === 2) mocks.live.get('main-session').session.status = 'closed';
      return { status: 'resolved', unionId: 'on_owner' };
    });
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    expect(lookups).toBe(2);
  });

  it('rejects a source closed while resolving the final coordinator', async () => {
    const f = importedFixture();
    mocks.live.get('main-session').session.ownerUnionId = undefined;
    let lookups = 0;
    mocks.union.mockImplementation(async () => {
      lookups += 1;
      if (lookups === 2) f.source.status = 'closed';
      return { status: 'resolved', unionId: 'on_owner' };
    });
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    expect(lookups).toBe(2);
  });

  it('rejects a new source owner until the host grant and attachment are explicitly renewed', async () => {
    const f = importedFixture();
    f.source.ownerUnionId = 'on_new_owner';
    // Caller-side authorization claims cannot replace the current denied host journal.
    f.registry[ROOT] = {
      ...f.registry[ROOT], authorizedSourceOwnerKey: 'union:on_new_owner',
    } as typeof f.registry[typeof ROOT];
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it('rejects a new owner change during the final coordinator query', async () => {
    const f = importedFixture();
    mocks.live.get('main-session').session.ownerUnionId = undefined;
    let lookups = 0;
    mocks.union.mockImplementation(async () => {
      lookups += 1;
      if (lookups === 2) f.source.ownerUnionId = 'on_new_owner';
      return { status: 'resolved', unionId: 'on_owner' };
    });
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    expect(lookups).toBe(2);
  });

  it.each([
    { adoptedFrom: { source: 'tmux' } },
    { workflowNode: {} },
    { pendingForkSession: true },
    { cliSessionId: undefined },
  ])('rejects a final source capability change while resolving the coordinator', async changed => {
    const f = importedFixture();
    mocks.live.get('main-session').session.ownerUnionId = undefined;
    let lookups = 0;
    mocks.union.mockImplementation(async () => {
      lookups += 1;
      if (lookups === 2) Object.assign(f.source, changed);
      return { status: 'resolved', unionId: 'on_owner' };
    });
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    expect(lookups).toBe(2);
  });

  it('rejects lost source readiness while resolving the final coordinator', async () => {
    const f = importedFixture();
    mocks.live.get('main-session').session.ownerUnionId = undefined;
    let lookups = 0;
    mocks.union.mockImplementation(async () => {
      lookups += 1;
      if (lookups === 2) mocks.live.get(SOURCE_ID).cliReady = false;
      return { status: 'resolved', unionId: 'on_owner' };
    });
    expect(await f.validate()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    expect(lookups).toBe(2);
  });
});
