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
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { writeGroupCollaborationMode } from '../src/services/group-collaboration-mode-store.js';
import { mutateProjectGroup } from '../src/services/project-group-store.js';
import { projectImportOperationId } from '../src/services/project-import-notifications.js';
import { projectImportSnapshotFromSource } from '../src/services/project-import-runtime.js';
import { readTurnRegistration } from '../src/core/trigger-registration.js';
import * as idempotency from '../src/services/idempotency-store.js';

const APP = 'cli_import_main', CHAT = 'oc_import_project', WORKER = 'cli_import_worker';
let dataDir: string, handle: IpcServerHandle, ds: any, source: any;
let send: ReturnType<typeof vi.spyOn>, fork: ReturnType<typeof vi.spyOn>;
let sourceLookup: ReturnType<typeof vi.spyOn>;
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
  it('commits metadata once and retries the exact stable key without another model send', async () => {
    const body = request();
    expect(await post(body)).toMatchObject({ status: 200, body: { delivered: true, unknown: false } });
    expect(registration(body)).toMatchObject({ state: 'registered', inputCommitted: { state: 'observed' } });
    expect(await post(body)).toMatchObject({ status: 200, body: { delivered: true } });
    expect(send).toHaveBeenCalledTimes(1);
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
    expect(await post(body)).toMatchObject({ status: 200, body: { delivered: false, unknown: true } });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
