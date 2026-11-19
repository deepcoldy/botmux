import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canStartInjectionFlush } from '../src/core/inject-queue-policy.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function makeWireHarness() {
  const h = workerSubmitHarness();
  Object.assign(h.scope, {
    cliLifetimeNonce: 'owned-runtime',
    webTerminalDirtyTarget: undefined,
    webTerminalInputGeneration: 0,
    openingInputBoxSettled: true,
    renderer: { markNewTurn: vi.fn() },
  });
  h.scope.webTerminalInputWireDirty = loadWorkerFunction<() => boolean>(
    'webTerminalInputWireDirty', h.scope,
  );
  h.scope.idleDetector.reset = vi.fn();
  h.scope.codexBridgeMarkPendingTurn = vi.fn(h.scope.codexBridgeMarkPendingTurn);
  const target = {
    backend: h.scope.backend,
    lifetime: h.scope.cliLifetimeNonce,
    generation: h.scope.cliSpawnGeneration,
  };
  const markDirty = () => { h.scope.webTerminalDirtyTarget = target; };
  return { ...h, target, markDirty };
}

function expectUnwritten(h: ReturnType<typeof makeWireHarness>) {
  expect(h.scope.backend).toBe(h.target.backend);
  expect(h.scope.cliLifetimeNonce).toBe(h.target.lifetime);
  expect(h.scope.cliSpawnGeneration).toBe(h.target.generation);
  // This intervention does not change the Web-input epoch or restart the CLI.
  expect(h.scope.webTerminalInputGeneration).toBe(0);
  expect(h.scope.webTerminalInputWireDirty()).toBe(true);
  expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
  expect(h.scope.setCaptureIdentity).not.toHaveBeenCalled();
  expect(h.scope.markActiveTurnStarted).not.toHaveBeenCalled();
  expect(h.scope.renderer.markNewTurn).not.toHaveBeenCalled();
  expect(h.scope.inflightInputs.onWrite).not.toHaveBeenCalled();
  expect(h.scope.noteCliInputWritten).not.toHaveBeenCalled();
  expect(h.scope.codexBridgeMarkPendingTurn).not.toHaveBeenCalled();
  expect(h.inputDeliveryEvidence.writeStartedAtMs({
    turnId: 'delivery', dispatchAttempt: 1, cliGeneration: h.target.generation,
  })).toBeUndefined();
  expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
  expect(h.scope.isFlushing).toBe(false);
}

function makeInjectionHarness() {
  const h = makeWireHarness();
  h.scope.pendingMessages.length = 0;
  const item = { command: '/compact', barrier: false };
  h.scope.pendingInjections.push(item);
  Object.assign(h.scope, {
    injectionFlushing: false,
    commandLineWritesPending: 0,
    bareShellLaunchBlocked: false,
    canStartInjectionFlush,
    revokePromptReadiness: vi.fn(() => { h.scope.isPromptReady = false; }),
    sendRawCommandLineWithRecoveryFence: vi.fn(async (_target: unknown, _command: string, beforeWrite?: () => void) => { beforeWrite?.(); }),
    awaitPtyQuiescence: vi.fn(async () => {}),
    STARTUP_CMD_QUIET_MS: 1,
    STARTUP_CMD_CAP_MS: 10,
  });
  const inject = loadWorkerFunction<() => Promise<void>>('flushPendingInjections', h.scope);
  return { ...h, item, inject };
}

