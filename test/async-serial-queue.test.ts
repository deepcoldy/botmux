import { describe, expect, it } from 'vitest';
import {
  runAdoptQueuedWriteSequence,
  runAdoptRawInputSequence,
  runAdoptSessionRenameSequence,
} from '../src/services/adopt-input-sequence.js';
import { AsyncSerialQueue } from '../src/utils/async-serial-queue.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AsyncSerialQueue', () => {
  it('does not start a second adopt write until the first paste/verify cycle settles', async () => {
    const queue = new AsyncSerialQueue();
    const firstGate = deferred<void>();
    const order: string[] = [];
    let composer = '';
    const submitted: string[] = [];

    const first = queue.run(async () => {
      order.push('first:paste');
      composer = 'first prompt';
      await firstGate.promise;
      submitted.push(composer);
      order.push('first:verified');
      return 'first-result';
    });
    const second = queue.run(async () => {
      order.push('second:paste');
      composer = 'second prompt';
      submitted.push(composer);
      order.push('second:verified');
      return 'second-result';
    });

    await Promise.resolve();
    expect(order).toEqual(['first:paste']);
    firstGate.resolve();

    await expect(first).resolves.toBe('first-result');
    await expect(second).resolves.toBe('second-result');
    expect(order).toEqual([
      'first:paste',
      'first:verified',
      'second:paste',
      'second:verified',
    ]);
    expect(submitted).toEqual(['first prompt', 'second prompt']);
  });

  it('releases the next write after a prior write rejects', async () => {
    const queue = new AsyncSerialQueue();
    const gate = deferred<void>();
    const order: string[] = [];
    const first = queue.run(async () => {
      order.push('first:start');
      await gate.promise;
      throw new Error('write failed');
    });
    const second = queue.run(async () => {
      order.push('second:start');
      return 'recovered';
    });

    await Promise.resolve();
    gate.resolve();
    await expect(first).rejects.toThrow('write failed');
    await expect(second).resolves.toBe('recovered');
    expect(order).toEqual(['first:start', 'second:start']);
  });

  it('holds a bundled raw follow-up through adapter settlement before the next adopt write', async () => {
    const queue = new AsyncSerialQueue();
    const followUpStarted = deferred<void>();
    const followUpVerification = deferred<void>();
    const order: string[] = [];
    const submitted: string[] = [];
    let composer = '';

    const rawAndFollowUp = runAdoptRawInputSequence({
      queue,
      writeRawInput: async () => {
        composer = '/model';
        order.push('raw:enter');
        submitted.push(composer);
        composer = '';
        return true;
      },
      writeFollowUp: async () => {
        composer = 'bundled follow-up';
        order.push('follow-up:paste');
        followUpStarted.resolve();
        await followUpVerification.promise;
        submitted.push(composer);
        order.push('follow-up:settled');
      },
    });
    const nextMessage = queue.run(async () => {
      composer = 'next adopt message';
      order.push('next:paste');
      submitted.push(composer);
      order.push('next:settled');
    });

    await followUpStarted.promise;
    expect(order).toEqual(['raw:enter', 'follow-up:paste']);
    expect(composer).toBe('bundled follow-up');

    followUpVerification.resolve();
    await Promise.all([rawAndFollowUp, nextMessage]);
    expect(order).toEqual([
      'raw:enter',
      'follow-up:paste',
      'follow-up:settled',
      'next:paste',
      'next:settled',
    ]);
    expect(submitted).toEqual(['/model', 'bundled follow-up', 'next adopt message']);
  });

  it('does not write the bundled follow-up when the raw command was not sent', async () => {
    const queue = new AsyncSerialQueue();
    const order: string[] = [];

    await runAdoptRawInputSequence({
      queue,
      writeRawInput: async () => {
        order.push('raw:failed');
        return false;
      },
      writeFollowUp: async () => {
        order.push('follow-up:must-not-run');
      },
    });

    expect(order).toEqual(['raw:failed']);
  });

  it('requeues an untouched adopt write when its captured generation is stale at dequeue', async () => {
    const queue = new AsyncSerialQueue();
    const priorGate = deferred<void>();
    let generation = 1;
    const order: string[] = [];
    const prior = queue.run(async () => {
      order.push('prior:start');
      await priorGate.promise;
      order.push('prior:end');
    });
    const queued = runAdoptQueuedWriteSequence({
      queue,
      isCurrent: () => generation === 1,
      write: async () => {
        order.push('stale:must-not-write');
      },
      onStale: () => {
        order.push('stale:requeued');
      },
    });

    await Promise.resolve();
    generation = 2;
    priorGate.resolve();
    await prior;
    await expect(queued).resolves.toEqual({ status: 'stale-before-write' });
    expect(order).toEqual(['prior:start', 'prior:end', 'stale:requeued']);
  });

  it('withholds a dependent bundled follow-up when generation changes after raw Enter', async () => {
    const queue = new AsyncSerialQueue();
    let current = true;
    const order: string[] = [];

    await runAdoptRawInputSequence({
      queue,
      isCurrent: () => current,
      writeRawInput: async () => {
        order.push('raw:enter');
        current = false;
        return true;
      },
      writeFollowUp: async () => {
        order.push('follow-up:must-not-write');
      },
      onStaleBeforeFollowUp: () => {
        order.push('follow-up:withheld-notified');
      },
    });

    expect(order).toEqual(['raw:enter', 'follow-up:withheld-notified']);
  });

  it('rechecks prompt readiness after prior adopt writes before native rename', async () => {
    const queue = new AsyncSerialQueue();
    const priorWriteGate = deferred<void>();
    const order: string[] = [];
    let promptReady = true;

    const priorWrite = queue.run(async () => {
      order.push('message:start');
      await priorWriteGate.promise;
      promptReady = false;
      order.push('message:submitted');
    });
    const staleRenameAttempt = runAdoptSessionRenameSequence({
      queue,
      isPromptReady: () => promptReady,
      writeRename: async () => {
        order.push('rename:must-not-run');
      },
    });

    await Promise.resolve();
    expect(order).toEqual(['message:start']);
    priorWriteGate.resolve();
    await priorWrite;
    await expect(staleRenameAttempt).resolves.toBe(false);
    expect(order).toEqual(['message:start', 'message:submitted']);

    promptReady = true;
    await expect(runAdoptSessionRenameSequence({
      queue,
      isPromptReady: () => promptReady,
      writeRename: async () => {
        order.push('rename:enter');
      },
    })).resolves.toBe(true);
    expect(order).toEqual(['message:start', 'message:submitted', 'rename:enter']);
  });

  it('starts rename only after a queued fast-final write has restored readiness', async () => {
    const queue = new AsyncSerialQueue();
    const priorAdapterGate = deferred<void>();
    const renameWriteGate = deferred<void>();
    const order: string[] = [];
    let promptReady = false;
    let renamePhase: 'reserved' | 'writing' | 'sent' | 'idle' = 'reserved';

    const priorWrite = queue.run(async () => {
      order.push('message:adapter-wait');
      await priorAdapterGate.promise;
      // Models assistant_final/prompt-ready arriving before writeInput returns.
      promptReady = true;
      order.push('message:fast-final');
    });
    const rename = runAdoptSessionRenameSequence({
      queue,
      isPromptReady: () => promptReady,
      writeRename: async () => {
        promptReady = false;
        renamePhase = 'writing';
        order.push('rename:text-to-enter-window');
        await renameWriteGate.promise;
        renamePhase = 'sent';
        order.push('rename:enter-landed');
      },
    });

    await Promise.resolve();
    expect(renamePhase).toBe('reserved');
    priorAdapterGate.resolve();
    await priorWrite;
    await Promise.resolve();
    expect(order).toEqual(['message:adapter-wait', 'message:fast-final', 'rename:text-to-enter-window']);
    expect(promptReady).toBe(false);
    expect(renamePhase).toBe('writing');

    // A terminal belonging to the previous model turn may arrive during the
    // rename's 200ms text→Enter beat. Only `sent` may release the gate.
    if (renamePhase === 'sent') renamePhase = 'idle';
    expect(renamePhase).toBe('writing');

    renameWriteGate.resolve();
    await expect(rename).resolves.toBe(true);
    // Command write completion alone does not represent the second prompt.
    expect(renamePhase).toBe('sent');
    expect(order).toEqual([
      'message:adapter-wait',
      'message:fast-final',
      'rename:text-to-enter-window',
      'rename:enter-landed',
    ]);
  });
});
