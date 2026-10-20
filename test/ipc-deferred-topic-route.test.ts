/**
 * POST /api/sessions/:sessionId/deferred-topic — the daemon-side first-message
 * claim for a silent fresh-topic schedule run whose CLI cannot write the host
 * binding sidecar (bwrap / seatbelt / read isolation).
 *
 * Pins: the sandbox aperture admits the route only with the URL session's
 * current capability; the claim turn comes from that capability, not the
 * body; and the binding is written only for a root the provider confirms as a
 * top-level message this bot sent into the session's chat.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as larkClient from '../src/im/lark/client.js';
import { config } from '../src/config.js';
import { readDeferredTopicBinding } from '../src/core/deferred-topic-binding.js';

const SECRET = 'deferred-topic-narrow-secret';
const CAP_A = 'ab12cd34'.repeat(8);
const CAP_B = 'ef56ab78'.repeat(8);
const TURN = 'schedule:task-1:run-1';

let handle: IpcServerHandle | null = null;
let dataDir: string | null = null;
let prevDataDir: string | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  if (prevDataDir !== null) config.session.dataDir = prevDataDir;
  prevDataDir = null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
  vi.restoreAllMocks();
});

function liveSession(sessionId: string, capability: string, turnId: string | undefined): any {
  return {
    session: {
      sessionId,
      status: 'active',
      scope: 'chat',
      chatId: `oc_${sessionId}`,
      deferredScheduleRun: {
        taskId: 'task-1',
        turnId: TURN,
        routingAnchor: 'schedule-run:task-1:run-1',
        createdAt: '2026-10-20T00:00:00.000Z',
      },
    },
    worker: { killed: false, connected: true, send: vi.fn() },
    larkAppId: 'cli_app',
    chatId: `oc_${sessionId}`,
    chatType: 'group',
    managedTurnOrigin: { capability, ...(turnId ? { turnId, dispatchAttempt: 1 } : {}) },
  };
}

function messageDetail(chatId: string, senderId = 'cli_app') {
  return { items: [{
    message_id: 'om_root',
    chat_id: chatId,
    create_time: String(Date.parse('2026-10-20T00:00:30.000Z')),
    sender: { id: senderId, id_type: 'app_id', sender_type: 'app' },
  }] };
}

async function setup(sessions: Record<string, any>): Promise<ReturnType<typeof vi.spyOn>> {
  dataDir = mkdtempSync(join(tmpdir(), 'ipc-deferred-topic-'));
  prevDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation((id: string) => sessions[id]);
  const detail = vi.spyOn(larkClient, 'getMessageDetail');
  setIpcAuthSecret(SECRET);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  return detail;
}

async function post(sessionId: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${handle!.port}/api/sessions/${encodeURIComponent(sessionId)}/deferred-topic`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

describe('POST /api/sessions/:sessionId/deferred-topic', () => {
  it('claims and commits a verified root with the session capability', async () => {
    const detail = await setup({ 'sess-a': liveSession('sess-a', CAP_A, TURN) });
    detail.mockResolvedValue(messageDetail('oc_sess-a'));

    const claim = await post('sess-a', { originCapability: CAP_A, action: 'claim' });
    expect(claim).toMatchObject({ status: 200, json: { ok: true, state: 'claimed' } });
    const commit = await post('sess-a', {
      originCapability: CAP_A,
      action: 'commit',
      leaseId: claim.json.leaseId,
      rootMessageId: 'om_root',
    });
    expect(commit).toMatchObject({ status: 200, json: { ok: true, state: 'bound', rootMessageId: 'om_root' } });
    expect(detail).toHaveBeenCalledWith('cli_app', 'om_root', expect.objectContaining({ userCardContent: false }));
    expect(readDeferredTopicBinding(dataDir!, 'sess-a')).toMatchObject({
      sessionId: 'sess-a', turnId: TURN, chatId: 'oc_sess-a', larkAppId: 'cli_app', rootMessageId: 'om_root',
    });
    expect(await post('sess-a', { originCapability: CAP_A, action: 'peek' }))
      .toMatchObject({ status: 200, json: { state: 'bound', rootMessageId: 'om_root' } });
  });

  it('403s without a capability, or with another session\'s capability', async () => {
    await setup({
      'sess-a': liveSession('sess-a', CAP_A, TURN),
      'sess-b': liveSession('sess-b', CAP_B, TURN),
    });
    expect((await post('sess-a', { action: 'claim' })).status).toBe(403);
    const cross = await post('sess-b', { originCapability: CAP_A, action: 'claim' });
    expect(cross.status).toBe(403);
    expect(cross.json).toMatchObject({ ok: false, error: 'origin_unproven' });
  });

  it('ignores a body-supplied turn and refuses when the capability turn is not the run', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'a-later-turn') });
    const res = await post('sess-a', { originCapability: CAP_A, action: 'claim', turnId: TURN, originTurnId: 'a-later-turn' });
    expect(res).toMatchObject({ status: 200, json: { ok: true, state: 'not_claimable', reason: 'turn_mismatch' } });
  });

  it('refuses to bind a root that lives in another chat', async () => {
    const detail = await setup({ 'sess-a': liveSession('sess-a', CAP_A, TURN) });
    detail.mockResolvedValue(messageDetail('oc_elsewhere'));
    const claim = await post('sess-a', { originCapability: CAP_A, action: 'claim' });
    const commit = await post('sess-a', {
      originCapability: CAP_A, action: 'commit', leaseId: claim.json.leaseId, rootMessageId: 'om_root',
    });
    expect(commit).toMatchObject({ status: 409, json: { ok: false, error: 'root_outside_target_chat' } });
    expect(readDeferredTopicBinding(dataDir!, 'sess-a')).toBeUndefined();
  });

  it('400s a malformed request', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, TURN) });
    expect(await post('sess-a', { originCapability: CAP_A, action: 'commit', leaseId: 'x', rootMessageId: 'om_r' }))
      .toMatchObject({ status: 400, json: { error: 'invalid_deferred_topic_request' } });
    expect((await post('sess-a', '{not json')).status).toBe(400);
    const oversized = await post('sess-a', { originCapability: CAP_A, action: 'claim', pad: 'x'.repeat(5000) });
    expect(oversized).toMatchObject({ status: 413, json: { error: 'body_too_large' } });
  });
});
