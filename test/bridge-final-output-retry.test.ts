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
      // Concurrent checkouts/processes must never reset each other's journals.
      session: { dataDir: mkdtempSync(join(tmpdir(), 'bridge-final-output-')) },
      daemon: { backendType: 'tmux', cliId: 'claude-code' },
    },
  };
});

vi.mock('../src/core/cost-calculator.js', () => ({
  getSessionTokenUsage: vi.fn(() => null),
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

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import {
  getDaemonReplyCardUsageSnapshot,
  initWorkerPool,
  postTurnStartingCard,
  pruneSteerFanoutState,
  __testOnly_setupWorkerHandlers,
  sendWorkerInput,
  __testOnly_resetOrdinaryImDeliveries,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import { MessageWithdrawnError } from '../src/im/lark/client.js';
import { emitSessionLifecycleHook } from '../src/services/session-lifecycle-hooks.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import { EventEmitter } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import { getBot, getOwnerOpenId, resolveReplyDelivery, resolveUsageDisplay } from '../src/bot-registry.js';
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

function makeHermesDs(): DaemonSession {
  const ds = makeDs();
  ds.session.cliId = 'hermes';
  return ds;
}

function finalOutputMsg(): Extract<WorkerToDaemon, { type: 'final_output' }> {
  return { type: 'final_output', content: 'final answer', lastUuid: 'uuid-1', turnId: 'turn-1' };
}

function listenerFinalOutputMsg(
  content = 'final answer',
): Extract<WorkerToDaemon, { type: 'final_output' }> {
  return {
    ...finalOutputMsg(),
    content: JSON.stringify({ decision: 'publish', content }),
  };
}

function seedReceiverReceipt(responseMode: 'silent' | 'listener_thread'): void {
  const memberKey = {
    listenerAppId: 'listener-app', meetingId: 'meeting-1', memberId: 'member-1', memberEpoch: 1,
  };
  expect(applyVcMeetingMemberProjection(config.session.dataDir, {
    ...memberKey,
    ownerBootId: 'owner-boot', ownerEpoch: 1, agentAppId: 'app_test', role: 'minutes',
    membershipGeneration: 1, status: 'active', responseMode, joinedAtIngestSeq: 0,
    capabilities: ['meeting.read', 'listener.output.request'], ownedSinks: [], sinkOwnerGeneration: 1,
    receiverSessionId: 'sid-final-out', outputChatId: 'oc_chat',
  })).toMatchObject({ ok: true });
  expect(acceptVcMeetingDelivery(config.session.dataDir, {
    ...memberKey,
    ownerBootId: 'owner-boot', ownerEpoch: 1, membershipGeneration: 1,
    deliveryKey: 'delivery-stable-key', inputHash: 'input-hash', fromSeq: 1, toSeq: 1,
    responseMode,
    listenerOutputProtocol: responseMode === 'listener_thread' ? 'decision_v1' : 'plain',
    receiverBootId: 'receiver-boot',
  })).toMatchObject({ kind: 'accepted' });
  expect(markVcMeetingDeliveryDispatched(config.session.dataDir, {
    ...memberKey, deliveryKey: 'delivery-stable-key',
  }, { receiverBootId: 'receiver-boot', workerGeneration: 1 })).toMatchObject({
    ok: true,
    receipt: { status: 'dispatched' },
  });
}

function seedSilentReceiverReceipt(): void {
  seedReceiverReceipt('silent');
}

const SCOPED_DEDUPE_KEY = 'sid-final-out:uuid-1';

afterAll(async () => {
  const { __testOnly_closeSkillFeedbackStores } = await import('../src/services/skill-feedback-store.js');
  await __testOnly_closeSkillFeedbackStores();
  rmSync(config.session.dataDir, { recursive: true, force: true });
});

describe('Bridge final_output delivery (P2 retry)', () => {
  beforeEach(async () => {
    const { __testOnly_closeSkillFeedbackStores } = await import('../src/services/skill-feedback-store.js');
    await __testOnly_closeSkillFeedbackStores();
    vi.useFakeTimers();
    vi.clearAllMocks();
    uploadImageMock.mockReset().mockResolvedValue('img_v3_uploaded_preview');
    resolveAllowedUsersWithMapMock.mockImplementation(async (_appId: string, entries: string[]) => ({
      resolved: entries,
      map: new Map(entries.map(entry => [entry, entry])),
      entryStatus: new Map(entries.map(entry => [entry, 'resolved' as const])),
    }));
    vi.mocked(getBot).mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
      resolvedAllowedUsers: [],
      botOpenId: 'ou_bot',
      botName: 'TestBot',
    } as any);
    // clearAllMocks wipes the factory return; re-arm footer mode so the
    // positive usage-render tests see footer usage (individual tests override).
    vi.mocked(resolveUsageDisplay).mockReturnValue('footer');
    rmSync(config.session.dataDir, { recursive: true, force: true });
    mkdirSync(config.session.dataDir, { recursive: true });
  });

  afterEach(async () => {
    const { setDurableBridgeFinalOutputHandler } = await import('../src/core/worker-pool.js');
    setDurableBridgeFinalOutputHandler(undefined);
    __testOnly_resetOrdinaryImDeliveries();
    const { __testOnly_closeSkillFeedbackStores } = await import('../src/services/skill-feedback-store.js');
    await __testOnly_closeSkillFeedbackStores();
    setActiveSessionsRegistry(undefined);
    rmSync(config.session.dataDir, { recursive: true, force: true });
    clearMessageListenerRunPreviewStore();
    vi.useRealTimers();
  });

  it.each(['bridge', 'local-turn', 'local-turn-headless'] as const)(
    'forwards %s screenshot replies without exposing a local path as an image key', async kind => {
      const sessionReply = vi.fn(async (_anchor: string, card: string) => {
        if (card.includes('![Preview](/tmp/preview.png)')) {
          throw new Error('card contains invalid image keys');
        }
        return 'om_reply';
      });
      initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
      const ds = makeDs();
      ds.session.cliId = 'codex';
      if (kind === 'bridge') ds.adoptedFrom = undefined;
      const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
      deliver(ds, { ...finalOutputMsg(), kind, content: 'Ready.\n\n![Preview](/tmp/preview.png)', userText: 'Show preview' }, 'tag', 0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sessionReply).toHaveBeenCalledOnce();
      expect(sessionReply.mock.calls[0][1]).toContain('Ready.');
      expect(sessionReply.mock.calls[0][1]).toContain('[Image omitted]');
      expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
    },
  );

  it.each(['bridge', 'local-turn', 'local-turn-headless'] as const)('uploads an adopted session screenshot before delivering the %s card', async kind => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
    const image = `${config.session.dataDir}/preview.png`;
    writeFileSync(image, png);
    const sessionReply = vi.fn(async (_anchor: string, _card: string) => 'om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => config.session.dataDir, getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.workingDir = config.session.dataDir;
    ds.session.cliId = 'codex';
    const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
    deliver(ds, { ...finalOutputMsg(), kind, content: `Ready.\n\n![Preview](${image})` }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(sessionReply).toHaveBeenCalledOnce());
    expect(uploadImageMock).toHaveBeenCalledExactlyOnceWith('app_test', png);
    expect(sessionReply.mock.calls[0][1]).toContain('![Preview](img_v3_uploaded_preview)');
    expect(sessionReply.mock.calls[0][1]).not.toContain('[Image omitted]');
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('uploads a Claude adopt preamble screenshot but never uploads paths from its quoted user text', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
    writeFileSync(`${config.session.dataDir}/preview.png`, png);
    writeFileSync(`${config.session.dataDir}/input.png`, png);
    const sessionReply = vi.fn(async (_anchor: string, _card: string) => 'om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => config.session.dataDir, getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.workingDir = config.session.dataDir;
    if (!ds.worker) throw new Error('Missing fixture worker');
    __testOnly_setupWorkerHandlers(ds, ds.worker);
    ds.worker.emit('message', {
      type: 'adopt_preamble', turnId: 'turn-adopt',
      userText: 'Check ![Input](input.png)', assistantText: 'Ready. ![Preview](preview.png)',
    });
    await vi.waitFor(() => expect(sessionReply).toHaveBeenCalledOnce());
    expect(uploadImageMock).toHaveBeenCalledExactlyOnceWith('app_test', png);
    expect(sessionReply.mock.calls[0][1]).toContain('![Preview](img_v3_uploaded_preview)');
    expect(sessionReply.mock.calls[0][1]).toContain('[Image omitted] [Input]');
  });

  it.each(['non-adopted', 'sandbox', 'read-isolation', 'remote', 'api-only'])(
    'does not add host image uploads to %s sessions', async mode => {
      writeFileSync(`${config.session.dataDir}/preview.png`, Buffer.from('89504e470d0a1a0a', 'hex'));
      const sessionReply = vi.fn(async (_anchor: string, _card: string) => 'om_reply');
      initWorkerPool({ sessionReply, getSessionWorkingDir: () => config.session.dataDir, getActiveCount: () => 1, closeSession: vi.fn() });
      const ds = makeDs();
      ds.workingDir = config.session.dataDir;
      if (mode === 'non-adopted') ds.adoptedFrom = undefined;
      if (mode === 'sandbox') ds.session.sandbox = true;
      if (mode === 'remote') ds.session.backendType = 'remote-runner';
      const bot = getBot('app_test');
      if (mode === 'read-isolation') bot.config.readIsolation = true;
      if (mode === 'api-only') bot.config.apiOnly = true;
      vi.mocked(getBot).mockReturnValue(bot);
      const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
      deliver(ds, { ...finalOutputMsg(), content: 'Ready. ![Preview](preview.png)' }, 'tag', 0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(uploadImageMock).not.toHaveBeenCalled();
      expect(sessionReply).toHaveBeenCalledOnce();
      expect(sessionReply.mock.calls[0][1]).toContain('Ready.');
    },
  );

  it('reuses the uploaded key and UUID after a final-output send failure', async () => {
    writeFileSync(`${config.session.dataDir}/preview.png`, Buffer.from('89504e470d0a1a0a', 'hex'));
    const sessionReply = vi.fn().mockRejectedValueOnce(new Error('network error')).mockResolvedValue('om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => config.session.dataDir, getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.workingDir = config.session.dataDir;
    const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
    deliver(ds, { ...finalOutputMsg(), content: 'Ready. ![Preview](preview.png)' }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(uploadImageMock).toHaveBeenCalledOnce();
    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(sessionReply.mock.calls[0][1]).toContain('img_v3_uploaded_preview');
    expect(sessionReply.mock.calls[1][1]).toBe(sessionReply.mock.calls[0][1]);
    expect(sessionReply.mock.calls[1][5].uuid).toBe(sessionReply.mock.calls[0][5].uuid);
  });

  it('delivers the body when the automatic image upload fails', async () => {
    writeFileSync(`${config.session.dataDir}/preview.png`, Buffer.from('89504e470d0a1a0a', 'hex'));
    uploadImageMock.mockRejectedValueOnce(new Error('upload failed'));
    const sessionReply = vi.fn(async (_anchor: string, _card: string) => 'om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => config.session.dataDir, getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.workingDir = config.session.dataDir;
    const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
    deliver(ds, { ...finalOutputMsg(), content: 'Ready. ![Preview](preview.png)' }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(uploadImageMock).toHaveBeenCalledOnce();
    expect(sessionReply).toHaveBeenCalledOnce();
    expect(sessionReply.mock.calls[0][1]).toContain('Ready.');
    expect(sessionReply.mock.calls[0][1]).toContain('[Image omitted]');
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('does not send a completed upload after the adopted worker loses ownership', async () => {
    writeFileSync(`${config.session.dataDir}/preview.png`, Buffer.from('89504e470d0a1a0a', 'hex'));
    let owned = true;
    uploadImageMock.mockImplementationOnce(async () => {
      owned = false;
      return 'img_v3_uploaded_preview';
    });
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => config.session.dataDir, getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.workingDir = config.session.dataDir;
    const complete = vi.fn();
    const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
    deliver(ds, { ...finalOutputMsg(), content: 'Ready. ![Preview](preview.png)' }, 'tag', 0, complete, () => owned);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(uploadImageMock).toHaveBeenCalledOnce();
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
    expect(complete).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('forwards an adopt preamble with local screenshots in both sides of the exchange', async () => {
    const sessionReply = vi.fn(async (_anchor: string, _card: string) => 'om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.session.cliId = 'codex';
    if (!ds.worker) throw new Error('Missing fixture worker');
    __testOnly_setupWorkerHandlers(ds, ds.worker);
    ds.worker.emit('message', {
      type: 'adopt_preamble', turnId: 'turn-adopt',
      userText: 'Check ![Input](/tmp/input.png)',
      assistantText: 'Ready. ![Preview](/tmp/preview.png)',
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledOnce();
    const card = sessionReply.mock.calls[0][1];
    expect(card).toContain('Ready.');
    expect(card).toContain('Check');
    expect(card).not.toContain('![Input]');
    expect(card).not.toContain('![Preview]');
  });

  it('downgrades only rejected image keys and retries the image-free card with the same UUID', async () => {
    const invalidImage = { response: { status: 400, data: {
      code: 230099, msg: 'Failed to create card content, ErrCode: 200570; ErrMsg: card contains invalid image keys',
    } } };
    const sessionReply = vi.fn()
      .mockRejectedValueOnce(invalidImage)
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    const complete = vi.fn();
    const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
    deliver(ds, { ...finalOutputMsg(), content: 'Ready. ![Preview](img_v3_rejected)' }, 'tag', 0, complete);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessionReply).toHaveBeenCalledTimes(3);
    expect(sessionReply.mock.calls[0][1]).toContain('![Preview](img_v3_rejected)');
    for (const call of sessionReply.mock.calls.slice(1)) {
      expect(call[1]).toContain('Ready.');
      expect(call[1]).toContain('[Image omitted]');
      expect(call[1]).not.toContain('![Preview]');
      expect(call[2]).toBe('interactive');
      expect(call[5].uuid).toBe(sessionReply.mock.calls[0][5].uuid);
    }
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
    expect(complete).toHaveBeenCalledExactlyOnceWith(true, 'om_reply');
  });

  it.each([
    { response: { status: 400, data: { code: 230099, msg: 'Invalid card schema' } } },
    { response: { status: 400, data: { code: 230001, msg: 'Invalid request' } } },
    { response: { status: 400, data: { code: 230099, msg: 'ErrCode: 200571; card contains invalid image keys' } } },
    new Error('Request failed with status code 400'),
    new Error('card contains invalid image keys'),
  ])('does not treat an unrelated rejection as permission to downgrade images: %j', async error => {
    const sessionReply = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
    deliver(ds, { ...finalOutputMsg(), content: 'Ready. ![Preview](img_v3_key)' }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(sessionReply.mock.calls[1][1]).toBe(sessionReply.mock.calls[0][1]);
  });

  it('uses the same image-free fallback for an adopt preamble and a flattened SDK error', async () => {
    const sessionReply = vi.fn().mockRejectedValueOnce(new Error(
      'Failed to reply message: ErrCode: 200570; ErrMsg: card contains invalid image keys (code: 230099)',
    )).mockResolvedValue('om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    if (!ds.worker) throw new Error('Missing fixture worker');
    __testOnly_setupWorkerHandlers(ds, ds.worker);
    ds.worker.emit('message', {
      type: 'adopt_preamble', turnId: 'turn-adopt', userText: 'Show preview',
      assistantText: 'Ready. ![Preview](img_v3_rejected)',
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(sessionReply.mock.calls[1][1]).toContain('[Image omitted]');
    expect(sessionReply.mock.calls[1][1]).toContain('Ready.');
    expect(sessionReply.mock.calls[1][1]).not.toContain('![Preview]');
    expect(sessionReply.mock.calls[1][4]).toBe('turn-adopt');
  });

  it('does not send the image fallback after the worker loses ownership', async () => {
    let owned = true;
    const sessionReply = vi.fn(async () => {
      owned = false;
      throw new Error('Failed to reply message: ErrCode: 200570; card contains invalid image keys (code: 230099)');
    });
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    const complete = vi.fn();
    const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
    deliver(ds, { ...finalOutputMsg(), content: 'Ready. ![Preview](img_v3_key)' }, 'tag', 0, complete, () => owned);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessionReply).toHaveBeenCalledOnce();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
    expect(complete).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each([['codex', false], ['claude-code', true]] as const)(
    'persists the actual downgraded %s bridge card with an existing message=%s', async (cliId, existing) => {
      vi.useRealTimers();
      getBot('app_test').config.replyCardMode = 'unified';
      const ds = makeDs();
      ds.adoptedFrom = undefined;
      ds.session.cliId = cliId;
      ds.currentTurnId = 'om_image_turn';
      const sessionReply = vi.fn(async () => 'om_image_reply');
      initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
      const { updateTurnReplyCard } = await import('../src/core/turn-reply-card.js');
      if (existing) await updateTurnReplyCard(ds, ds.currentTurnId, { kind: 'start' }, sessionReply);
      const error = new Error('ErrCode: 200570; card contains invalid image keys (code: 230099)');
      if (existing) updateMessageMock.mockRejectedValueOnce(error);
      else sessionReply.mockRejectedValueOnce(error);
      const complete = vi.fn();
      const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
      deliver(ds, { ...finalOutputMsg(), turnId: ds.currentTurnId, kind: 'bridge', content: 'Answer. ![Preview](img_v3_rejected)' }, 'tag', 0, complete);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledExactlyOnceWith(true, 'om_image_reply'));
      const { TurnReplyCardStore } = await import('../src/services/turn-reply-card.js');
      const record = new TurnReplyCardStore(config.session.dataDir).read({
        larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: ds.currentTurnId,
      });
      expect(record?.finalCard).toContain('[Image omitted]');
      expect(record?.lastCard).not.toContain('![Preview]');
      expect(record?.finalDelivered).toBe(true);
      await updateTurnReplyCard(ds, ds.currentTurnId, { kind: 'terminal', phase: 'completed' }, sessionReply);
      expect(updateMessageMock.mock.calls.at(-1)?.[2]).toContain('Answer.');
      expect(updateMessageMock.mock.calls.at(-1)?.[2]).not.toContain('![Preview]');
      expect(sessionReply).toHaveBeenCalledTimes(existing ? 1 : 2);
      expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
    },
  );

  it('routes ordinary bridge final output through the durable handler without direct sessionReply', async () => {
    const sessionReply = vi.fn(async () => 'om_direct_should_not_run');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const {
      __testOnly_deliverFinalOutput: deliver,
      setDurableBridgeFinalOutputHandler,
    } = await import('../src/core/worker-pool.js');
    const durable = vi.fn(async () => ({ kind: 'delivered' as const, messageId: 'om_durable' }));
    setDurableBridgeFinalOutputHandler(durable);
    const ds = makeDs();
    const onComplete = vi.fn();

    deliver(ds, finalOutputMsg(), 'tag', 0, onComplete, () => true,
      { mode: 'thread', rootMessageId: 'om_root' });
    await vi.advanceTimersByTimeAsync(10);

    expect(durable).toHaveBeenCalledWith(expect.objectContaining({
      daemonSession: ds,
      turnId: 'turn-1',
      providerUuid: expect.stringMatching(/^bf_/),
      target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
      msgType: 'interactive',
    }));
    expect(sessionReply).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(true, 'om_durable');
  });

  it('keeps the reply-card write fence on the non-primary final path', async () => {
    vi.useRealTimers();
    const bot = getBot('app_test');
    Object.assign(bot.config, { replyCardMode: 'unified', apiOnly: false });
    vi.mocked(getBot).mockReturnValue(bot);
    let beforeWrite: (() => void | Promise<void>) | undefined;
    const sessionReply = vi.fn(async (...args: any[]) => {
      beforeWrite = args[5]?.beforeWrite;
      return 'om_reply';
    });
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    const onComplete = vi.fn();
    const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');

    deliver(ds, { ...finalOutputMsg(), kind: 'bridge', turnId: 'om_fenced_final' },
      'tag', 0, onComplete, () => true);
    await vi.waitFor(() => expect(sessionReply).toHaveBeenCalledOnce());

    expect(beforeWrite).toBeTypeOf('function');
    bot.config.apiOnly = true;
    await expect(Promise.resolve().then(() => beforeWrite!()))
      .rejects.toThrow('Reply-card turn no longer owns delivery');
    bot.config.apiOnly = false;
    expect(onComplete).toHaveBeenCalledWith(true, 'om_reply');
  });

  it('fails closed on an ambiguous durable settlement without falling back to direct delivery', async () => {
    const sessionReply = vi.fn(async () => 'om_direct_should_not_run');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const {
      __testOnly_deliverFinalOutput: deliver,
      setDurableBridgeFinalOutputHandler,
    } = await import('../src/core/worker-pool.js');
    setDurableBridgeFinalOutputHandler(vi.fn(async () => ({
      kind: 'ambiguous' as const,
      error: 'provider result unknown',
    })));
    const ds = makeDs();
    const onComplete = vi.fn();

    deliver(ds, finalOutputMsg(), 'tag', 0, onComplete, () => true,
      { mode: 'thread', rootMessageId: 'om_root' });
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.agentAttention).toMatchObject({
      kind: 'blocked',
      reason: 'Durable final output is ambiguous: provider result unknown',
    });
    expect(onComplete).toHaveBeenCalledWith(false);
  });

  it.each([undefined, 'native_before_fork'])('binds prepared native input to its reserved worker before execution (native=%s)', async nativeSessionId => {
    const ds = makeDs();
    ds.session.cliId = 'claude-code';
    ds.session.cliSessionId = nativeSessionId;
    ds.session.workerGeneration = 3;
    ds.workerGeneration = 3;
    const binding = { appId: ds.larkAppId, chatId: ds.chatId, sessionId: ds.session.sessionId, turnId: 'om_prepared', workerGeneration: 2,
      epoch: groupContextEpoch(ds.session.sessionId, nativeSessionId, 'claude-code', 'om_prepared') };
    writePreparedGroupContext({ ...binding, createdAt: Date.now(), body: '', includedSeqs: [], throughSeq: 0, incomplete: false }, config.session.dataDir);
    bindGroupContextDelivery(binding, config.session.dataDir);
    const workerPool = await import('../src/core/worker-pool.js') as any;
    expect(workerPool.__testOnly_bindPreparedGroupContextWorker).toBeTypeOf('function');
    workerPool.__testOnly_bindPreparedGroupContextWorker(ds, 'om_prepared', 3);
    expect(readGroupContextDeliveryBinding(binding.appId, binding.chatId, binding.turnId, config.session.dataDir))
      .toEqual({ ...binding, workerGeneration: 3 });
    ds.session.cliSessionId = 'replacement_native';
    ds.session.workerGeneration = 4;
    ds.workerGeneration = 4;
    if (nativeSessionId) {
      workerPool.__testOnly_bindPreparedGroupContextWorker(ds, 'om_prepared', 4);
      expect(readGroupContextDeliveryBinding(binding.appId, binding.chatId, binding.turnId, config.session.dataDir)?.workerGeneration).toBe(3);
    }
  });

  it('binds an adopted bridge input before its real reservation callback can dispatch', async () => {
    initWorkerPool({ sessionReply: vi.fn(async () => 'unused'), getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.session.cliId = 'claude-code';
    ds.session.cliSessionId = 'native_adopted';
    ds.session.workerGeneration = 2;
    ds.workerGeneration = 2;
    const binding = { appId: ds.larkAppId, chatId: ds.chatId, sessionId: ds.session.sessionId, turnId: 'om_adopted', workerGeneration: 2,
      epoch: groupContextEpoch(ds.session.sessionId, ds.session.cliSessionId, 'claude-code', 'om_adopted') };
    writePreparedGroupContext({ ...binding, createdAt: Date.now(), body: '', includedSeqs: [], throughSeq: 0, incomplete: false }, config.session.dataDir);
    bindGroupContextDelivery(binding, config.session.dataDir);
    const stopBeforeSpawn = new Error('test stops before worker spawn');
    let recordedGeneration: number | undefined;
    const { forkAdoptWorker } = await import('../src/core/worker-pool.js');
    expect(() => forkAdoptWorker(ds, { prompt: 'prepared native input', turnId: binding.turnId,
      onWorkerGenerationReserved: generation => {
        expect(generation).toBe(3);
        recordedGeneration = readGroupContextDeliveryBinding(binding.appId, binding.chatId, binding.turnId, config.session.dataDir, binding.epoch)?.workerGeneration;
        throw stopBeforeSpawn;
      } })).toThrow(stopBeforeSpawn);
    expect(recordedGeneration).toBe(3);
    expect(ds.worker?.kill).not.toHaveBeenCalled();
  });

  it.each(['bridge', 'explicit'] as const)('keeps the %s answer and Oncall source in the existing reply card', async source => {
    vi.useRealTimers();
    const bot = getBot('app_test');
    bot.config.replyCardMode = 'unified';
    bot.config.oncallGroup = { enabled: true, chatIds: ['oc_chat'] };
    vi.mocked(getBot).mockReturnValue(bot);
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.scope = 'thread';
    ds.session.cliId = 'claude-code';
    ds.currentTurnId = 'om_managed_turn';
    const sessionReply = vi.fn(async () => 'om_managed_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    const { updateTurnReplyCard } = await import('../src/core/turn-reply-card.js');
    await updateTurnReplyCard(ds, ds.currentTurnId, { kind: 'start' },
      (body, type, uuid) => sessionReply(ds.session.rootMessageId, body, type, ds.larkAppId, ds.currentTurnId, { uuid }));
    if (source === 'explicit') {
      const { attachOncallGroupButton } = await import('../src/im/lark/oncall-group.js');
      const card = attachOncallGroupButton(JSON.stringify({ schema: '2.0', body: { elements: [
        { tag: 'markdown', content: '显式完整答复' },
      ] } }), bot.config.oncallGroup, ds.chatId);
      await updateTurnReplyCard(ds, ds.currentTurnId, { kind: 'final', text: '显式完整答复', card, source },
        async () => 'om_managed_reply');
    }
    ds.worker!.emit('message', { type: 'thinking_update', sessionId: ds.session.sessionId, turnId: ds.currentTurnId,
      entries: [{ kind: 'tool_call', id: 'read-1', name: 'Read', args: '{}', subject: 'README.md' }] });
    ds.worker!.emit('message', { type: 'final_output', sessionId: ds.session.sessionId, turnId: ds.currentTurnId,
      kind: 'bridge', content: '同卡完整答复', lastUuid: 'managed-final' });
    ds.worker!.emit('message', { type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: ds.currentTurnId,
      status: 'completed', durationMs: 2300, completedAtMs: Date.now() });
    const expectedAnswer = source === 'explicit' ? '显式完整答复' : '同卡完整答复';
    const { OncallGroupStore } = await import('../src/services/oncall-group-store.js');
    await vi.waitFor(() => {
      expect(updateMessageMock.mock.calls.some(call => call[2]?.includes(expectedAnswer) && call[2]?.includes('已完成') && call[2]?.includes('oncall_group_create'))).toBe(true);
      expect(new OncallGroupStore(config.session.dataDir).findSource('app_test', 'om_managed_reply'))
        .toMatchObject({ chatId: 'oc_chat', questionId: ds.currentTurnId, answer: expectedAnswer });
    }, { timeout: 5000 });
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(updateMessageMock.mock.calls.every(call => call[1] === 'om_managed_reply')).toBe(true);
    const { TurnReplyCardStore } = await import('../src/services/turn-reply-card.js');
    const record = new TurnReplyCardStore(config.session.dataDir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: ds.currentTurnId });
    if (source === 'bridge') expect(record?.tools[0]?.subject).toBe('README.md');
    expect(record?.finalDelivered).toBe(true);
    expect(record?.finalSource).toBe(source);
  });

  it.each([
    ['claude-code', 'on'], ['claude-code', 'bot-off'], ['claude-code', 'chat-off'],
    ['codex', 'on'], ['codex', 'bot-off'], ['codex', 'chat-off'],
  ] as const)('%s unified replies keep the %s status card independent through ready and final output', async (cliId, statusMode) => {
    vi.useRealTimers();
    const bot = getBot('app_test');
    Object.assign(bot.config, { replyCardMode: 'unified', disableStreamingCard: statusMode === 'bot-off',
      noCardChats: statusMode === 'chat-off' ? ['oc_chat'] : [] });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.scope = 'thread';
    ds.session.cliId = cliId;
    ds.workerReady = true;
    ds.currentTurnId = ds.streamCardPendingTurnId = 'om_independent_turn';
    ds.streamCardPending = true;
    ds.lastScreenStatus = 'working';
    const sessionReply = vi.fn(async (_root: string, body: string) => body === '{}' ? 'om_status' : 'om_answer');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // Admission and another starting-card trigger may race before either POST finishes.
    await Promise.all([
      postTurnStartingCard(ds, sessionReply, ds.currentTurnId),
      postTurnStartingCard(ds, sessionReply, ds.currentTurnId),
    ]);
    const expectedPosts = statusMode === 'on' ? 2 : 1;
    expect(sessionReply).toHaveBeenCalledTimes(expectedPosts);
    expect(ds.streamCardId).toBe(statusMode === 'on' ? 'om_status' : undefined);
    ds.worker!.emit('message', { type: 'ready', port: 9999, token: 'test-token', turnId: ds.currentTurnId });
    await vi.waitFor(() => expect(ds.workerPort).toBe(9999));
    if (statusMode === 'on') {
      await vi.waitFor(() => expect(updateMessageMock.mock.calls.some(call => call[1] === 'om_status')).toBe(true));
    }
    ds.worker!.emit('message', { type: 'final_output', sessionId: ds.session.sessionId, turnId: ds.currentTurnId,
      kind: 'bridge', content: '独立开关不影响完整答复', lastUuid: 'independent-final' });
    await vi.waitFor(() => expect(updateMessageMock.mock.calls.some(call =>
      call[1] === 'om_answer' && call[2]?.includes('独立开关不影响完整答复'))).toBe(true), { timeout: 5000 });
    expect(sessionReply).toHaveBeenCalledTimes(expectedPosts);
    expect(updateMessageMock.mock.calls.filter(call => call[2]?.includes('独立开关不影响完整答复'))
      .every(call => call[1] === 'om_answer')).toBe(true);
    if (statusMode !== 'on') expect(updateMessageMock.mock.calls.every(call => call[1] === 'om_answer')).toBe(true);
  });

  it('does not let a delayed reply POST overwrite the successor status-card identity', async () => {
    vi.useRealTimers();
    getBot('app_test').config.replyCardMode = 'unified';
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.scope = 'thread';
    ds.session.cliId = 'claude-code';
    ds.workerReady = true;
    ds.currentTurnId = ds.streamCardPendingTurnId = 'om_old';
    ds.streamCardPending = true;
    let resolveOldReply!: (id: string) => void;
    const oldReply = new Promise<string>(resolve => { resolveOldReply = resolve; });
    const sessionReply = vi.fn(async (_root: string, body: string, _type?: string, _app?: string, turnId?: string) => {
      if (body === '{}') return `status_${turnId}`;
      return turnId === 'om_old' ? oldReply : `reply_${turnId}`;
    });
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
    const oldPost = postTurnStartingCard(ds, sessionReply, 'om_old');
    await vi.waitFor(() => expect(sessionReply).toHaveBeenCalledTimes(2));
    expect(ds.streamCardId).toBe('status_om_old');
    ds.currentTurnId = ds.streamCardPendingTurnId = 'om_next';
    ds.streamCardPending = true;
    ds.streamCardTurnGeneration = (ds.streamCardTurnGeneration ?? 0) + 1;
    await expect(postTurnStartingCard(ds, sessionReply, 'om_next')).resolves.toBe(true);
    resolveOldReply('reply_om_old');
    await expect(oldPost).resolves.toBe(true);
    expect(ds.streamCardId).toBe('status_om_next');
    expect(ds.streamCardPending).toBe(false);
    expect(sessionReply).toHaveBeenCalledTimes(4);
  });

  it.each(['unified', 'unified-status-off', 'legacy'] as const)('waits quietly for the worker receipt with no late notice in %s mode', async mode => {
    vi.useRealTimers();
    const bot = getBot('app_test');
    bot.config.replyCardMode = mode === 'legacy' ? 'legacy' : 'unified';
    bot.config.disableStreamingCard = mode === 'unified-status-off';
    vi.mocked(getBot).mockReturnValue(bot);
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.scope = 'thread';
    ds.session.cliId = 'claude-code';
    ds.workerGeneration = ds.session.workerGeneration = 1;
    ds.currentTurnId = 'om_delayed_turn';
    (ds.worker!.send as ReturnType<typeof vi.fn>).mockImplementation((_message, callback) => { callback?.(null); return true; });
    const sessionReply = vi.fn(async () => 'om_wait_card');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const { updateTurnReplyCard } = await import('../src/core/turn-reply-card.js');
    await updateTurnReplyCard(ds, ds.currentTurnId, { kind: 'refresh' },
      (body, type, uuid) => sessionReply(ds.session.rootMessageId, body, type, ds.larkAppId, ds.currentTurnId, { uuid }));
    const beforeEnqueueReplies = sessionReply.mock.calls.length;
    const beforeEnqueueTypes = sessionReply.mock.calls.map(call => call[2]);
    const enqueuedAt = Date.now();
    expect(sendWorkerInput(ds, 'hello', ds.currentTurnId)).toBe(true);
    // The old 2s "delivery delayed" nudge (text in legacy, card refresh in
    // unified) has been removed: a turn waiting for its worker receipt must stay
    // completely quiet now. Wait past the old settlement window and assert no
    // new outgoing message of any kind was produced.
    await new Promise(resolve => setTimeout(resolve, 2_500));
    expect(sessionReply).toHaveBeenCalledTimes(beforeEnqueueReplies);
    expect(sessionReply.mock.calls.map(call => call[2])).toEqual(beforeEnqueueTypes);
    expect(sessionReply.mock.calls.every(call => call[2] !== 'text')).toBe(true);
    if (mode !== 'legacy') {
      const { TurnReplyCardStore } = await import('../src/services/turn-reply-card.js');
      // No quiet card refresh either: the stored card must not have been
      // rewritten after enqueue.
      expect(new TurnReplyCardStore(config.session.dataDir).read({
        larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: ds.currentTurnId!,
      })?.updatedAtMs).not.toBeGreaterThan(enqueuedAt);
    }
  });

  it('shows opt-in execution timing from the current final, never the next turn', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
    const bot = getBot('app_test');
    const ds = makeDs();
    ds.currentTurnId = 'newer-queued-turn';
    ds.turnReceivedAtMs = new Map([['turn-1', 1000], ['newer-queued-turn', 9000]]);
    const msg = { ...finalOutputMsg(), durationMs: 23400, executionStartedAtMs: 4200 };

    deliver(ds, msg, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply.mock.calls[0][1]).not.toContain('执行耗时');

    bot.config.showReplyTiming = true;
    ds.session.cliId = 'codex-app';
    deliver(ds, { ...msg, durationMs: undefined, codexAppSettlement: {
      requestId: 'req', generation: 'gen', seq: 1, dispatchId: 'dispatch', durationMs: 23400,
    } }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply.mock.calls[1][1]).toContain('等待 3.2 秒');
    expect(sessionReply.mock.calls[1][1]).toContain('执行耗时 23.4 秒');
    expect(sessionReply.mock.calls[1][4]).toBe(msg.turnId);

    ds.session.cliId = 'claude-code';
    deliver(ds, { ...msg, durationMs: 1200 }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply.mock.calls[2][1]).toContain('执行耗时 1.2 秒');

    deliver(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply.mock.calls[3][1]).not.toContain('执行耗时');
    expect(sessionReply.mock.calls[3][1]).not.toContain('等待');
  });

  it('zero-prompt final reports the exact old turn dispatch root, while ordinary bots never auto-report', async () => {
    const onZeroPromptFinal = vi.fn(async () => {});
    initWorkerPool({ sessionReply: vi.fn(async () => 'om_reply'), onZeroPromptFinal,
      getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.scope = 'chat';
    ds.currentTurnId = 'turn-next';
    ds.currentReplyTarget = { mode: 'thread', rootMessageId: 'om_next', turnId: 'turn-next' } as any;
    ds.session.promptInjection = 'none';
    ds.initConfig = { promptInjection: 'default' } as any;
    const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
    deliver(ds, finalOutputMsg(), 'tag', 0, undefined, () => true,
      { mode: 'thread', rootMessageId: 'om_original' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onZeroPromptFinal).toHaveBeenCalledWith(ds, {
      turnId: 'turn-1', content: 'final answer', dispatchRoot: 'om_original',
    });
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
    ds.session.promptInjection = 'default';
    deliver(ds, { ...finalOutputMsg(), lastUuid: 'other', turnId: 'turn-next' }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onZeroPromptFinal).toHaveBeenCalledTimes(1);
  });

  it('settles the visible final once even when the independent lead report rejects', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    const onZeroPromptFinal = vi.fn(async () => { throw new Error('lead offline'); });
    const onComplete = vi.fn();
    initWorkerPool({ sessionReply, onZeroPromptFinal,
      getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.initConfig = { promptInjection: 'none' } as any;
    ds.currentTurnId = 'turn-1';
    const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
    deliver(ds, finalOutputMsg(), 'tag', 0, onComplete);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(onZeroPromptFinal).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
    expect(ds.completedIdleTurnId).toBe('turn-1');
    expect(onComplete).toHaveBeenCalledWith(true, 'om_reply');
  });

  it('commits dedup uuid only after a successful sessionReply', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    // Drive the case 'final_output' by invoking the registered handler.
    // setupWorkerHandlers attaches handler when a worker is forked, but we
    // bypass that: invoke the callback by emitting a message to the
    // EventEmitter that the live `worker.on('message')` registers. The
    // simplest path is to fork the worker via forkAdoptWorker — but that
    // spawns a real process. Instead we rely on the case branch's
    // self-contained behavior by importing deliverFinalOutput indirectly
    // via firing the IPC 'message' event after attaching a listener that
    // mirrors the case branch.
    //
    // Implementation detail: setupWorkerHandlers is internal; we exercise
    // it by directly calling the IPC entry. Since deliverFinalOutput is
    // file-private, we reach it through the public IPC dispatch.

    const ds = makeDs();
    // Hand-wired dispatcher that mirrors the relevant case branch in
    // setupWorkerHandlers. Keeping it here keeps the test independent of
    // unrelated card/state plumbing.
    const dispatcher = async (msg: WorkerToDaemon) => {
      if (msg.type !== 'final_output') return;
      if (!msg.content || !msg.content.trim()) return;
      if (msg.lastUuid && ds.lastBridgeEmittedUuid === `${msg.sessionId ?? ds.session.sessionId}:${msg.lastUuid}`) return;
      // Direct call to the public path:
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, msg, 'tag', 0);
    };

    await dispatcher(finalOutputMsg());
    // First attempt is delayed 0ms; flush microtasks + timers
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(sessionReply).toHaveBeenCalledTimes(1));
    expect(sessionReply.mock.calls[0][4]).toBe('turn-1');
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('strict topic policy blocks automatic final output before publishing', async () => {
    const current = getBot('app_test');
    vi.mocked(getBot).mockReturnValue({ ...current, config: { ...current.config, topicUnavailablePolicy: 'stop' } } as any);
    const sessionReply = vi.fn(async () => 'om_sent');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    // The blocked state must be pushed to Dashboard immediately, not wait for the
    // next row refresh (every other attention raise in worker-pool calls
    // publishAttentionPatch alongside the in-memory flag).
    const patches: any[] = [];
    const off = dashboardEventBus.subscribe(event => {
      if (event.type === 'session.update' && event.body.sessionId === ds.session.sessionId) patches.push(event.body.patch);
    });
    try {
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0, undefined, undefined, { mode: 'thread', rootMessageId: 'om_root' });
      await vi.advanceTimersByTimeAsync(10);
      expect(topicDetailMock).toHaveBeenCalledWith('app_test', 'om_root');
      const lookups = topicDetailMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30000);
      expect(topicDetailMock).toHaveBeenCalledTimes(lookups);
      expect(ds.agentAttention).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('TOPIC_SEND_BLOCKED') });
      expect(patches.some(patch => patch.agentAttention?.kind === 'blocked')).toBe(true);
      expect(sessionReply).not.toHaveBeenCalled();
      expect(ds.lastBridgeEmittedUuid).toBeUndefined();
    } finally { off(); }
  });

  it('shares the automatic final precheck with the provider send boundary', async () => {
    const current = getBot('app_test');
    vi.mocked(getBot).mockReturnValue({ ...current, config: { ...current.config, topicUnavailablePolicy: 'stop' } } as any);
    topicDetailMock.mockResolvedValueOnce({ items: [{ message_id: 'om_root', deleted: false }] });
    const sessionReply = vi.fn(async (...args: any[]) => {
      await args[5].topicMessageLookup('app_test', 'om_root');
      return 'om_sent';
    });
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const before = topicDetailMock.mock.calls.length;
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(makeDs(), finalOutputMsg(), 'tag', 0, undefined, undefined, { mode: 'thread', rootMessageId: 'om_root' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(topicDetailMock.mock.calls.length - before).toBe(1);
  });

  it('turnFailed final_output on a session WITHOUT a human recipient @mentions the bot admin', async () => {
    // Bot-to-bot dispatched sessions are ownerless: a model-gateway failure
    // card would otherwise ping nobody and scroll by silently.
    vi.mocked(getOwnerOpenId).mockReturnValue('ou_admin_human');
    const sessionReply = vi.fn(async () => 'om_failed_notice');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs(); // no session.ownerOpenId → no footer recipient
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, { ...finalOutputMsg(), content: '⚠️ 模型网关故障', turnFailed: true }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(String(sessionReply.mock.calls[0][1])).toContain('<at id=ou_admin_human></at>');
  });

  it('turnFailed final_output with a human footer recipient does NOT add the admin fallback mention', async () => {
    // The owner is already addressed by the card footer's <at>; a second
    // body mention would double-ping.
    vi.mocked(getOwnerOpenId).mockReturnValue('ou_admin_human');
    const sessionReply = vi.fn(async () => 'om_failed_owner_notice');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.session.ownerOpenId = 'ou_session_owner';
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, { ...finalOutputMsg(), content: '⚠️ 模型网关故障', turnFailed: true }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    const sent = String(sessionReply.mock.calls[0][1]);
    expect(sent).not.toContain('ou_admin_human');
    expect(sent).toContain('<at id=ou_session_owner></at>');
  });

  it('ordinary (non-failed) final_output never adds the admin fallback mention', async () => {
    vi.mocked(getOwnerOpenId).mockReturnValue('ou_admin_human');
    const sessionReply = vi.fn(async () => 'om_ok_answer');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(String(sessionReply.mock.calls[0][1])).not.toContain('ou_admin_human');
  });

  it.each(['claude-code', 'codex'])('adds an independent Oncall button on the %s final delivery path', async cliId => {
    vi.mocked(getBot).mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId, oncallGroup: { enabled: true, chatIds: ['oc_chat'] } },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot',
    } as any);
    const sessionReply = vi.fn(async () => 'om_oncall_answer');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.session.ownerOpenId = 'ou_different_owner';
    ds.session.cliId = cliId as any;
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(String(sessionReply.mock.calls[0][1])).toContain('oncall_group_create');
    expect(String(sessionReply.mock.calls[0][1])).not.toContain('botmux_feedback');
    const { OncallGroupStore } = await import('../src/services/oncall-group-store.js');
    expect(new OncallGroupStore(config.session.dataDir).findSource('app_test', 'om_oncall_answer')).toMatchObject({ chatId: 'oc_chat' });
    const { getSkillFeedbackStore } = await import('../src/services/skill-feedback-store.js');
    const delivery = (await getSkillFeedbackStore(config.session.dataDir))
      .findDeliveryByPlatformMessage('lark', ds.larkAppId, 'om_oncall_answer');
    expect(delivery).toMatchObject({ cardMode: 'card' });
    expect(delivery?.policy).toBeUndefined();
    expect(delivery?.baseCard).toBeUndefined();
  });

  it('records a feedback Delivery only after the canonical final_output send returns its platform message id', async () => {
    vi.mocked(getBot).mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', feedback: { enabled: true } },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot',
    } as any);
    const sessionReply = vi.fn(async () => 'om_feedback_answer');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.session.ownerOpenId = 'ou_requester';
    ds.feedbackPolicy = normalizeFeedbackPolicy({ enabled: true });
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    const { getSkillFeedbackStore } = await import('../src/services/skill-feedback-store.js');

    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    const feedbackStore = await getSkillFeedbackStore(config.session.dataDir);
    expect(feedbackStore.findDeliveryByPlatformMessage('lark', ds.larkAppId, 'om_feedback_answer')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);

    expect(feedbackStore.findDeliveryByPlatformMessage('lark', ds.larkAppId, 'om_feedback_answer')).toMatchObject({
      platformMessageId: 'om_feedback_answer',
      policy: expect.objectContaining({ enabled: true }),
      baseCard: expect.objectContaining({ schema: '2.0' }),
    });
  });

  it('uses the worker-start feedback policy snapshot after live config is disabled', async () => {
    const sessionReply = vi.fn(async () => 'om_snapshot_feedback');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.session.ownerOpenId = 'ou_requester';
    ds.feedbackPolicy = normalizeFeedbackPolicy({ enabled: true });
    // Simulate an admin disabling feedback while this worker/session remains alive.
    vi.mocked(getBot).mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot',
    } as any);
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;

    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(String((sessionReply as any).mock.calls[0][1])).toContain('botmux_feedback');
  });

  it('keeps feedback disabled for a worker whose startup snapshot was disabled', async () => {
    vi.mocked(getBot).mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', feedback: { enabled: true } },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot',
    } as any);
    const sessionReply = vi.fn(async () => 'om_disabled_snapshot');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.session.ownerOpenId = 'ou_requester';
    ds.feedbackPolicy = undefined;
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;

    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(String((sessionReply as any).mock.calls[0][1])).not.toContain('botmux_feedback');
  });

  it('does not render feedback when no requester identity can be proven', async () => {
    vi.mocked(getBot).mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', feedback: { enabled: true } },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot',
    } as any);
    const sessionReply = vi.fn(async () => 'om_no_requester_feedback');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(String(sessionReply.mock.calls[0][1])).not.toContain('botmux_feedback');
  });

  it('renders everyone feedback for an ownerless final output', async () => {
    const sessionReply = vi.fn(async () => 'om_everyone_feedback');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.feedbackPolicy = normalizeFeedbackPolicy({ enabled: true, audience: 'everyone' });
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    const { getSkillFeedbackStore } = await import('../src/services/skill-feedback-store.js');

    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(String(sessionReply.mock.calls[0][1])).toContain('botmux_feedback');
    expect((await getSkillFeedbackStore(config.session.dataDir))
      .findDeliveryByPlatformMessage('lark', ds.larkAppId, 'om_everyone_feedback'))
      .toMatchObject({ policy: { audience: 'everyone', reviewers: [] } });
  });

  it('resolves an email reviewer before rendering and freezes only the open_id', async () => {
    resolveAllowedUsersWithMapMock.mockResolvedValue({
      resolved: ['ou_email_reviewer'],
      map: new Map([['reviewer@example.com', 'ou_email_reviewer']]),
      entryStatus: new Map([['reviewer@example.com', 'resolved' as const]]),
    });
    const sessionReply = vi.fn(async () => 'om_email_feedback');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.feedbackPolicy = normalizeFeedbackPolicy({
      enabled: true,
      audience: 'reviewers',
      reviewers: ['reviewer@example.com'],
    });
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    const { getSkillFeedbackStore } = await import('../src/services/skill-feedback-store.js');

    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(resolveAllowedUsersWithMapMock).toHaveBeenCalledWith('app_test', ['reviewer@example.com']);
    expect(String(sessionReply.mock.calls[0][1])).toContain('botmux_feedback');
    const delivery = (await getSkillFeedbackStore(config.session.dataDir))
      .findDeliveryByPlatformMessage('lark', ds.larkAppId, 'om_email_feedback');
    expect(delivery?.policy?.reviewers).toEqual(['ou_email_reviewer']);
    expect(JSON.stringify(delivery?.policy)).not.toContain('reviewer@example.com');
  });

  it('does not render a reviewers card when every email is unresolved', async () => {
    resolveAllowedUsersWithMapMock.mockResolvedValue({
      resolved: [],
      map: new Map(),
      entryStatus: new Map([['ghost@example.com', 'definitive' as const]]),
    });
    const sessionReply = vi.fn(async () => 'om_unresolved_feedback');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.feedbackPolicy = normalizeFeedbackPolicy({
      enabled: true,
      audience: 'reviewers',
      reviewers: ['ghost@example.com'],
    });
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;

    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(String(sessionReply.mock.calls[0][1])).not.toContain('botmux_feedback');
  });

  it('keeps feedback disabled by default but still records the turn-completion delivery', async () => {
    const sessionReply = vi.fn(async () => 'om_plain_answer');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    // No feedback control on the card itself.
    expect(String(sessionReply.mock.calls[0][1])).not.toContain('botmux_feedback');
    // But the delivery is still recorded so a later turn_terminal correlates to
    // a turn.completed event — feedback is independent of completion bookkeeping.
    const { getSkillFeedbackStore } = await import('../src/services/skill-feedback-store.js');
    const delivery = (await getSkillFeedbackStore(config.session.dataDir))
      .findDeliveryByPlatformMessage('lark', ds.larkAppId, 'om_plain_answer');
    expect(delivery).toMatchObject({ cardMode: 'card' });
    expect(delivery?.policy).toBeUndefined();
    expect(delivery?.baseCard).toBeUndefined();
  });

  it('keeps feedback controls on ordinary local-turn output', async () => {
    vi.mocked(getBot).mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', feedback: { enabled: true } },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot',
    } as any);
    const sessionReply = vi.fn(async () => 'om_local_feedback');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.session.ownerOpenId = 'ou_requester';
    ds.feedbackPolicy = normalizeFeedbackPolicy({ enabled: true });
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, { ...finalOutputMsg(), kind: 'local-turn', userText: 'question' }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(String(sessionReply.mock.calls[0][1])).toContain('botmux_feedback');
  });

  it('keeps the terminal-local title for a traditional adopted local turn', async () => {
    const sessionReply = vi.fn(async () => 'om_terminal_local_turn');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;

    __testOnly_deliverFinalOutput(ds, { ...finalOutputMsg(), kind: 'local-turn', userText: 'question' }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(String(sessionReply.mock.calls[0][1])).toContain('终端本地对话（在 adopted pane 中直接输入，已同步至飞书）');
    expect(String(sessionReply.mock.calls[0][1])).not.toContain('Codex App 共享对话');
  });

  it('labels a Codex App shared local turn without calling it an adopted pane', async () => {
    const sessionReply = vi.fn(async () => 'om_codex_app_shared_turn');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.session.existingAppServerEndpoint = 'unix:///tmp/codex-app-server.sock';
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;

    __testOnly_deliverFinalOutput(ds, { ...finalOutputMsg(), kind: 'local-turn', userText: 'question' }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(String(sessionReply.mock.calls[0][1])).toContain('Codex App 共享对话（已同步至飞书）');
    expect(String(sessionReply.mock.calls[0][1])).not.toContain('在 adopted pane 中直接输入');
  });

  // ─── transcript 模式：最终回复卡投递成功后给本轮打「已完成」标签 ──────────
  // replyDelivery=transcript 时最终回复由这条 bridge fallback 主投递；成功后
  // ds.completedIdleTurnId 记住该轮，idle 卡头改「已完成」。send 模式（缺省）
  // 必须一个字节都不变。
  describe('transcript replyDelivery → completedIdleTurnId', () => {
    function armTranscript(): ReturnType<typeof vi.fn> {
      vi.mocked(resolveReplyDelivery).mockReturnValue('transcript');
      const sessionReply = vi.fn(async () => 'om_reply');
      initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
      return sessionReply;
    }

    it('carries the exact native author into final publication and omits it after an epoch change', async () => {
      const sessionReply = armTranscript();
      const ds = makeDs();
      ds.session.cliId = 'claude-code';
      ds.session.cliSessionId = 'native_final';
      ds.session.workerGeneration = 1;
      const binding = { appId: ds.larkAppId, chatId: ds.chatId, sessionId: ds.session.sessionId, turnId: 'turn-1', workerGeneration: 1,
        epoch: groupContextEpoch(ds.session.sessionId, ds.session.cliSessionId, ds.session.cliId, 'turn-1') };
      writePreparedGroupContext({ ...binding, createdAt: Date.now(), body: '', includedSeqs: [], throughSeq: 0, incomplete: false }, config.session.dataDir);
      bindGroupContextDelivery(binding, config.session.dataDir);
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
      await vi.advanceTimersByTimeAsync(10);
      expect(sessionReply.mock.calls[0]?.[5]?.groupContextAuthorOrigin).toEqual(binding);
      sessionReply.mockClear();
      ds.session.cliSessionId = 'replacement_native';
      __testOnly_deliverFinalOutput(ds, { ...finalOutputMsg(), assistantMsgUuid: 'second-final' }, 'tag', 0);
      await vi.advanceTimersByTimeAsync(10);
      expect(sessionReply.mock.calls[0]?.[5]?.groupContextAuthorOrigin).toBeUndefined();
    });

    it('marks the turn only AFTER the canonical send succeeds', async () => {
      const sessionReply = armTranscript();
      const ds = makeDs();
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
      // Nothing is marked before the (0ms-deferred) send settles.
      expect(ds.completedIdleTurnId).toBeUndefined();
      await vi.advanceTimersByTimeAsync(10);
      expect(sessionReply).toHaveBeenCalledTimes(1);
      expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
      expect(ds.completedIdleTurnId).toBe('turn-1');
    });

    it('a failed send leaves the turn unmarked (retry still pending)', async () => {
      vi.mocked(resolveReplyDelivery).mockReturnValue('transcript');
      const sessionReply = vi.fn(async () => { throw new Error('lark 500'); });
      initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
      const ds = makeDs();
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
      await vi.advanceTimersByTimeAsync(10);
      expect(sessionReply).toHaveBeenCalledTimes(1);
      expect(ds.completedIdleTurnId).toBeUndefined();
    });

    it('unconfigured replyDelivery on claude-code = send by default → does NOT mark the turn', async () => {
      // 缺省不随 CLI 翻转：没显式配 transcript 就是 send，走不到 completedIdleTurnId。
      vi.mocked(resolveReplyDelivery).mockReturnValue(undefined);
      const sessionReply = vi.fn(async () => 'om_reply');
      initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
      const ds = makeDs();
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
      await vi.advanceTimersByTimeAsync(10);
      expect(sessionReply).toHaveBeenCalledTimes(1);
      expect(ds.completedIdleTurnId).toBeUndefined();
    });

    it('explicit send mode never sets completedIdleTurnId', async () => {
      vi.mocked(resolveReplyDelivery).mockReturnValue('send');
      const sessionReply = vi.fn(async () => 'om_reply');
      initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
      const ds = makeDs();
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
      await vi.advanceTimersByTimeAsync(10);
      expect(sessionReply).toHaveBeenCalledTimes(1);
      expect(ds.completedIdleTurnId).toBeUndefined();
    });

    it('stale lineage (a newer turn already opened) does not relabel the live card', async () => {
      armTranscript();
      const ds = makeDs();
      // Type-ahead: turn-2 was admitted while turn-1 was still running.
      ds.currentTurnId = 'turn-2';
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
      await vi.advanceTimersByTimeAsync(10);
      expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
      expect(ds.completedIdleTurnId).toBeUndefined();
    });

    it('known matching lineage still marks the turn', async () => {
      armTranscript();
      const ds = makeDs();
      ds.currentTurnId = 'turn-1';
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
      await vi.advanceTimersByTimeAsync(10);
      expect(ds.completedIdleTurnId).toBe('turn-1');
    });

    it("kind 'local-turn' (terminal-local sync) never marks the turn", async () => {
      const sessionReply = armTranscript();
      const ds = makeDs();
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, { ...finalOutputMsg(), kind: 'local-turn', userText: 'question' }, 'tag', 0);
      await vi.advanceTimersByTimeAsync(10);
      expect(sessionReply).toHaveBeenCalledTimes(1);
      expect(ds.completedIdleTurnId).toBeUndefined();
    });

    it('a card already settled to idle is re-patched immediately with the completed label', async () => {
      armTranscript();
      const ds = makeDs();
      ds.workerReady = true;
      ds.streamCardId = 'om_card';
      ds.lastScreenStatus = 'idle';
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
      await vi.advanceTimersByTimeAsync(10);
      expect(ds.completedIdleTurnId).toBe('turn-1');
      // idle label is the 20th positional arg of buildStreamingCard.
      const calls = vi.mocked(buildStreamingCard).mock.calls;
      expect(calls.some(c => c[19] === 'completed')).toBe(true);
    });

    it('a card still working is NOT patched; the label rides the next status edge', async () => {
      armTranscript();
      const ds = makeDs();
      ds.workerReady = true;
      ds.streamCardId = 'om_card';
      ds.lastScreenStatus = 'working';
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
      await vi.advanceTimersByTimeAsync(10);
      expect(ds.completedIdleTurnId).toBe('turn-1');
      const calls = vi.mocked(buildStreamingCard).mock.calls;
      expect(calls.some(c => c[19] === 'completed')).toBe(false);
    });
  });

  it('routes synthetic Codex App identities through their frozen reply turn and uses dispatch-stable Lark UUIDs', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;

    __testOnly_deliverFinalOutput(ds, {
      type: 'final_output',
      sessionId: ds.session.sessionId,
      content: 'scheduled answer one',
      lastUuid: 'synthetic-1',
      turnId: 'codex-app-dispatch-synthetic-1',
      replyTurnId: 'om_shared_route',
      codexAppSettlement: {
        requestId: 'request-1', generation: 'generation-1', seq: 1, dispatchId: 'dispatch-1',
      },
    }, 'tag', 0);
    __testOnly_deliverFinalOutput(ds, {
      type: 'final_output',
      sessionId: ds.session.sessionId,
      content: 'scheduled answer two',
      lastUuid: 'synthetic-2',
      turnId: 'codex-app-dispatch-synthetic-2',
      replyTurnId: 'om_shared_route',
      codexAppSettlement: {
        requestId: 'request-2', generation: 'generation-1', seq: 2, dispatchId: 'dispatch-2',
      },
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(sessionReply.mock.calls.map(call => call[4])).toEqual([
      'om_shared_route',
      'om_shared_route',
    ]);
    expect(sessionReply.mock.calls.map(call => call[5]?.uuid)).toEqual([
      'ca_dispatch-1',
      'ca_dispatch-2',
    ]);
    expect(sessionReply.mock.calls[0][5]).not.toHaveProperty('suppressHook');
  });

  it('routes sequential Codex App settlements through each ledger-frozen shared-chat root', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.cliId = 'codex-app';
    ds.currentReplyTarget = {
      rootMessageId: 'om_topic_b', turnId: 'turn-b', updatedAt: new Date().toISOString(),
    };
    ds.session.currentReplyTarget = ds.currentReplyTarget;
    ds.session.codexAppDispatchLedger = [
      {
        dispatchId: 'dispatch-a', turnId: 'turn-a', state: 'prepared', content: 'A',
        replyTarget: { mode: 'thread', rootMessageId: 'om_topic_a' },
      },
      {
        dispatchId: 'dispatch-b', turnId: 'turn-b', state: 'accepted', content: 'B',
        replyTarget: { mode: 'thread', rootMessageId: 'om_topic_b' },
      },
    ];
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'answer A', lastUuid: 'uuid-a', turnId: 'turn-a',
      codexAppSettlement: {
        requestId: 'settle-a', generation: 'generation-1', seq: 1, dispatchId: 'dispatch-a',
      },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(sessionReply).toHaveBeenCalledTimes(1));
    expect(sessionReply.mock.calls[0][5]?.replyTarget)
      .toEqual({ mode: 'thread', rootMessageId: 'om_topic_a' });

    (ds.worker as any).emit('message', {
      type: 'codex_app_dispatch_transition',
      sessionId: ds.session.sessionId,
      requestId: 'prepare-b',
      operation: 'submit',
      entries: [{ dispatchId: 'dispatch-b', turnId: 'turn-b' }],
    } satisfies Extract<WorkerToDaemon, { type: 'codex_app_dispatch_transition' }>);
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.[0]?.state).toBe('prepared'));
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'answer B', lastUuid: 'uuid-b', turnId: 'turn-b',
      codexAppSettlement: {
        requestId: 'settle-b', generation: 'generation-1', seq: 2, dispatchId: 'dispatch-b',
      },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(sessionReply).toHaveBeenCalledTimes(2));
    expect(sessionReply.mock.calls[1][5]?.replyTarget)
      .toEqual({ mode: 'thread', rootMessageId: 'om_topic_b' });
  });

  it.each(['doc_comment', 'http_wait', 'http_async', 'suppressed'] as const)(
    'fails closed instead of leaking a recovered %s settlement into Lark',
    async deliverySink => {
      const sessionReply = vi.fn(async () => 'om_forbidden');
      initWorkerPool({
        sessionReply,
        getSessionWorkingDir: () => '/tmp',
        getActiveCount: () => 1,
        closeSession: vi.fn(),
      });
      const ds = makeDs();
      ds.adoptedFrom = undefined;
      ds.scope = 'chat';
      ds.session.scope = 'chat';
      ds.session.cliId = 'codex-app';
      ds.session.codexAppDispatchLedger = [{
        dispatchId: `dispatch-${deliverySink}`,
        turnId: `turn-${deliverySink}`,
        state: 'prepared',
        content: 'recovered payload',
        deliverySink,
      }];
      __testOnly_setupWorkerHandlers(ds, ds.worker as any);

      (ds.worker as any).emit('message', {
        type: 'final_output',
        sessionId: ds.session.sessionId,
        content: 'must not cross channels',
        lastUuid: `uuid-${deliverySink}`,
        turnId: `turn-${deliverySink}`,
        codexAppSettlement: {
          requestId: `settle-${deliverySink}`,
          generation: 'generation-recovered',
          seq: 1,
          dispatchId: `dispatch-${deliverySink}`,
        },
      } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

      await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger).toEqual([]));
      expect(sessionReply).not.toHaveBeenCalled();
      await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'codex_app_dispatch_persisted',
          requestId: `settle-${deliverySink}`,
          ok: true,
        }),
      ));
    },
  );

  it.each([
    { name: 'non-steerable head', steerable: false, sink: 'lark' as const },
    { name: 'steerable but non-lark (doc_comment) head', steerable: true, sink: 'doc_comment' as const },
  ])(
    'R4-B4: rejects a steer_superseded settlement on a $name (ACK false, no pop, no mutation)',
    async ({ steerable, sink }) => {
      const sessionReply = vi.fn(async () => 'om_forbidden');
      initWorkerPool({
        sessionReply,
        getSessionWorkingDir: () => '/tmp',
        getActiveCount: () => 1,
        closeSession: vi.fn(),
      });
      const ds = makeDs();
      ds.adoptedFrom = undefined;
      ds.session.cliId = 'codex-app';
      // Two entries so the head has a successor — isolate the steerable/sink
      // rejection from the "no successor" rule (that is a separate worker check).
      const headEntry: any = {
        dispatchId: 'dispatch-sup-head', turnId: 'turn-sup-head', state: 'prepared',
        content: 'superseded head', deliverySink: sink,
        ...(steerable ? { codexAppSteerable: true } : {}),
      };
      ds.session.codexAppDispatchLedger = [
        headEntry,
        { dispatchId: 'dispatch-sup-next', turnId: 'turn-sup-next', state: 'accepted', content: 'next', deliverySink: 'lark', codexAppSteerable: true },
      ];
      __testOnly_setupWorkerHandlers(ds, ds.worker as any);

      (ds.worker as any).emit('message', {
        type: 'final_output', sessionId: ds.session.sessionId,
        content: '', lastUuid: 'uuid-sup-head', turnId: 'turn-sup-head',
        suppressDelivery: true,
        disposition: 'steer_superseded',
        codexAppSettlement: {
          requestId: 'settle-sup-head', generation: 'gen-sup', seq: 1, dispatchId: 'dispatch-sup-head',
        },
      } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

      // ACK false, no delivery, and the ledger head is NOT popped (no mutation).
      await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'codex_app_dispatch_persisted',
          requestId: 'settle-sup-head',
          ok: false,
        }),
      ));
      expect(sessionReply).not.toHaveBeenCalled();
      expect(ds.session.codexAppDispatchLedger?.[0]?.dispatchId).toBe('dispatch-sup-head');
      expect(ds.session.codexAppDispatchLedger?.length).toBe(2);
    },
  );

  it('R4-B4: commits a steer_superseded settlement on a steerable Lark head with a successor (ACK true, pop, no delivery)', async () => {
    const sessionReply = vi.fn(async () => 'om_forbidden');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.session.cliId = 'codex-app';
    ds.session.codexAppDispatchLedger = [
      { dispatchId: 'dispatch-ok-head', turnId: 'turn-ok-head', state: 'prepared', content: 'superseded', deliverySink: 'lark', codexAppSteerable: true },
      { dispatchId: 'dispatch-ok-next', turnId: 'turn-ok-next', state: 'accepted', content: 'real', deliverySink: 'lark', codexAppSteerable: true },
    ];
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: '', lastUuid: 'uuid-ok-head', turnId: 'turn-ok-head',
      suppressDelivery: true,
      disposition: 'steer_superseded',
      codexAppSettlement: {
        requestId: 'settle-ok-head', generation: 'gen-ok', seq: 1, dispatchId: 'dispatch-ok-head',
      },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

    // ACK true, ledger head popped (durable FIFO advanced), but never delivered.
    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'codex_app_dispatch_persisted',
        requestId: 'settle-ok-head',
        ok: true,
      }),
    ));
    expect(sessionReply).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.length).toBe(1));
    expect(ds.session.codexAppDispatchLedger?.[0]?.dispatchId).toBe('dispatch-ok-next');
  });

  it('R5-B4-2: rejects a steer_superseded on a steerable head with an UNDEFINED sink (legacy/mixed ledger fails closed)', async () => {
    const sessionReply = vi.fn(async () => 'om_forbidden');
    initWorkerPool({
      sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.session.cliId = 'codex-app';
    // steerable=true but deliverySink MISSING — admission always writes both, so
    // this can only be a mixed/corrupt/legacy ledger and must fail closed.
    ds.session.codexAppDispatchLedger = [
      { dispatchId: 'dispatch-nosink-head', turnId: 'turn-nosink-head', state: 'prepared', content: 'x', codexAppSteerable: true },
      { dispatchId: 'dispatch-nosink-next', turnId: 'turn-nosink-next', state: 'accepted', content: 'y', deliverySink: 'lark', codexAppSteerable: true },
    ];
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: '', lastUuid: 'uuid-nosink', turnId: 'turn-nosink-head',
      suppressDelivery: true, disposition: 'steer_superseded',
      codexAppSettlement: { requestId: 'settle-nosink', generation: 'gen-ns', seq: 1, dispatchId: 'dispatch-nosink-head' },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex_app_dispatch_persisted', requestId: 'settle-nosink', ok: false }),
    ));
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.session.codexAppDispatchLedger?.length).toBe(2);
    expect(ds.session.codexAppDispatchLedger?.[0]?.dispatchId).toBe('dispatch-nosink-head');
  });

  it('R5-B4-2: rejects a steer_superseded on the SOLE remaining head (no successor — a lone forged superseded must not commit)', async () => {
    const sessionReply = vi.fn(async () => 'om_forbidden');
    initWorkerPool({
      sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.session.cliId = 'codex-app';
    // A perfectly steerable Lark head — but it is the ONLY entry. A superseded
    // member must have a real successor; the sole head can only settle as a real
    // final. A lone forged superseded would otherwise silently commit it.
    ds.session.codexAppDispatchLedger = [
      { dispatchId: 'dispatch-solo', turnId: 'turn-solo', state: 'prepared', content: 'solo', deliverySink: 'lark', codexAppSteerable: true },
    ];
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: '', lastUuid: 'uuid-solo', turnId: 'turn-solo',
      suppressDelivery: true, disposition: 'steer_superseded',
      codexAppSettlement: { requestId: 'settle-solo', generation: 'gen-solo', seq: 1, dispatchId: 'dispatch-solo' },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex_app_dispatch_persisted', requestId: 'settle-solo', ok: false }),
    ));
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.session.codexAppDispatchLedger?.length).toBe(1);
    expect(ds.session.codexAppDispatchLedger?.[0]?.dispatchId).toBe('dispatch-solo');
  });

  it('R7-B2 daemon half: a two-member steered group settles through the REAL daemon handler — superseded head persisted+suppressed (not delivered), real member delivered, ledger drains', async () => {
    // DAEMON-SIDE of the round-trip: drives the real setupWorkerHandlers ledger
    // preview → store-write → ACK path (not a worker-side fake ACK). Member 1 is
    // steer_superseded (must commit + NOT deliver), member 2 is the real final
    // (must deliver). Proves the daemon accepts the superseded, advances the FIFO,
    // and only delivers the real member — the half the worker integration test
    // stubs with a deterministic ACK.
    const sessionReply = vi.fn(async () => 'om_delivered');
    initWorkerPool({
      sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.session.cliId = 'codex-app';
    ds.session.codexAppDispatchLedger = [
      { dispatchId: 'd-grp-1', turnId: 'turn-grp-1', state: 'prepared', content: '', deliverySink: 'lark', codexAppSteerable: true, replyTarget: { mode: 'thread', rootMessageId: 'om_grp' } },
      { dispatchId: 'd-grp-2', turnId: 'turn-grp-2', state: 'accepted', content: 'real answer', deliverySink: 'lark', codexAppSteerable: true, replyTarget: { mode: 'thread', rootMessageId: 'om_grp' } },
    ];
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // Member 1: superseded — persisted + suppressed (no delivery), pops the head.
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: '', lastUuid: 'uuid-grp-1', turnId: 'turn-grp-1',
      suppressDelivery: true, disposition: 'steer_superseded',
      codexAppSettlement: { requestId: 'settle-grp-1', generation: 'gen-grp', seq: 1, dispatchId: 'd-grp-1' },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex_app_dispatch_persisted', requestId: 'settle-grp-1', ok: true })));
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.length).toBe(1));
    expect(sessionReply).not.toHaveBeenCalled(); // superseded head NOT delivered

    // Member 2 becomes the head; the runner submits it (accepted → prepared)
    // before its final can settle — mirror that transition through the real handler.
    (ds.worker as any).emit('message', {
      type: 'codex_app_dispatch_transition',
      sessionId: ds.session.sessionId,
      requestId: 'prepare-grp-2',
      operation: 'submit',
      entries: [{ dispatchId: 'd-grp-2', turnId: 'turn-grp-2' }],
    } satisfies Extract<WorkerToDaemon, { type: 'codex_app_dispatch_transition' }>);
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.[0]?.state).toBe('prepared'));

    // Member 2: the real final — delivered, ledger fully drains.
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'real answer', lastUuid: 'uuid-grp-2', turnId: 'turn-grp-2',
      codexAppSettlement: { requestId: 'settle-grp-2', generation: 'gen-grp', seq: 2, dispatchId: 'd-grp-2' },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(sessionReply).toHaveBeenCalledTimes(1)); // real member delivered
    // codex R7 delta: assert the daemon returns the REAL final's persistence ACK
    // too (not only the superseded head's settle-grp-1). Without this, a daemon
    // that forgets to ACK the last member would still drain the ledger + deliver
    // to Lark here, but the real worker would hang forever in
    // waitForCodexAppDaemonPersistence — invisible to a delivery-only assertion.
    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex_app_dispatch_persisted', requestId: 'settle-grp-2', ok: true })));
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger ?? []).toEqual([]));
  });

  it('HTTP steer: an http_async steer group fans the REAL final out to the superseded member (in-memory + durable, no Lark)', async () => {
    // options.steer over the HTTP control API: member 1 is the root riff task
    // (http_async, polling trigger-result by its own triggerId), member 2 is the
    // steer follow-up that merged into the active codex turn. Member 1 settles
    // steer_superseded (parked, NOT delivered); the real final for member 2 must
    // resolve BOTH members with the merged answer and drain the ledger.
    const sessionReply = vi.fn(async () => 'om_delivered');
    initWorkerPool({
      sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.session.sessionId = 'sid-http-steer-async';
    ds.adoptedFrom = undefined;
    ds.session.cliId = 'codex-app';
    ds.asyncTriggerResults = new Map([
      ['turn-http-grp-1', { status: 'pending' as const, createdAt: 1 }],
      ['turn-http-grp-2', { status: 'pending' as const, createdAt: 2 }],
    ]);
    ds.idempotentAsyncTurns = new Map([
      ['turn-http-grp-1', { ownerLarkAppId: 'app_test', key: 'k1', kind: 'turn' as const, workerGeneration: 1 }],
    ]);
    ds.session.codexAppDispatchLedger = [
      { dispatchId: 'd-http-grp-1', turnId: 'turn-http-grp-1', state: 'prepared', content: '', deliverySink: 'http_async', codexAppSteerable: true },
      { dispatchId: 'd-http-grp-2', turnId: 'turn-http-grp-2', state: 'accepted', content: 'merged answer', deliverySink: 'http_async', codexAppSteerable: true },
    ];
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // Member 1: superseded — ACK true, ledger pops, parked for fan-out, no Lark.
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: '', lastUuid: 'uuid-http-grp-1', turnId: 'turn-http-grp-1',
      suppressDelivery: true, disposition: 'steer_superseded',
      codexAppSettlement: { requestId: 'settle-http-grp-1', generation: 'gen-http-grp', seq: 1, dispatchId: 'd-http-grp-1' },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex_app_dispatch_persisted', requestId: 'settle-http-grp-1', ok: true })));
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.length).toBe(1));
    expect(sessionReply).not.toHaveBeenCalled();
    // Still pending: the merged answer has not arrived yet.
    expect(ds.asyncTriggerResults.get('turn-http-grp-1')?.status).toBe('pending');

    // Member 2: submit (accepted → prepared), then the real merged final.
    (ds.worker as any).emit('message', {
      type: 'codex_app_dispatch_transition',
      sessionId: ds.session.sessionId,
      requestId: 'prepare-http-grp-2',
      operation: 'submit',
      entries: [{ dispatchId: 'd-http-grp-2', turnId: 'turn-http-grp-2' }],
    } satisfies Extract<WorkerToDaemon, { type: 'codex_app_dispatch_transition' }>);
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.[0]?.state).toBe('prepared'));
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'merged answer', lastUuid: 'uuid-http-grp-2', turnId: 'turn-http-grp-2',
      codexAppSettlement: { requestId: 'settle-http-grp-2', generation: 'gen-http-grp', seq: 2, dispatchId: 'd-http-grp-2' },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

    // The real final resolves BOTH members with the merged answer.
    await vi.waitFor(() => expect(ds.asyncTriggerResults.get('turn-http-grp-1')?.status).toBe('completed'));
    expect(ds.asyncTriggerResults.get('turn-http-grp-1')?.content).toBe('merged answer');
    expect(ds.asyncTriggerResults.get('turn-http-grp-1')?.usage).toBeUndefined(); // usage belongs to the real trigger only
    expect(ds.asyncTriggerResults.get('turn-http-grp-2')?.status).toBe('completed');
    expect(ds.asyncTriggerResults.get('turn-http-grp-2')?.content).toBe('merged answer');
    // The convergence entry is dropped so a later graceful worker exit cannot
    // retro-fail the merged root turn.
    expect(ds.idempotentAsyncTurns.has('turn-http-grp-1')).toBe(false);
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger ?? []).toEqual([]));
    expect(sessionReply).not.toHaveBeenCalled(); // HTTP-only group never touches Lark
    // Durable fan-out: the superseded triggerId itself is a completed record.
    const { lookup } = await import('../src/services/async-trigger-store.js');
    const persisted1 = lookup(ds.session.sessionId, 'turn-http-grp-1');
    expect(persisted1?.result.status).toBe('completed');
    expect(persisted1?.result.content).toBe('merged answer');
    expect(persisted1?.result.usage).toBeUndefined();
  });

  it('HTTP steer: an http_wait steer group resolves the superseded member\'s open wait promise with the merged answer', async () => {
    const sessionReply = vi.fn(async () => 'om_delivered');
    const resolveRootWait = vi.fn();
    initWorkerPool({
      sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.session.sessionId = 'sid-http-steer-wait';
    ds.adoptedFrom = undefined;
    ds.session.cliId = 'codex-app';
    ds.pendingWaitPromises = new Map([
      ['turn-wait-grp-1', { resolve: resolveRootWait }],
      ['turn-wait-grp-2', { resolve: vi.fn() }],
    ]);
    ds.session.codexAppDispatchLedger = [
      { dispatchId: 'd-wait-grp-1', turnId: 'turn-wait-grp-1', state: 'prepared', content: '', deliverySink: 'http_wait', codexAppSteerable: true },
      { dispatchId: 'd-wait-grp-2', turnId: 'turn-wait-grp-2', state: 'accepted', content: 'merged', deliverySink: 'http_wait', codexAppSteerable: true },
    ];
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: '', lastUuid: 'uuid-wait-grp-1', turnId: 'turn-wait-grp-1',
      suppressDelivery: true, disposition: 'steer_superseded',
      codexAppSettlement: { requestId: 'settle-wait-grp-1', generation: 'gen-wait-grp', seq: 1, dispatchId: 'd-wait-grp-1' },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex_app_dispatch_persisted', requestId: 'settle-wait-grp-1', ok: true })));
    expect(resolveRootWait).not.toHaveBeenCalled(); // parked until the real final

    (ds.worker as any).emit('message', {
      type: 'codex_app_dispatch_transition', sessionId: ds.session.sessionId,
      requestId: 'prepare-wait-grp-2', operation: 'submit',
      entries: [{ dispatchId: 'd-wait-grp-2', turnId: 'turn-wait-grp-2' }],
    } satisfies Extract<WorkerToDaemon, { type: 'codex_app_dispatch_transition' }>);
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.[0]?.state).toBe('prepared'));
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'merged answer', lastUuid: 'uuid-wait-grp-2', turnId: 'turn-wait-grp-2',
      codexAppSettlement: { requestId: 'settle-wait-grp-2', generation: 'gen-wait-grp', seq: 2, dispatchId: 'd-wait-grp-2' },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

    await vi.waitFor(() => expect(resolveRootWait).toHaveBeenCalledWith('merged answer'));
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger ?? []).toEqual([]));
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('HTTP steer: pruning fanout state on ledger drain stops a later real final resolving the parked failure-group member', async () => {
    // Failure shape: the group's last head dies (turn_terminal / recovery fence)
    // and the ledger drains WITHOUT a real final settle. The onCodexAppLedgerDrained
    // chokepoint prunes the parked in-memory fanout state so the parked member
    // converges through its own terminal/closed-session paths — and a final that
    // settles afterwards must never retroactively fan content into it (the FIFO
    // group is already over).
    const sessionReply = vi.fn(async () => 'om_delivered');
    initWorkerPool({
      sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.session.sessionId = 'sid-http-steer-prune';
    ds.adoptedFrom = undefined;
    ds.session.cliId = 'codex-app';
    ds.asyncTriggerResults = new Map([
      ['turn-prune-1', { status: 'pending' as const, createdAt: 1 }],
      ['turn-prune-2', { status: 'pending' as const, createdAt: 2 }],
    ]);
    ds.session.codexAppDispatchLedger = [
      { dispatchId: 'd-prune-1', turnId: 'turn-prune-1', state: 'prepared', content: '', deliverySink: 'http_async', codexAppSteerable: true },
      { dispatchId: 'd-prune-2', turnId: 'turn-prune-2', state: 'accepted', content: 'merged answer', deliverySink: 'http_async', codexAppSteerable: true },
    ];
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // Member 1 settles superseded → parked for fan-out.
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: '', lastUuid: 'uuid-prune-1', turnId: 'turn-prune-1',
      suppressDelivery: true, disposition: 'steer_superseded',
      codexAppSettlement: { requestId: 'settle-prune-1', generation: 'gen-prune', seq: 1, dispatchId: 'd-prune-1' },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex_app_dispatch_persisted', requestId: 'settle-prune-1', ok: true })));
    expect(ds.asyncTriggerResults.get('turn-prune-1')?.status).toBe('pending');

    // The failure path drains the ledger (terminal/recovery fence). The daemon's
    // onCodexAppLedgerDrained chokepoint prunes the parked group state at that
    // point. Simulate that prune while T2 is still queued.
    pruneSteerFanoutState(ds.session.sessionId);

    // T2 then settles through the normal FIFO path (submit → real final). With
    // the park table pruned its real final must NOT fan out to member 1.
    (ds.worker as any).emit('message', {
      type: 'codex_app_dispatch_transition',
      sessionId: ds.session.sessionId,
      requestId: 'prepare-prune-2',
      operation: 'submit',
      entries: [{ dispatchId: 'd-prune-2', turnId: 'turn-prune-2' }],
    } satisfies Extract<WorkerToDaemon, { type: 'codex_app_dispatch_transition' }>);
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger?.[0]?.state).toBe('prepared'));
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'late merged answer', lastUuid: 'uuid-prune-2', turnId: 'turn-prune-2',
      codexAppSettlement: { requestId: 'settle-prune-2', generation: 'gen-prune', seq: 2, dispatchId: 'd-prune-2' },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

    // T2 completes normally; wait for its SETTLEMENT ACK, not just the
    // asyncResult completion — fan-out runs synchronously right after that ACK
    // in the same handler continuation, so observing the ACK proves any
    // (incorrect) fan-out onto member 1 has already happened or been skipped.
    await vi.waitFor(() => expect((ds.worker as any).send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex_app_dispatch_persisted', requestId: 'settle-prune-2', ok: true })));
    // Member 1 was pruned and stays pending for its own convergence path — the
    // pruned park table must NOT have fanned T2's content into it.
    expect(ds.asyncTriggerResults.get('turn-prune-1')?.status).toBe('pending');
    expect(ds.asyncTriggerResults.get('turn-prune-1')?.content).toBeUndefined();
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('still resolves a live HTTP wait sink without posting to Lark', async () => {
    const sessionReply = vi.fn(async () => 'om_forbidden');
    const resolveWait = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    ds.session.cliId = 'codex-app';
    ds.pendingWaitPromises = new Map([['turn-wait-live', { resolve: resolveWait }]]);
    ds.session.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-wait-live',
      turnId: 'turn-wait-live',
      state: 'prepared',
      content: 'live payload',
      deliverySink: 'http_wait',
    }];
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'HTTP answer', lastUuid: 'uuid-wait-live', turnId: 'turn-wait-live',
      codexAppSettlement: {
        requestId: 'settle-wait-live', generation: 'generation-live', seq: 1,
        dispatchId: 'dispatch-wait-live',
      },
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

    await vi.waitFor(() => expect(resolveWait).toHaveBeenCalledWith('HTTP answer'));
    await vi.waitFor(() => expect(ds.session.codexAppDispatchLedger).toEqual([]));
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('abandons a delayed final before external delivery when worker/session ownership changes', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    let owned = true;
    const complete = vi.fn();

    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0, complete, () => owned);
    owned = false;
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(false);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });

  it('keeps a shutdown drain registration until an ordinary bridge final finishes delivery', async () => {
    let resolveReply!: (messageId: string) => void;
    const sessionReply = vi.fn(() => new Promise<string>(resolve => {
      resolveReply = resolve;
    }));
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.finalOutputDeliveriesInFlight?.size).toBe(1);

    resolveReply('om_reply');
    await vi.waitFor(() => {
      expect(ds.finalOutputDeliveriesInFlight).toBeUndefined();
    });
  });

  it('drops final_output whose worker sessionId does not match the daemon session', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: 'sid-other-worker',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });

  it('clears a stuck limited state when a real answer is harvested after recovery', async () => {
    // Regression guard (adopt/bridge sessions): a structured rate-limit emit
    // parks ds in `limited`, but in-terminal recovery has no Lark turn / retry
    // button / kill to clear it. A harvested final_output is a definitive
    // self-heal signal, so it must clear the stale limit + drop 'limited'.
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.workerPort = 4321;
    ds.usageLimit = { limited: true, kind: 'rate', retryAtMs: Date.now() + 5 * 60_000, retryLabel: '5-10 min', retryReady: false };
    ds.lastScreenStatus = 'limited';
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(ds.usageLimit).toBeUndefined();
    expect(ds.lastScreenStatus).not.toBe('limited');
    expect(sessionReply).toHaveBeenCalled();
  });

  it('marks message listener run preview replied when an explicit botmux send is observed', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const run = createMessageListenerRunPreview('app_test', 'oc_chat', ['om_source']);
    const triggerId = 'mlrp_turn_explicit_send';
    markMessageListenerRunPreviewTriggered(run.runId, 'om_source', {
      action: 'queued',
      sessionId: 'sid-final-out',
      triggerId,
    });

    const ds = makeDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'explicit_reply_observed',
      turnId: triggerId,
      messageId: 'om_explicit_reply',
    } as any);

    const updated = getMessageListenerRunPreview(run.runId);
    expect(updated?.results[0]).toMatchObject({
      messageId: 'om_source',
      state: 'replied',
      sessionId: ds.session.sessionId,
      replyMessageId: 'om_explicit_reply',
    });
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('records Hermes source binding and allows matching sourceHermesSessionId', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-A',
    });
    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-A',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(ds.hermesBridgeSourceSessionIds).toEqual(new Set(['hermes-A']));
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('resets Hermes source authorization for a replacement worker and ignores stale bindings', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    const oldWorker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, oldWorker);
    oldWorker.emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-A',
    });
    expect(ds.hermesBridgeSourceSessionIds).toEqual(new Set(['hermes-A']));

    const replacementWorker = new EventEmitter() as any;
    replacementWorker.killed = false;
    replacementWorker.send = vi.fn();
    replacementWorker.kill = vi.fn();
    replacementWorker.pid = 100000;
    __testOnly_setupWorkerHandlers(ds, replacementWorker);
    ds.worker = replacementWorker;

    expect(ds.hermesBridgeSourceSessionIds).toBeUndefined();

    replacementWorker.emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-A',
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).not.toHaveBeenCalled();

    oldWorker.emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-A-late',
    });
    expect(ds.hermesBridgeSourceSessionIds).toBeUndefined();

    replacementWorker.emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-C',
    });
    expect(ds.hermesBridgeSourceSessionIds).toEqual(new Set(['hermes-C']));
  });

  it('keeps old and rebound Hermes sources valid when one drain emits both turns', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // The worker was already bound to A. During one later drain it discovers
    // C's marker and sends that rebind before emitReadyCodexTurns forwards the
    // completed A turn followed by C's turn.
    (ds.worker as any).emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-A',
    });
    (ds.worker as any).emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-C',
    });
    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-A',
      content: 'answer from A',
      lastUuid: 'uuid-A',
      turnId: 'turn-A',
    });
    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-C',
      content: 'answer from C',
      lastUuid: 'uuid-C',
      turnId: 'turn-C',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(ds.hermesBridgeSourceSessionIds).toEqual(new Set(['hermes-A', 'hermes-C']));
    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(sessionReply.mock.calls[0][1]).toContain('answer from A');
    expect(sessionReply.mock.calls[1][1]).toContain('answer from C');
    expect(sessionReply.mock.calls.map(call => call[4])).toEqual(['turn-A', 'turn-C']);
  });

  it('drops Hermes final_output whose sourceHermesSessionId does not match the bound source', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    ds.hermesBridgeSourceSessionIds = new Set(['hermes-A']);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-B',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });

  it('drops Hermes final_output with sourceHermesSessionId before daemon has a binding', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-A',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });

  it('drops Hermes final_output without sourceHermesSessionId after a source is bound', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    ds.hermesBridgeSourceSessionIds = new Set(['hermes-A']);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });

  it('does not apply the Hermes source guard after the session switches to another CLI', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.cliId = 'codex';
    ds.hermesBridgeSourceSessionIds = new Set(['hermes-A']);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('does not address daemon final-output footers to a known bot owner', async () => {
    writeFileSync(
      join(config.session.dataDir, 'bot-openids-app_test.json'),
      JSON.stringify({ Claude: 'ou_foreign_bot' }),
    );

    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.ownerOpenId = 'ou_foreign_bot';
    ds.ownerOpenId = 'ou_foreign_bot';

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain('[botmux](');
    expect(cardJson).not.toContain('<at id=ou_foreign_bot></at>');
  });

  it.each(['claude-code', 'codex', 'hermes'] as const)(
    'zero-prompt %s terminal finals inherit the initiator at start and use fresh normal cards through retries', async cliId => {
      const sessionReply = vi.fn().mockRejectedValueOnce(new Error('network error')).mockResolvedValue('om_reply');
      const onZeroPromptFinal = vi.fn(async () => {});
      initWorkerPool({ sessionReply, onZeroPromptFinal, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
      const ds = makeDs();
      ds.adoptedFrom = undefined;
      ds.scope = 'chat';
      ds.session.cliId = cliId;
      ds.session.promptInjection = 'none';
      ds.session.quoteTargetId = 'om_original';
      ds.session.quoteTargetSenderOpenId = 'ou_initiator';
      ds.session.quoteTargetSenderIsBot = true;
      ds.session.turnReplyContexts = { om_original: {
        target: { mode: 'thread', rootMessageId: 'om_original_topic' },
        replyTargetSenderOpenId: 'ou_initiator', replyTargetSenderIsBot: true,
      } };
      __testOnly_setupWorkerHandlers(ds, ds.worker as any);
      ds.worker!.emit('message', { type: 'terminal_turn_started', turnId: 'local-native-1', startedAtMs: Date.now() });
      ds.session.quoteTargetId = 'om_new';
      ds.session.quoteTargetSenderOpenId = 'ou_later';
      ds.session.turnReplyContexts.om_new = {
        target: { mode: 'quote', rootMessageId: 'om_new_topic' },
        replyTargetSenderOpenId: 'ou_later', replyTargetSenderIsBot: true,
      };
      ds.worker!.emit('message', {
        ...finalOutputMsg(), sessionId: ds.session.sessionId, turnId: 'local-native-1',
        terminalLocal: true, content: 'Recovered review final',
      });
      await vi.advanceTimersByTimeAsync(10);
      // The in-flight attempt owns its frozen address even if bounded records
      // are pruned before the retry.
      delete ds.session.turnReplyContexts['local-native-1'];
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sessionReply).toHaveBeenCalledTimes(2);
      for (const call of sessionReply.mock.calls) {
        const card = String(call[1]);
        expect(card).toContain('Recovered review final');
        expect(card).toContain('<at id=ou_initiator></at>');
        expect(card).not.toContain('ou_later');
        expect(card).not.toMatch(/终端本地对话|来自终端/);
        expect(call[5]).toMatchObject({ replyTarget: { mode: 'thread', rootMessageId: 'om_original_topic' } });
      }
      expect(sessionReply.mock.calls[0][5].uuid).toBe(sessionReply.mock.calls[1][5].uuid);
      expect(updateMessageMock).not.toHaveBeenCalled();
      expect(onZeroPromptFinal).not.toHaveBeenCalled();
      ds.worker!.emit('message', { type: 'terminal_turn_started', turnId: 'local-native-2', startedAtMs: Date.now() });
      ds.worker!.emit('message', {
        ...finalOutputMsg(), sessionId: ds.session.sessionId, turnId: 'local-native-2',
        lastUuid: 'uuid-2', terminalLocal: true, content: 'Next terminal final',
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(sessionReply).toHaveBeenCalledTimes(3);
      expect(String(sessionReply.mock.calls[2][1])).toContain('<at id=ou_later></at>');
      expect(sessionReply.mock.calls[2][5]).toMatchObject({ replyTarget: { mode: 'quote', rootMessageId: 'om_new_topic' } });
    },
  );

  it('does not enable terminal final forwarding in ordinary or adopted sessions', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    for (const zero of [false, true]) {
      const ds = makeDs();
      if (zero) ds.session.promptInjection = 'none';
      else ds.adoptedFrom = undefined;
      __testOnly_setupWorkerHandlers(ds, ds.worker as any);
      ds.worker!.emit('message', { type: 'terminal_turn_started', turnId: 'local-native', startedAtMs: Date.now() });
      ds.worker!.emit('message', { ...finalOutputMsg(), turnId: 'local-native', terminalLocal: true });
      expect(ds.session.turnReplyContexts?.['local-native']).toBeUndefined();
    }
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it.each(['claude-code', 'codex', 'hermes'] as const)(
    'zero-injection %s finals @ the exact initiating bot once without an extra HTTP report', async cliId => {
      const sessionReply = vi.fn(async () => 'om_reply');
      const onZeroPromptFinal = vi.fn(async () => {});
      initWorkerPool({ sessionReply, onZeroPromptFinal, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
      const ds = makeDs();
      ds.session.cliId = cliId;
      ds.session.promptInjection = 'none';
      ds.session.ownerOpenId = 'ou_owner';
      ds.session.quoteTargetId = 'turn-new';
      ds.session.quoteTargetSenderOpenId = 'ou_new_sender';
      ds.session.replyTargets = {
        'turn-1': { updatedAt: new Date().toISOString(), senderOpenId: 'ou_initiating_bot',
          participants: [{ openId: 'ou_initiating_bot', isBot: true }, { openId: 'ou_other', isBot: false }] },
      };
      const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
      deliver(ds, finalOutputMsg(), 'tag', 0);
      await vi.advanceTimersByTimeAsync(10);
      const card = String(sessionReply.mock.calls[0][1]);
      expect(card.match(/<at id=ou_initiating_bot><\/at>/g)).toHaveLength(1);
      for (const id of ['ou_owner', 'ou_new_sender', 'ou_other']) expect(card).not.toContain(`<at id=${id}>`);
      expect(onZeroPromptFinal).not.toHaveBeenCalled();
    },
  );

  it('zero-injection final retries retain the original human sender even after the turn records are pruned', async () => {
    const sessionReply = vi.fn().mockRejectedValueOnce(new Error('network error')).mockResolvedValue('om_reply');
    const onZeroPromptFinal = vi.fn(async () => {});
    initWorkerPool({ sessionReply, onZeroPromptFinal, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.initConfig = { promptInjection: 'none' } as any;
    ds.session.ownerOpenId = 'ou_owner';
    ds.session.turnReplyContexts = { 'turn-1': {
      target: { mode: 'thread', rootMessageId: 'om_original' },
      replyTargetSenderOpenId: 'ou_initiator', replyTargetSenderIsBot: false,
    } };
    const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
    deliver(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    ds.session.turnReplyContexts = {};
    ds.session.quoteTargetId = 'turn-new';
    ds.session.quoteTargetSenderOpenId = 'ou_other';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessionReply).toHaveBeenCalledTimes(2);
    for (const call of sessionReply.mock.calls) {
      expect(String(call[1])).toContain('<at id=ou_initiator></at>');
      expect(String(call[1])).not.toContain('<at id=ou_owner>');
      expect(String(call[1])).not.toContain('<at id=ou_other>');
    }
    expect(onZeroPromptFinal).toHaveBeenCalledTimes(1);
  });

  it.each(['ou_stale', 'all', 'cli_peer', 'ou_bot'])(
    'zero-injection final never guesses or emits an invalid/self recipient (%s)', async sender => {
      const sessionReply = vi.fn(async () => 'om_reply');
      initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
      const ds = makeDs();
      ds.session.promptInjection = 'none';
      ds.session.ownerOpenId = 'ou_owner';
      ds.session.quoteTargetId = sender === 'ou_stale' ? 'turn-new' : 'turn-1';
      ds.session.quoteTargetSenderOpenId = sender;
      const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
      deliver(ds, finalOutputMsg(), 'tag', 0);
      await vi.advanceTimersByTimeAsync(10);
      expect(String(sessionReply.mock.calls[0][1])).not.toContain('<at id=');
    },
  );

  it('zero-injection accepts a legacy sender only for the matching reply turn', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const ds = makeDs();
    ds.session.promptInjection = 'none';
    ds.session.quoteTargetId = 'original-turn';
    ds.session.quoteTargetSenderOpenId = 'ou_original_bot';
    ds.session.quoteTargetSenderIsBot = true;
    const { __testOnly_deliverFinalOutput: deliver } = await import('../src/core/worker-pool.js');
    deliver(ds, { ...finalOutputMsg(), replyTurnId: 'original-turn' }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(String(sessionReply.mock.calls[0][1])).toContain('<at id=ou_original_bot></at>');
  });

  it('addresses Mira daemon fallback output back to the bot dispatcher', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.cliId = 'mira';
    ds.session.ownerOpenId = undefined;
    ds.ownerOpenId = undefined;
    ds.session.creatorOpenId = 'ou_dispatcher_bot';
    ds.session.quoteTargetSenderIsBot = true;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain('<at id=ou_dispatcher_bot></at>');
  });

  it.each(['mira', 'mir', 'dsh'] as const)('addresses %s daemon fallback output back to the bot dispatcher', async (cliId) => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.cliId = cliId;
    ds.session.ownerOpenId = undefined;
    ds.ownerOpenId = undefined;
    ds.session.creatorOpenId = 'ou_dispatcher_bot';
    ds.session.quoteTargetSenderIsBot = true;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain('<at id=ou_dispatcher_bot></at>');
  });

  it('addresses Mira fallback output to a known-bot owner (/repo-primed dispatch)', async () => {
    // `botmux dispatch --repo` primes the thread with "@bot /repo <path>",
    // which records the dispatching bot as ownerOpenId (daemon /repo
    // session-create path) instead of nulling it like @-mention auto-create.
    writeFileSync(
      join(config.session.dataDir, 'bot-openids-app_test.json'),
      JSON.stringify({ Orchestrator: 'ou_orch_bot' }),
    );

    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.cliId = 'mira';
    ds.session.ownerOpenId = 'ou_orch_bot';
    ds.ownerOpenId = 'ou_orch_bot';
    ds.session.creatorOpenId = 'ou_orch_bot';
    ds.session.quoteTargetSenderIsBot = true;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain('<at id=ou_orch_bot></at>');
  });

  it('keeps daemon final-output footer addressing for a human owner', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.ownerOpenId = 'ou_human';
    ds.ownerOpenId = 'ou_human';

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain('<at id=ou_human></at>');
  });

  it('uses probe-free lexical link repair for sandboxed bridge fallback output', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.sandbox = true;
    const home = homedir().replace(/\/+$/, '');
    const relativeHome = home.replace(/^\/+/, '');
    const missing = `${relativeHome}/botmux-definitely-missing-${Date.now()}.md`;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      content: `[file](${missing})`,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain(`[file](/${missing})`);
  });

  it('preserves a real home-shaped relative link in a non-isolated bridge fallback', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const cwd = mkdtempSync(join(tmpdir(), 'botmux-bridge-relative-'));
    const relativeHome = homedir().replace(/^\/+|\/+$/g, '');
    const relativeFile = `${relativeHome}/project/a.md`;
    mkdirSync(join(cwd, relativeHome, 'project'), { recursive: true });
    writeFileSync(join(cwd, relativeFile), 'relative');
    try {
      const ds = makeDs();
      ds.workingDir = cwd;
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, {
        ...finalOutputMsg(),
        content: `[file](${relativeFile})`,
      }, 'tag', 0);

      await vi.advanceTimersByTimeAsync(10);

      const cardJson = sessionReply.mock.calls[0][1] as string;
      expect(cardJson).toContain(`[file](${relativeFile})`);
      expect(cardJson).not.toContain(`[file](/${relativeFile})`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('uses probe-free lexical link repair for read-isolated bridge fallback output', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.initConfig = { readIsolation: true } as any;
    const home = homedir().replace(/\/+$/, '');
    const relativeHome = home.replace(/^\/+/, '');
    const missing = `${relativeHome}/botmux-definitely-missing-read-iso-${Date.now()}.md`;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      content: `[file](${missing})`,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain(`[file](/${missing})`);
  });

  it.each([
    ['persisted session backend', (ds: DaemonSession) => { ds.session.backendType = 'riff'; }],
    ['reconciled live backend', (ds: DaemonSession) => {
      ds.session.backendType = 'tmux';
      ds.initConfig = { backendType: 'riff' } as any;
    }],
  ])('uses probe-free lexical link repair for Riff via %s', async (_source, configure) => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    configure(ds);
    const home = homedir().replace(/\/+$/, '');
    const relativeHome = home.replace(/^\/+/, '');
    const missing = `${relativeHome}/botmux-definitely-missing-riff-${Date.now()}.md`;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      content: `[file](${missing})`,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain(`[file](/${missing})`);
  });

  it('uses lexical link repair when sandboxing is forced globally', async () => {
    const previous = process.env.BOTMUX_SANDBOX;
    process.env.BOTMUX_SANDBOX = '1';
    try {
      const sessionReply = vi.fn(async () => 'om_reply');
      initWorkerPool({
        sessionReply,
        getSessionWorkingDir: () => '/tmp',
        getActiveCount: () => 1,
        closeSession: vi.fn(),
      });

      const ds = makeDs();
      const home = homedir().replace(/\/+$/, '');
      const relativeHome = home.replace(/^\/+/, '');
      const missing = `${relativeHome}/botmux-definitely-missing-global-sandbox-${Date.now()}.md`;

      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, {
        ...finalOutputMsg(),
        content: `[file](${missing})`,
      }, 'tag', 0);

      await vi.advanceTimersByTimeAsync(10);

      const cardJson = sessionReply.mock.calls[0][1] as string;
      expect(cardJson).toContain(`[file](/${missing})`);
    } finally {
      if (previous === undefined) delete process.env.BOTMUX_SANDBOX;
      else process.env.BOTMUX_SANDBOX = previous;
    }
  });

  it('uses probe-free lexical link repair for adopt preamble cards', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.sandbox = true;
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    const home = homedir().replace(/\/+$/, '');
    const relativeHome = home.replace(/^\/+/, '');
    const missing = `${relativeHome}/botmux-definitely-missing-adopt-${Date.now()}.md`;

    (ds.worker as any).emit('message', {
      type: 'adopt_preamble',
      userText: 'show file',
      assistantText: `[file](${missing})`,
      turnId: 'turn-adopt',
    });
    await Promise.resolve();

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain(`[file](/${missing})`);
  });

  it('always delivers the answer as a fresh message (never PATCHes a card in place)', async () => {
    // The placeholder pending-card + its PATCH delivery were removed entirely
    // (message.patch is silent — no Feishu notification/unread). The bridge
    // final-output now unconditionally goes out as a brand-new reply.
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.quoteTargetId = 'om_user';

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(updateMessageMock).not.toHaveBeenCalled();
    // Turn reactions are driven off message acceptance (noteTurnReceived) and
    // the idle edge (finishTurnReactions), not the bridge final-output path.
    expect(addReactionMock).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('locks explicit VC IM fallback output and replies to its exact Lark message with one UUID', async () => {
    const sessionReply = vi.fn(async () => 'om_vc_fallback');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-im',
      memberId: 'member-im', memberEpoch: 1,
    };
    const origin = {
      listenerAppId: 'listener-app', meetingId: 'meeting-im', memberId: 'member-im',
      memberEpoch: 1, agentAppId: 'app_test', ownerBootId: 'owner-boot', ownerEpoch: 1,
      membershipGeneration: 1, sinkOwnerGeneration: 1,
      receiverSessionId: ds.session.sessionId, larkMessageId: 'om_human_a',
      replyTargetSenderOpenId: 'ou_human_a',
    };
    expect(applyVcMeetingMemberProjection(config.session.dataDir, {
      listenerAppId: origin.listenerAppId,
      meetingId: origin.meetingId,
      memberId: origin.memberId,
      memberEpoch: origin.memberEpoch,
      agentAppId: origin.agentAppId,
      ownerBootId: origin.ownerBootId,
      ownerEpoch: origin.ownerEpoch,
      role: 'minutes',
      membershipGeneration: origin.membershipGeneration,
      status: 'active',
      responseMode: 'silent',
      capabilities: ['meeting.read'],
      ownedSinks: [],
      sinkOwnerGeneration: origin.sinkOwnerGeneration,
      joinedAtIngestSeq: 0,
      receiverSessionId: origin.receiverSessionId,
      outputChatId: ds.chatId,
    })).toMatchObject({ ok: true });
    ds.session.vcMeetingImTurnOrigins = { om_human_a: origin };
    const msg = {
      ...finalOutputMsg(),
      content: 'safe body <at id="ou_injected">Injected</at>',
      turnId: 'om_human_a',
      lastUuid: 'bridge-a',
    };
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;

    __testOnly_deliverFinalOutput(ds, msg, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][4]).toBe('om_human_a');
    expect(sessionReply.mock.calls[0][5]).toMatchObject({
      quoteMessageId: 'om_human_a',
      uuid: expect.stringMatching(/^vcp_[0-9a-f]+$/),
      sourceSessionId: ds.session.sessionId,
      suppressHook: true,
    });
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).not.toContain('ou_human_a');
    expect(cardJson).not.toContain('<at');
    expect(cardJson).toContain('＜at');
    const providerUuid = sessionReply.mock.calls[0][5].uuid;
    expect(listVcMeetingListenerMessageIds(config.session.dataDir, {
      listenerAppId: origin.listenerAppId,
      meetingId: origin.meetingId,
      targetChatId: ds.chatId,
    })).toEqual(['om_vc_fallback']);

    // A daemon/worker replay sees the terminal ledger and performs no second
    // provider call. A changed replay is also suppressed: first output wins.
    __testOnly_deliverFinalOutput(ds, { ...msg, lastUuid: 'bridge-replay' }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    __testOnly_deliverFinalOutput(ds, {
      ...msg,
      content: 'changed fallback answer',
      lastUuid: 'bridge-changed',
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(providerUuid).toBeTruthy();
  });

  it('unwraps a stale automatic meeting envelope before replying to a human listener-chat question', async () => {
    const sessionReply = vi.fn(async () => 'om_vc_direct_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-im-envelope',
      memberId: 'member-im-envelope', memberEpoch: 1,
    };
    const origin = {
      listenerAppId: 'listener-app', meetingId: 'meeting-im-envelope', memberId: 'member-im-envelope',
      memberEpoch: 1, agentAppId: 'app_test', ownerBootId: 'owner-boot', ownerEpoch: 1,
      membershipGeneration: 1, sinkOwnerGeneration: 1,
      receiverSessionId: ds.session.sessionId, larkMessageId: 'om_human_envelope',
    };
    expect(applyVcMeetingMemberProjection(config.session.dataDir, {
      listenerAppId: origin.listenerAppId,
      meetingId: origin.meetingId,
      memberId: origin.memberId,
      memberEpoch: origin.memberEpoch,
      agentAppId: origin.agentAppId,
      ownerBootId: origin.ownerBootId,
      ownerEpoch: origin.ownerEpoch,
      role: 'minutes',
      membershipGeneration: origin.membershipGeneration,
      status: 'active',
      responseMode: 'silent',
      capabilities: ['meeting.read'],
      ownedSinks: [],
      sinkOwnerGeneration: origin.sinkOwnerGeneration,
      joinedAtIngestSeq: 0,
      receiverSessionId: origin.receiverSessionId,
      outputChatId: ds.chatId,
    })).toMatchObject({ ok: true });
    ds.session.vcMeetingImTurnOrigins = { om_human_envelope: origin };
    const msg = {
      ...finalOutputMsg(),
      content: JSON.stringify({
        decision: 'publish',
        content: '请根据当前已启用的能力处理会议相关请求。',
      }),
      turnId: 'om_human_envelope',
      lastUuid: 'bridge-human-envelope',
    };
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;

    __testOnly_deliverFinalOutput(ds, msg, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain('请根据当前已启用的能力处理会议相关请求。');
    expect(cardJson).not.toContain('&quot;decision&quot;');
    expect(cardJson).not.toContain('publish');
    expect(sessionReply.mock.calls[0][5]).toMatchObject({
      quoteMessageId: 'om_human_envelope',
    });
  });

  it('blocks the plain fallback when VC IM authority expires during a withdrawn quote request', async () => {
    let plainFallbackCalls = 0;
    const sessionReply = vi.fn(async (...args: any[]) => {
      const opts = args[5] as {
        beforeQuoteFallback?: () => void | Promise<void>;
      } | undefined;
      // Model the exact daemon sequence: the quote RPC was already in flight,
      // then the member was removed before Lark answered "withdrawn".
      expect(applyVcMeetingMemberProjection(config.session.dataDir, {
        listenerAppId: 'listener-app', meetingId: 'meeting-im-race',
        memberId: 'member-im-race', memberEpoch: 1,
        agentAppId: 'app_test', ownerBootId: 'owner-boot', ownerEpoch: 1,
        role: 'minutes', membershipGeneration: 2, status: 'removed',
        responseMode: 'silent', capabilities: ['meeting.read'], ownedSinks: [],
        sinkOwnerGeneration: 1, joinedAtIngestSeq: 0,
        receiverSessionId: 'sid-final-out', outputChatId: 'oc_chat',
      })).toMatchObject({ ok: true });
      await opts?.beforeQuoteFallback?.();
      plainFallbackCalls += 1;
      return 'om_forbidden_fallback';
    });
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-im-race',
      memberId: 'member-im-race', memberEpoch: 1,
    };
    const origin = {
      listenerAppId: 'listener-app', meetingId: 'meeting-im-race',
      memberId: 'member-im-race', memberEpoch: 1,
      agentAppId: 'app_test', ownerBootId: 'owner-boot', ownerEpoch: 1,
      membershipGeneration: 1, sinkOwnerGeneration: 1,
      receiverSessionId: ds.session.sessionId, larkMessageId: 'om_human_race',
    };
    expect(applyVcMeetingMemberProjection(config.session.dataDir, {
      ...origin,
      role: 'minutes', status: 'active', responseMode: 'silent',
      capabilities: ['meeting.read'], ownedSinks: [], joinedAtIngestSeq: 0,
      outputChatId: ds.chatId,
    })).toMatchObject({ ok: true });
    ds.session.vcMeetingImTurnOrigins = { om_human_race: origin };

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      turnId: 'om_human_race',
      lastUuid: 'bridge-race',
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(plainFallbackCalls).toBe(0);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
    const actions = listVcMeetingActions(config.session.dataDir, {
      listenerAppId: origin.listenerAppId,
      meetingId: origin.meetingId,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: 'attempting', attemptCount: 1 });
    expect(actions[0]).not.toHaveProperty('externalRefs.messageId');
  });

  it('indexes a successful ordinary meeting-delivery fallback output', async () => {
    const sessionReply = vi.fn(async () => 'om_meeting_fallback');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
    };
    seedReceiverReceipt('listener_thread');
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...listenerFinalOutputMsg(),
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][1]).toContain('final answer');
    expect(sessionReply.mock.calls[0][1]).not.toContain('decision');
    expect(sessionReply.mock.calls[0][1]).not.toContain('botmux_skill_feedback');
    expect(sessionReply.mock.calls[0][5]).toMatchObject({
      uuid: expect.stringMatching(/^vcp_[0-9a-f]+$/),
      sourceSessionId: ds.session.sessionId,
      suppressHook: true,
    });
    expect(listVcMeetingListenerMessageIds(config.session.dataDir, {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      targetChatId: ds.chatId,
    })).toEqual(['om_meeting_fallback']);
    const { getSkillFeedbackStore } = await import('../src/services/skill-feedback-store.js');
    expect((await getSkillFeedbackStore(config.session.dataDir)).findDeliveryByPlatformMessage(
      'lark', ds.larkAppId, 'om_meeting_fallback',
    )).toBeUndefined();
  });

  it('delivers a listener-thread result when the receiver uses its dedicated active-session key', async () => {
    const sessionReply = vi.fn(async () => 'om_vc_receiver_fallback');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      memberId: 'member-1',
      memberEpoch: 1,
    };
    seedReceiverReceipt('listener_thread');
    setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...listenerFinalOutputMsg(),
      sessionId: ds.session.sessionId,
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(listVcMeetingListenerMessageIds(config.session.dataDir, {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      targetChatId: ds.chatId,
    })).toEqual(['om_vc_receiver_fallback']);
  });

  it('treats a valid skip decision as a successful no-message outcome', async () => {
    const sessionReply = vi.fn(async () => 'om_forbidden');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
    };
    seedReceiverReceipt('listener_thread');
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...listenerFinalOutputMsg(),
      content: '{"decision":"skip"}',
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
    expect(listVcMeetingActions(config.session.dataDir, {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
    })).toEqual([]);
  });

  it('fails closed on a malformed automatic listener control envelope', async () => {
    const sessionReply = vi.fn(async () => 'om_forbidden');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
    };
    seedReceiverReceipt('listener_thread');
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      content: '暂无重要更新',
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(listVcMeetingListenerMessageIds(config.session.dataDir, {
      listenerAppId: 'listener-app', meetingId: 'meeting-1', targetChatId: ds.chatId,
    })).toEqual([]);
  });

  it('reuses one provider UUID when a listener reply is accepted before crash reconciliation', async () => {
    const providerMessages = new Map<string, string>();
    let crashAfterFirstAccept = true;
    const sessionReply = vi.fn(async (...args: any[]) => {
      const uuid = args[5]?.uuid as string;
      expect(uuid).toMatch(/^vcp_[0-9a-f]+$/);
      const messageId = providerMessages.get(uuid) ?? 'om_provider_once';
      providerMessages.set(uuid, messageId);
      if (crashAfterFirstAccept) {
        crashAfterFirstAccept = false;
        throw new Error('simulated daemon crash after provider accepted UUID');
      }
      return messageId;
    });
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
    };
    seedReceiverReceipt('listener_thread');
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    const first = {
      ...listenerFinalOutputMsg(),
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
      lastUuid: 'bridge-attempt-1',
    };
    __testOnly_deliverFinalOutput(ds, first, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);

    const deliveryKey = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
      deliveryKey: 'delivery-stable-key',
    };
    expect(markVcMeetingDeliveryAmbiguous(config.session.dataDir, deliveryKey, {
      workerGeneration: 1,
      dispatchAttempt: 1,
    })).toMatchObject({ ok: true, receipt: { status: 'ambiguous' } });
    expect(markVcMeetingDeliveryDispatched(config.session.dataDir, deliveryKey, {
      receiverBootId: 'receiver-boot-2',
      workerGeneration: 2,
    })).toMatchObject({ ok: true, receipt: { dispatchAttempt: 2 } });

    __testOnly_deliverFinalOutput(ds, {
      ...first,
      content: JSON.stringify({
        decision: 'publish',
        content: 'changed replay answer must not create another effect',
      }),
      dispatchAttempt: 2,
      lastUuid: 'bridge-attempt-2',
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(2);
    const firstUuid = sessionReply.mock.calls[0][5].uuid;
    expect(sessionReply.mock.calls[1][5].uuid).toBe(firstUuid);
    expect(sessionReply.mock.calls[0][5]).toMatchObject({ suppressHook: true });
    expect(sessionReply.mock.calls[1][5]).toMatchObject({ suppressHook: true });
    expect(providerMessages).toEqual(new Map([[firstUuid, 'om_provider_once']]));
    expect(listVcMeetingActions(config.session.dataDir, {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
    })).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        providerKey: firstUuid,
        externalRefs: { messageId: 'om_provider_once' },
      }),
    ]);
  });

  it('does not emit a delayed final output after the delivery failed terminally', async () => {
    const sessionReply = vi.fn(async () => 'om_forbidden_output');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
    };
    seedReceiverReceipt('listener_thread');
    expect(failVcMeetingDelivery(config.session.dataDir, {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
      deliveryKey: 'delivery-stable-key',
    }, {
      kind: 'terminal',
      workerGeneration: 1,
      dispatchAttempt: 1,
      errorCode: 'turn_cancelled',
      pauseStream: true,
    })).toMatchObject({ ok: true, receipt: { status: 'failed_terminal' } });

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(listVcMeetingListenerMessageIds(config.session.dataDir, {
      listenerAppId: 'listener-app', meetingId: 'meeting-1', targetChatId: ds.chatId,
    })).toEqual([]);
  });

  it('recovers a doc-comment destination from persisted per-turn state after restart', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.scope = 'chat';
    ds.chatId = 'doc:doc-token';
    ds.session.scope = 'chat';
    ds.session.chatId = 'doc:doc-token';
    ds.session.docCommentTargets = {
      'turn-1': {
        fileToken: 'doc-token',
        fileType: 'docx',
        commentId: 'comment-1',
        turnId: 'turn-1',
        replyId: 'reply-1',
        reactionId: 'reaction-1',
      },
    };

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(replyToDocCommentMock).toHaveBeenCalledTimes(1);
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.session.docCommentTargets).toBeUndefined();
    expect(removeCommentReactionMock).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('consumes doc-comment turn state after posting even when reaction cleanup fails', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    removeCommentReactionMock.mockRejectedValueOnce(new Error('reaction already gone'));

    const ds = makeDs();
    const target = {
      fileToken: 'doc-token',
      fileType: 'docx',
      commentId: 'comment-1',
      replyId: 'reply-1',
      reactionId: 'reaction-1',
    };
    ds.docCommentTurns = new Map([['turn-1', target]]);
    ds.session.docCommentTargets = {
      'turn-1': { ...target, turnId: 'turn-1' },
    };

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(replyToDocCommentMock).toHaveBeenCalledTimes(1);
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.docCommentTurns).toBeUndefined();
    expect(ds.session.docCommentTargets).toBeUndefined();
    expect(updateSessionMock).toHaveBeenCalledWith(ds.session);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('never posts a fallback card for a doc-native session without a safe comment target', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.scope = 'chat';
    ds.chatId = 'doc:doc-token';
    ds.session.scope = 'chat';
    ds.session.chatId = 'doc:doc-token';

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(replyToDocCommentMock).not.toHaveBeenCalled();
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('retries on transient failure and commits after success', async () => {
    const sessionReply = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockRejectedValueOnce(new Error('transient 2'))
      .mockResolvedValueOnce('om_reply');
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    // Attempt 1 (delay 0)
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();

    // Attempt 2 (delay 5000)
    await vi.advanceTimersByTimeAsync(5000);
    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();

    // Attempt 3 (delay 15000)
    await vi.advanceTimersByTimeAsync(15000);
    expect(sessionReply).toHaveBeenCalledTimes(3);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
    expect(getSessionUsageSnapshot).toHaveBeenCalledTimes(1);
    expect(getSessionUsageSnapshot).toHaveBeenCalledWith({
      cliId: 'claude-code',
      sessionId: 'sid-final-out',
      cliSessionId: 'claude-session-xyz',
      cwd: '/tmp',
      larkAppId: 'app_test',
      fresh: true,
    });
    const cards = sessionReply.mock.calls.map(call => call[1] as string);
    expect(new Set(cards)).toHaveLength(1);
    expect(cards[0]).toContain('上下文 12.3K/100K (12%)');
    // Reply-card footer is context-only now; the cumulative token line is not
    // rendered here (it lives on the live streaming card).
    expect(cards[0]).not.toContain('Token ↑');
  });

  it('keeps a stable Lark uuid across ordinary final_output retries so an ambiguous first attempt cannot duplicate the answer', async () => {
    // Regression (duplicate-reply incident): the daemon retries final_output
    // delivery up to 3 times on transient failure. The ordinary (non-VC,
    // non-Codex-App) path used to carry NO Lark `uuid`, so an ambiguous first
    // attempt — the server accepted the reply but the client saw a network
    // error — created a brand-new copy on each retry. With 3 attempts the
    // user saw the same answer up to 3 times. Every retry must now carry one
    // stable uuid so the Feishu server (uuid field, 1h idempotent TTL)
    // collapses retries into the original message.
    const sessionReply = vi
      .fn()
      .mockRejectedValueOnce(new Error('ambiguous: server accepted, response lost'))
      .mockResolvedValueOnce('om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    // Attempt 1 (delay 0) — ambiguous failure.
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    // Attempt 2 (delay 5000) — success, carrying the SAME uuid as attempt 1.
    await vi.advanceTimersByTimeAsync(5000);
    expect(sessionReply).toHaveBeenCalledTimes(2);

    const firstOpts = sessionReply.mock.calls[0][5] as { uuid?: string } | undefined;
    const secondOpts = sessionReply.mock.calls[1][5] as { uuid?: string } | undefined;
    expect(firstOpts?.uuid).toMatch(/^bf_[0-9a-f]{46}$/);
    expect(secondOpts?.uuid).toBe(firstOpts!.uuid);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('derives a distinct Lark uuid per ordinary turn so different answers are never collapsed', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    __testOnly_deliverFinalOutput(
      ds,
      { ...finalOutputMsg(), lastUuid: 'uuid-2', turnId: 'turn-2' },
      'tag',
      0,
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(2);
    const firstUuid = (sessionReply.mock.calls[0][5] as { uuid?: string }).uuid;
    const secondUuid = (sessionReply.mock.calls[1][5] as { uuid?: string }).uuid;
    expect(firstUuid).toMatch(/^bf_[0-9a-f]{46}$/);
    expect(secondUuid).toMatch(/^bf_[0-9a-f]{46}$/);
    expect(secondUuid).not.toBe(firstUuid);
  });

  it('reads a sandboxed Claude transcript through the daemon reply-card boundary', async () => {
    const actualCostCalculator =
      await vi.importActual<typeof import('../src/core/cost-calculator.js')>(
        '../src/core/cost-calculator.js',
      );
    vi.mocked(getSessionUsageSnapshot)
      .mockImplementationOnce(actualCostCalculator.getSessionUsageSnapshot);

    const sandboxRoot = mkdtempSync(join(tmpdir(), 'botmux-card-usage-sandbox-'));
    const previousSessionDataDir = process.env.SESSION_DATA_DIR;
    try {
      process.env.SESSION_DATA_DIR = join(sandboxRoot, 'data');
      const transcriptDir = join(
        sandboxRoot,
        'bots',
        'app_test',
        'claude',
        'projects',
        realpathSync('/tmp').replace(/[^A-Za-z0-9-]/g, '-'),
      );
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(
        join(transcriptDir, 'claude-session-xyz.jsonl'),
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-sonnet-test',
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 5,
            },
          },
        }) + '\n',
      );

      expect(getDaemonReplyCardUsageSnapshot(makeDs())).toMatchObject({
        context: { usedTokens: 115 },
        tokens: { in: 115, out: 20 },
      });
    } finally {
      if (previousSessionDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousSessionDataDir;
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it('reads a sandboxed Codex rollout through the daemon reply-card boundary', async () => {
    const actualCostCalculator =
      await vi.importActual<typeof import('../src/core/cost-calculator.js')>(
        '../src/core/cost-calculator.js',
      );
    vi.mocked(getSessionUsageSnapshot)
      .mockImplementationOnce(actualCostCalculator.getSessionUsageSnapshot);

    const sandboxRoot = mkdtempSync(join(tmpdir(), 'botmux-card-usage-codex-'));
    const previousSessionDataDir = process.env.SESSION_DATA_DIR;
    const codexSid = '019dd80d-d922-7a11-8339-0208d8c5b4ef';
    try {
      process.env.SESSION_DATA_DIR = join(sandboxRoot, 'data');
      const rolloutDir = join(
        sandboxRoot,
        'bots',
        'app_test',
        'codex',
        'sessions',
        '2026',
        '07',
        '29',
      );
      mkdirSync(rolloutDir, { recursive: true });
      writeFileSync(
        join(rolloutDir, `rollout-2026-07-29T12-00-00-${codexSid}.jsonl`),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 1_000,
                cached_input_tokens: 400,
                output_tokens: 50,
              },
              last_token_usage: { total_tokens: 250 },
              model_context_window: 2_000,
            },
          },
        }) + '\n',
      );
      const ds = makeDs();
      ds.session.cliId = 'codex';
      ds.session.cliSessionId = codexSid;

      expect(getDaemonReplyCardUsageSnapshot(ds)).toMatchObject({
        context: { usedTokens: 250, windowTokens: 2_000, percentUsed: 13 },
        tokens: { in: 1_000, out: 50 },
      });
    } finally {
      if (previousSessionDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousSessionDataDir;
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it('does not read or render footer usage when this bot is not in footer mode', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    // Default streaming (or off) → the reply-card footer must not carry usage,
    // and the gate must short-circuit before touching the transcript reader.
    vi.mocked(resolveUsageDisplay).mockReturnValue('off');

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(getSessionUsageSnapshot).not.toHaveBeenCalled();
    const card = sessionReply.mock.calls[0]?.[1] as string;
    expect(card).toContain('[botmux](');
    expect(card).not.toContain('上下文');
    expect(card).not.toContain('Token');
  });

  it('gives up after 3 attempts and does NOT commit dedup', async () => {
    const sessionReply = vi.fn().mockRejectedValue(new Error('persistent'));
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(15000);

    expect(sessionReply).toHaveBeenCalledTimes(3);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('treats a Lark content-audit rejection as permanent: no retries, visible notice, settled', async () => {
    const auditError = {
      isAxiosError: true,
      name: 'AxiosError',
      message: 'Request failed with status code 400',
      config: { method: 'post', url: 'https://open.feishu.cn/open-apis/im/v1/messages' },
      response: { status: 400, data: { code: 230028, msg: 'contain sensitive data: EMAIL_ADDRESS' } },
    };
    // Primary reply is audit-rejected; the follow-up notice (same reply channel) succeeds.
    const sessionReply = vi
      .fn()
      .mockRejectedValueOnce(auditError)
      .mockResolvedValueOnce('om_notice');
    const closeSession = vi.fn();
    const complete = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    // Use PRODUCTION-LENGTH ids: randomUUID sessionId (36) + om_ turnId (~35).
    // Naive concatenation would build an 80+ char dedupe uuid, which Feishu
    // hard-rejects at 50 — defeating this very notice. The fixture's short ids
    // (sid-final-out/turn-1) hid that in the first iteration.
    ds.session.sessionId = '01234567-89ab-4def-8234-56789abcdef0';
    const productionMsg = { ...finalOutputMsg(), turnId: 'om_x100b63519db838a4b32f' };
    vi.mocked(emitSessionLifecycleHook).mockClear();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, productionMsg, 'tag', 0, complete);

    await vi.advanceTimersByTimeAsync(0);
    // Even after the full backoff window elapses, attempts stay at 2:
    // rejected primary + one audit notice, never a same-payload retry.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(15000);
    expect(sessionReply).toHaveBeenCalledTimes(2);

    // The second call is the audit-safe notice (plain text), carrying the code
    // and a dedup uuid that respects Feishu's 50-char hard cap — never the
    // rejected answer body.
    const noticeCall = sessionReply.mock.calls[1];
    expect(noticeCall[2]).toBe('text');
    expect(String(noticeCall[1])).toContain('230028');
    expect(String(noticeCall[1])).not.toContain('final answer');
    const noticeUuid = noticeCall[5].uuid as string;
    expect(noticeUuid.startsWith('ab_')).toBe(true);
    expect(noticeUuid.length).toBe(50);

    // The turn settles (identical retransmits cannot pass the audit) and the
    // dashboard attention row is lit.
    expect(ds.lastBridgeEmittedUuid).toBe('01234567-89ab-4def-8234-56789abcdef0:uuid-1');
    expect(complete).toHaveBeenCalledWith(true);
    expect(ds.agentAttention).toMatchObject({ kind: 'blocked' });
    // External lifecycle channel must see the block, matching the
    // TOPIC_SEND_BLOCKED branch (operators may route on session.requires_attention).
    expect(emitSessionLifecycleHook).toHaveBeenCalledWith(
      ds,
      'session.requires_attention',
      expect.objectContaining({ reason: 'content_audit_blocked', turnId: productionMsg.turnId }),
    );
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('MessageWithdrawnError aborts retries, commits dedup, and closes session', async () => {
    const sessionReply = vi.fn().mockRejectedValue(new MessageWithdrawnError('om_root'));
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const worker = ds.worker as any;
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(0);

    // Single attempt, no further retries
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
    expect(closeSession).toHaveBeenCalledWith(ds);
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'close' });
    expect(worker.kill).not.toHaveBeenCalled();
  });

  it('preserves an unsettled Codex FIFO owner when the root is withdrawn', async () => {
    const sessionReply = vi.fn().mockRejectedValue(new MessageWithdrawnError('om_root'));
    const closeSession = vi.fn();
    const complete = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });
    const ds = makeDs();
    ds.session.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-pending',
      turnId: 'turn-1',
      state: 'prepared',
      content: 'pending answer',
    }];
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0, complete);
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionReply).toHaveBeenCalledOnce();
    expect(closeSession).not.toHaveBeenCalled();
    expect((ds.worker as any).kill).not.toHaveBeenCalled();
    expect(ds.session.codexAppDispatchLedger).toHaveLength(1);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
    expect(complete).toHaveBeenCalledWith(false);
  });

  it('aborts pending retry if the session was closed in the meantime', async () => {
    const sessionReply = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockResolvedValueOnce('om_reply');  // would succeed if a 2nd attempt fired
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    // Attempt 1 fails
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionReply).toHaveBeenCalledTimes(1);

    // User closes the session before the 5s retry fires
    ds.session.status = 'closed' as any;

    // Backoff fires — must NOT call sessionReply again
    await vi.advanceTimersByTimeAsync(5000);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });
});

