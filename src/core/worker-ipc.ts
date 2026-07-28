import type { ChildProcess } from 'node:child_process';
import type { DaemonToWorker } from '../types.js';

/**
 * Resolve only after Node confirms that an IPC message was sent.
 *
 * ChildProcess.send() returning false is not itself a delivery failure: it can
 * mean the message is queued behind IPC backpressure. The callback is the
 * authoritative success/error signal.
 */
export function sendWorkerIpc(
  worker: ChildProcess,
  message: DaemonToWorker,
): Promise<void> {
  if (worker.killed || worker.connected === false) {
    return Promise.reject(new Error('worker IPC channel is not connected'));
  }

  return new Promise((resolve, reject) => {
    try {
      worker.send(message, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}
