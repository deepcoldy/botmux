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
import { writeGroupCollaborationMode } from '../src/services/group-collaboration-mode-store.js';
import { mutateProjectGroup, readProjectGroup } from '../src/services/project-group-store.js';
import { projectImportOperationId } from '../src/services/project-import-notifications.js';
import { projectImportSnapshotFromSource } from '../src/services/project-import-runtime.js';
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

  it('delivers uninitialized project group import notice (even when importedSessionPolicy=ignore on disk), posts 项目未初始化 card, and lets coordinator run init -> inspect -> attach (auto-title <=24) -> rename in the same silent notice turn', async () => {
    const bot = registry.registerBot({
      larkAppId: APP, larkAppSecret: 'synthetic-only', cliId: 'codex',
      allowedUsers: ['ou_owner'], defaultWorkingDir: '/tmp',
    });
    bot.resolvedAllowedUsers = ['ou_owner'];
    registry.registerBot({
      larkAppId: WORKER, larkAppSecret: 'synthetic-worker', cliId: 'claude-code', name: 'WorkerBot',
      allowedUsers: ['ou_owner'],
    });
    vi.spyOn(client, 'resolveTargetAppOpenId').mockResolvedValue({ status: 'resolved', openId: 'ou_owner' });

    // Simulate an uninitialized project group (`project-groups.json` has NO record for CHAT,
    // and `group-collaboration-modes.json` has `importedSessionPolicy: 'ignore'` from Dashboard's default).
    await mutateProjectGroup(dataDir, CHAT, () => undefined as any);
    rmSync(join(dataDir, 'project-groups.json'), { force: true });
    await writeGroupCollaborationMode(dataDir, {
      chatId: CHAT, mode: 'project', coordinatorAppId: APP, workerAppIds: [WORKER], importedSessionPolicy: 'ignore',
    });

    // Simulate no active coordinator session yet; `/api/project-workstream/coordinators` with
    // `ensureUninitializedCoordinator: true` must bootstrap a dormant chat-scope session.
    const activeMap = new Map<string, any>();
    vi.mocked(pool.getActiveSessionsRegistry).mockReturnValue(activeMap);
    vi.mocked(pool.findActiveBySessionId).mockImplementation(id => {
      for (const entry of activeMap.values()) {
        if (entry.session.sessionId === id) return entry;
      }
      return undefined;
    });
    vi.spyOn(sessionStore, 'createSession').mockImplementation((chatId, rootMessageId, title, chatType, scope) => ({
      sessionId: 'bootstrapped-coord',
      chatId,
      rootMessageId,
      title,
      chatType,
      scope,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    } as any));

    const coordPath = '/api/project-workstream/coordinators';
    const coordHeaders = new Headers({ 'content-type': 'application/json' });
    const coordRes = await fetch(`http://127.0.0.1:${handle.port}${coordPath}`, {
      method: 'POST',
      body: JSON.stringify({ chatId: CHAT, coordinatorLarkAppId: APP, ensureUninitializedCoordinator: true }),
      headers: daemonIpcAuthHeaders({
        secret: 'synthetic-import-secret', port: handle.port, method: 'POST', path: coordPath, headers: coordHeaders,
      }),
    });
    expect(coordRes.status).toBe(200);
    const coordJson = await coordRes.json() as { ok: boolean; coordinators: Array<{ sessionId: string; scope: string }> };
    expect(coordJson).toMatchObject({
      ok: true,
      coordinators: [{ sessionId: 'bootstrapped-coord', scope: 'chat' }],
    });
    const bootstrappedDs = [...activeMap.values()][0]!;
    bootstrappedDs.worker = { killed: false, send: vi.fn() };
    bootstrappedDs.workerGeneration = 1;
    bootstrappedDs.hasHistory = true;

    // Source has a generic title ('新会话') + a concrete recentSummary so we also verify
    // `inspect` summary extraction and `attach` <=24-char concrete auto-title fallback.
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

    let dispatchedTurnId = '';
    let deliveredPrompt = '';
    send.mockImplementationOnce((target, content, triggerId) => {
      dispatchedTurnId = triggerId!;
      deliveredPrompt = JSON.stringify(content);
      const entry = target.idempotentAsyncTurns?.get(triggerId!);
      if (entry) {
        idempotency.recordTurnInputCommit({
          ownerLarkAppId: APP, key: entry.key, sessionId: target.session.sessionId,
          triggerId: triggerId!, ownerBootId: 'synthetic-import-boot', workerGeneration: 1, observedAt: Date.now(),
        });
      }
      return true;
    });
    replyCardSpy.mockResolvedValueOnce('om_uninit_topic_card');

    const snapshot = projectImportSnapshotFromSource(source)!;
    const operationId = projectImportOperationId(snapshot);
    const id = createHash('sha256').update(operationId).digest('hex');
    const target = { sessionId: 'bootstrapped-coord', larkAppId: APP, chatId: CHAT, scope: 'chat' };
    const deliverBody = {
      notification: { id, operationId, projectGeneration: '__uninitialized__', coordinatorAppId: APP, snapshot },
      target,
      idempotencyKey: `project-import:${id}:${createHash('sha256').update(target.sessionId).digest('hex').slice(0, 24)}`,
    };
    expect(await post(deliverBody)).toMatchObject({ status: 200, body: { delivered: true, unknown: false } });
    expect(deliveredPrompt).toContain('本群尚未初始化项目');
    expect(deliveredPrompt).toContain('project_not_found');
    expect(bootstrappedDs.session.ownerUnionId).toBe('on_owner');

    // Visible topic migration card is published immediately with "项目未初始化，已通知主控".
    expect(replyCardSpy).toHaveBeenCalledTimes(1);
    const uninitCardJson = String(replyCardSpy.mock.calls[0]?.[2] ?? '');
    expect(uninitCardJson).toContain('项目未初始化，已通知主控');

    // Wire real ProjectCoordinator + ProjectWorkstreamAttachments to verify the full silent-turn flow:
    // `project init` -> `inspect` -> `attach` (omitting --title!) -> `rename`.
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
      getMode: chatId => ({ chatId, mode: 'project', coordinatorAppId: APP, workerAppIds: [WORKER], importedSessionPolicy: 'ignore' }),
      projectRun: (ctx, action, beforeApply) => coordinator.run(ctx, action, beforeApply),
      reportSecret: () => 'synthetic-report-secret',
      lookupRoot: async () => true,
    });
    vi.spyOn(sources.projectWorkstreamAttachments, 'inspect').mockImplementation((actor, req) => service.inspect(actor, req));
    vi.spyOn(sources.projectWorkstreamAttachments, 'attach').mockImplementation((actor, req) => service.attach(actor, req));
    vi.spyOn(sources.projectWorkstreamAttachments, 'rename').mockImplementation((actor, req) => service.rename(actor, req));

    const cap = 'ab'.repeat(32);
    bootstrappedDs.managedTurnOrigin = { capability: cap, turnId: dispatchedTurnId, dispatchAttempt: 1 };

    // Step 1: Coordinator runs `botmux project init` inside the silent import notice turn.
    const initRes = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/bootstrapped-coord/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'init',
        title: '插件领域专项',
        goal: '收敛宿主与插件类加载器边界问题',
        originCapability: cap,
        originTurnId: dispatchedTurnId,
        originDispatchAttempt: 1,
      }),
    });
    expect(initRes.status).toBe(200);
    expect(updateCardSpy).toHaveBeenCalledWith(APP, 'om_uninit_topic_card', expect.stringContaining('项目会话迁入 · 待确认登记'));

    // Step 2: Coordinator runs `inspect` -> `attach` (WITHOUT `--title`) -> `rename` in the SAME silent notice turn!
    const wsPath = '/api/sessions/bootstrapped-coord/project-workstream';
    const wsPost = async (payload: Record<string, unknown>) => {
      const r = await fetch(`http://127.0.0.1:${handle.port}${wsPath}`, {
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

    const inspected = await wsPost({
      action: 'inspect',
      sourceSessionId: source.sessionId,
      sourceLarkAppId: WORKER,
      rootMessageId: source.rootMessageId,
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
      action: 'attach',
      sourceSessionId: source.sessionId,
      sourceLarkAppId: WORKER,
      rootMessageId: source.rootMessageId,
    });
    expect(attached.status).toBe(200);
    const autoTitle = readProjectGroup(dataDir, CHAT)?.workstreams.find(w => w.dispatchRoot === 'om_uninit_topic')?.title ?? '';
    expect(autoTitle.length).toBeGreaterThan(0);
    expect(Array.from(autoTitle).length).toBeLessThanOrEqual(24);
    expect(autoTitle).toContain('排查插件领域宿主类加载器隔离异常');
    expect(updateCardSpy).toHaveBeenLastCalledWith(APP, 'om_uninit_topic_card', expect.stringContaining(autoTitle));

    const renamed = await wsPost({
      action: 'rename',
      rootMessageId: source.rootMessageId,
      title: '插件类加载器隔离排障',
    });
    expect(renamed.status).toBe(200);
    expect(readProjectGroup(dataDir, CHAT)?.workstreams).toContainEqual(
      expect.objectContaining({ dispatchRoot: 'om_uninit_topic', title: '插件类加载器隔离排障' }),
    );
    expect(transport.updateCard).toHaveBeenCalled();
    expect(updateCardSpy).toHaveBeenLastCalledWith(APP, 'om_uninit_topic_card', expect.stringContaining('插件类加载器隔离排障'));
  });
});
