import type { ChildProcess } from 'node:child_process';
import type { WorkerToDaemon } from '../../src/types.js';

/** Wait on the child's IPC events instead of racing a polling timer against them.
 * The collected array closes the gap between process launch and subscribing here;
 * workers that report an error or exit before the expected message fail fast. */
export function waitForWorkerMessage<T extends WorkerToDaemon['type']>(
  child: ChildProcess,
  messages: readonly WorkerToDaemon[],
  type: T,
  logs: readonly string[],
  timeoutMs: number,
): Promise<Extract<WorkerToDaemon, { type: T }>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const diagnostics = () => `${JSON.stringify(messages)}\n${logs.join('')}`;
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onChildError);
    };
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const onMessage = (raw: unknown) => {
      const message = raw as WorkerToDaemon;
      if (message.type === type) {
        finish(() => resolvePromise(message as Extract<WorkerToDaemon, { type: T }>));
      } else if (message.type === 'error' && type !== 'error') {
        finish(() => rejectPromise(new Error(
          `worker error before ${type}: ${message.message}\n${diagnostics()}`,
        )));
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() => rejectPromise(new Error(
        `worker exited before ${type} (code=${code}, signal=${signal})\n${diagnostics()}`,
      )));
    };
    const onChildError = (error: Error) => {
      finish(() => rejectPromise(new Error(
        `worker process error before ${type}: ${error.message}\n${diagnostics()}`,
      )));
    };
    const timer = setTimeout(() => {
      finish(() => rejectPromise(new Error(
        `timed out after ${timeoutMs}ms waiting for ${type}\n${diagnostics()}`,
      )));
    }, timeoutMs);

    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onChildError);
    for (const message of messages) {
      onMessage(message);
      if (settled) break;
    }
    if (!settled && (child.exitCode !== null || child.signalCode !== null)) {
      onExit(child.exitCode, child.signalCode);
    }
  });
}
