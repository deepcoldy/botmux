/**
 * "The close may be retried" and "writes may be admitted again" are TWO
 * different questions. destroy-result.ts used to answer the second one by
 * reading the first one's field (`recovery`), which opened a real fencing hole:
 * `mojo_local_child_termination_unproven` is legitimately `retryable` (the
 * irreversible remote cancel has not run yet), so the worker rolled back and a
 * probe could `write()` successfully while a process still holding the injected
 * credential was possibly alive.
 *
 * Every case here is a BEHAVIOURAL probe: it calls the real `write()` and the
 * real `abortDestroySession()` instead of asserting on the returned object.
 * That distinction is the point — the previous test in this area asserted only
 * `recovery: 'retryable'`, which is exactly the value the bug produced, so it
 * stayed green while admission was being re-opened.
 *
 * Run:  pnpm vitest run test/mojo-close-admission-fence.test.ts
 */
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MojoBackend } from '../src/adapters/backend/mojo-backend.js';
import type { TerminationOutcome } from '../src/adapters/backend/mojo-process-tree.js';
import { isLinux } from './helpers/synthetic-proc.js';
import {
  buildCloseResultMessage,
  interpretAbortOutcome,
  mayRestoreWriteAdmission,
  mayRetryClose,
  normalizeDestroyResult,
} from '../src/adapters/backend/destroy-result.js';

let binDir: string;
beforeAll(() => { binDir = mkdtempSync(join(tmpdir(), 'mojo-admission-')); });
afterAll(() => { rmSync(binDir, { recursive: true, force: true }); });

