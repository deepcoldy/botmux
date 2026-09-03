import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { basename } from 'node:path';
import { realpathSync } from 'node:fs';
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

/**
 * COMPILED SINGLE-FILE BINARY.
 *
 * The cases above all inject `workerPath`, so the DEFAULT branch — the one that
 * decides how workers are identified in production — was never exercised. In the
 * compiled form that default was `join(__dirname,'..','worker.js')` =
 * `/$bunfs/worker.js`, a process-private virtual path that appears in no command
 * line at all, so `cmd.includes(...)` matched nothing and orphans were NEVER
 * reaped. MEASURED against a real compiled binary: a worker's actual cmdline is
 * `<binary> __worker`.
 *
 * `isStandaloneBinary()` is exercised for real (not mocked) by pointing
 * `process.argv[1]` at a `/$bunfs/` path, which is exactly the signal it keys off
 * (src/core/self-spawn.ts). These cases deliberately pass NO `workerPath`.
 */
describe('reapOrphanWorkers — compiled binary form', () => {
  const REAL_ARGV1 = process.argv[1];
  const BIN = process.execPath;
  const NAME = BIN.slice(BIN.lastIndexOf('/') + 1);

  beforeEach(() => { process.argv[1] = '/$bunfs/root/cli.js'; });
  afterEach(() => { process.argv[1] = REAL_ARGV1; });

  it('reaps `<binary> __worker` orphans, which the worker.js predicate could never match', () => {
    const killed: number[] = [];
    const procs: ProcSnapshot[] = [
      { pid: 200, ppid: 1, cmd: `${BIN} __worker` },        // orphan ✓
      { pid: 201, ppid: 1, cmd: `${NAME} __worker` },       // relative argv[0] — MEASURED shape ✓
      { pid: 202, ppid: 777, cmd: `${BIN} __worker` },      // live worker ✗
    ];

    const n = reapOrphanWorkers({ procs, kill: (pid) => killed.push(pid) });

    expect(n).toBe(2);
    expect(killed).toEqual([200, 201]);
  });

  it('still spares other installs and non-workers (conservatism is preserved)', () => {
    const killed: number[] = [];
    const procs: ProcSnapshot[] = [
      { pid: 301, ppid: 1, cmd: `${BIN} __supervisor` },   // another entry, not a worker ✗
      { pid: 302, ppid: 1, cmd: `${BIN} start` },          // ordinary CLI ✗
      { pid: 303, ppid: 1, cmd: 'grep -r __worker src/' }, // merely mentions the token ✗
    ];

    expect(reapOrphanWorkers({ procs, kill: (p) => killed.push(p) })).toBe(0);
    expect(killed).toEqual([]);
  });

  /**
   * CROSS-INSTALL PRECISION.
   *
   * The worker.js predicate identified this install by an ABSOLUTE path, so another
   * botmux install's orphans could never match it. A basename-only compiled
   * predicate silently loses that: every released install names its binary
   * `botmux`, so install A would reap install B's orphans — each leaking ~0.5 GB
   * and, worse, killing live-looking processes that belong to somebody else's
   * daemon.
   *
   * The earlier version of this file appeared to cover the case with a literal
   * `/opt/other-botmux/botmux __worker`, but that only passed BY ACCIDENT: under
   * vitest `basename(process.execPath)` is `node`, which that string does not
   * contain. Deriving the name from `process.execPath` is what gives the case
   * teeth — VERIFIED that the basename-only predicate reaps pid 400 here.
   */
  it('spares a SAME-NAMED binary from a different install (absolute argv[0] must match exactly)', () => {
    const killed: number[] = [];
    const sameName = basename(BIN);
    const procs: ProcSnapshot[] = [
      { pid: 400, ppid: 1, cmd: `/opt/other-install/${sameName} __worker` },        // ✗ not ours
      { pid: 401, ppid: 1, cmd: `/usr/local/lib/botmux/${sameName} __worker` },     // ✗ not ours
      { pid: 402, ppid: 1, cmd: `${realpathSync(BIN)} __worker` },                  // ✓ ours
    ];

    const n = reapOrphanWorkers({ procs, kill: (p) => killed.push(p) });

    expect(killed).toEqual([402]);
    expect(n).toBe(1);
  });

  it('a relative argv[0] still matches by basename (our spawns never produce one)', () => {
    // spawnWorker goes through process.execPath, which the kernel resolves to an
    // absolute path, so this branch only sees processes started by a bare PATH
    // lookup. Cross-install ambiguity is unavoidable there — but such a process
    // was also not started the way we start ours, so matching by name is the most
    // that can be said, and dropping the branch would leave those orphans forever.
    const killed: number[] = [];
    const procs: ProcSnapshot[] = [
      { pid: 500, ppid: 1, cmd: `${basename(BIN)} __worker` },
    ];
    expect(reapOrphanWorkers({ procs, kill: (p) => killed.push(p) })).toBe(1);
    expect(killed).toEqual([500]);
  });

  it('never matches a /$bunfs/ path (nothing on the system carries one)', () => {
    const killed: number[] = [];
    const procs: ProcSnapshot[] = [
      { pid: 400, ppid: 1, cmd: `${BIN} /$bunfs/worker.js` },
    ];
    // The old default would have "matched" this synthetic line while matching no
    // real one; the new predicate requires the __worker token instead.
    expect(reapOrphanWorkers({ procs, kill: (p) => killed.push(p) })).toBe(0);
  });
});
