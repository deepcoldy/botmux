/**
 * `kill(pid, 0)` liveness probes, one named function per verdict policy.
 *
 * The three policies are NOT interchangeable — they differ in what an `EPERM`
 * (the pid exists but belongs to another user) and any other errno mean — and
 * the call sites rely on the exact policy they were written with (lock-holder
 * reclaim wants "can I signal it", occupancy leases want "does it exist",
 * fleet inventory wants "has it provably gone"). Pick by the question you are
 * asking; do not "unify" them.
 *
 * None of these validates `pid` (0, negative or fractional pids mean process
 * groups / "everyone" to kill(2)); callers that can see untrusted values guard
 * first. None of them detects a zombie or pid reuse — see
 * utils/process-identity for those.
 */

function probeErrno(pid: number): string | undefined | null {
  try {
    process.kill(pid, 0);
    return null; // signal delivered: alive and ours
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code;
  }
}

/** Alive AND signalable by us. Every failure — ESRCH, EPERM, anything else — is
 *  "not alive". Use when the next step is to signal / take over the process. */
export function pidIsSignalable(pid: number): boolean {
  return probeErrno(pid) === null;
}

/** The pid exists. EPERM (exists, not ours) counts as alive; ESRCH and every
 *  other error count as dead. Use for "is some process holding this pid". */
export function pidExistsEpermAlive(pid: number): boolean {
  const code = probeErrno(pid);
  return code === null || code === 'EPERM';
}

/** Only ESRCH proves the pid is gone; EPERM and any unexpected error keep it
 *  "possibly alive". Fail-closed for "may I treat it as dead?" questions. */
export function pidNotProvablyGone(pid: number): boolean {
  return probeErrno(pid) !== 'ESRCH';
}
