import { nudgeRead, spawn } from '../../src/utils/pty.js';

const mode = process.env.BOTMUX_TEST_PTY_PROBE_MODE ?? 'gap';
const started = Date.now();
// 256 lines of 64 bytes: four times what n_tty hands out per read.
const exitBurst = 'i=0; while [ "$i" -lt 256 ]; do printf "%062d\\n" "$i"; i=$((i+1)); done';
const script = mode === 'input'
  ? 'stty -echo; printf READY; read value; stty size; printf "reply:%s\\n" "$value"'
  : mode === 'cancel' ? 'printf READY; sleep 30'
  : mode === 'echo' || mode === 'echo-nudge' ? 'stty -echo; printf READY; while read line; do printf "r:%s;" "$line"; done'
  : mode === 'pause' ? 'stty -echo; printf first; sleep 0.1; i=0; while [ "$i" -lt 4096 ]; do printf AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; i=$((i+1)); done; printf last; read ack'
  : mode === 'exit-burst' ? `${exitBurst}; printf TAIL`
  // A background process that ignores the hangup keeps the terminal open after
  // the shell exits, so only node-pty's teardown can end the reader.
  : mode === 'exit-stall' ? `(trap "" HUP; exec sleep 4) & printf "%s:" "$!"; sleep 0.2; ${exitBurst}; printf TAIL`
  : 'printf first; sleep 0.3; printf "\\344\\275"; sleep 0.1; printf "\\240\\345\\245\\275"; printf last';

let teardownStalls = 0;
if (mode === 'exit-stall') {
  // node-pty arms a timer when the child exits and destroys the reader when it
  // fires. Stall the loop past that timer's delay as soon as it is armed, as a
  // busy host would, so it fires before the reader gets another turn.
  const setTimer = globalThis.setTimeout;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const timer = setTimer(...args);
    if (/unixTerminal/.test(new Error().stack ?? '')) {
      teardownStalls++;
      const until = Date.now() + (Number(args[1]) || 0) + 100;
      while (Date.now() < until) { /* stalled event loop */ }
    }
    return timer;
  }) as typeof setTimeout;
}

const terminal = spawn('/bin/sh', ['-c', script], {
  cwd: process.cwd(), env: { PATH: '/usr/bin:/bin', HOME: process.cwd() },
  name: 'xterm-256color', cols: 80, rows: 24,
});
if (mode === 'exit-burst') {
  // Give the reader no turn until node-pty has reaped the child: its whole
  // output and its exit are then queued together, as on a host too busy to
  // schedule the reader in between.
  const deadline = Date.now() + 3000;
  for (;;) {
    try { process.kill(terminal.pid, 0); } catch { break; }
    if (Date.now() > deadline) break;
  }
}
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
      // Exercise backpressure with a live child: output left at child exit
      // has its own exit-* probes. Keep the child alive until we have
      // received its whole burst.
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
    let heldOpen = false;
    const holder = mode === 'exit-stall' ? Number(/^(\d+):/.exec(output)?.[1]) : 0;
    if (holder) try { process.kill(holder, 'SIGKILL'); heldOpen = true; } catch { /* already gone */ }
    process.stdout.write(JSON.stringify({ output, exit, elapsedMs: Date.now() - started, liveBeforeKill, echoLatencies, teardownStalls, heldOpen }) + '\n');
    resolve();
  });
});
