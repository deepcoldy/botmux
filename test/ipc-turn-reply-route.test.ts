/**
 * POST /api/sessions/:sessionId/turn-reply — host-side structured session-turn
 * reply proxy for isolated CLIs (macOS Seatbelt, credential-only Seatbelt,
 * Linux bwrap, CLI-own workspace-write sandboxes) that cannot open the shared
 * `<DATA_DIR>/session-turns/turns.sqlite` database directly.
 */
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __testOnly_resetManagedOriginRuntimeAuthState,
  routeHasNarrowUntrustedAuth,
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import { config } from '../src/config.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { loopbackFetch } from '../src/core/loopback-fetch.js';
import {
  createTurnReplyQuotaTracker,
  postRelayedTurnReplies,
  recordRelayedTurnReply,
  RELAYED_TURN_REPLY_HEADERS,
  RELAYED_TURN_REPLY_MAX_BYTES,
  RELAYED_TURN_REPLY_MAX_IN_FLIGHT_PER_SESSION,
  RELAYED_TURN_REPLY_MAX_ITEMS,
  RELAYED_TURN_REPLY_ROUTE,
  sealRelayedTurnReplyRequest,
  SESSION_TURN_REPLY_RAW_TEXT_CAP,
} from '../src/core/relayed-turn-reply.js';
import {
  cleanupSessionTurns,
  projectLarkTurnInbound,
  readSessionTurns,
  recordSessionTurnInput,
  stageSessionTurnInbound,
  type SessionTurnReply,
} from '../src/services/session-turns.js';

const SECRET = 'turn-reply-narrow-secret';
const CAP_A = 'ab12cd34'.repeat(8);
const CAP_B = 'ef56ab78'.repeat(8);

let handle: IpcServerHandle | null = null;
let dataDir: string | null = null;
let prevDataDir: string | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  __testOnly_resetManagedOriginRuntimeAuthState();
  if (prevDataDir !== null) config.session.dataDir = prevDataDir;
  prevDataDir = null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
  vi.restoreAllMocks();
});

function liveSession(
  sessionId: string,
  capability: string,
  turnId: string | undefined,
  extra: Record<string, unknown> = {},
  dsExtra: Record<string, unknown> = {},
): any {
  return {
    session: {
      sessionId,
      status: 'active',
      chatId: `oc_${sessionId}`,
      rootMessageId: `om_root_${sessionId}`,
      cliSessionId: `native-${sessionId}`,
      cliId: 'claude-code',
      ...extra,
    },
    worker: { killed: false, connected: true, send: vi.fn() },
    larkAppId: 'cli_app',
    chatId: `oc_${sessionId}`,
    chatType: 'group',
    managedTurnOrigin: { capability, ...(turnId ? { turnId, dispatchAttempt: 1 } : {}) },
    ...dsExtra,
  };
}

function stageTurn(sessionId: string, turnId: string, text = 'hello'): void {
  stageSessionTurnInbound(dataDir!, sessionId, turnId, projectLarkTurnInbound({
    messageId: turnId,
    rootId: turnId,
    senderId: 'ou_user',
    senderType: 'user',
    createTime: '0',
    msgType: 'text',
    content: text,
  }, [], turnId, 'User'));
  recordSessionTurnInput({
    dataDir: dataDir!,
    sessionId,
    turnId,
    input: text,
    cliId: 'claude-code',
    at: Date.now() - 1_000,
  });
}

async function setup(sessions: Record<string, any>): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'ipc-turn-reply-'));
  prevDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation((id: string) => sessions[id]);
  setIpcAuthSecret(SECRET);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
}

function capabilityRequest(
  sessionId: string,
  body: unknown,
  opts: { capability: string; turnId?: string; dispatchAttempt?: number },
): { raw: string; headers: Record<string, string> } {
  if (typeof body === 'string') {
    // Oversized-body coverage only needs valid pre-body auth; the daemon rejects
    // Content-Length before inspecting this deliberately non-envelope payload.
    const expectedTurnId = (JSON.parse(body) as { expectedTurnId: string }).expectedTurnId;
    const sealed = sealRelayedTurnReplyRequest({
      key: { kind: 'capability', material: opts.capability },
      sessionId,
      payload: { expectedTurnId, replies: [] },
      dispatchAttempt: opts.dispatchAttempt,
    });
    return { raw: body, headers: { 'content-type': 'application/json', ...sealed.headers } };
  }
  const sealed = sealRelayedTurnReplyRequest({
    key: { kind: 'capability', material: opts.capability },
    sessionId,
    payload: body as { expectedTurnId: string; replies: [] },
    dispatchAttempt: opts.dispatchAttempt,
  });
  return { raw: JSON.stringify(sealed.body), headers: { 'content-type': 'application/json', ...sealed.headers } };
}

function postCapability(
  sessionId: string,
  body: unknown,
  opts: { capability: string; turnId?: string; dispatchAttempt?: number },
): Promise<Response> {
  const request = capabilityRequest(sessionId, body, opts);
  return loopbackFetch(`http://127.0.0.1:${handle!.port}/api/sessions/${encodeURIComponent(sessionId)}/${RELAYED_TURN_REPLY_ROUTE}`, {
    method: 'POST',
    headers: request.headers,
    body: request.raw,
  });
}

function hostRequest(sessionId: string, body: { expectedTurnId: string; replies: SessionTurnReply[] }) {
  return sealRelayedTurnReplyRequest({
    key: { kind: 'host', material: SECRET },
    sessionId,
    payload: body,
    dispatchAttempt: 1,
  });
}

