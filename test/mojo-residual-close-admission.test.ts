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
 * It holds for a third reason: a successful close sets `killed`, and write()
 * refuses on `killed` before it ever consults the fence. That is a real guarantee,
 * but it is a DIFFERENT mechanism than the fence, so it deserves its own test
 * instead of being inferred from the fencing tests.
 *
 * Run:  pnpm vitest run test/mojo-residual-close-admission.test.ts
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MojoBackend } from '../src/adapters/backend/mojo-backend.js';

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
    (backend as unknown as { terminateChildProven: () => Promise<boolean> })
      .terminateChildProven = async () => false;
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

    // The handover invariant. A residual close does not latch the fence, so this
    // must be refused by the teardown itself.
    expect(backend.write('a turn after a residual close')).toBe(false);
    // The DISCRIMINATING assertion. The line above is satisfied by `closing`, which
    // the residual path never resets, so it holds even if `killed` was never set --
    // it cannot observe that guard at all. `killed`'s real job here is to make a
    // later abort a NO-OP: abortDestroySession() returns early on `killed`, and the
    // residual path deliberately does not latch `admissionFenced`, so without
    // `killed` the abort falls through and clears `closing`, re-opening writes on a
    // session that still has an unenumerable credentialed subtree.
    await backend.abortDestroySession();
    expect(backend.write('a turn after aborting a residual close')).toBe(false);
  }, 20_000);

  it('does not mark a normally-proven close as residual', async () => {
    // Guards the blast radius from the other side: if `residual` leaked onto every
    // close, the daemon could not tell a genuinely clean teardown from one that
    // left an unenumerable subtree behind.
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
    expect(result.residual).toBeUndefined();
    expect(backend.write('a turn after a clean close')).toBe(false);
  }, 20_000);
});
