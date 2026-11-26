// Run one supervisor with one maintenance-deferred daemon and no test-harness
// handles. In run mode, only the supervisor's deferral timer can keep the event
// loop alive. In stop modes, the stop trigger is deliberately unref'd too: the
// process can exit only after the deferral timer has held it long enough for the
// requested stop to run and cancel that timer.
// argv: <statePath> <distDir> <cwd> <dataDir> <run|stopAll|stopOneBot>
import { FleetSupervisor } from '../../src/core/fleet-supervisor.js';

const [statePath, distDir, cwd, dataDir, mode] = process.argv.slice(2);
if (!statePath || !distDir || !cwd || !dataDir || !['run', 'stopAll', 'stopOneBot'].includes(mode)) {
  throw new Error('invalid maintenance host arguments');
}

const sup = new FleetSupervisor({
  statePath,
  distDir,
  daemonEnv: { SESSION_DATA_DIR: dataDir },
  cwd,
  log: () => {},
});
sup.start([{ name: 'botmux-0', appId: 'cli_a', botIndex: 0 }]);

if (mode !== 'run') {
  const trigger = setTimeout(() => {
    const stopping = mode === 'stopAll' ? sup.stopAll() : sup.stopOneBot('botmux-0');
    void stopping.catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  }, 100);
  trigger.unref();
}
