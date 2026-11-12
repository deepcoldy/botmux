import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { writeRawCommandLine } from '../src/core/raw-command-writer.js';

describe('Dashboard goal controls preserve native turn ownership', () => {
  it.each([false, true])('keeps the active turn on a native control (failed write: %s)', async failed => {
    const writes: string[] = [];
    const scope: any = {
      backend: {
        sendText(text: string) { writes.push(text); return !failed; },
        sendSpecialKeys(key: string) { writes.push(key); return true; },
      },
      currentBotmuxTurnId: 'existing-turn', currentBotmuxDispatchAttempt: 4, currentBotmuxCallerOpenId: 'existing-caller',
      commandLineWritesPending: 0, commandLineWriteTail: Promise.resolve(),
      cliSpawnGeneration: 1, cliRestartInProgress: false, isPromptReady: true,
      idleDetector: { reset: vi.fn() }, flushPending: vi.fn(async () => {}),
      cliAdapter: {}, lastInitConfig: { cliId: 'traex' },
      rawCommandWriteOptionsFor: () => ({ delay: async () => {} }), writeRawCommandLine,
      markTurnRetired: vi.fn(), setCaptureIdentity: vi.fn(), send: vi.fn(), log: vi.fn(),
    };
    scope.sendRawCommandLine = loadWorkerFunction('sendRawCommandLine', scope);
    scope.runAmbiguousSubmissionTransaction = loadWorkerFunction('runAmbiguousSubmissionTransaction', scope);
    scope.sendRawCommandLineWithRecoveryFence = loadWorkerFunction('sendRawCommandLineWithRecoveryFence', scope);
    const deliver = loadWorkerFunction('deliverRawInput', scope);
    await deliver({ type: 'raw_input', content: '/goal pause', nativeGoalControl: true });
    expect(scope.markTurnRetired).not.toHaveBeenCalled();
    expect(scope.setCaptureIdentity).not.toHaveBeenCalled();
    expect([scope.currentBotmuxTurnId, scope.currentBotmuxDispatchAttempt, scope.currentBotmuxCallerOpenId])
      .toEqual(['existing-turn', 4, 'existing-caller']);
    expect(writes).toEqual(failed ? ['/goal pause'] : ['/goal pause', 'Enter']);
    if (failed) expect(scope.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'user_notify', turnId: 'existing-turn' }));
    expect(scope.isPromptReady).toBe(failed);
    expect(scope.flushPending).toHaveBeenCalledTimes(1);
  });

  it('withholds Enter and waiting controls when the CLI is replaced during a write', async () => {
    const writes: string[] = [];
    let release!: () => void;
    let typed!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const textWritten = new Promise<void>(resolve => { typed = resolve; });
    const target = {
      sendText(text: string) { writes.push(text); typed(); return true; },
      sendSpecialKeys(key: string) { writes.push(key); return true; },
    };
    const scope: any = {
      backend: target, cliSpawnGeneration: 1, cliRestartInProgress: false,
      currentBotmuxTurnId: 'existing-turn', commandLineWritesPending: 0, commandLineWriteTail: Promise.resolve(),
      rawCommandWriteOptionsFor: () => ({ delay: () => waiting }), writeRawCommandLine,
      cliAdapter: {}, lastInitConfig: { cliId: 'traex' }, idleDetector: { reset: vi.fn() },
      flushPending: vi.fn(async () => {}), send: vi.fn(), log: vi.fn(),
    };
    for (const name of ['sendRawCommandLine', 'runAmbiguousSubmissionTransaction', 'sendRawCommandLineWithRecoveryFence']) {
      scope[name] = loadWorkerFunction(name, scope);
    }
    const deliver = loadWorkerFunction('deliverRawInput', scope);
    const pause = deliver({ type: 'raw_input', content: '/goal pause', nativeGoalControl: true });
    await textWritten;
    const resume = deliver({ type: 'raw_input', content: '/goal resume', nativeGoalControl: true });
    scope.backend = { sendText: vi.fn(), sendSpecialKeys: vi.fn() };
    scope.cliSpawnGeneration = 2;
    scope.cliRestartInProgress = true;
    release();
    await Promise.all([pause, resume]);
    expect(writes).toEqual(['/goal pause']);
    expect(scope.backend.sendText).not.toHaveBeenCalled();
    expect(scope.flushPending).toHaveBeenCalledTimes(2);
    expect(scope.idleDetector.reset).not.toHaveBeenCalled();
  });

  it('does not reset readiness of a replacement installed after Enter', async () => {
    const scope: any = {
      cliSpawnGeneration: 1, cliRestartInProgress: false, isPromptReady: true,
      idleDetector: { reset: vi.fn() }, flushPending: vi.fn(async () => {}),
      currentBotmuxTurnId: 'old-turn', lastInitConfig: { cliId: 'traex' }, cliAdapter: {},
      commandLineWriteTail: Promise.resolve(), commandLineWritesPending: 0,
      rawCommandWriteOptionsFor: () => ({ delay: async () => {} }), writeRawCommandLine, log: vi.fn(), send: vi.fn(),
    };
    scope.backend = {
      sendText: () => true,
      sendSpecialKeys() { scope.backend = {}; scope.cliSpawnGeneration = 2; scope.isPromptReady = true; return true; },
    };
    for (const name of ['sendRawCommandLine', 'runAmbiguousSubmissionTransaction', 'sendRawCommandLineWithRecoveryFence']) {
      scope[name] = loadWorkerFunction(name, scope);
    }
    await loadWorkerFunction('deliverRawInput', scope)({ type: 'raw_input', content: '/goal pause', nativeGoalControl: true });
    expect(scope.cliSpawnGeneration).toBe(2);
    expect(scope.isPromptReady).toBe(true);
    expect(scope.idleDetector.reset).not.toHaveBeenCalled();
  });
});
