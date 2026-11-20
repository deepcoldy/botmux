/**
 * POST /api/sessions/:sessionId/feedback-send-lease — the daemon takes the
 * `botmux send` maintenance lease for an isolated CLI that cannot take it
 * in-process. Pins: the sandbox aperture admits the route only with the URL
 * session's current capability, and a lease is bound to that session.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setIpcAuthSecret, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import { config } from '../src/config.js';
import { beginFeedbackMaintenance, inspectFeedbackMaintenance } from '../src/services/feedback-maintenance.js';

const CAP_A = 'ab12cd34'.repeat(8);
const CAP_B = 'ef56ab78'.repeat(8);
let handle: IpcServerHandle | null = null;
let dataDir: string | null = null;
let prevDataDir: string | null = null;
let child: ChildProcess | null = null;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  child = null;
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  if (prevDataDir !== null) config.session.dataDir = prevDataDir;
  prevDataDir = null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
  vi.restoreAllMocks();
});

function liveSession(sessionId: string, capability: string): any {
  return {
    session: { sessionId, status: 'active', chatId: `oc_${sessionId}`, rootMessageId: `om_root_${sessionId}` },
    worker: { killed: false, connected: true, send: vi.fn() },
    larkAppId: 'cli_app',
    chatId: `oc_${sessionId}`,
    managedTurnOrigin: { capability, turnId: `turn-${sessionId}`, dispatchAttempt: 1 },
  };
}

async function setup(sessions: Record<string, any>): Promise<number> {
  dataDir = mkdtempSync(join(tmpdir(), 'ipc-feedback-send-lease-'));
  prevDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation((id: string) => sessions[id]);
  setIpcAuthSecret('feedback-send-lease-secret');
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  child = spawn('sleep', ['60'], { stdio: 'ignore' });
  await once(child, 'spawn');
  return child.pid!;
}

async function post(sessionId: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${handle!.port}/api/sessions/${encodeURIComponent(sessionId)}/feedback-send-lease`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}
const leases = () => existsSync(join(dataDir!, 'feedback-send-leases')) ? readdirSync(join(dataDir!, 'feedback-send-leases')) : [];

describe('POST /api/sessions/:sessionId/feedback-send-lease', () => {
  it('takes a lease for an isolated sender holding the current capability and blocks freezing with it', async () => {
    const pid = await setup({ 'sess-a': liveSession('sess-a', CAP_A), 'sess-b': liveSession('sess-b', CAP_B) });
    expect((await post('sess-a', { originCapability: CAP_B, action: 'acquire', processId: pid })).status).toBe(403);
    expect((await post('sess-gone', { originCapability: CAP_A, action: 'acquire', processId: pid })).status).toBe(403);
    expect(leases()).toEqual([]);

    const acquired = await post('sess-a', { originCapability: CAP_A, action: 'acquire', processId: pid });
    expect(acquired).toMatchObject({ status: 200, body: { ok: true } });
    expect(leases()).toEqual([acquired.body.lease]);
    expect(JSON.parse(readFileSync(join(dataDir!, 'feedback-send-leases', acquired.body.lease), 'utf8'))).toMatchObject({ processId: pid, sessionId: 'sess-a' });
    await beginFeedbackMaintenance(dataDir!, 'route');
    expect((await inspectFeedbackMaintenance(dataDir!, 'route')).blockers).toContain(`send_in_progress:${pid}`);
    expect(await post('sess-a', { originCapability: CAP_A, action: 'acquire', processId: pid }))
      .toEqual({ status: 409, body: { ok: false, error: 'feedback_storage_maintenance' } });
  });

  it('releases only through the owning session and lease-scoped credential', async () => {
    const pid = await setup({ 'sess-a': liveSession('sess-a', CAP_A), 'sess-b': liveSession('sess-b', CAP_B) });
    const { body: { lease, releaseToken } } = await post('sess-a', { originCapability: CAP_A, action: 'acquire', processId: pid });
    expect((await post('sess-b', { originCapability: CAP_B, action: 'release', processId: pid, lease, releaseToken })).status).toBe(409);
    const wrongToken = `${releaseToken.slice(0, -1)}${releaseToken.endsWith('A') ? 'B' : 'A'}`;
    expect((await post('sess-a', { originCapability: CAP_B, action: 'release', processId: pid, lease, releaseToken: wrongToken })).status).toBe(409);
    expect(leases()).toEqual([lease]);
    // A stale or absent origin capability does not invalidate the independent
    // lease credential; a wrong session or token still cannot release it.
    expect(await post('sess-a', { action: 'release', processId: pid, lease, releaseToken })).toEqual({ status: 200, body: { ok: true } });
    expect(leases()).toEqual([]);
  });

  it('keeps managed meeting sends working in a receiver session', async () => {
    const receiver = liveSession('sess-receiver', CAP_A);
    receiver.session.vcMeetingReceiver = true;
    const pid = await setup({ 'sess-receiver': receiver });
    const acquired = await post('sess-receiver', { originCapability: CAP_A, action: 'acquire', processId: pid });
    expect(acquired).toMatchObject({ status: 200, body: { ok: true } });
    expect(await post('sess-receiver', {
      originCapability: CAP_A, action: 'release', processId: pid, lease: acquired.body.lease, releaseToken: acquired.body.releaseToken,
    })).toEqual({ status: 200, body: { ok: true } });
  });

  it('releases after turn rotation, session deactivation and a daemon restart', async () => {
    const sessions: Record<string, any> = {
      'sess-a': liveSession('sess-a', CAP_A),
      'sess-b': liveSession('sess-b', CAP_B),
    };
    const pid = await setup(sessions);
    const rotated = await post('sess-a', { originCapability: CAP_A, action: 'acquire', processId: pid });
    sessions['sess-a'] = liveSession('sess-a', CAP_B);
    expect(await post('sess-a', {
      originCapability: CAP_A, action: 'release', processId: pid,
      lease: rotated.body.lease, releaseToken: rotated.body.releaseToken,
    })).toEqual({ status: 200, body: { ok: true } });

    const inactive = await post('sess-a', { originCapability: CAP_B, action: 'acquire', processId: pid });
    await handle!.close();
    handle = null;
    delete sessions['sess-a'];
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const token = inactive.body.releaseToken as string;
    const wrongToken = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect((await post('sess-a', {
      originCapability: CAP_B, action: 'release', processId: pid,
      lease: inactive.body.lease, releaseToken: wrongToken,
    })).status).toBe(409);
    expect(leases()).toEqual([inactive.body.lease]);
    expect(await post('sess-a', {
      originCapability: CAP_B, action: 'release', processId: pid,
      lease: inactive.body.lease, releaseToken: token,
    })).toEqual({ status: 200, body: { ok: true } });
    expect(leases()).toEqual([]);
  });
});
