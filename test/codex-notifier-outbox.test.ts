import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import {
  CodexNotifierOutboxWorker,
  acquireCodexNotifierWorkerLease,
  createCodexNotifierEvent,
  emitCodexNotifierOutboxItem,
  enqueueCodexNotifierEvent,
  isCodexNotifierWorkerStateFresh,
  listCodexNotifierOutbox,
  materializeCodexNotifierOutboxEvent,
  parseCodexNotifierEvent,
  parseCodexNotifierOutboxItem,
  quarantineCodexNotifierOutboxItem,
  readCodexNotifierOutboxItem,
  readCodexNotifierWorkerState,
  runCodexNotifierWorkerSupervisor,
} from '../src/features/codex-notifier/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-codex-outbox-'));
  tempDirs.push(dataDir);
  return dataDir;
}

function completionEvent(seed = '1') {
  return createCodexNotifierEvent({
    hook_event_name: 'Stop',
    session_id: `thread-${seed}`,
    turn_id: `turn-${seed}`,
    cwd: '/workspace/project',
    last_assistant_message: `完成 ${seed}`,
  }, {
    title: `任务 ${seed}`,
    completedAt: '2026-07-22T08:00:00.000Z',
  });
}

describe('Codex notifier outbox', () => {
  it('ignores an entry removed between directory scan and stat', () => {
    const dataDir = newDataDir();
    const directory = join(dataDir, 'codex-notifier', 'outbox');
    mkdirSync(directory, { recursive: true });
    symlinkSync(
      join(directory, 'already-removed'),
      join(directory, `${'a'.repeat(64)}.json`),
    );

    expect(listCodexNotifierOutbox(dataDir)).toEqual([]);
  });

  it('atomically freezes the first target and deduplicates by stable event id', () => {
    const dataDir = newDataDir();
    const event = completionEvent();
    const firstPath = enqueueCodexNotifierEvent(dataDir, 'cli_first', event);
    const secondPath = enqueueCodexNotifierEvent(dataDir, 'cli_second', event);

    expect(secondPath).toBe(firstPath);
    expect(listCodexNotifierOutbox(dataDir)).toHaveLength(1);
    expect(readCodexNotifierOutboxItem(firstPath)).toEqual({
      schemaVersion: 1,
      targetBotAppId: 'cli_first',
      event,
    });
    expect(statSync(firstPath).mode & 0o777).toBe(0o600);
  });

  it('rejects malformed targets and forged event identities', () => {
    expect(() => parseCodexNotifierOutboxItem({
      schemaVersion: 1,
      targetBotAppId: ' ',
      event: completionEvent(),
    })).toThrow('codex_notifier_outbox_target_invalid');
    expect(() => parseCodexNotifierOutboxItem({
      schemaVersion: 1,
      targetBotAppId: 'cli_target',
      event: { ...completionEvent(), eventId: 'forged' },
    })).toThrow('codex completion event id mismatch');
  });

  it('rejects extra envelope fields before inspecting their contents', () => {
    const oversized = { toJSON: () => { throw new Error('must not inspect'); } };
    expect(() => parseCodexNotifierOutboxItem({
      schemaVersion: 1,
      targetBotAppId: 'cli_target',
      event: completionEvent(),
      ignored: oversized,
    })).toThrow('codex_notifier_outbox_invalid');
  });

  it('quarantines a corrupt same-id file before rewriting the event', () => {
    const dataDir = newDataDir();
    const event = completionEvent();
    const path = enqueueCodexNotifierEvent(dataDir, 'cli_target', event);
    writeFileSync(path, '{broken');

    enqueueCodexNotifierEvent(dataDir, 'cli_target', event);

    expect(readCodexNotifierOutboxItem(path).event).toEqual(event);
    expect(readdirSync(join(dataDir, 'codex-notifier', 'dead-letter'))).toHaveLength(1);
  });

  it('tolerates another process winning the corrupt-file quarantine race', () => {
    const dataDir = newDataDir();
    const event = completionEvent();
    const path = enqueueCodexNotifierEvent(dataDir, 'cli_target', event);
    writeFileSync(path, '{broken');

    expect(quarantineCodexNotifierOutboxItem(dataDir, path)).not.toBeNull();
    expect(quarantineCodexNotifierOutboxItem(dataDir, path)).toBeNull();
  });

  it('does not quarantine a valid file that replaced the corrupt version just read', () => {
    const dataDir = newDataDir();
    const event = completionEvent();
    const path = enqueueCodexNotifierEvent(dataDir, 'cli_first', event);
    writeFileSync(path, '{broken');
    let readError: unknown;
    try {
      readCodexNotifierOutboxItem(path);
    } catch (error) {
      readError = error;
    }
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      targetBotAppId: 'cli_second',
      event,
    }));

    expect(quarantineCodexNotifierOutboxItem(dataDir, path, readError)).toBeNull();
    expect(readCodexNotifierOutboxItem(path).targetBotAppId).toBe('cli_second');
    expect(readdirSync(join(dataDir, 'codex-notifier', 'dead-letter'))).toHaveLength(0);
  });

  it('stores App provenance outside the strict v1 event for rolling compatibility', () => {
    const dataDir = newDataDir();
    const event = createCodexNotifierEvent({
      hook_event_name: 'Stop',
      session_id: '019f8d92-df7c-7572-83ca-b1e99f20204c',
      turn_id: 'turn-app',
      cwd: '/workspace/project',
    }, {
      clientSurface: 'codex-app',
      conversationKind: 'side',
      completedAt: '2026-07-22T08:00:00.000Z',
    });
    const path = enqueueCodexNotifierEvent(dataDir, 'cli_target', event);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const item = readCodexNotifierOutboxItem(path);

    expect(raw.clientSurface).toBe('codex-app');
    expect(raw.conversationKind).toBe('side');
    expect(raw.event.clientSurface).toBeUndefined();
    expect(raw.event.conversationKind).toBeUndefined();
    expect(parseCodexNotifierEvent(raw.event)).toEqual(item.event);
    expect(item.clientSurface).toBe('codex-app');
    expect(item.conversationKind).toBe('side');
    expect(item.event.clientSurface).toBeUndefined();
    expect(item.event.conversationKind).toBeUndefined();
    expect(materializeCodexNotifierOutboxEvent(item)).toEqual(event);
  });

  it('normalizes legacy inner provenance and rejects conflicting provenance', () => {
    const event = createCodexNotifierEvent({
      hook_event_name: 'Stop',
      session_id: '019f8d92-df7c-7572-83ca-b1e99f20204c',
      turn_id: 'turn-app',
      cwd: '/workspace/project',
    }, {
      clientSurface: 'codex-app',
      completedAt: '2026-07-22T08:00:00.000Z',
    });

    expect(parseCodexNotifierOutboxItem({
      schemaVersion: 1,
      targetBotAppId: 'cli_target',
      event,
    })).toMatchObject({
      clientSurface: 'codex-app',
      event: { eventId: event.eventId },
    });
    expect(() => parseCodexNotifierOutboxItem({
      schemaVersion: 1,
      targetBotAppId: 'cli_target',
      clientSurface: 'codex-cli',
      event,
    })).toThrow('codex_notifier_outbox_client_surface_conflict');
  });
});

