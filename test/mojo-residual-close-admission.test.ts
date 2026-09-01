/**
 * A residual close must still refuse new writes.
 *
 * This is the one invariant that falls between two owners, so it was explicitly
 * handed over rather than assumed: the containment layer guarantees "the session
 * is never reported clean" (its unprovable handle can never be released, so the
 * device-isolation blocker survives), but it does NOT govern write admission. And
 * the platform-residual close deliberately does NOT latch the write fence — that
 * latch is exactly what produced the permanent wedge on hosts with no /proc.
 *
 * So on the residual path nothing that normally refuses writes is in play: the
 * fence is intentionally absent and the containment blocker cannot help. If the
 * session still accepted a turn afterwards, a credentialed subtree we cannot
 * enumerate would be sharing a session with fresh work — which is the exact hazard
 * the fence exists to prevent, reached by a different route.
 *
 * WHICH GUARD DOES WHAT — measured, not inferred; read before editing asserts
 * ---------------------------------------------------------------------------
 * write() refuses on `killed || closing || shutdownDetaching`, and the residual
 * close sets TWO of them. Measured flag matrix on this path:
 *
 *              AFTER CLOSE                  AFTER A LATER abortDestroySession()
 *   clean      killed=1 closing=1 -> refused    killed=1 closing=1 -> refused
 *   no killed  killed=0 closing=1 -> refused    killed=0 closing=0 -> ADMITTED
 *   no closing killed=1 closing=0 -> refused    killed=1 closing=0 -> refused
 *
 * Two consequences that decide where the assertions go:
 *
 * 1. Straight after the close, BOTH flags are set and either alone refuses. So an
 *    assertion at that moment cannot observe either flag individually — dropping
 *    `killed` leaves it green. That is measured, not assumed, and it is why this
 *    test asserts a SECOND time after an abort.
 * 2. Only `killed` governs the post-abort moment: abortDestroySession() begins
 *    with `if (this.killed) return;`, so without it the abort proceeds and clears
 *    `closing`, admitting the next turn onto a subtree this platform cannot
 *    enumerate. The post-abort assertion is the ONLY coverage of `killed` here;
 *    remove it and that guarantee is unguarded again.
 *
 * Also recorded so nobody "adds coverage" for it and reports a kill: dropping
 * `closing` alone is an EQUIVALENT mutation with respect to write admission,
 * because `killed` already refuses at both moments. `closing` earns its keep
 * elsewhere (it gates the window before the close completes), not here.
 *
 * Run:  pnpm vitest run test/mojo-residual-close-admission.test.ts
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'bun:test';
import { MojoBackend } from '../src/adapters/backend/mojo-backend.js';
import type { TerminationOutcome } from '../src/adapters/backend/mojo-process-tree.js';
import { isLinux } from './helpers/synthetic-proc.js';

let binDir: string;
beforeAll(() => { binDir = mkdtempSync(join(tmpdir(), 'mojo-residual-')); });
afterAll(() => { rmSync(binDir, { recursive: true, force: true }); });

function fakeMojo(name: string, body: string): string {
  const p = join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

class FastProofBackend extends MojoBackend {
  protected override get terminationProofBudgetMs(): number { return 300; }
}

describe('platform-residual close', () => {
  it('closes with a residual marker and still refuses further writes', async () => {
    const bin = fakeMojo('mojo-residual', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
echo '{"type":"system","subtype":"init","session_id":"sid-residual"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-residual","warnings":[]}'`);
    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('start');
    await vi.waitFor(() => expect(backend.cliSessionIdForTest).toBe('sid-residual'));

    // Force the one terminal verdict that routes to a residual close. Stubbing the
    // quiescence result (rather than faking a Darwin host) keeps this runnable on
    // Linux CI, which is the only place we can run it at all.
    (backend as unknown as { terminateChildProven: () => Promise<TerminationOutcome> })
      .terminateChildProven = async () => ({
        ok: false,
        boundaryProven: false,
        evidence: 'unknown',
        residual: { deviceIsolation: true, reason: 'cannot enumerate on darwin' },
        signalsStopped: false,
      });
    (backend as unknown as { lastQuiescence: unknown }).lastQuiescence = {
      kind: 'unsupported-platform',
      boundaryProof: false,
      platform: 'darwin',
    };

    const result = await backend.destroySession();

    // Closed, not fenced: a platform with no instrument must not wedge the session.
    expect(result).toMatchObject({
      ok: true,
      taskId: 'sid-residual',
      residual: 'local_subtree_unprovable_on_platform',
    });
    // The honest part of the verdict: it is NOT dressed up as a clean close.
    expect(result.admission).toBeUndefined();

    // The handover invariant. A residual close does not latch the fence, so the
    // teardown itself must refuse. NOTE: at this moment both guards are set, so
    // this assertion cannot observe either one alone — see the header matrix.
    expect(backend.write('a turn after a residual close')).toBe(false);

    // The second moment, and the only one sensitive to `killed`. A rollback of a
    // residual close is meaningless — nothing was held back that could be given
    // up — so the abort must be a no-op rather than a way back to a writable
    // session. `killed` is what enforces that; without it the abort clears
    // `closing` and the next turn is admitted on top of a subtree this platform
    // cannot enumerate.
    await backend.abortDestroySession();
    expect(backend.write('a turn after aborting a residual close')).toBe(false);
  }, 20_000);

  // Linux-only: it needs a REAL live child plus /proc enumeration to reach a
  // termination verdict. Off Linux the scanner returns unsupported-platform by
  // design, so this case is skipped explicitly instead of failing.
  it.runIf(isLinux)('marks an ordinary clean-scan close as boundary-unproven, not as fully clean', async () => {
    // Guards the blast radius from the other side. `residual` must not be one
    // undifferentiated flag: the daemon has to tell "this host has no instrument"
    // apart from "the instrument answered and its answer is not proof".
    //
    // This assertion was INVERTED before indictment A: it demanded
    // `residual === undefined` for exactly this path, which is the ordinary Linux
    // weak-handle close. That is the fail-open the reviewer reproduced -- a clean
    // scan publishing a plain closed row, which drops the session out of the
    // device-isolation inventory while a setsid'd, environ-scrubbed descendant may
    // still hold the credential. A clean scan now closes the session WITH a
    // residual marker so the blocker is retained.
    const bin = fakeMojo('mojo-clean', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
echo '{"type":"system","subtype":"init","session_id":"sid-clean"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-clean","warnings":[]}'
exit 0`);
    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('start');
    await vi.waitFor(() => expect(backend.cliSessionIdForTest).toBe('sid-clean'));
    await vi.waitFor(() => {
      expect((backend as unknown as { child: unknown }).child).toBeNull();
    }, { timeout: 10_000 });

    const result = await backend.destroySession();
    expect(result).toMatchObject({ ok: true, taskId: 'sid-clean' });
    // Closed, but explicitly NOT laundered into a proof-backed clean close...
    expect(result.residual).toBe('local_subtree_boundary_unproven');
    // ...and still distinguishable from the no-instrument platform verdict.
    expect(result.residual).not.toBe('local_subtree_unprovable_on_platform');
    expect(backend.write('a turn after a clean close')).toBe(false);
  }, 20_000);
});