function fakeMojo(name: string, body: string): string {
  const p = join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** Keeps the escalation ladder in milliseconds; see mojo-close-failclosed. */
class FastProofBackend extends MojoBackend {
  protected override get terminationProofBudgetMs(): number { return 300; }
}

/**
 * Point the backend at a REAL live process group whose kills are swallowed.
 * A non-existent pid would make the liveness probe answer ESRCH and the test
 * would pass for the wrong reason (nothing to prove alive), so the victim has
 * to genuinely exist while SIGTERM/SIGKILL aimed at it do nothing.
 */
async function withUnprovableChild<T>(
  backend: MojoBackend,
  fn: () => Promise<T>,
): Promise<T> {
  const { spawn } = await import('node:child_process');
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
  (backend as unknown as { child: unknown }).child = Object.assign(new EventEmitter(), {
    pid: victimPid,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  try {
    return await fn();
  } finally {
    killSpy.mockRestore();
    try { realKill(-victimPid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

describe('close retryability and write admission are separate verdicts', () => {
  // Linux-only: it needs a REAL live child plus /proc enumeration to reach a
  // termination verdict. Off Linux the scanner returns unsupported-platform by
  // design, so this case is skipped explicitly instead of failing.
  it.runIf(isLinux)('keeps writes fenced after an unproven local termination, even across abortDestroySession()', async () => {
    const bin = fakeMojo('mojo-adm-unproven', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
echo '{"type":"system","subtype":"init","session_id":"sid-adm"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-adm","warnings":[]}'`);
    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('start');
    await vi.waitFor(() => expect(backend.cliSessionIdForTest).toBe('sid-adm'));

    const result = await withUnprovableChild(backend, () => backend.destroySession());

    // The close itself IS retryable: nothing irreversible ran (the remote cancel
    // sits after this early return). That must not be confused with admission.
    expect(result).toMatchObject({
      ok: false,
      taskId: 'sid-adm',
      error: 'mojo_local_child_termination_unproven',
      recovery: 'retryable',
      admission: 'fenced',
    });
    expect(mayRetryClose(result)).toBe(true);
    // The verdict the worker actually acts on.
    expect(mayRestoreWriteAdmission(result)).toBe(false);

    // Behaviour, not shape: a possibly-live credentialed process means no new turn.
    expect(backend.write('a turn that must be refused')).toBe(false);

    // And the fence must be LATCHED. A close the daemon could not commit is
    // legitimately aborted, but "the close was abandoned" is not evidence that
    // the survivor died — this is the call that used to clear `closing` and let
    // the very next write() through.
    await backend.abortDestroySession();
    expect(backend.write('a turn after the abort')).toBe(false);
  }, 60_000);

  // Linux-only: it needs a REAL live child plus /proc enumeration to reach a
  // termination verdict. Off Linux the scanner returns unsupported-platform by
  // design, so this case is skipped explicitly instead of failing.
  it.runIf(isLinux)('REPORTS the refused rollback instead of letting the daemon infer success', async () => {
    // The cross-layer half of the same bug. abortDestroySession() returning void
    // on a refusal is indistinguishable from a successful restore, and the daemon
    // treats "the worker answered without throwing" as admissionRestored:true —
    // so the durable journal clears a fence that write() is still enforcing.
    const bin = fakeMojo('mojo-adm-report', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
echo '{"type":"system","subtype":"init","session_id":"sid-report"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-report","warnings":[]}'`);
    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('start');
    await vi.waitFor(() => expect(backend.cliSessionIdForTest).toBe('sid-report'));
    await withUnprovableChild(backend, () => backend.destroySession());

    const outcome = interpretAbortOutcome(await backend.abortDestroySession());
    expect(outcome).toMatchObject({
      admissionRestored: false,
      reason: 'local_termination_unproven',
    });
    // The report must agree with the observable behaviour, which is the whole
    // point: a `true` here would be a durable lie.
    expect(backend.write('a turn after the refused abort')).toBe(false);
  }, 60_000);

  it('keeps the close retryable after the fence latches', async () => {
    // Pins the LIVENESS half of the latched fence: a fence that also blocked the
    // close would leave the session un-closeable forever, which is worse than the
    // bug being fixed. Verified killable — making `admissionFenced` short-circuit
    // destroySession() turns this red.
    //
    // Scope note, deliberately narrow: this does NOT assert that the fence outlives
    // a SUCCESSFUL close. That is unobservable and therefore untestable here —
    // after a successful close `killed` is true, so write() refuses regardless of
    // the fence, and clearing `admissionFenced` at that point is an equivalent
    // mutation (confirmed: it survives). The field comment states the one-way
    // lifetime as an implementation fact, not as a tested guarantee.
    const bin = fakeMojo('mojo-adm-lifetime', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
echo '{"type":"system","subtype":"init","session_id":"sid-lifetime"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-lifetime","warnings":[]}'`);
    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('start');
    await vi.waitFor(() => expect(backend.cliSessionIdForTest).toBe('sid-lifetime'));

    // First close: local termination cannot be proven → fence latches.
    await withUnprovableChild(backend, () => backend.destroySession());
    expect(backend.write('refused while fenced')).toBe(false);

    // The survivor is now gone, so the retried close must reach the remote cancel
    // and SUCCEED. The fence must not have wedged it.
    (backend as unknown as { terminateChildProven: () => Promise<TerminationOutcome> })
      .terminateChildProven = async () => ({
        ok: true,
        boundaryProven: true,
        evidence: 'members-empty',
        residual: null,
        signalsStopped: true,
      });
    await expect(backend.destroySession()).resolves.toMatchObject({
      ok: true,
      taskId: 'sid-lifetime',
    });
  }, 60_000);

  it('does not claim restoration after the session was already torn down', async () => {
    const bin = fakeMojo('mojo-adm-torndown', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
echo '{"type":"system","subtype":"init","session_id":"sid-torn"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-torn","warnings":[]}'
exit 0`);
    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('start');
    await vi.waitFor(() => expect(backend.cliSessionIdForTest).toBe('sid-torn'));
    await vi.waitFor(() => {
      expect((backend as unknown as { child: unknown }).child).toBeNull();
    }, { timeout: 10_000 });
    await expect(backend.destroySession()).resolves.toMatchObject({ ok: true });

    // A proven cancel is irreversible; restoring admission would produce a
    // session that looks writable but can never continue.
    expect(interpretAbortOutcome(await backend.abortDestroySession())).toMatchObject({
      admissionRestored: false,
      reason: 'session_already_torn_down',
    });
    expect(backend.write('a turn after teardown')).toBe(false);
  }, 60_000);

  it('does not let the earlier local failure launder a missing lineage into retryable', async () => {
    // Both faults at once: a turn was dispatched with no lineage AND the local
    // subtree cannot be proven dead. The local check returns first, so its
    // verdict used to overwrite the `uncertain` the lineage check would have
    // produced for the same session — downgrading an unnamable remote session to
    // "just retry it".
    const bin = fakeMojo('mojo-adm-nolineage', `if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
exit 0`);
    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('a turn whose lineage never arrives');
    await vi.waitFor(() => {
      expect((backend as unknown as { acceptedWriteWithoutLineage: boolean }).acceptedWriteWithoutLineage).toBe(true);
    });
    expect(backend.cliSessionIdForTest).toBeUndefined();

    // The local proof is forced to fail rather than staged with a real
    // unkillable victim: reproducing BOTH faults from real processes is
    // timing-dependent (the no-lineage child exits, so the nonce scan can
    // legitimately come back quiescent and the case would silently degrade into
    // the plain mojo_lineage_not_materialized path it is meant to contrast with).
    // What matters here is only the ORDER of the two verdicts.
    (backend as unknown as { terminateChildProven: () => Promise<TerminationOutcome> })
      .terminateChildProven = async () => ({
        ok: false,
        boundaryProven: false,
        evidence: 'timeout',
        residual: { deviceIsolation: true, pids: [424242] },
        signalsStopped: false,
      });

    const result = await backend.destroySession();

    expect(result).toMatchObject({
      ok: false,
      error: 'mojo_local_child_termination_unproven',
      // NOT 'retryable': there may be a remote session we can never name.
      recovery: 'uncertain',
      admission: 'fenced',
    });
    // No id to hand back, so none is invented.
    expect(result.taskId).toBeUndefined();
    expect(mayRestoreWriteAdmission(result)).toBe(false);
    expect(backend.write('a turn that must be refused')).toBe(false);
    await backend.abortDestroySession();
    expect(backend.write('a turn after the abort')).toBe(false);
  }, 60_000);

  it('still restores admission when the local subtree was PROVEN gone and only the remote cancel failed', async () => {
    // The counter-case that stops the fix from degenerating into "fence
    // everything": here the local child really is gone and the remote session is
    // named, so there is no unnamed survivor. Admission must come back, or a
    // failed cancel would strand a session that can never be written to again.
    const bin = fakeMojo('mojo-adm-cancelfail', `if [ "$1" = "session" ] && [ "$2" = "cancel" ]; then echo 'cancel exploded' >&2; exit 3; fi
if [ "$1" = "session" ]; then echo '{"status":"ok"}'; exit 0; fi
echo '{"type":"system","subtype":"init","session_id":"sid-cancelfail"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-cancelfail","warnings":[]}'
exit 0`);
    const backend = new FastProofBackend({ bin }, 'session-under-test');
    backend.spawn('', [], {} as never);
    backend.write('start');
    await vi.waitFor(() => expect(backend.cliSessionIdForTest).toBe('sid-cancelfail'));
    await vi.waitFor(() => {
      expect((backend as unknown as { child: unknown }).child).toBeNull();
    }, { timeout: 10_000 });

    const result = await backend.destroySession();
    expect(result).toMatchObject({
      ok: false,
      taskId: 'sid-cancelfail',
      recovery: 'retryable',
      admission: 'restorable',
    });
    expect(mayRestoreWriteAdmission(result)).toBe(true);
    // destroySession already cleared its own gate on this path, and the abort is
    // what the worker calls; both must leave the session writable.
    await backend.abortDestroySession();
    expect(backend.write('a follow-up turn after a failed cancel')).toBe(true);
  }, 60_000);
});

describe('destroy-result reads admission, not retryability', () => {
  it('fences a retryable result that explicitly asks for a fence', () => {
    // The exact shape the mojo backend now returns. Keyed on `recovery` this
    // reads `true`, which is the bug.
    expect(mayRestoreWriteAdmission({
      ok: false,
      error: 'mojo_local_child_termination_unproven',
      recovery: 'retryable',
      admission: 'fenced',
    })).toBe(false);
    // ... while the close stays retryable.
    expect(mayRetryClose({
      ok: false,
      recovery: 'retryable',
      admission: 'fenced',
    })).toBe(true);
  });

  it('derives admission from recovery only when it is absent', () => {
    expect(mayRestoreWriteAdmission({ ok: false, recovery: 'retryable' })).toBe(true);
    expect(mayRestoreWriteAdmission({ ok: false, recovery: 'uncertain' })).toBe(false);
    expect(mayRestoreWriteAdmission({ ok: false, recovery: 'irreversible' })).toBe(false);
    expect(mayRestoreWriteAdmission({ ok: false })).toBe(true);
    // An explicit `restorable` is honoured even against a fencing recovery, so the
    // two fields cannot silently disagree in the unsafe direction only.
    expect(mayRestoreWriteAdmission({ ok: false, recovery: 'uncertain', admission: 'restorable' })).toBe(true);
    expect(mayRestoreWriteAdmission({ ok: true })).toBe(false);
  });

  it('never reports an irreversible close as retryable', () => {
    expect(mayRetryClose({ ok: false, recovery: 'irreversible' })).toBe(false);
    expect(mayRetryClose({ ok: false, recovery: 'uncertain' })).toBe(true);
    expect(mayRetryClose({ ok: true })).toBe(false);
  });

  it('fences an unknown remote result on its own field', () => {
    expect(normalizeDestroyResult(undefined, { remote: true })).toMatchObject({
      ok: false,
      error: 'remote_close_result_missing',
      recovery: 'uncertain',
      admission: 'fenced',
    });
    expect(mayRestoreWriteAdmission(normalizeDestroyResult({ ok: 'yes' }, { remote: true }))).toBe(false);
  });

  it('forwards admission across the IPC boundary', () => {
    // Dropping it here would let the daemon re-derive "retryable so writes are
    // fine" and undo a fence the backend deliberately kept — the same laundering
    // bug `recovery` already had at this boundary.
    expect(buildCloseResultMessage('req-fence', {
      ok: false,
      taskId: 'sid-adm',
      error: 'mojo_local_child_termination_unproven',
      recovery: 'retryable',
      admission: 'fenced',
    })).toEqual({
      type: 'close_result',
      requestId: 'req-fence',
      ok: false,
      taskId: 'sid-adm',
      error: 'mojo_local_child_termination_unproven',
      recovery: 'retryable',
      admission: 'fenced',
    });
    expect(buildCloseResultMessage('req-plain', { ok: true })).toEqual({
      type: 'close_result',
      requestId: 'req-plain',
      ok: true,
    });
  });
});

describe('interpretAbortOutcome fails closed', () => {
  it('treats a legacy void return as a genuine restore', () => {
    // Riff and the local backends return void from abortDestroySession and really
    // do restore admission, so this shape must stay compatible.
    expect(interpretAbortOutcome(undefined)).toEqual({ admissionRestored: true });
    expect(interpretAbortOutcome(null)).toEqual({ admissionRestored: true });
  });

  it('honours an explicit refusal and carries its reason', () => {
    expect(interpretAbortOutcome({ admissionRestored: false, reason: 'local_termination_unproven' }))
      .toEqual({ admissionRestored: false, reason: 'local_termination_unproven' });
    expect(interpretAbortOutcome({ admissionRestored: true })).toEqual({ admissionRestored: true });
  });

  it('fences a malformed answer instead of reading it as success', () => {
    // typeof, NOT truthiness: `{ admissionRestored: 'yes' }` would otherwise pass a
    // plain `if (outcome.admissionRestored)` check. A fence wrongly cleared is
    // unrecoverable; a fence wrongly kept is merely retried.
    for (const raw of [{}, { admissionRestored: 'yes' }, 'restored', 42, [], true]) {
      expect(interpretAbortOutcome(raw), `raw=${JSON.stringify(raw)}`)
        .toEqual({ admissionRestored: false, reason: 'abort_result_malformed' });
    }
  });
});
