/**
 * Client-side & real `botmux send` end-to-end tests for structured turn reply
 * recording across sandboxed (unwritable shared `turns.sqlite`), unsandboxed,
 * multi-attachment, pure-file, restart/warm-reattach, queued-turn advance, and
 * `TurnSendLedger` crash-replay recovery paths.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import {
  __testOnly_resetManagedOriginRuntimeAuthState,
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import { config } from '../src/config.js';
import {
  buildRelayedTurnReplyPortCandidates,
  chunkRelayedTurnReplies,
  postRelayedTurnReplies as postRelayedTurnRepliesBase,
  recordStructuredTurnRepliesWithFallback,
  signRelayedTurnReplyResponse,
  RELAYED_TURN_REPLY_HEADERS,
  RELAYED_TURN_REPLY_MAX_ITEMS,
  SESSION_TURN_REPLY_RAW_TEXT_CAP,
  type PostRelayedTurnRepliesOptions,
  type RelayedTurnReplyClientClaim,
} from '../src/core/relayed-turn-reply.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import { ReplyDeliveryStore } from '../src/services/reply-delivery-store.js';
import {
  projectLarkTurnInbound,
  readSessionTurns,
  recordSessionTurnInput,
  stageSessionTurnInbound,
  type SessionTurnReply,
} from '../src/services/session-turns.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'cli-send-turn-reply-secret';
const CAP_1 = '11aa22bb'.repeat(8);
const CAP_2 = '33cc44dd'.repeat(8);

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runFixtureAsync(args: string[], env: Record<string, string | undefined>): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(FIXTURE, args, {
      cwd: REPO_ROOT,
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { stdout += String(d); });
    child.stderr?.on('data', d => { stderr += String(d); });
    child.on('error', reject);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* */ }
      reject(new Error(`fixture timed out after 30s; stderr=${stderr}`));
    }, 30_000);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function postRelayedForTest(
  opts: PostRelayedTurnRepliesOptions,
  signResponses: boolean | ((input: Parameters<PostRelayedTurnRepliesOptions['postBatch']>[0]) => boolean) = true,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return postRelayedTurnRepliesBase({
    readHostSecret: () => SECRET,
    preferCapability: true,
    ...opts,
    postBatch: async input => {
      const res = await opts.postBatch(input);
      const shouldSign = typeof signResponses === 'function' ? signResponses(input) : signResponses;
      if (!shouldSign) return res;
      const raw = await res.clone().text();
      const material = input.keyKind === 'capability' ? input.claim?.capability : SECRET;
      if (!material) return res;
      const headers = new Headers(res.headers);
      headers.set(RELAYED_TURN_REPLY_HEADERS.responseProof, signRelayedTurnReplyResponse({
        key: { kind: input.keyKind, material },
        sessionId: input.sessionId,
        turnId: input.headers[RELAYED_TURN_REPLY_HEADERS.turnId]!,
        ...(input.headers[RELAYED_TURN_REPLY_HEADERS.dispatchAttempt]
          ? { dispatchAttempt: Number(input.headers[RELAYED_TURN_REPLY_HEADERS.dispatchAttempt]) }
          : {}),
        requestNonce: input.payload.requestNonce,
        status: res.status,
        raw,
      }));
      return new Response(raw, { status: res.status, headers });
    },
  });
}

