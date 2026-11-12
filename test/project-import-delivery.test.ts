import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../src/config.js';
import * as registry from '../src/bot-registry.js';
import * as pool from '../src/core/worker-pool.js';
import * as sources from '../src/services/project-workstream-runtime.js';
import * as sessionStore from '../src/services/session-store.js';
import * as sessionManager from '../src/core/session-manager.js';
import * as groups from '../src/services/groups-store.js';
import * as client from '../src/im/lark/client.js';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { readGroupCollaborationMode, writeGroupCollaborationMode } from '../src/services/group-collaboration-mode-store.js';
import { mutateProjectGroup, readProjectGroup } from '../src/services/project-group-store.js';
import { projectImportOperationId } from '../src/services/project-import-notifications.js';
import {
  PROJECT_IMPORT_AWAITING_PROJECT_ROUTE,
  PROJECT_IMPORT_COORDINATORS_ROUTE,
  projectImportSnapshotFromSource,
} from '../src/services/project-import-runtime.js';
import { readTurnRegistration } from '../src/core/trigger-registration.js';
import * as idempotency from '../src/services/idempotency-store.js';
import { ProjectCoordinator, type ProjectCoordinatorTransport } from '../src/services/project-coordinator.js';
import { createProjectWorkstreamAttachments } from '../src/services/project-workstream-attachments.js';

const APP = 'cli_import_main', CHAT = 'oc_import_project', WORKER = 'cli_import_worker';
let dataDir: string, handle: IpcServerHandle, ds: any, source: any;
let send: ReturnType<typeof vi.spyOn>, fork: ReturnType<typeof vi.spyOn>;
let sourceLookup: ReturnType<typeof vi.spyOn>;
let replyCardSpy: ReturnType<typeof vi.spyOn>, updateCardSpy: ReturnType<typeof vi.spyOn>;
const previousDir = config.session.dataDir;
let previousEnv: string | undefined;

