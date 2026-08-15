/**
 * destroySession() must never report success it cannot prove.
 *
 * Both cases below are behavioural and were UNGUARDED before: reverting either
 * production change left the whole mojo suite green, which is exactly how these
 * two fail-open paths survived several review rounds.
 *
 * Run:  pnpm vitest run test/mojo-close-failclosed.test.ts
 */
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('mojo destroySession fails closed', () => {
  it('refuses the close when a dispatched turn never produced its lineage', async () => {
    // The child accepts the write and then exits WITHOUT ever emitting
    // system/init. There may be a remote session we have no id for, so it cannot
    // be cancelled and must not be reported as gone.
    //
    // Gating the wait on `this.child` (instead of acceptedWriteWithoutLineage)
    // made this return ok:true, because the child was already reaped.
    const bin = fakeMojo('mojo-nolineage', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
exit 0`);
    const backend = new MojoBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('a turn whose lineage never arrives');

    // The state the bug needed: the write was accepted, no lineage ever arrived,
    // and the local child is already gone. Closing while a child is still alive
    // does not exercise this at all -- a `this.child`-keyed gate looks correct
    // there. Waiting for `child === null` is not enough either: a failed turn is
    // retried, so a fresh child can reappear between the wait and the close and
    // silently restore the wrong gate's verdict. Pin the child explicitly.
    await vi.waitFor(() => {
      expect((backend as unknown as { acceptedWriteWithoutLineage: boolean }).acceptedWriteWithoutLineage).toBe(true);
    });
    (backend as unknown as { child: unknown }).child = null;
    expect(backend.cliSessionIdForTest).toBeUndefined();

    await expect(backend.destroySession()).resolves.toMatchObject({
      ok: false,
      error: 'mojo_lineage_not_materialized',
    });
    // A refused prepare is reversible, so admission can be restored for retry.
    backend.abortDestroySession();
  });

  it('refuses the close when the local child cannot be proven dead', async () => {
    // Lineage exists and the cancel succeeds, so the only open question is the
    // local credentialed child. SIGTERM alone is not proof: this child never
    // exits and never reports an exit code, which is what an uninterruptible
    // process looks like. Publishing a closed row here would drop the
    // device-isolation blocker for a process still holding the injected JWT.
    const bin = fakeMojo('mojo-stuck', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
echo '{"type":"system","subtype":"init","session_id":"sid-stuck"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-stuck","warnings":[]}'`);
    const backend = new MojoBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('start');
    await vi.waitFor(() => expect(backend.cliSessionIdForTest).toBe('sid-stuck'));

    // Swap in a child that survives every signal and reports no exit status.
    const stuck = Object.assign(new EventEmitter(), {
      pid: 424242,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });
    (backend as unknown as { child: unknown }).child = stuck;

    await expect(backend.destroySession()).resolves.toMatchObject({
      ok: false,
      taskId: 'sid-stuck',
      error: 'mojo_local_child_termination_unproven',
    });
  }, 20_000);
});
