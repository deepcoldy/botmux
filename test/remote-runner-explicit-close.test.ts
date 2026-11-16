import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const { listChatPinsMock } = vi.hoisted(() => ({
  listChatPinsMock: vi.fn(async () => []),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ resolvedAllowedUsers: [], config: {} })),
  getBotBrand: vi.fn(() => 'feishu'),
  getAllBots: vi.fn(() => []),
  loadBotConfigs: vi.fn(),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/adapters/backend/mojo-backend.js', () => ({
  cancelMojoSessionById: vi.fn(async () => ({ kind: 'cancelled' as const })),
  MojoBackend: class {},
}));

vi.mock('../src/adapters/backend/riff-backend.js', () => ({
  hashUrlForLog: vi.fn(() => 'riffhash'),
  cancelRiffTaskById: vi.fn(async () => true),
  RiffBackend: class {},
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  sendEphemeralCard: vi.fn(),
  sendUserMessage: vi.fn(),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  getMessageChatId: vi.fn(),
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(async () => true),
  listChatPins: (...args: unknown[]) => listChatPinsMock(...args),
  MessageWithdrawnError: class extends Error {},
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
  deleteFrozenCards: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  __testOnly_setRemoteRunnerExplicitCloseWake,
  __testOnly_setupWorkerHandlers,
  __testOnly_wakeRemoteRunnerWorkerForExplicitClose,
  closeSession,
  findActiveBySessionId,
  initWorkerPool,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import type { DaemonToWorker } from '../src/types.js';
import { controllerForSession } from '../src/core/session-controller.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import * as sessionStore from '../src/services/session-store.js';

let dataDir: string;
let previousDataDir: string;

function createFakeWorker(): EventEmitter & {
  killed: boolean;
  send: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: string | null;
  kill: ReturnType<typeof vi.fn>;
} {
  const worker = Object.assign(new EventEmitter(), {
    killed: false,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(),
    send: vi.fn(),
  });
  worker.send.mockImplementation((message: { type: string; requestId?: string }) => {
    if (message.type === 'close' && message.requestId) {
      queueMicrotask(() => worker.emit('message', {
        type: 'close_result',
        requestId: message.requestId,
        ok: true,
      }));
    } else if (message.type === 'close_commit') {
      queueMicrotask(() => {
        worker.exitCode = 0;
        worker.emit('exit', 0, null);
      });
    }
  });
  return worker;
}

function createFixture(liveWorker: boolean): {
  ds: DaemonSession;
  worker: (EventEmitter & { killed: boolean; send: ReturnType<typeof vi.fn> }) | null;
} {
  sessionStore.init('app');
  const session = sessionStore.createSession('oc_remote', 'om_remote', 'remote close', 'group');
  session.larkAppId = 'app';
  session.scope = 'chat';
  session.backendType = 'remote-runner';
  session.remoteBackendState = {
    version: 1,
    provider: 'test-provider',
    generation: 1,
    remoteSessionId: 'remote-1',
    agentThreadId: 'thread-1',
  };
  sessionStore.updateSession(session);

  const worker = liveWorker ? createFakeWorker() : null;
  const ds = {
    larkAppId: 'app',
    chatId: session.chatId,
    chatType: 'group',
    scope: 'chat',
    worker,
    workerReady: liveWorker,
    session,
    initConfig: { backendType: 'remote-runner' },
  } as unknown as DaemonSession;
  if (worker) __testOnly_setupWorkerHandlers(ds, worker as never);
  setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
  return { ds, worker };
}

function canonicalFixture(online = true, liveWorker = true) {
  const fixture = createFixture(liveWorker);
  const controller = controllerForSession(fixture.ds, true)!;
  const bootstrap = controller.bindWorker(fixture.ds.workerGeneration ?? 0);
  if (online) controller.store.apply(controller.ref, { type: 'worker_online', worker: bootstrap.worker });
  return { ...fixture, controller, bootstrap };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-remote-close-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  listChatPinsMock.mockResolvedValue([]);
  initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
    getSessionWorkingDir: () => '/repo',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  __testOnly_setRemoteRunnerExplicitCloseWake();
  setActiveSessionsRegistry(new Map());
  config.session.dataDir = previousDataDir;
  sessionStore.init('test-app');
  rmSync(dataDir, { recursive: true, force: true });
});

describe('remote runner explicit close', () => {
  it('closes a handshaken canonical worker while input readiness is fenced', async () => {
    vi.useFakeTimers();
    try {
      const { ds, worker, controller } = canonicalFixture();
      expect(ds.workerReady).toBe(true);
      const closing = closeSession(ds.session.sessionId);
      expect(ds.workerReady).toBe(false);
      expect(controller.allowsInput()).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      await expect(closing).resolves.toMatchObject({ ok: true, outcome: 'closed' });
      expect(worker!.send.mock.calls.some(([message]) => message.type === 'close')).toBe(true);
      expect(controller.store.read(controller.ref)?.lifecycle).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['idle', 'dormant', 'active'] as const)('closes a real %s canonical worker through provider cancel ACK', async mode => {
    const { ds } = createFixture(false);
    const commandsPath = join(dataDir, 'commands.jsonl');
    const provider = join(dataDir, 'provider.mjs');
    writeFileSync(provider, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const emit = event => process.stdout.write(JSON.stringify({ protocol: 'botmux.remote-runner', version: 1, ...event }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(commandsPath)}, JSON.stringify(command) + '\\n');
  if (command.type === 'hello') emit({ type: 'hello', requestId: command.requestId, provider: 'test-provider', capabilities: ['start', 'resume', 'turn', 'cancel', 'detach', 'reattach', 'status'] });
  if (command.type === 'resume') emit({ type: 'ready', requestId: command.requestId, state: command.state });
  if (command.type === 'turn') emit({ type: 'status', requestId: command.requestId, status: 'busy' });
  if (command.type === 'cancel') emit({ type: 'status', requestId: command.requestId, status: 'closed' });
});
`);
    chmodSync(provider, 0o755);
    const controller = controllerForSession(ds, true)!;
    const operation = mode === 'dormant' ? controller.beginControl('close').operation : undefined;
    if (operation) controller.controlStarted(operation.operationId);
    const bootstrap = controller.bindWorker(1);
    ds.workerGeneration = ds.session.workerGeneration = 1;
    const init = {
      type: 'init', sessionId: ds.session.sessionId, chatId: ds.chatId,
      rootMessageId: ds.session.rootMessageId, workingDir: dataDir,
      cliId: 'remote-runner', cliPathOverride: provider, backendType: 'remote-runner',
      backendConfig: { expectedProvider: 'test-provider', operationTimeoutMs: 1000 },
      remoteBackendState: ds.session.remoteBackendState, prompt: '',
      larkAppId: 'app', larkAppSecret: 'test', sessionContract: bootstrap,
      ...(operation ? { sessionCommand: { version: 2 as const, operationId: operation.operationId } } : {}),
    } satisfies DaemonToWorker;
    ds.initConfig = init;
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'), env: { ...process.env, SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: join(dataDir, 'bots.json'), BOTMUX_SESSION_ID: ds.session.sessionId,
        LARK_APP_ID: 'app', LARK_APP_SECRET: 'test' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    ds.worker = child;
    const logs: string[] = [];
    child.stdout?.on('data', chunk => logs.push(String(chunk)));
    child.stderr?.on('data', chunk => logs.push(String(chunk)));
    child.on('message', message => logs.push(JSON.stringify(message)));
    __testOnly_setupWorkerHandlers(ds, child, undefined, 1);
    try {
      child.send(init);
      await vi.waitFor(() => expect(controller.store.read(controller.ref)?.workerOnline, logs.join('')).toBe(true), { timeout: 15_000 });
      if (mode === 'active') {
        controller.admitInput('active-turn', 1);
        child.send({ type: 'message', content: 'keep running', turnId: 'active-turn', dispatchAttempt: 1 });
        await vi.waitFor(() => expect(readFileSync(commandsPath, 'utf8')).toContain('"type":"turn"'));
      }
      const result = await closeSession(ds.session.sessionId);
      expect(result, logs.join('\n')).toMatchObject({ ok: true, outcome: 'closed' });
      const commands = readFileSync(commandsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(commands.map(command => command.type)).toContain('cancel');
      expect(commands.map(command => command.type)).not.toContain('start');
      if (mode !== 'active') expect(commands.map(command => command.type)).not.toContain('turn');
      expect(findActiveBySessionId(ds.session.sessionId)).toBeUndefined();
      expect(controller.store.read(controller.ref)?.lifecycle).toBe('closed');
      expect(sessionStore.getSession(ds.session.sessionId)?.status).toBe('closed');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('uses prepare/commit before publishing a live remote session closed', async () => {
    const { ds, worker } = createFixture(true);

    await expect(closeSession(ds.session.sessionId)).resolves.toMatchObject({
      ok: true,
      outcome: 'closed',
    });
    const sent = worker!.send.mock.calls.map(([message]) => message);
    const prepare = sent.find(message => message.type === 'close');
    expect(prepare?.requestId).toEqual(expect.any(String));
    expect(sent).toContainEqual({ type: 'close_commit', requestId: prepare.requestId });
    expect(sessionStore.getSession(ds.session.sessionId)?.status).toBe('closed');
    expect(sessionStore.getSession(ds.session.sessionId)?.remoteBackendState).toMatchObject({
      remoteSessionId: 'remote-1',
      agentThreadId: 'thread-1',
    });
  });

  it('allows a live pre-ready worker to close before backend state is persisted', async () => {
    const { ds } = createFixture(true);
    ds.workerReady = false;
    ds.session.remoteBackendState = undefined;
    sessionStore.updateSession(ds.session);

    const closing = closeSession(ds.session.sessionId);
    queueMicrotask(() => { ds.workerReady = true; });
    await expect(closing).resolves.toMatchObject({
      ok: true,
      outcome: 'closed',
    });
    expect(sessionStore.getSession(ds.session.sessionId)?.status).toBe('closed');
  });

  it('fails closed for a worker-less active row with opaque provider state', async () => {
    const { ds } = createFixture(false);
    __testOnly_setRemoteRunnerExplicitCloseWake(async () => false);

    await expect(closeSession(ds.session.sessionId)).resolves.toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'remote_runner_worker_missing',
      retryable: true,
      effect: 'not_dispatched',
    });
    expect(sessionStore.getSession(ds.session.sessionId)?.status).toBe('active');
  });

  it('wakes a control-only worker before closing a dormant remote session', async () => {
    const { ds } = createFixture(false);
    const wake = vi.fn(async (target: DaemonSession) => {
      const worker = createFakeWorker();
      target.worker = worker as never;
      target.workerReady = true;
      __testOnly_setupWorkerHandlers(target, worker as never);
      return true;
    });
    __testOnly_setRemoteRunnerExplicitCloseWake(wake);

    await expect(closeSession(ds.session.sessionId)).resolves.toMatchObject({
      ok: true,
      outcome: 'closed',
    });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(ds, expect.stringMatching(/^remote-runner-wake:/));
    expect(sessionStore.getSession(ds.session.sessionId)?.status).toBe('closed');
  });

  it('retires an exited provider so the next close can reconcile through a fresh control worker', async () => {
    const { ds, worker } = createFixture(true);

    worker!.emit('message', {
      type: 'claude_exit',
      code: 1,
      signal: null,
    });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect(ds.worker).toBeNull();
    expect(worker!.kill).toHaveBeenCalledWith('SIGTERM');

    const wake = vi.fn(async (target: DaemonSession) => {
      const replacement = createFakeWorker();
      target.worker = replacement as never;
      target.workerReady = true;
      __testOnly_setupWorkerHandlers(target, replacement as never);
      return true;
    });
    __testOnly_setRemoteRunnerExplicitCloseWake(wake);

    await expect(closeSession(ds.session.sessionId)).resolves.toMatchObject({
      ok: true,
      outcome: 'closed',
    });
    expect(wake).toHaveBeenCalledOnce();
    expect(sessionStore.getSession(ds.session.sessionId)?.status).toBe('closed');
  });

  it('clears an uncertain close fence when the provider exit arrives after the close result', async () => {
    const { ds, worker } = createFixture(true);
    worker!.send.mockImplementation((message: { type: string; requestId?: string }) => {
      if (message.type === 'close' && message.requestId) {
        queueMicrotask(() => worker!.emit('message', {
          type: 'close_result',
          requestId: message.requestId,
          ok: false,
          error: 'provider exited during close',
          recovery: 'uncertain',
        }));
      }
    });

    await expect(closeSession(ds.session.sessionId)).resolves.toMatchObject({
      ok: false,
      error: 'remote_runner_close_reconciliation_required',
      retryable: false,
      recovery: 'uncertain',
    });
    expect(ds.remoteCloseState?.phase).toBe('uncertain');

    worker!.emit('message', { type: 'claude_exit', code: 1, signal: null });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect(ds.worker).toBeNull();
    expect(ds.remoteCloseState).toBeUndefined();

    const wake = vi.fn(async (target: DaemonSession) => {
      const replacement = createFakeWorker();
      target.worker = replacement as never;
      target.workerReady = true;
      __testOnly_setupWorkerHandlers(target, replacement as never);
      return true;
    });
    __testOnly_setRemoteRunnerExplicitCloseWake(wake);

    await expect(closeSession(ds.session.sessionId)).resolves.toMatchObject({
      ok: true,
      outcome: 'closed',
    });
    expect(wake).toHaveBeenCalledOnce();
  });

  it('does not relatch uncertainty when the provider exits while close is preparing', async () => {
    const { ds, worker } = createFixture(true);
    worker!.send.mockImplementation((message: { type: string; requestId?: string }) => {
      if (message.type === 'close' && message.requestId) {
        expect(ds.remoteCloseState).toMatchObject({
          phase: 'preparing',
          requestId: message.requestId,
        });
        queueMicrotask(() => worker!.emit('message', {
          type: 'claude_exit',
          code: 1,
          signal: null,
        }));
      }
    });
    worker!.kill.mockImplementation(() => {
      queueMicrotask(() => worker!.emit('exit', 1, null));
      return true;
    });

    await expect(closeSession(ds.session.sessionId)).resolves.toMatchObject({
      ok: false,
      error: 'remote_runner_close_reconciliation_required',
      retryable: false,
      recovery: 'uncertain',
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(ds.worker).toBeNull();
    expect(ds.remoteCloseState).toBeUndefined();

    const wake = vi.fn(async (target: DaemonSession) => {
      const replacement = createFakeWorker();
      target.worker = replacement as never;
      target.workerReady = true;
      __testOnly_setupWorkerHandlers(target, replacement as never);
      return true;
    });
    __testOnly_setRemoteRunnerExplicitCloseWake(wake);

    await expect(closeSession(ds.session.sessionId)).resolves.toMatchObject({
      ok: true,
      outcome: 'closed',
    });
    expect(wake).toHaveBeenCalledOnce();
  });

  it('keeps a provider-proven retryable close active without latching a fence', async () => {
    const { ds, worker, controller } = canonicalFixture();
    worker!.send.mockImplementation((message: { type: string; requestId?: string }) => {
      if (message.type === 'close' && message.requestId) {
        queueMicrotask(() => worker!.emit('message', {
          type: 'close_result',
          requestId: message.requestId,
          ok: false,
          error: 'remote target remains live',
          recovery: 'retryable',
          admission: 'restorable',
        }));
      } else if (message.type === 'close_abort' && message.requestId) {
        queueMicrotask(() => worker!.emit('message', {
          type: 'close_abort_result',
          requestId: message.requestId,
          ok: true,
          admissionRestored: true,
        }));
      }
    });

    await expect(closeSession(ds.session.sessionId)).resolves.toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'remote_runner_worker_close_failed',
      retryable: true,
      effect: 'rejected',
      recovery: 'retryable',
    });
    expect(controller.store.read(controller.ref)?.lifecycle).toBe('active');
    expect(controller.allowsInput()).toBe(true);
    expect(ds.remoteCloseState).toBeUndefined();
    expect(sessionStore.getSession(ds.session.sessionId)?.status).toBe('active');
  });

  it('restores canonical admission after a proven pre-dispatch failure', async () => {
    const { ds, controller } = canonicalFixture(false, false);
    __testOnly_setRemoteRunnerExplicitCloseWake(async () => false);
    await expect(closeSession(ds.session.sessionId)).resolves.toMatchObject({
      ok: false, effect: 'not_dispatched', retryable: true,
    });
    expect(controller.store.read(controller.ref)).toMatchObject({ lifecycle: 'active' });
    expect(controller.allowsInput()).toBe(true);
    expect(ds.remoteCloseState).toBeUndefined();
  });

  it('reconciles a historical uncertain close only after a current worker ACK', async () => {
    const { ds, controller } = canonicalFixture();
    const { operation } = controller.beginControl('close');
    controller.controlStarted(operation.operationId);
    controller.controlResult(operation.operationId, 'uncertain', undefined, 'remote_runner_worker_missing');
    await expect(closeSession(ds.session.sessionId)).resolves.toMatchObject({ ok: true });
    expect(controller.store.read(controller.ref)?.lifecycle).toBe('closed');
    expect(controller.operation(operation.operationId)?.phase).toBe('confirmed');
  });

  it('waits for the real handshake while closing and never opens input', async () => {
    vi.useFakeTimers();
    try {
      const { ds, worker, controller, bootstrap } = canonicalFixture(false);
      const closing = closeSession(ds.session.sessionId);
      await vi.advanceTimersByTimeAsync(100);
      expect(worker!.send.mock.calls.some(([message]) => message.type === 'close')).toBe(false);
      controller.store.apply(controller.ref, { type: 'worker_online', worker: bootstrap.worker });
      expect(ds.workerReady).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      await expect(closing).resolves.toMatchObject({ ok: true });
    } finally { vi.useRealTimers(); }
  });

  it.each(['worker', 'generation', 'session', 'operation'] as const)(
    'rejects changed %s ownership while waiting for handshake', async change => {
      vi.useFakeTimers();
      try {
        const { ds, worker, controller, bootstrap } = canonicalFixture(false);
        const closing = closeSession(ds.session.sessionId);
        await vi.advanceTimersByTimeAsync(100);
        if (change === 'worker') ds.worker = createFakeWorker() as never;
        if (change === 'generation') ds.workerGeneration = (ds.workerGeneration ?? 0) + 1;
        if (change === 'session') ds.session = { ...ds.session, sessionId: 'replacement' };
        if (change === 'operation') {
          controller.controlResult(controller.operation()!.operationId, 'failed_before_effect');
          controller.beginControl('suspend');
        }
        controller.store.apply(controller.ref, { type: 'worker_online', worker: bootstrap.worker });
        await vi.advanceTimersByTimeAsync(100);
        await expect(closing).resolves.toMatchObject({ ok: false });
        expect(worker!.send.mock.calls.some(([message]) => message.type === 'close')).toBe(false);
      } finally { vi.useRealTimers(); }
    },
  );

  it('keeps a missing close ACK uncertain and preserves that evidence on retry', async () => {
    vi.useFakeTimers();
    try {
      const { ds, worker, controller } = canonicalFixture();
      worker!.send.mockImplementation(() => true);
      const closing = closeSession(ds.session.sessionId);
      await vi.advanceTimersByTimeAsync(35_100);
      await expect(closing).resolves.toMatchObject({ ok: false, effect: 'unknown', recovery: 'uncertain' });
      expect(controller.store.read(controller.ref)?.lifecycle).toBe('closing');
      expect(controller.operation()?.phase).toBe('uncertain');
      expect(controller.allowsInput()).toBe(false);
      // A retry with no worker is not proof the previous cancel never ran.
      ds.worker = null;
      ds.remoteCloseState = undefined;
      __testOnly_setRemoteRunnerExplicitCloseWake(async () => false);
      await closeSession(ds.session.sessionId);
      expect(controller.operation()?.phase).toBe('uncertain');
      expect(controller.allowsInput()).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('keeps a close left applying by a daemon crash fenced when the retry fails before dispatch', async () => {
    // The earlier daemon persisted the close as applying and died before any
    // result: its cancel may already have reached the provider.
    const first = canonicalFixture();
    const { operation } = first.controller.beginControl('close');
    first.controller.controlStarted(operation.operationId);
    // Restart: a fresh DaemonSession over the same durable contract, no worker.
    const ds = { ...first.ds, worker: null, remoteCloseState: undefined,
      initConfig: { backendType: 'remote-runner' } } as unknown as DaemonSession;
    setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
    const controller = controllerForSession(ds, true)!;
    __testOnly_setRemoteRunnerExplicitCloseWake(async () => false);
    await expect(closeSession(ds.session.sessionId)).resolves.toMatchObject({ ok: false, effect: 'not_dispatched' });
    expect(controller.store.read(controller.ref)?.lifecycle).toBe('closing');
    expect(controller.operation(operation.operationId)?.phase).toBe('uncertain');
    expect(controller.allowsInput()).toBe(false);
  });

  it('uses an empty, non-deferred resume fork for the control-only wake', async () => {
    const { ds } = createFixture(false);
    const fork = vi.fn((
      target: DaemonSession,
      prompt: unknown,
      resume: unknown,
      opts: { deferDuringDeviceIsolation?: boolean; onAdmission?: (value: 'accepted') => void },
    ) => {
      const worker = createFakeWorker();
      target.worker = worker as never;
      target.workerReady = true;
      opts.onAdmission?.('accepted');
      return true;
    });

    await expect(
      __testOnly_wakeRemoteRunnerWorkerForExplicitClose(ds, fork as never),
    ).resolves.toBe(true);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(fork.mock.calls[0]?.[1]).toBe('');
    expect(fork.mock.calls[0]?.[2]).toBe(true);
    expect(fork.mock.calls[0]?.[3]).toMatchObject({
      deferDuringDeviceIsolation: false,
      onAdmission: expect.any(Function),
    });
  });

  it('refuses a control-only wake while durable queued work is unsettled', async () => {
    const { ds } = createFixture(false);
    ds.session.queued = true;
    sessionStore.updateSession(ds.session);
    const fork = vi.fn(() => true);

    await expect(
      __testOnly_wakeRemoteRunnerWorkerForExplicitClose(ds, fork as never),
    ).resolves.toBe(false);
    expect(fork).not.toHaveBeenCalled();
    expect(ds.remoteCloseState).toBeUndefined();
  });

  it('clears the wake admission fence when control-worker materialization throws', async () => {
    const { ds } = createFixture(false);
    __testOnly_setRemoteRunnerExplicitCloseWake(async () => {
      throw new Error('wake exploded');
    });

    await expect(closeSession(ds.session.sessionId)).resolves.toEqual({
      ok: false,
      alreadyClosed: false,
      error: 'remote_runner_worker_missing',
      retryable: true,
      effect: 'not_dispatched',
    });
    expect(ds.remoteCloseState).toBeUndefined();
    expect(sessionStore.getSession(ds.session.sessionId)?.status).toBe('active');
  });
});
