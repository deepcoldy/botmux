import { describe, it, expect } from 'vitest';
import {
  classifyOrphanPanes,
  paneProcessGroup,
  defaultIsHelperComm,
  enumerateOrphanPanes,
  enumerateThreadLockHolders,
  planOrphanSessionSweep,
  type RichProc,
  type OrphanPane,
} from '../src/core/orphan-session-reaper.js';

// Process-tree builder for tests: "pid:ppid:pgid:state:comm" and a cmd.
function proc(spec: string, cmd = '', uid = 1000, startTicks = 1): RichProc {
  const [pidS, ppidS, pgidS, state, comm] = spec.split(':');
  return { pid: Number(pidS), ppid: Number(ppidS), pgid: Number(pgidS), state: state ?? 'S', comm: comm ?? 'x', cmd, uid, startTicks };
}

const SHELL = (n: number) => proc(`${n}:9000:${n}:S:bash`, '-bash');

describe('paneProcessGroup', () => {
  it('collects the pgid arm and the ppid subtree; flags a setsid escaped payload', () => {
    const procs = [
      proc('9000:1:9000:S:tmux', 'tmux: server'),
      SHELL(100),
      proc('101:100:100:S:cat', 'cat'),                 // tmux pipe helper, same pgid
      proc('102:101:102:S:codex', 'codex exec'),       // setsid'd: own pgid 102
    ];
    const { members, escapedPayload } = paneProcessGroup(100, procs);
    // pgid arm: 100 (shell) and 101 (pipe cat); 102 took its OWN pgid via
    // setsid so it is not in the signalled group, but the subtree arm finds it.
    expect([...members].sort((a, b) => a - b)).toEqual([100, 101]);
    expect(escapedPayload).toBe(true); // codex escaped the pane pgid
  });
});

describe('defaultIsHelperComm', () => {
  it('recognises shells and botmux pipe helpers as bare, CLIs as payload', () => {
    expect(defaultIsHelperComm('bash', '-bash')).toBe(true);
    expect(defaultIsHelperComm('cat', 'cat')).toBe(true);
    expect(defaultIsHelperComm('node', 'node .../program-status-relay .../plan.json')).toBe(true);
    expect(defaultIsHelperComm('codex', 'codex exec')).toBe(false);
    expect(defaultIsHelperComm('claude', 'claude')).toBe(false);
  });
});