describe('Worker turn_terminal routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes a matching terminal receipt independently of final_output', async () => {
    const ds = makeDs();
    const onTurnTerminal = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    const terminal: Extract<WorkerToDaemon, { type: 'turn_terminal' }> = {
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'delivery-stable-key',
      status: 'completed',
    };
    (ds.worker as any).emit('message', terminal);
    await Promise.resolve();

    expect(onTurnTerminal).toHaveBeenCalledTimes(1);
    expect(onTurnTerminal).toHaveBeenCalledWith(ds, terminal, { workerGeneration: 1 });
  });

  it('captures silent fallback output and keeps the bounded legacy marker after terminal', async () => {
    const ds = makeDs();
    ds.suppressedFinalOutputTurns = new Map([['delivery-stable-key', 1]]);
    const sessionReply = vi.fn(async () => 'om_reply');
    const onTurnTerminal = vi.fn(async () => {});
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output',
      sessionId: ds.session.sessionId,
      content: 'analysis that must stay silent',
      lastUuid: 'assistant-uuid',
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.suppressedFinalOutputTurns.has('delivery-stable-key')).toBe(true);

    (ds.worker as any).emit('message', {
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
      status: 'completed',
    } satisfies Extract<WorkerToDaemon, { type: 'turn_terminal' }>);
    await Promise.resolve();

    expect(onTurnTerminal).toHaveBeenCalledTimes(1);
    expect(ds.suppressedFinalOutputTurns.has('delivery-stable-key')).toBe(true);
  });

  it('keeps an overlapping silent schedule exact while a queued normal turn stays loud', async () => {
    const ds = makeDs();
    ds.silentScheduledTurns = new Map([['schedule-turn', Date.now()]]);
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'ready', port: 4567, token: 'token', turnId: 'schedule-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'ready' }>);
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'silent progress', status: 'working', turnId: 'schedule-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'screen_update' }>);
    (ds.worker as any).emit('message', {
      type: 'tui_prompt', description: 'silent approval',
      options: [{ text: 'allow', selected: false }], turnId: 'schedule-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'tui_prompt' }>);
    (ds.worker as any).emit('message', {
      type: 'user_notify', message: 'silent warning', turnId: 'schedule-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'user_notify' }>);
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'silent automatic answer', lastUuid: 'silent-uuid', turnId: 'schedule-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    (ds.worker as any).emit('message', {
      type: 'error', message: 'silent startup failure', turnId: 'schedule-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'error' }>);
    await Promise.resolve();
    expect(sessionReply).not.toHaveBeenCalled();

    (ds.worker as any).emit('message', {
      type: 'user_notify', message: 'normal warning', turnId: 'normal-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'user_notify' }>);
    await Promise.resolve();
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][1]).toBe('normal warning');
    expect(sessionReply.mock.calls[0][4]).toBe('normal-turn');

    (ds.worker as any).emit('message', {
      type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'schedule-turn', status: 'completed',
    } satisfies Extract<WorkerToDaemon, { type: 'turn_terminal' }>);
    await Promise.resolve();
    expect(ds.silentScheduledTurns?.has('schedule-turn')).toBe(true);

    // A trailing event after terminal is still tied to the silent turn.
    (ds.worker as any).emit('message', {
      type: 'user_notify', message: 'late silent warning', turnId: 'schedule-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'user_notify' }>);
    await Promise.resolve();
    expect(sessionReply).toHaveBeenCalledTimes(1);
  });

  it.each(['running', 'completed'] as const)('restores a %s silent recovery before handling trailing output', async (status) => {
    const ds = makeDs();
    ds.adoptedFrom = undefined;
    const logicalTurnId = 'schedule:abcdef12:11111111-2222-3333-4444-555555555555';
    const turnId = 'schedule:abcdef12:22222222-2222-3333-4444-555555555555';
    ds.session.ordinaryTurnRecovery = {
      logicalTurnId, currentTurnId: turnId, continuationsStarted: 1,
      status, silentLogicalTurnIds: [logicalTurnId],
    };
    vi.mocked(getBot).mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot',
    } as any);
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    expect(ds.silentScheduledTurns).toBeUndefined();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // A terminal can be persisted before the trailing bridge output arrives.
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId, turnId,
      content: 'late silent answer', lastUuid: `silent-restored-${status}`,
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    (ds.worker as any).emit('message', {
      type: 'user_notify', message: 'late silent notice', turnId,
    } satisfies Extract<WorkerToDaemon, { type: 'user_notify' }>);
    await Promise.resolve();
    expect(sessionReply).not.toHaveBeenCalled();

    (ds.worker as any).emit('message', {
      type: 'user_notify', message: 'ordinary notice', turnId: 'om_normal_after_restart',
    } satisfies Extract<WorkerToDaemon, { type: 'user_notify' }>);
    await Promise.resolve();
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][1]).toBe('ordinary notice');
  });

  it('keeps an internal receipt private after human interruption while preserving progress and later replies', async () => {
    const ds = makeDs();
    ds.suppressedTriggerFinalTurns = new Map([['trg_background', Date.now()]]);
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    const emit = (msg: WorkerToDaemon) => (ds.worker as any).emit('message', msg);

    emit({ type: 'active_turn_envelope_changed', previousTurnId: 'trg_background', turnId: 'om_human_update' });
    emit({ type: 'active_turn_envelope_changed', previousTurnId: 'om_human_update', turnId: 'om_second_update' });
    const receipt = 'TASK_RESULT {"status":"completed"}';
    emit({ type: 'final_output', sessionId: ds.session.sessionId,
      content: receipt, lastUuid: 'private-receipt', turnId: 'om_second_update' });
    await Promise.resolve();
    expect(sessionReply).not.toHaveBeenCalled();

    emit({ type: 'user_notify', message: 'Background task completed', turnId: 'om_second_update' });
    await Promise.resolve();
    expect(sessionReply).toHaveBeenCalledTimes(1);
    emit({ type: 'final_output', sessionId: ds.session.sessionId,
      content: 'Answer to a later question', lastUuid: 'later-answer', turnId: 'om_later_question' });
    await vi.waitFor(() => expect(sessionReply).toHaveBeenCalledTimes(2));
    expect(sessionReply.mock.calls[1][1]).toContain('Answer to a later question');
    expect(sessionReply.mock.calls.some(call => String(call[1]).includes('TASK_RESULT'))).toBe(false);
  });

  it('drops only the final_output of a suppressed trigger turn while other turns and its aux UI stay loud', async () => {
    const ds = makeDs();
    // A loud connector opted into suppressFinalOutput; trigger-session armed this
    // exact turn id (parallel to silentScheduledTurns but final-only).
    ds.suppressedTriggerFinalTurns = new Map([['trg_alert', Date.now()]]);
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // The suppressed turn's final_output must be dropped …
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'trigger summary that must not be posted', lastUuid: 'trg-uuid', turnId: 'trg_alert',
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await Promise.resolve();
    expect(sessionReply).not.toHaveBeenCalled();

    // … but its auxiliary UI (user_notify/streaming) is NOT suppressed: unlike
    // schedule-silent, trigger suppression only gates final_output, so the live
    // status/notify channel still reaches the topic.
    (ds.worker as any).emit('message', {
      type: 'user_notify', message: 'trigger warning still shows', turnId: 'trg_alert',
    } satisfies Extract<WorkerToDaemon, { type: 'user_notify' }>);
    await Promise.resolve();
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][1]).toBe('trigger warning still shows');

    // … and an unrelated turn on the same session keeps its final_output loud.
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: 'human turn answer', lastUuid: 'human-uuid', turnId: 'other-turn',
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await new Promise(r => setTimeout(r, 10));
    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(sessionReply.mock.calls[1][1]).toContain('human turn answer');
    expect(sessionReply.mock.calls[1][4]).toBe('other-turn');
  });

  it.each([
    { silent: false, notice: 'Model service refused this turn', expected: 1 },
    { silent: true, notice: 'Model service refused this turn', expected: 0 },
    { silent: false, notice: undefined, expected: 0 },
  ])('handles suppressed trigger failure diagnostics without leaking partial text: %j', async ({ silent, notice, expected }) => {
    const ds = makeDs();
    ds.suppressedTriggerFinalTurns = new Map([['trg_failed', Date.now()]]);
    if (silent) ds.silentScheduledTurns = new Map([['trg_failed', Date.now()]]);
    const sessionReply = vi.fn(async () => 'om_failure');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    const output: Extract<WorkerToDaemon, { type: 'final_output' }> = {
      type: 'final_output', sessionId: ds.session.sessionId,
      turnId: 'trg_failed', lastUuid: 'failed-uuid',
      content: 'INTERNAL_PARTIAL_RECEIPT\nModel service refused this turn',
      turnFailed: true, turnFailureNotice: notice,
    };
    (ds.worker as any).emit('message', output);
    await new Promise(r => setTimeout(r, 10));
    expect(sessionReply).toHaveBeenCalledTimes(expected);
    if (expected) {
      expect(sessionReply.mock.calls[0][1]).toContain(notice);
      expect(sessionReply.mock.calls[0][1]).not.toContain('INTERNAL_PARTIAL_RECEIPT');
      (ds.worker as any).emit('message', output);
      await new Promise(r => setTimeout(r, 10));
      expect(sessionReply).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps a newer silent retry armed when stale output and terminal arrive first', async () => {
    const ds = makeDs();
    ds.suppressedFinalOutputTurns = new Map([['delivery-stable-key', 2]]);
    const sessionReply = vi.fn(async () => 'om_reply');
    const onTurnTerminal = vi.fn(async () => {});
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    const emitFinal = (dispatchAttempt: number, content: string) => {
      (ds.worker as any).emit('message', {
        type: 'final_output',
        sessionId: ds.session.sessionId,
        content,
        lastUuid: `assistant-uuid-${dispatchAttempt}`,
        turnId: 'delivery-stable-key',
        dispatchAttempt,
      } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    };
    const emitTerminal = (dispatchAttempt: number) => {
      (ds.worker as any).emit('message', {
        type: 'turn_terminal',
        sessionId: ds.session.sessionId,
        turnId: 'delivery-stable-key',
        dispatchAttempt,
        status: 'completed',
      } satisfies Extract<WorkerToDaemon, { type: 'turn_terminal' }>);
    };

    emitFinal(1, 'stale attempt output must stay silent');
    emitTerminal(1);
    await Promise.resolve();

    expect(sessionReply).not.toHaveBeenCalled();
    expect(onTurnTerminal).toHaveBeenCalledTimes(1);
    expect(ds.suppressedFinalOutputTurns.get('delivery-stable-key')).toBe(2);

    emitFinal(2, 'current attempt output must stay silent');
    emitTerminal(2);
    await Promise.resolve();

    expect(sessionReply).not.toHaveBeenCalled();
    expect(onTurnTerminal).toHaveBeenCalledTimes(2);
    expect(ds.suppressedFinalOutputTurns.get('delivery-stable-key')).toBe(2);
  });

  it('suppresses non-final streaming, TUI, and diagnostic UI for a listener_thread receiver', async () => {
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      memberId: 'member-1',
      memberEpoch: 1,
    };
    ds.suppressedFinalOutputTurns = new Map([['delivery-stable-key', 1]]);
    seedReceiverReceipt('listener_thread');
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal: (_ds, terminal) => {
        completeVcMeetingDelivery(config.session.dataDir, {
          listenerAppId: 'listener-app', meetingId: 'meeting-1', memberId: 'member-1', memberEpoch: 1,
          deliveryKey: terminal.turnId,
        }, { workerGeneration: 1, dispatchAttempt: terminal.dispatchAttempt });
      },
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'ready', port: 4567, token: 'token', turnId: 'delivery-stable-key', dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'ready' }>);
    (ds.worker as any).emit('message', {
      type: 'screen_update',
      content: 'meeting transcript on screen',
      status: 'working',
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'screen_update' }>);
    (ds.worker as any).emit('message', {
      type: 'tui_prompt',
      description: 'permission needed',
      options: [{ text: 'allow', selected: false }],
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'tui_prompt' }>);
    (ds.worker as any).emit('message', {
      type: 'user_notify', message: 'submit failed', turnId: 'delivery-stable-key', dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'user_notify' }>);
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.workerPort).toBe(4567);
    expect(ds.lastScreenStatus).toBe('working');

    (ds.worker as any).emit('message', {
      type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'delivery-stable-key',
      dispatchAttempt: 1, status: 'completed',
    } satisfies Extract<WorkerToDaemon, { type: 'turn_terminal' }>);
    await Promise.resolve();
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'idle after terminal', status: 'idle',
      turnId: 'delivery-stable-key', dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'screen_update' }>);
    await Promise.resolve();
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('drops a terminal receipt from a stale or wrongly-bound worker', async () => {
    const ds = makeDs();
    const onTurnTerminal = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'turn_terminal',
      sessionId: 'sid-stale-worker',
      turnId: 'delivery-stable-key',
      status: 'completed',
    } satisfies Extract<WorkerToDaemon, { type: 'turn_terminal' }>);
    await Promise.resolve();

    expect(onTurnTerminal).not.toHaveBeenCalled();
  });

  it('reports the exact worker generation when the process exits', async () => {
    const ds = makeDs();
    const onWorkerExit = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onWorkerExit,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('exit', 17, 'SIGTERM');
    await Promise.resolve();

    expect(onWorkerExit).toHaveBeenCalledWith(ds, {
      sessionId: ds.session.sessionId,
      workerGeneration: 1,
      code: 17,
      signal: 'SIGTERM',
    });
  });

  it('reports a managed CLI exit even when the Node worker stays alive', async () => {
    const ds = makeDs();
    const onCliExit = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onCliExit,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'managed_turn_origin',
      sessionId: ds.session.sessionId,
      capability: 'live-capability',
      turnId: 'om_live',
    } satisfies Extract<WorkerToDaemon, { type: 'managed_turn_origin' }>);
    expect(ds.managedTurnOrigin).toEqual({
      capability: 'live-capability',
      turnId: 'om_live',
    });

    (ds.worker as any).emit('message', {
      type: 'claude_exit', code: 9, signal: 'SIGKILL',
    } satisfies Extract<WorkerToDaemon, { type: 'claude_exit' }>);
    await Promise.resolve();

    expect(onCliExit).toHaveBeenCalledWith(ds, {
      sessionId: ds.session.sessionId,
      workerGeneration: 1,
      code: 9,
      signal: 'SIGKILL',
    });
    expect(ds.managedTurnOrigin).toBeUndefined();
  });

  it('ignores stale-worker CLI exit authority changes after replacement', async () => {
    const ds = makeDs();
    const oldWorker = ds.worker as any;
    const replacementWorker = makeDs().worker as any;
    const onCliExit = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onCliExit,
    });
    __testOnly_setupWorkerHandlers(ds, oldWorker);
    ds.worker = replacementWorker;
    __testOnly_setupWorkerHandlers(ds, replacementWorker);

    replacementWorker.emit('message', {
      type: 'managed_turn_origin',
      sessionId: ds.session.sessionId,
      capability: 'replacement-capability',
      turnId: 'om_replacement',
    } satisfies Extract<WorkerToDaemon, { type: 'managed_turn_origin' }>);

    oldWorker.emit('message', {
      type: 'claude_exit', code: 9, signal: 'SIGKILL',
    } satisfies Extract<WorkerToDaemon, { type: 'claude_exit' }>);
    await Promise.resolve();

    expect(ds.managedTurnOrigin).toEqual({
      capability: 'replacement-capability',
      turnId: 'om_replacement',
    });
    expect(onCliExit).not.toHaveBeenCalled();
  });
});


