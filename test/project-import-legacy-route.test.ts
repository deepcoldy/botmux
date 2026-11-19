import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as bots from '../src/bot-registry.js';
import * as pool from '../src/core/worker-pool.js';
import * as sessions from '../src/services/session-store.js';
import * as attachments from '../src/services/project-workstream-attachments.js';
import { projectCoordinator } from '../src/services/project-coordinator-runtime.js';
import { ProjectCoordinator } from '../src/services/project-coordinator.js';
import { mutateProjectGroup, readProjectGroup } from '../src/services/project-group-store.js';
import { writeGroupCollaborationMode } from '../src/services/group-collaboration-mode-store.js';
import {
  setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';

const APP = 'cli_legacy_main', WORKER = 'cli_legacy_worker', CHAT = 'oc_legacy_project';
const ROOT = 'om_imported_root', CAP = 'ab'.repeat(32);
const SECRET = 'synthetic-legacy-project-test-secret';
const savedDataDir = config.session.dataDir;
let dataDir: string, server: IpcServerHandle, ds: any, source: any;
let record: attachments.ProjectAttachmentRecord | undefined;
let run: ReturnType<typeof vi.spyOn>, coordinator: ProjectCoordinator;
let transport: any;

beforeEach(async () => {
  dataDir = mkdtempSync(join(process.env.SESSION_DATA_DIR!, 'legacy-project-route-'));
  config.session.dataDir = dataDir;
  bots.registerBot({ larkAppId: APP, larkAppSecret: 'synthetic-only', cliId: 'codex' });
  ds = {
    session: { sessionId: 'legacy-main', larkAppId: APP, chatId: CHAT, rootMessageId: 'om_main', status: 'active', scope: 'chat' },
    larkAppId: APP, chatId: CHAT, chatType: 'group', scope: 'chat',
    managedTurnOrigin: {
      capability: CAP, turnId: 'om_bot_notice', dispatchAttempt: 1,
      trustedCaller: { senderType: 'bot', requestLarkAppId: APP, requestUserOpenId: 'ou_bot' },
    },
  };
  source = {
    sessionId: 'legacy-source', larkAppId: WORKER, chatId: CHAT, rootMessageId: ROOT,
    status: 'active', scope: 'thread', projectRouteRevision: 1,
  };
  record = {
    version: 1, operationId: 'synthetic-operation', projectGeneration: 'generation-one',
    chatId: CHAT, rootMessageId: ROOT, coordinatorSessionId: ds.session.sessionId,
    coordinatorLarkAppId: APP, coordinatorOwnerKey: 'union:on_owner',
    source: {
      sessionId: source.sessionId, larkAppId: WORKER, chatId: CHAT, rootMessageId: ROOT,
      scope: 'thread', status: 'active', ownerKey: 'union:on_owner', routeRevision: 1,
      source: 'relay', ordinary: true, reportCapability: 'verified',
    },
    revision: 1, state: 'active', phase: 'active', title: '原始迁入任务', purpose: '测试',
    createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z',
  };
  vi.spyOn(pool, 'findActiveBySessionId').mockImplementation(id => id === ds.session.sessionId ? ds : undefined);
  vi.spyOn(sessions, 'getSession').mockImplementation(id => id === source.sessionId ? source : undefined);
  vi.spyOn(attachments, 'readProjectAttachmentRecord').mockImplementation((_dir, rootOrChat, providedRoot) =>
    (providedRoot ?? rootOrChat) === ROOT ? record : undefined);
  transport = {
    sendCard: vi.fn(async () => 'om_card'), updateCard: vi.fn(async () => {}),
    pinMessage: vi.fn(async () => true), unpinMessage: vi.fn(async () => true),
    resolveThreadId: vi.fn(async () => null), isMessageWithdrawn: () => false,
    isMessageUpdateExpired: () => false, brand: () => 'feishu',
  };
  coordinator = new ProjectCoordinator(transport);
  run = vi.spyOn(projectCoordinator, 'run').mockImplementation((ctx, action, beforeApply) =>
    coordinator.run(ctx, action, beforeApply));
  await writeGroupCollaborationMode(dataDir, {
    chatId: CHAT, mode: 'project', coordinatorAppId: APP, workerAppIds: [WORKER],
  });
  await mutateProjectGroup(dataDir, CHAT, () => ({
    schemaVersion: 1, revision: 1, chatId: CHAT, larkAppId: APP,
    coordinatorSessionId: ds.session.sessionId, title: '项目', goal: '测试', phase: '测试', focus: '测试',
    status: 'active', blockers: [], milestones: [],
    workstreams: [{
      dispatchRoot: ROOT, title: '原始迁入任务', purpose: '测试', owners: [WORKER],
      status: 'pending', progress: 0, createdAt: 'generation-one', updatedAt: 'generation-one',
      attachment: {
        sourceSessionId: source.sessionId, sourceLarkAppId: WORKER, revision: 1,
        routeRevision: 1, state: 'active', reportCapability: 'verified',
      },
    }],
    createdAt: 'generation-one', updatedAt: 'generation-one',
    card: { messageId: 'om_card', pinned: true, updatedAt: 'generation-one' },
  }));
  setIpcAuthSecret(SECRET);
  setLarkAppId(APP);
  server = await startIpcServer({ host: '127.0.0.1', port: 0, authRequired: true });
});

afterEach(async () => {
  await server?.close();
  setIpcAuthSecret(null);
  setLarkAppId('');
  vi.restoreAllMocks();
  config.session.dataDir = savedDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

async function post(body: Record<string, unknown>, host = false) {
  const path = `/api/sessions/${ds.session.sessionId}/project`;
  const headers = new Headers({ 'content-type': 'application/json' });
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: 'POST',
    body: JSON.stringify({ ...body, ...(host ? {} : {
      originCapability: CAP, originTurnId: ds.managedTurnOrigin.turnId, originDispatchAttempt: 1,
    }) }),
    headers: host ? daemonIpcAuthHeaders({
      secret: SECRET, port: server.port, method: 'POST', path, headers,
    }) : headers,
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
const expectedAttachment = () => ({
  sourceSessionId: source.sessionId, revision: 1, coordinatorSessionId: ds.session.sessionId,
});
const item = () => readProjectGroup(dataDir, CHAT)!.workstreams[0]!;

describe('legacy /project cannot bypass imported workstream authority', () => {
  it.each([false, true])('rejects the internal rename action, host=%s', async host => {
    expect(await post({ action: 'workstream_rename', dispatchRoot: ROOT, title: '伪造的新标题' }, host))
      .toMatchObject({ status: 403, body: { error: 'project_workstream_route_required' } });
    expect(run).not.toHaveBeenCalled();
    expect(item().title).toBe('原始迁入任务');
  });

  it.each([
    { title: '伪造的新标题' }, { purpose: '抢占来源' }, { status: 'completed' },
    { progress: 0 }, { owners: [] }, { owners: ['cli_other'] },
    { title: '', purpose: '', status: 'in_progress' },
  ])('rejects imported dispatch metadata or ownership patches %j', async patch => {
    expect(await post({ action: 'dispatch', dispatchRoot: ROOT, ...patch }, true))
      .toMatchObject({ status: 403, body: { error: 'project_workstream_route_required' } });
    expect(run).not.toHaveBeenCalled();
    expect(item()).toMatchObject({ title: '原始迁入任务', status: 'pending', owners: [WORKER] });
  });

  it('keeps a blank --into dispatch as an exact metadata-only no-op for a bot turn', async () => {
    const before = readProjectGroup(dataDir, CHAT);
    expect(await post({ action: 'dispatch', dispatchRoot: ROOT, title: '', purpose: '' }))
      .toMatchObject({ status: 200, body: { ok: true, project: before } });
    expect(run).not.toHaveBeenCalled();
    expect(readProjectGroup(dataDir, CHAT)).toEqual(before);
  });

  it.each(['chat', 'app'] as const)('rejects a no-op imported root belonging to another %s', async changed => {
    if (changed === 'chat') record!.chatId = 'oc_other';
    else record!.coordinatorLarkAppId = 'cli_other';
    expect(await post({ action: 'dispatch', dispatchRoot: ROOT }, true))
      .toMatchObject({ status: 403, body: { error: 'project_coordinator_required' } });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([false, true])('requires attachment proof for imported report, host=%s', async host => {
    expect(await post({ action: 'report', dispatchRoot: ROOT, status: 'completed', content: '伪造完成' }, host))
      .toMatchObject({ status: 403, body: { error: 'project_workstream_route_required' } });
    expect(run).not.toHaveBeenCalled();
    expect(item().status).toBe('pending');
  });

  it('does not elevate a bot/current-turn capability into trusted-host report authority', async () => {
    expect(await post({
      action: 'report', dispatchRoot: ROOT, status: 'completed', content: '伪造完成',
      expectedAttachment: expectedAttachment(),
    })).toMatchObject({ status: 403, body: { error: 'trusted_host_required' } });
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts an exact host-signed imported report through the actual coordinator mutation', async () => {
    expect(await post({
      action: 'report', dispatchRoot: ROOT, status: 'completed', content: '已验证结果',
      expectedAttachment: expectedAttachment(),
    }, true)).toMatchObject({ status: 200, body: { ok: true } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(item()).toMatchObject({ title: '原始迁入任务', status: 'completed', lastReport: '已验证结果' });
  });

  it.each(['closed', 'moved', 'rebound', 'mode', 'membership'] as const)(
    'rechecks %s after waiting in the real coordinator queue', async changed => {
      let entered!: () => void, release!: () => void;
      const blocked = new Promise<void>(resolve => { entered = resolve; });
      const unblocked = new Promise<void>(resolve => { release = resolve; });
      let once = true;
      transport.updateCard.mockImplementation(async () => {
        if (once) { once = false; entered(); await unblocked; }
      });
      const blocker = coordinator.run({
        dataDir, chatId: CHAT, larkAppId: APP, coordinatorSessionId: ds.session.sessionId,
      }, { action: 'refresh' });
      await blocked;
      let enqueued!: () => void;
      const waiting = new Promise<void>(resolve => { enqueued = resolve; });
      run.mockImplementation((ctx, action, beforeApply) => {
        const result = coordinator.run(ctx, action, beforeApply);
        enqueued();
        return result;
      });
      const report = post({
        action: 'report', dispatchRoot: ROOT, status: 'completed', content: '旧回报',
        expectedAttachment: expectedAttachment(),
      }, true);
      await waiting;
      if (changed === 'closed') source.status = 'closed';
      else if (changed === 'moved') { source.rootMessageId = 'om_moved'; source.projectRouteRevision = 2; }
      else if (changed === 'rebound') record!.revision = 2;
      else await writeGroupCollaborationMode(dataDir, {
        chatId: CHAT, mode: changed === 'mode' ? 'standard' : 'project',
        coordinatorAppId: APP, workerAppIds: [],
      });
      release();
      await blocker;
      expect(await report).toMatchObject({ body: { ok: false, error: 'project_attachment_revision_conflict' } });
      expect(item()).toMatchObject({ status: 'pending', title: '原始迁入任务' });
    },
  );

  it('leaves ordinary legacy dispatch/report unchanged when no imported journal exists', async () => {
    record = undefined;
    expect(await post({
      action: 'dispatch', dispatchRoot: ROOT, title: '正常旧派单', owners: ['cli_other'],
      status: 'in_progress', progress: 30,
    })).toMatchObject({ status: 200, body: { ok: true } });
    expect(item()).toMatchObject({ title: '正常旧派单', status: 'in_progress', owners: ['cli_other'], progress: 30 });
    expect(await post({
      action: 'report', dispatchRoot: ROOT, status: 'completed', content: '正常旧回报',
    })).toMatchObject({ status: 200, body: { ok: true } });
    expect(item()).toMatchObject({ status: 'completed', lastReport: '正常旧回报' });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
