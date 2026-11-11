import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as registry from '../src/bot-registry.js';
import * as pool from '../src/core/worker-pool.js';
import * as client from '../src/im/lark/client.js';
import * as runtime from '../src/services/project-workstream-runtime.js';
import { setIpcAuthSecret, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as modes from '../src/services/group-collaboration-mode-store.js';
import { mutateProjectGroup, readProjectGroup } from '../src/services/project-group-store.js';
import { withFileLock } from '../src/utils/file-lock.js';
import { createProjectWorkstreamAttachments } from '../src/services/project-workstream-attachments.js';
import { ProjectCoordinator, type ProjectCoordinatorTransport } from '../src/services/project-coordinator.js';

const APP = 'cli_project_main', CHAT = 'oc_project_ipc', CAP = 'ab'.repeat(32);
let handle: IpcServerHandle;
let ds: any;
let attach: ReturnType<typeof vi.spyOn>;
const oldDir = config.session.dataDir;
const roots: string[] = [];

async function post(action: string, extra: Record<string, unknown> = {}, host = false) {
  const path = '/api/sessions/main-ipc/project-workstream';
  const body = JSON.stringify({ action, ...extra, ...(host ? {} : {
    originCapability: CAP, originTurnId: 'om_human', originDispatchAttempt: 1,
  }) });
  const headers = new Headers({ 'content-type': 'application/json' });
  return fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST', body,
    headers: host ? daemonIpcAuthHeaders({ secret: 'synthetic-ipc-secret', port: handle.port, method: 'POST', path, headers }) : headers,
  });
}
beforeEach(async () => {
  const bot = registry.registerBot({
    larkAppId: APP, larkAppSecret: 'synthetic-only', cliId: 'codex', allowedUsers: ['ou_owner'],
  });
  bot.resolvedAllowedUsers = ['ou_owner'];
  ds = {
    session: { sessionId: 'main-ipc', chatId: CHAT, rootMessageId: 'om_main', scope: 'chat', status: 'active', ownerUnionId: 'on_owner' },
    larkAppId: APP, chatId: CHAT, chatType: 'group', scope: 'chat',
    managedTurnOrigin: { capability: CAP, turnId: 'om_human', dispatchAttempt: 1, trustedCaller: {
      requestLarkAppId: APP, requestUserOpenId: 'ou_owner', requestUserUnionId: 'on_owner', senderType: 'user',
    } },
  };
  vi.spyOn(pool, 'findActiveBySessionId').mockImplementation(id => id === 'main-ipc' ? ds : undefined);
  vi.spyOn(client, 'resolveUnionIdFromOpenIdStrict').mockResolvedValue({ status: 'resolved', unionId: 'on_owner' });
  attach = vi.spyOn(runtime.projectWorkstreamAttachments, 'attach').mockResolvedValue({
    registered: true, cardSynced: true, attachment: {
      sourceSessionId: 'worker', sourceLarkAppId: 'cli_worker', revision: 1, routeRevision: 1,
      source: 'relay', state: 'active', reportCapability: 'verified',
    },
  });
  vi.spyOn(runtime.projectWorkstreamAttachments, 'rename').mockResolvedValue({ cardSynced: true, project: {} as any });
  setIpcAuthSecret('synthetic-ipc-secret');
  handle = await startIpcServer({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  await handle?.close();
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
  config.session.dataDir = oldDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const source = { sourceSessionId: 'worker', sourceLarkAppId: 'cli_worker', rootMessageId: 'om_task', title: '迁入任务' };

describe('project workstream IPC boundary', () => {
  it('binds actor to the live human chat coordinator, not request JSON', async () => {
    expect((await post('attach', source)).status).toBe(200);
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'main-ipc', larkAppId: APP, chatId: CHAT, ownerKey: 'union:on_owner', turnId: 'om_human',
    }), expect.objectContaining(source));
  });
  it('rejects stale capability before source lookup/registration', async () => {
    ds.managedTurnOrigin.capability = 'cd'.repeat(32);
    expect((await post('attach', source)).status).toBe(403);
    expect(attach).not.toHaveBeenCalled();
  });
  it('does not let a host signature substitute for a current CLI turn proof', async () => {
    expect((await post('attach', source, true)).status).toBe(403);
    expect(attach).not.toHaveBeenCalled();
  });
  it('does not treat a bot/unknown/scheduled caller or owner fallback as a human', async () => {
    for (const caller of [
      { requestLarkAppId: APP, requestUserOpenId: 'ou_owner', senderType: 'bot' },
      { requestLarkAppId: APP, requestUserOpenId: 'ou_owner' },
      { requestLarkAppId: APP, requestUserOpenId: 'ou_owner', senderType: 'user', source: 'schedule_creator' },
    ]) {
      ds.managedTurnOrigin.trustedCaller = caller;
      ds.session.ownerOpenId = 'ou_owner';
      expect((await post('attach', source, true)).status).toBe(403);
    }
    expect(attach).not.toHaveBeenCalled();
  });
  it('refuses a guest and a thread-scoped worker even with valid turn identity', async () => {
    ds.managedTurnOrigin.trustedCaller.requestUserOpenId = 'ou_guest';
    expect((await post('attach', source)).status).toBe(403);
    ds.managedTurnOrigin.trustedCaller.requestUserOpenId = 'ou_owner';
    ds.scope = 'thread';
    expect((await post('attach', source)).status).toBe(403);
    expect(attach).not.toHaveBeenCalled();
  });
  it('rejects forged authority and numeric coercions without writes', async () => {
    for (const extra of [
      { ownerKey: 'union:on_other' }, { chatId: 'oc_other' },
      { expectedRevision: '1' }, { progress: '100' }, { title: { arbitrary: true } },
    ]) {
      expect((await post('attach', { ...source, ...extra })).status).toBe(400);
    }
    expect(attach).not.toHaveBeenCalled();
  });
  it('refuses attach/status unless the human is the coordinator session owner', async () => {
    const reconcile = vi.spyOn(runtime.projectWorkstreamAttachments, 'reconcile');
    // Report validation compares the coordinator session owner with the human
    // who attached; another operator or an ownerless coordinator would leave a
    // registered association whose reports are always rejected.
    for (const owner of [{ ownerUnionId: 'on_other' }, { ownerUnionId: undefined }]) {
      Object.assign(ds.session, owner);
      for (const [action, extra] of [['attach', source], ['status', {}]] as const) {
        const res = await post(action, extra);
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe('project_coordinator_owner_required');
      }
    }
    expect(attach).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    ds.session.ownerUnionId = 'on_owner';
    expect((await post('attach', source)).status).toBe(200);
  });
  it.each(['attach', 'status'] as const)('rejects owner replacement during asynchronous legacy owner resolution before invoking %s', async action => {
    ds.session.ownerUnionId = undefined;
    ds.session.ownerOpenId = 'ou_legacy_owner';
    vi.mocked(client.resolveUnionIdFromOpenIdStrict).mockImplementationOnce(async () => {
      ds.session.ownerUnionId = 'on_replacement';
      return { status: 'resolved', unionId: 'on_owner' };
    });
    const reconcile = vi.spyOn(runtime.projectWorkstreamAttachments, 'reconcile');
    const res = await post(action, action === 'attach' ? source : {});
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'project_coordinator_owner_required' });
    expect(attach).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });
  it.each(['attach', 'status'] as const)(
    'rechecks coordinator ownership after real %s source lookup before persistent writes', async action => {
      const dataDir = mkdtempSync(join(process.env.SESSION_DATA_DIR!, 'owner-ipc-'));
      roots.push(dataDir);
      config.session.dataDir = dataDir;
      await modes.writeGroupCollaborationMode(dataDir, {
        chatId: CHAT, mode: 'project', coordinatorAppId: APP, workerAppIds: ['cli_worker'],
      });
      const transport: ProjectCoordinatorTransport = {
        sendCard: vi.fn(async () => 'om_card'), updateCard: vi.fn(async () => {}),
        pinMessage: vi.fn(async () => true), unpinMessage: vi.fn(async () => true),
        resolveThreadId: vi.fn(async () => null), isMessageWithdrawn: () => false,
        isMessageUpdateExpired: () => false, brand: () => 'feishu',
      };
      const coordinator = new ProjectCoordinator(transport);
      await coordinator.run({
        dataDir, chatId: CHAT, larkAppId: APP, coordinatorSessionId: 'main-ipc',
      }, { action: 'init', title: '合成项目', goal: '测试所有权边界' });
      let replaceOwner = false;
      const service = createProjectWorkstreamAttachments({
        dataDir,
        getSource: async () => {
          if (replaceOwner) ds.session.ownerUnionId = 'on_replacement';
          return {
            sessionId: 'worker', larkAppId: 'cli_worker', chatId: CHAT, rootMessageId: 'om_task',
            scope: 'thread', status: 'active', ownerKey: 'union:on_owner', routeRevision: 1,
            source: 'relay', ordinary: true, reportCapability: 'verified',
          };
        },
        getProject: chatId => readProjectGroup(dataDir, chatId),
        getMode: chatId => modes.readGroupCollaborationMode(dataDir, chatId),
        projectRun: (ctx, value, beforeApply) => coordinator.run(ctx, value, beforeApply),
        reportSecret: () => 'synthetic-owner-boundary-secret',
        lookupRoot: async () => true,
      });
      attach.mockImplementation((actor, request) => service.attach(actor, request));
      vi.spyOn(runtime.projectWorkstreamAttachments, 'reconcile')
        .mockImplementation((actor, request) => service.reconcile(actor, request));
      if (action === 'status') expect((await post('attach', source)).status).toBe(200);
      const before = readProjectGroup(dataDir, CHAT);
      const publicationCount = vi.mocked(transport.updateCard).mock.calls.length;
      replaceOwner = true;
      const res = await post(action, action === 'attach' ? source : { rootMessageId: 'om_task' });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'project_attachment_turn_stale' });
      expect(readProjectGroup(dataDir, CHAT)).toEqual(before);
      expect(transport.updateCard).toHaveBeenCalledTimes(publicationCount);
    },
  );
  it('allows dedicated rename action without an extra task kickoff', async () => {
    expect((await post('rename', { rootMessageId: 'om_task', title: '实现迁入任务' })).status).toBe(200);
    expect(runtime.projectWorkstreamAttachments.rename).toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });
  it.each(['capability', 'origin', 'project-generation'] as const)(
    'rejects notification opt-in if %s changes while the real configuration lock is held', async change => {
      const dataDir = mkdtempSync(join(process.env.SESSION_DATA_DIR!, 'workstream-ipc-'));
      roots.push(dataDir);
      config.session.dataDir = dataDir;
      await modes.writeGroupCollaborationMode(dataDir, {
        chatId: CHAT, mode: 'project', coordinatorAppId: APP, workerAppIds: ['cli_worker'],
      });
      await mutateProjectGroup(dataDir, CHAT, () => ({
        schemaVersion: 1, revision: 1, chatId: CHAT, larkAppId: APP,
        coordinatorSessionId: 'main-ipc', title: '合成项目', goal: '测试',
        phase: '验证', focus: '测试', status: 'active', blockers: [], workstreams: [], milestones: [],
        createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z',
      }));
      const originalWriter = modes.writeGroupCollaborationMode;
      let entered!: () => void, release!: () => void, called!: () => void;
      const locked = new Promise<void>(resolve => { entered = resolve; });
      const unlocked = new Promise<void>(resolve => { release = resolve; });
      const writerCalled = new Promise<void>(resolve => { called = resolve; });
      const held = withFileLock(join(dataDir, modes.GROUP_COLLABORATION_MODE_STORE_FILE), async () => {
        entered();
        await unlocked;
      });
      await locked;
      vi.spyOn(modes, 'writeGroupCollaborationMode').mockImplementation((...args) => {
        called();
        return originalWriter(...args);
      });
      try {
        const pending = post('notifications', { mode: 'notify' });
        await writerCalled;
        if (change === 'capability') ds.managedTurnOrigin.capability = 'cd'.repeat(32);
        else if (change === 'origin') ds.managedTurnOrigin = { ...ds.managedTurnOrigin };
        else await mutateProjectGroup(dataDir, CHAT, current => ({
          ...current!, createdAt: '2026-11-11T00:01:00Z',
        }));
        release();
        await held;
        const response = await pending;
        expect(response.status).not.toBe(200);
        expect(await response.json()).toMatchObject({
          ok: false, error: change === 'project-generation'
            ? 'project_configuration_changed' : 'project_attachment_actor_unproven',
        });
        expect(modes.readGroupCollaborationMode(dataDir, CHAT)?.importedSessionPolicy).toBe('ignore');
      } finally {
        release();
        await held;
      }
    },
  );
});