describe('classifyOrphanPanes — the ONLY auto-kill is a taken-over bare wrapper', () => {
  const base = {
    procs: [] as RichProc[],
    reachableBindings: new Set<string>(['inst-A']),
    lockHolderPids: new Set<number>(),
    ownUid: 1000,
    permitBareWrapperReap: true,
  };

  it('kills a bare shell wrapper whose binding is live on the reachable server', () => {
    const panes: OrphanPane[] = [{ panePid: 100, sessionName: 'bmx-aaaaaaaa', instanceBinding: 'inst-A' }];
    const procs = [proc('9000:1:9000:S:tmux', 'tmux: server'), SHELL(100), proc('101:100:100:Z:codex', '<defunct>')];
    const r = classifyOrphanPanes({ ...base, panes, procs });
    expect(r.censusComplete).toBe(true);
    expect(r.verdicts[0]).toMatchObject({ kill: true, reason: 'bare-wrapper-taken-over' });
  });

  it('does NOT kill a duplicate that still runs a live CLI payload', () => {
    const panes: OrphanPane[] = [{ panePid: 100, sessionName: 'bmx-aaaaaaaa', instanceBinding: 'inst-A' }];
    const procs = [SHELL(100), proc('101:100:100:S:codex', 'codex exec')];
    const r = classifyOrphanPanes({ ...base, panes, procs });
    expect(r.verdicts[0].kill).toBe(false);
    expect(r.verdicts[0].reason).toBe('live-cli-payload');
  });

  it('does NOT kill when no live reachable session owns the binding (not a proven duplicate)', () => {
    const panes: OrphanPane[] = [{ panePid: 100, sessionName: 'bmx-aaaaaaaa', instanceBinding: 'inst-ORPHAN' }];
    const procs = [SHELL(100)];
    const r = classifyOrphanPanes({ ...base, panes, procs });
    expect(r.verdicts[0]).toMatchObject({ kill: false, reason: 'not-a-duplicate-no-reachable-binding' });
  });

  it('GLOBAL lock veto: a setsid lock-holding descendant anywhere in the subtree blocks the kill', () => {
    const panes: OrphanPane[] = [{ panePid: 100, sessionName: 'bmx-aaaaaaaa', instanceBinding: 'inst-A' }];
    const procs = [
      SHELL(100),
      proc('101:100:100:S:bash', 'bash'),
      proc('102:101:102:S:codex', 'codex exec'), // escaped to own pgid, holds the lock
    ];
    const lockHolderPids = new Set([102]);
    const r = classifyOrphanPanes({ ...base, panes, procs, lockHolderPids });
    expect(r.verdicts[0].kill).toBe(false);
    // live payload OR lock — both are vetoes; the escaped codex is payload too.
    expect(['lock-held', 'live-cli-payload']).toContain(r.verdicts[0].reason);
  });

  it('a bare wrapper with a lock held by an in-pgid member is vetoed as lock-held', () => {
    const panes: OrphanPane[] = [{ panePid: 100, sessionName: 'bmx-aaaaaaaa', instanceBinding: 'inst-A' }];
    // A non-helper-looking but signalable process holding the lock but otherwise
    // classified: use a helper comm (cat) that also holds the lock.
    const procs = [SHELL(100), proc('101:100:100:S:cat', 'cat')];
    const r = classifyOrphanPanes({ ...base, panes, procs, lockHolderPids: new Set([101]) });
    expect(r.verdicts[0]).toMatchObject({ kill: false, reason: 'lock-held' });
  });

  it('HOST-WIDE lock veto: a lock holder OUTSIDE the pane group/subtree (setsid/reparented live CLI) still blocks the kill', () => {
    // The pane group is a clean bare wrapper (shell + pipe cat) and its binding
    // is live on the reachable server. But pid 777 — not in the pgid, not in
    // the ppid subtree — holds a thread-writer lock: a CLI that escaped via
    // setsid/double-fork/reparent. The kill predicate must fail closed anyway;
    // deleting the host-wide veto would approve this SIGHUP.
    const panes: OrphanPane[] = [{ panePid: 100, sessionName: 'bmx-aaaaaaaa', instanceBinding: 'inst-A' }];
    const procs = [
      proc('9000:1:9000:S:tmux', 'tmux: server'),
      SHELL(100),
      proc('101:100:100:S:cat', 'cat'),
      proc('777:1:777:S:codex', 'codex exec'), // escaped, unrelated subtree
    ];
    const r = classifyOrphanPanes({ ...base, panes, procs, lockHolderPids: new Set([777]) });
    expect(r.verdicts[0]).toMatchObject({ kill: false, reason: 'lock-held' });
  });

  it('refuses to signal a pane group containing another-uid process', () => {
    const panes: OrphanPane[] = [{ panePid: 100, sessionName: 'bmx-aaaaaaaa', instanceBinding: 'inst-A' }];
    const procs = [SHELL(100), proc('101:100:100:S:bash', 'bash', 0 /* root */)];
    const r = classifyOrphanPanes({ ...base, panes, procs });
    expect(r.verdicts[0]).toMatchObject({ kill: false, reason: 'unsignalable-member' });
  });

  it('report-only (permit off) NEVER kills even a clean bare-wrapper duplicate', () => {
    const panes: OrphanPane[] = [{ panePid: 100, sessionName: 'bmx-aaaaaaaa', instanceBinding: 'inst-A' }];
    const procs = [SHELL(100)];
    const r = classifyOrphanPanes({ ...base, panes, procs, permitBareWrapperReap: false });
    expect(r.verdicts[0]).toMatchObject({ kill: false, reason: 'bare-wrapper-taken-over' });
  });
});

