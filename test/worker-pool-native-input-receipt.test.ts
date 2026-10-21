/**
 * worker-pool: `native_input_consumed` receipt fencing.
 *
 * The receipt covers shared group background, so only the live worker
 * generation's own evidence may reach the daemon callback. A replaced or
 * stale worker's late receipt proves nothing about the replacement.
 *
 * Run: bun x vitest run --project unit test/worker-pool-native-input-receipt.test.ts
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { emitHookEventMock } = vi.hoisted(() => ({
  emitHookEventMock: vi.fn(),
}));

vi.mock('../src/services/hook-runner.js', () => ({
  emitHookEvent: (...args: unknown[]) => emitHookEventMock(...args),
}));

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return {
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    MessageWithdrawnError,
  };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{"type":"streaming"}'),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
  buildTuiPromptCard: vi.fn(() => '{"type":"tui"}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{"type":"tui-resolved"}'),
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
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  ensureSessionWhiteboard: vi.fn(),
  persistStreamCardState: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(() => ({ tokenUsage: null })),
}));

vi.mock('../src/skills/installer.js', () => ({
  ensureSkills: vi.fn(),
}));

vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: vi.fn(),
}));

vi.mock('../src/adapters/cli/claude-code.js', () => ({
  claudeJsonlPathForSession: vi.fn(),
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: class {},
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));


import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  admitQueuedActivationTail,
  forkWorker,
  initWorkerPool,
  promoteQueuedActivationTail,
  sendWorkerInput,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { config } from '../src/config.js';
import {
  writePreparedGroupContext, confirmGroupContextNativeInput,
  readGroupContextDeliveryReceipt, getDeliveredGroupContextSeqs, bindGroupContextDelivery, type PreparedGroupContext,
} from '../src/services/group-context-delivery-store.js';
import { commitGroupContextDispatchIntoPayload } from '../src/services/group-context-prompt.js';
import { groupContextEpoch } from '../src/services/group-context-prompt.js';
import { closeLinkRefRuntime, initializeLinkRefRuntime } from '../src/services/link-ref-runtime.js';
import * as sessionStore from '../src/services/session-store.js';

function makeFakeWorker() {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.pid = 4242;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return worker;
}

function makeDs(worker: any): DaemonSession {
  return {
    session: {
      sessionId: 'sid-receipt', rootMessageId: 'om_root', chatId: 'oc_chat', title: 'Receipt',
      status: 'active', createdAt: new Date('2026-10-06T00:00:00.000Z').toISOString(), chatType: 'group',
      cliId: 'claude-code', workingDir: '/repo', cliSessionId: 'native-known',
    },
    worker, workerPort: 9999, workerToken: 'tok', larkAppId: 'app_test', chatId: 'oc_chat', chatType: 'group',
    scope: 'thread', spawnedAt: 1, cliVersion: '1.0', lastMessageAt: 2, hasHistory: false, workingDir: '/repo',
    displayMode: 'hidden', streamCardId: 'om_card', streamCardNonce: 'nonce', lastScreenContent: '',
    lastScreenStatus: 'working', currentTurnTitle: 'Receipt',
  } as DaemonSession;
}

async function flush(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); }

describe('native_input_consumed fencing', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('delivers a live generation receipt with its exact generation', async () => {
    const onNativeInputConsumed = vi.fn();
    initWorkerPool({ sessionReply: vi.fn(), getSessionWorkingDir: () => '/repo', getActiveCount: () => 1, closeSession: vi.fn(), onNativeInputConsumed } as any);
    const worker = makeFakeWorker();
    const ds = makeDs(worker);
    __testOnly_setupWorkerHandlers(ds, worker);
    const receipt = { type: 'native_input_consumed', turnId: 'om_turn', proofKind: 'claude_transcript_user_record', nativeSessionId: 'native-known' };
    worker.emit('message', receipt);
    await flush();
    expect(onNativeInputConsumed).toHaveBeenCalledTimes(1);
    expect(onNativeInputConsumed).toHaveBeenCalledWith(ds, receipt, { workerGeneration: ds.session.workerGeneration });
    expect(ds.session.workerGeneration).toBeGreaterThanOrEqual(1);
  });

  it('ignores receipts from a replaced worker or a changed generation', async () => {
    const onNativeInputConsumed = vi.fn();
    initWorkerPool({ sessionReply: vi.fn(), getSessionWorkingDir: () => '/repo', getActiveCount: () => 1, closeSession: vi.fn(), onNativeInputConsumed } as any);
    const worker = makeFakeWorker();
    const ds = makeDs(worker);
    __testOnly_setupWorkerHandlers(ds, worker);
    // A replacement took over the session; the old child's late receipt is stale.
    ds.worker = makeFakeWorker();
    worker.emit('message', { type: 'native_input_consumed', turnId: 'om_turn', proofKind: 'codex_history_match' });
    await flush();
    expect(onNativeInputConsumed).not.toHaveBeenCalled();
    ds.worker = worker;
    ds.session.workerGeneration = (ds.session.workerGeneration ?? 1) + 1;
    worker.emit('message', { type: 'native_input_consumed', turnId: 'om_turn', proofKind: 'codex_history_match' });
    await flush();
    expect(onNativeInputConsumed).not.toHaveBeenCalled();
  });

  it('survives a throwing receipt handler', async () => {
    const onNativeInputConsumed = vi.fn(() => { throw new Error('store unavailable'); });
    initWorkerPool({ sessionReply: vi.fn(), getSessionWorkingDir: () => '/repo', getActiveCount: () => 1, closeSession: vi.fn(), onNativeInputConsumed } as any);
    const worker = makeFakeWorker();
    const ds = makeDs(worker);
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'native_input_consumed', turnId: 'om_turn', proofKind: 'codex_rpc_turn_start', nativeTurnId: 'nt' });
    await flush();
    expect(onNativeInputConsumed).toHaveBeenCalledTimes(1);
    expect(worker.killed).toBe(false);
  });
});

describe('group background dispatch boundary', () => {
  let dataDir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    dataDir = mkdtempSync(join(tmpdir(), 'worker-pool-dispatch-'));
    config.session.dataDir = dataDir;
    delete process.env.BOTMUX_LINK_REFS_MODE;
  });
  afterEach(() => {
    closeLinkRefRuntime();
    delete process.env.BOTMUX_LINK_REFS_MODE;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const frag = (seq: number, text: string) => `<message seq="${seq}" message_id="om_m${seq}" chat_id="oc_chat" sender_type="user" sender_id="ou_user" msg_type="text" create_time="1"><quote kind="verbatim">${text}</quote></message>`;
  const bundle = (turnId: string, epoch: string, seqs: number[]): PreparedGroupContext => {
    const sources = seqs.map(seq => ({ seq, text: frag(seq, `topic ${seq}`) }));
    return {
      appId: 'app_test', chatId: 'oc_chat', turnId, createdAt: Date.now(), epoch,
      body: `<shared_group_context trust="untrusted" through_seq="${Math.max(...seqs)}">\n<policy>p</policy>\n${sources.map(s => s.text).join('\n')}\n</shared_group_context>`,
      includedSeqs: seqs, throughSeq: Math.max(...seqs), incomplete: false, sources,
    };
  };

  it('subtracts sources covered while the turn waited, right before worker IPC, and keeps a retry identical', async () => {
    initWorkerPool({ sessionReply: vi.fn(), getSessionWorkingDir: () => '/repo', getActiveCount: () => 1, closeSession: vi.fn() } as any);
    const worker = makeFakeWorker();
    const ds = makeDs(worker);
    ds.session.workerGeneration = 1; ds.workerGeneration = 1;
    const epoch1 = groupContextEpoch('sid-receipt', 'native-known', 'claude-code', 'om_turn_1');
    const epoch2 = groupContextEpoch('sid-receipt', 'native-known', 'claude-code', 'om_turn_2');
    const frozen1 = writePreparedGroupContext(bundle('om_turn_1', epoch1, [1]), dataDir);
    const frozen = writePreparedGroupContext(bundle('om_turn_2', epoch2, [1, 2]), dataDir);
    // Turn 1 is really dispatched with its frozen background embedded.
    expect(sendWorkerInput(ds, { content: `prefix\n\n${frozen1.body}\n\n<user_message>first</user_message>` }, 'om_turn_1')).toBe(true);
    worker.send.mockClear();
    // Assembled and queued with the frozen body while turn 1 is still in flight.
    const payload = { content: `prefix\n\n${frozen.body}\n\n<user_message>next</user_message>` };
    // Turn 1's native input receipt lands before turn 2 leaves the FIFO.
    const binding1 = { appId: 'app_test', chatId: 'oc_chat', turnId: 'om_turn_1', sessionId: 'sid-receipt', epoch: epoch1, workerGeneration: 1 };
    expect(confirmGroupContextNativeInput(binding1, { kind: 'claude_transcript_user_record' }, dataDir)).toBe(true);
    expect(sendWorkerInput(ds, payload, 'om_turn_2')).toBe(true);
    const sent = worker.send.mock.calls.map((call: any[]) => call[0]).find((message: any) => message?.type === 'message');
    expect(sent.content).not.toContain('topic 1');
    expect(sent.content).toContain('topic 2');
    expect(sent.content).toContain('<user_message>next</user_message>');
    // The payload object itself (the durable queue entry) now carries the committed content.
    expect(payload.content).toBe(sent.content);
    expect(readGroupContextDeliveryReceipt('app_test', 'oc_chat', 'om_turn_2', dataDir, epoch2)?.dispatchedAt).toBeTypeOf('number');
    // A retry after more coverage (nothing new here, but the snapshot is authoritative) sends the same content.
    worker.send.mockClear();
    expect(sendWorkerInput(ds, payload, 'om_turn_2', { dispatchAttempt: 1 })).toBe(true);
    const resent = worker.send.mock.calls.map((call: any[]) => call[0]).find((message: any) => message?.type === 'message');
    expect(resent.content).toBe(sent.content);
    // The receipt for turn 2 covers exactly what was dispatched: seq 2 (seq 1 was already covered by turn 1).
    const binding2 = { appId: 'app_test', chatId: 'oc_chat', turnId: 'om_turn_2', sessionId: 'sid-receipt', epoch: epoch2, workerGeneration: 1 };
    expect(confirmGroupContextNativeInput(binding2, { kind: 'claude_transcript_user_record' }, dataDir)).toBe(true);
    expect(getDeliveredGroupContextSeqs('app_test', 'oc_chat', 'sid-receipt', epoch2, dataDir)).toEqual([1, 2]);
  });

  it('registers only URLs from the group context that actually crosses worker IPC', () => {
    process.env.BOTMUX_LINK_REFS_MODE = 'enabled';
    initializeLinkRefRuntime(dataDir);
    initWorkerPool({ sessionReply: vi.fn(), getSessionWorkingDir: () => '/repo', getActiveCount: () => 1, closeSession: vi.fn() } as any);
    const worker = makeFakeWorker();
    const ds = makeDs(worker);
    ds.session.workerGeneration = 1; ds.workerGeneration = 1;
    const droppedUrl = 'https://context.example.test/already-covered';
    const keptUrl = 'https://context.example.test/new-for-this-turn';
    const epoch1 = groupContextEpoch('sid-receipt', 'native-known', 'claude-code', 'om_turn_1');
    const turnId = 'om_turn_link_ref';
    const epoch2 = groupContextEpoch('sid-receipt', 'native-known', 'claude-code', turnId);
    const first = bundle('om_turn_1', epoch1, [1]);
    first.body = `<shared_group_context trust="untrusted" through_seq="1">\n<policy>p</policy>\n${frag(1, droppedUrl)}\n</shared_group_context>`;
    first.sources = [{ seq: 1, text: frag(1, droppedUrl) }];
    writePreparedGroupContext(first, dataDir);
    const frozen = writePreparedGroupContext({
      ...bundle(turnId, epoch2, [1, 2]),
      body: `<shared_group_context trust="untrusted" through_seq="2">\n<policy>p</policy>\n${frag(1, droppedUrl)}\n${frag(2, keptUrl)}\n</shared_group_context>`,
      sources: [
        { seq: 1, text: frag(1, droppedUrl) },
        { seq: 2, text: frag(2, keptUrl) },
      ],
    }, dataDir);
    const binding1 = { appId: 'app_test', chatId: 'oc_chat', turnId: 'om_turn_1', sessionId: 'sid-receipt', epoch: epoch1, workerGeneration: 1 };
    bindGroupContextDelivery(binding1, dataDir);
    expect(commitGroupContextDispatchIntoPayload({ content: `${first.body}\nFirst` }, binding1, dataDir)).toBeDefined();
    expect(confirmGroupContextNativeInput(binding1, { kind: 'claude_transcript_user_record' }, dataDir)).toBe(true);

    const payload = {
      content: `${frozen.body}\nTask`,
      linkRefs: {
        mode: 'disabled' as const,
        sources: [{ sourceType: 'group_context' as const, kind: 'text' as const, text: frozen.body }],
      },
    };
    expect(sendWorkerInput(ds, payload, turnId)).toBe(true);
    const sent = worker.send.mock.calls.map((call: any[]) => call[0]).find((message: any) => message?.type === 'message');
    expect(sent, JSON.stringify(worker.send.mock.calls)).toBeDefined();
    expect(sent.content).toContain(keptUrl);
    expect(sent.content).not.toContain(droppedUrl);
    expect(sent.content.match(/\{\{botmux_link:lr_[0-9a-f]{32}\}\}/g)).toHaveLength(1);
    expect(payload.content).toBe(sent.content);
    expect(payload.linkRefs).toEqual({ mode: 'enabled' });
  });

  it('defers queued-turn LinkRef registration until promotion and reuses it after journal persistence retries', () => {
    process.env.BOTMUX_LINK_REFS_MODE = 'enabled';
    initializeLinkRefRuntime(dataDir);
    initWorkerPool({ sessionReply: vi.fn(), getSessionWorkingDir: () => '/repo', getActiveCount: () => 1, closeSession: vi.fn() } as any);
    const worker = makeFakeWorker();
    const ds = makeDs(worker);
    ds.session.workerGeneration = 1; ds.workerGeneration = 1;
    const droppedUrl = 'https://context.example.test/queued-already-covered';
    const keptUrl = 'https://context.example.test/queued-new';
    const firstEpoch = groupContextEpoch('sid-receipt', 'native-known', 'claude-code', 'om_queue_first');
    const queuedTurnId = 'om_queue_link_ref';
    const queuedEpoch = groupContextEpoch('sid-receipt', 'native-known', 'claude-code', queuedTurnId);
    const first = {
      ...bundle('om_queue_first', firstEpoch, [1]),
      body: `<shared_group_context trust="untrusted" through_seq="1">\n<policy>p</policy>\n${frag(1, droppedUrl)}\n</shared_group_context>`,
      sources: [{ seq: 1, text: frag(1, droppedUrl) }],
    };
    writePreparedGroupContext(first, dataDir);
    const frozen = writePreparedGroupContext({
      ...bundle(queuedTurnId, queuedEpoch, [1, 2]),
      body: `<shared_group_context trust="untrusted" through_seq="2">\n<policy>p</policy>\n${frag(1, droppedUrl)}\n${frag(2, keptUrl)}\n</shared_group_context>`,
      sources: [
        { seq: 1, text: frag(1, droppedUrl) },
        { seq: 2, text: frag(2, keptUrl) },
      ],
    }, dataDir);
    const firstBinding = {
      appId: 'app_test', chatId: 'oc_chat', turnId: 'om_queue_first',
      sessionId: 'sid-receipt', epoch: firstEpoch, workerGeneration: 1,
    };
    bindGroupContextDelivery(firstBinding, dataDir);
    expect(commitGroupContextDispatchIntoPayload({ content: `${first.body}\nFirst` }, firstBinding, dataDir)).toBeDefined();
    expect(confirmGroupContextNativeInput(firstBinding, { kind: 'claude_transcript_user_record' }, dataDir)).toBe(true);

    admitQueuedActivationTail(ds, {
      userPrompt: 'queued task',
      turnId: queuedTurnId,
      cliInput: {
        content: `${frozen.body}\nQueued task`,
        linkRefs: {
          mode: 'disabled',
          sources: [{ sourceType: 'group_context', kind: 'text', text: frozen.body }],
        },
      },
    });
    let failedPromotionContent: string | undefined;
    vi.mocked(sessionStore.updateSession).mockImplementationOnce(session => {
      failedPromotionContent = session.queuedActivationInput?.content;
      throw new Error('promotion store unavailable');
    });
    expect(promoteQueuedActivationTail(ds)).toBe(false);
    expect(failedPromotionContent).toMatch(/\{\{botmux_link:lr_[0-9a-f]{32}\}\}/);
    expect(worker.send).not.toHaveBeenCalled();
    expect(ds.session.queuedActivationTail?.[0]?.cliInput.linkRefs).toEqual({
      mode: 'enabled',
      sources: [{ sourceType: 'group_context', kind: 'text', text: frozen.body }],
    });

    expect(promoteQueuedActivationTail(ds)).toBe(true);
    const sent = worker.send.mock.calls.map((call: any[]) => call[0]).find((message: any) => message?.turnId === queuedTurnId);
    expect(sent).toBeDefined();
    expect(sent.content).toBe(failedPromotionContent);
    expect(sent.content).toContain(keptUrl);
    expect(sent.content).not.toContain(droppedUrl);
    expect(sent.content.match(/\{\{botmux_link:lr_[0-9a-f]{32}\}\}/g)).toHaveLength(1);
  });

  it('does not record a dispatch for a fork that is deferred before any IPC', async () => {
    initWorkerPool({ sessionReply: vi.fn(), getSessionWorkingDir: () => '/repo', getActiveCount: () => 1, closeSession: vi.fn() } as any);
    const worker = makeFakeWorker();
    const ds = makeDs(worker);
    ds.session.workerGeneration = 1; ds.workerGeneration = 1;
    // A queued session behind an XPI shared-cwd admission group defers the fork.
    (ds.session as any).queued = true;
    (ds.session as any).xpiSharedCwdAdmissionGroupId = 'review_group';
    const epoch1 = groupContextEpoch('sid-receipt', 'native-known', 'claude-code', 'om_turn_1');
    const epoch2 = groupContextEpoch('sid-receipt', 'native-known', 'claude-code', 'om_turn_2');
    const frozen1 = writePreparedGroupContext(bundle('om_turn_1', epoch1, [1]), dataDir);
    const frozen2 = writePreparedGroupContext(bundle('om_turn_2', epoch2, [1]), dataDir);
    const payload = { content: `${frozen2.body}\nTask` };
    let admission = '';
    expect(forkWorker(ds, payload, { turnId: 'om_turn_2' }, { onAdmission: (value: any) => { admission = String(value); } } as any)).toBe(true);
    expect(admission).toBe('deferred');
    expect(worker.send).not.toHaveBeenCalled();
    // Nothing crossed the boundary: no snapshot, and the payload is untouched.
    expect(readGroupContextDeliveryReceipt('app_test', 'oc_chat', 'om_turn_2', dataDir, epoch2)?.dispatchedAt).toBeUndefined();
    expect(payload.content).toContain('topic 1');
    // Turn 1 is dispatched and consumed meanwhile; the deferred turn 2 still subtracts it when it really goes.
    const binding1 = { appId: 'app_test', chatId: 'oc_chat', turnId: 'om_turn_1', sessionId: 'sid-receipt', epoch: epoch1, workerGeneration: 1 };
    bindGroupContextDelivery(binding1, dataDir);
    expect(commitGroupContextDispatchIntoPayload({ content: `${frozen1.body}\nFirst` }, binding1, dataDir)).toBeDefined();
    expect(confirmGroupContextNativeInput(binding1, { kind: 'claude_transcript_user_record' }, dataDir)).toBe(true);
    const eventual = commitGroupContextDispatchIntoPayload(payload, { appId: 'app_test', chatId: 'oc_chat', turnId: 'om_turn_2', sessionId: 'sid-receipt', epoch: epoch2, workerGeneration: 1 }, dataDir)!;
    expect(eventual.dispatched.includedSeqs).toEqual([]);
    expect(payload.content).toBe('Task');
  });
});