describe('keyed turn input-commit observation', () => {
  it('records only matching live commit ACKs and leaves write failures unknown', async () => {
    const ds = makeDs();
    ds.workerGeneration = ds.session.workerGeneration = 1;
    ds.idempotentAsyncTurns = new Map([['trg_keyed', {
      ownerLarkAppId: ds.larkAppId, key: 'original-key', kind: 'turn', workerGeneration: 1,
    }]]);
    const record = vi.spyOn(registrationStore, 'recordTurnInputCommit').mockReturnValue(true);
    initWorkerPool({ sessionReply: vi.fn(async () => 'om_reply'), getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const worker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, worker, undefined, 1);
    try {
      worker.emit('message', { type: 'turn_input_received', turnId: 'trg_keyed' });
      worker.emit('message', { type: 'turn_input_committed', turnId: 'trg_other' });
      await Promise.resolve();
      expect(record).not.toHaveBeenCalled();
      worker.emit('message', { type: 'turn_input_committed', turnId: 'trg_keyed' });
      await Promise.resolve();
      expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        ownerLarkAppId: ds.larkAppId, sessionId: ds.session.sessionId, triggerId: 'trg_keyed',
        key: 'original-key', workerGeneration: 1, ownerBootId: expect.any(String),
      }));
      record.mockImplementationOnce(() => { throw new Error('disk full'); });
      worker.emit('message', { type: 'turn_input_committed', turnId: 'trg_keyed' });
      await Promise.resolve();
      expect(ds.idempotentAsyncTurns.has('trg_keyed')).toBe(true);
      ds.workerGeneration = ds.session.workerGeneration = 2;
      worker.emit('message', { type: 'turn_input_committed', turnId: 'trg_keyed' });
      await Promise.resolve();
      expect(record).toHaveBeenCalledTimes(2);
      ds.worker = new EventEmitter() as any;
      worker.emit('message', { type: 'turn_input_committed', turnId: 'trg_keyed' });
      await Promise.resolve();
      expect(record).toHaveBeenCalledTimes(2);
    } finally { record.mockRestore(); }
  });
});
