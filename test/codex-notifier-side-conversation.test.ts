import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyCodexConversationPatches,
  CodexSideConversationMonitor,
  CodexSideConversationTracker,
  createSideConversationCompletionEvent,
  listRecentCodexVisualizationThreads,
} from '../src/features/codex-notifier/index.js';

const SIDE_THREAD_ID = '019f9365-7d84-7b42-8fa9-05b5eedf1a4f';
const HISTORICAL_THREAD_ID = '019f9365-7d84-7b42-8fa9-05b5eedf1a40';
const NEW_THREAD_ID = '019f9365-7d84-7b42-8fa9-05b5eedf1a41';
const TURN_KEY = 'tail:turn-side';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sideState(
  status: string,
  options: {
    id?: string;
    turnId?: string;
    startedAtMs?: number;
    durationMs?: number;
    updatedAt?: number;
  } = {},
) {
  const startedAtMs = options.startedAtMs
    ?? Date.parse('2026-07-24T08:00:00.000Z');
  const durationMs = options.durationMs ?? 5_000;
  return {
    id: options.id ?? SIDE_THREAD_ID,
    sideConversation: true,
    ephemeral: true,
    cwd: '/workspace/botmux',
    title: 'Side Chat',
    updatedAt: options.updatedAt ?? startedAtMs + durationMs,
    turnHistory: {
      history: {
        entitiesByKey: {
          [TURN_KEY]: {
            turnId: options.turnId ?? 'turn-side',
            status,
            turnStartedAtMs: startedAtMs,
            durationMs,
            params: {
              cwd: '/workspace/botmux',
              input: [{ type: 'text', text: '测试 Side Chat 完成通知' }],
            },
            items: [
              { type: 'userMessage', content: [{ type: 'text', text: '测试 Side Chat 完成通知' }] },
              { type: 'agentMessage', text: 'Side Chat 已经完成。' },
            ],
          },
        },
      },
    },
  };
}

function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function decodeFrame(frame: Buffer): any {
  return JSON.parse(frame.subarray(4).toString('utf8'));
}

class FakeIpcSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  readonly writes: Buffer[] = [];
  onWrite?: (message: any) => void;

  write(value: Uint8Array): boolean {
    const frame = Buffer.from(value);
    this.writes.push(frame);
    this.onWrite?.(decodeFrame(frame));
    return true;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    queueMicrotask(() => this.emit('close'));
    return this;
  }
}

function asSocket(socket: FakeIpcSocket): Socket {
  return socket as unknown as Socket;
}

function initializeSocket(
  socket: FakeIpcSocket,
  onFollow?: (conversationId: string) => void,
): void {
  socket.onWrite = message => {
    if (message.type === 'request' && message.method === 'initialize') {
      queueMicrotask(() => socket.emit('data', encodeFrame({
        type: 'response',
        method: 'initialize',
        resultType: 'success',
        result: { clientId: 'test-client' },
      })));
      return;
    }
    if (
      message.type === 'broadcast'
      && message.method === 'thread-stream-following-changed'
      && message.params?.following === true
    ) {
      onFollow?.(message.params.conversationId);
    }
  };
  queueMicrotask(() => socket.emit('connect'));
}

function emitSnapshot(
  socket: FakeIpcSocket,
  conversationId: string,
  state: ReturnType<typeof sideState>,
  revision = 1,
): void {
  socket.emit('data', encodeFrame({
    type: 'broadcast',
    method: 'thread-stream-state-changed',
    params: {
      hostId: 'local',
      conversationId,
      change: {
        type: 'snapshot',
        revision,
        conversationState: state,
      },
    },
  }));
}

function emitPatches(
  socket: FakeIpcSocket,
  conversationId: string,
  baseRevision: number,
  revision: number,
  patches: unknown[],
): void {
  socket.emit('data', encodeFrame({
    type: 'broadcast',
    method: 'thread-stream-state-changed',
    params: {
      hostId: 'local',
      conversationId,
      change: {
        type: 'patches',
        baseRevision,
        revision,
        patches,
      },
    },
  }));
}

async function connectOnce(
  monitor: CodexSideConversationMonitor,
  signal?: AbortSignal,
): Promise<void> {
  await (monitor as unknown as {
    connectOnce: (signal?: AbortSignal) => Promise<void>;
  }).connectOnce(signal);
}

