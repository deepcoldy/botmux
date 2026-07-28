import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { sendWorkerIpc } from '../src/core/worker-ipc.js';

describe('sendWorkerIpc', () => {
  it('treats send() false plus a successful callback as IPC backpressure, not failure', async () => {
    const send = vi.fn((_message, callback) => {
      callback(null);
      return false;
    });
    const worker = { killed: false, connected: true, send } as unknown as ChildProcess;

    await expect(sendWorkerIpc(worker, { type: 'refresh_screen' })).resolves.toBeUndefined();
  });

  it('rejects an asynchronous IPC delivery error', async () => {
    const failure = new Error('channel closed');
    const send = vi.fn((_message, callback) => {
      callback(failure);
      return false;
    });
    const worker = { killed: false, connected: true, send } as unknown as ChildProcess;

    await expect(sendWorkerIpc(worker, { type: 'refresh_screen' })).rejects.toThrow('channel closed');
  });

  it('rejects a synchronous send throw', async () => {
    const send = vi.fn(() => { throw new Error('send threw'); });
    const worker = { killed: false, connected: true, send } as unknown as ChildProcess;

    await expect(sendWorkerIpc(worker, { type: 'refresh_screen' })).rejects.toThrow('send threw');
  });

  it('fails before send when the IPC channel is disconnected', async () => {
    const send = vi.fn();
    const worker = { killed: false, connected: false, send } as unknown as ChildProcess;

    await expect(sendWorkerIpc(worker, { type: 'refresh_screen' })).rejects.toThrow('not connected');
    expect(send).not.toHaveBeenCalled();
  });
});
