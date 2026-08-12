import { describe, it, expect, afterEach } from 'vitest';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { waitAllWithin, trackProducerQuiet } from '../src/core/producer-quiescence.ts';

// Real forked children so the fence is exercised against actual IPC
// 'disconnect' / 'close' / 'exit' event ordering — not mocks. The real shutdown
// path is the PARENT killing the worker (SIGTERM/SIGKILL), which closes the IPC
// channel (disconnect ~1ms) independently of stdio 'close'.

const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) { try { k.kill('SIGKILL'); } catch { /* */ } }
});

/** Fork a child with an IPC channel, optionally spawning a grandchild that
 *  inherits its stdout to delay the child's 'close' (but not 'disconnect'). */
function forkChild(opts: { holdStdoutMs?: number } = {}): ChildProcess {
  const src = `
    const cp = require('node:child_process');
    ${opts.holdStdoutMs ? `
    // Grandchild inherits our stdout pipe and holds it open, delaying our 'close'
    // (but NOT our IPC 'disconnect') — the exact scenario the fence must survive.
    cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, ${opts.holdStdoutMs})'], { stdio: ['ignore', 'inherit', 'ignore'] });
    ` : ''}
    setInterval(() => {}, 100000);
  `;
  const child = fork(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  kids.push(child);
  return child;
}

describe('producer-quiescence fence (real ChildProcess)', () => {
  it('resolves on IPC disconnect promptly after SIGTERM, without waiting for close/stdio', async () => {
    const child = forkChild({ holdStdoutMs: 1500 }); // grandchild holds stdout ~1.5s
    await new Promise(r => child.once('spawn', r));
    expect(child.connected).toBe(true);
    const { alreadyQuiet, done } = trackProducerQuiet(child as any);
    expect(alreadyQuiet).toBe(false);

    let closeSeen = false;
    child.once('close', () => { closeSeen = true; });

    const t0 = Date.now();
    child.kill('SIGTERM');            // real shutdown path: parent kills worker
    await done;                       // fence resolves on disconnect
    const elapsed = Date.now() - t0;

    // Disconnect fence resolves ~immediately, long before the grandchild releases
    // stdout (what 'close' waits for). Generous bound to avoid CI flakiness.
    expect(elapsed).toBeLessThan(800);
    expect(closeSeen).toBe(false);    // proves we did NOT wait on close
  });

  it('resolves on IPC disconnect ALONE — a detached-but-alive worker (no exit/close) still quiesces the fence', async () => {
    // The daemon "detach" disposition kills the worker's IPC but the underlying
    // process (multiplexer pane) may keep running: 'exit'/'close' never fire, so
    // the fence MUST key on 'disconnect'. This is the scenario that proves the
    // disconnect listener is load-bearing (removing it hangs the fence).
    const child = forkChild();
    await new Promise(r => child.once('spawn', r));
    expect(child.connected).toBe(true);
    const { alreadyQuiet, done } = trackProducerQuiet(child as any);
    expect(alreadyQuiet).toBe(false);

    let exitSeen = false;
    child.once('exit', () => { exitSeen = true; });

    child.disconnect();  // sever IPC only; worker process stays alive
    const resolved = await Promise.race([
      done!.then(() => true),
      new Promise<boolean>(r => setTimeout(() => r(false), 1500)),
    ]);
    expect(resolved).toBe(true);   // fence resolved on disconnect alone
    expect(exitSeen).toBe(false);  // worker never exited — only disconnect fired
    child.kill('SIGKILL');
  });

  it('resolves when a worker is SIGKILLed (channel goes away)', async () => {
    const child = forkChild();
    await new Promise(r => child.once('spawn', r));
    const { alreadyQuiet, done } = trackProducerQuiet(child as any);
    expect(alreadyQuiet).toBe(false);
    child.kill('SIGKILL');
    // The meaningful assertion is that the fence RESOLVES after SIGKILL (channel
    // torn down by death) within a bound — not the exact `connected` value at the
    // resolving tick, which can still momentarily read stale.
    const resolved = await Promise.race([
      done!.then(() => true),
      new Promise<boolean>(r => setTimeout(() => r(false), 2000)),
    ]);
    expect(resolved).toBe(true);
  });

  it('reports already-quiet for a worker whose channel is already gone (no hang)', async () => {
    const child = forkChild();
    await new Promise(r => child.once('spawn', r));
    child.kill('SIGTERM');
    await new Promise<void>(r => child.once('disconnect', () => r()));
    expect(child.connected).not.toBe(true);
    // Channel already gone before we track → alreadyQuiet, no promise to await.
    const { alreadyQuiet, done } = trackProducerQuiet(child as any);
    expect(alreadyQuiet).toBe(true);
    expect(done).toBeUndefined();
  });

  it('treats a live worker with no IPC channel as already quiet (no terminal source)', async () => {
    // No IPC channel → the worker cannot send a turn_terminal message at all, so
    // it is quiescent for terminal purposes regardless of being alive.
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 100000)'], { stdio: 'ignore' });
    kids.push(child);
    await new Promise(r => child.once('spawn', r));
    expect(child.connected).not.toBe(true);
    const { alreadyQuiet } = trackProducerQuiet(child as any);
    expect(alreadyQuiet).toBe(true);
    child.kill('SIGKILL');
  });

  it('waitAllWithin returns true when all settle before the deadline, false on timeout', async () => {
    const fast = [new Promise(r => setTimeout(r, 20)), new Promise(r => setTimeout(r, 30))];
    expect(await waitAllWithin(fast, Date.now() + 500)).toBe(true);

    const slow = [new Promise(r => setTimeout(r, 5000))];
    const t0 = Date.now();
    expect(await waitAllWithin(slow, Date.now() + 100)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000); // bounded by the deadline, not the promise
  });

  it('waitAllWithin returns true immediately for an empty set and false for a zero budget', async () => {
    expect(await waitAllWithin([], Date.now() + 100)).toBe(true);
    expect(await waitAllWithin([new Promise(() => { /* never */ })], Date.now() - 1)).toBe(false);
  });
});
