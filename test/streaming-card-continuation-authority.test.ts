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
  getActiveSessionsRegistry,
  initWorkerPool,
  postFreshStreamingCard,
  postTurnStartingCard,
  setActiveSessionsRegistry,
  __testOnly_setupWorkerHandlers as setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import { controllerForSession } from '../src/core/session-controller.js';
import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import * as sessionStore from '../src/services/session-store.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { __testOnly_activeSessions as activeSessions, __testOnly_sessionReply as sessionReply } from '../src/daemon.js';
import { __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';

const APP = 'cli_card_cont_auth';
const oldDataDir = config.session.dataDir;
const originalRegistry = getActiveSessionsRegistry();
let home: string;
let dataDir: string;
let ds: DaemonSession;
let closeStores: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  __testOnly_resetLarkGate();
  vi.stubEnv('BOTMUX_LARK_QPS', '100000');
  vi.stubEnv('BOTMUX_LARK_GATE_RETRY_BASE_MS', '1');
  home = mkdtempSync(join(tmpdir(), 'card-cont-authority-'));
  dataDir = join(home, 'data');
  mkdirSync(dataDir, { mode: 0o700 });
  config.session.dataDir = dataDir;
  activeSessions.clear();
  setActiveSessionsRegistry(activeSessions);
  registerBot({
    larkAppId: APP,
    larkAppSecret: 'test-secret',
    cliId: 'antigravity',
    topicUnavailablePolicy: 'stop',
    replyCardMode: 'legacy',
  });
  sessionStore.init(APP);
  const stored = sessionStore.createSession('oc_source', 'om_source', 'source', 'group', 'thread');
  ds = {
    larkAppId: APP,
    chatId: 'oc_source',
    scope: 'thread',
    chatType: 'group',
    currentTurnId: 'om_turn_1',
    currentReplyTarget: { turnId: 'om_turn_1', rootMessageId: 'om_source' },
    session: {
      ...stored,
      larkAppId: APP,
      chatId: 'oc_source',
      scope: 'thread',
      rootMessageId: 'om_source',
      cliId: 'antigravity',
      status: 'active',
      title: 'source',
      workingDir: dataDir,
    },
  } as unknown as DaemonSession;
  sessionStore.updateSession(ds.session);
  activeSessions.set(activeSessionKey(ds), ds);
  initWorkerPool({
    sessionReply,
    getSessionWorkingDir: () => dataDir,
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
  mocks.request.mockReset().mockImplementation(async ({ method, url }) => {
    if (method === 'GET' && url.includes('/im/v1/chats/')) {
      return { code: 0, data: { chat_mode: 'group' } };
    }
    if (method !== 'GET' || !url.includes('/im/v1/messages/')) {
      throw new Error(`Unexpected provider request: ${method} ${url}`);
    }
    const id = url.split('/').at(-1);
    return {
      code: 0,
      data: {
        items: [{ message_id: id, chat_id: 'oc_source', deleted: false }],
      },
    };
  });
  mocks.create.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_sent' } });
  mocks.reply.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_sent' } });
  mocks.patch.mockReset().mockResolvedValue({ code: 0 });
  mocks.delete.mockReset().mockResolvedValue({ code: 0 });
  mocks.upload.mockReset().mockResolvedValue({ file_key: 'file_overflow' });
  closeStores = [];
});

afterEach(() => {
  for (const fn of closeStores.splice(0)) {
    try { fn(); } catch { /* already closed */ }
  }
  activeSessions.clear();
  setActiveSessionsRegistry(originalRegistry);
  ds.session.status = 'closed';
  sessionStore.init(APP, { owner: false });
  config.session.dataDir = oldDataDir;
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
  __testOnly_resetLarkGate();
});

function createFakeWorker() {
  return Object.assign(new EventEmitter(), {
    killed: false,
    send: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

describe('streaming card authority across same-worker runtime continuations and non-continued replacements', () => {
  it('retains the initial ready streaming card when the same worker continues its runtime mid-POST, and preserves it across silent restart recovery', async () => {
    const controller = controllerForSession(ds, true)!;
    closeStores.push(() => controller.store.close());
    ds.initConfig = { sessionContract: controller.bindWorker(1) } as any;
    const worker = createFakeWorker();
    ds.worker = worker as any;
    ds.workerGeneration = 1;
    ds.session.workerGeneration = 1;
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_1';
    setupWorkerHandlers(ds, worker as any, undefined, 1);
    const workerRef = controller.store.read(controller.ref)!.worker!;
    const r1 = controller.reserveBinding('b1-launcher', workerRef);
    controller.bindRuntime('b1-launcher', workerRef, {
      backend: 'tmux',
      physicalId: '100:launcherStart',
      proof: 'process_start',
    });

    let resolvePost!: (value: { code: number; data: { message_id: string } }) => void;
    let postInFlight = false;
    mocks.reply.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          postInFlight = true;
          resolvePost = resolve;
        }),
    );

    const readyPromise = worker.listeners('message')[0]({
      type: 'ready',
      port: 9999,
      token: 'fixture',
      turnId: 'om_turn_1',
      sessionContract: {
        version: 2,
        session: controller.ref,
        producer: workerRef,
        bindingId: 'b1-launcher',
        eventId: `${workerRef.workerId}:1`,
        sequence: 1,
        scope: { runtime: r1 },
      },
    });

    await vi.waitFor(() => expect(postInFlight).toBe(true));
    expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);

    // Same worker unwraps/discovers its native conversation id mid-POST (`continuesBindingId: 'b1-launcher'`).
    const r2 = controller.reserveBinding('b2-conv', workerRef);
    controller.bindRuntime(
      'b2-conv',
      workerRef,
      {
        backend: 'tmux',
        physicalId: '200:leafStart',
        nativeSessionId: 'conv-live-08fa7247',
        proof: 'process_start',
      },
      undefined,
      'b1-launcher',
    );
    expect(controller.currentRuntime()).toEqual(r2);

    resolvePost({ code: 0, data: { message_id: 'om_card_live_1' } });
    await readyPromise;

    // Must NOT withdraw the card on an in-process continuation, and must commit streamCardId!
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(ds.streamCardId).toBe('om_card_live_1');
    expect(ds.session.streamCardId).toBe('om_card_live_1');

    // Subsequent silent daemon restart (`suppressRecoveryCard: true`) restores and PATCHes the surviving card.
    const ds2 = {
      ...ds,
      workerReady: false,
      workerGeneration: 2,
      suppressRecoveryCard: true,
      streamCardId: ds.session.streamCardId,
      streamCardNonce: ds.session.streamCardNonce,
      session: { ...ds.session, workerGeneration: 2 },
    } as unknown as DaemonSession;
    activeSessions.set(activeSessionKey(ds2), ds2);
    const controller2 = controllerForSession(ds2, true)!;
    ds2.initConfig = { sessionContract: controller2.bindWorker(2) } as any;
    const worker2 = createFakeWorker();
    ds2.worker = worker2 as any;
    setupWorkerHandlers(ds2, worker2 as any, undefined, 2);
    const workerRef2 = controller2.store.read(controller2.ref)!.worker!;
    controller2.reserveBinding('b3-reattach', workerRef2);
    const bound3 = controller2.bindRuntime('b3-reattach', workerRef2, {
      backend: 'tmux',
      physicalId: '200:leafStart',
      nativeSessionId: 'conv-live-08fa7247',
      proof: 'process_start',
    });

    await worker2.listeners('message')[0]({
      type: 'ready',
      port: 9998,
      token: 'fixture-2',
      sessionContract: {
        version: 2,
        session: controller2.ref,
        producer: workerRef2,
        bindingId: 'b3-reattach',
        eventId: `${workerRef2.workerId}:1`,
        sequence: 1,
        scope: { runtime: bound3.ref },
      },
    });
    await worker2.listeners('message')[0]({
      type: 'screen_update',
      content: 'Resumed session idle',
      status: 'idle',
      sessionContract: {
        version: 2,
        session: controller2.ref,
        producer: workerRef2,
        bindingId: 'b3-reattach',
        eventId: `${workerRef2.workerId}:2`,
        sequence: 2,
        scope: { runtime: bound3.ref },
      },
    });

    expect(ds2.streamCardId).toBe('om_card_live_1');
    expect(mocks.delete).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mocks.patch.mock.calls.some(([req]) => req.path.message_id === 'om_card_live_1')).toBe(true);
    });
  });

  it('retains a turn-less ready card (no execution scope) when the same worker continues its runtime mid-POST', async () => {
    // A worker spawned without an opening prompt reports ready with no turnId,
    // so the admitted event carries only a runtime scope. A ready with a turnId
    // gets an execution attached on admission and exercises a different branch.
    const controller = controllerForSession(ds, true)!;
    closeStores.push(() => controller.store.close());
    ds.initConfig = { sessionContract: controller.bindWorker(1) } as any;
    const worker = createFakeWorker();
    ds.worker = worker as any;
    ds.workerGeneration = 1;
    ds.session.workerGeneration = 1;
    setupWorkerHandlers(ds, worker as any, undefined, 1);
    const workerRef = controller.store.read(controller.ref)!.worker!;
    const r1 = controller.reserveBinding('b1-turnless', workerRef);
    controller.bindRuntime('b1-turnless', workerRef, {
      backend: 'tmux',
      physicalId: '100:turnlessLauncher',
      proof: 'process_start',
    });

    let resolvePost!: (value: { code: number; data: { message_id: string } }) => void;
    let postInFlight = false;
    mocks.reply.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          postInFlight = true;
          resolvePost = resolve;
        }),
    );

    const readyPromise = worker.listeners('message')[0]({
      type: 'ready',
      port: 9999,
      token: 'fixture',
      sessionContract: {
        version: 2,
        session: controller.ref,
        producer: workerRef,
        bindingId: 'b1-turnless',
        eventId: `${workerRef.workerId}:1`,
        sequence: 1,
        scope: { runtime: r1 },
      },
    });

    await vi.waitFor(() => expect(postInFlight).toBe(true));
    expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);

    controller.reserveBinding('b2-turnless-leaf', workerRef);
    const bound2 = controller.bindRuntime(
      'b2-turnless-leaf',
      workerRef,
      {
        backend: 'tmux',
        physicalId: '200:turnlessLeaf',
        nativeSessionId: 'conv-turnless',
        proof: 'process_start',
      },
      undefined,
      'b1-turnless',
    );
    expect(controller.currentRuntime()).toEqual(bound2.ref);

    resolvePost({ code: 0, data: { message_id: 'om_card_turnless' } });
    await readyPromise;

    expect(mocks.delete).not.toHaveBeenCalled();
    expect(ds.streamCardId).toBe('om_card_turnless');
    expect(ds.session.streamCardId).toBe('om_card_turnless');
  });

  it('retains the initial ready streaming card even when the opening turn already bound to the continued runtime before ready POST resolves', async () => {
    const controller = controllerForSession(ds, true)!;
    closeStores.push(() => controller.store.close());
    ds.initConfig = { sessionContract: controller.bindWorker(1) } as any;
    const worker = createFakeWorker();
    ds.worker = worker as any;
    ds.workerGeneration = 1;
    ds.session.workerGeneration = 1;
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_1';
    setupWorkerHandlers(ds, worker as any, undefined, 1);
    const workerRef = controller.store.read(controller.ref)!.worker!;
    const execution = controller.admitInput('om_turn_1');
    const r1 = controller.reserveBinding('b1-launcher', workerRef);
    controller.bindRuntime('b1-launcher', workerRef, {
      backend: 'tmux',
      physicalId: '100:launcherStart',
      proof: 'process_start',
    });

    let resolvePost!: (value: { code: number; data: { message_id: string } }) => void;
    let postInFlight = false;
    mocks.reply.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          postInFlight = true;
          resolvePost = resolve;
        }),
    );

    const readyPromise = worker.listeners('message')[0]({
      type: 'ready',
      port: 9999,
      token: 'fixture',
      turnId: 'om_turn_1',
      sessionContract: {
        version: 2,
        session: controller.ref,
        producer: workerRef,
        bindingId: 'b1-launcher',
        eventId: `${workerRef.workerId}:1`,
        sequence: 1,
        scope: { runtime: r1, execution },
      },
    });

    await vi.waitFor(() => expect(postInFlight).toBe(true));

    // CLI unwraps to leaf runtime r2 AND starts executing om_turn_1 on r2 before ready POST returns.
    controller.reserveBinding('b2-leaf', workerRef);
    const bound2 = controller.bindRuntime(
      'b2-leaf',
      workerRef,
      {
        backend: 'tmux',
        physicalId: '200:leafStart',
        nativeSessionId: 'conv-live-08fa7247-c',
        proof: 'process_start',
      },
      undefined,
      'b1-launcher',
    );
    await worker.listeners('message')[0]({
      type: 'turn_execution_started',
      turnId: 'om_turn_1',
      startedAtMs: Date.now() - 10,
      sessionContract: {
        version: 2,
        session: controller.ref,
        producer: workerRef,
        bindingId: 'b2-leaf',
        eventId: `${workerRef.workerId}:2`,
        sequence: 2,
        scope: { runtime: bound2.ref, execution },
      },
    });

    resolvePost({ code: 0, data: { message_id: 'om_card_live_c' } });
    await readyPromise;

    expect(mocks.delete).not.toHaveBeenCalled();
    expect(ds.streamCardId).toBe('om_card_live_c');
    expect(ds.session.streamCardId).toBe('om_card_live_c');
  });

  it('withdraws a stale card on non-continued runtime replacement AND rolls back CARD_POSTING_SENTINEL so the new runtime can post a fresh card', async () => {
    const controller = controllerForSession(ds, true)!;
    closeStores.push(() => controller.store.close());
    ds.initConfig = { sessionContract: controller.bindWorker(1) } as any;
    const worker = createFakeWorker();
    ds.worker = worker as any;
    ds.workerGeneration = 1;
    ds.session.workerGeneration = 1;
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_1';
    setupWorkerHandlers(ds, worker as any, undefined, 1);
    const workerRef = controller.store.read(controller.ref)!.worker!;
    const r1 = controller.reserveBinding('b1-initial', workerRef);
    controller.bindRuntime('b1-initial', workerRef, {
      backend: 'tmux',
      physicalId: '100:initialStart',
      proof: 'process_start',
    });

    let resolveFirstPost!: (value: { code: number; data: { message_id: string } }) => void;
    let firstPostInFlight = false;
    mocks.reply.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          firstPostInFlight = true;
          resolveFirstPost = resolve;
        }),
    );

    const readyPromise = worker.listeners('message')[0]({
      type: 'ready',
      port: 9999,
      token: 'fixture',
      turnId: 'om_turn_1',
      sessionContract: {
        version: 2,
        session: controller.ref,
        producer: workerRef,
        bindingId: 'b1-initial',
        eventId: `${workerRef.workerId}:1`,
        sequence: 1,
        scope: { runtime: r1 },
      },
    });

    await vi.waitFor(() => expect(firstPostInFlight).toBe(true));
    expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);

    // Non-continued runtime replacement (NO continuesBindingId — e.g. CLI respawned).
    const r2 = controller.reserveBinding('b2-respawn', workerRef);
    controller.bindRuntime('b2-respawn', workerRef, {
      backend: 'tmux',
      physicalId: '999:respawnStart',
      nativeSessionId: 'conv-respawn',
      proof: 'process_start',
    });

    resolveFirstPost({ code: 0, data: { message_id: 'om_card_stale_1' } });
    await readyPromise;

    await vi.waitFor(() => {
      expect(mocks.delete).toHaveBeenCalledWith({ path: { message_id: 'om_card_stale_1' } });
    });
    // Sentinel MUST be rolled back rather than stranding ds.streamCardId === '__posting__' forever!
    expect(ds.streamCardId).toBeUndefined();

    // Subsequent screen_update on the replacement runtime r2 can now post a fresh card!
    mocks.reply.mockResolvedValueOnce({ code: 0, data: { message_id: 'om_card_fresh_2' } });
    await worker.listeners('message')[0]({
      type: 'screen_update',
      content: 'Working on task...',
      status: 'working',
      turnId: 'om_turn_1',
      sessionContract: {
        version: 2,
        session: controller.ref,
        producer: workerRef,
        bindingId: 'b2-respawn',
        eventId: `${workerRef.workerId}:2`,
        sequence: 2,
        scope: { runtime: r2 },
      },
    });
    await vi.waitFor(() => expect(ds.streamCardId).toBe('om_card_fresh_2'));
  });

  it('restores pre-POST card identity when non-retirement ownership drops in postTurnStartingCard and postFreshStreamingCard', async () => {
    ds.workerReady = true;
    ds.streamCardId = 'om_existing_card';
    ds.streamCardNonce = 'nonce_existing';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_1';
    ds.session.handoffLiveCard = { turnId: 'om_turn_1', closed: true } as any;

    const startingResult = await postTurnStartingCard(ds, sessionReply, 'om_turn_1');
    expect(startingResult).toBe(false);
    expect(ds.streamCardId).toBe('om_existing_card');
    expect(ds.streamCardNonce).toBe('nonce_existing');

    ds.session.handoffLiveCard = undefined;
    ds.streamCardId = 'om_existing_card';
    ds.streamCardNonce = 'nonce_existing';

    let resolveManualPost!: (value: { code: number; data: { message_id: string } }) => void;
    let manualPostInFlight = false;
    mocks.reply.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          manualPostInFlight = true;
          resolveManualPost = resolve;
        }),
    );

    const freshPromise = postFreshStreamingCard(ds, sessionReply);
    await vi.waitFor(() => expect(manualPostInFlight).toBe(true));
    expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);

    // Bot switches to apiOnly while the manual /card POST is in flight (non-retirement transport loss).
    registerBot({
      larkAppId: APP,
      larkAppSecret: 'test-secret',
      cliId: 'antigravity',
      topicUnavailablePolicy: 'stop',
      replyCardMode: 'legacy',
      apiOnly: true,
    });
    resolveManualPost({ code: 0, data: { message_id: 'om_manual_discarded' } });
    const freshResult = await freshPromise;
    expect(freshResult).toBe(false);
    expect(ds.streamCardId).toBe('om_existing_card');
    expect(ds.streamCardId).not.toBe(CARD_POSTING_SENTINEL);
  });

  it('rolls back the posting sentinel on the screen_update POST path when a non-continued replacement wins ownership mid-flight', async () => {
    const controller = controllerForSession(ds, true)!;
    closeStores.push(() => controller.store.close());
    ds.initConfig = { sessionContract: controller.bindWorker(1) } as any;
    const worker = createFakeWorker();
    ds.worker = worker as any;
    ds.workerGeneration = 1;
    ds.session.workerGeneration = 1;
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_1';
    setupWorkerHandlers(ds, worker as any, undefined, 1);
    const workerRef = controller.store.read(controller.ref)!.worker!;
    const r1 = controller.reserveBinding('b1-screen', workerRef);
    controller.bindRuntime('b1-screen', workerRef, {
      backend: 'tmux',
      physicalId: '100:screenStart',
      proof: 'process_start',
    });

    // A completed ready POST drives the contract worker_online, so the later
    // screen_update passes the workerHasInitialized gate (workerReady is a
    // contract-backed read-only accessor once a controller exists).
    mocks.reply.mockResolvedValueOnce({ code: 0, data: { message_id: 'om_first_card' } });
    await worker.listeners('message')[0]({
      type: 'ready',
      port: 9999,
      token: 'fixture',
      turnId: 'om_turn_1',
      sessionContract: {
        version: 2,
        session: controller.ref,
        producer: workerRef,
        bindingId: 'b1-screen',
        eventId: `${workerRef.workerId}:1`,
        sequence: 1,
        scope: { runtime: r1 },
      },
    });
    expect(ds.workerReady).toBe(true);
    expect(ds.streamCardId).toBe('om_first_card');
    // Simulate a session whose live card was lost without a successor, so the
    // next screen_update takes the fresh-card POST branch.
    ds.streamCardId = undefined;

    let resolveScreen!: (value: { code: number; data: { message_id: string } }) => void;
    let screenPostInFlight = false;
    mocks.reply.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          screenPostInFlight = true;
          resolveScreen = resolve;
        }),
    );

    worker.listeners('message')[0]({
      type: 'screen_update',
      content: 'working...',
      status: 'working',
      turnId: 'om_turn_1',
      sessionContract: {
        version: 2,
        session: controller.ref,
        producer: workerRef,
        bindingId: 'b1-screen',
        eventId: `${workerRef.workerId}:2`,
        sequence: 2,
        scope: { runtime: r1 },
      },
    });

    await vi.waitFor(() => expect(screenPostInFlight).toBe(true));
    expect(ds.streamCardId).toBe(CARD_POSTING_SENTINEL);

    // Non-continued replacement (no continuesBindingId) wins ownership mid-POST.
    const r2 = controller.reserveBinding('b2-screen-respawn', workerRef);
    controller.bindRuntime('b2-screen-respawn', workerRef, {
      backend: 'tmux',
      physicalId: '999:screenRespawn',
      nativeSessionId: 'conv-screen-respawn',
      proof: 'process_start',
    });

    resolveScreen({ code: 0, data: { message_id: 'om_screen_stale' } });

    await vi.waitFor(() => {
      expect(mocks.delete).toHaveBeenCalledWith({ path: { message_id: 'om_screen_stale' } });
    });
    // Sentinel must be rolled back on the screen_update path too, not left stuck.
    expect(ds.streamCardId).toBeUndefined();

    // The replacement runtime's next screen_update can now POST a fresh card.
    mocks.reply.mockResolvedValueOnce({ code: 0, data: { message_id: 'om_screen_fresh' } });
    worker.listeners('message')[0]({
      type: 'screen_update',
      content: 'still working...',
      status: 'working',
      turnId: 'om_turn_1',
      sessionContract: {
        version: 2,
        session: controller.ref,
        producer: workerRef,
        bindingId: 'b2-screen-respawn',
        eventId: `${workerRef.workerId}:3`,
        sequence: 3,
        scope: { runtime: r2 },
      },
    });
    await vi.waitFor(() => expect(ds.streamCardId).toBe('om_screen_fresh'));
  });

  it('restores pre-POST card identity at the starting-card entry gate when a closed handoff loses ownership while the post identity still holds', async () => {
    // No session controller here: workerReady stays a plain writable field,
    // mirroring the standalone postTurnStartingCard harness above.
    ds.workerReady = true;
    ds.streamCardId = 'om_existing_card';
    ds.streamCardNonce = 'nonce_existing';
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_turn_1';
    // A manual card matching the live identity keeps streaming cards enabled
    // (handoffCardBlocksStreaming === false) while the closed handoff still
    // makes stillOwnsPost() false at the entry gate — without retiring the
    // session, so the generic (non-retirement-only) rollback must run.
    ds.session.handoffLiveCard = {
      turnId: 'om_turn_1',
      closed: true,
      manualCard: { messageId: 'om_existing_card', nonce: 'nonce_existing' },
    } as any;

    const startingResult = await postTurnStartingCard(ds, sessionReply, 'om_turn_1');
    expect(startingResult).toBe(false);
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(ds.streamCardId).toBe('om_existing_card');
    expect(ds.streamCardNonce).toBe('nonce_existing');
    expect(ds.streamCardId).not.toBe(CARD_POSTING_SENTINEL);
  });
});
