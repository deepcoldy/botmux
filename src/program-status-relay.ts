/**
 * Pane-resident relay that answers the OSC 7501 probe synchronously.
 *
 *   tmux pane <-> relay <-> inner PTY <-> CLI
 *
 * Under the tmux backend tmux answers the CLI's DA1 sentinel itself, before
 * the worker can see the OSC 7501 probe through pipe-pane, so Claude Code
 * concludes the terminal lacks program-status support (see
 * utils/program-status-probe-relay.ts for the full ordering argument). The
 * relay answers the probe and only THEN forwards the bytes after it, so the
 * 7501 answer always precedes tmux's DA1 answer. Everything else — status
 * reports included — passes through unchanged for the worker's pipe-pane.
 *
 * Fail-open: if the inner PTY cannot be created the CLI runs directly on the
 * pane terminal (handshake lost, session intact).
 */
import { spawn as spawnChild } from 'node:child_process';
import { decodeProgramStatusRelayPlan } from './core/program-status-relay-launch.js';
import { isStandaloneBinary } from './core/self-spawn.js';
import { PROGRAM_STATUS_PROBE_REPLY, ProgramStatusProbeRelay } from './utils/program-status-probe-relay.js';
import * as pty from './utils/pty.js';

/** A lone trailing ESC (or partial probe) is held at most this long. */
const HELD_FLUSH_MS = 15;
/** Upper bound on waiting for the CLI after forwarding a terminating signal. */
const SIGNAL_EXIT_GRACE_MS = 5000;

const plan = decodeProgramStatusRelayPlan(process.argv.slice(isStandaloneBinary() ? 3 : 2)[0]);
const stdin = process.stdin;
const stdout = process.stdout;

function exitWithChildStatus(code: number | null | undefined, signal: number | NodeJS.Signals | null | undefined): void {
  const signo = typeof signal === 'number' ? signal : 0;
  const status = signo > 0 ? 128 + signo : (code ?? 1);
  // Let pending pane output drain before the process (and with it the pane) goes away.
  if (stdout.writableLength > 0) stdout.once('drain', () => process.exit(status));
  else process.exit(status);
  setTimeout(() => process.exit(status), 1000).unref();
}

function runDirect(reason: unknown): void {
  process.stderr.write(`[botmux] program-status relay unavailable (${reason instanceof Error ? reason.message : String(reason)}); running CLI directly\n`);
  const child = spawnChild(plan.bin, plan.args, { stdio: 'inherit' });
  for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT', 'SIGQUIT'] as const) {
    process.on(sig, () => { try { child.kill(sig); } catch { /* exited */ } });
  }
  child.on('error', (err) => { process.stderr.write(`${err.message}\n`); process.exit(127); });
  child.on('exit', (code, signal) => process.exit(signal ? 128 + (signalNumber(signal) ?? 1) : (code ?? 1)));
}

function signalNumber(sig: NodeJS.Signals): number | undefined {
  return ({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[sig];
}

function spawnInner(): pty.IPty | null {
  try {
    return pty.spawn(plan.bin, plan.args, {
      name: process.env.TERM || 'xterm-256color',
      cols: stdout.columns || 80,
      rows: stdout.rows || 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      encoding: null,
    });
  } catch (err) {
    runDirect(err);
    return null;
  }
}

const inner = spawnInner();
if (inner) relayThrough(inner);

function relayThrough(term: pty.IPty): void {
  const relay = new ProgramStatusProbeRelay();
  let heldTimer: ReturnType<typeof setTimeout> | null = null;

  let paused = false;
  function forward(buf: Buffer): void {
    if (!stdout.write(buf) && !paused) {
      paused = true;
      term.pause();
      stdout.once('drain', () => { paused = false; term.resume(); });
    }
  }

  term.onData((data: string | Buffer) => {
    const chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    for (const action of relay.feed(chunk)) {
      if ('answer' in action) term.write(PROGRAM_STATUS_PROBE_REPLY);
      else forward(action.forward);
    }
    if (heldTimer) { clearTimeout(heldTimer); heldTimer = null; }
    if (relay.hasPending()) {
      heldTimer = setTimeout(() => {
        heldTimer = null;
        const held = relay.flush();
        if (held) forward(held);
      }, HELD_FLUSH_MS);
    }
  });

  term.onExit(({ exitCode, signal }) => {
    if (heldTimer) clearTimeout(heldTimer);
    const held = relay.flush();
    if (held) forward(held);
    exitWithChildStatus(exitCode, signal);
  });

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.on('data', (data: Buffer) => term.write(data));
  stdin.on('error', () => { /* pane gone; SIGHUP handles teardown */ });
  stdout.on('error', () => { /* pane gone; SIGHUP handles teardown */ });

  process.on('SIGWINCH', () => {
    if (stdout.columns && stdout.rows) {
      try { term.resize(stdout.columns, stdout.rows); } catch { /* CLI exited */ }
    }
  });

  for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT', 'SIGQUIT'] as const) {
    process.on(sig, () => {
      try { term.kill(sig); } catch { /* already exited */ }
      setTimeout(() => process.exit(128 + (signalNumber(sig) ?? 1)), SIGNAL_EXIT_GRACE_MS).unref();
    });
  }
}