describe('Codex notifier outbox worker', () => {
  it('treats only recent worker heartbeats as online', () => {
    const state = {
      schemaVersion: 1 as const,
      heartbeatAt: '2026-07-22T08:00:00.000Z',
      pendingCount: 0,
      lastDeliveredAt: null,
      lastDisposition: null,
      lastError: null,
      stats: { accepted: 0, duplicate: 0, failed: 0 },
    };

    expect(isCodexNotifierWorkerStateFresh(
      state,
      Date.parse('2026-07-22T08:01:29.000Z'),
    )).toBe(true);
    expect(isCodexNotifierWorkerStateFresh(
      state,
      Date.parse('2026-07-22T08:01:31.000Z'),
    )).toBe(false);
    expect(isCodexNotifierWorkerStateFresh(null)).toBe(false);
  });

  it('leaves pending files untouched while the feature is disabled', async () => {
    const dataDir = newDataDir();
    enqueueCodexNotifierEvent(dataDir, 'cli_target', completionEvent());
    const emit = vi.fn();
    const worker = new CodexNotifierOutboxWorker({
      dataDir,
      emit,
      readConfig: () => ({ enabled: false, notifyWhen: 'locked_only' }),
    });

    expect(await worker.processOnce()).toEqual({
      accepted: 0,
      duplicate: 0,
      failed: 0,
      deferred: 0,
    });
    expect(emit).not.toHaveBeenCalled();
    expect(listCodexNotifierOutbox(dataDir)).toHaveLength(1);
  });

  it.each(['accepted', 'duplicate'] as const)('removes an event after daemon reports %s', async (disposition) => {
    const dataDir = newDataDir();
    const event = completionEvent();
    enqueueCodexNotifierEvent(dataDir, 'cli_target', event);
    const emit = vi.fn(async () => disposition);
    const worker = new CodexNotifierOutboxWorker({
      dataDir,
      emit,
      now: () => Date.parse('2026-07-22T08:01:00.000Z'),
      readConfig: () => ({ enabled: true, targetBotAppId: 'cli_target', notifyWhen: 'locked_only' }),
    });

    expect(await worker.processOnce()).toMatchObject({ [disposition]: 1, failed: 0 });
    expect(emit).toHaveBeenCalledWith({
      schemaVersion: 1,
      targetBotAppId: 'cli_target',
      event,
    });
    expect(listCodexNotifierOutbox(dataDir)).toEqual([]);

    const state = JSON.parse(readFileSync(join(dataDir, 'codex-notifier', 'worker-state.json'), 'utf8'));
    expect(state.pendingCount).toBe(0);
    expect(state.stats[disposition]).toBe(1);
    expect(state.lastDisposition).toBe(disposition);
  });

  it('retains failed events and applies exponential retry before succeeding', async () => {
    const dataDir = newDataDir();
    enqueueCodexNotifierEvent(dataDir, 'cli_target', completionEvent());
    let now = Date.parse('2026-07-22T08:01:00.000Z');
    const emit = vi.fn()
      .mockRejectedValueOnce(new Error('daemon offline'))
      .mockResolvedValueOnce('accepted');
    const worker = new CodexNotifierOutboxWorker({
      dataDir,
      emit,
      now: () => now,
      logger: { error: vi.fn() },
      readConfig: () => ({ enabled: true, targetBotAppId: 'cli_target', notifyWhen: 'locked_only' }),
    });

    expect(await worker.processOnce()).toMatchObject({ failed: 1, deferred: 0 });
    expect(listCodexNotifierOutbox(dataDir)).toHaveLength(1);
    expect(await worker.processOnce()).toMatchObject({ failed: 0, deferred: 1 });
    expect(emit).toHaveBeenCalledTimes(1);

    now += 2_000;
    expect(await worker.processOnce()).toMatchObject({ accepted: 1, deferred: 0 });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(listCodexNotifierOutbox(dataDir)).toEqual([]);
  });

  it('does not let the first 50 deferred failures starve a later event', async () => {
    const dataDir = newDataDir();
    for (let index = 0; index < 51; index += 1) {
      enqueueCodexNotifierEvent(dataDir, 'cli_target', completionEvent(`fair-${index}`));
    }
    const files = listCodexNotifierOutbox(dataDir);
    const lastEventId = readCodexNotifierOutboxItem(files[50]!.path).event.eventId;
    const emit = vi.fn(async (item) => {
      if (item.event.eventId === lastEventId) return 'accepted' as const;
      throw new Error('permanently offline');
    });
    const worker = new CodexNotifierOutboxWorker({
      dataDir,
      emit,
      now: () => Date.parse('2026-07-22T08:01:00.000Z'),
      logger: { error: vi.fn() },
      readConfig: () => ({ enabled: true, targetBotAppId: 'cli_target', notifyWhen: 'locked_only' }),
    });

    expect(await worker.processOnce()).toMatchObject({ failed: 50, accepted: 0 });
    expect(await worker.processOnce()).toMatchObject({ deferred: 50, accepted: 1 });
    expect(emit).toHaveBeenCalledTimes(51);
    expect(listCodexNotifierOutbox(dataDir)).toHaveLength(50);
  });

  it('ends a failing batch within its time budget so heartbeat can refresh', async () => {
    const dataDir = newDataDir();
    for (let index = 0; index < 5; index += 1) {
      enqueueCodexNotifierEvent(dataDir, 'cli_target', completionEvent(`budget-${index}`));
    }
    let now = Date.parse('2026-07-22T08:01:00.000Z');
    const emit = vi.fn(async () => {
      now += 15_000;
      throw new Error('daemon request timed out');
    });
    const worker = new CodexNotifierOutboxWorker({
      dataDir,
      emit,
      now: () => now,
      maxBatchMs: 25_000,
      logger: { error: vi.fn() },
      readConfig: () => ({ enabled: true, targetBotAppId: 'cli_target', notifyWhen: 'locked_only' }),
    });

    expect(await worker.processOnce()).toMatchObject({ failed: 2 });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(readCodexNotifierWorkerState(dataDir)?.heartbeatAt)
      .toBe(new Date(now).toISOString());
  });

  it('quarantines a malformed file instead of retrying it forever', async () => {
    const dataDir = newDataDir();
    const event = completionEvent();
    const path = enqueueCodexNotifierEvent(dataDir, 'cli_target', event);
    writeFileSync(path, '{broken');
    const emit = vi.fn();
    const worker = new CodexNotifierOutboxWorker({
      dataDir,
      emit,
      logger: { error: vi.fn() },
      readConfig: () => ({ enabled: true, targetBotAppId: 'cli_target', notifyWhen: 'locked_only' }),
    });

    expect(await worker.processOnce()).toMatchObject({ failed: 1, deferred: 0 });
    expect(emit).not.toHaveBeenCalled();
    expect(listCodexNotifierOutbox(dataDir)).toEqual([]);
    expect(readdirSync(join(dataDir, 'codex-notifier', 'dead-letter'))).toHaveLength(1);
  });
});