function openStreamingRequest(input: {
  sessionId: string;
  headers?: Record<string, string>;
  body?: string;
}): {
  req: http.ClientRequest;
  body: string;
  response: Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>;
} {
  let resolveResponse!: (value: { status: number; headers: http.IncomingHttpHeaders; body: string }) => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const req = http.request({
    hostname: '127.0.0.1',
    port: handle!.port,
    method: 'POST',
    path: `/api/sessions/${encodeURIComponent(input.sessionId)}/${RELAYED_TURN_REPLY_ROUTE}`,
    headers: {
      'content-type': 'application/json',
      'transfer-encoding': 'chunked',
      ...(input.headers ?? {}),
    },
  }, res => {
    const chunks: Buffer[] = [];
    res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    res.on('end', () => resolveResponse({
      status: res.statusCode ?? 0,
      headers: res.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    }));
    res.on('error', rejectResponse);
  });
  req.on('error', err => {
    // An early 403/413/429 closes the socket before the client finishes streaming.
    void err;
  });
  return { req, body: input.body ?? '', response };
}

function openSealedStream(
  sessionId: string,
  body: { expectedTurnId: string; replies: SessionTurnReply[] },
  opts: { capability: string; dispatchAttempt?: number },
) {
  const request = capabilityRequest(sessionId, body, opts);
  const stream = openStreamingRequest({ sessionId, headers: request.headers, body: request.raw });
  const splitAt = Math.max(1, Math.floor(request.raw.length / 2));
  return {
    stream,
    writePrefix: () => stream.req.write(request.raw.slice(0, splitAt)),
    end: () => stream.req.end(request.raw.slice(splitAt)),
  };
}

