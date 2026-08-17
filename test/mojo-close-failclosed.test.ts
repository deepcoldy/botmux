/**
 * destroySession() must never report success it cannot prove, and a FAILED
 * prepare must not lie about being rollbackable.
 *
 * Every case here is behavioural and was verified to go red when its production
 * change is reverted. That matters: two earlier fixes in this area shipped with
 * no guarding test at all, and a later one passed while `child.kill('SIGKILL')`
 * was deleted, because the test only observed the final timeout.
 *
 * Run:  pnpm vitest run test/mojo-close-failclosed.test.ts
 */
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Real-process cases: each drives a live bash child through spawn/kill plus
// /proc enumeration, and the product's own settle/proof windows (8s destroy
// settle, 2s termination proof) sit inside every run. The 30s project default
// is enough on a quiet dev machine but times out on loaded 2-core CI runners,
// where suite-wide parallel forks contend for the same cores.
vi.setConfig({ testTimeout: 90_000 });
import { MojoBackend } from '../src/adapters/backend/mojo-backend.js';
import { isLinux } from './helpers/synthetic-proc.js';

let binDir: string;
beforeAll(() => { binDir = mkdtempSync(join(tmpdir(), 'mojo-failclosed-')); });
afterAll(() => { rmSync(binDir, { recursive: true, force: true }); });