describe('Codex Side Chat state tracking', () => {
  it('emits one completion event for an inProgress to completed patch', () => {
    const tracker = new CodexSideConversationTracker();
    expect(tracker.observeSnapshot(SIDE_THREAD_ID, 1, sideState('inProgress')).events).toEqual([]);

    const result = tracker.observePatches(SIDE_THREAD_ID, 1, 2, [{
      op: 'replace',
      path: ['turnHistory', 'history', 'entitiesByKey', TURN_KEY, 'status'],
      value: 'completed',
    }]);

    expect(result.needsSnapshot).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: 'task.completed',
      source: 'codex-desktop',
      clientSurface: 'codex-app',
      conversationKind: 'side',
      threadId: SIDE_THREAD_ID,
      nativeTurnId: 'turn-side',
      status: 'completed',
      title: '测试 Side Chat 完成通知',
      cwd: '/workspace/botmux',
      completedAt: '2026-07-24T08:00:05.000Z',
      finalPreview: 'Side Chat 已经完成。',
    });
  });

  it('suppresses historical terminal snapshots but recovers a newly discovered fast completion', () => {
    const historical = new CodexSideConversationTracker();
    expect(historical.observeSnapshot(
      SIDE_THREAD_ID,
      1,
      sideState('completed'),
    ).events).toEqual([]);

    const newlyDiscovered = new CodexSideConversationTracker();
    expect(newlyDiscovered.observeSnapshot(
      SIDE_THREAD_ID,
      1,
      sideState('completed'),
      { notifyTerminalOnFirstSnapshot: true },
    ).events).toHaveLength(1);

    const watermarked = new CodexSideConversationTracker();
    expect(watermarked.observeSnapshot(
      SIDE_THREAD_ID,
      1,
      sideState('completed'),
      {
        notifyTerminalOnFirstSnapshot: true,
        terminalNotBeforeMs: Date.parse('2026-07-24T08:01:00.000Z'),
      },
    ).events).toEqual([]);
  });

  it('does not use a later conversation update as proof of a new terminal turn', () => {
    const state = sideState('completed', {
      updatedAt: Date.parse('2026-07-24T09:00:00.000Z'),
    });
    const turn = state.turnHistory.history.entitiesByKey[TURN_KEY] as Record<string, unknown>;
    delete turn.turnStartedAtMs;
    delete turn.durationMs;

    const tracker = new CodexSideConversationTracker();
    expect(tracker.observeSnapshot(
      SIDE_THREAD_ID,
      1,
      state,
      {
        notifyTerminalOnFirstSnapshot: true,
        terminalNotBeforeMs: Date.parse('2026-07-24T08:30:00.000Z'),
      },
    ).events).toEqual([]);
  });

  it('fails closed for normal conversations, malformed revisions and unsafe patches', () => {
    expect(createSideConversationCompletionEvent(
      { ...sideState('completed'), sideConversation: false },
      sideState('completed').turnHistory.history.entitiesByKey[TURN_KEY],
    )).toBeUndefined();

    const tracker = new CodexSideConversationTracker();
    expect(tracker.observeSnapshot(
      SIDE_THREAD_ID,
      2,
      { ...sideState('completed'), sideConversation: false },
    )).toEqual({ events: [], needsSnapshot: false });
    expect(tracker.has(SIDE_THREAD_ID)).toBe(false);
    tracker.observeSnapshot(SIDE_THREAD_ID, 3, sideState('inProgress'));
    expect(tracker.observePatches(SIDE_THREAD_ID, 2, 4, [])).toEqual({
      events: [],
      needsSnapshot: true,
    });
    expect(() => applyCodexConversationPatches({}, [{
      op: 'add',
      path: ['__proto__', 'polluted'],
      value: true,
    }])).toThrow('codex_side_chat_patch_path_invalid');
    expect(() => applyCodexConversationPatches({}, [{
      op: 'copy' as 'add',
      path: ['value'],
      value: true,
    }])).toThrow('codex_side_chat_patch_path_invalid');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps completion extraction safe for out-of-range timestamps', () => {
    const event = createSideConversationCompletionEvent(
      sideState('completed', {
        startedAtMs: Number.MAX_VALUE,
        durationMs: Number.MAX_VALUE,
        updatedAt: Number.MAX_VALUE,
      }),
      sideState('completed', {
        startedAtMs: Number.MAX_VALUE,
        durationMs: Number.MAX_VALUE,
        updatedAt: Number.MAX_VALUE,
      }).turnHistory.history.entitiesByKey[TURN_KEY],
      Date.parse('2026-07-24T09:00:00.000Z'),
    );

    expect(event?.completedAt).toBe('2026-07-24T09:00:00.000Z');
  });

  it('evicts old conversations before the tracked state byte budget is exceeded', () => {
    const oneStateBytes = Buffer.byteLength(JSON.stringify(sideState('inProgress')));
    const tracker = new CodexSideConversationTracker(10, oneStateBytes + 100);
    const secondId = '019f9365-7d84-7b42-8fa9-05b5eedf1a42';

    tracker.observeSnapshot(SIDE_THREAD_ID, 1, sideState('inProgress'));
    tracker.observeSnapshot(secondId, 1, sideState('inProgress', { id: secondId }));

    expect(tracker.has(SIDE_THREAD_ID)).toBe(false);
    expect(tracker.has(secondId)).toBe(true);
    tracker.clear();
    expect(tracker.has(secondId)).toBe(false);
  });
});

