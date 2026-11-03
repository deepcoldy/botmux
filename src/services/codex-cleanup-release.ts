import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface CodexCleanupRelease {
  sessionId: string;
  threadId: string;
  workerGeneration: number;
  nonce: string;
}
export interface CodexCleanupReleaseTicket {
  request: CodexCleanupRelease;
  released: Promise<CodexCleanupRelease>;
}

/** A clean wrapper exit is NOT native release. Only a matching proof from the
 * exact IPC child that received this close can discharge the native lifetime. */
export function captureCodexCleanupRelease(worker: ChildProcess, identity: Omit<CodexCleanupRelease, 'nonce'>,
  timeoutMs = 5_000): CodexCleanupReleaseTicket {
  const request = { ...identity, nonce: randomUUID() };
  const released = new Promise<CodexCleanupRelease>((resolve, reject) => {
    const finish = (error?: string) => {
      clearTimeout(timer); worker.off('message', message); worker.off('exit', exited);
      if (error) reject(new Error(error)); else resolve(request);
    };
    const message = (value: any) => {
      if (value?.type !== 'codex_cleanup_released' || value.nonce !== request.nonce
          || value.sessionId !== request.sessionId || value.threadId !== request.threadId
          || value.workerGeneration !== request.workerGeneration) return;
      finish(value.released === true ? undefined : 'codex_native_release_unverified');
    };
    const exited = () => finish('codex_native_release_unverified');
    const timer = setTimeout(() => finish('codex_native_release_timeout'), timeoutMs);
    worker.on('message', message); worker.once('exit', exited);
    if (worker.exitCode != null || worker.signalCode != null) exited();
  });
  void released.catch(() => undefined);
  return { request, released };
}
