/**
 * `restart --include-pm2` God retirement.
 *
 * A PID-addressed kill(2) cannot bind a signal to a PID+birth generation, so
 * this module never signals the God by PID. The kill is addressed to the
 * PM2_HOME control socket (`pm2 kill`) — i.e. to
 * "whichever God owns this home", which is exactly the object being retired —
 * and the recorded pid+birth identity is used only to VERIFY disappearance
 * afterwards. Callers must run this strictly AFTER the managed core fleet has
 * been retired and verified gone (and plugin services stopped): with an empty
 * fleet the God holds no session state, so retiring it cannot interrupt a
 * Riff prepare/persist/commit handshake.
 */

export interface Pm2GodRetirementRuntime {
  /** Scan for God processes owning this PM2_HOME (cmdline-marker based). */
  listGodPids(): number[];
  /** Birth identity for verification only — never signalling authority. */
  readStartIdentity(pid: number): string | undefined;
  isAlive(pid: number): boolean;
  /** Bounded `pm2 kill` against this PM2_HOME's control socket. */
  pm2Kill(): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const PM2_GOD_RETIREMENT_VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_POLL_INTERVAL_MS = 200;

export interface RetiredPm2God {
  pid: number;
  startIdentity: string | undefined;
}

export interface Pm2RegistryRowLiveness {
  name: string;
  status: string | undefined;
  pid: number | undefined;
}

/** Registry statuses that prove no process is running for the row. */
const TERMINAL_PM2_ROW_STATUSES: ReadonlySet<string> = new Set(['stopped', 'errored']);

/**
 * `pm2 kill` slaughters every process the God still manages without any
 * graceful handshake, so the God may only be retired once the WHOLE registry
 * is quiescent: every row — core, plugin, or an orphaned row a plugin
 * uninstall left behind — must be in a terminal status with no live pid. A
 * plugin stop that failed (stop errors are collected into reports, not
 * rethrown) or a leftover running `botmux-plugin-*` row therefore blocks the
 * kill here, fail-closed, instead of being silently killed with the God.
 */
export function assertPm2RegistryQuiescentForGodRetirement(
  rows: readonly Pm2RegistryRowLiveness[],
): void {
  const live = rows.filter(row => {
    const status = (row.status ?? '').trim();
    const pidLive = typeof row.pid === 'number' && Number.isSafeInteger(row.pid) && row.pid > 0;
    return pidLive || !TERMINAL_PM2_ROW_STATUSES.has(status);
  });
  if (live.length === 0) return;
  const detail = live
    .map(row => `${row.name}:${row.status ?? 'unknown'}${row.pid ? `:pid ${row.pid}` : ''}`)
    .join(', ');
  throw new Error(
    `[restart --include-pm2] refusing pm2 kill: PM2 registry still has live/unproven row(s): ${detail}; `
    + 'stop or delete them first (e.g. a plugin service that failed to stop, or a leftover '
    + 'botmux-plugin-* row from an uninstalled plugin); the God and every remaining process were left untouched',
  );
}

/**
 * Between God retirement and the fresh `pm2 start`, any pm2 client invocation
 * (even a read-only jlist from another shell) lazily births a God from ITS
 * environment, not from this restart's cleaned one. Accepting it would defeat
 * the whole point of --include-pm2, so the start transaction refuses.
 */
export function assertNoReplacementPm2God(pids: readonly number[]): void {
  if (pids.length === 0) return;
  throw new Error(
    `[restart --include-pm2] a replacement PM2 God (pid ${pids.join(', ')}) appeared between God `
    + 'retirement and the fleet start; it was not born from this restart\'s cleaned environment — '
    + 'rerun `botmux restart --include-pm2`',
  );
}

/**
 * Retire the sole live PM2 God, or return null when none is alive. Fails
 * closed — without mutating anything — on an invalid scan or multiple visible
 * Gods, and fails closed after `pm2 kill` if the God's disappearance cannot
 * be proven within the timeout.
 */
export async function retireSoleLivePm2God(
  rt: Pm2GodRetirementRuntime,
  timeoutMs: number = PM2_GOD_RETIREMENT_VERIFY_TIMEOUT_MS,
): Promise<RetiredPm2God | null> {
  const scanned = rt.listGodPids();
  const canonical = [...new Set(scanned)]
    .filter(pid => Number.isSafeInteger(pid) && pid > 1)
    .sort((a, b) => a - b);
  if (canonical.length !== scanned.length) {
    throw new Error('[restart --include-pm2] PM2 God scan returned invalid/duplicate PIDs; no process was signalled');
  }
  if (canonical.length === 0) return null;
  if (canonical.length > 1) {
    throw new Error(
      `[restart --include-pm2] multiple PM2 God daemons are visible `
      + `(pids: ${canonical.join(', ')}); no process was signalled`,
    );
  }

  const pid = canonical[0];
  const startIdentity = rt.readStartIdentity(pid);
  rt.pm2Kill();

  const deadline = rt.now() + timeoutMs;
  for (;;) {
    // Two independent proofs: the marker scan finds no God for this home, and
    // the original pid is gone (or its slot was reused by a different birth).
    const scanEmpty = rt.listGodPids().length === 0;
    const originalGone = !rt.isAlive(pid)
      || (startIdentity !== undefined && rt.readStartIdentity(pid) !== startIdentity);
    if (scanEmpty && originalGone) return { pid, startIdentity };
    if (rt.now() >= deadline) {
      throw new Error(
        `[restart --include-pm2] PM2 God pid ${pid} is still observable after pm2 kill; `
        + 'the core fleet is already retired and nothing further was mutated — '
        + 'inspect the God process, then rerun `botmux restart` (with or without --include-pm2) to bring the fleet back',
      );
    }
    await rt.sleep(VERIFY_POLL_INTERVAL_MS);
  }
}
