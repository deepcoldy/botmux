/**
 * Node's process.kill is PID-addressed and PM2's `kill` RPC is PM2_HOME/socket
 * addressed; neither binds a signal to a PID+birth generation. Therefore a
 * live God cannot be safely replaced automatically. This admission check must
 * run before any fleet or breadcrumb mutation.
 */
export function assertIncludePm2RestartAdmission(pids: readonly number[]): void {
  const canonical = [...new Set(pids)]
    .filter(pid => Number.isSafeInteger(pid) && pid > 1)
    .sort((a, b) => a - b);
  if (canonical.length !== pids.length) {
    throw new Error('[restart --include-pm2] PM2 God scan returned invalid/duplicate PIDs');
  }
  if (canonical.length === 0) return;
  if (canonical.length > 1) {
    throw new Error(
      `[restart --include-pm2] multiple PM2 God daemons are visible `
      + `(pids: ${canonical.join(', ')}); no process or breadcrumb was changed`,
    );
  }
  throw new Error(
    `[restart --include-pm2] refusing before fleet mutation: live PM2 God pid ${canonical[0]} `
    + 'cannot be signalled with generation-bound authority on this platform; '
    + 'this option does not signal or restart an existing God; '
    + 'no process or breadcrumb was changed',
  );
}