describe('Codex notifier worker lease', () => {
  it('allows only one dashboard process to own the outbox and releases cleanly', () => {
    const dataDir = newDataDir();
    const first = acquireCodexNotifierWorkerLease(dataDir);
    const second = acquireCodexNotifierWorkerLease(dataDir);

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    first.release();

    const third = acquireCodexNotifierWorkerLease(dataDir);
    expect(third.acquired).toBe(true);
    third.release();
  });

  it('does not reclaim a fresh lock while its first writer is still initializing it', () => {
    const dataDir = newDataDir();
    const lockPath = join(dataDir, 'codex-notifier', 'worker.lock');
    mkdirSync(join(dataDir, 'codex-notifier'), { recursive: true });
    writeFileSync(lockPath, '');

    const lease = acquireCodexNotifierWorkerLease(dataDir);

    expect(lease.acquired).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('reclaims an unparseable lock only after its initialization grace period', () => {
    const dataDir = newDataDir();
    const lockPath = join(dataDir, 'codex-notifier', 'worker.lock');
    mkdirSync(join(dataDir, 'codex-notifier'), { recursive: true });
    writeFileSync(lockPath, '{');
    const stale = new Date(Date.now() - 10_000);
    utimesSync(lockPath, stale, stale);

    const lease = acquireCodexNotifierWorkerLease(dataDir);

    expect(lease.acquired).toBe(true);
    lease.release();
  });

  it('removes each poll abort listener after the timer settles', async () => {
    const dataDir = newDataDir();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const worker = new CodexNotifierOutboxWorker({
      dataDir,
      signal: controller.signal,
      emit: vi.fn(async () => 'accepted'),
      readConfig: () => ({ enabled: false, notifyWhen: 'locked_only' }),
      pollIntervalMs: 1,
    });

    const running = worker.run();
    const deadline = Date.now() + 500;
    while (add.mock.calls.length < 20 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    expect(add.mock.calls.length).toBeGreaterThanOrEqual(20);
    expect(remove.mock.calls.length).toBeGreaterThanOrEqual(add.mock.calls.length - 1);

    controller.abort();
    await running;
    expect(remove.mock.calls.length).toBe(add.mock.calls.length);
  });

  it('runs and aborts the completion producer under the single worker lease', async () => {
    const dataDir = newDataDir();
    const controller = new AbortController();
    let producerSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const runProducer = vi.fn((signal: AbortSignal) => {
      producerSignal = signal;
      markStarted?.();
      return new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const worker = new CodexNotifierOutboxWorker({
      dataDir,
      signal: controller.signal,
      emit: vi.fn(async () => 'accepted'),
      runProducer,
      readConfig: () => ({ enabled: false, notifyWhen: 'locked_only' }),
      pollIntervalMs: 1,
    });

    const running = worker.run();
    await started;
    expect(runProducer).toHaveBeenCalledOnce();
    expect(producerSignal?.aborted).toBe(false);

    controller.abort();
    await running;
    expect(producerSignal?.aborted).toBe(true);
  });

  it('keeps retrying after a rolling restart leaves the old dashboard lease alive', async () => {
    const dataDir = newDataDir();
    const controller = new AbortController();
    const release = vi.fn();
    const acquireLease = vi.fn()
      .mockReturnValueOnce({ acquired: false, path: '/tmp/worker.lock', release: vi.fn() })
      .mockImplementationOnce(() => {
        setTimeout(() => controller.abort(), 5);
        return { acquired: true, path: '/tmp/worker.lock', release };
      });
    const unavailable = vi.fn();

    await runCodexNotifierWorkerSupervisor({
      dataDir,
      signal: controller.signal,
      emit: vi.fn(async () => 'accepted'),
      readConfig: () => ({ enabled: true, targetBotAppId: 'cli_target', notifyWhen: 'locked_only' }),
      acquireLease,
      leaseRetryMs: 1,
      pollIntervalMs: 1,
      onLeaseUnavailable: unavailable,
    });

    expect(acquireLease).toHaveBeenCalledTimes(2);
    expect(unavailable).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('Codex notifier emitter', () => {
  it('sends the frozen target envelope to the selected daemon', async () => {
    const item = {
      schemaVersion: 1 as const,
      targetBotAppId: 'cli_target',
      event: completionEvent(),
    };
    const fetchDaemon = vi.fn(async () => new Response(JSON.stringify({ status: 'accepted' }), {
      status: 200,
    }));

    expect(await emitCodexNotifierOutboxItem(item, {
      findDaemon: vi.fn(() => ({ larkAppId: 'cli_target', ipcPort: 4321 })),
      fetchDaemon: fetchDaemon as never,
    })).toBe('accepted');
    expect(fetchDaemon).toHaveBeenCalledWith(
      4321,
      '/api/codex-notifier/events',
      expect.objectContaining({
        body: JSON.stringify(item),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('aborts a hung daemon request so later outbox items can retry', async () => {
    const item = {
      schemaVersion: 1 as const,
      targetBotAppId: 'cli_target',
      event: completionEvent(),
    };
    const fetchDaemon = vi.fn(async (_port: number, _path: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));

    await expect(emitCodexNotifierOutboxItem(item, {
      findDaemon: vi.fn(() => ({ larkAppId: 'cli_target', ipcPort: 4321 })),
      fetchDaemon: fetchDaemon as never,
      timeoutMs: 5,
    })).rejects.toBeTruthy();
  });
});
