import '../../src/worker.js';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Observe the real worker only after the fake CLI has started. No production
// test hooks: importing worker.ts installs its normal IPC init handler.
const cliObservation = process.env.SESSION_TEMP_CLI_OBSERVATION!;
const workerObservation = process.env.SESSION_TEMP_WORKER_OBSERVATION!;
const timer = setInterval(() => {
  if (!existsSync(cliObservation)) return;
  writeFileSync(workerObservation, JSON.stringify({
    TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
    tmpdir: tmpdir(),
  }));
  clearInterval(timer);
}, 20);
timer.unref();
