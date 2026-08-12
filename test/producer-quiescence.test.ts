import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { waitAllWithin, trackProducerQuiet, type ProducerHandle } from '../src/core/producer-quiescence.ts';

// Real child processes so the fence is exercised against actual IPC
// 'disconnect' / 'close' / 'exit' ordering, PLUS a controlled fake ProducerHandle
// for the states a real process makes hard to stage deterministically
// (killed=true && connected=true; exit observed while connected still true).

const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) { try { k.kill('SIGKILL'); } catch { /* */ } }
});

/**
 * Spawn a real child WITH an IPC channel (stdio incl. 'ipc'), running an inline
 * script via `-e`. NOTE: this uses spawn(process.execPath, ['-e', src]) — NOT
 * fork(process.execPath, ...), which would treat the node binary as a module
 * path and never run `src`. The child sends {ready:true} over IPC; callers MUST
 * await ready before acting, so the scenario is provably set up.
 */
async function spawnChild(opts: { holdStdoutMs?: number } = {}): Promise<ChildProcess> {
  const src = `
    const cp = require('node:child_process');
    ${opts.holdStdoutMs ? `
    // Grandchild inherits our stdout pipe and holds it open, delaying OUR 'close'
    // (but not our IPC 'disconnect') — the fd-inheritance scenario.
    cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, ${opts.holdStdoutMs})'], { stdio: ['ignore', 'inherit', 'ignore'] });
    ` : ''}
    process.send && process.send({ ready: true });
    setInterval(() => {}, 100000);
  `;
  const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  kids.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child never sent ready')), 5000);
    child.once('message', (m: any) => { if (m && m.ready) { clearTimeout(timer); resolve(); } });
    child.once('error', reject);
  });
  return child;
}

/** Controlled ProducerHandle: drive connected/exit/disconnect deterministically. */
function fakeProducer(initial: { connected: boolean }): ProducerHandle & { emit: (e: string) => void; set: (c: Partial<{ connected: boolean; exitCode: number | null; signalCode: NodeJS.Signals | null }>) => void } {
  const ee = new EventEmitter();
  const state = { connected: initial.connected, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
  return {
    get connected() { return state.connected; },
    get exitCode() { return state.exitCode; },
    get signalCode() { return state.signalCode; },
    once(event: string, listener: (...a: unknown[]) => void) { ee.once(event, listener); return this as unknown; },
    emit(event: string) { ee.emit(event); },
    set(c) { Object.assign(state, c); },
  };
}

describe('producer-quiescence fence (real ChildProcess)', () => {
  it('the spawn helper truly runs the inline script (guards against fork-modulePath false coverage)', async () => {
    let stdout = '';
    const child = await spawnChild();
    child.stdout?.on('data', d => { stdout += d; });
    // The child sent {ready:true} over IPC (awaited in spawnChild) — proof the
    // script executed. (fork(execPath,['-e',src]) would never have run it.)
    expect(child.connected).toBe(true);
    child.kill('SIGKILL');
  });

  it('resolves on IPC disconnect promptly after SIGTERM, without waiting for close/stdio', async () => {
    const child = await spawnChild({ holdStdoutMs: 1500 }); // grandchild holds stdout ~1.5s
    expect(child.connected).toBe(true);
    const { alreadyQuiet, done } = trackProducerQuiet(child as ProducerHandle);
    expect(alreadyQuiet).toBe(false);
    let closeSeen = false;
    child.once('close', () => { closeSeen = true; });

    const t0 = Date.now();
    child.kill('SIGTERM');
    await done;
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(800);   // resolved on disconnect, not close(~1.5s)
    expect(closeSeen).toBe(false);       // proves we did NOT wait on close
    child.kill('SIGKILL');
  });

  it('resolves on IPC disconnect ALONE — detached-but-alive worker (no exit/close) still quiesces', async () => {
    const child = await spawnChild();
    expect(child.connected).toBe(true);
    const { done } = trackProducerQuiet(child as ProducerHandle);
    let exitSeen = false;
    child.once('exit', () => { exitSeen = true; });
    child.disconnect();                  // sever IPC only; process stays alive
    const resolved = await Promise.race([done!.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 1500))]);
    expect(resolved).toBe(true);
    expect(exitSeen).toBe(false);        // only disconnect fired
    child.kill('SIGKILL');
  });

  it('resolves when a worker is SIGKILLed', async () => {
    const child = await spawnChild();
    const { done } = trackProducerQuiet(child as ProducerHandle);
    child.kill('SIGKILL');
    const resolved = await Promise.race([done!.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 2000))]);
    expect(resolved).toBe(true);
  });

  it('treats a live worker with no IPC channel as already quiet (no terminal source)', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 100000)'], { stdio: 'ignore' });
    kids.push(child);
    await new Promise(r => child.once('spawn', r));
    expect(child.connected).not.toBe(true);
    expect(trackProducerQuiet(child as ProducerHandle).alreadyQuiet).toBe(true);
    child.kill('SIGKILL');
  });
});

describe('producer-quiescence fence (controlled: exit must NOT resolve while connected)', () => {
  it('an exit observed while connected=true does NOT resolve; only disconnect (connected=false) does', async () => {
    const p = fakeProducer({ connected: true });
    const { alreadyQuiet, done } = trackProducerQuiet(p);
    expect(alreadyQuiet).toBe(false);

    let resolved = false;
    void done!.then(() => { resolved = true; });

    // exit fires but the channel is still open (connected=true) — must stay pending.
    p.set({ exitCode: 0 });
    p.emit('exit');
    await new Promise(r => setTimeout(r, 30));
    expect(resolved).toBe(false);        // the crux: exit alone did NOT settle

    // now the channel actually closes → disconnect → quiescent.
    p.set({ connected: false });
    p.emit('disconnect');
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(true);
  });

  it('killed=true && connected=true is NOT quiet — must enter the fence and wait for disconnect', async () => {
    // Mirrors ChildProcess right after .kill(SIGTERM): a signal was sent
    // (killed=true) but the IPC channel is momentarily still open.
    const p = fakeProducer({ connected: true });
    p.set({ signalCode: 'SIGTERM' }); // "killed"-ish, but channel not yet closed
    const { alreadyQuiet, done } = trackProducerQuiet(p);
    expect(alreadyQuiet).toBe(false);   // must NOT be treated as already quiet
    let resolved = false;
    void done!.then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 20));
    expect(resolved).toBe(false);       // still pending until the channel closes
    p.set({ connected: false });
    p.emit('disconnect');
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(true);
  });
});

describe('waitAllWithin', () => {
  it('returns true when all settle before the deadline, false on timeout (bounded by deadline)', async () => {
    expect(await waitAllWithin([new Promise(r => setTimeout(r, 20)), new Promise(r => setTimeout(r, 30))], Date.now() + 500)).toBe(true);
    const t0 = Date.now();
    expect(await waitAllWithin([new Promise(r => setTimeout(r, 5000))], Date.now() + 100)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('true immediately for an empty set; false for a zero/past budget', async () => {
    expect(await waitAllWithin([], Date.now() + 100)).toBe(true);
    expect(await waitAllWithin([new Promise(() => { /* never */ })], Date.now() - 1)).toBe(false);
  });
});
