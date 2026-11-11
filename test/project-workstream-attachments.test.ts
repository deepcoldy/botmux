import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createProjectWorkstreamAttachments, projectAttachmentRecordPath, readProjectAttachmentRecord,
  type ProjectAttachmentActor, type ProjectAttachmentSource,
} from '../src/services/project-workstream-attachments.js';
import {
  ProjectCoordinator, type ProjectCoordinatorAction, type ProjectCoordinatorContext, type ProjectCoordinatorTransport,
} from '../src/services/project-coordinator.js';
import { mutateProjectGroup, readProjectGroup } from '../src/services/project-group-store.js';
import {
  readGroupCollaborationMode, writeGroupCollaborationMode,
} from '../src/services/group-collaboration-mode-store.js';
import {
  createDispatchReportBinding, resolveVerifiedDispatchReportTarget, verifyDispatchReportBinding,
} from '../src/core/dispatch-report-binding.js';
import { updateDispatchRegistry } from '../src/core/dispatch-registry.js';
import { buildDispatchTaskTree, recordDispatchLastReport } from '../src/core/dispatch-task-tree.js';
import { authorizeReportSessionRelayRequest } from '../src/core/report-session-relay.js';
import { issueProjectSourceGrant, verifyProjectSourceGrant } from '../src/services/project-workstream-authority.js';
import { withFileLock } from '../src/utils/file-lock.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const SECRET = 'synthetic-attachment-test-secret';

async function fixture() {
  const dataDir = mkdtempSync(join(process.env.SESSION_DATA_DIR!, 'attachment-'));
  roots.push(dataDir);
  const actor: ProjectAttachmentActor = {
    sessionId: 'main-one', larkAppId: 'cli_main', chatId: 'oc_group', scope: 'chat', ownerKey: 'union:on_owner',
  };
  let source: ProjectAttachmentSource | undefined = {
    sessionId: 'source-one', larkAppId: 'cli_worker', chatId: 'oc_group', rootMessageId: 'om_topic',
    scope: 'thread', status: 'active', ownerKey: 'union:on_owner', routeRevision: 1,
    source: 'relay', ordinary: true, reportCapability: 'verified', title: '会话标题',
  };
  const transport: ProjectCoordinatorTransport = {
    sendCard: vi.fn(async () => 'om_card'),
    updateCard: vi.fn(async () => {}),
    pinMessage: vi.fn(async () => true),
    unpinMessage: vi.fn(async () => true),
    resolveThreadId: vi.fn(async () => null),
    isMessageWithdrawn: () => false, isMessageUpdateExpired: () => false, brand: () => 'feishu',
  };
  const coordinator = new ProjectCoordinator(transport);
  const context = { dataDir, chatId: actor.chatId, larkAppId: actor.larkAppId, coordinatorSessionId: actor.sessionId };
  await writeGroupCollaborationMode(dataDir, {
    chatId: actor.chatId, mode: 'project', coordinatorAppId: actor.larkAppId, workerAppIds: ['cli_worker'],
  });
  await coordinator.run(context, { action: 'init', title: '项目', goal: '合成测试' });
  const getSource = vi.fn(async () => source ? structuredClone(source) : undefined);
  const projectRun = vi.fn((
    ctx: ProjectCoordinatorContext, action: ProjectCoordinatorAction, beforeApply?: () => void,
  ) => coordinator.run(ctx, action, beforeApply));
  const lookupRoot = vi.fn(async () => true);
  const deps = {
    dataDir, getSource, projectRun, lookupRoot,
    getProject: (chatId: string) => readProjectGroup(dataDir, chatId),
    getMode: (chatId: string) => readGroupCollaborationMode(dataDir, chatId),
    reportSecret: () => SECRET,
  };
  const request = { sourceSessionId: 'source-one', sourceLarkAppId: 'cli_worker', rootMessageId: 'om_topic', title: '迁入任务' };
  const registry = () => JSON.parse(readFileSync(join(dataDir, 'orchestrate-dispatch.json'), 'utf8'));
  return {
    dataDir, actor, request, transport, coordinator, context, deps,
    service: createProjectWorkstreamAttachments(deps),
    getSource, projectRun, lookupRoot, registry,
    source: () => source!,
    replaceSource: (next: ProjectAttachmentSource | undefined) => { source = next; },
  };
}

