import { spawn } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import { snapshotChildPids } from '../src/core/session-discovery.js';
import { findTraexLeafPid, resolveTraexOwnershipPid, scheduleTraexLeafPidResolve } from '../src/core/traex-leaf-pid.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

// Launch chain measured on a real network-policy sandbox (unshare + slirp4netns
// + bwrap, fake `traex` leaf), with the OSC relay (1) and session-scope sh (2)
// in front of it as a tmux pane has them.
const NETWORK_SANDBOX_TREE: Record<number, number[]> = {
  1: [2], 2: [3], 3: [4], 4: [5], 5: [6], 6: [7], 7: [8], 8: [9], 9: [10],
};
const NETWORK_SANDBOX_COMMS: Record<number, string> = {
  1: 'node', 2: 'sh', 3: 'node', 4: 'unshare', 5: 'node', 6: 'sh', 7: 'sh', 8: 'bwrap', 9: 'bwrap', 10: 'traex',
};
const probesFor = (tree: Record<number, number[]>, comms: Record<number, string>) => ({
  childrenOf: (pid: number) => tree[pid] ?? [],
  commOf: (pid: number) => comms[pid],
});

function makeScheduler() {
  const queue: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => { queue.push(fn); },
    runAll: (max = 10_000) => { let n = 0; while (queue.length && n++ < max) queue.shift()!(); return n; },
    pending: () => queue.length,
  };
}

describe('findTraexLeafPid', () => {
  it('reaches traex below the full network-policy sandbox chain', () => {
    expect(findTraexLeafPid(1, probesFor(NETWORK_SANDBOX_TREE, NETWORK_SANDBOX_COMMS))).toBe(10);
  });

  it('returns null while the launcher has not forked traex yet', () => {
    const tree = { ...NETWORK_SANDBOX_TREE, 9: [] };
    expect(findTraexLeafPid(1, probesFor(tree, NETWORK_SANDBOX_COMMS))).toBeNull();
  });
});

describe('resolveTraexOwnershipPid', () => {
  const probes = probesFor(NETWORK_SANDBOX_TREE, NETWORK_SANDBOX_COMMS);

  it('leaves the candidate alone outside launcher shapes', () => {
    expect(resolveTraexOwnershipPid(3, false, probes)).toBe(3);
  });

  it('descends from a wired launch layer to the leaf', () => {
    // The scope payload (the runner) is what the layer unwrap binds first.
    expect(resolveTraexOwnershipPid(3, true, probes)).toBe(10);
  });

  it('keeps a candidate that already is the TRAE process', () => {
    const tree = { ...NETWORK_SANDBOX_TREE, 10: [11] };
    const comms = { ...NETWORK_SANDBOX_COMMS, 11: 'traex' };
    expect(resolveTraexOwnershipPid(10, true, probesFor(tree, comms))).toBe(10);
  });

  it('fails closed to the candidate while the leaf is missing', () => {
    const tree = { ...NETWORK_SANDBOX_TREE, 9: [] };
    expect(resolveTraexOwnershipPid(3, true, probesFor(tree, NETWORK_SANDBOX_COMMS))).toBe(3);
  });
});

describe('scheduleTraexLeafPidResolve', () => {
  it('still binds a leaf the launcher forks after a slow (network) setup', () => {
    // The network runner may wait ~10s for its namespace and ~10s for its
    // link before bwrap even starts; model a leaf that appears 25s in.
    const scheduler = makeScheduler();
    const backend = {};
    const tree: Record<number, number[]> = { ...NETWORK_SANDBOX_TREE, 9: [] };
    let elapsedMs = 0;
    const applyRealPid = vi.fn();
    scheduleTraexLeafPidResolve(1, {
      getBackend: () => backend,
      getChildPid: () => 1,
      applyRealPid,
      schedule: (fn, ms) => scheduler.schedule(() => {
        elapsedMs += ms;
        if (elapsedMs >= 25_000) tree[9] = [10];
        fn();
      }),
      probes: probesFor(tree, NETWORK_SANDBOX_COMMS),
    });
    scheduler.runAll();
    expect(applyRealPid).toHaveBeenCalledExactlyOnceWith(10);
    expect(scheduler.pending()).toBe(0);
  });

  it('stops once the backend that started it is replaced', () => {
    const scheduler = makeScheduler();
    let backend: object = {};
    const applyRealPid = vi.fn();
    scheduleTraexLeafPidResolve(1, {
      getBackend: () => backend,
      getChildPid: () => 1,
      applyRealPid,
      schedule: fn => scheduler.schedule(fn),
      probes: probesFor({ ...NETWORK_SANDBOX_TREE, 9: [] }, NETWORK_SANDBOX_COMMS),
    });
    scheduler.runAll(3);
    backend = {};
    scheduler.runAll();
    expect(applyRealPid).not.toHaveBeenCalled();
    expect(scheduler.pending()).toBe(0);
  });
});

describe('snapshotChildPids', () => {
  it('answers child lookups from one read of the real process table', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
    let grandchildren: number[] = [];
    try {
      for (let i = 0; i < 50 && grandchildren.length === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        grandchildren = snapshotChildPids()(child.pid!);
      }
      expect(grandchildren).toHaveLength(1);
      const snapshot = snapshotChildPids();
      expect(snapshot(process.pid)).toContain(child.pid);
      expect(snapshot(grandchildren[0]!)).toEqual([]);
    } finally {
      // Only the processes this test spawned: the sh and its one sleep.
      for (const pid of grandchildren) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
      child.kill('SIGKILL');
    }
  });
});

describe('worker currentTraexObservedPid', () => {
  // A launch layer wired as backend.cliPid (the leaf not bound yet, or a scope
  // payload binding that landed first) must not be trusted as the TRAE pid the
  // ownership gate reads.
  const probes = probesFor(NETWORK_SANDBOX_TREE, NETWORK_SANDBOX_COMMS);
  const load = (cliPid: number, launcherActive: boolean) => loadWorkerFunction<() => number | undefined>('currentTraexObservedPid', {
    backend: { cliPid, getChildPid: () => 2 },
    lastSpawnTraexLauncherActive: launcherActive,
    codexAdoptPendingPid: undefined,
    resolveTraexOwnershipPid: (pid: number, active: boolean) => resolveTraexOwnershipPid(pid, active, probes),
  });

  it('descends from a wired launch layer to the leaf', () => {
    expect(load(3, true)()).toBe(10);
  });

  it('returns the wired pid unchanged outside launcher shapes', () => {
    expect(load(3, false)()).toBe(3);
  });
});
