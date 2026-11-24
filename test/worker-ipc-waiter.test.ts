import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { WorkerToDaemon } from '../src/types.js';
import { waitForWorkerMessage } from './helpers/worker-ipc-waiter.js';

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

describe('waitForWorkerMessage', () => {
  it('replays a message collected before subscribing and removes its listeners', async () => {
    const child = fakeChild();
    const message = { type: 'worker_fatal', message: 'boom' } satisfies WorkerToDaemon;
    const pending = waitForWorkerMessage(child, [message], 'worker_fatal', [], 100);

    await expect(pending).resolves.toBe(message);
    expect(child.listenerCount('message')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  });

  it('resolves directly from the IPC event', async () => {
    const child = fakeChild();
    const pending = waitForWorkerMessage(child, [], 'ready', [], 100);
    const ready = { type: 'ready', port: 40993 };

    child.emit('message', ready);
    await expect(pending).resolves.toBe(ready);
    expect(child.listenerCount('message')).toBe(0);
  });

  it('rejects on child exit without waiting for the deadline', async () => {
    const child = fakeChild();
    const pending = waitForWorkerMessage(child, [], 'ready', [], 100);

    child.exitCode = 1;
    child.emit('exit', 1, null);
    await expect(pending).rejects.toThrow('worker exited before ready');
    expect(child.listenerCount('message')).toBe(0);
  });

  it('still times out when the worker never produces the message', async () => {
    const child = fakeChild();
    const pending = waitForWorkerMessage(child, [], 'ready', ['worker log'], 10);
    const rejection = expect(pending).rejects.toThrow('timed out');

    await rejection;
    expect(child.listenerCount('message')).toBe(0);
  });
});
