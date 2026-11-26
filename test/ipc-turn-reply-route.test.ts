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
  recordRelayedTurnReply,
  RELAYED_TURN_REPLY_HEADERS,
  RELAYED_TURN_REPLY_MAX_BYTES,
  RELAYED_TURN_REPLY_MAX_IN_FLIGHT_PER_SESSION,
  RELAYED_TURN_REPLY_MAX_ITEMS,
  RELAYED_TURN_REPLY_ROUTE,
  SESSION_TURN_REPLY_RAW_TEXT_CAP,
} from '../src/core/relayed-turn-reply.js';
import {
  cleanupSessionTurns,
  projectLarkTurnInbound,
  readSessionTurns,
  recordSessionTurnInput,
  stageSessionTurnInbound,
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

function postCapability(
  sessionId: string,
  body: unknown,
  opts: { capability?: string; turnId?: string; dispatchAttempt?: number } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.capability !== undefined) headers[RELAYED_TURN_REPLY_HEADERS.capability] = opts.capability;
  if (opts.turnId !== undefined) headers[RELAYED_TURN_REPLY_HEADERS.turnId] = opts.turnId;
  if (opts.dispatchAttempt !== undefined) headers[RELAYED_TURN_REPLY_HEADERS.dispatchAttempt] = String(opts.dispatchAttempt);
  return loopbackFetch(`http://127.0.0.1:${handle!.port}/api/sessions/${encodeURIComponent(sessionId)}/${RELAYED_TURN_REPLY_ROUTE}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function openStreamingRequest(input: {
  sessionId: string;
  headers?: Record<string, string>;
}): {
  req: http.ClientRequest;
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
  return { req, response };
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
      const stream = openStreamingRequest({
        sessionId: targetSession,
        headers: cap ? { [RELAYED_TURN_REPLY_HEADERS.capability]: cap } : {},
      });
      stream.req.write('{"expectedTurnId":"turn-a",'); // intentionally incomplete, never ended
      const res = await stream.response;
      stream.req.destroy();
      expect(res.status).toBe(403);
      expect(res.headers.connection).toBe('close');
      expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'origin_unproven' });
    }
    expect(readSessionTurns(dataDir!, 'sess-a', 0, 50).turns[0]?.replies).toEqual([]);
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

    // Start streaming a valid request for turn-new, then revoke/rotate mid-stream before body ends.
    const stream = openStreamingRequest({
      sessionId: 'sess-a',
      headers: { [RELAYED_TURN_REPLY_HEADERS.capability]: CAP_A },
    });
    stream.req.write(`{"expectedTurnId":"turn-new","replies":[{"messageId":"om_race","responseKind":"final","at":${now},`);
    await new Promise(resolve => setTimeout(resolve, 40));
    session.managedTurnOrigin = { capability: CAP_B, turnId: 'turn-next', dispatchAttempt: 2 };
    stream.req.end('"text":"too late"}]}');
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

    const hmacRes = await fetchDaemonIpc(handle!.port, `/api/sessions/sess-rx/${RELAYED_TURN_REPLY_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedTurnId: 'turn-rx',
        replies: [{ messageId: 'om_rx_2', responseKind: 'final', at: now + 1, text: 'done' }],
      }),
    }, SECRET);
    expect(hmacRes.status).toBe(200);
    expect(readSessionTurns(dataDir!, 'sess-rx', 0, 50).turns[0]?.replies.map(r => r.messageId))
      .toEqual(['om_rx_1', 'om_rx_2']);

    // Trusted host targeting an absent or closed session receives 404 session_not_active.
    const missingRes = await fetchDaemonIpc(handle!.port, `/api/sessions/sess-gone/${RELAYED_TURN_REPLY_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedTurnId: 'turn-rx',
        replies: [{ messageId: 'om_gone', responseKind: 'final', at: now }],
      }),
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

  it('enforces timestamp bounds, 262K CJK UTF-8 payload acceptance, 2 MiB body cap, cumulative text cap, and 64-item cap', async () => {
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

    // Body > 2 MiB rejected with 413 body_too_large.
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
    const s1 = openStreamingRequest({
      sessionId: 'sess-a',
      headers: { [RELAYED_TURN_REPLY_HEADERS.capability]: CAP_A },
    });
    s1.req.write(`{"expectedTurnId":"turn-a","replies":[{"messageId":"om_pol_ok","responseKind":"progress","at":${now},`);
    await new Promise(resolve => setTimeout(resolve, 40));
    session.managedTurnOrigin = { capability: CAP_A, turnId: 'turn-a', dispatchAttempt: 1 };
    s1.req.end('"text":"policy revoke ok"}]}');
    const r1 = await s1.response;
    expect(r1.status).toBe(200);

    // 2. Mid-stream same-turn capability rotation (CAP_A -> CAP_B, same turn-a) MUST return retryable 403 origin_unproven (NOT terminal 409).
    const s2 = openStreamingRequest({
      sessionId: 'sess-a',
      headers: { [RELAYED_TURN_REPLY_HEADERS.capability]: CAP_A },
    });
    s2.req.write(`{"expectedTurnId":"turn-a","replies":[{"messageId":"om_rot","responseKind":"progress","at":${now + 1},`);
    await new Promise(resolve => setTimeout(resolve, 40));
    session.managedTurnOrigin = { capability: CAP_B, turnId: 'turn-a', dispatchAttempt: 1 };
    s2.req.end('"text":"rotated"}]}');
    const r2 = await s2.response;
    expect(r2.status).toBe(403);
    expect(JSON.parse(r2.body)).toEqual({ ok: false, error: 'origin_unproven' });

    // 3. Mid-stream full revocation (!turnId) rejects capability callers with 403 origin_unproven and writes nothing.
    const s3 = openStreamingRequest({
      sessionId: 'sess-a',
      headers: { [RELAYED_TURN_REPLY_HEADERS.capability]: CAP_B },
    });
    s3.req.write(`{"expectedTurnId":"turn-a","replies":[{"messageId":"om_revoked","responseKind":"final","at":${now + 2},`);
    await new Promise(resolve => setTimeout(resolve, 40));
    session.managedTurnOrigin = { capability: 'unpublished-random' };
    s3.req.end('"text":"revoked"}]}');
    const r3 = await s3.response;
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
      const s = openStreamingRequest({
        sessionId: 'sess-a',
        headers: { [RELAYED_TURN_REPLY_HEADERS.capability]: CAP_A },
      });
      s.req.write('{"expectedTurnId":"turn-a",');
      return s;
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
