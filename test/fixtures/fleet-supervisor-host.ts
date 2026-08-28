// Standalone supervisor host for the "restart backoff timer must keep the event
// loop alive" regression test. Runs a FleetSupervisor in ITS OWN process (no
// vitest/test-harness handles propping up the loop) with one crash-looping fake
// daemon. If the restart timer were unref'd, this process would drain its loop
// and exit mid-backoff after the first crash, never reaching restarts>=2 — the
// exact bug this guards. argv: <statePath> <distDir> <cwd>
import { FleetSupervisor } from '../../src/core/fleet-supervisor.js';

const [statePath, distDir, cwd] = process.argv.slice(2);
const sup = new FleetSupervisor({
  statePath,
  distDir,
  daemonEnv: {},
  cwd,
  policy: { maxRestarts: 50, restartDelayMs: 60 },
  log: () => {},
});
sup.start([{ name: 'botmux-0', appId: 'cli_a', botIndex: 0 }]);
// Deliberately hold NOTHING ourselves — only the supervisor's (ref'd) restart
// timer should keep this process alive across each backoff.
