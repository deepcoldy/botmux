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
import { initWorkerPool, sendWorkerInput, forkWorker, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { config } from '../src/config.js';
import {
  writePreparedGroupContext, confirmGroupContextNativeInput,
  readGroupContextDeliveryReceipt, getDeliveredGroupContextSeqs, bindGroupContextDelivery, type PreparedGroupContext,
} from '../src/services/group-context-delivery-store.js';
import { commitGroupContextDispatchIntoPayload } from '../src/services/group-context-prompt.js';
import { groupContextEpoch } from '../src/services/group-context-prompt.js';

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
  });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

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