describe('POST /api/sessions/:sessionId/turn-reply', () => {
  it('opens narrow untrusted auth ONLY for exact POST /api/sessions/:id/turn-reply', () => {
    expect(routeHasNarrowUntrustedAuth('POST', '/api/sessions/sess-a/turn-reply')).toBe(true);
    expect(routeHasNarrowUntrustedAuth('GET', '/api/sessions/sess-a/turn-reply')).toBe(false);
    expect(routeHasNarrowUntrustedAuth('POST', '/api/sessions/sess-a/turn-reply/extra')).toBe(false);
  });

  it('rejects unauthenticated or wrong-session capability BEFORE reading any body bytes and reveals no existence oracle', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') });
    stageTurn('sess-a', 'turn-a');

    // Never finish writing the request body: pre-body auth MUST respond immediately with 403 + Connection: close.
    for (const [targetSession, cap] of [
      ['sess-a', undefined],
      ['sess-a', CAP_B],
      ['sess-missing', CAP_A],
    ] as const) {
      const request = cap
        ? capabilityRequest(targetSession, { expectedTurnId: 'turn-a', replies: [] }, { capability: cap })
        : { raw: '', headers: {} as Record<string, string> };
      const stream = openStreamingRequest({
        sessionId: targetSession,
        headers: request.headers,
        body: request.raw,
      });
      stream.req.write(request.raw.slice(0, Math.max(1, Math.floor(request.raw.length / 2)))); // intentionally incomplete, never ended
      const res = await stream.response;
      stream.req.destroy();
      expect(res.status).toBe(403);
      expect(res.headers.connection).toBe('close');
      expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'origin_unproven' });
    }
    expect(readSessionTurns(dataDir!, 'sess-a', 0, 50).turns[0]?.replies).toEqual([]);
  });

  it('keeps capability and reply text confidential from a stale listener and rejects tampered replay', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') });
    stageTurn('sess-a', 'turn-a');
    let captured: { headers: http.IncomingHttpHeaders; raw: string } | undefined;
    const rogue = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        captured = { headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') };
        res.writeHead(403, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ ok: false, error: 'origin_unproven' }));
      });
    });
    await new Promise<void>(resolve => rogue.listen(0, '127.0.0.1', resolve));
    const address = rogue.address();
    if (!address || typeof address === 'string') throw new Error('rogue listener has no port');
    try {
      const outcome = await postRelayedTurnReplies({
        sessionId: 'sess-a',
        expectedTurnId: 'turn-a',
        replies: [{ messageId: 'om_real', responseKind: 'final', at: Date.now(), text: 'private reply body' }],
        readClaim: () => ({ capability: CAP_A, turnId: 'turn-a', dispatchAttempt: 1, ipcPort: address.port }),
        readHostSecret: () => undefined,
        preferCapability: true,
        resolvePorts: claim => [claim?.ipcPort ?? address.port, handle!.port],
        backoffMs: [0],
        postBatch: async ({ ipcPort, sessionId, payload, headers }) => loopbackFetch(
          `http://127.0.0.1:${ipcPort}/api/sessions/${sessionId}/${RELAYED_TURN_REPLY_ROUTE}`,
          { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) },
        ),
      });
      expect(outcome).toEqual({ ok: true });
      expect(captured).toBeDefined();
      const stolen = captured!;
      expect(stolen.raw).not.toContain(CAP_A);
      expect(stolen.raw).not.toContain('private reply body');
      for (const value of Object.values(stolen.headers)) {
        expect(String(value)).not.toContain(CAP_A);
      }

      // The sealed request may only be replayed verbatim. The result cache
      // returns the first committed response; no second SQLite row is written.
      const replay = await loopbackFetch(`http://127.0.0.1:${handle!.port}/api/sessions/sess-a/${RELAYED_TURN_REPLY_ROUTE}`, {
        method: 'POST', headers: stolen.headers as Record<string, string>, body: stolen.raw,
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ recorded: 1, duplicates: 0, staged: true });

      // Reusing a valid proof with modified ciphertext cannot mint a new reply.
      // Use a fresh nonce so this exercises hash/decrypt rejection rather than
      // the exact-replay cache's idempotent acknowledgement of an earlier commit.
      const tamperRequest = capabilityRequest('sess-a', {
        expectedTurnId: 'turn-a',
        replies: [{ messageId: 'om_tampered', responseKind: 'final', at: Date.now(), text: 'tampered' }],
      }, { capability: CAP_A });
      const tamperedBody = JSON.parse(tamperRequest.raw) as { sealed: string };
      tamperedBody.sealed = `${tamperedBody.sealed.slice(0, -1)}${tamperedBody.sealed.endsWith('A') ? 'B' : 'A'}`;
      const tampered = await loopbackFetch(`http://127.0.0.1:${handle!.port}/api/sessions/sess-a/${RELAYED_TURN_REPLY_ROUTE}`, {
        method: 'POST', headers: tamperRequest.headers, body: JSON.stringify(tamperedBody),
      });
      expect(tampered.status).toBe(400);
      expect(readSessionTurns(dataDir!, 'sess-a', 0, 50).turns[0]?.replies.map(reply => reply.messageId))
        .toEqual(['om_real']);
    } finally {
      await new Promise<void>(resolve => rogue.close(() => resolve()));
    }
  });

  it('fails over between wrong host secret and stale capability in both directions without exposing either key', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') });
    stageTurn('sess-a', 'turn-a');
    const now = Date.now();

    for (const scenario of [
      {
        name: 'host-to-capability', messageId: 'om_host_to_cap', capability: CAP_A,
        hostSecret: 'wrong-secret-for-current-daemon', preferCapability: false,
        expectedKinds: ['host', 'capability'],
      },
      {
        name: 'capability-to-host', messageId: 'om_cap_to_host', capability: CAP_B,
        hostSecret: SECRET, preferCapability: true,
        expectedKinds: ['capability', 'host'],
      },
    ] as const) {
      const keyKinds: string[] = [];
      const outcome = await postRelayedTurnReplies({
        sessionId: 'sess-a',
        expectedTurnId: 'turn-a',
        replies: [{ messageId: scenario.messageId, responseKind: 'final', at: now, text: `private ${scenario.name}` }],
        readClaim: () => ({ capability: scenario.capability, turnId: 'turn-a', dispatchAttempt: 1, ipcPort: handle!.port }),
        readHostSecret: () => scenario.hostSecret,
        preferCapability: scenario.preferCapability,
        resolvePorts: () => [handle!.port],
        backoffMs: [0],
        postBatch: async ({ ipcPort, sessionId, payload, headers, keyKind }) => {
          keyKinds.push(keyKind);
          return fetchDaemonIpc(ipcPort, `/api/sessions/${sessionId}/${RELAYED_TURN_REPLY_ROUTE}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(payload),
          }, scenario.hostSecret);
        },
      });
      expect(outcome, scenario.name).toEqual({ ok: true });
      expect(keyKinds, scenario.name).toEqual(scenario.expectedKinds);
    }
    expect(readSessionTurns(dataDir!, 'sess-a', 0, 50).turns[0]?.replies.map(reply => reply.messageId))
      .toEqual(['om_host_to_cap', 'om_cap_to_host']);
  });

  it('serves exact replay floods from the bounded result cache without charging pre-body quota again', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') });
    stageTurn('sess-a', 'turn-a');
    const request = capabilityRequest('sess-a', {
      expectedTurnId: 'turn-a',
      replies: [{ messageId: 'om_replayed', responseKind: 'final', at: Date.now(), text: 'one real reply' }],
    }, { capability: CAP_A, dispatchAttempt: 1 });
    const postExact = () => loopbackFetch(`http://127.0.0.1:${handle!.port}/api/sessions/sess-a/${RELAYED_TURN_REPLY_ROUTE}`, {
      method: 'POST', headers: request.headers, body: request.raw,
    });
    const statuses: number[] = [];
    for (let index = 0; index < 30; index++) {
      const response = await postExact();
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    expect(statuses).toEqual(Array(30).fill(200));

    const fresh = await postCapability('sess-a', {
      expectedTurnId: 'turn-a',
      replies: [{ messageId: 'om_after_replay_flood', responseKind: 'auxiliary', at: Date.now(), text: 'still writable' }],
    }, { capability: CAP_A });
    expect(fresh.status).toBe(200);
    expect(readSessionTurns(dataDir!, 'sess-a', 0, 50).turns[0]?.replies.map(reply => reply.messageId))
      .toEqual(['om_replayed', 'om_after_replay_flood']);
  });

  it('uses retryable failure tombstones to stop tampered replay floods without poisoning fresh recovery', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') });
    stageTurn('sess-a', 'turn-a');
    const originalPayload = {
      expectedTurnId: 'turn-a',
      replies: [{ messageId: 'om_after_failure', responseKind: 'final' as const, at: Date.now(), text: 'valid after failures' }],
    };
    const request = capabilityRequest('sess-a', originalPayload, { capability: CAP_A });
    const tampered = JSON.parse(request.raw) as { sealed: string };
    tampered.sealed = `${tampered.sealed.slice(0, -1)}${tampered.sealed.endsWith('A') ? 'B' : 'A'}`;
    const tamperedRaw = JSON.stringify(tampered);
    const postRaw = (raw: string) => loopbackFetch(`http://127.0.0.1:${handle!.port}/api/sessions/sess-a/${RELAYED_TURN_REPLY_ROUTE}`, {
      method: 'POST', headers: request.headers, body: raw,
    });

    const statuses: number[] = [];
    for (let index = 0; index < 30; index++) {
      const response = await postRaw(tamperedRaw);
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    expect(statuses).toEqual([400, ...Array(29).fill(503)]);

    // The original nonce gets a retryable tombstone, never a poisoned cached
    // 400. The production client reseals with a fresh nonce and commits at once.
    const originalExact = await postRaw(request.raw);
    expect(originalExact.status).toBe(503);
    await originalExact.arrayBuffer();
    const recovered = await postRelayedTurnReplies({
      sessionId: 'sess-a', expectedTurnId: 'turn-a', replies: originalPayload.replies,
      readClaim: () => ({ capability: CAP_A, turnId: 'turn-a', dispatchAttempt: 1, ipcPort: handle!.port }),
      readHostSecret: () => undefined,
      preferCapability: true,
      resolvePorts: () => [handle!.port],
      backoffMs: [0],
      postBatch: async ({ ipcPort, sessionId, payload, headers }) => loopbackFetch(
        `http://127.0.0.1:${ipcPort}/api/sessions/${sessionId}/${RELAYED_TURN_REPLY_ROUTE}`,
        { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) },
      ),
    });
    expect(recovered).toEqual({ ok: true });
    expect(readSessionTurns(dataDir!, 'sess-a', 0, 50).turns[0]?.replies.map(reply => reply.messageId))
      .toEqual(['om_after_failure']);
  });

  it('coalesces an exact duplicate while the original body is pending, then serves the committed result', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') });
    stageTurn('sess-a', 'turn-a');
    const request = capabilityRequest('sess-a', {
      expectedTurnId: 'turn-a',
      replies: [{ messageId: 'om_pending', responseKind: 'final', at: Date.now(), text: 'pending coalesce' }],
    }, { capability: CAP_A });
    const stream = openStreamingRequest({ sessionId: 'sess-a', headers: request.headers, body: request.raw });
    const splitAt = Math.floor(request.raw.length / 2);
    stream.req.write(request.raw.slice(0, splitAt));
    await new Promise(resolve => setTimeout(resolve, 40));

    const duplicate = await loopbackFetch(`http://127.0.0.1:${handle!.port}/api/sessions/sess-a/${RELAYED_TURN_REPLY_ROUTE}`, {
      method: 'POST', headers: request.headers, body: request.raw,
    });
    expect(duplicate.status).toBe(503);
    expect(await duplicate.json()).toEqual({ ok: false, error: 'turn_reply_in_progress' });

    stream.req.end(request.raw.slice(splitAt));
    const original = await stream.response;
    expect(original.status).toBe(200);
    const afterDone = await loopbackFetch(`http://127.0.0.1:${handle!.port}/api/sessions/sess-a/${RELAYED_TURN_REPLY_ROUTE}`, {
      method: 'POST', headers: request.headers, body: request.raw,
    });
    expect(afterDone.status).toBe(200);
    expect(await afterDone.json()).toEqual(JSON.parse(original.body));
    expect(readSessionTurns(dataDir!, 'sess-a', 0, 50).turns[0]?.replies.map(reply => reply.messageId))
      .toEqual(['om_pending']);
  });

  it('charges lost-response retries only for post-dedup new text and continues later batches', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') });
    stageTurn('sess-a', 'turn-a');
    const now = Date.now();
    const largeText = 'a'.repeat(SESSION_TURN_REPLY_RAW_TEXT_CAP);
    const postReal = async (
      replies: SessionTurnReply[],
      stripFirstProof: boolean,
      expectedAttempts?: number,
    ) => {
      let attempts = 0;
      let stripRemaining = stripFirstProof ? 1 : 0;
      const outcome = await postRelayedTurnReplies({
        sessionId: 'sess-a', expectedTurnId: 'turn-a', replies,
        readClaim: () => ({ capability: CAP_A, turnId: 'turn-a', dispatchAttempt: 1, ipcPort: handle!.port }),
        readHostSecret: () => undefined,
        preferCapability: true,
        resolvePorts: () => [handle!.port],
        backoffMs: [0, 0],
        postBatch: async ({ ipcPort, sessionId, payload, headers }) => {
          attempts += 1;
          const response = await loopbackFetch(`http://127.0.0.1:${ipcPort}/api/sessions/${sessionId}/${RELAYED_TURN_REPLY_ROUTE}`, {
            method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload),
          });
          if (stripRemaining > 0) {
            stripRemaining -= 1;
            const raw = await response.text();
            const unauthenticatedHeaders = new Headers(response.headers);
            unauthenticatedHeaders.delete(RELAYED_TURN_REPLY_HEADERS.responseProof);
            return new Response(raw, { status: response.status, headers: unauthenticatedHeaders });
          }
          return response;
        },
      });
      expect(outcome).toEqual({ ok: true });
      if (expectedAttempts !== undefined) expect(attempts).toBe(expectedAttempts);
    };

    const firstBatch: SessionTurnReply[] = [
      { messageId: 'om_large_first', responseKind: 'final', at: now, text: largeText },
      ...Array.from({ length: 63 }, (_, index) => ({
        messageId: `om_first_${index}`, responseKind: 'final' as const, at: now,
      })),
    ];
    await postReal([
      ...firstBatch,
      { messageId: 'om_second_batch', responseKind: 'final', at: now },
    ], true, 3);
    expect(readSessionTurns(dataDir!, 'sess-a', 0, 50).turns[0]?.replies).toHaveLength(65);

    // The first committed batch plus three later batches fit the character
    // window exactly after scrub/truncation. A duplicate retry charging raw
    // text again would make the last legitimate batch hit 429 instead.
    for (let index = 0; index < 3; index++) {
      await postReal([{
        messageId: `om_large_new_${index}`,
        responseKind: 'final',
        at: now,
        text: largeText,
      }], false, 1);
    }
    expect(readSessionTurns(dataDir!, 'sess-a', 0, 50).turns[0]?.replies).toHaveLength(68);
  });

  it('records multi-reply batches atomically, scrubs text, preserves text:undefined, and deduplicates retries', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') });
    stageTurn('sess-a', 'turn-a');
    const now = Date.now();

    const payload = {
      expectedTurnId: 'turn-a',
      // Forged top-level fields must be ignored by the daemon.
      sessionId: 'sess-other',
      turnId: 'turn-other',
      pruneNow: now + 365 * 24 * 60 * 60 * 1000,
      replies: [
        { messageId: 'om_primary_1', responseKind: 'final', at: now, text: 'Secret Bearer tok123 at /Users/dev/file.ts' },
        { messageId: 'om_attach_1', responseKind: 'final', at: now },
        { messageId: 'om_attach_2', responseKind: 'final', at: now, text: '' },
      ],
    };

    const first = await postCapability('sess-a', payload, { capability: CAP_A, turnId: 'turn-a', dispatchAttempt: 1 });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, recorded: 3, duplicates: 0, staged: true });

    const replay = await postCapability('sess-a', payload, { capability: CAP_A, turnId: 'turn-a', dispatchAttempt: 1 });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, recorded: 0, duplicates: 3, staged: true });

    const turns = readSessionTurns(dataDir!, 'sess-a', 0, 50).turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]!.replies).toEqual([
      { messageId: 'om_primary_1', responseKind: 'final', at: now, text: 'Secret <redacted> at <redacted>' },
      { messageId: 'om_attach_1', responseKind: 'final', at: now },
      { messageId: 'om_attach_2', responseKind: 'final', at: now },
    ]);
    expect('text' in turns[0]!.replies[1]!).toBe(false);
    expect('text' in turns[0]!.replies[2]!).toBe(false);
  });

  it('prevents cross-turn forgery and rejects mid-stream origin rotation (zero TOCTOU)', async () => {
    const session = liveSession('sess-a', CAP_A, 'turn-new');
    await setup({ 'sess-a': session });
    stageTurn('sess-a', 'turn-old');
    stageTurn('sess-a', 'turn-new');
    const now = Date.now();

    // Active turn is turn-new: attempting to record onto staged turn-old MUST fail with 409.
    const crossTurn = await postCapability('sess-a', {
      expectedTurnId: 'turn-old',
      replies: [{ messageId: 'om_forged', responseKind: 'final', at: now, text: 'forged' }],
    }, { capability: CAP_A });
    expect(crossTurn.status).toBe(409);
    expect(await crossTurn.json()).toEqual({ ok: false, error: 'turn_mismatch' });

    // Start streaming a valid sealed request for turn-new, then revoke/rotate mid-stream before body ends.
    const raceRequest = capabilityRequest('sess-a', {
      expectedTurnId: 'turn-new',
      replies: [{ messageId: 'om_race', responseKind: 'final', at: now, text: 'too late' }],
    }, { capability: CAP_A });
    const stream = openStreamingRequest({
      sessionId: 'sess-a',
      headers: raceRequest.headers,
      body: raceRequest.raw,
    });
    const splitAt = Math.floor(raceRequest.raw.length / 2);
    stream.req.write(raceRequest.raw.slice(0, splitAt));
    await new Promise(resolve => setTimeout(resolve, 40));
    session.managedTurnOrigin = { capability: CAP_B, turnId: 'turn-next', dispatchAttempt: 2 };
    stream.req.end(raceRequest.raw.slice(splitAt));
    const raceRes = await stream.response;
    expect(raceRes.status).toBe(409);
    expect(JSON.parse(raceRes.body)).toEqual({ ok: false, error: 'turn_mismatch' });

    const turns = readSessionTurns(dataDir!, 'sess-a', 0, 50).turns;
    expect(turns.find(t => t.turnId === 'turn-old')?.replies).toEqual([]);
    expect(turns.find(t => t.turnId === 'turn-new')?.replies).toEqual([]);
  });

  it('supports vcMeetingReceiver sessions (allowReceiver: true) and trusted-host HMAC auth', async () => {
    await setup({
      'sess-rx': liveSession('sess-rx', CAP_A, 'turn-rx', { vcMeetingReceiver: true }),
    });
    stageTurn('sess-rx', 'turn-rx');
    const now = Date.now();

    const capRes = await postCapability('sess-rx', {
      expectedTurnId: 'turn-rx',
      replies: [{ messageId: 'om_rx_1', responseKind: 'progress', at: now, text: 'working' }],
    }, { capability: CAP_A });
    expect(capRes.status).toBe(200);

    const hmacRequest = hostRequest('sess-rx', {
      expectedTurnId: 'turn-rx',
      replies: [{ messageId: 'om_rx_2', responseKind: 'final', at: now + 1, text: 'done' }],
    });
    const hmacRes = await fetchDaemonIpc(handle!.port, `/api/sessions/sess-rx/${RELAYED_TURN_REPLY_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...hmacRequest.headers },
      body: JSON.stringify(hmacRequest.body),
    }, SECRET);
    expect(hmacRes.status).toBe(200);
    expect(readSessionTurns(dataDir!, 'sess-rx', 0, 50).turns[0]?.replies.map(r => r.messageId))
      .toEqual(['om_rx_1', 'om_rx_2']);

    // Trusted host targeting an absent or closed session receives 404 session_not_active.
    const missingRequest = hostRequest('sess-gone', {
      expectedTurnId: 'turn-rx',
      replies: [{ messageId: 'om_gone', responseKind: 'final', at: now }],
    });
    const missingRes = await fetchDaemonIpc(handle!.port, `/api/sessions/sess-gone/${RELAYED_TURN_REPLY_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...missingRequest.headers },
      body: JSON.stringify(missingRequest.body),
    }, SECRET);
    expect(missingRes.status).toBe(404);
    expect(await missingRes.json()).toEqual({ ok: false, error: 'session_not_active' });
  });

  it('binds doc:<commentId> replies strictly to live docCommentTargets/docCommentTurns and forbids colons in commentId', async () => {
    await setup({
      'sess-im': liveSession('sess-im', CAP_A, 'turn-im'),
      'sess-doc': liveSession('sess-doc', CAP_B, 'turn-doc', {
        docCommentTargets: {
          'turn-doc': { fileToken: 'doc_1', fileType: 'docx', commentId: 'cmt_42', turnId: 'turn-doc' },
        },
      }),
    });
    stageTurn('sess-im', 'turn-im');
    stageTurn('sess-doc', 'turn-doc');
    const now = Date.now();

    // Non-doc IM session cannot forge doc: receipt.
    const imDoc = await postCapability('sess-im', {
      expectedTurnId: 'turn-im',
      replies: [{ messageId: 'doc:cmt_42', responseKind: 'final', at: now, text: 'fake' }],
    }, { capability: CAP_A });
    expect(imDoc.status).toBe(403);
    expect(await imDoc.json()).toEqual({ ok: false, error: 'doc_comment_target_mismatch' });

    // Doc session with wrong commentId -> 403; with ':' inside commentId -> 400.
    const wrongCmt = await postCapability('sess-doc', {
      expectedTurnId: 'turn-doc',
      replies: [{ messageId: 'doc:cmt_other', responseKind: 'final', at: now, text: 'wrong' }],
    }, { capability: CAP_B });
    expect(wrongCmt.status).toBe(403);

    const colonCmt = await postCapability('sess-doc', {
      expectedTurnId: 'turn-doc',
      replies: [{ messageId: 'doc:cmt:42', responseKind: 'final', at: now, text: 'colon' }],
    }, { capability: CAP_B });
    expect(colonCmt.status).toBe(400);

    // Exact matching doc:<commentId> succeeds.
    const okCmt = await postCapability('sess-doc', {
      expectedTurnId: 'turn-doc',
      replies: [{ messageId: 'doc:cmt_42', responseKind: 'final', at: now, text: 'comment reply' }],
    }, { capability: CAP_B });
    expect(okCmt.status).toBe(200);
    expect(readSessionTurns(dataDir!, 'sess-doc', 0, 50).turns[0]?.replies).toEqual([
      { messageId: 'doc:cmt_42', responseKind: 'final', at: now, text: 'comment reply' },
    ]);
  });

  it('enforces timestamp bounds, 262K CJK UTF-8 payload acceptance, 3 MiB body cap, cumulative text cap, and 64-item cap', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') });
    stageTurn('sess-a', 'turn-a');
    const now = Date.now();

    // Backdated 1970 and far-future timestamps rejected with 400.
    for (const badAt of [1, now - 25 * 60 * 60 * 1000, now + 120_000]) {
      const res = await postCapability('sess-a', {
        expectedTurnId: 'turn-a',
        replies: [{ messageId: 'om_bad_at', responseKind: 'final', at: badAt }],
      }, { capability: CAP_A });
      expect(res.status).toBe(400);
    }

    // 262,144-char CJK text (~768 KiB UTF-8, valid under 2 MiB JSON cap) succeeds and truncates consistently.
    const cjk262k = '测'.repeat(256 * 1024 + 100);
    const bigCjkRes = await postCapability('sess-a', {
      expectedTurnId: 'turn-a',
      replies: [{ messageId: 'om_cjk', responseKind: 'progress', at: now, text: cjk262k }],
    }, { capability: CAP_A });
    expect(bigCjkRes.status).toBe(200);
    const storedText = readSessionTurns(dataDir!, 'sess-a', 0, 50).turns[0]?.replies[0]?.text ?? '';
    expect(storedText.length).toBeGreaterThan(256 * 1024 - 10);
    expect(storedText.endsWith('…')).toBe(true);

    // Cumulative text > SESSION_TURN_REPLY_RAW_TEXT_CAP across batch rejected with 400.
    const half = 'a'.repeat(Math.ceil(SESSION_TURN_REPLY_RAW_TEXT_CAP / 2) + 10);
    const cumRes = await postCapability('sess-a', {
      expectedTurnId: 'turn-a',
      replies: [
        { messageId: 'om_c1', responseKind: 'progress', at: now, text: half },
        { messageId: 'om_c2', responseKind: 'progress', at: now, text: half },
      ],
    }, { capability: CAP_A });
    expect(cumRes.status).toBe(400);

    // > 64 replies rejected with 400.
    const tooManyItems = Array.from({ length: RELAYED_TURN_REPLY_MAX_ITEMS + 1 }, (_, i) => ({
      messageId: `om_item_${i}`,
      responseKind: 'progress',
      at: now,
    }));
    const itemsRes = await postCapability('sess-a', { expectedTurnId: 'turn-a', replies: tooManyItems }, { capability: CAP_A });
    expect(itemsRes.status).toBe(400);

    // Body > 3 MiB rejected with 413 body_too_large.
    const oversized = JSON.stringify({
      expectedTurnId: 'turn-a',
      replies: [{ messageId: 'om_huge', responseKind: 'progress', at: now, text: 'x'.repeat(RELAYED_TURN_REPLY_MAX_BYTES + 1024) }],
    });
    const overRes = await postCapability('sess-a', oversized, { capability: CAP_A });
    expect(overRes.status).toBe(413);
    expect(await overRes.json()).toEqual({ ok: false, error: 'body_too_large' });
  });

  it('handles mid-stream same-turn policyCapability revoke, capability rotation (403 retryable), and full revocation cleanly', async () => {
    const session = liveSession('sess-a', CAP_A, 'turn-a');
    session.managedTurnOrigin.policyCapability = 'pol-cap-1';
    await setup({ 'sess-a': session });
    stageTurn('sess-a', 'turn-a');
    const now = Date.now();

    // 1. Mid-stream policyCapability-only revoke (same live capability & turnId) MUST still commit 200.
    const s1 = openSealedStream('sess-a', {
      expectedTurnId: 'turn-a',
      replies: [{ messageId: 'om_pol_ok', responseKind: 'progress', at: now, text: 'policy revoke ok' }],
    }, { capability: CAP_A });
    s1.writePrefix();
    await new Promise(resolve => setTimeout(resolve, 40));
    session.managedTurnOrigin = { capability: CAP_A, turnId: 'turn-a', dispatchAttempt: 1 };
    s1.end();
    const r1 = await s1.stream.response;
    expect(r1.status).toBe(200);

    // 2. Mid-stream same-turn capability rotation (CAP_A -> CAP_B, same turn-a) MUST return retryable 403 origin_unproven (NOT terminal 409).
    const s2 = openSealedStream('sess-a', {
      expectedTurnId: 'turn-a',
      replies: [{ messageId: 'om_rot', responseKind: 'progress', at: now + 1, text: 'rotated' }],
    }, { capability: CAP_A });
    s2.writePrefix();
    await new Promise(resolve => setTimeout(resolve, 40));
    session.managedTurnOrigin = { capability: CAP_B, turnId: 'turn-a', dispatchAttempt: 1 };
    s2.end();
    const r2 = await s2.stream.response;
    expect(r2.status).toBe(403);
    expect(JSON.parse(r2.body)).toEqual({ ok: false, error: 'origin_unproven' });

    // 3. Mid-stream full revocation (!turnId) rejects capability callers with 403 origin_unproven and writes nothing.
    const s3 = openSealedStream('sess-a', {
      expectedTurnId: 'turn-a',
      replies: [{ messageId: 'om_revoked', responseKind: 'final', at: now + 2, text: 'revoked' }],
    }, { capability: CAP_B });
    s3.writePrefix();
    await new Promise(resolve => setTimeout(resolve, 40));
    session.managedTurnOrigin = { capability: 'unpublished-random' };
    s3.end();
    const r3 = await s3.stream.response;
    expect(r3.status).toBe(403);
    expect(JSON.parse(r3.body)).toEqual({ ok: false, error: 'origin_unproven' });

    expect(readSessionTurns(dataDir!, 'sess-a', 0, 50).turns[0]?.replies.map(r => r.messageId))
      .toEqual(['om_pol_ok']);
  });

  it('isolates per-session in-flight caps (no cross-session slowloris starvation) and closes stalled bodies with 408 body_timeout', async () => {
    await setup({
      'sess-a': liveSession('sess-a', CAP_A, 'turn-a'),
      'sess-b': liveSession('sess-b', CAP_B, 'turn-b'),
    });
    stageTurn('sess-a', 'turn-a');
    stageTurn('sess-b', 'turn-b');

    const held = Array.from({ length: RELAYED_TURN_REPLY_MAX_IN_FLIGHT_PER_SESSION }, () => {
      const sealed = openSealedStream('sess-a', {
        expectedTurnId: 'turn-a',
        replies: [{ messageId: 'om_stalled', responseKind: 'progress', at: Date.now() }],
      }, { capability: CAP_A });
      sealed.writePrefix();
      return sealed.stream;
    });
    await new Promise(resolve => setTimeout(resolve, 60));

    // Session A hits its per-session cap -> 429 too_many_turn_reply_requests.
    const overflowA = await postCapability('sess-a', {
      expectedTurnId: 'turn-a',
      replies: [{ messageId: 'om_overflow', responseKind: 'progress', at: Date.now() }],
    }, { capability: CAP_A });
    expect(overflowA.status).toBe(429);
    expect(await overflowA.json()).toEqual({ ok: false, error: 'too_many_turn_reply_requests' });

    // Sibling Session B MUST NOT be starved by Session A's stalled streams!
    const okB = await postCapability('sess-b', {
      expectedTurnId: 'turn-b',
      replies: [{ messageId: 'om_b_ok', responseKind: 'final', at: Date.now(), text: 'not starved' }],
    }, { capability: CAP_B });
    expect(okB.status).toBe(200);

    // Let one stalled body hit the 2s body timeout; destroy the rest cleanly.
    const stalled = held.pop()!;
    for (const s of held) s.req.destroy();
    const timeoutRes = await stalled.response;
    stalled.req.destroy();
    expect(timeoutRes.status).toBe(408);
    expect(JSON.parse(timeoutRes.body)).toEqual({ ok: false, error: 'body_timeout' });
  }, 15_000);

  it('enforces exact atomic post-dedup per-turn quotas (no batch overshoot, idempotent replay at cap, byte cap, backward clock jump) and close fence', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ipc-turn-reply-quota-'));
    const session = liveSession('sess-q', CAP_A, 'turn-q');
    stageTurn('sess-q', 'turn-q');
    const baseNow = Date.now();

    const quota = createTurnReplyQuotaTracker({
      windowMs: 10_000,
      maxWindowRequests: 4,
      maxWindowChars: 100,
      maxTurnReplies: 3,
      maxTurnChars: 120,
      maxTurnPayloadBytes: 500,
    });

    // Window char limit: 60 + 60 > 100 inside 10s window -> 429 turn_reply_rate_limited.
    const r1 = recordRelayedTurnReply({
      ds: session,
      dataDir,
      quota,
      now: baseNow,
      body: {
        expectedTurnId: 'turn-q',
        replies: [{ messageId: 'om_q1', responseKind: 'progress', at: baseNow, text: 'a'.repeat(60) }],
      },
    });
    expect(r1).toEqual({ ok: true, recorded: 1, duplicates: 0, staged: true });

    const r2RateLimited = recordRelayedTurnReply({
      ds: session,
      dataDir,
      quota,
      now: baseNow + 1_000,
      body: {
        expectedTurnId: 'turn-q',
        replies: [{ messageId: 'om_q2', responseKind: 'progress', at: baseNow + 1_000, text: 'b'.repeat(60) }],
      },
    });
    expect(r2RateLimited).toEqual({ ok: false, status: 429, error: 'turn_reply_rate_limited' });

    // Backward clock jump in rateWindowNow must NOT pin the sliding window.
    const backwardOk = recordRelayedTurnReply({
      ds: session,
      dataDir,
      quota,
      now: baseNow + 1_000,
      rateWindowNow: baseNow - 5_000,
      body: {
        expectedTurnId: 'turn-q',
        replies: [{ messageId: 'om_q1', responseKind: 'progress', at: baseNow, text: 'a'.repeat(60) }],
      },
    });
    expect(backwardOk).toEqual({ ok: true, recorded: 0, duplicates: 1, staged: true });

    // Batch overshoot test: currently at 1 reply, cap is 3 -> batch of 3 NEW replies (total 4 > 3) MUST fail atomically with 0 writes!
    const overshoot = recordRelayedTurnReply({
      ds: session,
      dataDir,
      quota,
      now: baseNow + 11_000,
      body: {
        expectedTurnId: 'turn-q',
        replies: [
          { messageId: 'om_over_1', responseKind: 'progress', at: baseNow + 11_000 },
          { messageId: 'om_over_2', responseKind: 'progress', at: baseNow + 11_000 },
          { messageId: 'om_over_3', responseKind: 'progress', at: baseNow + 11_000 },
        ],
      },
    });
    expect(overshoot).toEqual({ ok: false, status: 429, error: 'turn_reply_quota_exceeded' });
    expect(readSessionTurns(dataDir, 'sess-q', 0, 50).turns[0]?.replies).toHaveLength(1);

    // Two distinct replies fit exactly into durable cap = 3.
    const r23 = recordRelayedTurnReply({
      ds: session,
      dataDir,
      quota,
      now: baseNow + 22_000,
      body: {
        expectedTurnId: 'turn-q',
        replies: [
          { messageId: 'om_q2', responseKind: 'progress', at: baseNow + 22_000 },
          { messageId: 'om_q3', responseKind: 'final', at: baseNow + 22_000 },
        ],
      },
    });
    expect(r23).toEqual({ ok: true, recorded: 2, duplicates: 0, staged: true });

    // Even AT durable cap = 3, an exact idempotent replay MUST still return HTTP 200!
    const dupAtCap = recordRelayedTurnReply({
      ds: session,
      dataDir,
      quota,
      now: baseNow + 33_000,
      body: {
        expectedTurnId: 'turn-q',
        replies: [{ messageId: 'om_q3', responseKind: 'final', at: baseNow + 22_000 }],
      },
    });
    expect(dupAtCap).toEqual({ ok: true, recorded: 0, duplicates: 1, staged: true });

    // A 4th distinct reply exceeds durable cap -> 429 turn_reply_quota_exceeded.
    const r4 = recordRelayedTurnReply({
      ds: session,
      dataDir,
      quota,
      now: baseNow + 44_000,
      body: {
        expectedTurnId: 'turn-q',
        replies: [{ messageId: 'om_q4', responseKind: 'auxiliary', at: baseNow + 44_000 }],
      },
    });
    expect(r4).toEqual({ ok: false, status: 429, error: 'turn_reply_quota_exceeded' });

    // After cleanupSessionTurns, close fence returns staged: false cleanly without writing.
    cleanupSessionTurns(dataDir, 'sess-q');
    const afterClose = recordRelayedTurnReply({
      ds: session,
      dataDir,
      now: baseNow + 45_000,
      body: {
        expectedTurnId: 'turn-q',
        replies: [{ messageId: 'om_after_close', responseKind: 'auxiliary', at: baseNow + 45_000 }],
      },
    });
    expect(afterClose).toEqual({ ok: true, recorded: 0, duplicates: 0, staged: false });
    expect(readSessionTurns(dataDir, 'sess-q', 0, 50).turns).toEqual([]);
  });
});
