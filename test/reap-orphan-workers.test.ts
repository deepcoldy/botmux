import { describe, it, expect } from 'vitest';
import { reapOrphanWorkers, type ProcSnapshot } from '../src/core/worker-pool.js';

// Absolute path of THIS install's worker script, as it appears in a worker's
// command line. reapOrphanWorkers() matches on this exact substring.
const WP = '/opt/botmux/dist/worker.js';

describe('reapOrphanWorkers', () => {
  it('reaps only ppid==1 processes that reference this install’s worker script', () => {
    const killed: number[] = [];
    const procs: ProcSnapshot[] = [
      { pid: 100, ppid: 1, cmd: `node --max-old-space-size=8192 ${WP}` }, // orphan ✓
      { pid: 101, ppid: 1, cmd: `node ${WP}` },                            // orphan ✓
      { pid: 102, ppid: 555, cmd: `node ${WP}` },                          // live worker (parented to daemon 555) ✗
      { pid: 103, ppid: 1, cmd: 'node /other/botmux/dist/worker.js' },     // a DIFFERENT install's orphan ✗
      { pid: 104, ppid: 1, cmd: '/usr/bin/claude --session-id abc' },      // CLI process, not a worker ✗
      { pid: 105, ppid: 1, cmd: 'node /opt/botmux/dist/index-daemon.js' }, // daemon, not a worker ✗
    ];

    const n = reapOrphanWorkers({ procs, workerPath: WP, kill: (pid) => killed.push(pid) });

    expect(n).toBe(2);
    expect(killed.sort((a, b) => a - b)).toEqual([100, 101]);
  });

  it('never targets a live worker whose forking daemon is still alive', () => {
    const killed: number[] = [];
    const procs: ProcSnapshot[] = [
      { pid: 200, ppid: 4242, cmd: `node ${WP}` },
      { pid: 201, ppid: 4242, cmd: `node ${WP}` },
    ];
    expect(reapOrphanWorkers({ procs, workerPath: WP, kill: (p) => killed.push(p) })).toBe(0);
    expect(killed).toEqual([]);
  });

  it('does not count a kill that throws (process already gone / lost the race)', () => {
    const procs: ProcSnapshot[] = [{ pid: 300, ppid: 1, cmd: `node ${WP}` }];
    const n = reapOrphanWorkers({
      procs,
      workerPath: WP,
      kill: () => { throw Object.assign(new Error('No such process'), { code: 'ESRCH' }); },
    });
    expect(n).toBe(0);
  });

  it('reaps nothing when there are no matching orphans', () => {
    const procs: ProcSnapshot[] = [
      { pid: 1, ppid: 0, cmd: '/sbin/init' },
      { pid: 400, ppid: 99, cmd: `node ${WP}` },
    ];
    const killed: number[] = [];
    expect(reapOrphanWorkers({ procs, workerPath: WP, kill: (p) => killed.push(p) })).toBe(0);
    expect(killed).toEqual([]);
  });
});
