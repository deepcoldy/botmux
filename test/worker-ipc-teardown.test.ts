import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsEval } from './helpers/ts-runner.js';
import { retireWorkerIpc } from './helpers/worker-ipc-teardown.js';

// A late reply to a worker the test already killed must not become an
// uncaught 'error' event. If the guard regresses these cases still pass their
// own assertions, but the run fails with the unhandled IPC error.
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

async function idleWorker(): Promise<ChildProcess> {
  const child = spawnTsEval('process.send?.({ ready: true }); setInterval(() => {}, 1000);',
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.push(child);
  await once(child, 'message');
  return child;
}

const deadOrZombie = (pid: number): boolean => {
  try { return /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
};

describe('retireWorkerIpc', () => {
  it.skipIf(process.platform !== 'linux')('drops the EPIPE of a reply racing the teardown kill', async () => {
    const child = await idleWorker();
    retireWorkerIpc(child);
    // child.once, not events.once: the latter rejects on 'error' and would
    // rethrow the very IPC error under test.
    const exited = new Promise(resolveExit => child.once('exit', resolveExit));
    child.kill('SIGKILL');
    // Do not yield: the parent has not read the EOF yet, so the channel still
    // looks connected while its peer is already gone.
    const deadline = Date.now() + 5_000;
    while (!deadOrZombie(child.pid!) && Date.now() < deadline) { /* spin */ }
    expect(child.connected).toBe(true);
    child.send({ type: 'late-reply' });
    await exited;
    await new Promise(resolve => setTimeout(resolve, 50));
  });

  it('drops a reply sent after the retired worker is gone', async () => {
    const child = await idleWorker();
    retireWorkerIpc(child);
    child.kill('SIGKILL');
    await once(child, 'exit');
    if (child.connected) await once(child, 'disconnect');
    child.send({ type: 'late-reply' });
    await new Promise(resolve => setTimeout(resolve, 50));
  });

  it('keeps every other worker error loud after retirement', async () => {
    const child = await idleWorker();
    retireWorkerIpc(child);
    retireWorkerIpc(child);
    expect(child.listenerCount('error')).toBe(1);
    expect(() => child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }))).toThrow('spawn failed');
    expect(() => child.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
  });
});
