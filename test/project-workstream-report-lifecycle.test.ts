import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';
import {
  localProjectAttachmentSource, setProjectWorkstreamPool, validateProjectAttachmentReport,
} from '../src/services/project-workstream-runtime.js';
import { createProjectWorkstreamAttachments } from '../src/services/project-workstream-attachments.js';
import { ProjectCoordinator, type ProjectCoordinatorTransport } from '../src/services/project-coordinator.js';
import { readProjectGroup } from '../src/services/project-group-store.js';
import { readGroupCollaborationMode, writeGroupCollaborationMode } from '../src/services/group-collaboration-mode-store.js';
import { loadOrCreateDispatchReportBindingSecret } from '../src/core/dispatch-report-binding.js';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { authorizeReportSessionRelayRequest, deliverReportSessionRelay } from '../src/core/report-session-relay.js';

// Real source projection, attachment service, journal, registry and project
// stores; only the daemon worker pool is synthetic. During an active turn
// (`runtime_busy`) ds.cliReady is false while ds.workerReady stays true; idle
// suspension clears worker/workerReady while the session itself stays active.
const oldDataDir = config.session.dataDir;
const roots: string[] = [];
const contractStores: SessionContractStore[] = [];
afterEach(() => {
  setProjectWorkstreamPool(undefined);
  config.session.dataDir = oldDataDir;
  for (const store of contractStores.splice(0)) {
    try { store.close(); } catch { /* ignore */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function session(patch: Record<string, unknown>) {
  return {
    sessionId: 'source-one', larkAppId: 'cli_worker', chatId: 'oc_group', rootMessageId: 'om_topic',
    scope: 'thread', chatType: 'group', status: 'active', ownerUnionId: 'on_owner',
    projectRouteRevision: 1, projectImportSource: 'relay', cliSessionId: 'native-source', title: '已有话题',
    ...patch,
  };
}

async function fixture(sourceWorkerLive: boolean) {
  const dataDir = mkdtempSync(join(process.env.SESSION_DATA_DIR!, 'workstream-lifecycle-'));
  roots.push(dataDir);
  config.session.dataDir = dataDir;
  const live = new Map<string, any>([
    ['source-one', {
      larkAppId: 'cli_worker', chatId: 'oc_group', scope: 'thread', session: session({}),
      worker: sourceWorkerLive ? { killed: false } : null,
      workerReady: sourceWorkerLive,
      cliReady: sourceWorkerLive,
    }],
    ['main-one', {
      larkAppId: 'cli_main', chatId: 'oc_group', scope: 'chat',
      worker: { killed: false }, workerReady: true, cliReady: true,
      session: session({ sessionId: 'main-one', larkAppId: 'cli_main', scope: 'chat', rootMessageId: 'om_main', cliSessionId: 'native-main' }),
    }],
  ]);
  setProjectWorkstreamPool({ findActiveBySessionId: id => live.get(id) });
  const transport: ProjectCoordinatorTransport = {
    sendCard: vi.fn(async () => 'om_card'), updateCard: vi.fn(async () => {}),
    pinMessage: vi.fn(async () => true), unpinMessage: vi.fn(async () => true),
    resolveThreadId: vi.fn(async () => null),
    isMessageWithdrawn: () => false, isMessageUpdateExpired: () => false, brand: () => 'feishu',
  };
  const coordinator = new ProjectCoordinator(transport);
  await writeGroupCollaborationMode(dataDir, {
    chatId: 'oc_group', mode: 'project', coordinatorAppId: 'cli_main', workerAppIds: ['cli_worker'],
  });
  await coordinator.run(
    { dataDir, chatId: 'oc_group', larkAppId: 'cli_main', coordinatorSessionId: 'main-one' },
    { action: 'init', title: '项目', goal: '合成' },
  );
  const service = createProjectWorkstreamAttachments({
    dataDir,
    getSource: localProjectAttachmentSource,
    getProject: chatId => readProjectGroup(dataDir, chatId),
    getMode: chatId => readGroupCollaborationMode(dataDir, chatId),
    projectRun: (ctx, action, beforeApply) => coordinator.run(ctx, action, beforeApply),
    reportSecret: () => loadOrCreateDispatchReportBindingSecret(dataDir),
  });
  const actor = { sessionId: 'main-one', larkAppId: 'cli_main', chatId: 'oc_group', scope: 'chat' as const, ownerKey: 'union:on_owner' };
  const request = { sourceSessionId: 'source-one', sourceLarkAppId: 'cli_worker', rootMessageId: 'om_topic', title: '迁入任务' };
  const registry = () => JSON.parse(readFileSync(join(dataDir, 'orchestrate-dispatch.json'), 'utf8'));
  const report = (appId = 'cli_worker', sessionId = 'source-one') =>
    validateProjectAttachmentReport(registry(), 'om_topic', appId, sessionId);
  const sourceWorker = live.get('source-one');
  return { dataDir, live, coordinator, service, actor, request, registry, report, sourceWorker };
}

describe('imported workstream reporting across source worker suspension and active turns', () => {
  it('keeps the association reportable when status runs while the source worker is suspended', async () => {
    const f = await fixture(true);
    await f.service.attach(f.actor, f.request);
    expect(await f.report()).toMatchObject({ ok: true });
    f.sourceWorker.worker = null;
    f.sourceWorker.workerReady = false;
    f.sourceWorker.cliReady = false;
    const status = await f.service.reconcile(f.actor, {});
    expect(status.attachments).toEqual([expect.objectContaining({ rootMessageId: 'om_topic', state: 'active' })]);
    f.sourceWorker.worker = { killed: false };
    f.sourceWorker.workerReady = true;
    f.sourceWorker.cliReady = false; // Woken directly into an active turn
    expect(await f.report()).toMatchObject({ ok: true });
  });

  it('registers a reportable association while the source worker is suspended', async () => {
    const f = await fixture(false);
    const attached = await f.service.attach(f.actor, f.request);
    expect(attached).toMatchObject({ registered: true, attachment: { state: 'active', reportCapability: 'verified' } });
    f.sourceWorker.worker = { killed: false };
    f.sourceWorker.workerReady = true;
    f.sourceWorker.cliReady = false;
    expect(await f.report()).toMatchObject({ ok: true });
  });

  it('still refuses a report while the source worker is suspended or dead', async () => {
    const f = await fixture(true);
    await f.service.attach(f.actor, f.request);
    f.sourceWorker.worker = null;
    f.sourceWorker.workerReady = false;
    f.sourceWorker.cliReady = false;
    expect(await f.report()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });

    f.sourceWorker.worker = { killed: true };
    f.sourceWorker.workerReady = true;
    expect(await f.report()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });

  it('accepts both in_progress and completed reports while SessionController is in runtime_busy (cliReady=false, workerReady=true) and rejects identity mismatches', async () => {
    const f = await fixture(true);
    const store = new SessionContractStore(f.dataDir, 'cli_worker');
    contractStores.push(store);
    const controller = new SessionController(f.sourceWorker, store);
    const boot = controller.bindWorker(1);
    const runtime = controller.reserveBinding('bind-1', boot.worker);
    let seq = 0;
    const emit = (msg: Record<string, unknown>, scope: Record<string, unknown> = { runtime }) => {
      seq += 1;
      return controller.ingest({
        ...msg,
        sessionContract: {
          version: 2, session: boot.session, producer: boot.worker,
          eventId: `${boot.worker.workerId}:${seq}`, sequence: seq, scope,
        },
      } as any, boot.worker);
    };

    controller.bindRuntime('bind-1', boot.worker, {
      backend: 'tmux', physicalId: 'pane-1', proof: 'process_start', nativeSessionId: 'native-source',
    });
    emit({ type: 'ready' }, {});
    emit({ type: 'prompt_ready' });
    expect(f.sourceWorker.workerReady).toBe(true);
    expect(f.sourceWorker.cliReady).toBe(true);

    await f.service.attach(f.actor, f.request);

    // Enter active turn (`runtime_busy`): promptReady=false -> cliReady=false, workerReady=true
    emit({ type: 'screen_update', status: 'working' });
    expect(f.sourceWorker.workerReady).toBe(true);
    expect(f.sourceWorker.cliReady).toBe(false);

    const capability = 'c'.repeat(64);
    const secret = loadOrCreateDispatchReportBindingSecret(f.dataDir);
    const relayedPayloads: any[] = [];

    for (const status of ['in_progress', 'completed'] as const) {
      const proof = await f.report();
      expect(proof).toEqual({ ok: true, ownerKey: 'union:on_owner', routeRevision: 1 });
      if (!proof.ok) throw new Error('expected ok');

      const decision = authorizeReportSessionRelayRequest({
        raw: {
          sessionId: 'source-one',
          dispatchRoot: 'om_topic',
          content: status === 'in_progress' ? '开始复测 QA 包' : '复测完成：10 轮 0 复现',
          status,
          originCapability: capability,
        },
        trustedHost: false,
        session: {
          sessionId: 'source-one',
          larkAppId: 'cli_worker',
          chatId: 'oc_group',
          receiver: false,
          scope: 'thread',
          rootMessageId: 'om_topic',
          ownerKey: proof.ownerKey,
          routeRevision: proof.routeRevision,
          liveOrigin: { capability, turnId: 'om_turn_busy', dispatchAttempt: 1 },
          quoteTargetId: 'om_turn_busy',
        },
        selfLarkAppId: 'cli_worker',
        registry: f.registry(),
        bindingSecret: secret,
      });
      expect(decision).toMatchObject({
        ok: true,
        dispatchRoot: 'om_topic',
        target: { sessionId: 'main-one', larkAppId: 'cli_main' },
        projectUpdate: { status },
      });
      if (!decision.ok) throw new Error('expected authorized decision');

      const delivered = await deliverReportSessionRelay({
        decision,
        triggerMeta: { requestId: `req-${status}`, receivedAt: '2026-11-12T02:30:00.000Z' },
        beforeWrite: async () => {
          const again = await f.report();
          if (!again.ok) throw new Error(again.error);
        },
        fetchTarget: async (_path, init) => {
          const parsed = JSON.parse(String(init.body));
          relayedPayloads.push(parsed);
          return new Response(JSON.stringify({ ok: true, sessionId: 'main-one', triggerId: `trg_${status}` }), { status: 200 });
        },
        postProjectUpdate: async () => {
          await f.coordinator.run(
            { dataDir: f.dataDir, chatId: 'oc_group', larkAppId: 'cli_main', coordinatorSessionId: 'main-one' },
            { action: 'report', dispatchRoot: 'om_topic', content: decision.content, status },
          );
          return { projectSynced: true };
        },
      });
      expect(delivered.status).toBe(200);
      expect(delivered.body).toMatchObject({
        ok: true,
        reportTarget: { sessionId: 'main-one', larkAppId: 'cli_main' },
        triggerId: `trg_${status}`,
        projectSynced: true,
      });
      expect(readProjectGroup(f.dataDir, 'oc_group')?.workstreams[0]?.status).toBe(status);
    }
    expect(relayedPayloads).toHaveLength(2);

    // Identity / route / owner / coordinator mismatches still fail closed while runtime_busy
    expect(await f.report('cli_other', 'source-one')).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    expect(await f.report('cli_worker', 'impostor-session')).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });

    f.sourceWorker.session.ownerUnionId = 'on_impostor';
    expect(await f.report()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    f.sourceWorker.session.ownerUnionId = 'on_owner';

    f.sourceWorker.session.projectRouteRevision = 2;
    expect(await f.report()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    f.sourceWorker.session.projectRouteRevision = 1;

    f.sourceWorker.session.rootMessageId = 'om_other_root';
    expect(await f.report()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    f.sourceWorker.session.rootMessageId = 'om_topic';

    // Shutdown detach clears ds.worker before the worker's exit event reaches
    // the controller, so the contract still projects workerReady=true; only the
    // missing worker handle can reject a report inside that window.
    const liveWorker = f.sourceWorker.worker;
    f.sourceWorker.worker = null;
    expect(f.sourceWorker.workerReady).toBe(true);
    expect(await f.report()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
    f.sourceWorker.worker = liveWorker;
    expect(await f.report()).toMatchObject({ ok: true });

    // Worker disconnect during turn rejects subsequent reports
    controller.workerLost(boot.worker);
    expect(f.sourceWorker.workerReady).toBe(false);
    expect(await f.report()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });
});