describe('project workstream attachments', () => {
  it('registers one project row with host-bound source and metadata-only inspection', async () => {
    const f = await fixture();
    const inspected = await f.service.inspect(f.actor, f.request);
    expect(inspected).toMatchObject({ sourceSessionId: 'source-one', reportCapability: 'verified', title: '会话标题' });
    expect(inspected).not.toHaveProperty('transcript');
    expect(inspected).not.toHaveProperty('ownerKey');
    const result = await f.service.attach(f.actor, f.request);
    expect(result).toMatchObject({ registered: true, cardSynced: true, attachment: { state: 'active', revision: 1 } });
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams).toHaveLength(1);
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams[0]).toMatchObject({ status: 'pending', progress: 0 });
    expect(resolveVerifiedDispatchReportTarget({
      registry: f.registry(), dispatchRoot: 'om_topic', secret: SECRET,
    })).toMatchObject({ ok: true, binding: { attachment: { sourceSessionId: 'source-one', ownerKey: 'union:on_owner', sourceRouteRevision: 1 } } });
  });

  it.each(['adopt', 'bind', 'fork', 'resume_import', 'manual'] as const)(
    'uses the same registration path for %s without importing transcript', async source => {
      const f = await fixture();
      f.source().source = source;
      expect(await f.service.attach(f.actor, f.request)).toMatchObject({ registered: true, attachment: { source } });
    },
  );

  it('serializes duplicate attach and keeps a completed workstream completed', async () => {
    const f = await fixture();
    await Promise.all([f.service.attach(f.actor, f.request), f.service.attach(f.actor, f.request)]);
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams).toHaveLength(1);
    await f.service.update(f.actor, { rootMessageId: 'om_topic', status: 'completed', content: '合成完成' });
    await f.service.attach(f.actor, f.request);
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams[0]).toMatchObject({ status: 'completed', progress: 100 });
    expect(readProjectAttachmentRecord(f.dataDir, 'oc_group', 'om_topic')?.revision).toBe(1);
  });

  it.each([
    { ownerKey: undefined },
    { ownerKey: 'union:on_other' },
  ])('requires source-owner authorization', async patch => {
    const f = await fixture();
    Object.assign(f.source(), patch);
    await expect(f.service.attach(f.actor, f.request)).rejects.toThrow('source_owner_authorization_required');
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams).toHaveLength(0);
  });

  it('accepts a host-proved scoped source-owner consent, not actor JSON', async () => {
    const f = await fixture();
    f.source().ownerKey = 'union:on_other';
    const actor = {
      ...f.actor, authorizedSourceOwnerKey: 'union:on_other',
      authorizedSourceSessionId: f.source().sessionId,
      authorizedSourceLarkAppId: f.source().larkAppId,
      authorizedSourceRootMessageId: f.source().rootMessageId,
      authorizedSourceRouteRevision: f.source().routeRevision,
      sourceAuthorizationStillValid: () => true,
    };
    expect(await f.service.attach(actor, f.request)).toMatchObject({ registered: true });
    expect(readProjectAttachmentRecord(f.dataDir, 'oc_group', 'om_topic')?.coordinatorOwnerKey).toBe('union:on_owner');
  });

  it.each([
    { scope: 'chat' as const },
    { chatId: 'oc_elsewhere' },
    { rootMessageId: 'om_elsewhere' },
    { status: 'closed' },
  ])('rejects a source not currently at the requested live topic', async patch => {
    const f = await fixture();
    Object.assign(f.source(), patch);
    await expect(f.service.attach(f.actor, f.request)).rejects.toThrow('source_route_mismatch');
  });

  it('refuses workflow/specialized ownership and roots that cannot be proved', async () => {
    const f = await fixture();
    f.source().ordinary = false;
    await expect(f.service.attach(f.actor, f.request)).rejects.toThrow('source_managed_elsewhere');
    f.source().ordinary = true;
    f.lookupRoot.mockResolvedValue(false);
    await expect(f.service.attach(f.actor, f.request)).rejects.toThrow('source_root_unproven');
  });

  it('does not overwrite an ordinary dispatch or a workflow alias', async () => {
    const f = await fixture();
    await updateDispatchRegistry(join(f.dataDir, 'orchestrate-dispatch.json'), registry => {
      registry.om_topic = { kind: 'workflow-handoff-message', nonce: 'wfh_demo' };
    });
    await expect(f.service.attach(f.actor, f.request)).rejects.toThrow('workstream_root_already_registered');
    expect(f.registry().om_topic).toEqual({ kind: 'workflow-handoff-message', nonce: 'wfh_demo' });
    expect(readProjectAttachmentRecord(f.dataDir, 'oc_group', 'om_topic')).toBeUndefined();
  });

  it('rejects non-project groups and non-coordinator/unauthorized actors', async () => {
    const f = await fixture();
    await expect(f.service.attach({ ...f.actor, ownerKey: undefined }, f.request)).rejects.toThrow('actor_unproven');
    await expect(f.service.attach({ ...f.actor, larkAppId: 'cli_other' }, f.request)).rejects.toThrow('coordinator_required');
    await writeGroupCollaborationMode(f.dataDir, { chatId: 'oc_group', mode: 'standard' });
    await expect(f.service.attach(f.actor, f.request)).rejects.toThrow('project_mode_required');
  });

  it('keeps failed project creation pending and repairs the same operation on retry', async () => {
    const f = await fixture();
    f.projectRun.mockRejectedValueOnce(new Error('project_write_failed'));
    expect(await f.service.attach(f.actor, f.request)).toMatchObject({ registered: false });
    const before = readProjectAttachmentRecord(f.dataDir, 'oc_group', 'om_topic')!;
    expect(before.phase).toBe('pending');
    expect(resolveVerifiedDispatchReportTarget({ registry: f.registry(), dispatchRoot: 'om_topic', secret: SECRET }))
      .toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    expect(await f.service.attach(f.actor, f.request)).toMatchObject({ registered: true });
    const after = readProjectAttachmentRecord(f.dataDir, 'oc_group', 'om_topic')!;
    expect(after.operationId).toBe(before.operationId);
    expect(after.phase).toBe('active');
  });

  it('treats card publication failure as a repairable projection, not failed registration', async () => {
    const f = await fixture();
    vi.mocked(f.transport.updateCard).mockRejectedValue(new Error('provider_offline'));
    const result = await f.service.attach(f.actor, f.request);
    expect(result).toMatchObject({ registered: true, cardSynced: false });
    expect(readProjectAttachmentRecord(f.dataDir, 'oc_group', 'om_topic')?.phase).toBe('active');
    vi.mocked(f.transport.updateCard).mockResolvedValue(undefined);
    expect(await f.service.attach(f.actor, f.request)).toMatchObject({ registered: true, cardSynced: true });
  });

  it('does not activate after the source moved during project publication', async () => {
    const f = await fixture();
    vi.mocked(f.transport.updateCard).mockImplementation(async () => {
      f.source().rootMessageId = 'om_moved';
    });
    await expect(f.service.attach(f.actor, f.request)).rejects.toThrow('source_route_mismatch');
    expect(resolveVerifiedDispatchReportTarget({ registry: f.registry(), dispatchRoot: 'om_topic', secret: SECRET }))
      .toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it('checks the authenticated turn again after async source lookup', async () => {
    const f = await fixture();
    let turnLive = true;
    const service = createProjectWorkstreamAttachments({ ...f.deps, actorAllowed: () => turnLive });
    f.getSource.mockImplementation(async () => {
      turnLive = false;
      return structuredClone(f.source());
    });
    await expect(service.attach(f.actor, f.request)).rejects.toThrow('project_attachment_turn_stale');
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams).toHaveLength(0);
    expect(readProjectAttachmentRecord(f.dataDir, 'om_topic')).toBeUndefined();
  });

  it('does not activate after project mode changed while the provider was awaited', async () => {
    const f = await fixture();
    vi.mocked(f.transport.updateCard).mockImplementation(async () => {
      await writeGroupCollaborationMode(f.dataDir, { chatId: 'oc_group', mode: 'standard' });
    });
    await expect(f.service.attach(f.actor, f.request)).rejects.toThrow('project_mode_required');
    expect(resolveVerifiedDispatchReportTarget({ registry: f.registry(), dispatchRoot: 'om_topic', secret: SECRET }))
      .toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it('does not let an unrelated owner manually update an imported task', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    await expect(f.service.update({ ...f.actor, ownerKey: 'union:on_other' }, {
      rootMessageId: 'om_topic', status: 'completed',
    })).rejects.toThrow('workstream_not_found');
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams[0]?.status).toBe('pending');
  });

  it('marks migration/close without inferring task completion and requires CAS when returning', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    await f.service.update(f.actor, { rootMessageId: 'om_topic', status: 'in_progress' });
    f.source().rootMessageId = 'om_elsewhere';
    f.source().routeRevision = 2;
    expect(await f.service.reconcile(f.actor)).toMatchObject({ attachments: [{ state: 'moved' }] });
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams[0]?.status).toBe('in_progress');
    f.source().rootMessageId = 'om_topic';
    f.source().routeRevision = 3;
    await expect(f.service.attach(f.actor, f.request)).rejects.toThrow('attachment_revision_required');
    expect(await f.service.attach(f.actor, { ...f.request, expectedRevision: 1 })).toMatchObject({ attachment: { revision: 2 } });
    f.source().status = 'closed';
    expect(await f.service.reconcile(f.actor)).toMatchObject({ attachments: [{ state: 'closed' }] });
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams[0]?.status).toBe('in_progress');
  });

  it('requires explicit reattachment for same-root fresh source sessions', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    f.replaceSource({ ...f.source(), sessionId: 'source-two' });
    const request = { ...f.request, sourceSessionId: 'source-two' };
    await expect(f.service.attach(f.actor, request)).rejects.toThrow('attachment_revision_required');
    await expect(f.service.attach(f.actor, { ...request, expectedRevision: 9 })).rejects.toThrow('attachment_revision_conflict');
    expect(await f.service.attach(f.actor, { ...request, expectedRevision: 1 }))
      .toMatchObject({ attachment: { sourceSessionId: 'source-two', revision: 2 } });
  });

  it('rebinds the same-owner coordinator successor but not an unrelated human', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    await f.service.reconcile({ ...f.actor, sessionId: 'main-two' });
    expect(f.registry().om_topic.orchSessionId).toBe('main-two');
    await f.service.reconcile({ ...f.actor, sessionId: 'main-three', ownerKey: 'union:on_other' });
    expect(f.registry().om_topic.orchSessionId).toBe('main-two');
    await expect(f.service.attach({
      ...f.actor, ownerKey: 'union:on_other', authorizedSourceOwnerKey: 'union:on_owner',
      authorizedSourceSessionId: f.source().sessionId,
      authorizedSourceLarkAppId: f.source().larkAppId,
      authorizedSourceRootMessageId: f.source().rootMessageId,
      authorizedSourceRouteRevision: f.source().routeRevision,
      sourceAuthorizationStillValid: () => true,
    }, f.request))
      .rejects.toThrow('workstream_root_already_registered');
  });

  it('keeps adopted/manual items on the task board without granting automatic report', async () => {
    const f = await fixture();
    f.source().source = 'adopt';
    f.source().reportCapability = 'manual';
    expect(await f.service.attach(f.actor, f.request)).toMatchObject({ attachment: { reportCapability: 'manual' } });
    expect(resolveVerifiedDispatchReportTarget({ registry: f.registry(), dispatchRoot: 'om_topic', secret: SECRET }))
      .toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    expect(await f.service.update(f.actor, { rootMessageId: 'om_topic', status: 'completed' }))
      .toMatchObject({ project: { workstreams: [{ status: 'completed' }] } });
    expect(f.registry().om_topic.lastReport).toMatchObject({ status: 'completed' });
  });

  it('observes migration/close without a human turn but never claims a new source or revives work', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    await f.service.update(f.actor, { rootMessageId: 'om_topic', status: 'completed' });
    const unrelated = { ...f.source(), sessionId: 'source-unrelated', rootMessageId: 'om_other' };
    await f.service.observe(unrelated);
    expect(readProjectAttachmentRecord(f.dataDir, 'om_topic')?.state).toBe('active');
    f.source().rootMessageId = 'om_other';
    f.source().routeRevision = 2;
    await f.service.observe(structuredClone(f.source()));
    expect(readProjectAttachmentRecord(f.dataDir, 'om_topic')?.state).toBe('moved');
    expect(f.registry().om_topic.lastReport.status).toBe('completed');
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams[0]?.status).toBe('completed');
    f.source().rootMessageId = 'om_topic';
    f.source().routeRevision = 1;
    await f.service.observe(structuredClone(f.source()));
    expect(readProjectAttachmentRecord(f.dataDir, 'om_topic')?.state).toBe('moved');
    f.source().status = 'closed';
    await f.service.observe(structuredClone(f.source()));
    expect(readProjectAttachmentRecord(f.dataDir, 'om_topic')?.state).toBe('closed');
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams[0]?.status).toBe('completed');
  });

  it('repairs project/registry projections from an unchanged journal after a partial write', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    f.source().rootMessageId = 'om_other';
    f.source().routeRevision = 2;
    await f.service.observe(structuredClone(f.source()));
    await mutateProjectGroup(f.dataDir, 'oc_group', project => {
      if (project) delete project.workstreams[0].attachment;
      return project;
    });
    const record = readProjectAttachmentRecord(f.dataDir, 'om_topic')!;
    expect(record.state).toBe('moved');
    await f.service.reconcile(f.actor);
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams[0]?.attachment?.state).toBe('moved');
    expect(f.registry().om_topic.projectAttachment.state).toBe('moved');
  });

  it('keeps manual business updates and tree report coherent when only the card publication fails', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    vi.mocked(f.transport.updateCard).mockRejectedValue(new Error('provider_offline'));
    expect(await f.service.update(f.actor, { rootMessageId: 'om_topic', status: 'completed', content: '合成完成' }))
      .toMatchObject({ registered: true, cardSynced: false });
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams[0]?.status).toBe('completed');
    expect(f.registry().om_topic.lastReport.status).toBe('completed');
  });

  it('renames ordinary owned workstreams without changing state or ownership', async () => {
    const f = await fixture();
    await f.coordinator.run(f.context, { action: 'dispatch', dispatchRoot: 'om_topic', title: '旧任务', status: 'completed' });
    await updateDispatchRegistry(join(f.dataDir, 'orchestrate-dispatch.json'), registry => {
      registry.om_topic = { orchSessionId: 'main-one', title: '旧任务',
        reportBinding: createDispatchReportBinding(SECRET, {
          dispatchRoot: 'om_topic', targetLarkAppId: 'cli_main', targetSessionId: 'main-one',
          targetChatId: 'oc_group', targetScope: 'chat', sourceName: '旧任务', issuedAt: '2026-11-11T00:00:00Z',
        }),
      };
    });
    await f.service.rename(f.actor, { rootMessageId: 'om_topic', title: '重命名任务' });
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams[0]).toMatchObject({ title: '重命名任务', status: 'completed' });
    expect(f.registry().om_topic).toMatchObject({ title: '重命名任务', orchSessionId: 'main-one' });
    expect(verifyDispatchReportBinding(SECRET, 'om_topic', f.registry().om_topic.reportBinding)?.sourceName).toBe('重命名任务');
  });

  it.each(['', '子任务', ' 子项目 ', '一'.repeat(25)])(
    'rejects invalid rename titles at the host service without modifying either projection', async title => {
      const f = await fixture();
      await f.service.attach(f.actor, f.request);
      const project = readProjectGroup(f.dataDir, 'oc_group');
      const registry = f.registry();
      await expect(f.service.rename(f.actor, { rootMessageId: 'om_topic', title }))
        .rejects.toThrow('project_workstream_title_required');
      expect(readProjectGroup(f.dataDir, 'oc_group')).toEqual(project);
      expect(f.registry()).toEqual(registry);
    },
  );

  it('refuses rename by another coordinator or for an unregistered root without creating a task', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    const project = readProjectGroup(f.dataDir, 'oc_group');
    const registry = f.registry();
    await expect(f.service.rename({ ...f.actor, larkAppId: 'cli_other' }, {
      rootMessageId: 'om_topic', title: '越权标题',
    })).rejects.toThrow('project_coordinator_required');
    await expect(f.service.rename(f.actor, {
      rootMessageId: 'om_unknown', title: '未登记任务',
    })).rejects.toThrow('workstream_not_found');
    expect(readProjectGroup(f.dataDir, 'oc_group')).toEqual(project);
    expect(f.registry()).toEqual(registry);
  });

  it('renames an imported item at the Unicode title limit and preserves child report authorization and task identity', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    const original = verifyDispatchReportBinding(SECRET, 'om_topic', f.registry().om_topic.reportBinding)!;
    const title = '𠮷'.repeat(24);
    await f.service.rename(f.actor, { rootMessageId: 'om_topic', title });
    const binding = verifyDispatchReportBinding(SECRET, 'om_topic', f.registry().om_topic.reportBinding)!;
    expect(binding).toEqual({ ...original, sourceName: title });
    const capability = 'synthetic-live-report-capability';
    const decision = authorizeReportSessionRelayRequest({
      trustedHost: false, selfLarkAppId: 'cli_worker', registry: f.registry(), bindingSecret: SECRET,
      raw: {
        sessionId: 'source-one', dispatchRoot: 'om_topic', content: '改名后完成',
        status: 'completed', originCapability: capability,
      },
      session: {
        sessionId: 'source-one', larkAppId: 'cli_worker', chatId: 'oc_group',
        scope: 'thread', rootMessageId: 'om_topic', receiver: false,
        ownerKey: 'union:on_owner', routeRevision: 1,
        liveOrigin: { capability, turnId: 'om_current_turn', dispatchAttempt: 1 },
      },
    });
    expect(decision).toMatchObject({
      ok: true, target: { sessionId: 'main-one', larkAppId: 'cli_main' },
      sourceName: title, projectUpdate: { status: 'completed' },
    });
    if (!decision.ok) throw new Error('expected authorized report');
    await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: decision.dispatchRoot,
      content: decision.content, ...decision.projectUpdate,
      expectedAttachment: {
        sourceSessionId: 'source-one', revision: 1, coordinatorSessionId: 'main-one',
      },
    });
    await updateDispatchRegistry(join(f.dataDir, 'orchestrate-dispatch.json'), registry => {
      recordDispatchLastReport(registry, decision.dispatchRoot, {
        ...decision.projectUpdate, content: decision.content, at: '2026-11-11T01:00:00Z',
      });
    });
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams).toHaveLength(1);
    expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams[0])
      .toMatchObject({ dispatchRoot: 'om_topic', title, status: 'completed' });
    expect(buildDispatchTaskTree({
      registry: f.registry(), orchSessionId: 'main-one', title: '项目',
      sessions: [{ sessionId: 'source-one', larkAppId: 'cli_worker', rootMessageId: 'om_topic', status: 'active' }],
      localAppIds: new Set(['cli_worker']),
    }).nodes).toMatchObject([{ dispatchRoot: 'om_topic', title, state: 'done' }]);
  });

  it('refuses a symlinked authority leaf instead of reading or overwriting it', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    const path = projectAttachmentRecordPath(f.dataDir, 'om_topic');
    rmSync(path);
    const decoy = join(f.dataDir, 'decoy');
    writeFileSync(decoy, 'do-not-touch', { mode: 0o600 });
    symlinkSync(decoy, path);
    await expect(f.service.attach(f.actor, f.request)).rejects.toThrow();
    expect(readFileSync(decoy, 'utf8')).toBe('do-not-touch');
  });

  it.each(['update', 'rename', 'attach'] as const)(
    'rejects a stale actor after %s waits in the real project queue, before any business write', async operation => {
      const f = await fixture();
      await f.service.attach(f.actor, f.request);
      let turnLive = true;
      const service = createProjectWorkstreamAttachments({ ...f.deps, actorAllowed: () => turnLive });
      let unblock!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      const release = new Promise<void>(resolve => { unblock = resolve; });
      let first = true;
      vi.mocked(f.transport.updateCard).mockImplementation(async () => {
        if (first) { first = false; entered(); await release; }
      });
      const blocker = f.coordinator.run(f.context, { action: 'refresh' });
      await waiting;
      let enqueued!: () => void;
      const queued = new Promise<void>(resolve => { enqueued = resolve; });
      f.projectRun.mockImplementation((ctx, action, beforeApply) => {
        const result = f.coordinator.run(ctx, action, beforeApply);
        if (action.action !== 'refresh') enqueued();
        return result;
      });
      const pending = operation === 'update'
        ? service.update(f.actor, { rootMessageId: 'om_topic', status: 'completed' })
        : operation === 'rename'
          ? service.rename(f.actor, { rootMessageId: 'om_topic', title: '新标题' })
          : service.attach(f.actor, { ...f.request, title: '新标题' });
      const outcome = pending.then(result => ({ result }), error => ({ error: error.message }));
      await queued;
      turnLive = false;
      unblock();
      await blocker;
      expect(await outcome).toMatchObject({ error: 'project_attachment_turn_stale' });
      const item = readProjectGroup(f.dataDir, 'oc_group')!.workstreams[0]!;
      expect(item).toMatchObject({ status: 'pending', title: '迁入任务' });
      expect(f.registry().om_topic.lastReport).toBeUndefined();
    },
  );

  it('rechecks the actor inside project mutation after waiting for its file lock', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    let turnLive = true;
    const service = createProjectWorkstreamAttachments({ ...f.deps, actorAllowed: () => turnLive });
    let entered!: () => void;
    let unlock!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { unlock = resolve; });
    const held = withFileLock(join(f.dataDir, 'project-groups.json'), async () => {
      entered();
      await released;
    });
    await waiting;
    let guardEntered!: () => void;
    const guardWaiting = new Promise<void>(resolve => { guardEntered = resolve; });
    f.projectRun.mockImplementation((ctx, action, beforeApply) => f.coordinator.run(ctx, action, () => {
      beforeApply?.();
      guardEntered();
    }));
    const outcome = service.update(f.actor, { rootMessageId: 'om_topic', status: 'completed' })
      .then(result => ({ result }), error => ({ error: error.message }));
    await guardWaiting;
    turnLive = false;
    unlock();
    await held;
    expect(await outcome).toMatchObject({ error: 'project_attachment_turn_stale' });
    expect(readProjectGroup(f.dataDir, 'oc_group')!.workstreams[0]!.status).toBe('pending');
    expect(f.registry().om_topic.lastReport).toBeUndefined();
  });

  it('rejects a same-turn actor whose capability or permission is revoked during source lookup', async () => {
    const f = await fixture();
    let allowed = true;
    const actor = { ...f.actor, turnId: 'om_same_turn', authorizationStillValid: () => allowed };
    const service = createProjectWorkstreamAttachments({ ...f.deps, actorAllowed: () => true });
    f.getSource.mockImplementationOnce(async () => {
      allowed = false;
      return structuredClone(f.source());
    });
    await expect(service.attach(actor, f.request)).rejects.toThrow('project_attachment_turn_stale');
    expect(actor.turnId).toBe('om_same_turn');
    expect(readProjectGroup(f.dataDir, 'oc_group')!.workstreams).toHaveLength(0);
    expect(readProjectAttachmentRecord(f.dataDir, 'om_topic')).toBeUndefined();
    expect(f.projectRun).not.toHaveBeenCalled();
  });

  it('rechecks same-turn caller authorization after a report waits in the real coordinator queue', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    let allowed = true, entered!: () => void, release!: () => void, enqueued!: () => void;
    const actor = { ...f.actor, turnId: 'om_same_turn', authorizationStillValid: () => allowed };
    const service = createProjectWorkstreamAttachments({ ...f.deps, actorAllowed: () => true });
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const unblocked = new Promise<void>(resolve => { release = resolve; });
    const queued = new Promise<void>(resolve => { enqueued = resolve; });
    vi.mocked(f.transport.updateCard).mockImplementationOnce(async () => {
      entered();
      await unblocked;
    });
    const blocker = f.coordinator.run(f.context, { action: 'refresh' });
    await blocked;
    f.projectRun.mockImplementation((ctx, action, beforeApply) => {
      const result = f.coordinator.run(ctx, action, beforeApply);
      if (action.action === 'report') enqueued();
      return result;
    });
    const report = service.update(actor, { rootMessageId: 'om_topic', status: 'completed', content: '旧权限回报' })
      .then(result => ({ result }), error => ({ error: error.message }));
    await queued;
    allowed = false;
    release();
    await blocker;
    expect(await report).toMatchObject({ error: 'project_attachment_turn_stale' });
    expect(actor.turnId).toBe('om_same_turn');
    expect(readProjectGroup(f.dataDir, 'oc_group')!.workstreams[0]!).toMatchObject({ status: 'pending', progress: 0 });
    expect(f.registry().om_topic.lastReport).toBeUndefined();
  });

  it('repairs an interrupted imported rename from its denied journal once, without reverting later titles', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    f.projectRun.mockRejectedValueOnce(new Error('simulated_project_write_failure'));
    await expect(f.service.rename(f.actor, { rootMessageId: 'om_topic', title: '新标题' }))
      .rejects.toThrow('simulated_project_write_failure');
    expect(readProjectAttachmentRecord(f.dataDir, 'om_topic')).toMatchObject({
      title: '新标题', pendingRename: true,
    });
    expect(f.registry().om_topic.title).toBe('新标题');
    expect(readProjectGroup(f.dataDir, 'oc_group')!.workstreams[0]!.title).toBe('迁入任务');
    await f.service.reconcile(f.actor, { rootMessageId: 'om_topic' });
    expect(readProjectGroup(f.dataDir, 'oc_group')!.workstreams[0]!).toMatchObject({
      title: '新标题', status: 'pending',
    });
    expect(readProjectAttachmentRecord(f.dataDir, 'om_topic')!.pendingRename).toBeUndefined();
    await f.coordinator.run(f.context, { action: 'workstream_rename', dispatchRoot: 'om_topic', title: '后续手工标题' });
    await f.service.reconcile(f.actor);
    expect(readProjectGroup(f.dataDir, 'oc_group')!.workstreams[0]!.title).toBe('后续手工标题');
  });

  it('exposes a pending operation after its source closes, without hiding it or activating a replacement', async () => {
    const f = await fixture();
    f.projectRun.mockRejectedValueOnce(new Error('simulated_project_write_failure'));
    await f.service.attach(f.actor, f.request);
    const operation = readProjectAttachmentRecord(f.dataDir, 'om_topic')!.operationId;
    f.source().status = 'closed';
    await f.service.observe(structuredClone(f.source()));
    expect(await f.service.reconcile(f.actor)).toMatchObject({
      attachments: [{ rootMessageId: 'om_topic', phase: 'pending', state: 'closed', revision: 1 }],
    });
    expect(readProjectGroup(f.dataDir, 'oc_group')!.workstreams).toHaveLength(0);
    expect(resolveVerifiedDispatchReportTarget({ registry: f.registry(), dispatchRoot: 'om_topic', secret: SECRET }))
      .toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    await expect(f.service.attach(f.actor, f.request)).rejects.toThrow('source_route_mismatch');
    f.replaceSource({ ...f.source(), sessionId: 'source-two', status: 'active' });
    const request = { ...f.request, sourceSessionId: 'source-two' };
    await expect(f.service.attach(f.actor, request)).rejects.toThrow('attachment_revision_required');
    expect(await f.service.attach(f.actor, { ...request, expectedRevision: 1 })).toMatchObject({
      attachment: { sourceSessionId: 'source-two', revision: 2, state: 'active' },
    });
    expect(readProjectAttachmentRecord(f.dataDir, 'om_topic')!.operationId).toBe(operation);
  });

  it('does not activate a valid but pending association from a status reconciliation', async () => {
    const f = await fixture();
    f.projectRun.mockRejectedValueOnce(new Error('simulated_project_write_failure'));
    await f.service.attach(f.actor, f.request);
    expect(await f.service.reconcile(f.actor)).toMatchObject({
      attachments: [{ rootMessageId: 'om_topic', phase: 'pending', state: 'pending' }],
    });
    expect(resolveVerifiedDispatchReportTarget({ registry: f.registry(), dispatchRoot: 'om_topic', secret: SECRET }))
      .toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    expect(await f.service.attach(f.actor, f.request)).toMatchObject({ registered: true });
  });

  it('requires cross-owner consent for the exact current source route, not a frozen previous lookup', async () => {
    const f = await fixture();
    f.source().ownerKey = 'union:on_source_owner';
    const grant = issueProjectSourceGrant({
      dataDir: f.dataDir, secret: SECRET, callerOwnerKey: f.source().ownerKey,
      source: {
        sourceSessionId: f.source().sessionId, sourceLarkAppId: f.source().larkAppId,
        rootMessageId: f.source().rootMessageId, routeRevision: 1, ownerKey: f.source().ownerKey!,
      },
      targetChatId: f.actor.chatId, coordinatorAppId: f.actor.larkAppId, now: 10_000,
    });
    const scope = {
      dataDir: f.dataDir, secret: SECRET, id: grant.id, sourceSessionId: f.source().sessionId,
      sourceLarkAppId: f.source().larkAppId, rootMessageId: f.source().rootMessageId,
      routeRevision: 1, targetChatId: f.actor.chatId, coordinatorAppId: f.actor.larkAppId, now: 10_001,
    };
    const owner = verifyProjectSourceGrant(scope);
    const actor = {
      ...f.actor, authorizedSourceOwnerKey: owner,
      authorizedSourceSessionId: scope.sourceSessionId,
      authorizedSourceLarkAppId: scope.sourceLarkAppId,
      authorizedSourceRootMessageId: scope.rootMessageId,
      authorizedSourceRouteRevision: scope.routeRevision,
      sourceAuthorizationStillValid: () => verifyProjectSourceGrant(scope) === owner,
    };
    f.source().routeRevision = 2;
    expect(verifyProjectSourceGrant({ ...scope, routeRevision: 2 })).toBeUndefined();
    await expect(f.service.attach(actor, f.request)).rejects.toThrow('source_owner_authorization_required');
    expect(readProjectAttachmentRecord(f.dataDir, 'om_topic')).toBeUndefined();
    expect(readProjectGroup(f.dataDir, 'oc_group')!.workstreams).toHaveLength(0);
  });

  it('keeps a newer human rename when an older partial rename is reconciled', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    f.projectRun.mockRejectedValueOnce(new Error('simulated_project_write_failure'));
    await expect(f.service.rename(f.actor, { rootMessageId: 'om_topic', title: '旧轮标题' }))
      .rejects.toThrow('simulated_project_write_failure');
    expect(readProjectAttachmentRecord(f.dataDir, 'om_topic')!.pendingRenamePreviousTitle).toBe('迁入任务');
    await f.coordinator.run(f.context, { action: 'workstream_rename', dispatchRoot: 'om_topic', title: '新人类标题' });
    await f.service.reconcile(f.actor);
    expect(readProjectGroup(f.dataDir, 'oc_group')!.workstreams[0]!.title).toBe('新人类标题');
    expect(f.registry().om_topic.title).toBe('新人类标题');
    expect(readProjectAttachmentRecord(f.dataDir, 'om_topic')!.pendingRename).toBeUndefined();
  });

  it('repairs only the tree projection of an already committed manual report after turn revocation', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    let turnLive = true;
    const service = createProjectWorkstreamAttachments({ ...f.deps, actorAllowed: () => turnLive });
    vi.mocked(f.transport.updateCard).mockImplementation(async () => { turnLive = false; });
    await expect(service.update(f.actor, {
      rootMessageId: 'om_topic', status: 'completed', content: '已经落盘的完成说明',
    })).rejects.toThrow('project_attachment_turn_stale');
    const committed = readProjectGroup(f.dataDir, 'oc_group')!.workstreams[0]!;
    expect(committed).toMatchObject({ status: 'completed', lastReport: '已经落盘的完成说明' });
    expect(f.registry().om_topic.lastReport).toBeUndefined();
    expect(readProjectAttachmentRecord(f.dataDir, 'om_topic')!.pendingReport).toBeDefined();
    vi.mocked(f.transport.updateCard).mockResolvedValue(undefined);
    turnLive = true;
    await service.reconcile(f.actor);
    expect(f.registry().om_topic.lastReport).toMatchObject({ status: 'completed', line: '已经落盘的完成说明' });
    expect(readProjectGroup(f.dataDir, 'oc_group')!.workstreams[0]).toMatchObject({
      status: committed.status, progress: committed.progress, lastReport: committed.lastReport,
      updatedAt: committed.updatedAt,
    });
    expect(readProjectAttachmentRecord(f.dataDir, 'om_topic')!.pendingReport).toBeUndefined();
  });

  it('does not replay an uncommitted manual report when status is reconciled', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    f.projectRun.mockRejectedValueOnce(new Error('before_project_commit'));
    await expect(f.service.update(f.actor, {
      rootMessageId: 'om_topic', status: 'completed', content: '并未完成',
    })).rejects.toThrow('before_project_commit');
    await f.service.reconcile(f.actor);
    expect(readProjectGroup(f.dataDir, 'oc_group')!.workstreams[0]!.status).toBe('pending');
    expect(f.registry().om_topic.lastReport).toBeUndefined();
    expect(readProjectAttachmentRecord(f.dataDir, 'om_topic')!.pendingReport).toBeUndefined();
  });

  it('does not mistake unchanged status for a committed new report after a project write failure', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    await f.service.update(f.actor, { rootMessageId: 'om_topic', status: 'completed', content: '原先结果' });
    f.projectRun.mockRejectedValueOnce(new Error('before_project_commit'));
    await expect(f.service.update(f.actor, {
      rootMessageId: 'om_topic', status: 'completed', content: '未经落盘的新结果',
    })).rejects.toThrow('before_project_commit');
    await f.service.reconcile(f.actor);
    expect(readProjectGroup(f.dataDir, 'oc_group')!.workstreams[0]!.lastReport).toBe('原先结果');
    expect(f.registry().om_topic.lastReport).toMatchObject({ status: 'completed', line: '原先结果' });
  });

  it('does not mirror an obsolete report over a newer human report during recovery', async () => {
    const f = await fixture();
    await f.service.attach(f.actor, f.request);
    let turnLive = true;
    const service = createProjectWorkstreamAttachments({ ...f.deps, actorAllowed: () => turnLive });
    vi.mocked(f.transport.updateCard).mockImplementation(async () => { turnLive = false; });
    await expect(service.update(f.actor, {
      rootMessageId: 'om_topic', status: 'completed', content: '旧结果',
    })).rejects.toThrow('project_attachment_turn_stale');
    vi.mocked(f.transport.updateCard).mockResolvedValue(undefined);
    await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_topic', status: 'blocked', content: '新人类发现阻塞',
    });
    turnLive = true;
    await service.reconcile(f.actor);
    expect(readProjectGroup(f.dataDir, 'oc_group')!.workstreams[0]).toMatchObject({
      status: 'blocked', lastReport: '新人类发现阻塞',
    });
    expect(f.registry().om_topic.lastReport).toBeUndefined();
  });
});