describe('Codex Side Chat candidate discovery', () => {
  it('returns recent UUID directories only and applies the requested limit', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'botmux-codex-side-chat-'));
    tempDirs.push(codexHome);
    const now = new Date(2026, 6, 24, 12, 0, 0).getTime();
    const day = join(codexHome, 'visualizations', '2026', '07', '24');
    mkdirSync(day, { recursive: true });
    const older = '019f9346-7d84-7b42-8fa9-05b5eedf1a40';
    const newer = '019f9352-7d84-7b42-8fa9-05b5eedf1a41';
    mkdirSync(join(day, older));
    mkdirSync(join(day, newer));
    mkdirSync(join(day, 'not-a-thread'));
    utimesSync(join(day, older), new Date(now - 2_000), new Date(now - 2_000));
    utimesSync(join(day, newer), new Date(now - 1_000), new Date(now - 1_000));

    expect(listRecentCodexVisualizationThreads(codexHome, now, 1)).toEqual([{
      id: newer,
      mtimeMs: now - 1_000,
    }]);
  });
});

describe('Codex Side Chat IPC monitor', () => {
  it('resets observation state while disabled and does not backfill during the disabled window', async () => {
    const sockets: FakeIpcSocket[] = [];
    const controller = new AbortController();
    let enqueueFails = true;
    const enqueue = vi.fn(() => {
      if (enqueueFails) throw new Error('temporary write failure');
    });
    let enabled = true;
    let state = sideState('inProgress');
    const monitor = new CodexSideConversationMonitor({
      dataDir: '/tmp/botmux-side-chat-test',
      signal: controller.signal,
      platform: 'darwin',
      scanIntervalMs: 5,
      retryMs: 1,
      connectTimeoutMs: 100,
      initializeTimeoutMs: 100,
      readConfig: () => ({
        enabled,
        targetBotAppId: 'cli_test',
        notifyWhen: 'always',
      }),
      listThreads: () => [{ id: SIDE_THREAD_ID, mtimeMs: Date.now() }],
      enqueue,
      logger: {
        debug: () => undefined,
        warn: () => undefined,
      },
      connect: () => {
        const socket = new FakeIpcSocket();
        sockets.push(socket);
        initializeSocket(socket, conversationId => {
          queueMicrotask(() => emitSnapshot(socket, conversationId, state));
        });
        return asSocket(socket);
      },
    });

    const running = monitor.run();
    await vi.waitFor(() => expect(sockets[0]?.writes.length).toBeGreaterThan(1));
    emitPatches(sockets[0], SIDE_THREAD_ID, 1, 2, [{
      op: 'replace',
      path: ['turnHistory', 'history', 'entitiesByKey', TURN_KEY, 'status'],
      value: 'completed',
    }]);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    enabled = false;
    await vi.waitFor(() => expect(sockets[0]?.destroyed).toBe(true));

    state = sideState('completed');
    enqueueFails = false;
    enabled = true;
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(sockets[1]?.writes.length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0]?.[2]?.eventId).toBe(enqueue.mock.calls[1]?.[2]?.eventId);
    controller.abort();
    await running;
  });

  it('recovers an initial candidate that completes before its first snapshot arrives', async () => {
    const baselineAt = Date.parse('2026-07-24T08:00:00.000Z');
    let now = baselineAt;
    const enqueue = vi.fn();
    const controller = new AbortController();
    const socket = new FakeIpcSocket();
    socket.onWrite = message => {
      if (message.type === 'request' && message.method === 'initialize') {
        queueMicrotask(() => socket.emit('data', encodeFrame({
          type: 'response',
          method: 'initialize',
          resultType: 'success',
          result: { clientId: 'test-client' },
        })));
        return;
      }
      if (
        message.type === 'broadcast'
        && message.method === 'thread-stream-following-changed'
        && message.params?.following === true
      ) {
        now = baselineAt + 6_000;
        queueMicrotask(() => emitSnapshot(
          socket,
          SIDE_THREAD_ID,
          sideState('completed', { startedAtMs: baselineAt }),
        ));
      }
    };
    queueMicrotask(() => socket.emit('connect'));
    const monitor = new CodexSideConversationMonitor({
      dataDir: '/tmp/botmux-side-chat-test',
      platform: 'darwin',
      now: () => now,
      scanIntervalMs: 5,
      connectTimeoutMs: 100,
      initializeTimeoutMs: 100,
      readConfig: () => ({
        enabled: true,
        targetBotAppId: 'cli_test',
        notifyWhen: 'always',
      }),
      listThreads: () => [{ id: SIDE_THREAD_ID, mtimeMs: baselineAt }],
      enqueue,
      connect: () => asSocket(socket),
    });

    const connected = connectOnce(monitor, controller.signal);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    expect(enqueue.mock.calls[0]?.[2]?.nativeTurnId).toBe('turn-side');

    controller.abort();
    await connected;
  });

  it('bounds in-memory events while durable enqueue is unavailable', async () => {
    const baselineAt = Date.parse('2026-07-24T08:00:00.000Z');
    let now = baselineAt;
    let enqueueFails = true;
    const accepted: string[] = [];
    const warnings: string[] = [];
    const enqueue = vi.fn((_dataDir, _targetBotAppId, event) => {
      if (enqueueFails) throw new Error('disk full');
      accepted.push(event.nativeTurnId);
      return '/tmp/outbox.json';
    });
    const states = new Map([
      [SIDE_THREAD_ID, sideState('completed', {
        startedAtMs: baselineAt,
      })],
      [NEW_THREAD_ID, sideState('completed', {
        id: NEW_THREAD_ID,
        turnId: 'turn-new',
        startedAtMs: baselineAt,
      })],
    ]);
    const controller = new AbortController();
    const socket = new FakeIpcSocket();
    socket.onWrite = message => {
      if (message.type === 'request' && message.method === 'initialize') {
        queueMicrotask(() => socket.emit('data', encodeFrame({
          type: 'response',
          method: 'initialize',
          resultType: 'success',
          result: { clientId: 'test-client' },
        })));
        return;
      }
      if (
        message.type === 'broadcast'
        && message.method === 'thread-stream-following-changed'
        && message.params?.following === true
      ) {
        const state = states.get(message.params.conversationId);
        if (!state) return;
        now = baselineAt + 6_000;
        queueMicrotask(() => emitSnapshot(
          socket,
          message.params.conversationId,
          state,
        ));
      }
    };
    queueMicrotask(() => socket.emit('connect'));
    const monitor = new CodexSideConversationMonitor({
      dataDir: '/tmp/botmux-side-chat-test',
      platform: 'darwin',
      now: () => now,
      scanIntervalMs: 5,
      connectTimeoutMs: 100,
      initializeTimeoutMs: 100,
      maxPendingEvents: 1,
      maxPendingBytes: 1024 * 1024,
      logger: {
        debug: () => undefined,
        warn: message => warnings.push(String(message)),
      },
      readConfig: () => ({
        enabled: true,
        targetBotAppId: 'cli_test',
        notifyWhen: 'always',
      }),
      listThreads: () => [
        { id: SIDE_THREAD_ID, mtimeMs: baselineAt },
        { id: NEW_THREAD_ID, mtimeMs: baselineAt },
      ],
      enqueue,
      connect: () => asSocket(socket),
    });

    const connected = connectOnce(monitor, controller.signal);
    await vi.waitFor(() => expect(
      warnings.some(message => message.includes('内存待入队已达上限')),
    ).toBe(true));
    enqueueFails = false;
    await vi.waitFor(() => expect(accepted).toEqual(['turn-side']));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(accepted).not.toContain('turn-new');

    controller.abort();
    await connected;
  });

  it('uses the enable-time watermark for late history and foreign-follow fast completions', async () => {
    const baselineAt = Date.parse('2026-07-24T08:00:00.000Z');
    let now = baselineAt;
    let threads = [{
      id: SIDE_THREAD_ID,
      mtimeMs: baselineAt - 1_000,
    }];
    const states = new Map<string, ReturnType<typeof sideState>>([
      [SIDE_THREAD_ID, sideState('completed', {
        startedAtMs: baselineAt - 10_000,
      })],
      [HISTORICAL_THREAD_ID, sideState('completed', {
        id: HISTORICAL_THREAD_ID,
        turnId: 'turn-history',
        startedAtMs: baselineAt - 20_000,
      })],
      [NEW_THREAD_ID, sideState('completed', {
        id: NEW_THREAD_ID,
        turnId: 'turn-new',
        startedAtMs: baselineAt + 10_000,
      })],
    ]);
    const enqueue = vi.fn();
    const controller = new AbortController();
    const socket = new FakeIpcSocket();
    socket.onWrite = message => {
      if (message.type === 'request' && message.method === 'initialize') {
        queueMicrotask(() => {
          socket.emit('data', encodeFrame({
            type: 'broadcast',
            method: 'thread-stream-following-changed',
            params: {
              hostId: 'local',
              conversationId: NEW_THREAD_ID,
              following: true,
            },
          }));
          socket.emit('data', encodeFrame({
            type: 'response',
            method: 'initialize',
            resultType: 'success',
            result: { clientId: 'test-client' },
          }));
        });
        return;
      }
      if (
        message.type === 'broadcast'
        && message.method === 'thread-stream-following-changed'
        && message.params?.following === true
      ) {
        const state = states.get(message.params.conversationId);
        if (state) {
          queueMicrotask(() => emitSnapshot(
            socket,
            message.params.conversationId,
            state,
          ));
        }
      }
    };
    queueMicrotask(() => socket.emit('connect'));
    const monitor = new CodexSideConversationMonitor({
      dataDir: '/tmp/botmux-side-chat-test',
      platform: 'darwin',
      now: () => now,
      scanIntervalMs: 5,
      connectTimeoutMs: 100,
      initializeTimeoutMs: 100,
      readConfig: () => ({
        enabled: true,
        targetBotAppId: 'cli_test',
        notifyWhen: 'always',
      }),
      listThreads: () => threads,
      enqueue,
      connect: () => asSocket(socket),
    });
    const connected = connectOnce(monitor, controller.signal);

    await vi.waitFor(() => expect(socket.writes.length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(
      enqueue.mock.calls[0]?.[2]?.nativeTurnId,
    ).toBe('turn-new'));
    now = baselineAt + 20_000;
    threads = [{
      id: HISTORICAL_THREAD_ID,
      mtimeMs: baselineAt - 2_000,
    }];
    await vi.waitFor(() => expect(
      socket.writes.some(frame =>
        decodeFrame(frame).params?.conversationId === HISTORICAL_THREAD_ID),
    ).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(enqueue).toHaveBeenCalledTimes(1);

    controller.abort();
    await connected;
  });

  it('decodes fragmented frames without repeated buffer concatenation and rejects oversized frames', async () => {
    const fragmentedSocket = new FakeIpcSocket();
    fragmentedSocket.onWrite = message => {
      if (message.method !== 'initialize') return;
      const response = encodeFrame({
        type: 'response',
        method: 'initialize',
        resultType: 'success',
        result: { clientId: 'test-client' },
      });
      queueMicrotask(() => {
        fragmentedSocket.emit('data', response.subarray(0, 2));
        fragmentedSocket.emit('data', response.subarray(2, 7));
        fragmentedSocket.emit('data', response.subarray(7));
      });
    };
    queueMicrotask(() => fragmentedSocket.emit('connect'));
    const fragmentedAbort = new AbortController();
    const fragmentedMonitor = new CodexSideConversationMonitor({
      dataDir: '/tmp/botmux-side-chat-test',
      platform: 'darwin',
      scanIntervalMs: 5,
      connectTimeoutMs: 100,
      initializeTimeoutMs: 100,
      readConfig: () => ({
        enabled: true,
        targetBotAppId: 'cli_test',
        notifyWhen: 'always',
      }),
      listThreads: () => [],
      connect: () => asSocket(fragmentedSocket),
    });
    const connected = connectOnce(fragmentedMonitor, fragmentedAbort.signal);
    await vi.waitFor(() => expect(
      fragmentedSocket.writes.some(frame =>
        decodeFrame(frame).method === 'initialize'),
    ).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fragmentedSocket.destroyed).toBe(false);
    fragmentedAbort.abort();
    await connected;

    const oversizedSocket = new FakeIpcSocket();
    const warnings: string[] = [];
    oversizedSocket.onWrite = message => {
      if (message.method !== 'initialize') return;
      const header = Buffer.alloc(4);
      header.writeUInt32LE(16 * 1024 * 1024 + 1);
      queueMicrotask(() => oversizedSocket.emit('data', header));
    };
    queueMicrotask(() => oversizedSocket.emit('connect'));
    const oversizedMonitor = new CodexSideConversationMonitor({
      dataDir: '/tmp/botmux-side-chat-test',
      platform: 'darwin',
      connectTimeoutMs: 100,
      initializeTimeoutMs: 100,
      logger: {
        debug: () => undefined,
        warn: message => warnings.push(String(message)),
      },
      readConfig: () => ({
        enabled: true,
        targetBotAppId: 'cli_test',
        notifyWhen: 'always',
      }),
      connect: () => asSocket(oversizedSocket),
    });

    await connectOnce(oversizedMonitor);
    expect(oversizedSocket.destroyed).toBe(true);
    expect(warnings.some(message => message.includes('帧长度无效'))).toBe(true);
  });

  it('times out both a stalled connection and a stalled initialize handshake', async () => {
    const connectSocket = new FakeIpcSocket();
    const connectWarnings: string[] = [];
    const connectMonitor = new CodexSideConversationMonitor({
      dataDir: '/tmp/botmux-side-chat-test',
      platform: 'darwin',
      connectTimeoutMs: 10,
      initializeTimeoutMs: 100,
      logger: {
        debug: () => undefined,
        warn: message => connectWarnings.push(String(message)),
      },
      readConfig: () => ({
        enabled: true,
        targetBotAppId: 'cli_test',
        notifyWhen: 'always',
      }),
      connect: () => asSocket(connectSocket),
    });
    await connectOnce(connectMonitor);
    expect(connectSocket.destroyed).toBe(true);
    expect(connectWarnings.some(message => message.includes('连接超时'))).toBe(true);

    const stalledInitializeSocket = new FakeIpcSocket();
    const initializeWarnings: string[] = [];
    queueMicrotask(() => stalledInitializeSocket.emit('connect'));
    const initializeMonitor = new CodexSideConversationMonitor({
      dataDir: '/tmp/botmux-side-chat-test',
      platform: 'darwin',
      connectTimeoutMs: 100,
      initializeTimeoutMs: 10,
      logger: {
        debug: () => undefined,
        warn: message => initializeWarnings.push(String(message)),
      },
      readConfig: () => ({
        enabled: true,
        targetBotAppId: 'cli_test',
        notifyWhen: 'always',
      }),
      connect: () => asSocket(stalledInitializeSocket),
    });
    await connectOnce(initializeMonitor);
    expect(stalledInitializeSocket.destroyed).toBe(true);
    expect(initializeWarnings.some(message => message.includes('初始化超时'))).toBe(true);
  });
});