beforeEach(async () => {
  previousEnv = process.env.SESSION_DATA_DIR;
  dataDir = mkdtempSync(join(process.env.SESSION_DATA_DIR!, 'project-import-delivery-'));
  config.session.dataDir = process.env.SESSION_DATA_DIR = dataDir;
  registry.registerBot({ larkAppId: APP, larkAppSecret: 'synthetic-only', cliId: 'codex' });
  ds = {
    session: {
      sessionId: 'main-import', larkAppId: APP, chatId: CHAT, rootMessageId: 'om_main',
      scope: 'chat', status: 'active', workerGeneration: 1,
    },
    larkAppId: APP, chatId: CHAT, chatType: 'group', scope: 'chat',
    worker: { killed: false, send: vi.fn() }, workerGeneration: 1, hasHistory: true,
  };
  source = {
    sessionId: 'source-import', larkAppId: WORKER, chatId: CHAT, rootMessageId: 'om_source',
    scope: 'thread', status: 'active', ordinary: true, routeRevision: 1, source: 'relay', chatType: 'group',
    title: 'private-title-not-for-notification', ownerKey: 'union:on_owner', reportCapability: 'verified',
  };
  vi.spyOn(pool, 'findActiveBySessionId').mockImplementation(id => id === ds.session.sessionId ? ds : undefined);
  vi.spyOn(pool, 'getActiveSessionsRegistry').mockReturnValue(new Map([['synthetic-main', ds]]));
  vi.spyOn(pool, 'getDaemonBootId').mockReturnValue('synthetic-import-boot');
  vi.spyOn(pool, 'hasQueuedActivationAdmissionGate').mockReturnValue(false);
  vi.spyOn(pool, 'withActiveSessionKeyLock').mockImplementation((_map, _key, run) => run());
  sourceLookup = vi.spyOn(sources, 'getProjectAttachmentSource').mockImplementation(async () => structuredClone(source));
  vi.spyOn(sessionStore, 'getSession').mockImplementation(id => id === source.sessionId ? ({
    ...source, projectRouteRevision: source.routeRevision, projectImportSource: source.source,
  } as any) : undefined);
  vi.spyOn(sessionStore, 'getOwnedSession').mockImplementation(id => id === ds.session.sessionId ? ds.session : undefined);
  vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
  vi.spyOn(sessionManager, 'ensureSessionWhiteboard').mockImplementation(() => {});
  vi.spyOn(sessionManager, 'rememberLastCliInput').mockImplementation(() => {});
  vi.spyOn(sessionManager, 'buildFollowUpCliInput').mockImplementation(prompt => ({ content: prompt }));
  vi.spyOn(groups, 'isInChat').mockResolvedValue(true);
  replyCardSpy = vi.spyOn(client, 'replyMessage').mockResolvedValue('om_import_topic_card');
  updateCardSpy = vi.spyOn(client, 'updateMessage').mockResolvedValue(undefined);
  fork = vi.spyOn(pool, 'forkWorker').mockImplementation(() => {});
  send = vi.spyOn(pool, 'sendWorkerInput').mockImplementation((target, _content, triggerId) => {
    const entry = target.idempotentAsyncTurns?.get(triggerId!);
    if (entry) {
      expect(idempotency.recordTurnInputCommit({
        ownerLarkAppId: APP, key: entry.key, sessionId: target.session.sessionId,
        triggerId: triggerId!, ownerBootId: 'synthetic-import-boot', workerGeneration: 1, observedAt: Date.now(),
      })).toBe(true);
    }
    return true;
  });
  await writeGroupCollaborationMode(dataDir, {
    chatId: CHAT, mode: 'project', coordinatorAppId: APP, workerAppIds: [WORKER], importedSessionPolicy: 'notify',
  });
  await mutateProjectGroup(dataDir, CHAT, () => ({
    schemaVersion: 1, revision: 1, chatId: CHAT, larkAppId: APP, coordinatorSessionId: ds.session.sessionId,
    title: 'synthetic', goal: 'probe only', phase: 'test', focus: 'test', status: 'active',
    blockers: [], workstreams: [], milestones: [], createdAt: 'generation-one', updatedAt: 'generation-one',
  }));
  setIpcAuthSecret('synthetic-import-secret');
  setLarkAppId(APP);
  handle = await startIpcServer({ host: '127.0.0.1', port: 0, authRequired: true });
});
afterEach(async () => {
  await handle?.close();
  setIpcAuthSecret(null);
  setLarkAppId('');
  vi.restoreAllMocks();
  config.session.dataDir = previousDir;
  if (previousEnv === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

function request() {
  const snapshot = projectImportSnapshotFromSource(source)!;
  const operationId = projectImportOperationId(snapshot);
  const id = createHash('sha256').update(operationId).digest('hex');
  const target = { sessionId: ds.session.sessionId, larkAppId: APP, chatId: CHAT, scope: 'chat' };
  return {
    notification: { id, operationId, projectGeneration: 'generation-one', coordinatorAppId: APP, snapshot },
    target,
    idempotencyKey: `project-import:${id}:${createHash('sha256').update(target.sessionId).digest('hex').slice(0, 24)}`,
  };
}
async function post(body = request(), host = true) {
  const path = '/api/project-import/deliver';
  const headers = new Headers({ 'content-type': 'application/json' });
  const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: host ? daemonIpcAuthHeaders({
      secret: 'synthetic-import-secret', port: handle.port, method: 'POST', path, headers,
    }) : headers,
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
async function hostPost(path: string, body: unknown) {
  const headers = new Headers({ 'content-type': 'application/json' });
  const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: daemonIpcAuthHeaders({ secret: 'synthetic-import-secret', port: handle.port, method: 'POST', path, headers }),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
function registration(body: ReturnType<typeof request>) {
  return readTurnRegistration(APP, ds.session.sessionId, body.idempotencyKey).body;
}

describe('project import actual delivery endpoint with real trigger and durable registration', () => {
  it('commits metadata once, posts one visible topic card, and retries the exact stable key without duplicate sends', async () => {
    const body = request();
    expect(await post(body)).toMatchObject({ status: 200, body: { delivered: true, unknown: false } });
    expect(registration(body)).toMatchObject({ state: 'registered', inputCommitted: { state: 'observed' } });
    expect(replyCardSpy).toHaveBeenCalledTimes(1);
    expect(replyCardSpy).toHaveBeenCalledWith(APP, 'om_source', expect.any(String), 'interactive', true);
    expect(await post(body)).toMatchObject({ status: 200, body: { delivered: true } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(replyCardSpy).toHaveBeenCalledTimes(1);
    expect(updateCardSpy).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
    expect(JSON.stringify(send.mock.calls[0]![1])).not.toContain(source.title);
    expect(JSON.stringify(send.mock.calls[0]![1])).not.toContain(source.ownerKey);
  });

  it.each(['closed', 'moved'] as const)('rejects a source %s while async lookup is outstanding', async change => {
    const body = request();
    sourceLookup.mockImplementationOnce(async () => {
      const prior = structuredClone(source);
      if (change === 'closed') source.status = 'closed';
      else { source.rootMessageId = 'om_moved'; source.routeRevision = 2; }
      return prior;
    });
    expect(await post(body)).toMatchObject({ status: 409, body: { error: 'source_changed', preDispatch: true } });
    expect(send).not.toHaveBeenCalled();
    expect(registration(body).state).toBe('unknown');
  });

  it.each(['closed', 'moved', 'policy', 'coordinator'] as const)(
    'rejects %s during the real trigger await before lease claim and can safely retry the same key', async change => {
      const body = request();
      vi.mocked(groups.isInChat).mockImplementationOnce(async () => {
        if (change === 'closed') source.status = 'closed';
        else if (change === 'moved') { source.rootMessageId = 'om_moved'; source.routeRevision = 2; }
        else if (change === 'policy') await writeGroupCollaborationMode(dataDir, { chatId: CHAT, mode: 'standard' });
        else await mutateProjectGroup(dataDir, CHAT, current => ({ ...current!, coordinatorSessionId: 'new-main' }));
        return true;
      });
      expect(await post(body)).toMatchObject({ status: 409, body: { preDispatch: true } });
      expect(send).not.toHaveBeenCalled();
      expect(registration(body).state).toBe('unknown');
      source.status = 'active'; source.rootMessageId = 'om_source'; source.routeRevision = 1;
      await writeGroupCollaborationMode(dataDir, {
        chatId: CHAT, mode: 'project', coordinatorAppId: APP, workerAppIds: [WORKER], importedSessionPolicy: 'notify',
      });
      await mutateProjectGroup(dataDir, CHAT, current => ({ ...current!, coordinatorSessionId: ds.session.sessionId }));
      expect(await post(body)).toMatchObject({ status: 200, body: { delivered: true } });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['ignore', 'standard', 'not-worker'] as const)('does nothing under %s policy', async mode => {
    await writeGroupCollaborationMode(dataDir, {
      chatId: CHAT, mode: mode === 'standard' ? 'standard' : 'project', coordinatorAppId: APP,
      workerAppIds: mode === 'not-worker' ? [] : [WORKER],
      importedSessionPolicy: mode === 'ignore' ? 'ignore' : 'notify',
    });
    expect(await post()).toMatchObject({ status: 409, body: { error: 'policy_disabled', preDispatch: true } });
    expect(sourceLookup).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not let an unsigned caller or arbitrary host payload forge source identity', async () => {
    const body = request();
    expect((await post(body, false)).status).toBe(401);
    expect((await post({ ...body, idempotencyKey: 'forged' })).status).toBe(400);
    expect((await post({
      ...body, notification: { ...body.notification, snapshot: { ...body.notification.snapshot, routeRevision: 9 } },
    })).status).toBe(400);
    const alternate = { ...body, notification: {
      ...body.notification, snapshot: { ...body.notification.snapshot, rootMessageId: 'om_forged' },
    } };
    expect((await post(alternate)).status).toBe(409);
    expect(send).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
  });

  it('keeps a synchronous worker refusal outcome unknown without inventing durable input acceptance', async () => {
    const body = request();
    send.mockReturnValueOnce(false);
    expect(await post(body)).toMatchObject({ status: 200, body: { delivered: false, unknown: true } });
    expect(registration(body)).toMatchObject({
      state: 'registered', inputCommitted: { state: 'unknown' },
    });
    expect(replyCardSpy).not.toHaveBeenCalled();
    expect(await post(body)).toMatchObject({ status: 200, body: { delivered: false, unknown: true } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('allows coordinator project-import turn to attach same-owner session onto pinned card while flagging ownerless sessions with confirm button', async () => {
    const bot = registry.registerBot({ larkAppId: APP, larkAppSecret: 'synthetic-only', cliId: 'codex', allowedUsers: ['ou_owner'] });
    bot.resolvedAllowedUsers = ['ou_owner'];
    ds.session.ownerOpenId = 'ou_owner';
    ds.session.ownerUnionId = 'on_owner';

    const transport: ProjectCoordinatorTransport = {
      sendCard: vi.fn(async () => 'om_pinned_project_card'),
      updateCard: vi.fn(async () => {}),
      pinMessage: vi.fn(async () => true),
      unpinMessage: vi.fn(async () => true),
      resolveThreadId: vi.fn(async () => null),
      isMessageWithdrawn: () => false,
      isMessageUpdateExpired: () => false,
      brand: () => 'feishu',
    };
    const coordinator = new ProjectCoordinator(transport);
    await mutateProjectGroup(dataDir, CHAT, current => ({
      ...current!,
      card: { messageId: 'om_pinned_project_card', pinned: true, updatedAt: 'generation-one' },
    }));

    const service = createProjectWorkstreamAttachments({
      dataDir,
      getSource: async () => structuredClone(source),
      getProject: chatId => readProjectGroup(dataDir, chatId),
      getMode: chatId => ({ chatId, mode: 'project', coordinatorAppId: APP, workerAppIds: [WORKER], importedSessionPolicy: 'notify' }),
      projectRun: (ctx, action, beforeApply) => coordinator.run(ctx, action, beforeApply),
      reportSecret: () => 'synthetic-report-secret',
      lookupRoot: async () => true,
    });
    vi.spyOn(sources.projectWorkstreamAttachments, 'inspect').mockImplementation((actor, req) => service.inspect(actor, req));
    vi.spyOn(sources.projectWorkstreamAttachments, 'attach').mockImplementation((actor, req) => service.attach(actor, req));

    // 1. Same-owner session: coordinator notice turn can inspect + attach onto pinned project card and settle topic card.
    let dispatchedTurnId = '';
    send.mockImplementationOnce((target, _content, triggerId) => {
      dispatchedTurnId = triggerId!;
      const entry = target.idempotentAsyncTurns?.get(triggerId!);
      if (entry) {
        idempotency.recordTurnInputCommit({
          ownerLarkAppId: APP, key: entry.key, sessionId: target.session.sessionId,
          triggerId: triggerId!, ownerBootId: 'synthetic-import-boot', workerGeneration: 1, observedAt: Date.now(),
        });
      }
      return true;
    });
    const sameOwnerBody = request();
    expect(await post(sameOwnerBody)).toMatchObject({ status: 200, body: { delivered: true } });
    expect(replyCardSpy).toHaveBeenCalledTimes(1);

    const cap = 'ef'.repeat(32);
    ds.managedTurnOrigin = { capability: cap, turnId: dispatchedTurnId, dispatchAttempt: 1 };
    const cliPath = `/api/sessions/${ds.session.sessionId}/project-workstream`;
    const cliPost = async (payload: Record<string, unknown>) => {
      const r = await fetch(`http://127.0.0.1:${handle.port}${cliPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          originCapability: cap,
          originTurnId: dispatchedTurnId,
          originDispatchAttempt: 1,
        }),
      });
      return { status: r.status, body: await r.json() as Record<string, any> };
    };

    expect(await cliPost({
      action: 'inspect',
      sourceSessionId: source.sessionId,
      sourceLarkAppId: WORKER,
      rootMessageId: source.rootMessageId,
    })).toMatchObject({ status: 200, body: { ok: true } });

    // Notice turn must NEVER be allowed to --claim-owner even when session is active.
    expect(await cliPost({
      action: 'attach',
      sourceSessionId: source.sessionId,
      sourceLarkAppId: WORKER,
      rootMessageId: source.rootMessageId,
      title: '同主人自动登记',
      claimOwner: true,
    })).toMatchObject({ status: 403, body: { ok: false, error: 'actor_nonhuman' } });

    expect(await cliPost({
      action: 'attach',
      sourceSessionId: source.sessionId,
      sourceLarkAppId: WORKER,
      rootMessageId: source.rootMessageId,
      title: '同主人自动登记',
    })).toMatchObject({ status: 200, body: { ok: true, result: { registered: true } } });
    expect(readProjectGroup(dataDir, CHAT)?.workstreams).toContainEqual(
      expect.objectContaining({ dispatchRoot: 'om_source', title: '同主人自动登记' }),
    );
    expect(transport.updateCard).toHaveBeenCalled();
    expect(updateCardSpy).toHaveBeenCalledWith(APP, 'om_import_topic_card', expect.stringContaining('已登记项目看板'));

    // 2. Ownerless session: host posts orange topic card with 确认登记 button; coordinator notice attach gets 403 source_owner_unknown.
    source = {
      ...source,
      sessionId: 'source-ownerless',
      rootMessageId: 'om_ownerless_topic',
      ownerKey: undefined,
      routeRevision: 2,
    };
    send.mockImplementationOnce((target, _content, triggerId) => {
      dispatchedTurnId = triggerId!;
      const entry = target.idempotentAsyncTurns?.get(triggerId!);
      if (entry) {
        idempotency.recordTurnInputCommit({
          ownerLarkAppId: APP, key: entry.key, sessionId: target.session.sessionId,
          triggerId: triggerId!, ownerBootId: 'synthetic-import-boot', workerGeneration: 1, observedAt: Date.now(),
        });
      }
      return true;
    });
    replyCardSpy.mockResolvedValueOnce('om_ownerless_card');
    const ownerlessBody = request();
    expect(await post(ownerlessBody)).toMatchObject({ status: 200, body: { delivered: true } });
    const postedOwnerlessCardJson = String(replyCardSpy.mock.calls.at(-1)?.[2] ?? '');
    expect(postedOwnerlessCardJson).toContain('source_owner_unknown');
    expect(postedOwnerlessCardJson).toContain('project_import_confirm');
    expect(postedOwnerlessCardJson).toContain('确认登记');

    ds.managedTurnOrigin = { capability: cap, turnId: dispatchedTurnId, dispatchAttempt: 2 };
    const attachOwnerless = await fetch(`http://127.0.0.1:${handle.port}${cliPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'attach',
        sourceSessionId: 'source-ownerless',
        sourceLarkAppId: WORKER,
        rootMessageId: 'om_ownerless_topic',
        title: '无主会话测试',
        originCapability: cap,
        originTurnId: dispatchedTurnId,
        originDispatchAttempt: 2,
      }),
    });
    expect(attachOwnerless.status).toBe(403);
    expect(await attachOwnerless.json()).toMatchObject({
      ok: false,
      error: 'source_owner_unknown',
      hint: expect.stringContaining('确认登记'),
    });
  });

  it('confines a notice turn to the notified source and to registration actions only', async () => {
    const bot = registry.registerBot({ larkAppId: APP, larkAppSecret: 'synthetic-only', cliId: 'codex', allowedUsers: ['ou_owner'] });
    bot.resolvedAllowedUsers = ['ou_owner'];
    ds.session.ownerOpenId = 'ou_owner';
    ds.session.ownerUnionId = 'on_owner';
    // Another same-owner thread in the same project group: a valid attach target
    // for a human turn, but not the session this notice is about.
    const other = { ...source, sessionId: 'source-other', rootMessageId: 'om_other_topic' };
    const sourceById = async (_app: string, id: string) => structuredClone(id === other.sessionId ? other : source);
    sourceLookup.mockImplementation(sourceById);
    const coordinator = new ProjectCoordinator({
      sendCard: vi.fn(async () => 'om_pinned_project_card'), updateCard: vi.fn(async () => {}),
      pinMessage: vi.fn(async () => true), unpinMessage: vi.fn(async () => true),
      resolveThreadId: vi.fn(async () => null), isMessageWithdrawn: () => false,
      isMessageUpdateExpired: () => false, brand: () => 'feishu',
    });
    const service = createProjectWorkstreamAttachments({
      dataDir, getSource: sourceById,
      getProject: chatId => readProjectGroup(dataDir, chatId),
      getMode: chatId => ({ chatId, mode: 'project', coordinatorAppId: APP, workerAppIds: [WORKER], importedSessionPolicy: 'notify' }),
      projectRun: (ctx, action, beforeApply) => coordinator.run(ctx, action, beforeApply),
      reportSecret: () => 'synthetic-report-secret', lookupRoot: async () => true,
    });
    for (const method of ['inspect', 'attach', 'rename', 'update', 'reconcile'] as const) {
      vi.spyOn(sources.projectWorkstreamAttachments, method).mockImplementation(((actor: any, req: any) => (service as any)[method](actor, req)) as any);
    }

    let turnId = '';
    send.mockImplementationOnce((target, _content, triggerId) => {
      turnId = triggerId!;
      const entry = target.idempotentAsyncTurns?.get(triggerId!);
      if (entry) idempotency.recordTurnInputCommit({
        ownerLarkAppId: APP, key: entry.key, sessionId: target.session.sessionId,
        triggerId: triggerId!, ownerBootId: 'synthetic-import-boot', workerGeneration: 1, observedAt: Date.now(),
      });
      return true;
    });
    expect(await post()).toMatchObject({ status: 200, body: { delivered: true } });
    expect(replyCardSpy).toHaveBeenCalledTimes(1);
    const cap = 'ef'.repeat(32);
    ds.managedTurnOrigin = { capability: cap, turnId, dispatchAttempt: 1 };
    const cliPost = async (payload: Record<string, unknown>) => {
      const r = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${ds.session.sessionId}/project-workstream`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, originCapability: cap, originTurnId: turnId, originDispatchAttempt: 1 }),
      });
      return { status: r.status, body: await r.json() as Record<string, any> };
    };
    const notified = { sourceSessionId: source.sessionId, sourceLarkAppId: WORKER, rootMessageId: source.rootMessageId };
    const otherIds = { sourceSessionId: other.sessionId, sourceLarkAppId: WORKER, rootMessageId: other.rootMessageId };
    for (const payload of [
      // Only the notified (root, app, session) is reachable from this turn.
      { action: 'inspect', ...otherIds },
      { action: 'attach', ...otherIds, title: '旁路登记' },
      { action: 'confirm', ...otherIds },
      { action: 'rename', rootMessageId: other.rootMessageId, title: '旁路改名' },
      // Even naming the notified source, the turn cannot change policy, status or grants.
      { action: 'notifications', mode: 'ignore', ...notified },
      { action: 'update', status: 'in_progress', content: '通知回合改状态', ...notified },
      { action: 'status', ...notified },
      { action: 'grant', ...notified },
    ]) {
      expect(await cliPost(payload), JSON.stringify(payload)).toMatchObject({ status: 403, body: { ok: false, error: 'actor_nonhuman' } });
    }
    expect(readGroupCollaborationMode(dataDir, CHAT)?.importedSessionPolicy).toBe('notify');
    expect(replyCardSpy).toHaveBeenCalledTimes(1);
    expect(readProjectGroup(dataDir, CHAT)?.workstreams).toEqual([]);

    // Positive control: the notified same-owner source does register from this turn.
    expect(await cliPost({ action: 'attach', ...notified, title: '同主人自动登记' }))
      .toMatchObject({ status: 200, body: { ok: true, result: { registered: true } } });
    expect(readProjectGroup(dataDir, CHAT)?.workstreams.map(item => item.dispatchRoot)).toEqual([source.rootMessageId]);
  });

  it('never sets the coordinator owner from an import: an ownerless coordinator stays ownerless and cannot register', async () => {
    const bot = registry.registerBot({ larkAppId: APP, larkAppSecret: 'synthetic-only', cliId: 'codex', allowedUsers: ['ou_owner'] });
    bot.resolvedAllowedUsers = ['ou_owner'];
    // The source owner can operate the coordinator bot and resolves on it, so the
    // removed inference would have made them the coordinator owner.
    vi.spyOn(client, 'resolveTargetAppOpenId').mockResolvedValue({ status: 'resolved', openId: 'ou_owner' });
    const updateSession = vi.mocked(sessionStore.updateSession);
    let turnId = '';
    send.mockImplementationOnce((target, _content, triggerId) => {
      turnId = triggerId!;
      const entry = target.idempotentAsyncTurns?.get(triggerId!);
      if (entry) idempotency.recordTurnInputCommit({
        ownerLarkAppId: APP, key: entry.key, sessionId: target.session.sessionId,
        triggerId: triggerId!, ownerBootId: 'synthetic-import-boot', workerGeneration: 1, observedAt: Date.now(),
      });
      return true;
    });
    expect(await post()).toMatchObject({ status: 200, body: { delivered: true } });
    expect(ds.session.ownerOpenId).toBeUndefined();
    expect(ds.session.ownerUnionId).toBeUndefined();
    expect(updateSession).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: ds.session.sessionId, ownerUnionId: 'on_owner' }));
    const cap = 'ab'.repeat(32);
    ds.managedTurnOrigin = { capability: cap, turnId, dispatchAttempt: 1 };
    const r = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${ds.session.sessionId}/project-workstream`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'attach', sourceSessionId: source.sessionId, sourceLarkAppId: WORKER, rootMessageId: source.rootMessageId,
        title: '无主主控不应登记', originCapability: cap, originTurnId: turnId, originDispatchAttempt: 1,
      }),
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ ok: false, error: 'project_coordinator_owner_required' });
  });

  it('uninitialized opted-in group: host posts only a waiting card (no coordinator session, turn or owner), then a human init lets the same notice reach the human coordinator', async () => {
    const bot = registry.registerBot({
      larkAppId: APP, larkAppSecret: 'synthetic-only', cliId: 'codex', allowedUsers: ['ou_owner'], defaultWorkingDir: '/tmp',
    });
    bot.resolvedAllowedUsers = ['ou_owner'];
    registry.registerBot({
      larkAppId: WORKER, larkAppSecret: 'synthetic-worker', cliId: 'claude-code', name: 'WorkerBot', allowedUsers: ['ou_owner'],
    });
    rmSync(join(dataDir, 'project-groups.json'), { force: true });
    expect(readProjectGroup(dataDir, CHAT)).toBeUndefined();
    const createSession = vi.spyOn(sessionStore, 'createSession');
    source = {
      ...source,
      sessionId: 'source-uninit-1',
      rootMessageId: 'om_uninit_topic',
      routeRevision: 3,
      title: '新会话',
      recentSummary: '排查插件领域宿主类加载器隔离异常并补齐回归单测覆盖',
      botName: 'WorkerBot',
      ownerKey: 'union:on_owner',
    };
    const snapshot = projectImportSnapshotFromSource(source)!;
    const operationId = projectImportOperationId(snapshot);
    const id = createHash('sha256').update(operationId).digest('hex');
    const notification = { id, operationId, projectGeneration: '__uninitialized__', coordinatorAppId: APP, snapshot };

    // Off by default: the Dashboard default writes `ignore` and an uninitialized group follows it.
    await writeGroupCollaborationMode(dataDir, {
      chatId: CHAT, mode: 'project', coordinatorAppId: APP, workerAppIds: [WORKER], importedSessionPolicy: 'ignore',
    });
    expect(await hostPost(PROJECT_IMPORT_AWAITING_PROJECT_ROUTE, { notification }))
      .toMatchObject({ status: 409, body: { ok: false, error: 'policy_disabled' } });
    expect(replyCardSpy).not.toHaveBeenCalled();

    await writeGroupCollaborationMode(dataDir, {
      chatId: CHAT, mode: 'project', coordinatorAppId: APP, workerAppIds: [WORKER], importedSessionPolicy: 'notify',
    });
    replyCardSpy.mockResolvedValueOnce('om_uninit_topic_card');
    expect(await hostPost(PROJECT_IMPORT_AWAITING_PROJECT_ROUTE, { notification }))
      .toMatchObject({ status: 200, body: { ok: true, cardPosted: true, reason: 'project_uninitialized' } });
    expect(replyCardSpy).toHaveBeenCalledTimes(1);
    expect(replyCardSpy).toHaveBeenCalledWith(APP, 'om_uninit_topic', expect.any(String), 'interactive', true);
    const waitingCard = String(replyCardSpy.mock.calls[0]?.[2] ?? '');
    expect(waitingCard).toContain('等待项目初始化');
    expect(waitingCard).not.toContain('project_import_confirm');
    // An outbox retry keeps the same card instead of posting another one.
    expect(await hostPost(PROJECT_IMPORT_AWAITING_PROJECT_ROUTE, { notification }))
      .toMatchObject({ status: 200, body: { ok: true, cardPosted: false } });
    expect(replyCardSpy).toHaveBeenCalledTimes(1);

    // An import never mints a coordinator: the old bootstrap request is inert and
    // a turn delivery is refused before dispatch while no project exists.
    expect(await hostPost(PROJECT_IMPORT_COORDINATORS_ROUTE, {
      chatId: CHAT, coordinatorLarkAppId: APP, ensureUninitializedCoordinator: true,
    })).toMatchObject({ status: 200, body: { ok: true, coordinators: [] } });
    const target = { sessionId: ds.session.sessionId, larkAppId: APP, chatId: CHAT, scope: 'chat' };
    const deliverBody = {
      notification, target,
      idempotencyKey: `project-import:${id}:${createHash('sha256').update(target.sessionId).digest('hex').slice(0, 24)}`,
    };
    expect(await post(deliverBody as any)).toMatchObject({ status: 409, body: { ok: false, error: 'policy_disabled', preDispatch: true } });
    expect(createSession).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
    expect(ds.session.ownerOpenId).toBeUndefined();
    expect(ds.session.ownerUnionId).toBeUndefined();

    // A human talks to the coordinator; that session carries the human's owner
    // identity and initializes the project.
    ds.session.ownerOpenId = 'ou_owner';
    ds.session.ownerUnionId = 'on_owner';
    const transport: ProjectCoordinatorTransport = {
      sendCard: vi.fn(async () => 'om_pinned_after_init'),
      updateCard: vi.fn(async () => {}),
      pinMessage: vi.fn(async () => true),
      unpinMessage: vi.fn(async () => true),
      resolveThreadId: vi.fn(async () => null),
      isMessageWithdrawn: () => false,
      isMessageUpdateExpired: () => false,
      brand: () => 'feishu',
    };
    const coordinator = new ProjectCoordinator(transport);
    const projectRuntimeModule = await import('../src/services/project-coordinator-runtime.js');
    vi.spyOn(projectRuntimeModule.projectCoordinator, 'run').mockImplementation((ctx, action, beforeApply) =>
      coordinator.run(ctx, action, beforeApply));
    const service = createProjectWorkstreamAttachments({
      dataDir,
      getSource: async () => structuredClone(source),
      getProject: chatId => readProjectGroup(dataDir, chatId),
      getMode: chatId => ({ chatId, mode: 'project', coordinatorAppId: APP, workerAppIds: [WORKER], importedSessionPolicy: 'notify' }),
      projectRun: (ctx, action, beforeApply) => coordinator.run(ctx, action, beforeApply),
      reportSecret: () => 'synthetic-report-secret',
      lookupRoot: async () => true,
    });
    vi.spyOn(sources.projectWorkstreamAttachments, 'inspect').mockImplementation((actor, req) => service.inspect(actor, req));
    vi.spyOn(sources.projectWorkstreamAttachments, 'attach').mockImplementation((actor, req) => service.attach(actor, req));
    vi.spyOn(sources.projectWorkstreamAttachments, 'rename').mockImplementation((actor, req) => service.rename(actor, req));

    const humanCap = 'cd'.repeat(32);
    ds.managedTurnOrigin = {
      capability: humanCap, turnId: 'om_human_init', dispatchAttempt: 1,
      trustedCaller: { requestLarkAppId: APP, requestUserOpenId: 'ou_owner', requestUserUnionId: 'on_owner', senderType: 'user' },
    };
    const initRes = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${ds.session.sessionId}/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'init', title: '插件领域专项', goal: '收敛宿主与插件类加载器边界问题',
        originCapability: humanCap, originTurnId: 'om_human_init', originDispatchAttempt: 1,
      }),
    });
    expect(initRes.status).toBe(200);
    expect(readProjectGroup(dataDir, CHAT)?.coordinatorSessionId).toBe(ds.session.sessionId);
    // The waiting card turns into a same-owner confirm card in place.
    expect(updateCardSpy).toHaveBeenCalledWith(APP, 'om_uninit_topic_card', expect.stringContaining('项目会话迁入 · 待确认登记'));

    // The pending notice (still carrying the placeholder generation) now reaches
    // the human coordinator; its silent turn inspects, attaches and renames.
    let dispatchedTurnId = '';
    let deliveredPrompt = '';
    send.mockImplementationOnce((target, content, triggerId) => {
      dispatchedTurnId = triggerId!;
      deliveredPrompt = JSON.stringify(content);
      const entry = target.idempotentAsyncTurns?.get(triggerId!);
      if (entry) idempotency.recordTurnInputCommit({
        ownerLarkAppId: APP, key: entry.key, sessionId: target.session.sessionId,
        triggerId: triggerId!, ownerBootId: 'synthetic-import-boot', workerGeneration: 1, observedAt: Date.now(),
      });
      return true;
    });
    expect(await post(deliverBody as any)).toMatchObject({ status: 200, body: { delivered: true, unknown: false } });
    expect(deliveredPrompt).not.toContain('project init');
    expect(deliveredPrompt).not.toContain(source.recentSummary);
    expect(createSession).not.toHaveBeenCalled();

    const cap = 'ab'.repeat(32);
    ds.managedTurnOrigin = { capability: cap, turnId: dispatchedTurnId, dispatchAttempt: 1 };
    const wsPost = async (payload: Record<string, unknown>) => {
      const r = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${ds.session.sessionId}/project-workstream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, originCapability: cap, originTurnId: dispatchedTurnId, originDispatchAttempt: 1 }),
      });
      return { status: r.status, body: await r.json() as Record<string, any> };
    };

    const inspected = await wsPost({
      action: 'inspect', sourceSessionId: source.sessionId, sourceLarkAppId: WORKER, rootMessageId: source.rootMessageId,
    });
    expect(inspected.status).toBe(200);
    expect(inspected.body.result).toMatchObject({
      source: 'relay',
      recentSummary: '排查插件领域宿主类加载器隔离异常并补齐回归单测覆盖',
      botName: 'WorkerBot',
    });
    expect(Array.from(String(inspected.body.result.suggestedTitle)).length).toBeLessThanOrEqual(24);
    expect(['子任务', '子项目', '新会话']).not.toContain(inspected.body.result.suggestedTitle);

    const attached = await wsPost({
      action: 'attach', sourceSessionId: source.sessionId, sourceLarkAppId: WORKER, rootMessageId: source.rootMessageId,
    });
    expect(attached.status).toBe(200);
    const autoTitle = readProjectGroup(dataDir, CHAT)?.workstreams.find(w => w.dispatchRoot === 'om_uninit_topic')?.title ?? '';
    expect(autoTitle.length).toBeGreaterThan(0);
    expect(Array.from(autoTitle).length).toBeLessThanOrEqual(24);
    expect(autoTitle).toContain('排查插件领域宿主类加载器隔离异常');
    expect(updateCardSpy).toHaveBeenLastCalledWith(APP, 'om_uninit_topic_card', expect.stringContaining(autoTitle));

    const renamed = await wsPost({ action: 'rename', rootMessageId: source.rootMessageId, title: '插件类加载器隔离排障' });
    expect(renamed.status).toBe(200);
    expect(readProjectGroup(dataDir, CHAT)?.workstreams).toContainEqual(
      expect.objectContaining({ dispatchRoot: 'om_uninit_topic', title: '插件类加载器隔离排障' }),
    );
    expect(transport.updateCard).toHaveBeenCalled();
    expect(updateCardSpy).toHaveBeenLastCalledWith(APP, 'om_uninit_topic_card', expect.stringContaining('插件类加载器隔离排障'));
  });
});
