/**
 * POST /api/sessions/:sessionId/turn-delivery — the daemon-side delivery row
 * for a final answer that an isolated CLI (bwrap relay / macOS read isolation)
 * already sent but cannot index itself, because the shared feedback store is
 * not exposed to the session.
 *
 * Pins: the sandbox aperture admits the route only with the URL session's
 * current capability; every correlation field comes from the live session,
 * never from the body; the row is idempotent per message and cannot be rebound
 * to another turn.
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
import { config } from '../src/config.js';
import {
  getSkillFeedbackStore,
  __testOnly_closeSkillFeedbackStores,
} from '../src/services/skill-feedback-store.js';
import { RELAYED_TURN_DELIVERY_MAX_BYTES } from '../src/core/relayed-turn-delivery.js';

const SECRET = 'turn-delivery-narrow-secret';
const CAP_A = 'ab12cd34'.repeat(8);
const CAP_B = 'ef56ab78'.repeat(8);

let handle: IpcServerHandle | null = null;
let dataDir: string | null = null;
let prevDataDir: string | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  await __testOnly_closeSkillFeedbackStores();
  if (prevDataDir !== null) config.session.dataDir = prevDataDir;
  prevDataDir = null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
  vi.restoreAllMocks();
});

function liveSession(sessionId: string, capability: string, turnId: string | undefined, extra: Record<string, unknown> = {}): any {
  return {
    session: {
      sessionId,
      status: 'active',
      chatId: `oc_${sessionId}`,
      rootMessageId: `om_root_${sessionId}`,
      cliSessionId: `native-${sessionId}`,
      cliId: 'claude-code',
      model: 'opus',
      ...extra,
    },
    worker: { killed: false, connected: true, send: vi.fn() },
    larkAppId: 'cli_app',
    chatId: `oc_${sessionId}`,
    chatType: 'group',
    cliVersion: '9.9.9',
    managedTurnOrigin: { capability, ...(turnId ? { turnId, dispatchAttempt: 2 } : {}) },
  };
}

async function setup(sessions: Record<string, any>): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'ipc-turn-delivery-'));
  prevDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation((id: string) => sessions[id]);
  setIpcAuthSecret(SECRET);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
}

function post(sessionId: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle!.port}/api/sessions/${encodeURIComponent(sessionId)}/turn-delivery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function rowFor(messageId: string) {
  const store = await getSkillFeedbackStore(dataDir!);
  return store.findDeliveryByPlatformMessage('lark', 'cli_app', messageId);
}

describe('POST /api/sessions/:sessionId/turn-delivery', () => {
  it('records the row from the live session, ignoring body-supplied correlation fields', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') });
    const res = await post('sess-a', {
      originCapability: CAP_A,
      messageId: 'om_answer_1',
      content: 'final answer',
      // None of these may be honoured.
      turnId: 'turn-forged',
      sessionId: 'sess-b',
      botAppId: 'cli_other',
      chatId: 'oc_elsewhere',
      policy: { audience: 'everyone' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, duplicate: false });
    expect(await rowFor('om_answer_1')).toMatchObject({
      botAppId: 'cli_app',
      sessionId: 'sess-a',
      turnId: 'turn-a',
      dispatchAttempt: 2,
      nativeSessionId: 'native-sess-a',
      chatId: 'oc_sess-a',
      topicRootId: 'om_root_sess-a',
      correlationDiscriminator: 'om_answer_1',
      cliId: 'claude-code',
      cliVersion: '9.9.9',
      model: 'opus',
      cardMode: 'card',
      status: 'delivered',
      policy: undefined,
      baseCard: undefined,
    });
  });

  it('403s a capability presented against another session and writes nothing', async () => {
    await setup({
      'sess-a': liveSession('sess-a', CAP_A, 'turn-a'),
      'sess-b': liveSession('sess-b', CAP_B, 'turn-b'),
    });
    const res = await post('sess-b', { originCapability: CAP_A, messageId: 'om_x', content: 'x' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'origin_unproven' });
    const missing = await post('sess-gone', { originCapability: CAP_A, messageId: 'om_x', content: 'x' });
    expect(missing.status).toBe(403);
    expect(await rowFor('om_x')).toBeUndefined();
  });

  it('403s once the turn capability has rotated (turn over)', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_B, 'turn-next') });
    const res = await post('sess-a', { originCapability: CAP_A, messageId: 'om_late', content: 'late' });
    expect(res.status).toBe(403);
    expect(await rowFor('om_late')).toBeUndefined();
  });

  it('409s when the live origin carries no turn', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, undefined) });
    const res = await post('sess-a', { originCapability: CAP_A, messageId: 'om_unbound', content: 'x' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'turn_unbound' });
    expect(await rowFor('om_unbound')).toBeUndefined();
  });

  it('404s a closed session', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a', { status: 'closed' }) });
    const res = await post('sess-a', { originCapability: CAP_A, messageId: 'om_closed', content: 'x' });
    expect(res.status).toBe(404);
    expect(await rowFor('om_closed')).toBeUndefined();
  });

  it.each([
    ['non-om message id', { messageId: 'oc_not_a_message', content: 'x' }],
    ['message id with a path separator', { messageId: 'om_a/b', content: 'x' }],
    ['empty content', { messageId: 'om_empty', content: '' }],
    ['non-string content', { messageId: 'om_obj', content: { text: 'x' } }],
  ])('400s %s', async (_label, payload) => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') });
    const res = await post('sess-a', { originCapability: CAP_A, ...payload });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_turn_delivery' });
  });

  it('413s an oversized body before authenticating it', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') });
    const res = await post('sess-a', {
      originCapability: CAP_A,
      messageId: 'om_big',
      content: 'x'.repeat(RELAYED_TURN_DELIVERY_MAX_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(await rowFor('om_big')).toBeUndefined();
  });

  it('is idempotent for the same message and refuses to rebind it to another turn', async () => {
    const sessions: Record<string, any> = { 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') };
    await setup(sessions);
    const first = await post('sess-a', { originCapability: CAP_A, messageId: 'om_once', content: 'answer' });
    expect(first.status).toBe(200);
    const again = await post('sess-a', { originCapability: CAP_A, messageId: 'om_once', content: 'answer' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, duplicate: true });

    sessions['sess-a'] = liveSession('sess-a', CAP_B, 'turn-b');
    const rebind = await post('sess-a', { originCapability: CAP_B, messageId: 'om_once', content: 'answer' });
    expect(rebind.status).toBe(409);
    expect(await rebind.json()).toMatchObject({ ok: false, error: 'message_already_recorded' });
    expect(await rowFor('om_once')).toMatchObject({ turnId: 'turn-a' });
  });
});
