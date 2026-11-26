import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  create: vi.fn(),
  reply: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  upload: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    request = mocks.request;
    im = {
      v1: {
        message: {
          create: mocks.create,
          reply: mocks.reply,
          patch: mocks.patch,
          delete: mocks.delete,
        },
        file: { create: mocks.upload },
        chat: { get: async () => ({ code: 0, data: { chat_mode: 'group' } }) },
      },
    };
  },
}));

import {
  CARD_POSTING_SENTINEL,
  __testOnly_setupWorkerHandlers as setupWorkerHandlers,
  closeSession,
  getActiveSessionsRegistry,
  initWorkerPool,
  parkStreamCard,
  postFreshStreamingCard,
  postTurnStartingCard,
  scheduleCardPatch,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import { reconcileResumedStreamingCard } from '../src/core/resume-streaming-card.js';
import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import * as sessionStore from '../src/services/session-store.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { __testOnly_activeSessions as activeSessions, __testOnly_sessionReply as sessionReply } from '../src/daemon.js';
import { __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';
import { STREAM_STATUS_TEMPLATE_MAP } from '../src/im/lark/stream-status-palette.js';
import {
  FEISHU_UUID_MAX_LEN,
  FEISHU_UUID_PATTERN,
  invalidateTurnStreamingCardPostSlot,
} from '../src/core/streaming-card-post-slot.js';

const APP = 'cli_stream_card_uuid_int';
const CHAT = 'oc_stream_uuid_chat';
const ROOT = 'om_stream_uuid_root';

const oldDataDir = config.session.dataDir;
const originalRegistry = getActiveSessionsRegistry();

type StoredFeishuMessage = {
  messageId: string;
  endpoint: 'create' | 'reply';
  destination: string;
  replyInThread?: boolean;
  uuid: string;
  content: string;
  deleted: boolean;
};

type WireAttempt = {
  endpoint: 'create' | 'reply';
  destination: string;
  replyInThread?: boolean;
  uuid: string;
  content: string;
  cardNonce?: string;
  outcome: 'ok' | 'dedup_ok' | 'http500_after_commit' | 'http400' | 'withdrawn';
  messageId?: string;
};

function extractCardNonce(cardJson: string): string | undefined {
  const m = /"card_nonce":"([^"]+)"/.exec(cardJson);
  return m?.[1];
}

function extractCardTemplate(cardJson: string): string | undefined {
  try {
    return JSON.parse(cardJson)?.header?.template;
  } catch {
    return undefined;
  }
}

function makeAxios500Code2200(): Error {
  return Object.assign(new Error('Request failed with status code 500'), {
    isAxiosError: true,
    response: {
      status: 500,
      data: { code: 2200, msg: 'internal error' },
    },
  });
}

function makeAxios400Deterministic(): Error {
  return Object.assign(new Error('Request failed with status code 400'), {
    isAxiosError: true,
    response: {
      status: 400,
      data: { code: 230099, msg: 'card build failed' },
    },
  });
}

function makeAxiosWithdrawn(code = 230011): Error {
  return Object.assign(new Error(`lark code ${code}`), {
    isAxiosError: true,
    response: {
      status: 400,
      data: { code, msg: code === 230031 ? 'update expired' : 'message withdrawn' },
    },
  });
}

class FeishuDedupeSimulator {
  private seq = 0;
  readonly byUuid = new Map<string, StoredFeishuMessage>();
  readonly byId = new Map<string, StoredFeishuMessage>();
  readonly wireAttempts: WireAttempt[] = [];
  readonly patches: Array<{ messageId: string; content: string }> = [];
  readonly deletes: string[] = [];

  /** Per-attempt error injector for create/reply: '500_commit' commits server-side THEN throws HTTP 500 code=2200. */
  nextPostMode: () => 'ok' | '500_commit' | '400_fail' | 'withdrawn' = () => 'ok';
  nextPatchMode: (messageId: string) => 'ok' | '500_fail' | 'withdrawn' | 'expired' = () => 'ok';
  withdrawnTargets = new Set<string>();

  handlePost(endpoint: 'create' | 'reply', destination: string, data: Record<string, any>): Promise<any> {
    const uuid = String(data?.uuid ?? '');
    expect(uuid.length).toBeGreaterThan(0);
    expect(uuid.length).toBeLessThanOrEqual(FEISHU_UUID_MAX_LEN);
    expect(uuid).toMatch(FEISHU_UUID_PATTERN);

    const content = String(data?.content ?? '');
    const replyInThread = data?.reply_in_thread;
    const cardNonce = extractCardNonce(content);
    const mode = this.nextPostMode();

    if (mode === 'withdrawn' || this.withdrawnTargets.has(destination)) {
      this.wireAttempts.push({ endpoint, destination, replyInThread, uuid, content, cardNonce, outcome: 'withdrawn' });
      return Promise.reject(makeAxiosWithdrawn(230011));
    }
    if (mode === '400_fail') {
      this.wireAttempts.push({ endpoint, destination, replyInThread, uuid, content, cardNonce, outcome: 'http400' });
      return Promise.reject(makeAxios400Deterministic());
    }

    // Feishu server-side UUID dedupe: returns original message_id WITHOUT replacing body,
    // and ignores parent_id mismatches (spike Test 3c).
    const existing = this.byUuid.get(uuid);
    let stored: StoredFeishuMessage;
    let isDedup = false;
    if (existing) {
      stored = existing;
      isDedup = true;
    } else {
      const messageId = `om_feishu_${++this.seq}`;
      stored = { messageId, endpoint, destination, replyInThread, uuid, content, deleted: false };
      this.byUuid.set(uuid, stored);
      this.byId.set(messageId, stored);
    }

    if (mode === '500_commit') {
      this.wireAttempts.push({
        endpoint,
        destination,
        replyInThread,
        uuid,
        content,
        cardNonce,
        outcome: 'http500_after_commit',
        messageId: stored.messageId,
      });
      return Promise.reject(makeAxios500Code2200());
    }

    this.wireAttempts.push({
      endpoint,
      destination,
      replyInThread,
      uuid,
      content,
      cardNonce,
      outcome: isDedup ? 'dedup_ok' : 'ok',
      messageId: stored.messageId,
    });
    return Promise.resolve({ code: 0, data: { message_id: stored.messageId } });
  }

  handlePatch(messageId: string, content: string): Promise<any> {
    const mode = this.nextPatchMode(messageId);
    if (mode === 'withdrawn') return Promise.reject(makeAxiosWithdrawn(230011));
    if (mode === 'expired') return Promise.reject(makeAxiosWithdrawn(230031));
    if (mode === '500_fail') return Promise.reject(makeAxios500Code2200());
    const stored = this.byId.get(messageId);
    if (stored?.deleted) return Promise.reject(makeAxiosWithdrawn(230011));
    if (stored) stored.content = content;
    this.patches.push({ messageId, content });
    return Promise.resolve({ code: 0 });
  }

  handleDelete(messageId: string): Promise<any> {
    const stored = this.byId.get(messageId);
    if (stored) stored.deleted = true;
    this.deletes.push(messageId);
    return Promise.resolve({ code: 0 });
  }

  liveMessages(): StoredFeishuMessage[] {
    return [...this.byId.values()].filter(m => !m.deleted);
  }
}

