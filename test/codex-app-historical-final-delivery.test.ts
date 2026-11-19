import * as registrationStore from '../src/services/idempotency-store.js';
/**
 * P2: daemon-side retry of `final_output` on transient Lark failures.
 *
 * The worker pops each turn off its queue at emit time and never re-sends
 * the same payload, so the daemon owns retry. We verify:
 *   - transient sessionReply rejections retry up to 3 times with backoff
 *   - dedup marker is committed only after a successful send
 *   - MessageWithdrawnError aborts retries (no point), commits dedup, and
 *     closes the session
 *   - 3 consecutive failures give up and DO NOT commit the dedup marker
 *     (so any retransmit can still deliver)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { config } from '../src/config.js';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { bindGroupContextDelivery, readGroupContextDeliveryBinding, writePreparedGroupContext } from '../src/services/group-context-delivery-store.js';
import { groupContextEpoch } from '../src/services/group-context-prompt.js';
import MarkdownIt from 'markdown-it';
import * as cotMessage from '../src/im/lark/cot-message.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { outputSnapshot } from '../src/services/universal-output-handoff.js';
import { OutputDeliveryJournal, outputDeliveryJournal } from '../src/services/output-delivery-journal.js';
import { OutputDeliveryCoordinator } from '../src/services/output-delivery-coordinator.js';
import { LocalAddressOutboundError, prepareLocalAddressContent } from '../src/im/lark/local-address-policy.js';
import { localAddressContextForBot } from '../src/im/lark/local-address-context.js';
import { localHttpOrigin } from '../src/core/dashboard-url.js';
import { finalOutputSnapshot } from '../src/services/final-output-handoff.js';
import { FinalOutputHandoffStore } from '../src/services/final-output-handoff-store.js';
import { FinalOutputHandoffHost, FinalOutputRejectedError } from '../src/services/final-output-handoff-host.js';
import { TurnSendLedger } from '../src/services/turn-send-ledger.js';

const topicDetailMock = vi.fn(async () => ({ items: [{ message_id: 'om_root', deleted: true }] }));
const updateMessageMock = vi.fn(async () => {});
const uploadImageMock = vi.fn(async (_appId: string, _image: string | Buffer) => 'img_v3_uploaded_preview');
const addReactionMock = vi.fn(async () => 'reaction_id');
const replyToDocCommentMock = vi.fn(async () => {});
const removeCommentReactionMock = vi.fn(async () => {});
const updateSessionMock = vi.fn();
const resolveAllowedUsersWithMapMock = vi.fn(async (_appId: string, entries: string[]) => ({
  resolved: entries,
  map: new Map(entries.map(entry => [entry, entry])),
  entryStatus: new Map(entries.map(entry => [entry, 'resolved' as const])),
}));
vi.mock('../src/im/lark/client.js', () => ({
  getMessageDetail: (...args: any[]) => topicDetailMock(...args),
  updateMessage: (...args: any[]) => updateMessageMock(...args),
  uploadImage: (appId: string, image: string | Buffer) => uploadImageMock(appId, image),
  addReaction: (...args: any[]) => addReactionMock(...args),
  resolveAllowedUsersWithMap: (...args: any[]) => resolveAllowedUsersWithMapMock(...args),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/doc-comment.js', () => ({
  replyToDocComment: (...args: any[]) => replyToDocCommentMock(...args),
  chunkCommentText: vi.fn((content: string) => [content]),
  unsubscribeDocFile: vi.fn(async () => {}),
  removeCommentReaction: (...args: any[]) => removeCommentReactionMock(...args),
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  buildTurnFailedCard: vi.fn((opts: { mentionOpenId?: string }) => JSON.stringify({ turnFailed: true, mentionOpenId: opts.mentionOpenId })),
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  // Bot admin (first resolved human allowedUser) — the failure-notice fallback
  // @ target. Tests that exercise turnFailed override this per case.
  getOwnerOpenId: vi.fn(() => undefined),
  // Reply-card footer usage only renders in 'footer' mode; tests override this
  // per case. Default 'footer' keeps the positive usage-render tests below green.
  resolveUsageDisplay: vi.fn(() => 'footer'),
  normalizeUsageDisplay: vi.fn(() => 'footer'),
  // Per-bot replyDelivery 的显式配置值。缺省给显式 'send'（绝大多数用例的前提）；
  // transcript 用例逐个翻转。undefined = 未配置，交由 effectiveReplyDelivery 按缺省
  // 解析（见 completedIdleTurnId 用例）。
  resolveReplyDelivery: vi.fn((): 'send' | 'transcript' | undefined => 'send'),
}));

vi.mock('../src/config.js', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return {
    config: {
      web: { externalHost: 'localhost' },
      dashboard: { externalHost: 'localhost', port: 7891 },
      // Concurrent checkouts/processes must never reset each other's journals.
      session: { dataDir: mkdtempSync(join(tmpdir(), 'bridge-final-output-')) },
      daemon: { backendType: 'tmux', cliId: 'claude-code' },
    },
  };
});

vi.mock('../src/core/cost-calculator.js', () => ({
  getSessionTokenUsage: vi.fn(() => null),
  getSessionUsageWithContext: vi.fn(() => ({ snapshot: { context: null, tokens: null, turnTokens: null } })),
  getSessionUsageSnapshot: vi.fn(() => ({
    context: { usedTokens: 12_345, windowTokens: 100_000, percentUsed: 12 },
    tokens: { in: 67_890, out: 123 },
  })),
}));

vi.mock('../src/services/session-store.js', () => ({
  getSession: vi.fn(() => undefined),
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: (...args: any[]) => updateSessionMock(...args),
  createSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/services/session-lifecycle-hooks.js', () => ({
  emitSessionLifecycleHook: vi.fn(() => true),
  emitSessionStateTransitionHook: vi.fn(() => true),
  setSessionLifecycleShutdown: vi.fn(),
}));

const linkRefRuntime = vi.hoisted(() => ({ current: undefined as any }));
vi.mock('../src/services/link-ref-runtime.js', () => ({
  getLinkRefRuntime: () => linkRefRuntime.current,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import {
  getDaemonReplyCardUsageSnapshot,
  getDaemonReplyCardRenderSnapshot,
  initWorkerPool,
  postTurnStartingCard,
  pruneSteerFanoutState,
  __testOnly_setupWorkerHandlers,
  sendWorkerInput,
  __testOnly_resetOrdinaryImDeliveries,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import { MessageWithdrawnError } from '../src/im/lark/client.js';
import { markRetryAttempt } from '../src/services/failed-turn-retry.js';
import { holdPurgeClickRollback, PURGE_CONTINUATION_WITHHELD, PURGE_IMAGES_NOT_APPLIED } from '../src/services/image-purge-recovery.js';
import { emitSessionLifecycleHook } from '../src/services/session-lifecycle-hooks.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import { EventEmitter } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acceptVcMeetingDelivery,
  applyVcMeetingMemberProjection,
  completeVcMeetingDelivery,
  failVcMeetingDelivery,
  markVcMeetingDeliveryAmbiguous,
  markVcMeetingDeliveryDispatched,
} from '../src/services/vc-meeting-delivery-store.js';
import { listVcMeetingActions } from '../src/services/vc-meeting-action-store.js';
import { listVcMeetingListenerMessageIds } from '../src/services/vc-meeting-listener-message-store.js';
import { getSessionUsageSnapshot } from '../src/core/cost-calculator.js';
import { getBot, getBotClient, getOwnerOpenId, resolveBrandLabel, resolveReplyDelivery, resolveUsageDisplay } from '../src/bot-registry.js';
import { buildStreamingCard } from '../src/im/lark/card-builder.js';
import {
  clearMessageListenerRunPreviewStore,
  createMessageListenerRunPreview,
  getMessageListenerRunPreview,
  markMessageListenerRunPreviewTriggered,
} from '../src/services/message-listener-run-preview-store.js';

// Build a fake worker child process whose IPC `message` event we can fire
// manually, then wire it through setupWorkerHandlers via forkAdoptWorker.
// To keep this test focused on the retry pipeline (and avoid spawning a
// real fork), we exercise the case branch by invoking the registered
// listener directly.

function makeDs(): DaemonSession {
  const fakeWorker = new EventEmitter() as any;
  fakeWorker.killed = false;
  fakeWorker.send = vi.fn();
  fakeWorker.kill = vi.fn();
  fakeWorker.pid = 99999;
  fakeWorker.stdout = new EventEmitter();
  fakeWorker.stderr = new EventEmitter();
  return {
    session: {
      sessionId: 'sid-final-out',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker: fakeWorker,
    workerPort: 0,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: false,
    adoptedFrom: {
      tmuxTarget: '0:1.0',
      originalCliPid: 1234,
      sessionId: 'claude-session-xyz',
      cliId: 'claude-code' as const,
      cwd: '/tmp',
    },
  };
}


import { controllerForSession } from '../src/core/session-controller.js';
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a,b) => { resolve=a;reject=b; }); return {promise,resolve,reject}; }
const stores: Array<{ close(): void }> = [];
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { for (const s of stores.splice(0)) s.close(); setActiveSessionsRegistry(undefined); __testOnly_resetOrdinaryImDeliveries(); vi.useRealTimers(); });
async function fixture(reply: (...args: any[]) => Promise<string>) {
  const sessionReply = vi.fn(reply);
  initWorkerPool({ sessionReply, getSessionWorkingDir: () => config.session.dataDir, getActiveCount: () => 1, closeSession: vi.fn() });
  const ds = makeDs(); ds.adoptedFrom = undefined;
  ds.session.sessionId = `historical-delivery-${Math.random()}`; ds.session.cliId = 'codex-app';
  ds.workerGeneration = ds.session.workerGeneration = 2;
  const controller = controllerForSession(ds, true)!; stores.push(controller.store);
  const ref = controller.ref; const store = controller.store; const oldWorker = controller.bindWorker(1).worker;
  const old = controller.reserveBinding('old', oldWorker);
  const identity: any = { backend: 'tmux', physicalId: '111:start111', nativeSessionId: 'native1', proof: 'process_start' };
  controller.bindRuntime('old', oldWorker, identity);
  const execution = controller.admitInput('old-turn', 1); store.bindQueuedExecution(ref, execution, old);
  store.apply(ref, { type: 'execution_phase', runtime: old, execution, phase: 'submitting' }); controller.workerLost(oldWorker);
  const bootstrap = controller.bindWorker(2); const producer = bootstrap.worker;
  const current = controller.reserveBinding('current', producer); const bare = { ...identity }; delete bare.nativeSessionId;
  controller.bindRuntime('current', producer, bare);
  const middle = controller.admitInput('newer-turn', 2); store.bindQueuedExecution(ref, middle, current);
  store.apply(ref, { type: 'execution_phase', runtime: current, execution: middle, phase: 'submitting' });
  controller.bindRuntime('current', producer, identity); expect(store.authorizeExecutionObserver(ref, producer, execution)).toBe(true);
  store.apply(ref, { type: 'worker_online', worker: producer }); controller.refresh();
  ds.initConfig = { cliId: 'codex-app', sessionContract: bootstrap } as any;
  ds.session.codexAppDispatchLedger = [
    { dispatchId: 'dispatch-old', turnId: 'old-turn', dispatchAttempt: 1, state: 'prepared', content: 'old', deliverySink: 'lark', codexAppSteerable: true },
    { dispatchId: 'dispatch-next', turnId: 'newer-turn', dispatchAttempt: 2, state: 'prepared', content: 'next', deliverySink: 'lark', codexAppSteerable: true },
  ];
  const sent = (ds.worker as any).send;
  __testOnly_setupWorkerHandlers(ds, ds.worker as any, undefined, 2);
  const worker: any = ds.worker;
  const origin: any = { version: 2, session: ref, producer, sequence: 1, eventId: `${producer.workerId}:1`, scope: { runtime: old, execution } };
  const msg: any = { type: 'final_output', sessionId: ref.sessionId, turnId: 'old-turn', dispatchAttempt: 1, content: 'retained native answer', lastUuid: 'old-turn',
    sessionContract: origin, sessionOutputOrigin: origin,
    codexAppSettlement: { requestId: 'persist-old', dispatchId: 'dispatch-old', generation: 'generation-original', seq: 7 } };
  return { ds, controller, ref, current, old, execution, middle, worker, msg, sessionReply, sent,
    run: (message = msg) => worker.listeners('message')[0](message) as Promise<void> };
}
describe('contentful historical Codex App settlement delivery', () => {
  it('delivers the retained answer through the actual handler and transport before ledger ACK', async () => {
    const network = deferred<string>(); const h = await fixture(() => network.promise);
    const pending = h.run(); await vi.waitFor(() => expect(h.sessionReply).toHaveBeenCalledTimes(1));
    expect(h.ds.session.codexAppDispatchLedger).toHaveLength(2);
    expect(h.sent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'codex_app_dispatch_persisted', ok: true }));
    network.resolve('om_retained'); await pending;
    expect(h.ds.session.codexAppDispatchLedger?.map(e => e.dispatchId)).toEqual(['dispatch-next']);
    expect(h.sent).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex_app_dispatch_persisted', requestId: 'persist-old', ok: true }));
    expect(h.controller.currentRuntime()).toEqual(h.current);
    expect(h.controller.store.execution(h.ref, h.middle.executionId)).toMatchObject({ phase: 'submitting', runtime: h.current });
  });
  it('durably advances an empty superseded historical head without calling transport', async () => {
    const h = await fixture(async () => 'om_unexpected');
    await h.run({ ...h.msg, content: '', suppressDelivery: true, disposition: 'steer_superseded' });
    expect(h.sessionReply).not.toHaveBeenCalled();
    expect(h.ds.session.codexAppDispatchLedger).toHaveLength(1);
    expect(h.sent).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex_app_dispatch_persisted', ok: true }));
  });
  it.each(['suspend', 'restart', 'worker-replacement'])('does not retry or settle after %s while transport is pending and then fails', async intervention => {
    const network = deferred<string>(); const h = await fixture(() => network.promise);
    const pending = h.run(); await vi.waitFor(() => expect(h.sessionReply).toHaveBeenCalledTimes(1));
    if (intervention === 'suspend') h.controller.beginControl('suspend', 'operator-suspend');
    else if (intervention === 'restart') h.controller.beginControl('restart', 'operator-restart');
    else { h.controller.bindWorker(3); h.ds.worker = { send: vi.fn() } as any; }
    network.reject(new Error('network-failed-after-intervention'));
    await vi.advanceTimersByTimeAsync(60_000); await pending;
    expect(h.sessionReply).toHaveBeenCalledTimes(1); expect(h.ds.session.codexAppDispatchLedger).toHaveLength(2);
    expect(h.sent).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex_app_dispatch_persisted', ok: false }));
  });
  it('does not send an old final if the exact ledger head disappears during topic preparation', async () => {
    const topic = deferred<any>();
    vi.mocked(getBot).mockReturnValue({ config: { larkAppId: 'app_test', cliId: 'codex-app', topicUnavailablePolicy: 'stop' }, resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot' } as any);
    topicDetailMock.mockReturnValueOnce(topic.promise);
    const h = await fixture(async () => 'om_unexpected');
    const pending = h.run(); await vi.waitFor(() => expect(topicDetailMock).toHaveBeenCalled());
    h.ds.session.codexAppDispatchLedger!.shift();
    topic.resolve({ items: [{ message_id: 'om_root', deleted: false }] }); await pending;
    expect(h.sessionReply).not.toHaveBeenCalled();
    expect(h.ds.session.codexAppDispatchLedger?.map(e => e.dispatchId)).toEqual(['dispatch-next']);
    expect(h.sent).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex_app_dispatch_persisted', ok: false }));
  });
});

afterAll(async () => {
  const { __testOnly_closeSkillFeedbackStores } = await import('../src/services/skill-feedback-store.js');
  await __testOnly_closeSkillFeedbackStores(); rmSync(config.session.dataDir, { force: true, recursive: true });
});
