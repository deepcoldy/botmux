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
import { MojoBackend } from '../src/adapters/backend/mojo-backend.js';

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
  });

  it('refuses the close when the local child cannot be proven dead', async () => {
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

  it('kills a detached descendant that inherited the credential', async () => {
    // mojo runs tools and can leave a detached grandchild holding X_JWT_TOKEN.
    // The parent exits immediately, so a direct-pid proof succeeds while the
    // credentialed descendant keeps running -- and the closed row then drops its
    // device-isolation blocker. Only group-level termination catches this.
    const pidFile = join(binDir, 'descendant.pid');
    const bin = fakeMojo('mojo-descendant', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
# A descendant that ignores SIGTERM and outlives its parent.
( trap '' TERM; sleep 60 & echo $! > ${pidFile}; wait ) &
echo '{"type":"system","subtype":"init","session_id":"sid-desc"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-desc","warnings":[]}'`);

    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('spawn a tool');
    await vi.waitFor(() => expect(backend.cliSessionIdForTest).toBe('sid-desc'));
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const descendant = Number(readFileSync(pidFile, 'utf-8').trim());
    expect(Number.isInteger(descendant)).toBe(true);
    expect(alive(descendant)).toBe(true);

    await expect(backend.destroySession()).resolves.toMatchObject({ ok: true });

    // The close claimed success, so the whole credentialed subtree must be gone.
    await vi.waitFor(() => expect(alive(descendant)).toBe(false), { timeout: 5_000 });
  }, 20_000);

  it('escalates to SIGKILL for a child that ignores SIGTERM', async () => {
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
  }, 20_000);

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
  }, 20_000);
});
