/**
 * Containment wiring in mojo-backend (opinion 2, integration segment A).
 *
 * The containment module landed unused, so the hole it was written to close was
 * still open. These cases pin the FIVE wiring points:
 *
 *   A1  a handle is minted and PERSISTED at spawn, not at close
 *   A2  treeNonce is adopted from an inherited handle, so a replacement worker
 *       generation can still enumerate the previous generation's tree
 *   A3  `rootPid === null` no longer means "no subtree": the durable store gets a
 *       veto, and an inherited handle that cannot be proven refuses the close
 *   A4  daemon shutdown never releases a handle
 *   A5  a workerless close proves the LOCAL subtree before reporting `cancelled`
 *
 * The store is redirected via SESSION_DATA_DIR, so nothing here touches a real
 * containment file.
 *
 * PLATFORM SCOPE
 * --------------
 * Cases that build a fake tree go through the `procRoot` seam and the synthetic
 * /proc fixture (test/helpers/synthetic-proc.ts), so they never read the host's
 * real /proc and run on ANY platform.
 *
 * Cases that need a REAL live process (spawnSleeper / liveWeakHandle / reading
 * /proc/<pid>/stat of an actual child) are Linux-only and are gated explicitly
 * with describe.runIf(isLinux) / it.runIf(isLinux) so they SKIP off Linux rather
 * than fail. Any suite below whose name is introduced through `describeLinux` is
 * Linux-only by construction, not by accident.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelMojoSessionById,
  MojoBackend,
  proveWorkerlessLocalSubtree,
} from '../src/adapters/backend/mojo-backend.js';
import { isLinux, syntheticProcRoot } from './helpers/synthetic-proc.js';
import {
  containmentHandles,
  recordContainmentHandle,
  type ContainmentHandle,
} from '../src/core/mojo-containment.js';

const STORE = 'mojo-containment-handles.json';

/** Linux-only: needs a real /proc and real process signalling. */
const describeLinux = describe.runIf(isLinux);

let dataDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mojo-containment-wiring-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

/** A weak handle naming a pid that is definitely NOT the recorded process. */
function staleWeakHandle(sessionId: string, rootPid: number): ContainmentHandle {
  return {
    kind: 'tree-identity',
    sessionId,
    generation: 0,
    rootPid,
    // A boot id that cannot match this host, so identity checks fail.
    bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    startTime: 424242,
    nonce: 'botmux-mojo-inherited-nonce',
  };
}

/**
 * A weak handle for THIS boot whose subtree is a live, scannable process.
 *
 * LINUX ONLY: it reads the host's real /proc to learn the boot id and the child's
 * starttime, which is the whole point (the handle must agree with the REAL
 * kernel). Every caller is therefore gated with runIf(isLinux); a fake tree case
 * must use syntheticProcRoot instead.
 */
function liveWeakHandle(sessionId: string, rootPid: number, nonce: string): ContainmentHandle {
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const stat = readFileSync(`/proc/${rootPid}/stat`, 'utf8');
  const startTime = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]);
  return { kind: 'tree-identity', sessionId, generation: 0, rootPid, bootId, startTime, nonce };
}

function backendFor(sessionId: string): MojoBackend {
  // The config surface only needs to be shaped; no CLI is invoked by these cases.
  return new MojoBackend({ model: 'default' } as never, sessionId);
}

describe('A2: treeNonce is per-session and inherited', () => {
  it('adopts the nonce of an outstanding handle instead of minting a fresh one', () => {
    // A replacement generation with a NEW nonce could never match the env of the
    // previous generation's tree, so that tree would be unenumerable forever.
    recordContainmentHandle(staleWeakHandle('sess-inherit', 999_001));
    const backend = backendFor('sess-inherit');
    expect(backend['treeNonce']).toBe('botmux-mojo-inherited-nonce');
  });

  it('mints a fresh nonce when the session owns nothing', () => {
    const backend = backendFor('sess-fresh');
    expect(backend['treeNonce']).toMatch(/^botmux-mojo-[0-9a-f]{24}$/);
  });

  it('refuses to construct when the containment store is unreadable', () => {
    // Coming up without knowing what was inherited would mean starting a turn that
    // can never be proven quiescent, so the throw is the point.
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, STORE), '{ this is not json');
    expect(() => backendFor('sess-corrupt')).toThrow();
  });
});