describe('relayed turn-reply client helpers (deterministic fake clock)', () => {
  it('keeps unsandboxed local writes and clean ENOENT no-ops at 0 IPC calls, falling back only on error or mustProxy', async () => {
    const sample: SessionTurnReply[] = [{ messageId: 'om_1', responseKind: 'final', at: 1000, text: 'hi' }];
    const postRelay = vi.fn(async () => ({ ok: true as const }));

    const localOk = await recordStructuredTurnRepliesWithFallback({
      sessionId: 'sess-a',
      turnId: 'turn-1',
      replies: sample,
      mustProxy: false,
      recordLocal: () => ({ staged: true, recorded: 1, duplicates: 0, recordedTextChars: 2 }),
      postRelay,
    });
    expect(localOk).toEqual({ ok: true, mode: 'local' });
    expect(postRelay).not.toHaveBeenCalled();

    const localEnoent = await recordStructuredTurnRepliesWithFallback({
      sessionId: 'sess-a',
      turnId: 'turn-1',
      replies: sample,
      mustProxy: false,
      recordLocal: () => ({ staged: false, recorded: 0, duplicates: 0, recordedTextChars: 0 }),
      postRelay,
    });
    expect(localEnoent).toEqual({ ok: true, mode: 'local' });
    expect(postRelay).not.toHaveBeenCalled();

    // Local permission/squat error transparently falls back to Daemon IPC.
    const localDenied = await recordStructuredTurnRepliesWithFallback({
      sessionId: 'sess-a',
      turnId: 'turn-1',
      replies: sample,
      mustProxy: false,
      recordLocal: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
      postRelay,
    });
    expect(localDenied).toEqual({ ok: true, mode: 'ipc' });
    expect(postRelay).toHaveBeenCalledTimes(1);

    // mustProxy skips local touch completely (vital for Linux bwrap where existsSync/lstatSync would see ENOENT).
    const recordLocal = vi.fn(() => ({ staged: false, recorded: 0, duplicates: 0, recordedTextChars: 0 }));
    const proxied = await recordStructuredTurnRepliesWithFallback({
      sessionId: 'sess-a',
      turnId: 'turn-1',
      replies: sample,
      mustProxy: true,
      recordLocal,
      postRelay,
    });
    expect(proxied).toEqual({ ok: true, mode: 'ipc' });
    expect(recordLocal).not.toHaveBeenCalled();
    expect(postRelay).toHaveBeenCalledTimes(2);
  });

  it('pre-slices >256KiB text and chunks >64 replies while deduplicating port candidates in precedence order', () => {
    const huge = '字'.repeat(SESSION_TURN_REPLY_RAW_TEXT_CAP + 5000);
    const items: SessionTurnReply[] = [
      { messageId: 'om_0', responseKind: 'final', at: 100, text: huge },
      ...Array.from({ length: RELAYED_TURN_REPLY_MAX_ITEMS + 2 }, (_, i) => ({
        messageId: `om_a_${i}`,
        responseKind: 'final' as const,
        at: 100,
      })),
    ];
    const batches = chunkRelayedTurnReplies(items);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(RELAYED_TURN_REPLY_MAX_ITEMS);
    expect(batches[0]![0]!.text!.length).toBe(SESSION_TURN_REPLY_RAW_TEXT_CAP);
    expect(batches[1]).toHaveLength(3);
    expect(buildRelayedTurnReplyPortCandidates([undefined, 9001, 9002, 9001, 0, -1, 70000, 9003]))
      .toEqual([9001, 9002, 9003]);
  });

  it('recovers across daemon port drift + batched worker warm-reattach 403 window via fake clock', async () => {
    let fakeNow = 10_000;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      fakeNow += ms;
      // Worker finishes warm-reattach during the first backoff sleep and rotates capability + port.
      if (sleeps.length === 1) {
        currentClaim = { capability: CAP_2, turnId: 'turn-1', ipcPort: 9102 };
      }
    };
    let currentClaim: RelayedTurnReplyClientClaim | null = { capability: CAP_1, turnId: 'turn-1', ipcPort: 9101 };
    const calls: Array<{ port: number; cap?: string }> = [];

    const outcome = await postRelayedForTest({
      sessionId: 'sess-a',
      expectedTurnId: 'turn-1',
      replies: [{ messageId: 'om_1', responseKind: 'final', at: 10_000, text: 'ok' }],
      readClaim: () => currentClaim,
      resolvePorts: claim => [claim?.ipcPort, 9102],
      now: () => fakeNow,
      sleep,
      postBatch: async ({ ipcPort, claim }) => {
        calls.push({ port: ipcPort, cap: claim?.capability });
        if (ipcPort === 9101) throw new Error('connect ECONNREFUSED 127.0.0.1:9101');
        if (claim?.capability === CAP_1) return jsonResponse(403, { ok: false, error: 'origin_unproven' });
        return jsonResponse(200, { ok: true, recorded: 1, duplicates: 0, staged: true });
      },
    });

    expect(outcome).toEqual({ ok: true });
    expect(calls).toEqual([
      { port: 9101, cap: CAP_1 }, // old port ECONNREFUSED -> rolls over immediately
      { port: 9102, cap: CAP_1 }, // new port 403 while worker reattaching -> backs off
      { port: 9102, cap: CAP_2 }, // rotated capability succeeds
    ]);
    expect(sleeps).toEqual([250]);
  });

  it('retries immediately with 0ms sleep on same-turn capability rotation and aborts immediately on revoked or rotated-to-next-turn 403', async () => {
    let fakeNow = 50_000;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); fakeNow += ms; };

    // Case 1: capability already rotated for SAME turn when 403 arrives -> 0ms immediate retry.
    let readCount = 0;
    const immediate = await postRelayedForTest({
      sessionId: 'sess-a',
      expectedTurnId: 'turn-1',
      replies: [{ messageId: 'om_1', responseKind: 'final', at: 50_000 }],
      readClaim: () => (++readCount === 1
        ? { capability: CAP_1, turnId: 'turn-1', ipcPort: 9200 }
        : { capability: CAP_2, turnId: 'turn-1', ipcPort: 9200 }),
      resolvePorts: claim => [claim?.ipcPort],
      now: () => fakeNow,
      sleep,
      postBatch: async ({ claim }) => claim?.capability === CAP_1
        ? jsonResponse(403, { ok: false, error: 'origin_unproven' })
        : jsonResponse(200, { ok: true, recorded: 1, duplicates: 0, staged: true }),
    });
    expect(immediate).toEqual({ ok: true });
    expect(sleeps).toEqual([]);

    // Case 2: capability unlinked on revocation -> immediate terminal stop with 0 sleeps.
    let unlinkedRead = 0;
    const revoked = await postRelayedForTest({
      sessionId: 'sess-a',
      expectedTurnId: 'turn-1',
      replies: [{ messageId: 'om_2', responseKind: 'final', at: 50_000 }],
      readClaim: () => (++unlinkedRead === 1 ? { capability: CAP_1, turnId: 'turn-1', ipcPort: 9200 } : null),
      resolvePorts: claim => [claim?.ipcPort ?? 9200],
      now: () => fakeNow,
      sleep,
      postBatch: async () => jsonResponse(403, { ok: false, error: 'origin_unproven' }),
    });
    expect(revoked).toEqual({ ok: false, error: 'origin_unproven' });
    expect(sleeps).toEqual([]);

    // Case 3: capability rotated to Turn N+1 -> immediate terminal stop with 0 sleeps.
    let rotatedNextRead = 0;
    const nextTurn = await postRelayedForTest({
      sessionId: 'sess-a',
      expectedTurnId: 'turn-1',
      replies: [{ messageId: 'om_3', responseKind: 'final', at: 50_000 }],
      readClaim: () => (++rotatedNextRead === 1
        ? { capability: CAP_1, turnId: 'turn-1', ipcPort: 9200 }
        : { capability: CAP_2, turnId: 'turn-2', ipcPort: 9200 }),
      resolvePorts: claim => [claim?.ipcPort],
      now: () => fakeNow,
      sleep,
      postBatch: async () => jsonResponse(403, { ok: false, error: 'origin_unproven' }),
    });
    expect(nextTurn).toEqual({ ok: false, error: 'origin_unproven' });
    expect(sleeps).toEqual([]);
  });

  it('retries trusted-host 409 turn_unbound and 429 rate-limit, while stopping immediately on 409 turn_mismatch and 429 quota_exceeded', async () => {
    let fakeNow = 80_000;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); fakeNow += ms; };

    let attempt = 0;
    const okAfterUnbound = await postRelayedForTest({
      sessionId: 'sess-a',
      expectedTurnId: 'turn-1',
      replies: [{ messageId: 'om_1', responseKind: 'final', at: 80_000 }],
      readClaim: () => null,
      resolvePorts: () => [9300],
      allowTurnUnboundRetry: true,
      now: () => fakeNow,
      sleep,
      postBatch: async () => {
        attempt += 1;
        if (attempt === 1) return jsonResponse(409, { ok: false, error: 'turn_unbound' });
        if (attempt === 2) return jsonResponse(429, { ok: false, error: 'turn_reply_rate_limited' });
        return jsonResponse(200, { ok: true, recorded: 1, duplicates: 0, staged: true });
      },
    });
    expect(okAfterUnbound).toEqual({ ok: true });
    expect(sleeps).toEqual([250, 500]);

    sleeps.length = 0;
    const mismatch = await postRelayedForTest({
      sessionId: 'sess-a',
      expectedTurnId: 'turn-1',
      replies: [{ messageId: 'om_2', responseKind: 'final', at: 80_000 }],
      readClaim: () => null,
      resolvePorts: () => [9300],
      allowTurnUnboundRetry: true,
      now: () => fakeNow,
      sleep,
      postBatch: async () => jsonResponse(409, { ok: false, error: 'turn_mismatch' }),
    });
    expect(mismatch).toEqual({ ok: false, error: 'turn_mismatch' });
    expect(sleeps).toEqual([]);

    const quota = await postRelayedForTest({
      sessionId: 'sess-a',
      expectedTurnId: 'turn-1',
      replies: [{ messageId: 'om_3', responseKind: 'final', at: 80_000 }],
      readClaim: () => null,
      resolvePorts: () => [9300],
      now: () => fakeNow,
      sleep,
      postBatch: async () => jsonResponse(429, { ok: false, error: 'turn_reply_quota_exceeded' }),
    });
    expect(quota).toEqual({ ok: false, error: 'turn_reply_quota_exceeded' });
    expect(sleeps).toEqual([]);
  });

  it('fails over across sibling reused ports on 403/404/401/503 and prevents trailing 404 from downgrading retryable 503', async () => {
    let fakeNow = 90_000;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); fakeNow += ms; };

    for (const staleStatus of [403, 404, 401, 503] as const) {
      const visited: number[] = [];
      const res = await postRelayedForTest({
        sessionId: 'sess-a',
        expectedTurnId: 'turn-1',
        replies: [{ messageId: 'om_failover', responseKind: 'final', at: 90_000 }],
        readClaim: () => ({ capability: CAP_1, turnId: 'turn-1', ipcPort: 9401 }),
        resolvePorts: () => [9401, 9402],
        now: () => fakeNow,
        sleep,
        postBatch: async ({ ipcPort }) => {
          visited.push(ipcPort);
          if (ipcPort === 9401) {
            return jsonResponse(staleStatus, { ok: false, error: staleStatus === 403 ? 'origin_unproven' : 'session_not_active' });
          }
          return jsonResponse(200, { ok: true, recorded: 1, duplicates: 0, staged: true });
        },
      });
      expect(res).toEqual({ ok: true });
      expect(visited).toEqual([9401, 9402]);
    }
    expect(sleeps).toEqual([]);

    // Trailing stale port returning 404 MUST NOT mask an earlier live port's retryable 503.
    let liveAttempts = 0;
    const preserved = await postRelayedForTest({
      sessionId: 'sess-a',
      expectedTurnId: 'turn-1',
      replies: [{ messageId: 'om_preserve', responseKind: 'final', at: 90_000 }],
      readClaim: () => null,
      resolvePorts: () => [9410, 9411],
      now: () => fakeNow,
      sleep,
      postBatch: async ({ ipcPort }) => {
        if (ipcPort === 9410) {
          liveAttempts += 1;
          return liveAttempts === 1
            ? jsonResponse(503, { ok: false, error: 'starting' })
            : jsonResponse(200, { ok: true, recorded: 1, duplicates: 0, staged: true });
        }
        return jsonResponse(404, { ok: false, error: 'session_not_active' });
      },
    });
    expect(preserved).toEqual({ ok: true });
    expect(sleeps).toEqual([250]);
  });

  it('skips useless sleeps at deadline boundary and still retries transient 403 when claim.turnId is undefined', async () => {
    let fakeNow = 100_000;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); fakeNow += ms; };

    // Deadline = 200ms, first backoff = 250ms -> must abort without sleeping into expired deadline.
    let calls = 0;
    const expired = await postRelayedForTest({
      sessionId: 'sess-a',
      expectedTurnId: 'turn-1',
      replies: [{ messageId: 'om_deadline', responseKind: 'final', at: 100_000 }],
      readClaim: () => null,
      resolvePorts: () => [9500],
      deadlineMs: 200,
      backoffMs: [0, 250, 500],
      now: () => fakeNow,
      sleep,
      postBatch: async () => {
        calls += 1;
        return jsonResponse(503, { ok: false, error: 'busy' });
      },
    });
    expect(expired).toEqual({ ok: false, error: 'busy' });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);

    // Capability without turnId (pre-turn-binding) getting transient 403 still backs off and succeeds.
    let claimState: RelayedTurnReplyClientClaim = { capability: CAP_1, ipcPort: 9501 };
    const noTurnSleeps: number[] = [];
    const ok = await postRelayedForTest({
      sessionId: 'sess-a',
      expectedTurnId: 'turn-1',
      replies: [{ messageId: 'om_noturn', responseKind: 'final', at: 100_000 }],
      readClaim: () => claimState,
      resolvePorts: claim => [claim?.ipcPort],
      now: () => fakeNow,
      sleep: async ms => {
        noTurnSleeps.push(ms);
        fakeNow += ms;
        claimState = { capability: CAP_2, turnId: 'turn-1', ipcPort: 9501 };
      },
      postBatch: async ({ claim }) => claim?.capability === CAP_1
        ? jsonResponse(403, { ok: false, error: 'origin_unproven' })
        : jsonResponse(200, { ok: true, recorded: 1, duplicates: 0, staged: true }),
    });
    expect(ok).toEqual({ ok: true });
    expect(noTurnSleeps).toEqual([250]);
  });
  it('never exposes bearer capability or plaintext to candidate listeners and rejects an unsigned forged 200', async () => {
    const seen: Array<{ headers: Record<string, string>; body: string }> = [];
    const outcome = await postRelayedForTest({
      sessionId: 'sess-a',
      expectedTurnId: 'turn-1',
      replies: [{ messageId: 'om_secret', responseKind: 'final', at: 100_000, text: 'private reply body' }],
      readClaim: () => ({ capability: CAP_1, turnId: 'turn-1', dispatchAttempt: 1, ipcPort: 9401 }),
      resolvePorts: () => [9401, 9402],
      postBatch: async ({ ipcPort, headers, payload }) => {
        seen.push({ headers, body: JSON.stringify(payload) });
        return ipcPort === 9401
          ? jsonResponse(403, { ok: false, error: 'origin_unproven' })
          : jsonResponse(200, { ok: true, recorded: 1, duplicates: 0, staged: true });
      },
    }, input => input.ipcPort === 9402);

    expect(outcome).toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(request.body).not.toContain('private reply body');
      expect(request.body).not.toContain(CAP_1);
      for (const value of Object.values(request.headers)) expect(value).not.toContain(CAP_1);
      expect(request.headers['x-botmux-origin-capability']).toBeUndefined();
      expect(request.headers[RELAYED_TURN_REPLY_HEADERS.requestProof]).toMatch(/^[a-f0-9]{64}$/);
    }

    const forged = await postRelayedForTest({
      sessionId: 'sess-a',
      expectedTurnId: 'turn-1',
      replies: [{ messageId: 'om_forged_ack', responseKind: 'final', at: 100_000, text: 'still private' }],
      readClaim: () => ({ capability: CAP_1, turnId: 'turn-1', ipcPort: 9401 }),
      resolvePorts: () => [9401],
      backoffMs: [0],
      postBatch: async () => jsonResponse(200, { ok: true, recorded: 1, duplicates: 0, staged: true }),
    }, false);
    expect(forged).toEqual({ ok: false, error: 'unauthenticated_ipc_response' });
  });
});