function fakeMojo(name: string, body: string): string {
  const p = join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Shrinks the termination-proof budget so the escalation ladder is exercised in
 * milliseconds. The production constant stays untouched, which is what keeps
 * these cases off the wall clock (the previous version burned 2s per run and was
 * flaky under parallel load).
 */
class FastProofBackend extends MojoBackend {
  protected override get terminationProofBudgetMs(): number { return 300; }
}

describe('mojo destroySession fails closed', () => {
  it('refuses the close when a dispatched turn never produced its lineage', async () => {
    // The child accepts the write and then exits WITHOUT ever emitting
    // system/init. There may be a remote session we have no id for, so it cannot
    // be cancelled and must not be reported as gone.
    const bin = fakeMojo('mojo-nolineage', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
exit 0`);
    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('a turn whose lineage never arrives');

    // The state the bug needed: write accepted, no lineage, child already gone.
    // Waiting for `child === null` alone is not enough -- a failed turn is
    // retried, so a fresh child can reappear and silently restore a
    // `this.child`-keyed gate's verdict. Pin it.
    await vi.waitFor(() => {
      expect((backend as unknown as { acceptedWriteWithoutLineage: boolean }).acceptedWriteWithoutLineage).toBe(true);
    });
    (backend as unknown as { child: unknown }).child = null;
    expect(backend.cliSessionIdForTest).toBeUndefined();

    // `uncertain`, not `retryable`: an unnamed remote session may exist, so write
    // admission must stay fenced rather than start a fresh lineage over an orphan.
    await expect(backend.destroySession()).resolves.toMatchObject({
      ok: false,
      error: 'mojo_lineage_not_materialized',
      recovery: 'uncertain',
    });
    // The returned object is not the guarantee -- the FENCE is. Asserting only the
    // verdict left `this.closing = false` free to re-open admission, and a probe
    // could then write() successfully on a session with a possible unnamed orphan.
    expect(backend.write('a turn that must be refused')).toBe(false);
  });

  // Linux-only: it needs a REAL live child plus /proc enumeration to reach a
  // termination verdict. Off Linux the scanner returns unsupported-platform by
  // design, so this case is skipped explicitly instead of failing.
  it.runIf(isLinux)('refuses the close when the local child cannot be proven dead', async () => {
    const bin = fakeMojo('mojo-stuck', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
echo '{"type":"system","subtype":"init","session_id":"sid-stuck"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-stuck","warnings":[]}'`);
    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('start');
    await vi.waitFor(() => expect(backend.cliSessionIdForTest).toBe('sid-stuck'));

    // Simulate an UNINTERRUPTIBLE process: signals are delivered but change
    // nothing, which is the only way a SIGKILL-proof state can be reproduced (a
    // real process cannot survive SIGKILL). The pid belongs to a real detached
    // process group, so the liveness probe genuinely finds members -- pointing at
    // an unused pid would make the probe answer ESRCH and pass for the wrong
    // reason, and pointing at this test process would signal our own group.
    const victim = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    await vi.waitFor(() => expect(typeof victim.pid).toBe('number'));
    const victimPid = victim.pid as number;
    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      // signal 0 is the liveness PROBE, never a kill: it must stay real.
      if (signal === 0) return realKill(pid, signal);
      if (pid === victimPid || pid === -victimPid) return true; // swallowed
      return realKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);

    const unkillable = Object.assign(new EventEmitter(), {
      pid: victimPid,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });
    (backend as unknown as { child: unknown }).child = unkillable;

    let result: Awaited<ReturnType<typeof backend.destroySession>>;
    try {
      result = await backend.destroySession();
    } finally {
      killSpy.mockRestore();
      try { realKill(-victimPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    expect(result).toMatchObject({
      ok: false,
      taskId: 'sid-stuck',
      error: 'mojo_local_child_termination_unproven',
      // Reversible: the irreversible remote cancel must NOT have run yet.
      recovery: 'retryable',
    });
    // The refused close must stay retryable against the SAME process, so the
    // handle cannot be dropped on the unproven path.
    expect((backend as unknown as { child: unknown }).child).toBe(unkillable);
  });

  // Linux-only: it needs a REAL live child plus /proc enumeration to reach a
  // termination verdict. Off Linux the scanner returns unsupported-platform by
  // design, so this case is skipped explicitly instead of failing.
  it.runIf(isLinux)('kills a descendant that ESCAPED the process group via setsid', async () => {
    // The earlier version of this case only started a background shell, which
    // stays in the SAME process group -- so it passed against a plain kill(-pgid)
    // and proved nothing about escapes. `setsid` makes the descendant the leader of
    // a NEW group and session, so it survives every kill aimed at the original
    // group while still holding the inherited X_JWT_TOKEN. Only the env-nonce scan
    // finds it.
    const pidFile = join(binDir, 'escaped.pid');
    const bin = fakeMojo('mojo-escaped', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
setsid bash -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 60' &
echo '{"type":"system","subtype":"init","session_id":"sid-escaped"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-escaped","warnings":[]}'`);

    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('spawn a tool that escapes');
    await vi.waitFor(() => expect(backend.cliSessionIdForTest).toBe('sid-escaped'));
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const escaped = Number(readFileSync(pidFile, 'utf-8').trim());
    const rootPid = backend.getChildPid();
    expect(Number.isInteger(escaped)).toBe(true);
    expect(alive(escaped)).toBe(true);

    // Precondition of the whole case: it really did leave the group, so a
    // group-only teardown cannot reach it.
    const escapedPgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(escaped)], { encoding: 'utf-8' }).trim());
    expect(escapedPgid).not.toBe(rootPid);

    await expect(backend.destroySession()).resolves.toMatchObject({ ok: true });
    // Success was claimed, so the whole credentialed subtree must be gone.
    await vi.waitFor(() => expect(alive(escaped)).toBe(false), { timeout: 5_000 });
  }, 60_000);

  // Linux-only: it needs a REAL live child plus /proc enumeration to reach a
  // termination verdict. Off Linux the scanner returns unsupported-platform by
  // design, so this case is skipped explicitly instead of failing.
  it.runIf(isLinux)('refuses the close while the escaped descendant cannot be killed', async () => {
    // Same escape, but the survivor cannot be signalled away. The close must fail
    // closed so the row stays active and its device-isolation blocker is retained,
    // instead of reporting ok:true with a credentialed process still running.
    const pidFile = join(binDir, 'immortal.pid');
    const bin = fakeMojo('mojo-immortal', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
setsid bash -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 60' &
echo '{"type":"system","subtype":"init","session_id":"sid-immortal"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-immortal","warnings":[]}'`);

    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('spawn an unkillable tool');
    await vi.waitFor(() => expect(backend.cliSessionIdForTest).toBe('sid-immortal'));
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const escaped = Number(readFileSync(pidFile, 'utf-8').trim());

    // Swallow signals aimed at the survivor only (signal 0 stays real, since it is
    // the liveness probe, not a kill). A real process cannot resist SIGKILL, so
    // this is the only way to reproduce a non-quiescent subtree.
    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0) return realKill(pid, signal);
      if (pid === escaped) return true;
      return realKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);

    let result: Awaited<ReturnType<typeof backend.destroySession>>;
    try {
      result = await backend.destroySession();
    } finally {
      killSpy.mockRestore();
      try { realKill(escaped, 'SIGKILL'); } catch { /* already gone */ }
    }
    expect(result).toMatchObject({
      ok: false,
      error: 'mojo_local_child_termination_unproven',
      recovery: 'retryable',
    });
  }, 60_000);

  // Linux-only: it needs a REAL live child plus /proc enumeration to reach a
  // termination verdict. Off Linux the scanner returns unsupported-platform by
  // design, so this case is skipped explicitly instead of failing.
  it.runIf(isLinux)('still scans the subtree after the direct child has been reaped', async () => {
    // The child's own `close` handler clears this.child, so a /close arriving after
    // the turn finished had nothing left to check and skipped the scan entirely --
    // which is precisely when an escaped descendant is the only thing left.
    const pidFile = join(binDir, 'orphaned.pid');
    const bin = fakeMojo('mojo-orphaned', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
setsid bash -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 60' &
echo '{"type":"system","subtype":"init","session_id":"sid-orphan"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-orphan","warnings":[]}'
exit 0`);

    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('finish the turn, leave a descendant');
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const escaped = Number(readFileSync(pidFile, 'utf-8').trim());
    // Model the state the bug needed: the direct child has been reaped and its
    // `close` handler cleared the handle. Pinning it is deterministic -- waiting is
    // not, because a retried turn can spawn a fresh child at any moment and restore
    // the handle we are trying to test without.
    (backend as unknown as { child: unknown }).child = null;
    expect(alive(escaped)).toBe(true);
    // The remembered root pid is the ONLY remaining way to reach the subtree.
    expect((backend as unknown as { lastTurnPid: number | null }).lastTurnPid).toBeGreaterThan(0);

    await backend.destroySession();
    await vi.waitFor(() => expect(alive(escaped)).toBe(false), { timeout: 5_000 });
  }, 60_000);

  // Linux-only: it needs a REAL live child plus /proc enumeration to reach a
  // termination verdict. Off Linux the scanner returns unsupported-platform by
  // design, so this case is skipped explicitly instead of failing.
  it.runIf(isLinux)('escalates to SIGKILL for a child that ignores SIGTERM', async () => {
    // Proves the ESCALATION, not just the final timeout: this child survives
    // SIGTERM forever, so the close can only succeed if SIGKILL is actually sent.
    // Deleting the SIGKILL step turns this red instead of leaving it green.
    const readyFile = join(binDir, 'sigterm-immune.ready');
    const bin = fakeMojo('mojo-sigterm-immune', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
trap '' TERM
echo '{"type":"system","subtype":"init","session_id":"sid-immune"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-immune","warnings":[]}'
touch ${readyFile}
sleep 60`);

    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('start');
    await vi.waitFor(() => expect(backend.cliSessionIdForTest).toBe('sid-immune'));
    await vi.waitFor(() => expect(existsSync(readyFile)).toBe(true));
    const childPid = backend.getChildPid();
    expect(typeof childPid).toBe('number');

    await expect(backend.destroySession()).resolves.toMatchObject({ ok: true });
    expect(alive(childPid as number)).toBe(false);
  }, 60_000);

  it('runs each turn in its own process group', async () => {
    // The group proof is only safe because the child leads its own group: sharing
    // the daemon's group would make kill(-pgid) take down the daemon itself.
    const bin = fakeMojo('mojo-pgid', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
echo '{"type":"system","subtype":"init","session_id":"sid-pgid"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-pgid","warnings":[]}'
sleep 30`);
    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('start');
    await vi.waitFor(() => expect(backend.cliSessionIdForTest).toBe('sid-pgid'));
    const childPid = backend.getChildPid() as number;

    const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(childPid)], { encoding: 'utf-8' }).trim());
    expect(pgid).toBe(childPid);
    expect(pgid).not.toBe(process.pid);

    await backend.destroySession();
  }, 60_000);
});
