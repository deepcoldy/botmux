import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { loopbackFetch } from '../src/core/loopback-fetch.js';
import * as store from '../src/services/session-store.js';
import * as pool from '../src/core/worker-pool.js';
import { captureWorkspace } from '../src/core/workspace-recycle-path.js';
import { workspaceTarget, WORKSPACE_RECYCLE_PROTOCOL } from '../src/core/workspace-recycle-model.js';
import type { RecycleRequest } from '../src/core/workspace-recycle-journal.js';

let server: IpcServerHandle | undefined;
const roots: string[] = [];
const secret = 'isolated-workspace-recycle-ipc-secret';
const originalDataDir = config.session.dataDir;
afterEach(async () => {
  await server?.close(); server = undefined;
  store.init(); config.session.dataDir = originalDataDir;
  setIpcAuthSecret(null); setLarkAppId(''); pool.setActiveSessionsRegistry(new Map());
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace recycle host IPC', () => {
  it('requires host HMAC, routes exact owner, and completes through the actual endpoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-recycle-ipc-')); roots.push(root);
    const workspacePath = join(root, 'work'); mkdirSync(workspacePath);
    const dataDir = join(root, 'data'); mkdirSync(dataDir);
    config.session.dataDir = dataDir; store.init('fixture-app'); setLarkAppId('fixture-app');
    setIpcAuthSecret(secret); pool.setActiveSessionsRegistry(new Map());
    server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const session = store.createSession('fixture-chat', 'fixture-thread', 'fixture', 'group');
    Object.assign(session, { larkAppId: 'fixture-app', workingDir: workspacePath, backendType: 'pty' });
    store.updateSession(session);
    const workspace = captureWorkspace(workspacePath);
    const target = workspaceTarget(session, workspace)!;
    const request: RecycleRequest = { protocol: WORKSPACE_RECYCLE_PROTOCOL, operationId: 'ipc-op', workspace, target, peers: [{ sessionId: session.sessionId, larkAppId: 'fixture-app' }] };
    const unsigned = await loopbackFetch(`http://127.0.0.1:${server.port}/api/workspace-recycle/prepare`, {
      method: 'POST', body: JSON.stringify({ ...request, originCapability: 'not-a-host-capability' }), headers: { 'Content-Type': 'application/json' },
    });
    expect(unsigned.status).toBe(401);
    const post = (action: string, body: unknown) => fetchDaemonIpc(server!.port, `/api/workspace-recycle/${action}`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
    }, secret);
    const wrongOwner = await post('prepare', { ...request, target: { ...target, larkAppId: 'other' }, peers: [{ sessionId: session.sessionId, larkAppId: 'other' }] });
    expect(wrongOwner.status).toBe(409);
    const prepared = await post('prepare', request);
    expect(prepared.status).toBe(200);
    expect(await prepared.json()).toMatchObject({ ok: true, status: 'prepared' });
    expect((await post('close', request)).status).toBe(409); // root still exists
    rmSync(workspacePath, { recursive: true });
    const result = await post('close', request);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ok: true, status: 'closed', journal: { after: { registered: false } } });
    expect(store.readSessionRowFromDisk(session.sessionId, 'fixture-app', dataDir)?.status).toBe('closed');
  });
});