describe('enumerateOrphanPanes', () => {
  it('lists direct non-zombie children of the orphan server as panes and reads the binding', () => {
    const procs = [
      proc('9000:1:9000:S:tmux', 'tmux: server'),
      SHELL(100),
      proc('101:9000:101:S:bash', '-bash'),
      proc('102:9000:102:Z:codex', '<defunct>'),
    ];
    const env = (pid: number) => pid === 100
      ? 'BOTMUX_CODEX_INSTANCE_BINDING=inst-A\0BOTMUX_TMUX_SESSION=bmx-aaaaaaaa\0'
      : null;
    const panes = enumerateOrphanPanes(9000, procs, env);
    expect(panes.map(p => p.panePid).sort()).toEqual([100, 101]); // zombie 102 skipped
    expect(panes.find(p => p.panePid === 100)?.instanceBinding).toBe('inst-A');
    expect(panes.find(p => p.panePid === 100)?.sessionName).toBe('bmx-aaaaaaaa');
  });

  it('excludes a pipe-pane helper that lives in the SERVER pgid even when it carries the binding', () => {
    // Measured topology: the server (9000) direct-forks BOTH a real pane shell
    // (own pgid 100) and a pipe-pane `sh … cat` helper (101) that stays in the
    // server's pgid (pgid=9000) and can carry BOTMUX_CODEX_INSTANCE_BINDING.
    // Only the self-pgid pane may be enumerated; the helper must never become
    // a kill target whose group contains the server pid.
    const procs = [
      proc('9000:1:9000:S:tmux', 'tmux: server'),
      SHELL(100),                                              // real pane: pgid 100
      proc('101:9000:9000:S:sh', 'sh -c cat'),                // helper: in server pgid
    ];
    const env = (pid: number) => 'BOTMUX_CODEX_INSTANCE_BINDING=inst-A\0';
    const panes = enumerateOrphanPanes(9000, procs, env);
    expect(panes.map(p => p.panePid)).toEqual([100]);
  });

  it('excludes a child that is not its own pgid leader (pgid != pid)', () => {
    const procs = [
      proc('9000:1:9000:S:tmux', 'tmux: server'),
      SHELL(100),
      proc('103:9000:100:S:cat', 'cat'), // shares pane 100's pgid; not a pane root
    ];
    expect(enumerateOrphanPanes(9000, procs, () => null).map(p => p.panePid)).toEqual([100]);
  });
});

describe('planOrphanSessionSweep fail-closed', () => {
  it('reports censusComplete=false and plans zero kills when the lock table is unavailable', () => {
    const procs = [proc('9000:1:9000:S:tmux', 'tmux: server'), SHELL(100)];
    const r = planOrphanSessionSweep({
      orphanServerPids: [9000], reachableBindings: new Set(['inst-A']),
      procs, lockHolderPids: null, ownUid: 1000, permitBareWrapperReap: true,
    });
    expect(r.censusComplete).toBe(false);
    expect(r.killablePgroups).toEqual([]);
  });

  it('plans the bare-wrapper pane group when census is complete and takeover proven', () => {
    const procs = [proc('9000:1:9000:S:tmux', 'tmux: server'), SHELL(100), proc('101:100:100:Z:codex', '<defunct>')];
    const r = planOrphanSessionSweep({
      orphanServerPids: [9000], reachableBindings: new Set(['inst-A']),
      procs, lockHolderPids: new Set(), ownUid: 1000, permitBareWrapperReap: true,
    });
    expect(r.censusComplete).toBe(true);
    expect(r.panesEvaluated).toBe(1);
  });
});

describe.skipIf(process.platform !== 'linux')('enumerateThreadLockHolders (real /proc)', () => {
  it('returns a Set on a complete census, or null when an EPERM boundary makes it unreadable; never throws', () => {
    const holders = enumerateThreadLockHolders();
    // On a shared host another-uid process can make /proc/<pid>/fd unreadable;
    // that must surface as null (fail closed → caller signals nothing), not as
    // an empty Set that would read as "no holders".
    if (holders !== null) expect(holders).toBeInstanceOf(Set);
  });
});

import { runPeriodicOrphanSessionSweep } from '../src/core/orphan-session-reaper.js';

