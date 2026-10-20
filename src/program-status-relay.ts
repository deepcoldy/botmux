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
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { consumeProgramStatusRelayPlan, relayChildLaunch } from './core/program-status-relay-launch.js';
import { isStandaloneBinary } from './core/self-spawn.js';
import { ProgramStatusProbeRelay, writeProbeReplySync } from './utils/program-status-probe-relay.js';
import * as pty from './utils/pty.js';

/** A lone trailing ESC (or partial probe) is held at most this long. */
const HELD_FLUSH_MS = 15;
/** Upper bound on waiting for the CLI after forwarding a terminating signal. */
const SIGNAL_EXIT_GRACE_MS = 5000;
/** After SIGKILLing the child, the relay kills itself if it still has not exited. */
const FINAL_KILL_MS = 2000;
/** Absolute: this process runs outside any sandbox, so it must never resolve
 *  helpers through the CLI's (possibly agent-writable) PATH. */
const STTY = ['/bin/stty', '/usr/bin/stty'].find(p => existsSync(p)) ?? '/bin/stty';

const [planDigestArg, planPathArg] = process.argv.slice(isStandaloneBinary() ? 3 : 2);
const plan = consumeProgramStatusRelayPlan(planDigestArg, planPathArg);
const stdin = process.stdin;
const stdout = process.stdout;
// Create the stderr stream NOW, while the pane is alive. It is lazy, and once
// the pane is killed node's stdin teardown (net Socket._destroy) touches it for
// the first time; creating a TTY stream re-opens the pane tty, and on macOS
// open() of a hung-up pty blocks forever. That froze the event loop before the
// SIGHUP handler's escalation could run, leaking the relay, the CLI and their
// three ptys per closed session until tmux could no longer fork a pane.
void process.stderr;
// The launch shim parked interpreter loader options and moved us to `/` so no
// bot- or workdir-configured preload runs in this unconfined process; the CLI
// gets its options and working directory back.
const { env: childEnv, cwd: childCwd } = relayChildLaunch(process.env, process.cwd());

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
  // The pane was put into raw mode for the relay; hand the CLI a sane terminal.
  spawnSync(STTY, ['sane'], { stdio: ['inherit', 'ignore', 'ignore'] });
  const child = spawnChild(plan.bin, plan.args, { stdio: 'inherit', env: childEnv, cwd: childCwd });
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
      cwd: childCwd,
      env: childEnv as Record<string, string>,
      // Keep node-pty's default UTF-8 mode: `encoding: null` would also leave
      // IUTF8 off on the inner PTY, so canonical-mode Backspace (e.g. a
      // wrapperCli prompt) would delete one byte of a multi-byte character.
      // Its StringDecoder reassembles characters split across reads.
      encoding: 'utf8',
    });
  } catch (err) {
    runDirect(err);
    return null;
  }
}

/** Make the pane a byte-transparent transport before the inner PTY exists (so
 *  the transient `stty` is never mistaken for the relay's CLI child). libuv's
 *  raw mode deliberately keeps OPOST|ONLCR, so bytes the inner PTY already
 *  processed would be rewritten again on the way out (`\r\n` → `\r\r\n`, and
 *  an app's bare-LF cursor moves turned into CRLF): full `stty raw` it is. */
function makePaneRaw(): void {
  if (!stdin.isTTY) return;
  stdin.setRawMode(true);
  const stty = spawnSync(STTY, ['raw', '-echo'], { stdio: ['inherit', 'ignore', 'pipe'] });
  if (stty.status !== 0) {
    process.stderr.write(`[botmux] program-status relay: stty raw failed (${stty.error?.message ?? stty.stderr?.toString().trim()}); output may be double-translated\n`);
  }
}

makePaneRaw();
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
      if ('answer' in action) writeProbeReplySync(term);
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

  stdin.on('data', (data: Buffer) => term.write(data));
  stdin.on('error', () => { /* pane gone; SIGHUP handles teardown */ });
  stdout.on('error', () => { /* pane gone; SIGHUP handles teardown */ });

  process.on('SIGWINCH', () => {
    if (stdout.columns && stdout.rows) {
      try { term.resize(stdout.columns, stdout.rows); } catch { /* CLI exited */ }
    }
  });

  let escalation: ReturnType<typeof setTimeout> | null = null;
  for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT', 'SIGQUIT'] as const) {
    process.on(sig, () => {
      try { term.kill(sig); } catch { /* already exited */ }
      if (escalation) return;
      // Never process.exit() while the child lives: node-pty's native waitpid
      // thread would be joined during teardown and can block indefinitely.
      // Kill the child instead; onExit then exits the relay normally.
      escalation = setTimeout(() => {
        try { term.kill('SIGKILL'); } catch { /* already exited */ }
        setTimeout(() => process.kill(process.pid, 'SIGKILL'), FINAL_KILL_MS).unref();
      }, SIGNAL_EXIT_GRACE_MS);
    });
  }
}