describe('real botmux send -> host Daemon IPC / local SQLite end-to-end', () => {
  let handle: IpcServerHandle | null = null;
  let root: string | null = null;
  let prevDataDir: string | null = null;

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    setIpcAuthSecret(null);
    __testOnly_resetManagedOriginRuntimeAuthState();
    if (prevDataDir !== null) config.session.dataDir = prevDataDir;
    prevDataDir = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
    vi.restoreAllMocks();
  });

  async function createHarness(opts: {
    sessionId: string;
    turnId: string;
    squatSessionTurns: boolean;
    queuedTurnId?: string;
    startServer?: boolean;
  }) {
    root = mkdtempSync(join(tmpdir(), 'botmux-send-turn-reply-'));
    const hostDataDir = join(root, 'host-data');
    const clientDataDir = opts.squatSessionTurns ? join(root, 'client-data') : hostDataDir;
    const clientHome = join(root, 'client-home');
    mkdirSync(hostDataDir, { recursive: true });
    mkdirSync(clientDataDir, { recursive: true });
    mkdirSync(clientHome, { recursive: true });

    const appId = 'cli_test_relay';
    const botsConfig = join(root, 'bots.json');
    writeFileSync(botsConfig, JSON.stringify([{
      larkAppId: appId,
      larkAppSecret: 'test-secret',
      cliId: 'claude-code',
    }]));

    const sessionRow = {
      larkAppId: appId,
      sessionId: opts.sessionId,
      status: 'active',
      cliId: 'claude-code',
      chatId: 'oc_test',
      rootMessageId: opts.turnId,
      scope: 'thread',
      chatType: 'group',
      workingDir: root,
    };
    seedPersistedSessionRows(clientDataDir, appId, { [opts.sessionId]: sessionRow });
    if (clientDataDir !== hostDataDir) {
      seedPersistedSessionRows(hostDataDir, appId, { [opts.sessionId]: sessionRow });
    }

    stageSessionTurnInbound(hostDataDir, opts.sessionId, opts.turnId, projectLarkTurnInbound({
      messageId: opts.turnId,
      rootId: opts.turnId,
      senderId: 'ou_user',
      senderType: 'user',
      createTime: '0',
      msgType: 'text',
      content: '请处理任务',
    }, [], opts.turnId, 'User'));
    recordSessionTurnInput({
      dataDir: hostDataDir,
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      input: '请处理任务',
      cliId: 'claude-code',
      at: Date.now() - 1_000,
    });

    if (opts.squatSessionTurns) {
      // Simulate confined sandbox where `<DATA_DIR>/session-turns` is unreachable/unwritable (ENOTDIR),
      // and `.dashboard-secret` is absent under clientHome so auth MUST use rotating capability.
      writeFileSync(join(clientDataDir, 'session-turns'), 'host-only-masked');
    }

    const procStart = readProcessStartIdentity(process.pid);
    mkdirSync(join(clientDataDir, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(clientDataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      capability: CAP_1,
      ...(procStart ? { procStart } : {}),
      ...(opts.queuedTurnId ? { queuedTurnId: opts.queuedTurnId, queuedTurns: [{ turnId: opts.queuedTurnId }] } : {}),
    }));

    const liveDs = {
      session: { ...sessionRow },
      worker: { killed: false, connected: true, send: vi.fn() },
      larkAppId: appId,
      chatId: 'oc_test',
      chatType: 'group',
      managedTurnOrigin: { capability: CAP_1, turnId: opts.turnId },
    };

    prevDataDir = config.session.dataDir;
    config.session.dataDir = hostDataDir;
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(
      (id: string) => (id === opts.sessionId ? liveDs as any : undefined),
    );
    setIpcAuthSecret(SECRET);
    if (opts.startServer !== false) {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    }

    const env = (portOverride?: number): Record<string, string | undefined> => ({
      PATH: process.env.PATH,
      HOME: clientHome,
      SESSION_DATA_DIR: clientDataDir,
      BOTS_CONFIG: botsConfig,
      BOTMUX_SESSION_ID: opts.sessionId,
      BOTMUX_TURN_ID: opts.turnId,
      BOTMUX_LARK_APP_ID: appId,
      BOTMUX_DAEMON_IPC_PORT: String(portOverride ?? handle?.port ?? 1),
      BOTMUX_TEST_DISTINCT_MESSAGE_IDS: '1',
    });

    return { root, hostDataDir, clientDataDir, findSpy, liveDs, env };
  }

  it('proxies primary + multi-attachment receipts through Daemon IPC with 0 stderr warnings and advances queued turn only AFTER attachments finish', async () => {
    const h = await createHarness({
      sessionId: 'sess_sandbox_multi',
      turnId: 'om_turn_multi',
      squatSessionTurns: true,
      queuedTurnId: 'om_turn_next',
    });
    const f1 = join(h.root, 'a.txt');
    const f2 = join(h.root, 'b.txt');
    writeFileSync(f1, 'file one');
    writeFileSync(f2, 'file two');

    const res = await runFixtureAsync(
      ['send', '--no-mention', '--response-kind', 'final', '结果见 /Users/alice/report.md', '--files', f1, '--files', f2],
      h.env(),
    );
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).not.toContain('could not record structured reply');

    const turns = readSessionTurns(h.hostDataDir, 'sess_sandbox_multi', 0, 50).turns;
    expect(turns).toHaveLength(1);
    const replies = turns[0]!.replies;
    expect(replies).toHaveLength(3);
    expect(replies[0]).toMatchObject({
      messageId: 'om_sent_1',
      responseKind: 'final',
      text: '结果见 <redacted>',
    });
    expect(replies[1]).toMatchObject({ messageId: 'om_sent_2', responseKind: 'final' });
    expect('text' in replies[1]!).toBe(false);
    expect(replies[2]).toMatchObject({ messageId: 'om_sent_3', responseKind: 'final' });
    expect('text' in replies[2]!).toBe(false);

    // Ancestor pid marker must have advanced to queued turn AFTER attachments + receipts finished.
    const markerAfter = JSON.parse(
      readFileSync(join(h.clientDataDir, '.botmux-cli-pids', String(process.pid)), 'utf8'),
    );
    expect(markerAfter.turnId).toBe('om_turn_next');
  }, 35_000);

  it('records single-file pureFileSend once via Daemon IPC without duplicate receipt or text', async () => {
    const h = await createHarness({
      sessionId: 'sess_sandbox_file',
      turnId: 'om_turn_file',
      squatSessionTurns: true,
    });
    const f1 = join(h.root, 'only.txt');
    writeFileSync(f1, 'single file payload');

    const res = await runFixtureAsync(
      ['send', '--no-mention', '--response-kind', 'final', '--files', f1],
      h.env(),
    );
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).not.toContain('could not record structured reply');

    const replies = readSessionTurns(h.hostDataDir, 'sess_sandbox_file', 0, 50).turns[0]?.replies ?? [];
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ messageId: 'om_sent_1', responseKind: 'final' });
    expect('text' in replies[0]!).toBe(false);
  }, 35_000);

  it('keeps unsandboxed writable turns.sqlite direct with 0 Daemon IPC calls', async () => {
    const h = await createHarness({
      sessionId: 'sess_unsandboxed',
      turnId: 'om_turn_direct',
      squatSessionTurns: false,
    });

    const res = await runFixtureAsync(
      ['send', '--no-mention', '--response-kind', 'final', '直写验证'],
      h.env(),
    );
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).not.toContain('could not record structured reply');
    expect(h.findSpy).not.toHaveBeenCalled();

    const replies = readSessionTurns(h.hostDataDir, 'sess_unsandboxed', 0, 50).turns[0]?.replies ?? [];
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ messageId: 'om_sent_1', responseKind: 'final', text: '直写验证' });
  }, 35_000);

  it('records readable --card-file final card text through Daemon IPC, scrubbed', async () => {
    const h = await createHarness({
      sessionId: 'sess_card_file',
      turnId: 'om_turn_card_file',
      squatSessionTurns: true,
    });
    const cardPath = join(h.root, 'cart-cashback-card.json');
    writeFileSync(cardPath, JSON.stringify({
      schema: '2.0',
      header: {
        title: { tag: 'plain_text', content: '购物车返现' },
        subtitle: { tag: 'plain_text', content: '已完成核算' },
      },
      body: { elements: [
        { tag: 'markdown', content: "共返现 <font color='green'>**$4.70**</font>，凭据 Bearer abcDEF123456.secret" },
        {
          tag: 'table',
          columns: [{ name: 'sku', display_name: 'SKU' }, { name: 'cb', display_name: '返现' }],
          rows: [{ sku: 'A-1', cb: '$1.20' }],
        },
        {
          tag: 'collapsible_panel',
          header: { title: { tag: 'markdown', content: '计算明细' } },
          elements: [{ tag: 'markdown', content: '满减后再按 5% 计算' }],
        },
      ] },
    }));

    const res = await runFixtureAsync(
      ['send', '--card-file', cardPath, '--response-kind', 'final', '--no-mention'],
      h.env(),
    );
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).not.toContain('could not record structured reply');

    const replies = readSessionTurns(h.hostDataDir, 'sess_card_file', 0, 50).turns[0]?.replies ?? [];
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ messageId: 'om_sent_1', responseKind: 'final' });
    expect(replies[0]!.text).toBe([
      '[卡片: 购物车返现]',
      '已完成核算',
      '共返现 **$4.70**，凭据 <redacted>',
      '',
      '| SKU | 返现 |\n| --- | --- |\n| A-1 | $1.20 |',
      '',
      '计算明细',
      '满减后再按 5% 计算',
    ].join('\n'));
  }, 35_000);

  it('records readable --card-json progress card text directly, and omits text for a card with none', async () => {
    const h = await createHarness({
      sessionId: 'sess_card_json',
      turnId: 'om_turn_card_json',
      squatSessionTurns: false,
    });

    const res = await runFixtureAsync(['send', '--no-mention', '--response-kind', 'progress', '--card-json', JSON.stringify({
      header: { title: { tag: 'plain_text', content: '进度' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '已处理 2/3' } },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '预计 1 分钟' }] },
      ],
    })], h.env());
    expect(res.code, res.stderr).toBe(0);
    const empty = await runFixtureAsync(['send', '--no-mention', '--response-kind', 'progress', '--card-json', JSON.stringify({
      schema: '2.0',
      body: { elements: [{ tag: 'hr' }] },
    })], h.env());
    expect(empty.code, empty.stderr).toBe(0);
    expect(empty.stderr).not.toContain('could not record structured reply');

    const replies = readSessionTurns(h.hostDataDir, 'sess_card_json', 0, 50).turns[0]?.replies ?? [];
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({
      messageId: 'om_sent_1',
      responseKind: 'progress',
      text: '[卡片: 进度]\n已处理 2/3\n预计 1 分钟',
    });
    // Each fixture process restarts its message-id counter; the second send is
    // a distinct event because its `at` differs.
    expect(replies[1]).toMatchObject({ messageId: 'om_sent_1', responseKind: 'progress' });
    expect(replies[1]!.at).toBeGreaterThan(replies[0]!.at);
    expect('text' in replies[1]!).toBe(false);
  }, 35_000);

  it('heals a missing structured receipt on TurnSendLedger final replay with exact sentAtMs and zero duplicates', async () => {
    // Run 1: daemon IPC unavailable -> Lark delivers & TurnSendLedger persists final with exact sentAtMs,
    // while structured receipt cannot reach host turns.sqlite yet.
    const h = await createHarness({
      sessionId: 'sess_replay_heal',
      turnId: 'om_turn_heal',
      squatSessionTurns: true,
      startServer: false,
    });
    // Pick an unreachable ephemeral port for run 1 (open then immediately close to find a free unused port).
    const tempServer = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const deadPort = tempServer.port;
    await tempServer.close();

    const run1 = await runFixtureAsync(
      ['send', '--no-mention', '--response-kind', 'final', '崩后补记正文'],
      h.env(deadPort),
    );
    expect(run1.code, run1.stderr).toBe(0);
    expect(run1.stderr).toContain('could not record structured reply');
    expect(readSessionTurns(h.hostDataDir, 'sess_replay_heal', 0, 50).turns[0]?.replies).toEqual([]);

    // Run 2: daemon is back up -> replay hits TurnSendLedger (0 Lark POSTs) and heals turns.sqlite via IPC.
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const run2 = await runFixtureAsync(
      ['send', '--no-mention', '--response-kind', 'final', '崩后补记正文'],
      h.env(handle.port),
    );
    expect(run2.code, run2.stderr).toBe(0);
    expect(run2.stderr).not.toContain('could not record structured reply');
    expect(run2.stdout).not.toContain('CAPTURE_REPLY=');
    const afterHeal = readSessionTurns(h.hostDataDir, 'sess_replay_heal', 0, 50).turns[0]?.replies ?? [];
    expect(afterHeal).toHaveLength(1);
    expect(afterHeal[0]).toMatchObject({
      messageId: 'om_sent_1',
      responseKind: 'final',
      text: '崩后补记正文',
    });
    const healedAt = afterHeal[0]!.at;

    // Run 3: repeating replay preserves exact sentAtMs -> idempotent INSERT OR IGNORE, still 1 reply.
    const run3 = await runFixtureAsync(
      ['send', '--no-mention', '--response-kind', 'final', '崩后补记正文'],
      h.env(handle.port),
    );
    expect(run3.code, run3.stderr).toBe(0);
    expect(run3.stderr).not.toContain('could not record structured reply');
    const afterThird = readSessionTurns(h.hostDataDir, 'sess_replay_heal', 0, 50).turns[0]?.replies ?? [];
    expect(afterThird).toHaveLength(1);
    expect(afterThird[0]!.at).toBe(healedAt);
  }, 45_000);

  it('heals BOTH primary and already-delivered ReplyDeliveryStore attachment receipts on TurnSendLedger replay, and authenticates via capability even with a mismatched .dashboard-secret', async () => {
    const h = await createHarness({
      sessionId: 'sess_replay_att',
      turnId: 'om_turn_att_heal',
      squatSessionTurns: true,
      startServer: false,
    });
    // Plant a mismatched `.dashboard-secret` in client HOME to verify capability headers are still sent.
    mkdirSync(join(h.root, 'client-home', '.botmux'), { recursive: true });
    writeFileSync(join(h.root, 'client-home', '.botmux', '.dashboard-secret'), 'wrong-secret-for-different-daemon');

    const f1 = join(h.root, 'att1.txt');
    const f2 = join(h.root, 'att2.txt');
    writeFileSync(f1, 'one');
    writeFileSync(f2, 'two');

    // Run 1 with unreachable daemon: delivers primary + 2 attachments to Lark and records ReplyDeliveryStore + TurnSendLedger.
    const tempServer = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const deadPort = tempServer.port;
    await tempServer.close();

    const run1 = await runFixtureAsync(
      ['send', '--no-mention', '--response-kind', 'final', '正文带双附件', '--files', f1, '--files', f2],
      h.env(deadPort),
    );
    expect(run1.code, run1.stderr).toBe(0);
    expect(readSessionTurns(h.hostDataDir, 'sess_replay_att', 0, 50).turns[0]?.replies).toEqual([]);

    // Run 2 with daemon back up: replays without calling Lark, authenticates via capability headers despite mismatched secret,
    // and heals primary + BOTH companion attachments in one batch.
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const run2 = await runFixtureAsync(
      ['send', '--no-mention', '--response-kind', 'final', '正文带双附件', '--files', f1, '--files', f2],
      h.env(handle.port),
    );
    expect(run2.code, run2.stderr).toBe(0);
    expect(run2.stderr).not.toContain('could not record structured reply');
    expect(run2.stdout).not.toContain('CAPTURE_REPLY=');

    const replies = readSessionTurns(h.hostDataDir, 'sess_replay_att', 0, 50).turns[0]?.replies ?? [];
    expect(replies).toHaveLength(3);
    expect(replies[0]).toMatchObject({ messageId: 'om_sent_1', responseKind: 'final', text: '正文带双附件' });
    expect(replies[1]).toMatchObject({ messageId: 'om_sent_2', responseKind: 'final' });
    expect(replies[2]).toMatchObject({ messageId: 'om_sent_3', responseKind: 'final' });
  }, 45_000);

  it('keeps the original attachment index when a middle pure-video upload fails', async () => {
    const h = await createHarness({
      sessionId: 'sess_video_partial',
      turnId: 'om_turn_video_partial',
      squatSessionTurns: false,
      startServer: false,
    });
    const args = ['send', '--no-mention', '--response-kind', 'final'];
    for (const name of ['A', 'B', 'C']) {
      const video = join(h.root, `${name}.mp4`);
      const cover = join(h.root, `${name}-cover.png`);
      writeFileSync(video, `video-${name}`);
      writeFileSync(cover, `cover-${name}`);
      args.push('--videos', video, '--video-covers', cover);
    }

    const res = await runFixtureAsync(args, {
      ...h.env(),
      BOTMUX_TEST_ALLOW_IMAGE_UPLOAD: '1',
      BOTMUX_TEST_FAIL_FILE_UPLOAD_SEQUENCE: '2',
    });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain('B.mp4');

    const delivery = new ReplyDeliveryStore(h.hostDataDir).read('cli_test_relay', 'om_sent_1', 'oc_test');
    expect(delivery?.attachments).toHaveLength(1);
    expect(delivery?.attachments[0]).toMatchObject({
      name: 'C.mp4',
      status: 'sent',
      messageId: 'om_sent_2',
    });
  }, 35_000);
});