describe('runPeriodicOrphanSessionSweep (daemon periodic wiring)', () => {
  const baseSeam = {
    platform: 'linux' as const,
    socketNames: ['botmux' as string | undefined],
    socketPath: () => '/tmp/x/tmux-1000/botmux',
    reachablePid: () => 100,
    isBotmuxPid: () => true,
    log: () => {},
  };

  it('report-only default counts orphan servers and never signals / touches procs', () => {
    let procsLoaded = false;
    const r = runPeriodicOrphanSessionSweep({
      ...baseSeam,
      listeningPids: () => [100, 200, 201], // reachable 100 + two orphan bmx listeners
      loadProcs: () => { procsLoaded = true; return []; },
      // permitBareWrapperReap omitted ⇒ report only
    } as any);
    expect(r.orphanServers).toBe(2);
    expect(r.signalled).toEqual([]);
    expect(procsLoaded).toBe(false); // report-only keeps the pass cheap
    expect(r.censusComplete).toBe(true);
  });

  it('unreadable census fails that label closed and reports censusComplete=false', () => {
    const r = runPeriodicOrphanSessionSweep({ ...baseSeam, listeningPids: () => null } as any);
    expect(r.orphanServers).toBe(0);
    expect(r.censusComplete).toBe(false);
  });

  it('non-botmux displaced listener is not counted as an orphan', () => {
    const r = runPeriodicOrphanSessionSweep({
      ...baseSeam,
      listeningPids: () => [100, 4242],
      isBotmuxPid: (p: number) => p === 100,
    } as any);
    expect(r.orphanServers).toBe(0);
  });

  it('destructive arm never signals on a non-Linux platform even when enabled', () => {
    let signalled = false;
    const r = runPeriodicOrphanSessionSweep({
      ...baseSeam,
      platform: 'darwin',
      listeningPids: () => [100, 200],
      permitBareWrapperReap: true,
      loadProcs: () => [],
      lockHolders: () => new Set<number>(),
      enumeratePanes: () => [],
      signal: () => { signalled = true; },
    } as any);
    expect(r.orphanServers).toBe(1);
    expect(signalled).toBe(false);
  });

  it('a SINGLE listener is never an orphan even when the owner probe is null (slow server)', () => {
    const r = runPeriodicOrphanSessionSweep({
      ...baseSeam,
      listeningPids: () => [100],
      reachablePid: () => null, // probe timed out against the saturated only server
    } as any);
    expect(r.orphanServers).toBe(0);
  });

  it('null owner with several listeners is NOT classified (must not label the slow current server orphan)', () => {
    const r = runPeriodicOrphanSessionSweep({
      ...baseSeam,
      listeningPids: () => [100, 200],
      reachablePid: () => null,
    } as any);
    expect(r.orphanServers).toBe(0);
    expect(r.signalled).toEqual([]);
  });

  it('destructive pass aborts if the reachable owner changes mid-pass (TOCTOU)', () => {
    let probe = 0;
    let signalled = false;
    const r = runPeriodicOrphanSessionSweep({
      ...baseSeam,
      listeningPids: () => [100, 200],
      reachablePid: () => { probe += 1; return probe === 1 ? 100 : 999; },
      permitBareWrapperReap: true,
      loadProcs: () => [],
      lockHolders: () => new Set<number>(),
      enumeratePanes: () => [],
      signal: () => { signalled = true; },
    } as any);
    expect(signalled).toBe(false);
    expect(r.censusComplete).toBe(false);
  });

  it('HARD GUARD: never signals the orphan server pid or a process in its pgid', () => {
    // Orphan server 200 (pgid 200) direct-forks a self-pgid bare pane 210 AND
    // a same-server-pgid helper 211. Even if a buggy plan listed 211, the guard
    // must suppress ALL signalling for the label.
    const procs = [
      proc('100:1:100:S:tmux', 'tmux: server'),
      proc('200:1:200:S:tmux', 'tmux -L botmux new-session -s bmx-dup'),
      proc('210:200:210:S:bash', '-bash'), // real pane, own pgid
      proc('211:200:200:S:sh', 'sh -c cat'), // helper in server pgid
    ];
    const signalled: number[] = [];
    const r = runPeriodicOrphanSessionSweep({
      ...baseSeam,
      listeningPids: () => [100, 200],
      reachablePid: () => 100,
      isBotmuxPid: (p: number) => p === 200,
      permitBareWrapperReap: true,
      loadProcs: () => procs,
      lockHolders: () => new Set<number>(),
      enumeratePanes: () => [{ panePid: 210, sessionName: 'bmx-dup', instanceBinding: 'inst-A' }, { panePid: 211, sessionName: 'x', instanceBinding: 'inst-A' }],
      reachableBindings: () => new Set(['inst-A']),
      ownUid: 1000,
      signal: (pid: number) => { signalled.push(pid); },
    } as any);
    // 211 (server pgid) reaching the plan is enough to trip the hard guard.
    expect(signalled).toEqual([]);
    expect(r.signalled).toEqual([]);
  });
});