describe('unconfirmed Web terminal wire state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('holds the queued input for the exact dirty CLI generation', async () => {
    const h = workerSubmitHarness();
    h.scope.cliLifetimeNonce = 'owned-runtime';
    h.scope.webTerminalDirtyTarget = {
      backend: h.scope.backend, lifetime: 'owned-runtime', generation: h.scope.cliSpawnGeneration,
    };
    const dirty = loadWorkerFunction<() => boolean>('webTerminalInputWireDirty', h.scope);
    expect(dirty()).toBe(true);
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages.map((item: { content: string }) => item.content)).toEqual(['payload']);
  });

  it.each(['backend', 'lifetime', 'generation'] as const)('does not apply an old dirty marker to a changed %s', field => {
    const backend = {};
    const scope: Record<string, unknown> = {
      backend, cliLifetimeNonce: 'owned', cliSpawnGeneration: 1,
      webTerminalDirtyTarget: { backend, lifetime: 'owned', generation: 1 },
    };
    const dirty = loadWorkerFunction<() => boolean>('webTerminalInputWireDirty', scope);
    expect(dirty()).toBe(true);
    if (field === 'backend') scope.backend = {};
    if (field === 'lifetime') scope.cliLifetimeNonce = 'replacement';
    if (field === 'generation') scope.cliSpawnGeneration = 2;
    expect(dirty()).toBe(false);
  });

  it.each([
    'codexModelMigrationAdmit',
    'postTerminalInputIsBlocked before lock',
    'postTerminalInputIsBlocked before dequeue',
    'detectBareShellLaunch',
    'runStartupCommands',
    'runInitialNativeRename',
    'admitTraexAutoModelPendingInput',
    'settleInputBox',
    'traexQuestionHoldsQueuedWrite',
  ] as const)('retains the exact queued item when the wire becomes dirty during %s', async phase => {
    const h = makeWireHarness();
    const head = h.scope.pendingMessages[0];
    const original = { ...head };
    const tail = { turnId: 'delivery-2', dispatchAttempt: 2, content: 'second payload' };
    h.scope.pendingMessages.push(tail);
    const entered = deferred<void>();
    const release = deferred<void>();
    const wait = vi.fn(async () => {
      entered.resolve(undefined);
      await release.promise;
      if (phase === 'codexModelMigrationAdmit') return 'proceed';
      return phase === 'runStartupCommands' || phase === 'admitTraexAutoModelPendingInput';
    });

    switch (phase) {
      case 'codexModelMigrationAdmit':
        h.scope.codexModelMigrationCheckNeeded = () => true;
        h.scope.codexModelMigrationAdmit = wait;
        break;
      case 'postTerminalInputIsBlocked before lock':
      case 'postTerminalInputIsBlocked before dequeue':
        h.scope.cliAdapter.postTerminalPromptFence = true;
        h.scope.postTerminalInputIsBlocked = phase === 'postTerminalInputIsBlocked before lock'
          ? wait
          : vi.fn().mockResolvedValueOnce(false).mockImplementation(wait);
        break;
      case 'detectBareShellLaunch':
        h.scope.bareShellChecked = false;
        h.scope.detectBareShellLaunch = wait;
        break;
      case 'runStartupCommands':
        h.scope.hasRunStartupCommands = false;
        h.scope.runStartupCommands = wait;
        h.scope.runInitialNativeRename = vi.fn(async () => {});
        break;
      case 'runInitialNativeRename':
        h.scope.hasRunStartupCommands = false;
        h.scope.runStartupCommands = vi.fn(async () => true);
        h.scope.runInitialNativeRename = wait;
        break;
      case 'admitTraexAutoModelPendingInput':
        h.scope.traexAutoModelRuntimeEligible = () => true;
        h.scope.admitTraexAutoModelPendingInput = wait;
        break;
      case 'settleInputBox':
        h.scope.openingInputBoxSettled = false;
        h.scope.inputBoxJudgeable = () => true;
        h.scope.cliAdapter.settleInputBox = wait;
        break;
      case 'traexQuestionHoldsQueuedWrite':
        h.scope.traexQuestionBridgeActive = () => true;
        h.scope.traexQuestionHoldsQueuedWrite = wait;
        h.scope.traexQuestionSubmitGuard = () => () => true;
        break;
    }

    expect(h.scope.webTerminalInputWireDirty()).toBe(false);
    const running = h.flush();
    await entered.promise;
    expect(wait).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages[0]).toBe(head);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    h.markDirty();
    release.resolve(undefined);
    await running;

    expectUnwritten(h);
    expect(h.scope.pendingMessages).toEqual([original, tail]);
    expect(h.scope.pendingMessages[0]).toBe(head);
    expect(h.scope.pendingMessages[1]).toBe(tail);
  });

  it('restores the dequeued item without attribution when dirty is observed by the final prepare callback', async () => {
    const h = makeWireHarness();
    const head = h.scope.pendingMessages[0];
    const original = { ...head };
    const tail = { turnId: 'delivery-2', dispatchAttempt: 2, content: 'second payload' };
    h.scope.pendingMessages.push(tail);
    const entered = deferred<void>();
    const release = deferred<void>();
    h.scope.runAmbiguousSubmissionTransaction = vi.fn(async (
      _target: unknown,
      write: () => Promise<unknown>,
      _accepted: unknown,
      prepare: () => void | Promise<void>,
    ) => {
      // Model waiting for the backend submission lock after takeNormal().
      entered.resolve(undefined);
      await release.promise;
      await prepare();
      return { result: await write() };
    });

    const running = h.flush();
    await entered.promise;
    expect(h.scope.runAmbiguousSubmissionTransaction).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages).toEqual([tail]);
    expect(h.scope.setCaptureIdentity).not.toHaveBeenCalled();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    h.markDirty();
    release.resolve(undefined);
    await running;

    expectUnwritten(h);
    expect(h.scope.pendingMessages).toEqual([original, tail]);
    expect(h.scope.pendingMessages[0]).toBe(head);
    expect(h.scope.pendingMessages[1]).toBe(tail);
    expect(h.scope.cliSubmissionInFlight).toBeNull();
    expect(h.scope.durableTurnInFlight).not.toBe(true);
  });

  it('allows an otherwise healthy queued input after model migration settles on a clean wire', async () => {
    const h = makeWireHarness();
    const release = deferred<void>();
    h.scope.codexModelMigrationCheckNeeded = () => true;
    h.scope.codexModelMigrationAdmit = vi.fn(async () => {
      await release.promise;
      return 'proceed';
    });
    const running = h.flush();
    expect(h.scope.codexModelMigrationAdmit).toHaveBeenCalledTimes(1);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    release.resolve(undefined);
    await running;
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.cliAdapter.writeInput.mock.calls[0][1]).toBe('payload');
    expect(h.scope.pendingMessages).toEqual([]);
    expect(h.scope.webTerminalInputWireDirty()).toBe(false);
  });

  it.each(['entry', 'detectBareShellLaunch', 'codexModelMigrationAdmit'] as const)(
    'keeps /compact queued with no raw writes when the wire becomes dirty at %s',
    async phase => {
      const h = makeInjectionHarness();
      const original = { ...h.item };
      const entered = deferred<void>();
      const release = deferred<void>();
      const wait = vi.fn(async () => {
        entered.resolve(undefined);
        await release.promise;
        return phase === 'codexModelMigrationAdmit' ? 'proceed' : false;
      });
      if (phase === 'entry') h.markDirty();
      if (phase === 'detectBareShellLaunch') {
        h.scope.bareShellChecked = false;
        h.scope.detectBareShellLaunch = wait;
      }
      if (phase === 'codexModelMigrationAdmit') {
        h.scope.codexModelMigrationCheckNeeded = () => true;
        h.scope.codexModelMigrationAdmit = wait;
      }

      const running = h.inject();
      if (phase !== 'entry') {
        await entered.promise;
        expect(wait).toHaveBeenCalledTimes(1);
        expect(h.scope.pendingInjections[0]).toBe(h.item);
        expect(h.scope.sendRawCommandLineWithRecoveryFence).not.toHaveBeenCalled();
        h.markDirty();
        release.resolve(undefined);
      }
      await running;

      expectUnwritten(h);
      expect(h.scope.pendingInjections).toEqual([original]);
      expect(h.scope.pendingInjections[0]).toBe(h.item);
      expect(h.scope.sendRawCommandLineWithRecoveryFence).not.toHaveBeenCalled();
      expect(h.scope.awaitPtyQuiescence).not.toHaveBeenCalled();
      expect(h.scope.revokePromptReadiness).not.toHaveBeenCalled();
      expect(h.scope.injectionFlushing).toBe(false);
    },
  );

  it('writes and consumes /compact normally for a clean CLI generation', async () => {
    const h = makeInjectionHarness();
    await h.inject();
    expect(h.scope.sendRawCommandLineWithRecoveryFence).toHaveBeenCalledExactlyOnceWith(
      h.target.backend, '/compact', expect.any(Function),
    );
    expect(h.scope.pendingInjections).toEqual([]);
    expect(h.scope.injectionFlushing).toBe(false);
    expect(h.scope.webTerminalInputWireDirty()).toBe(false);
  });

  it('restores the shifted injection when the wire turns dirty inside the write prepare callback', async () => {
    const h = makeInjectionHarness();
    const original = { ...h.item };
    // All outer gates pass on a clean wire; the dirty generation starts only
    // once the fenced write invokes its prepare callback, i.e. after shift().
    h.scope.sendRawCommandLineWithRecoveryFence = vi.fn(async (
      _target: unknown, _command: string, beforeWrite?: () => void,
    ) => { beforeWrite && (h.markDirty(), beforeWrite()); });
    await h.inject();
    // The write path was entered (this timing is past every outer gate)...
    expect(h.scope.sendRawCommandLineWithRecoveryFence).toHaveBeenCalledTimes(1);
    // ...but the prepare callback refused, so the shifted item must be
    // restored instead of being silently consumed on an uncertain wire.
    expect(h.scope.pendingInjections).toEqual([original]);
    expect(h.scope.pendingInjections[0]).toBe(h.item);
    expect(h.scope.awaitPtyQuiescence).not.toHaveBeenCalled();
    expect(h.scope.injectionFlushing).toBe(false);
    expect(h.scope.webTerminalInputWireDirty()).toBe(true);
  });
});