function createFakeWorker(): EventEmitter & { killed: boolean; kill: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  const worker = Object.assign(new EventEmitter(), {
    killed: false,
    kill: vi.fn(),
    send: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  return worker;
}

async function flush(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('streaming status card idempotent UUID (real worker-pool + daemon sessionReply + lark client)', () => {
  let home: string;
  let dataDir: string;
  let sim: FeishuDedupeSimulator;
  let closeSessionSpy: ReturnType<typeof vi.fn>;
  let activeSessionsCreated: DaemonSession[];

  function makeDs(opts: {
    scope?: 'thread' | 'chat';
    rootMessageId?: string;
    chatId?: string;
    title?: string;
  } = {}): DaemonSession {
    const scope = opts.scope ?? 'thread';
    const chatId = opts.chatId ?? CHAT;
    const rootMessageId = opts.rootMessageId ?? ROOT;
    const stored = sessionStore.createSession(chatId, rootMessageId, opts.title ?? 'test-session', 'group', scope);
    const ds = {
      larkAppId: APP,
      chatId,
      scope,
      chatType: 'group',
      workingDir: dataDir,
      workerReady: true,
      workerGeneration: 1,
      displayMode: 'hidden',
      streamCardTurnGeneration: 1,
      session: { ...stored, larkAppId: APP, workingDir: dataDir, cliId: 'claude-code', workerGeneration: 1 },
    } as unknown as DaemonSession;
    sessionStore.updateSession(ds.session);
    activeSessions.set(activeSessionKey(ds), ds);
    activeSessionsCreated.push(ds);
    return ds;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    __testOnly_resetLarkGate();
    vi.stubEnv('BOTMUX_LARK_QPS', '100000');
    // Disable internal api-gate sleep retries here (api-gate retries with caller uuid are tested
    // separately with fake timers in test/lark-outbound-hook.test.ts) so outer retries across
    // postTurnStartingCard / ready / screen_update run deterministically and fast.
    vi.stubEnv('BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS', '0');
    vi.stubEnv('BOTMUX_LARK_GATE_CIRCUIT_FAILURE_THRESHOLD', '50');
    home = mkdtempSync(join(tmpdir(), 'botmux-stream-uuid-int-'));
    dataDir = join(home, 'data');
    mkdirSync(dataDir, { mode: 0o700 });
    config.session.dataDir = dataDir;
    sim = new FeishuDedupeSimulator();
    activeSessionsCreated = [];
    activeSessions.clear();
    setActiveSessionsRegistry(activeSessions);
    registerBot({
      larkAppId: APP,
      larkAppSecret: 'test-secret',
      cliId: 'claude-code',
      topicUnavailablePolicy: 'legacy',
      replyCardMode: 'legacy',
    });
    sessionStore.init(APP);
    closeSessionSpy = vi.fn(async (target: DaemonSession) => {
      target.session.status = 'closed';
      return true;
    });
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => dataDir,
      getActiveCount: () => activeSessions.size,
      closeSession: closeSessionSpy,
    });

    mocks.request.mockReset().mockImplementation(async ({ method, url }: any) => {
      if (method === 'GET' && String(url).includes('/im/v1/chats/')) {
        return { code: 0, data: { chat_mode: 'group' } };
      }
      if (method === 'GET' && String(url).includes('/im/v1/messages/')) {
        const id = String(url).split('/').at(-1)!;
        const stored = sim.byId.get(id);
        return {
          code: 0,
          data: {
            items: [{
              message_id: id,
              chat_id: CHAT,
              deleted: sim.withdrawnTargets.has(id) || stored?.deleted === true,
            }],
          },
        };
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    mocks.create.mockReset().mockImplementation((req: any) =>
      sim.handlePost('create', req.data.receive_id, req.data),
    );
    mocks.reply.mockReset().mockImplementation((req: any) =>
      sim.handlePost('reply', req.path.message_id, req.data),
    );
    mocks.patch.mockReset().mockImplementation((req: any) =>
      sim.handlePatch(req.path.message_id, req.data.content),
    );
    mocks.delete.mockReset().mockImplementation((req: any) =>
      sim.handleDelete(req.path.message_id),
    );
    mocks.upload.mockReset().mockResolvedValue({ file_key: 'file_dummy' });
  });

  afterEach(() => {
    for (const ds of activeSessionsCreated) ds.session.status = 'closed';
    activeSessions.clear();
    setActiveSessionsRegistry(originalRegistry);
    sessionStore.init(APP, { owner: false });
    config.session.dataDir = oldDataDir;
    rmSync(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
    __testOnly_resetLarkGate();
  });

  it('reuses one per-turn uuid and card_nonce across postTurnStartingCard and 3 screen_update retries under HTTP 500 code=2200, reconciles stale body via PATCH, and rotates/recalls on next turn', async () => {
    const ds = makeDs({ scope: 'thread' });
    const worker = createFakeWorker();
    ds.worker = worker as any;
    ds.workerGeneration = 1;
    setupWorkerHandlers(ds, worker as any, undefined, 1);

    // Turn 1 succeeds normally -> M0
    ds.currentTurnId = 'om_turn_1';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_1';
    ds.streamCardTurnGeneration = 1;
    expect(await postTurnStartingCard(ds, sessionReply, 'om_turn_1')).toBe(true);
    const turn1CardId = ds.streamCardId!;
    const turn1Uuid = sim.wireAttempts[0].uuid;
    expect(turn1Uuid).toMatch(/^sc_t_[0-9a-f]{32}$/);
    expect(turn1Uuid.length).toBeLessThanOrEqual(FEISHU_UUID_MAX_LEN);
    expect(sim.liveMessages()).toHaveLength(1);

    // Begin Turn 2: park Turn 1's card, bump generation, set pending -> HTTP 500 code=2200 AFTER Feishu commits!
    parkStreamCard(ds);
    ds.currentTurnId = 'om_turn_2';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_2';
    ds.streamCardTurnGeneration = 2;
    invalidateTurnStreamingCardPostSlot(ds);

    // First 3 outer POST rounds (postTurnStartingCard + 2 screen_updates) fail with 500 code=2200 after server-side commit.
    // The 4th outer round (3rd screen_update, status='idle') recovers with HTTP 200 dedup!
    let outage = true;
    sim.nextPostMode = () => (outage ? '500_commit' : 'ok');

    // Attempt 1 (outer): postTurnStartingCard ('starting') -> lands M1 on Feishu, returns 500
    expect(await postTurnStartingCard(ds, sessionReply, 'om_turn_2')).toBe(false);
    expect(ds.streamCardId).toBe(turn1CardId);
    expect(ds.streamCardPending).toBe(true);
    expect(ds.streamCardPendingTurnId).toBe('om_turn_2');

    // Attempt 2 (outer): screen_update #1 ('working') -> fails 500, must keep streamCardPending=true!
    worker.emit('message', { type: 'screen_update', content: 'working 1', status: 'working', turnId: 'om_turn_1' });
    await flush();
    expect(ds.streamCardPending).toBe(true);
    expect(ds.streamCardPendingTurnId).toBe('om_turn_2');
    expect(ds.streamCardId).toBe(turn1CardId);

    // Attempt 3 (outer): screen_update #2 ('working') -> fails 500
    worker.emit('message', { type: 'screen_update', content: 'working 2', status: 'working', turnId: 'om_turn_2' });
    await flush();
    expect(ds.streamCardPending).toBe(true);
    expect(ds.streamCardPendingTurnId).toBe('om_turn_2');

    // Feishu recovers! Attempt 4 (outer): screen_update #3 ('idle') succeeds via UUID dedup returning M1!
    // Also simulate the immediate reconciliation PATCH targeting M1 failing ONCE (tail of outage),
    // then succeeding on the next frame via cardNeedsStartingExitRetry!
    const committedTurn2Id = sim.wireAttempts[1].messageId!;
    let m1PatchFailures = 1;
    sim.nextPatchMode = messageId => (messageId === committedTurn2Id && m1PatchFailures-- > 0 ? '500_fail' : 'ok');
    outage = false;

    worker.emit('message', { type: 'screen_update', content: 'done', status: 'idle', turnId: 'om_turn_2' });
    await flush();

    // Every single Turn 2 wire attempt across postTurnStartingCard + 3 screen_updates carried the EXACT same uuid & card_nonce!
    const turn2Attempts = sim.wireAttempts.slice(1);
    expect(turn2Attempts.length).toBeGreaterThanOrEqual(4);
    const turn2Uuid = turn2Attempts[0].uuid;
    const turn2Nonce = turn2Attempts[0].cardNonce;
    expect(turn2Uuid).toMatch(/^sc_t_[0-9a-f]{32}$/);
    expect(turn2Uuid).not.toBe(turn1Uuid);
    expect(turn2Nonce).toBeTruthy();
    for (const attempt of turn2Attempts) {
      expect(attempt.uuid).toBe(turn2Uuid);
      expect(attempt.cardNonce).toBe(turn2Nonce);
      expect(attempt.endpoint).toBe('reply');
      expect(attempt.replyInThread).toBe(true);
    }

    // Feishu ONLY created ONE card for Turn 2 (M1) — zero orphan cards! And Turn 1's M0 was recalled!
    const turn2CardId = ds.streamCardId!;
    expect(turn2CardId).toBe(turn2Attempts[0].messageId);
    expect(ds.streamCardNonce).toBe(turn2Nonce);
    expect(ds.streamCardPending).toBe(false);
    expect(sim.deletes).toContain(turn1CardId);
    expect(sim.liveMessages().map(m => m.messageId)).toEqual([turn2CardId]);

    // Because the first reconciliation PATCH failed, Feishu's M1 is still showing 'starting' —
    // and conservative visibleStreamingCardStatus seeding ensures the next idle frame retries the exit PATCH!
    expect(extractCardTemplate(sim.byId.get(turn2CardId)!.content)).toBe(STREAM_STATUS_TEMPLATE_MAP.starting);
    worker.emit('message', { type: 'screen_update', content: 'done', status: 'idle', turnId: 'om_turn_2' });
    await flush();
    expect(extractCardTemplate(sim.byId.get(turn2CardId)!.content)).toBe(STREAM_STATUS_TEMPLATE_MAP.idle);

    // Begin Turn 3 -> must rotate to a brand-new UUID, post M2, and recall M1!
    parkStreamCard(ds);
    ds.currentTurnId = 'om_turn_3';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_3';
    ds.streamCardTurnGeneration = 3;
    invalidateTurnStreamingCardPostSlot(ds);

    expect(await postTurnStartingCard(ds, sessionReply, 'om_turn_3')).toBe(true);
    await flush();
    const turn3Attempt = sim.wireAttempts.at(-1)!;
    expect(turn3Attempt.uuid).toMatch(/^sc_t_[0-9a-f]{32}$/);
    expect(turn3Attempt.uuid).not.toBe(turn2Uuid);
    expect(sim.deletes).toContain(turn2CardId);
    expect(sim.liveMessages().map(m => m.messageId)).toEqual([ds.streamCardId]);
  });

  it('immediately reconciles stale deduped body on recovery PATCH without waiting for another screen_update', async () => {
    const ds = makeDs({ scope: 'thread' });
    const worker = createFakeWorker();
    ds.worker = worker as any;
    ds.workerGeneration = 1;
    setupWorkerHandlers(ds, worker as any, undefined, 1);

    ds.currentTurnId = 'om_turn_a';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_a';
    ds.streamCardTurnGeneration = 1;

    let outage = true;
    sim.nextPostMode = () => (outage ? '500_commit' : 'ok');
    expect(await postTurnStartingCard(ds, sessionReply, 'om_turn_a')).toBe(false);

    outage = false;
    worker.emit('message', { type: 'screen_update', content: 'finished', status: 'idle', turnId: 'om_turn_a' });
    await flush();

    const cardId = ds.streamCardId!;
    expect(sim.liveMessages().map(m => m.messageId)).toEqual([cardId]);
    // Attempt 1 committed 'starting', Attempt 2 deduped with 'idle' -> immediate PATCH updated Feishu card to 'idle'!
    expect(sim.patches.some(p => p.messageId === cardId)).toBe(true);
    expect(extractCardTemplate(sim.byId.get(cardId)!.content)).toBe(STREAM_STATUS_TEMPLATE_MAP.idle);
  });

  it('suppresses case ready static fallback on HTTP 500 code=2200 so untagged screen_update dedups, while preserving fallback with distinct sc_f_ uuid on deterministic 400', async () => {
    // Subcase A: HTTP 500 code=2200 on case 'ready' -> NO static fallback; subsequent untagged PTY screen_update reuses ready's uuid & nonce
    const dsA = makeDs({ scope: 'thread', rootMessageId: 'om_root_ready_a' });
    const workerA = createFakeWorker();
    dsA.worker = workerA as any;
    dsA.workerReady = false;
    dsA.workerGeneration = 1;
    setupWorkerHandlers(dsA, workerA as any, undefined, 1);

    let outageA = true;
    sim.nextPostMode = () => (outageA ? '500_commit' : 'ok');

    workerA.emit('message', { type: 'ready', port: 9101, token: 'tok_a', turnId: 'om_ready_turn_a' });
    await flush();

    // Only the streaming card attempts ran — NO static fallback card was created!
    expect(dsA.streamCardId).toBeUndefined();
    expect(sim.byId.size).toBe(1);
    const readyUuid = sim.wireAttempts[0].uuid;
    const readyNonce = sim.wireAttempts[0].cardNonce;
    expect(readyUuid).toMatch(/^sc_t_[0-9a-f]{32}$/);
    expect(sim.wireAttempts.every(a => a.uuid === readyUuid)).toBe(true);

    // Recover on untagged PTY screen_update (turnId omitted) -> reuses ready's exact uuid & nonce!
    outageA = false;
    workerA.emit('message', { type: 'screen_update', content: 'running', status: 'working' });
    await flush();

    expect(sim.byId.size).toBe(1);
    expect(dsA.streamCardId).toBe(sim.wireAttempts[0].messageId);
    expect(dsA.streamCardNonce).toBe(readyNonce);
    expect(sim.wireAttempts.at(-1)!.uuid).toBe(readyUuid);
    expect(extractCardTemplate(sim.byId.get(dsA.streamCardId!)!.content)).toBe(STREAM_STATUS_TEMPLATE_MAP.working);

    // Subcase B: deterministic HTTP 400 on case 'ready' -> fires static fallback with distinct sc_f_ uuid
    const attemptsBeforeB = sim.wireAttempts.length;
    const dsB = makeDs({ scope: 'thread', rootMessageId: 'om_root_ready_b' });
    const workerB = createFakeWorker();
    dsB.worker = workerB as any;
    dsB.workerReady = false;
    dsB.workerGeneration = 1;
    setupWorkerHandlers(dsB, workerB as any, undefined, 1);

    let firstAttempt = true;
    sim.nextPostMode = () => {
      if (firstAttempt) {
        firstAttempt = false;
        return '400_fail';
      }
      return 'ok';
    };
    workerB.emit('message', { type: 'ready', port: 9102, token: 'tok_b', turnId: 'om_ready_turn_b' });
    await flush();

    const bAttempts = sim.wireAttempts.slice(attemptsBeforeB);
    expect(bAttempts).toHaveLength(2);
    expect(bAttempts[0].uuid).toMatch(/^sc_t_[0-9a-f]{32}$/);
    expect(bAttempts[1].uuid).toMatch(/^sc_f_[0-9a-f]{32}$/);
    expect(bAttempts[1].uuid).not.toBe(bAttempts[0].uuid);
  });

  it('propagates caller uuid through both sendMessage (plain chat-scope) and replyMessage (thread/quote) and rotates uuid when replyTargetKey changes', async () => {
    const ds = makeDs({ scope: 'chat', chatId: 'oc_plain_chat', rootMessageId: 'om_plain_seed' });
    ds.streamCardTurnGeneration = 1;

    // 1. Plain chat-scope -> sendMessage (im.v1.message.create) receives sc_t_ uuid
    ds.currentReplyTarget = undefined;
    ds.session.currentReplyTarget = undefined;
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_plain_turn';
    expect(await postTurnStartingCard(ds, sessionReply, 'om_plain_turn')).toBe(true);
    const plainAttempt = sim.wireAttempts.at(-1)!;
    expect(plainAttempt.endpoint).toBe('create');
    expect(plainAttempt.destination).toBe('oc_plain_chat');
    expect(plainAttempt.uuid).toMatch(/^sc_t_[0-9a-f]{32}$/);

    // 2. Chat-scope switched to thread target A -> replyMessage (reply_in_thread: true) receives distinct uuid
    ds.currentReplyTarget = { turnId: 'om_topic_a', rootMessageId: 'om_topic_a', mode: 'thread' };
    ds.session.currentReplyTarget = ds.currentReplyTarget;
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_topic_a';
    // Deliberately keep same streamCardTurnGeneration to prove replyTargetKey alone rotates the slot!
    sim.nextPostMode = () => '500_commit';
    expect(await postTurnStartingCard(ds, sessionReply, 'om_topic_a')).toBe(false);
    const topicAFailed = sim.wireAttempts.at(-1)!;
    expect(topicAFailed.endpoint).toBe('reply');
    expect(topicAFailed.destination).toBe('om_topic_a');
    expect(topicAFailed.replyInThread).toBe(true);
    expect(topicAFailed.uuid).not.toBe(plainAttempt.uuid);

    // 3. Switch replyTargetKey to thread target B under SAME turnGeneration -> MUST rotate uuid (never alias Topic A's card!)
    ds.currentReplyTarget = { turnId: 'om_topic_b', rootMessageId: 'om_topic_b', mode: 'thread' };
    ds.session.currentReplyTarget = ds.currentReplyTarget;
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_topic_b';
    sim.nextPostMode = () => 'ok';
    expect(await postTurnStartingCard(ds, sessionReply, 'om_topic_b')).toBe(true);
    const topicBSucceeded = sim.wireAttempts.at(-1)!;
    expect(topicBSucceeded.endpoint).toBe('reply');
    expect(topicBSucceeded.destination).toBe('om_topic_b');
    expect(topicBSucceeded.uuid).not.toBe(topicAFailed.uuid);
    expect(topicBSucceeded.messageId).not.toBe(topicAFailed.messageId);
  });

  it('gives manual /card unique sc_m_ uuids, dedups /card & legacy migration retries on 500, and preserves mid-flight beginNewTurn supersession', async () => {
    const ds = makeDs({ scope: 'thread' });
    ds.currentTurnId = 'om_turn_1';
    ds.streamCardTurnGeneration = 1;
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_1';
    expect(await postTurnStartingCard(ds, sessionReply, 'om_turn_1')).toBe(true);
    const turnUuid = sim.wireAttempts.at(-1)!.uuid;

    // Two consecutive successful /card calls must get distinct sc_m_ UUIDs (and neither equals turnUuid)
    expect(await postFreshStreamingCard(ds, sessionReply)).toBe(true);
    const manual1Uuid = sim.wireAttempts.at(-1)!.uuid;
    const manual1Id = ds.streamCardId!;
    expect(manual1Uuid).toMatch(/^sc_m_[0-9a-f]{32}$/);
    expect(manual1Uuid).not.toBe(turnUuid);

    expect(await postFreshStreamingCard(ds, sessionReply)).toBe(true);
    const manual2Uuid = sim.wireAttempts.at(-1)!.uuid;
    expect(manual2Uuid).toMatch(/^sc_m_[0-9a-f]{32}$/);
    expect(manual2Uuid).not.toBe(manual1Uuid);
    expect(ds.streamCardId).not.toBe(manual1Id);

    // /card failing with HTTP 500 code=2200 after commit -> retry /card reuses same sc_m_ uuid
    let failManual = true;
    sim.nextPostMode = () => (failManual ? '500_commit' : 'ok');
    const attemptsBeforeRetry = sim.wireAttempts.length;
    expect(await postFreshStreamingCard(ds, sessionReply)).toBe(false);
    failManual = false;
    expect(await postFreshStreamingCard(ds, sessionReply)).toBe(true);
    const retryAttempts = sim.wireAttempts.slice(attemptsBeforeRetry);
    expect(retryAttempts.length).toBeGreaterThanOrEqual(2);
    expect(retryAttempts[0].uuid).toMatch(/^sc_m_[0-9a-f]{32}$/);
    expect(retryAttempts.every(a => a.uuid === retryAttempts[0].uuid)).toBe(true);

    // Legacy migration (retireMessageId) failing with HTTP 500 -> retry reuses same sc_l_ uuid
    let failLegacy = true;
    sim.nextPostMode = () => (failLegacy ? '500_commit' : 'ok');
    const attemptsBeforeLegacy = sim.wireAttempts.length;
    expect(await postFreshStreamingCard(ds, sessionReply, { retireMessageId: 'om_legacy_card' })).toBe(false);
    failLegacy = false;
    expect(await postFreshStreamingCard(ds, sessionReply, { retireMessageId: 'om_legacy_card' })).toBe(true);
    const legacyAttempts = sim.wireAttempts.slice(attemptsBeforeLegacy);
    expect(legacyAttempts.length).toBeGreaterThanOrEqual(2);
    expect(legacyAttempts[0].uuid).toMatch(/^sc_l_[0-9a-f]{32}$/);
    expect(legacyAttempts.every(a => a.uuid === legacyAttempts[0].uuid)).toBe(true);

    // Mid-flight beginNewTurn while /card is awaiting Lark -> must NOT clear Turn 2's streamCardPending and must cascade Turn 2 card!
    let resolveInFlightManual!: () => void;
    const replyEntered = new Promise<void>(resolveEntered => {
      mocks.reply.mockImplementationOnce((req: any) => new Promise(resolve => {
        resolveInFlightManual = () => resolve(sim.handlePost('reply', req.path.message_id, req.data));
        resolveEntered();
      }));
    });
    const inFlight = postFreshStreamingCard(ds, sessionReply);
    expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);
    await replyEntered;

    // Turn 2 arrives mid-/card
    ds.currentTurnId = 'om_turn_2';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_2';
    ds.streamCardTurnGeneration = 2;
    invalidateTurnStreamingCardPostSlot(ds);

    resolveInFlightManual();
    expect(await inFlight).toBe(true);
    await flush();

    // Turn 2's starting card was cascaded automatically with a fresh sc_t_ uuid!
    expect(ds.streamCardPending).toBe(false);
    expect(ds.streamCardPendingTurnId).toBeUndefined();
    const lastAttempt = sim.wireAttempts.at(-1)!;
    expect(lastAttempt.uuid).toMatch(/^sc_t_[0-9a-f]{32}$/);
    expect(lastAttempt.messageId).toBe(ds.streamCardId);
  });

  it('handles MessageWithdrawnError, MessageUpdateExpiredError, and TopicSendError without sentinel leak or dead-card UUID loops', async () => {
    // 1. Live card PATCH returns 230011 (withdrawn) -> next screen_update creates a new card with a DIFFERENT uuid
    const ds = makeDs({ scope: 'thread' });
    const worker = createFakeWorker();
    ds.worker = worker as any;
    ds.workerGeneration = 1;
    setupWorkerHandlers(ds, worker as any, undefined, 1);

    ds.currentTurnId = 'om_turn_w';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_w';
    ds.streamCardTurnGeneration = 1;
    expect(await postTurnStartingCard(ds, sessionReply, 'om_turn_w')).toBe(true);
    const deadCardId = ds.streamCardId!;
    const firstUuid = sim.wireAttempts.at(-1)!.uuid;

    sim.nextPatchMode = () => 'withdrawn';
    scheduleCardPatch(ds, '{"patched":1}', 'om_turn_w');
    await flush();
    expect(ds.streamCardId).toBeUndefined();

    sim.nextPatchMode = () => 'ok';
    worker.emit('message', { type: 'screen_update', content: 'recreated', status: 'working', turnId: 'om_turn_w' });
    await flush();
    const recreatedAttempt = sim.wireAttempts.at(-1)!;
    expect(recreatedAttempt.uuid).not.toBe(firstUuid);
    expect(recreatedAttempt.messageId).not.toBe(deadCardId);
    expect(ds.streamCardId).toBe(recreatedAttempt.messageId);

    // 2. MessageWithdrawnError during screen_update POST with unsettled Codex App FIFO ->
    // closeWithdrawnSessionIfLedgerEmpty returns false, and sentinel MUST be cleared (never stuck at '__posting__')!
    const dsLedger = makeDs({ scope: 'thread', rootMessageId: 'om_withdrawn_root' });
    dsLedger.session.codexAppDispatchLedger = [{
      dispatchId: 'disp_1',
      turnId: 'om_turn_ledger',
      state: 'prepared',
      content: 'work',
    }] as any;
    const workerLedger = createFakeWorker();
    dsLedger.worker = workerLedger as any;
    dsLedger.workerGeneration = 1;
    setupWorkerHandlers(dsLedger, workerLedger as any, undefined, 1);

    sim.nextPostMode = () => 'withdrawn';
    workerLedger.emit('message', { type: 'screen_update', content: 'working', status: 'working', turnId: 'om_turn_ledger' });
    await flush();
    expect(closeSessionSpy).not.toHaveBeenCalled();
    expect(dsLedger.streamCardId).not.toBe(CARD_POSTING_SENTINEL);
    expect(dsLedger.streamCardId).toBeUndefined();
    const withdrawnUuid = sim.wireAttempts.at(-1)!.uuid;

    // Next attempt (after target recovers or changes) gets a fresh UUID and succeeds!
    sim.nextPostMode = () => 'ok';
    workerLedger.emit('message', { type: 'screen_update', content: 'recovered', status: 'working', turnId: 'om_turn_ledger' });
    await flush();
    const recoveredAttempt = sim.wireAttempts.at(-1)!;
    expect(recoveredAttempt.uuid).not.toBe(withdrawnUuid);
    expect(dsLedger.streamCardId).toBe(recoveredAttempt.messageId);

    // 3. TopicSendError('TOPIC_SEND_BLOCKED') under stop policy during ready POST ->
    // clears sentinel, suppresses static fallback, does not auto-close session!
    registerBot({
      larkAppId: APP,
      larkAppSecret: 'test-secret',
      cliId: 'claude-code',
      topicUnavailablePolicy: 'stop',
      replyCardMode: 'legacy',
    });
    const dsBlocked = makeDs({ scope: 'thread', rootMessageId: 'om_blocked_root' });
    sim.withdrawnTargets.add('om_blocked_root');
    const workerBlocked = createFakeWorker();
    dsBlocked.worker = workerBlocked as any;
    dsBlocked.workerReady = false;
    dsBlocked.workerGeneration = 1;
    setupWorkerHandlers(dsBlocked, workerBlocked as any, undefined, 1);

    const attemptsBeforeBlocked = sim.wireAttempts.length;
    workerBlocked.emit('message', { type: 'ready', port: 9103, token: 'tok_blk', turnId: 'om_turn_blk' });
    await flush();
    expect(dsBlocked.streamCardId).not.toBe(CARD_POSTING_SENTINEL);
    expect(dsBlocked.streamCardId).toBeUndefined();
    expect(closeSessionSpy).not.toHaveBeenCalled();
    // Pre-write topic guard blocked before hitting im.v1.message.reply — no static fallback POST either!
    expect(sim.wireAttempts.slice(attemptsBeforeBlocked)).toHaveLength(0);
  });

  it('retires consumed uuid before deleting a stale card after ownership loss so a later retry never dedups onto the deleted card', async () => {
    const ds = makeDs({ scope: 'thread' });
    ds.currentTurnId = 'om_turn_stale';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_stale';
    ds.streamCardTurnGeneration = 1;

    // Ownership flips to suspendedColdResume while POST is in flight -> POST resolves with M_stale,
    // daemon deletes M_stale and MUST retire U1 so the next retry uses U2 !== U1.
    mocks.reply.mockImplementationOnce(async (req: any) => {
      const res = await sim.handlePost('reply', req.path.message_id, req.data);
      ds.session.suspendedColdResume = true;
      return res;
    });

    expect(await postTurnStartingCard(ds, sessionReply, 'om_turn_stale')).toBe(false);
    await flush();
    const staleAttempt = sim.wireAttempts.at(-1)!;
    expect(sim.deletes).toContain(staleAttempt.messageId);

    // Resume ownership and retry same turn -> MUST mint fresh UUID and new messageId!
    ds.session.suspendedColdResume = false;
    expect(await postTurnStartingCard(ds, sessionReply, 'om_turn_stale')).toBe(true);
    const retryAttempt = sim.wireAttempts.at(-1)!;
    expect(retryAttempt.uuid).not.toBe(staleAttempt.uuid);
    expect(retryAttempt.messageId).not.toBe(staleAttempt.messageId);
    expect(ds.streamCardId).toBe(retryAttempt.messageId);
  });

  it('sends stable sc_r_ uuid on reconcileResumedStreamingCard retries and isolates close+resume into a fresh DaemonSession', async () => {
    const ds = makeDs({ scope: 'thread', rootMessageId: 'om_resume_root' });
    ds.streamCardId = 'om_closed_card';
    ds.lastScreenStatus = 'idle';

    // Attempt 1 hits 500 after commit -> Attempt 2 retries with exact same sc_r_ uuid and succeeds
    let failResume = true;
    sim.nextPostMode = () => (failResume ? '500_commit' : 'ok');
    const postCard = (cardJson: string, uuid?: string) =>
      sessionReply('om_resume_root', cardJson, 'interactive', APP, undefined, uuid ? { uuid } : undefined);

    await expect(reconcileResumedStreamingCard(ds, 'om_closed_card', postCard)).rejects.toThrow();
    const firstResumeAttempt = sim.wireAttempts.at(-1)!;
    expect(firstResumeAttempt.uuid).toMatch(/^sc_r_[0-9a-f]{32}$/);

    failResume = false;
    // Change title between attempts so body diverges -> dedup commit triggers scheduleCardPatch
    ds.currentTurnTitle = 'updated-after-resume';
    const res = await reconcileResumedStreamingCard(ds, 'om_closed_card', postCard);
    await flush();

    expect(res).toEqual({ status: 'committed', reposted: true, messageId: firstResumeAttempt.messageId });
    const secondResumeAttempt = sim.wireAttempts.at(-1)!;
    expect(secondResumeAttempt.uuid).toBe(firstResumeAttempt.uuid);
    expect(sim.byId.size).toBe(1);
    expect(sim.deletes).toContain('om_closed_card');
    expect(sim.patches.some(p => p.messageId === firstResumeAttempt.messageId)).toBe(true);

    // Close session and reactivate into a fresh DaemonSession object with the SAME sessionId in the same process ->
    // MUST mint a distinct UUID (no cross-lifecycle collision within Feishu's 1h TTL).
    await closeSession(ds.session.sessionId);
    const reactivated = sessionStore.reactivateClosedSession(ds.session.sessionId);
    expect(reactivated.ok).toBe(true);
    if (!reactivated.ok) throw new Error('reactivateClosedSession failed');
    const reopened = {
      larkAppId: APP,
      chatId: CHAT,
      scope: 'thread',
      chatType: 'group',
      workingDir: dataDir,
      workerReady: true,
      displayMode: 'hidden',
      streamCardTurnGeneration: 1,
      streamCardPending: true,
      streamCardPendingTurnId: 'om_turn_1',
      session: reactivated.session,
    } as unknown as DaemonSession;
    activeSessions.set(activeSessionKey(reopened), reopened);
    activeSessionsCreated.push(reopened);

    expect(await postTurnStartingCard(reopened, sessionReply, 'om_turn_1')).toBe(true);
    const reopenedUuid = sim.wireAttempts.at(-1)!.uuid;
    expect(reopenedUuid).toMatch(/^sc_t_[0-9a-f]{32}$/);
    expect(reopenedUuid).not.toBe(firstResumeAttempt.uuid);
  });

  it('retries a failed resume dedup reconciliation PATCH with the shared bounded backoff', async () => {
    vi.useFakeTimers();
    try {
      const ds = makeDs({ scope: 'thread', rootMessageId: 'om_resume_patch_retry_root' });
      ds.streamCardId = 'om_closed_card';
      ds.lastScreenStatus = 'idle';
      let failResume = true;
      sim.nextPostMode = () => (failResume ? '500_commit' : 'ok');
      const postCard = (cardJson: string, uuid?: string) =>
        sessionReply('om_resume_patch_retry_root', cardJson, 'interactive', APP, undefined, uuid ? { uuid } : undefined);
      await expect(reconcileResumedStreamingCard(ds, 'om_closed_card', postCard)).rejects.toThrow();

      failResume = false;
      ds.currentTurnTitle = 'updated-after-resume';
      sim.nextPatchMode = () => '500_fail';
      const committed = await reconcileResumedStreamingCard(ds, 'om_closed_card', postCard);
      expect(committed).toMatchObject({ status: 'committed', reposted: true });
      await vi.advanceTimersByTimeAsync(100);
      const failedPatchCalls = mocks.patch.mock.calls.length;
      expect(failedPatchCalls).toBeGreaterThan(0);

      sim.nextPatchMode = () => 'ok';
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mocks.patch.mock.calls.length).toBeGreaterThan(failedPatchCalls);
      const messageId = ds.streamCardId!;
      expect(sim.byId.get(messageId)?.content).toContain('updated-after-resume');

      const deliveredPatchCalls = mocks.patch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mocks.patch.mock.calls.length).toBe(deliveredPatchCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains commit-unknown slot when a worker exits mid-POST under HTTP 500 so replacement worker dedups with zero orphan cards', async () => {
    const ds = makeDs({ scope: 'thread', rootMessageId: 'om_root_worker_swap' });
    const worker1 = createFakeWorker();
    ds.worker = worker1 as any;
    ds.workerGeneration = 1;
    ds.session.workerGeneration = 1;
    setupWorkerHandlers(ds, worker1 as any, undefined, 1);

    ds.currentTurnId = 'om_turn_swap';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_swap';
    ds.streamCardTurnGeneration = 1;

    // Worker 1 exits mid-flight while Attempt 1 commits M1 on Feishu and returns HTTP 500 code=2200
    mocks.reply.mockImplementationOnce(async (req: any) => {
      worker1.killed = true;
      ds.worker = null;
      return sim.handlePost('reply', req.path.message_id, req.data);
    });
    sim.nextPostMode = () => '500_commit';
    expect(await postTurnStartingCard(ds, sessionReply, 'om_turn_swap')).toBe(false);
    const attempt1 = sim.wireAttempts.at(-1)!;
    expect(sim.byId.size).toBe(1);

    // Replacement Worker 2 comes ready for the same turn -> MUST reuse Attempt 1's exact uuid & card_nonce!
    sim.nextPostMode = () => 'ok';
    const worker2 = createFakeWorker();
    ds.worker = worker2 as any;
    ds.workerReady = false;
    ds.workerGeneration = 2;
    ds.session.workerGeneration = 2;
    setupWorkerHandlers(ds, worker2 as any, undefined, 2);
    worker2.emit('message', { type: 'ready', port: 9120, token: 'tok_w2', turnId: 'om_turn_swap' });
    await flush();

    const attempt2 = sim.wireAttempts.at(-1)!;
    expect(attempt2.uuid).toBe(attempt1.uuid);
    expect(attempt2.cardNonce).toBe(attempt1.cardNonce);
    expect(sim.byId.size).toBe(1);
    expect(ds.streamCardId).toBe(attempt1.messageId);
  });

  it('falls through to a fresh ready card when the restored-card PATCH rejects deterministically', async () => {
    const ds = makeDs({ scope: 'thread', rootMessageId: 'om_root_reuse_400' });
    ds.currentTurnId = 'om_turn_r400_replacement';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_r400_replacement';
    expect(await postTurnStartingCard(ds, sessionReply, 'om_turn_r400_replacement')).toBe(true);
    const oldCard = ds.streamCardId!;

    const worker = createFakeWorker();
    ds.worker = worker as any;
    ds.workerReady = false;
    ds.workerGeneration = 2;
    ds.session.workerGeneration = 2;
    setupWorkerHandlers(ds, worker as any, undefined, 2);
    mocks.patch.mockRejectedValueOnce(makeAxios400Deterministic());
    const attemptsBefore = sim.wireAttempts.length;
    worker.emit('message', { type: 'ready', port: 9122, token: 'tok_r400_replacement' });
    await flush();

    expect(ds.streamCardId).toBeTruthy();
    expect(ds.streamCardId).not.toBe(oldCard);
    expect(sim.wireAttempts.length).toBe(attemptsBefore + 1);
    expect(sim.wireAttempts.at(-1)!.uuid).toMatch(/^sc_t_[0-9a-f]{32}$/);
  });

  it('keeps existing live card on case ready transient reuse-PATCH 500 and parks expired 230031 card for recall', async () => {
    // Subcase A: transient HTTP 500 on ready reuse PATCH keeps ds.streamCardId intact (zero duplicate POST)
    const dsA = makeDs({ scope: 'thread', rootMessageId: 'om_root_reuse_500' });
    dsA.currentTurnId = 'om_turn_r500';
    dsA.streamCardPending = true;
    dsA.streamCardPendingTurnId = 'om_turn_r500';
    expect(await postTurnStartingCard(dsA, sessionReply, 'om_turn_r500')).toBe(true);
    const liveCardA = dsA.streamCardId!;

    const workerA = createFakeWorker();
    dsA.worker = workerA as any;
    dsA.workerReady = false;
    dsA.workerGeneration = 2;
    dsA.session.workerGeneration = 2;
    setupWorkerHandlers(dsA, workerA as any, undefined, 2);
    sim.nextPatchMode = () => '500_fail';
    const attemptsBefore = sim.wireAttempts.length;
    workerA.emit('message', { type: 'ready', port: 9121, token: 'tok_ra' });
    await flush();
    expect(dsA.streamCardId).toBe(liveCardA);
    expect(sim.wireAttempts.slice(attemptsBefore)).toHaveLength(0);

    // Subcase B: MessageUpdateExpiredError (230031) parks old card and posts fresh replacement recalling it
    sim.nextPatchMode = () => 'expired';
    const workerA2 = createFakeWorker();
    dsA.worker = workerA2 as any;
    dsA.workerReady = false;
    dsA.workerGeneration = 3;
    dsA.session.workerGeneration = 3;
    setupWorkerHandlers(dsA, workerA2 as any, undefined, 3);
    workerA2.emit('message', { type: 'ready', port: 9122, token: 'tok_ra2' });
    await flush();
    expect(dsA.streamCardId).toBeTruthy();
    expect(dsA.streamCardId).not.toBe(liveCardA);
    expect(sim.deletes).toContain(liveCardA);
  });

  it('skips case ready static fallback when commit-unknown history exists or a superseding turn arrived mid-flight', async () => {
    // Subcase A: Attempt #1 postTurnStartingCard hits 500 -> Attempt #2 ready hits deterministic 400 ->
    // MUST NOT post static fallback or lose slot -> Attempt #3 screen_update dedups to single card!
    const ds = makeDs({ scope: 'thread', rootMessageId: 'om_root_ready_400_after_500' });
    const worker = createFakeWorker();
    ds.worker = worker as any;
    ds.workerGeneration = 1;
    ds.session.workerGeneration = 1;
    setupWorkerHandlers(ds, worker as any, undefined, 1);

    ds.currentTurnId = 'om_turn_r400';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_r400';
    ds.streamCardTurnGeneration = 1;

    sim.nextPostMode = () => '500_commit';
    expect(await postTurnStartingCard(ds, sessionReply, 'om_turn_r400')).toBe(false);
    const uuid1 = sim.wireAttempts.at(-1)!.uuid;

    sim.nextPostMode = () => '400_fail';
    worker.emit('message', { type: 'ready', port: 9123, token: 'tok_r400', turnId: 'om_turn_r400' });
    await flush();
    // No static sc_f_ fallback was posted!
    expect(sim.wireAttempts.some(a => a.uuid.startsWith('sc_f_'))).toBe(false);

    sim.nextPostMode = () => 'ok';
    worker.emit('message', { type: 'screen_update', content: 'recovered', status: 'working', turnId: 'om_turn_r400' });
    await flush();
    expect(sim.byId.size).toBe(1);
    expect(sim.wireAttempts.at(-1)!.uuid).toBe(uuid1);

    // Subcase B: ready POST hits deterministic 400 after Turn 2 arrived mid-flight -> cascades Turn 2 starting card
    const dsSup = makeDs({ scope: 'thread', rootMessageId: 'om_root_ready_superseded' });
    const workerSup = createFakeWorker();
    dsSup.worker = workerSup as any;
    dsSup.workerReady = false;
    dsSup.workerGeneration = 1;
    dsSup.session.workerGeneration = 1;
    setupWorkerHandlers(dsSup, workerSup as any, undefined, 1);

    let rejectReady!: () => void;
    const readyEntered = new Promise<void>(resolveEntered => {
      mocks.reply.mockImplementationOnce((req: any) => new Promise((_resolve, reject) => {
        rejectReady = () => reject(makeAxios400Deterministic());
        void req;
        resolveEntered();
      }));
    });
    dsSup.streamCardTurnGeneration = 1;
    workerSup.emit('message', { type: 'ready', port: 9124, token: 'tok_sup', turnId: 'om_turn_sup_1' });
    await readyEntered;

    // Turn 2 arrives mid-flight while ready holds CARD_POSTING_SENTINEL
    dsSup.currentTurnId = 'om_turn_sup_2';
    dsSup.streamCardPending = true;
    dsSup.streamCardPendingTurnId = 'om_turn_sup_2';
    dsSup.streamCardTurnGeneration = 2;
    invalidateTurnStreamingCardPostSlot(dsSup);

    sim.nextPostMode = () => 'ok';
    rejectReady();
    await flush();
    expect(dsSup.streamCardPending).toBe(false);
    expect(dsSup.streamCardId).toBeTruthy();
    expect(sim.wireAttempts.at(-1)!.uuid).toMatch(/^sc_t_[0-9a-f]{32}$/);
  });

  it('protects Turn 2 commit-unknown slot from rolled-back M0 withdrawn PATCH and late auto-compact refusal', async () => {
    const ds = makeDs({ scope: 'thread', rootMessageId: 'om_root_protect_slot' });
    const worker = createFakeWorker();
    ds.worker = worker as any;
    ds.workerGeneration = 1;
    ds.session.workerGeneration = 1;
    setupWorkerHandlers(ds, worker as any, undefined, 1);

    // Turn 1 publishes M0
    ds.currentTurnId = 'om_turn_p1';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_p1';
    ds.streamCardTurnGeneration = 1;
    expect(await postTurnStartingCard(ds, sessionReply, 'om_turn_p1')).toBe(true);
    const m0Id = ds.streamCardId!;

    // Turn 2 parks M0 and hits HTTP 500 after Feishu commits M1
    parkStreamCard(ds);
    ds.currentTurnId = 'om_turn_p2';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_p2';
    ds.streamCardTurnGeneration = 2;
    invalidateTurnStreamingCardPostSlot(ds);

    sim.nextPostMode = () => '500_commit';
    expect(await postTurnStartingCard(ds, sessionReply, 'om_turn_p2')).toBe(false);
    const turn2Uuid = sim.wireAttempts.at(-1)!.uuid;
    expect(ds.streamCardId).toBe(m0Id);

    // Hazard 1: an expired PATCH on rolled-back M0 MUST NOT wipe Turn 2's commit-unknown slot
    sim.nextPatchMode = () => 'expired';
    scheduleCardPatch(ds, '{"stale":"m0"}', 'om_turn_p2');
    await flush();

    // Hazard 2: a late auto-compact safe_composer_required refusal for an older turn MUST NOT wipe Turn 2's slot
    worker.emit('message', {
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'auto-compact:old-1',
      status: 'failed',
      errorCode: 'safe_composer_required',
      composerRefusal: 'composer_not_empty',
    });
    await flush();

    // Turn 2 recovers via screen_update -> MUST still reuse exact turn2Uuid and dedup onto M1!
    sim.nextPostMode = () => 'ok';
    sim.nextPatchMode = () => 'ok';
    worker.emit('message', { type: 'screen_update', content: 'working', status: 'working', turnId: 'om_turn_p2' });
    await flush();
    expect(sim.wireAttempts.at(-1)!.uuid).toBe(turn2Uuid);
    expect(sim.liveMessages().map(m => m.messageId)).toEqual([ds.streamCardId]);
  });

  it('settles turn_terminal cancelled and failed outcomes on screen_update dedup recovery', async () => {
    const ds = makeDs({ scope: 'thread', rootMessageId: 'om_root_terminal_dedup' });
    const worker = createFakeWorker();
    ds.worker = worker as any;
    ds.workerGeneration = 1;
    ds.session.workerGeneration = 1;
    setupWorkerHandlers(ds, worker as any, undefined, 1);

    ds.currentTurnId = 'om_turn_cancel';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_cancel';
    ds.streamCardTurnGeneration = 1;

    sim.nextPostMode = () => '500_commit';
    expect(await postTurnStartingCard(ds, sessionReply, 'om_turn_cancel')).toBe(false);

    // Cancelled terminal arrives during outage while card is still unbound
    worker.emit('message', {
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'om_turn_cancel',
      status: 'cancelled',
    });
    await flush();

    // Outage clears and screen_update('idle') recovers via dedup -> card MUST settle to interrupted (orange)!
    sim.nextPostMode = () => 'ok';
    worker.emit('message', { type: 'screen_update', content: 'stopped', status: 'idle', turnId: 'om_turn_cancel' });
    await flush();
    expect(extractCardTemplate(sim.byId.get(ds.streamCardId!)!.content)).toBe(STREAM_STATUS_TEMPLATE_MAP.interrupted);
  });

  async function expectTerminalDedupPatchRetry(terminalStatus: 'cancelled' | 'completed'): Promise<void> {
    vi.useFakeTimers();
    try {
      const turnId = `om_turn_${terminalStatus}_dedup_retry`;
      const ds = makeDs({ scope: 'thread', rootMessageId: `om_root_${terminalStatus}_dedup_retry` });
      const worker = createFakeWorker();
      ds.worker = worker as any;
      ds.workerGeneration = 1;
      ds.session.workerGeneration = 1;
      setupWorkerHandlers(ds, worker as any, undefined, 1);
      ds.currentTurnId = turnId;
      ds.streamCardPending = true;
      ds.streamCardPendingTurnId = turnId;
      ds.streamCardTurnGeneration = 1;

      sim.nextPostMode = () => '500_commit';
      expect(await postTurnStartingCard(ds, sessionReply, turnId)).toBe(false);
      worker.emit('message', {
        type: 'turn_terminal', sessionId: ds.session.sessionId, turnId, status: terminalStatus,
      });
      await vi.advanceTimersByTimeAsync(0);

      sim.nextPostMode = () => 'ok';
      sim.nextPatchMode = () => '500_fail';
      // Force a divergent body so the deduplicated POST must reconcile the
      // original starting card rather than merely accepting its message id.
      ds.currentTurnTitle = `${terminalStatus}-updated-after-unknown`;
      if (terminalStatus === 'cancelled') {
        worker.emit('message', { type: 'screen_update', content: 'stopped', status: 'idle', turnId });
      } else {
        // A busy post-terminal frame would be discarded as stale. Retry the
        // starting-card entry directly so completed takes the late-publication
        // settleStaleBusyCardStatus path rather than the ordinary live-frame path.
        expect(await postTurnStartingCard(ds, sessionReply, turnId)).toBe(true);
      }
      await vi.advanceTimersByTimeAsync(100);
      const failedPatchCalls = mocks.patch.mock.calls.length;
      expect(failedPatchCalls).toBeGreaterThan(0);

      sim.nextPatchMode = () => 'ok';
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mocks.patch.mock.calls.length).toBeGreaterThan(failedPatchCalls);
      const expectedTemplate = terminalStatus === 'cancelled'
        ? STREAM_STATUS_TEMPLATE_MAP.interrupted
        : STREAM_STATUS_TEMPLATE_MAP.idle;
      expect(extractCardTemplate(sim.byId.get(ds.streamCardId!)!.content)).toBe(expectedTemplate);

      const deliveredPatchCalls = mocks.patch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mocks.patch.mock.calls.length).toBe(deliveredPatchCalls);
    } finally {
      vi.useRealTimers();
    }
  }

  it('retries a failed cancelled-terminal dedup PATCH with the shared bounded backoff', async () => {
    await expectTerminalDedupPatchRetry('cancelled');
  });

  it('retries a failed completed-terminal dedup PATCH with the shared bounded backoff', async () => {
    await expectTerminalDedupPatchRetry('completed');
  });

  it('suppresses a cancelled-terminal dedup retry after a newer working revision', async () => {
    vi.useFakeTimers();
    try {
      const turnId = 'om_turn_cancelled_retry_superseded';
      const ds = makeDs({ scope: 'thread', rootMessageId: 'om_root_cancelled_retry_superseded' });
      const worker = createFakeWorker();
      ds.worker = worker as any;
      ds.workerGeneration = 1;
      ds.session.workerGeneration = 1;
      setupWorkerHandlers(ds, worker as any, undefined, 1);
      ds.currentTurnId = turnId;
      ds.streamCardPending = true;
      ds.streamCardPendingTurnId = turnId;
      ds.streamCardTurnGeneration = 1;

      sim.nextPostMode = () => '500_commit';
      expect(await postTurnStartingCard(ds, sessionReply, turnId)).toBe(false);
      worker.emit('message', {
        type: 'turn_terminal', sessionId: ds.session.sessionId, turnId, status: 'cancelled',
      });
      await vi.advanceTimersByTimeAsync(0);

      sim.nextPostMode = () => 'ok';
      sim.nextPatchMode = () => '500_fail';
      ds.currentTurnTitle = 'cancelled-diverged-body';
      worker.emit('message', { type: 'screen_update', content: 'stopped', status: 'idle', turnId });
      await vi.advanceTimersByTimeAsync(100);
      const interruptedPatchCalls = mocks.patch.mock.calls.length;
      expect(interruptedPatchCalls).toBeGreaterThan(0);

      // A newer working frame owns the card and bumps the render revision. Its
      // PATCH also fails, so it must not clear the older dedup retry by accident.
      worker.emit('message', { type: 'screen_update', content: 'resumed', status: 'working', turnId });
      await vi.advanceTimersByTimeAsync(100);
      const workingPatchCalls = mocks.patch.mock.calls.length;
      expect(workingPatchCalls).toBeGreaterThan(interruptedPatchCalls);

      sim.nextPatchMode = () => 'ok';
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mocks.patch.mock.calls.length).toBe(workingPatchCalls);

      // The current live state remains retryable by a fresh frame even though
      // the obsolete terminal retry was suppressed.
      worker.emit('message', { type: 'screen_update', content: 'resumed', status: 'working', turnId });
      await vi.advanceTimersByTimeAsync(100);
      expect(extractCardTemplate(sim.byId.get(ds.streamCardId!)!.content)).toBe(STREAM_STATUS_TEMPLATE_MAP.working);
    } finally {
      vi.useRealTimers();
    }
  });

  it('guards postFreshStreamingCard against silent listener sessions and does not cascade postTurnStartingCard after ownership loss on catch', async () => {
    // 1. Silent message-listener session -> postFreshStreamingCard returns false with zero wire posts and no empty streamCardId
    const dsSilent = makeDs({ scope: 'thread', rootMessageId: 'om_root_silent_card' });
    dsSilent.session.messageListenerRun = { sourceMessageId: 'om_root_silent_card', replyMode: 'none' } as any;
    const attemptsBefore = sim.wireAttempts.length;
    expect(await postFreshStreamingCard(dsSilent, sessionReply, { retireMessageId: 'om_should_keep' })).toBe(false);
    expect(sim.wireAttempts.slice(attemptsBefore)).toHaveLength(0);
    expect(dsSilent.streamCardId).toBeUndefined();
    expect(sim.deletes).not.toContain('om_should_keep');

    // 2. Ownership loss (closeSession) during in-flight /card rejection with superseded turn -> MUST return false without cascading postTurnStartingCard!
    const dsClosed = makeDs({ scope: 'thread', rootMessageId: 'om_root_closed_card' });
    dsClosed.streamCardTurnGeneration = 1;
    let rejectManual!: () => void;
    const entered = new Promise<void>(resolveEntered => {
      mocks.reply.mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectManual = () => reject(makeAxios500Code2200());
        resolveEntered();
      }));
    });
    const manualPromise = postFreshStreamingCard(dsClosed, sessionReply);
    await entered;

    dsClosed.currentTurnId = 'om_turn_after_close';
    dsClosed.streamCardPending = true;
    dsClosed.streamCardPendingTurnId = 'om_turn_after_close';
    dsClosed.streamCardTurnGeneration = 2;
    await closeSession(dsClosed.session.sessionId);

    const attemptsBeforeReject = sim.wireAttempts.length;
    rejectManual();
    expect(await manualPromise).toBe(false);
    await flush();
    expect(sim.wireAttempts.slice(attemptsBeforeReject)).toHaveLength(0);
  });
});
