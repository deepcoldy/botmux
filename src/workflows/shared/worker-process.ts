/** Engine-neutral process primitives for short-lived workflow workers. */

import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { WorkerToDaemon } from '../../types.js';

type WindowsForkOptions = ForkOptions & { windowsHide?: boolean };

export interface WorkerHandle {
  send(msg: unknown): void;
  on(event: 'message', cb: (msg: WorkerToDaemon) => void): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
  /** ChildProcess `close` is the outer-process resource fence. Unlike `exit`,
   * it is also emitted after a spawn `error` once stdio/IPC are closed. */
  on(event: 'close', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
  readonly pid?: number;
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
}

export interface WorkerProcessFactory {
  spawn(opts: WorkerSpawnOptions): WorkerHandle;
}

export type WorkerSpawnOptions = {
  workerPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/** Default factory: real `node:child_process.fork` against `worker.js`. */
export const forkWorkerJsFactory: WorkerProcessFactory = {
  spawn(opts) {
    const child: ChildProcess = fork(opts.workerPath, [], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      cwd: opts.cwd,
      env: opts.env,
    } as WindowsForkOptions);
    return {
      send: (message) => child.send(message as never),
      on: (event: string, cb: (...args: unknown[]) => void) => {
        child.on(event as never, cb);
      },
      kill: (signal) => {
        // `child.killed` flips to true when kill(2) is *sent*, not when the
        // process exits. Using it as a guard suppresses TERM/KILL escalation
        // after an ignored SIGINT. Only an observed exit is terminal.
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      },
      get pid() {
        return child.pid;
      },
      get stdout() {
        return child.stdout;
      },
      get stderr() {
        return child.stderr;
      },
    } as WorkerHandle;
  },
};

export function expandWorkflowWorkingDir(workingDir: string | undefined): string | undefined {
  if (!workingDir) return undefined;
  if (workingDir === '~') return homedir();
  if (workingDir.startsWith('~/')) return join(homedir(), workingDir.slice(2));
  return workingDir;
}

/** Deterministically map any string id to a UUID-v4-shaped hex token. */
export function syntheticSessionUuid(rawId: string): string {
  const hash = createHash('sha256').update(rawId).digest('hex');
  const version = `4${hash.slice(13, 16)}`;
  const variantNibble = ((parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16);
  const variant = `${variantNibble}${hash.slice(17, 20)}`;
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${version}-${variant}-${hash.slice(20, 32)}`;
}