describe('A3: rootPid === null no longer means "no subtree"', () => {
  it.runIf(isLinux)('kills an inherited live subtree instead of leaving the session unclosable', async () => {
    // THE bug this segment started from: on a replacement generation lastTurnPid is
    // always null, so the old code returned true — reporting a clean close for a
    // session that still had a live credentialed survivor.
    //
    // Proving it alive was only half the fix. Proof is READ-ONLY, so a survivor
    // nothing ever signalled made every /close retry fail forever: safe, but
    // permanently unclosable. An inherited handle means this generation took over
    // that cleanup, so the tree is signalled and only then proven.
    const child = spawnSleeper();
    try {
      const sessionId = 'sess-inherited-alive';
      recordContainmentHandle(liveWeakHandle(sessionId, child.pid, `nonce-${child.pid}`));
      const backend = backendFor(sessionId);
      // No turn was ever spawned by THIS backend, so rootPid is null.
      expect(backend['lastTurnPid']).toBeNull();

      const outcome = await backend['terminateChildProven']();
      // The close may proceed (ok), but a /proc scan is not a boundary proof, so
      // the outcome must say so and must carry the residual that keeps isolation.
      expect(outcome.ok).toBe(true);
      expect(outcome.boundaryProven).toBe(false);
      expect(outcome.evidence).toBe('diagnostic-clean');
      expect(outcome.residual?.deviceIsolation).toBe(true);
      expect(outcome.signalsStopped).toBe(true);
      // Not merely "signal delivered": it must no longer be EXECUTING. A killed
      // child whose parent has not reaped it yet lingers as a zombie, and
      // kill(pid, 0) still succeeds for one, so liveness is read from its state.
      expect(executing(child.pid)).toBe(false);
      // The handle is NOT discharged: this host proved quiescence by /proc scan
      // only, which is a diagnostic signal. The session closes, the residual and
      // its device-isolation blocker stay.
      expect(containmentHandles(sessionId)).toHaveLength(1);
    } finally {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('refuses the close when an inherited member cannot be killed', async () => {
    // The safety half: a member the signal cannot remove must still refuse. The
    // synthetic /proc keeps reporting it, which is what an uninterruptible or
    // otherwise unkillable process looks like from here.
    const sessionId = 'sess-inherited-unkillable';
    const proc = syntheticProcRoot({ parent: dataDir, name: 'proc-unkillable' });
    proc.addProcess({ pid: 7000, state: 'S', pgid: 7000, startTime: 555 });
    recordContainmentHandle({
      kind: 'tree-identity', sessionId, generation: 0,
      rootPid: 7000, bootId: proc.bootId, startTime: 555, nonce: 'nonce-unkillable',
    });
    class Unkillable extends MojoBackend {
      protected get procRoot(): string { return proc.path; }
    }
    const backend = new Unkillable({ model: 'default' } as never, sessionId);
    const outcome = await backend['terminateChildProven']();
    expect(outcome.ok).toBe(false);
    expect(outcome.boundaryProven).toBe(false);
    // A refused close must never claim the signals are done with.
    expect(outcome.signalsStopped).toBe(false);
    expect(outcome.residual?.deviceIsolation).toBe(true);
    expect(containmentHandles(sessionId)).toHaveLength(1);
  });

  it.runIf(isLinux)('reports the quiescence verdict without boundary proof for a scan-only handle', async () => {
    const child = spawnSleeper();
    try {
      const sessionId = 'sess-inherited-alive-2';
      recordContainmentHandle(liveWeakHandle(sessionId, child.pid, `nonce-${child.pid}`));
      const backend = backendFor(sessionId);
      await backend['terminateChildProven']();
      // Even a clean weak (scan-only) result is never boundary proof: only a
      // kernel-level cgroup can mint that.
      expect(backend.lastTurnQuiescence?.boundaryProof).toBe(false);
    } finally {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('still allows the close when nothing was ever spawned and nothing is outstanding', async () => {
    const backend = backendFor('sess-virgin');
    const outcome = await backend['terminateChildProven']();
    expect(outcome.ok).toBe(true);
    // "Nothing recorded" is not a kernel-level boundary proof either, so this
    // stays unproven rather than claiming a boundary it never observed. It costs
    // nothing: with no handle in the store there is no blocker to retain.
    expect(outcome.boundaryProven).toBe(false);
  });

  // Linux-only in substance: discharging on a boot-id MISMATCH requires reading
  // a boot id at all. Off Linux there is none, so the correct production answer
  // is to refuse (fail-closed) rather than age the handle out -- a different
  // behaviour, not a broken test, so this pins the Linux rule only.
  it.runIf(isLinux)('discharges an inherited handle whose recorded boot no longer matches', async () => {
    // A bootId mismatch is genuine proof: the recorded tree cannot have survived
    // the reboot that changed the id, so the handle may be retired.
    const sessionId = 'sess-rebooted';
    recordContainmentHandle(staleWeakHandle(sessionId, 999_002));
    const backend = backendFor(sessionId);
    const outcome = await backend['terminateChildProven']();
    expect(outcome.ok).toBe(true);
    // The one case where a WEAK handle does reach a boundary proof: the recorded
    // tree cannot have survived the reboot that changed the boot id, and a
    // same-user child cannot rewrite that id. The outcome must agree with the
    // store it just emptied -- claiming a residual here would ask the daemon to
    // keep a blocker whose only evidence has been deleted.
    expect(outcome.boundaryProven).toBe(true);
    expect(outcome.residual).toBeNull();
    expect(containmentHandles(sessionId)).toEqual([]);
  });

  it('refuses the close when the store cannot be read at teardown', async () => {
    const backend = backendFor('sess-store-breaks');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, STORE), 'not json at all');
    // An unreadable store cannot answer "nothing outstanding", so it must not be
    // allowed to resolve as a successful close.
    await expect(backend['terminateChildProven']()).rejects.toThrow();
  });
});

describe('A4: shutdown must not release the tree', () => {
  it('leaves outstanding handles in place across kill()', () => {
    // SIGTERM is not proof. Releasing here would drop the blocker across a restart
    // while a credentialed process may still be running.
    const sessionId = 'sess-shutdown';
    recordContainmentHandle(staleWeakHandle(sessionId, 999_003));
    const backend = backendFor(sessionId);
    backend.kill();
    expect(containmentHandles(sessionId)).toHaveLength(1);
  });

  it('survives an unreadable store during kill() instead of crashing shutdown', () => {
    const backend = backendFor('sess-shutdown-corrupt');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, STORE), '{{{');
    expect(() => backend.kill()).not.toThrow();
  });
});

describe('A5: a workerless close must prove the local subtree', () => {
  it.runIf(isLinux)('refuses when a local credentialed subtree is still alive', () => {
    // "No worker" must never imply "no local process": the worker dying is exactly
    // what orphans a credentialed descendant.
    const child = spawnSleeper();
    try {
      const sessionId = 'sess-workerless-alive';
      recordContainmentHandle(liveWeakHandle(sessionId, child.pid, `nonce-${child.pid}`));
      const outcome = proveWorkerlessLocalSubtree(sessionId);
      expect(outcome).not.toBeNull();
      expect(outcome?.kind).toBe('failed');
      if (outcome?.kind === 'failed') expect(outcome.retryable).toBe(true);
      expect(containmentHandles(sessionId)).toHaveLength(1);
    } finally {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  // Linux-only in substance: discharging on a boot-id MISMATCH requires reading
  // a boot id at all. Off Linux there is none, so the correct production answer
  // is to refuse (fail-closed) rather than age the handle out -- a different
  // behaviour, not a broken test, so this pins the Linux rule only.
  it.runIf(isLinux)('passes and discharges the handle when the local subtree is provably gone', () => {
    const sessionId = 'sess-workerless-gone';
    recordContainmentHandle(staleWeakHandle(sessionId, 999_004));
    expect(proveWorkerlessLocalSubtree(sessionId)).toBeNull();
    expect(containmentHandles(sessionId)).toEqual([]);
  });

  it('passes when the session never owned a local subtree', () => {
    expect(proveWorkerlessLocalSubtree('sess-workerless-empty')).toBeNull();
  });

  it('refuses when the containment store is unreadable', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, STORE), 'corrupt');
    const outcome = proveWorkerlessLocalSubtree('sess-workerless-corrupt');
    expect(outcome?.kind).toBe('failed');
    if (outcome?.kind === 'failed') expect(outcome.retryable).toBe(true);
  });

  it('lets a workerless close through when the only member left is a zombie', () => {
    // The workerless path must use the SAME definition of "running" as teardown,
    // or a dead worker's reaped subtree would block the close forever.
    const sessionId = 'sess-workerless-zombie';
    const proc = syntheticProcRoot({ parent: dataDir, name: 'proc-workerless-zombie' });
    proc.addProcess({ pid: 5150, state: 'Z', pgid: 5150, startTime: 999 });

    recordContainmentHandle({
      kind: 'tree-identity', sessionId, generation: 0,
      rootPid: 5150, bootId: proc.bootId, startTime: 999, nonce: 'nonce-workerless-zombie',
    });
    expect(proveWorkerlessLocalSubtree(sessionId, { procRoot: proc.path })).toBeNull();
    // Close allowed (a zombie executes nothing), handle retained: a weak handle
    // never mints a boundary proof, so the blocker outlives the close.
    expect(containmentHandles(sessionId)).toHaveLength(1);
  });

  it('still refuses a workerless close when a live member remains beside a zombie', () => {
    const sessionId = 'sess-workerless-zombie-live';
    const proc = syntheticProcRoot({ parent: dataDir, name: 'proc-workerless-mixed' });
    proc.addProcess({ pid: 5150, state: 'Z', pgid: 5150, startTime: 999 });
    proc.addProcess({ pid: 5151, name: 'kid', state: 'S', ppid: 5150, pgid: 5150, startTime: 1000 });

    recordContainmentHandle({
      kind: 'tree-identity', sessionId, generation: 0,
      rootPid: 5150, bootId: proc.bootId, startTime: 999, nonce: 'nonce-workerless-mixed',
    });
    const outcome = proveWorkerlessLocalSubtree(sessionId, { procRoot: proc.path });
    expect(outcome?.kind).toBe('failed');
    expect(containmentHandles(sessionId)).toHaveLength(1);
  });

  it.runIf(isLinux)('does not read a failed scan as an empty subtree', () => {
    // scanned:false collapsing into pids:[] would read as "nothing alive" and mint
    // a proof we do not have. Point the scan at a /proc that does not exist.
    const sessionId = 'sess-workerless-unscannable';
    recordContainmentHandle(liveWeakHandle(sessionId, process.pid, 'nonce-unscannable'));
    const outcome = proveWorkerlessLocalSubtree(sessionId, { procRoot: join(dataDir, 'no-proc') });
    expect(outcome?.kind).toBe('failed');
    expect(containmentHandles(sessionId)).toHaveLength(1);
  });
});

// Linux-only: every case here spawns a REAL child and reads its real /proc identity.
describeLinux('A1: the handle is recorded at spawn, not at close', () => {
  it('persists a handle for the freshly spawned turn root', () => {
    // Recording at close would be too late: a crash in between loses the tree, and
    // a lost tree can never be proven quiescent afterwards.
    const child = spawnSleeper();
    try {
      const backend = backendFor('sess-record-at-spawn');
      expect(containmentHandles('sess-record-at-spawn')).toEqual([]);
      backend['recordTurnContainment'](child.pid);
      const handles = containmentHandles('sess-record-at-spawn');
      expect(handles).toHaveLength(1);
      // The nonce must be the one actually injected into that tree, or the env
      // signal cannot corroborate anything later.
      expect(handles[0]?.nonce).toBe(backend['treeNonce']);
    } finally {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('persists a handle when a REAL turn is dispatched', async () => {
    // The wiring must live on the actual spawn path, not just in a helper: if the
    // call site in runTurn() is removed, nothing records the tree and the next
    // generation inherits nothing to prove.
    const binDir = mkdtempSync(join(tmpdir(), 'mojo-wiring-bin-'));
    try {
      const bin = join(binDir, 'mojo-turn');
      writeFileSync(
        bin,
        '#!/usr/bin/env bash\n'
        + 'if [ "$1" = "session" ]; then echo \'{"status":"ok"}\'; exit 0; fi\n'
        + 'echo \'{"type":"system","subtype":"init","session_id":"sid-wiring"}\'\n'
        + 'echo \'{"type":"result","status":"ok","result":"ok","session_id":"sid-wiring","warnings":[]}\'\n',
      );
      chmodSync(bin, 0o755);

      const sessionId = 'sess-real-turn';
      const backend = new MojoBackend({ bin } as never, sessionId);
      backend.spawn('', [], {} as never);
      backend.write('a turn that must be recorded');
      // The handle has to exist as soon as the child does — waiting on the turn's
      // result would not distinguish "recorded at spawn" from "recorded at close".
      await vi.waitFor(() => {
        expect(containmentHandles(sessionId).length).toBeGreaterThan(0);
      });
      backend.kill();
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('records a handle durable enough to be inherited by the next generation', () => {
    const child = spawnSleeper();
    try {
      backendFor('sess-durable')['recordTurnContainment'](child.pid);
      // A brand-new backend for the same session (a replacement generation) must
      // see it and adopt its nonce.
      const next = backendFor('sess-durable');
      expect(containmentHandles('sess-durable')).toHaveLength(1);
      expect(next['treeNonce']).toBe(containmentHandles('sess-durable')[0]?.nonce);
    } finally {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
});

describe('A3: a failed scan is not an empty subtree (backend teardown path)', () => {
  it.runIf(isLinux)('refuses the close when the inherited tree cannot be scanned at all', async () => {
    // scanned:false collapsing into pids:[] would read as "nothing alive" and
    // release a handle on the strength of a scan that never ran.
    const sessionId = 'sess-teardown-unscannable';
    recordContainmentHandle(liveWeakHandle(sessionId, process.pid, 'nonce-teardown'));
    const missingProc = join(dataDir, 'no-proc-here');
    class Unscannable extends MojoBackend {
      protected get procRoot(): string { return missingProc; }
    }
    const backend = new Unscannable({ model: 'default' } as never, sessionId);
    const outcome = await backend['terminateChildProven']();
    expect(outcome.ok).toBe(false);
    expect(outcome.boundaryProven).toBe(false);
    expect(outcome.residual?.deviceIsolation).toBe(true);
    expect(containmentHandles(sessionId)).toHaveLength(1);
  });

  it('refuses when identity checks PASS but the scan itself fails', async () => {
    // The sharper case: boot id and starttime both match, so the handle reaches
    // the scan callback. The scan then fails. If `scanned: false` were collapsed
    // into `pids: []` the handle would be released on evidence that never
    // existed — this is the one shape where fail-open is invisible.
    const sessionId = 'sess-teardown-scan-fails';
    const proc = syntheticProcRoot({ parent: dataDir, name: 'proc-scan-fails' });
    // The recorded root, with a starttime the handle will agree with.
    proc.addProcess({ pid: 4242, state: 'S', pgid: 4242, startTime: 777 });
    // A SECOND pid whose stat is unparsable, which fails the whole scan.
    proc.addUnparsableProcess(4243);

    recordContainmentHandle({
      kind: 'tree-identity', sessionId, generation: 0,
      rootPid: 4242, bootId: proc.bootId, startTime: 777, nonce: 'nonce-scan-fails',
    });
    class ScanFails extends MojoBackend {
      protected get procRoot(): string { return proc.path; }
    }
    const backend = new ScanFails({ model: 'default' } as never, sessionId);
    const outcome = await backend['terminateChildProven']();
    expect(outcome.ok).toBe(false);
    // "Cannot enumerate" must not be reported as an observation of emptiness.
    expect(outcome.evidence).toBe('unknown');
    expect(outcome.residual?.deviceIsolation).toBe(true);
    expect(containmentHandles(sessionId)).toHaveLength(1);
  });
});

// Linux-only: needs a real live survivor process to refuse the close.
describeLinux('A5: the workerless close entry point enforces the local check', () => {
  it('returns failed from cancelMojoSessionById without cancelling anything remote', async () => {
    // The local gate must run BEFORE the remote cancel, so a live local subtree
    // refuses the close even though no CLI is reachable in this test.
    const child = spawnSleeper();
    try {
      const sessionId = 'sess-entrypoint-alive';
      recordContainmentHandle(liveWeakHandle(sessionId, child.pid, `nonce-${child.pid}`));
      const outcome = await cancelMojoSessionById({ model: 'default' } as never, sessionId);
      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') {
        expect(outcome.message).toMatch(/local subtree unproven/);
        expect(outcome.retryable).toBe(true);
      }
      expect(containmentHandles(sessionId)).toHaveLength(1);
    } finally {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
});

describe('platform triage: "no instrument" is not "evidence of a survivor"', () => {
  /**
   * Off Linux there is no /proc, so the subtree can NEVER be enumerated. Treating
   * that like a failed proof fenced write admission and then refused every
   * rollback, so a non-Linux host could neither close a mojo session nor write to
   * it again — a permanent wedge caused by the absence of an instrument rather
   * than by any evidence of a survivor. It closes with a residual marker instead,
   * and the credential boundary stays with the durable containment handle.
   */
  class Darwinish extends MojoBackend {
    protected get procRoot(): string { return join(dataDir, 'no-proc'); }
    protected async proveTurnQuiescence(): Promise<never | ReturnType<MojoBackend['lastTurnQuiescence']>> {
      // Stand in for a real non-Linux host: the scanner's platform gate produces
      // exactly this verdict, and it is terminal.
      const q = { kind: 'unsupported-platform' as const, boundaryProof: false as const, platform: 'darwin' };
      (this as unknown as { lastQuiescence: unknown }).lastQuiescence = q;
      return q as never;
    }
  }

  it('closes with a residual marker instead of wedging the session', async () => {
    const backend = new Darwinish({ model: 'default' } as never, 'sess-darwin');
    const result = await backend.destroySession();
    expect(result.ok).toBe(true);
    expect(result.residual).toBe('local_subtree_unprovable_on_platform');
    // No failure verdict means nothing for the worker to latch a fence on.
    expect(result.error).toBeUndefined();
  });

  it('does not fence write admission on a residual close', async () => {
    // The whole point of decision (a): latching the fence here is what wedged the
    // session, so a residual close must leave admission untouched.
    const backend = new Darwinish({ model: 'default' } as never, 'sess-darwin-no-fence');
    const result = await backend.destroySession();
    expect(result.ok).toBe(true);
    expect(result.admission).toBeUndefined();
    expect(backend['admissionFenced']).toBe(false);
  });

  it('does NOT extend the residual close to a merely unscannable host', async () => {
    // The safety half: "the instrument failed" is evidence a survivor may exist,
    // so it must still refuse the close. Only a terminal platform limit is exempt.
    class Unscannable extends MojoBackend {
      protected get procRoot(): string { return join(dataDir, 'no-proc'); }
      protected async proveTurnQuiescence(): Promise<never> {
        const q = { kind: 'unscannable' as const, boundaryProof: false as const, reason: 'cannot read /proc' };
        (this as unknown as { lastQuiescence: unknown }).lastQuiescence = q;
        return q as never;
      }
    }
    const backend = new Unscannable({ model: 'default' } as never, 'sess-unscannable');
    const result = await backend.destroySession();
    expect(result.ok).toBe(false);
    // Fencing's classifier names this case distinctly (the instrument failed, as
    // opposed to a member being observed alive), but the important part is that it
    // is a FENCED failure and carries no residual marker.
    expect(result.error).toBe('mojo_local_termination_unscannable');
    expect(result.admission).toBe('fenced');
    expect(result.residual).toBeUndefined();
  });

  it('does NOT extend the residual close to a live subtree', async () => {
    class Alive extends MojoBackend {
      protected get procRoot(): string { return join(dataDir, 'no-proc'); }
      protected async proveTurnQuiescence(): Promise<never> {
        const q = { kind: 'alive' as const, boundaryProof: false as const, pids: [4242] };
        (this as unknown as { lastQuiescence: unknown }).lastQuiescence = q;
        return q as never;
      }
    }
    const backend = new Alive({ model: 'default' } as never, 'sess-alive');
    const result = await backend.destroySession();
    expect(result.ok).toBe(false);
    expect(result.residual).toBeUndefined();
  });

  it('keeps the containment handle outstanding across a residual close', async () => {
    // The residual close does not claim the tree is gone, so the blocker must
    // survive it — that is what carries the credential boundary here.
    const sessionId = 'sess-darwin-blocker';
    recordContainmentHandle(staleWeakHandle(sessionId, 999_005));
    class DarwinKeep extends Darwinish {}
    const backend = new DarwinKeep({ model: 'default' } as never, sessionId);
    const result = await backend.destroySession();
    expect(result.ok).toBe(true);
    expect(containmentHandles(sessionId)).toHaveLength(1);
  });
});

describe('the handle proof and the in-memory ladder must agree about zombies', () => {
  it('discharges a handle whose only remaining member is a zombie', async () => {
    // Found by a real regression: the ladder discounted zombies while the handle
    // proof did not, so the ladder called the tree clean and the handle proof
    // called the SAME tree alive. The close was refused forever and the handle
    // could never be discharged — a permanent, unrecoverable block on a process
    // that executes nothing.
    const sessionId = 'sess-zombie-agree';
    const proc = syntheticProcRoot({ parent: dataDir, name: 'proc-zombie' });
    // The recorded root, still present but REAPED (state Z).
    proc.addProcess({ pid: 4242, state: 'Z', pgid: 4242, startTime: 777 });

    recordContainmentHandle({
      kind: 'tree-identity', sessionId, generation: 0,
      rootPid: 4242, bootId: proc.bootId, startTime: 777, nonce: 'nonce-zombie',
    });
    class ZombieProc extends MojoBackend {
      protected get procRoot(): string { return proc.path; }
    }
    const backend = new ZombieProc({ model: 'default' } as never, sessionId);
    const outcome = await backend['terminateChildProven']();
    // Agreement is about the CLOSE, not about discharging the handle: the weak
    // handle stays until something unforgeable proves the boundary.
    expect(outcome.ok).toBe(true);
    expect(outcome.boundaryProven).toBe(false);
    expect(outcome.residual?.deviceIsolation).toBe(true);
    expect(containmentHandles(sessionId)).toHaveLength(1);
  });

  it('still refuses when a non-zombie member remains alongside a zombie', async () => {
    const sessionId = 'sess-zombie-plus-live';
    const proc = syntheticProcRoot({ parent: dataDir, name: 'proc-zombie-live' });
    proc.addProcess({ pid: 4242, state: 'Z', pgid: 4242, startTime: 777 });
    // A descendant in the same group that is genuinely running.
    proc.addProcess({ pid: 4243, name: 'kid', state: 'R', ppid: 4242, pgid: 4242, startTime: 778 });

    recordContainmentHandle({
      kind: 'tree-identity', sessionId, generation: 0,
      rootPid: 4242, bootId: proc.bootId, startTime: 777, nonce: 'nonce-zombie-live',
    });
    class ZombiePlusLive extends MojoBackend {
      protected get procRoot(): string { return proc.path; }
    }
    const backend = new ZombiePlusLive({ model: 'default' } as never, sessionId);
    const outcome = await backend['terminateChildProven']();
    expect(outcome.ok).toBe(false);
    expect(outcome.boundaryProven).toBe(false);
    expect(outcome.residual?.deviceIsolation).toBe(true);
    expect(containmentHandles(sessionId)).toHaveLength(1);
  });
});

describe('an unreadable store must not crash the daemon', () => {
  it('returns a structured failure from cancelMojoSessionById instead of throwing', async () => {
    // The constructor fails closed by throwing, but this function DECLARES a
    // structured outcome and its call site is a fire-and-forget void ... .then()
    // with no catch, in a daemon with no unhandledRejection handler. A throw here
    // therefore terminates the daemon and every session it serves, so fail-closed
    // would become fail-crash.
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, STORE), 'not json at all');
    const outcome = await cancelMojoSessionById({ model: 'default' } as never, 'sess-corrupt-cancel');
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      // Retryable, and NOT a claim the remote session is gone: the caller must
      // refuse the close so the blocker is retained.
      expect(outcome.retryable).toBe(true);
    }
  });
});

describe('inherited signalling is gated by what each fact licenses', () => {
  it('signals an escaped member even when the recorded root is long gone', () => {
    // This is the case the fix exists for. A descendant that called setsid OUTLIVES
    // its parent, so the root-identity gate can never pass for it; if a dead root
    // meant "signal nothing", that survivor would be re-proven alive on every retry
    // and the session could never be closed at all.
    const sessionId = 'sess-escaped-member';
    const proc = syntheticProcRoot({ parent: dataDir, name: 'proc-escaped' });
    // The recorded root is GONE from /proc entirely...
    // ...but an escaped descendant survives in its own session, found by the nonce.
    proc.addProcess({
      pid: 9100, name: 'escaped', state: 'S', pgid: 9100, startTime: 654,
      environ: 'PATH=/bin\0BOTMUX_MOJO_TREE_NONCE=nonce-escaped\0',
    });
    recordContainmentHandle({
      kind: 'tree-identity', sessionId, generation: 0,
      rootPid: 9000, bootId: proc.bootId, startTime: 654, nonce: 'nonce-escaped',
    });

    const sent: number[] = [];
    const realKill = process.kill.bind(process);
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      sent.push(pid);
      if (Math.abs(pid) === 9100 || Math.abs(pid) === 9000) return true;   // synthetic
      return realKill(pid, sig as NodeJS.Signals);
    }) as typeof process.kill);
    try {
      class FakeProc extends MojoBackend {
        protected get procRoot(): string { return proc.path; }
      }
      const backend = new FakeProc({ model: 'default' } as never, sessionId);
      backend['signalInheritedTree'](9000, false);
      // The escapee must be signalled individually, which is the only way to reach it.
      expect(sent).toContain(9100);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not send the negated GROUP signal when the root identity fails', () => {
    // The group kill is negated, so it reaches every process in the group. On a
    // recycled pid that is a stranger's group, which is unrecoverable — so it must
    // be sent ONLY when the recorded identity still verifies.
    const sessionId = 'sess-group-gate';
    const proc = syntheticProcRoot({ parent: dataDir, name: 'proc-group-gate' });
    proc.addProcess({ pid: 8000, state: 'S', pgid: 8000, startTime: 321 });

    const sent: number[] = [];
    const realKill = process.kill.bind(process);
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      sent.push(pid);
      if (pid === 8000 || pid === -8000) return true;   // synthetic; never really signal
      return realKill(pid, sig as NodeJS.Signals);
    }) as typeof process.kill);
    try {
      class FakeProc extends MojoBackend {
        protected get procRoot(): string { return proc.path; }
      }
      const backend = new FakeProc({ model: 'default' } as never, sessionId);
      backend['signalInheritedTree'](8000, false);
      // No NEGATED target may appear: that would be the group kill.
      expect(sent.filter(p => p < 0)).toEqual([]);
      // The member itself is still signalled individually.
      expect(sent).toContain(8000);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** Is that pid still EXECUTING? */
function executing(pid: number): boolean {
  // Deliberately NOT kill(pid, 0): that succeeds for a zombie, and a zombie has
  // already been reaped by the kernel -- it runs nothing and cannot use the
  // credential. Only reading the state tells the two apart.
  let text: string;
  try { text = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return false; }
  const state = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)[0];
  return state !== 'Z';
}

/** A real, live process to stand in for a credentialed survivor. */
function spawnSleeper(): { pid: number } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  const child = spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
  if (typeof child.pid !== 'number') throw new Error('could not spawn a sleeper');
  return { pid: child.pid };
}
