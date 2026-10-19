import { nudgeRead, spawn } from '../../src/utils/pty.js';

const mode = process.env.BOTMUX_TEST_PTY_PROBE_MODE ?? 'gap';
const started = Date.now();
const script = mode === 'input'
  ? 'stty -echo; printf READY; read value; stty size; printf "reply:%s\\n" "$value"'
  : mode === 'cancel' ? 'printf READY; sleep 30'
  : mode === 'echo' || mode === 'echo-nudge' ? 'stty -echo; printf READY; while read line; do printf "r:%s;" "$line"; done'
  : mode === 'pause' ? 'stty -echo; printf first; sleep 0.1; i=0; while [ "$i" -lt 4096 ]; do printf AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; i=$((i+1)); done; printf last; read ack'
  : 'printf first; sleep 0.3; printf "\\344\\275"; sleep 0.1; printf "\\240\\345\\245\\275"; printf last';
const terminal = spawn('/bin/sh', ['-c', script], {
  cwd: process.cwd(), env: { PATH: '/usr/bin:/bin', HOME: process.cwd() },
  name: 'xterm-256color', cols: 80, rows: 24,
});
let output = '';
let acted = false;
let acknowledged = false;
let liveBeforeKill = false;
const echoLatencies: number[] = [];

/** Echo round trips after an idle gap long enough for the Bun reader to be
 * sitting in its idle retry; `echo-nudge` calls nudgeRead after each write. */
async function measureEcho(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 120));
    const want = `r:${i};`;
    const t0 = performance.now();
    terminal.write(`${i}\n`);
    if (mode === 'echo-nudge') nudgeRead(terminal);
    while (!output.includes(want)) await new Promise(r => setTimeout(r, 0));
    echoLatencies.push(performance.now() - t0);
  }
  terminal.write('\x04');
}
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { terminal.kill('SIGKILL'); reject(new Error('PTY probe timed out')); }, 5000);
  terminal.onData(data => {
    output += data;
    if (!acted && mode === 'pause') {
      acted = true; terminal.pause(); setTimeout(() => terminal.resume(), 350);
    }
    if (!acknowledged && mode === 'pause' && output.endsWith('last')) {
      // Exercise backpressure with a live child. node-pty forcibly destroys
      // its reader 200ms after child exit, which can truncate queued output
      // on busy hosts; that independent teardown limit is not this probe's
      // contract. Keep the child alive until we have received its whole burst.
      acknowledged = true; terminal.write('done\n');
    }
    if (!acted && output.includes('READY')) {
      acted = true;
      if (mode === 'input') { terminal.resize(99, 31); terminal.write('hello\n'); }
      if (mode === 'echo' || mode === 'echo-nudge') void measureEcho();
      if (mode === 'cancel') setTimeout(() => {
        try { process.kill(terminal.pid, 0); liveBeforeKill = true; } catch { /* asserted by parent */ }
        terminal.kill('SIGTERM');
      }, 100);
    }
  });
  terminal.onExit(exit => {
    clearTimeout(timer);
    process.stdout.write(JSON.stringify({ output, exit, elapsedMs: Date.now() - started, liveBeforeKill, echoLatencies }) + '\n');
    resolve();
  });
});
