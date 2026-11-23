/**
 * A dead pane kept by remain-on-exit must refuse input from every source.
 *
 * paste-buffer into a dead pane crashes the WHOLE tmux server on tmux <= 3.3a
 * (2026-11-19: the fleet's shared `-L botmux` server, 104 sessions). Botmux's
 * own paste is guarded inside its tmux queue, but any client attached to the
 * pane (Web terminal, `tmux attach`) can still paste into it through tmux's
 * default `prefix ]` / middle-click bindings. Every managed session therefore
 * carries a `pane-died` hook that switches input off on the corpse, and
 * paste-buffer skips a pane whose input is off on every tmux version.
 *
 * Real tmux on a private socket + the real TmuxPipeBackend: both the fresh
 * creation path and the reattach backfill must leave `#{pane_input_off}` = 1
 * on the corpse, and a paste into it must leave the server (and its other
 * sessions) alive.
 *
 * tmux marks a pane dead (`#{pane_dead}` = 1) as soon as its terminal closes,
 * but runs `pane-died` only once it has reaped the pane's process. A read in
 * between legitimately answers `1:0` (CI caught that, #3667), so the hooked
 * cases wait for the state the hook converges to, within the same bound.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }

/** A pane process that lets go of its terminal and only then exits, which
 *  widens the window between `#{pane_dead}` = 1 and `pane-died` from the
 *  natural microseconds (#3667) to every run. HUP is ignored so tmux closing
 *  the pty does not end it early. */
const DIES_AFTER_CLOSING_TERMINAL = `trap '' HUP; exec </dev/null >/dev/null 2>&1; sleep 0.3; exit 3`;

type PaneState = {
  answer: string;
  status: number | null;
  signal: NodeJS.Signals | null;
};

const isAuthoritativeState = (answer: string) => /^[01]:[01]$/.test(answer);
const isAuthoritativeMissing = (state: PaneState) => state.answer === ':' && state.status === 0;

describe.skipIf(!realTmux)('a managed tmux pane refuses input once its CLI died', () => {
  let dir: string;
  const socket = 'bmxinputoff';
  const saved: Record<string, string | undefined> = {};
  const backends: TmuxPipeBackend[] = [];
  const tmux = (...args: string[]) =>
    spawnSync(realTmux!, ['-L', socket, ...args], { encoding: 'utf8', timeout: 5_000, env: { ...process.env } });

  const paneState = (name: string): PaneState => {
    const result = tmux('display-message', '-p', '-t', name, '#{pane_dead}:#{pane_input_off}');
    return {
      answer: String(result.stdout ?? '').trim(),
      status: result.status,
      signal: result.signal,
    };
  };

  /** Poll until the pane is dead (before the backend reaps it), then return
   *  its `#{pane_dead}:#{pane_input_off}` answer. Only for panes WITHOUT a
   *  hook: with one, the first dead answer may predate the hook. */
  const waitForCorpse = async (name: string): Promise<string> => {
    const deadline = Date.now() + 20_000;
    let last = '';
    while (Date.now() < deadline) {
      last = paneState(name).answer;
      if (last.startsWith('1:')) return last;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`pane ${name} never died (last answer: ${JSON.stringify(last)})`);
  };

  /** Return the first authoritative answer before releasing the old CLI. An
   *  unexpected state or a real missing answer fails the caller immediately;
   *  unreadable results alone are retried within the supplied budget. */
  const waitForLivePane = async (
    name: string,
    deadline = Date.now() + 20_000,
    readState: () => PaneState = () => paneState(name),
  ): Promise<string> => {
    const seen: string[] = [];
    while (Date.now() < deadline) {
      const state = readState();
      if (seen.at(-1) !== state.answer) seen.push(state.answer);
      if (isAuthoritativeState(state.answer) || isAuthoritativeMissing(state)) return state.answer;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`pane ${name} never became readable (answers: ${JSON.stringify(seen)})`);
  };

  /** Wait, within the same bound, until a hooked corpse reaches the state the
   *  `pane-died` hook converges to. Returns every distinct answer seen, so a
   *  failure shows whether the pane died at all and where it stopped. */
  const waitForInputOff = async (
    name: string,
    deadline = Date.now() + 20_000,
    readState: () => PaneState = () => paneState(name),
  ): Promise<string> => {
    const seen: string[] = [];
    while (Date.now() < deadline) {
      const state = readState();
      const { answer } = state;
      if (seen.at(-1) !== answer) seen.push(answer);
      if (answer === '1:1') break;
      // tmux 3.x answers a missing target with ':' and status 0. Empty/error
      // answers are transient instead: keep polling within the same deadline.
      if (isAuthoritativeMissing(state)) break;
      // tmux < 3.6 built with libutempter can drop the pane's SIGCHLD
      // (tmux#4559) and then reaps it — and runs the hook — only when another
      // child exits. A synchronous run-shell is that child; it does not touch
      // the pane's input state itself.
      if (answer === '1:0') tmux('run-shell', 'true');
      await new Promise(r => setTimeout(r, 25));
    }
    return seen.join(' → ');
  };

  /** A paste into the corpse must not take the server down. */
  const pasteIntoCorpseLeavesServerUp = (name: string) => {
    const before = String(tmux('display-message', '-p', '-t', 'keepalive', '#{pid}').stdout).trim();
    spawnSync(realTmux!, ['-L', socket, 'load-buffer', '-'], { input: 'x\ny', env: { ...process.env }, timeout: 5_000 });
    tmux('paste-buffer', '-t', name, '-p');
    expect(tmux('has-session', '-t', 'keepalive').status).toBe(0);
    expect(String(tmux('display-message', '-p', '-t', 'keepalive', '#{pid}').stdout).trim()).toBe(before);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmux-inputoff-'));
    for (const key of ['TMUX_TMPDIR', 'SHELL', 'TMUX', 'TMUX_PANE', 'PATH']) saved[key] = process.env[key];
    process.env.TMUX_TMPDIR = dir;
    process.env.SHELL = '/bin/sh';
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    expect(tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keepalive', 'sleep 600').status).toBe(0);
  });

  afterEach(() => {
    for (const backend of backends.splice(0)) {
      try { backend.kill(); } catch { /* already gone */ }
    }
    // This test's private server only (TMUX_TMPDIR still points at it).
    tmux('kill-server');
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSandboxScratch(dir);
  });

  it('polls through transient unreadable answers but stops on authoritative missing', async () => {
    const scriptedReader = (states: PaneState[], fallback: PaneState) => {
      let reads = 0;
      return {
        read: () => { reads += 1; return states.shift() ?? fallback; },
        count: () => reads,
      };
    };
    const deadline = Date.now() + 20_000;
    const finalInputOff: PaneState = { answer: '1:1', status: 0, signal: null };

    // A refused connection and a timed-out client are both retryable. Adjacent
    // empty answers collapse in the diagnostic sequence, but not in the reads.
    const convergence = scriptedReader([
      { answer: '0:0', status: 0, signal: null },
      { answer: '1:0', status: 0, signal: null },
      { answer: '', status: 1, signal: null },
      { answer: '', status: null, signal: 'SIGTERM' },
      finalInputOff,
    ], finalInputOff);
    expect(await waitForInputOff('scripted-convergence', deadline, convergence.read)).toMatch(/1:1$/);
    expect(convergence.count()).toBe(5);

    // A real missing answer is terminal, not a transient empty read: do not
    // spend the remaining budget or consume a later answer.
    const missing = scriptedReader([
      { answer: ':', status: 0, signal: null },
      finalInputOff,
    ], finalInputOff);
    expect(await waitForInputOff('scripted-missing', deadline, missing.read)).toBe(':');
    expect(missing.count()).toBe(1);

    // The pre-release alive check uses the same transient-read classification.
    const live = scriptedReader([
      { answer: '', status: 1, signal: null },
      { answer: '0:0', status: 0, signal: null },
    ], { answer: '0:0', status: 0, signal: null });
    expect(await waitForLivePane('scripted-live', deadline, live.read)).toBe('0:0');
    expect(live.count()).toBe(2);
  }, 40_000);

  // The 11-19 re-trigger shape: a resumed CLI that dies at once (e.g. its
  // resume target is gone) leaves a corpse before anything else can run, so
  // the hook must be installed in the same tmux queue as the session itself.
  it('switches input off on the corpse of a CLI that dies the moment it starts', async () => {
    const backend = new TmuxPipeBackend('bmx-inputoff-fresh', { createSession: true, ownsSession: true, socketName: socket });
    backends.push(backend);
    const workdir = mkdtempSync(join(dir, 'cwd-'));
    try {
      backend.spawn('/bin/sh', ['-c', 'exit 3'], {
        cwd: workdir, cols: 100, rows: 30, env: { ...process.env } as Record<string, string>, paneLaunchDir: workdir,
      });
    } catch { /* an instantly dead CLI is reported as a startup failure */ }
    expect(await waitForInputOff('bmx-inputoff-fresh')).toMatch(/1:1$/);
    pasteIntoCorpseLeavesServerUp('bmx-inputoff-fresh');
  }, 40_000);

  it('backfills the hook on a session an older build created, when reattaching', async () => {
    // Created the way an older build did: remain-on-exit, but no hook. Its
    // CLI dies only once the reattach has finished: a fixed lifetime raced
    // spawn() itself under load (and a corpse found by spawn is reaped).
    const release = join(dir, 'release-old');
    expect(tmux('new-session', '-d', '-s', 'bmx-inputoff-old',
      `until [ -e '${release}' ]; do sleep 0.05; done; ${DIES_AFTER_CLOSING_TERMINAL}`,
      ';', 'set-option', '-t', 'bmx-inputoff-old', 'remain-on-exit', 'on').status).toBe(0);
    const backend = new TmuxPipeBackend('bmx-inputoff-old', { ownsSession: true, isReattach: true, socketName: socket });
    backends.push(backend);
    const workdir = mkdtempSync(join(dir, 'cwd-'));
    backend.spawn('/bin/sh', ['-c', 'exit 0'], {
      cwd: workdir, cols: 100, rows: 30, env: { ...process.env } as Record<string, string>, paneLaunchDir: workdir,
    });
    // The alive check and the post-release convergence share the original 20s
    // budget; retrying a transient read must not add a second polling window.
    const deadline = Date.now() + 20_000;
    expect(await waitForLivePane('bmx-inputoff-old', deadline)).toBe('0:0');
    writeFileSync(release, '');
    expect(await waitForInputOff('bmx-inputoff-old', deadline)).toMatch(/1:1$/);
    pasteIntoCorpseLeavesServerUp('bmx-inputoff-old');
  }, 40_000);

  it('switches input off immediately for a corpse that predates reattach backfill', async () => {
    // The old build left a corpse BEFORE the new worker arrives. A pane-died
    // hook alone cannot retroactively secure it: the attach client can paste
    // during the option/probe window and take down the whole server.
    expect(tmux('new-session', '-d', '-s', 'bmx-inputoff-predead', 'exit 3',
      ';', 'set-option', '-t', 'bmx-inputoff-predead', 'remain-on-exit', 'on').status).toBe(0);
    expect(await waitForCorpse('bmx-inputoff-predead')).toBe('1:0');
    const backend = new TmuxPipeBackend('bmx-inputoff-predead', { ownsSession: true, isReattach: true, socketName: socket });
    backends.push(backend);
    // Isolate the option-application boundary from the later corpse reaping;
    // this is the exact production method spawn() calls before readPaneDeath().
    (backend as unknown as { applySessionOptions(): void }).applySessionOptions();
    expect(String(tmux('display-message', '-p', '-t', 'bmx-inputoff-predead', '#{pane_dead}:#{pane_input_off}').stdout).trim()).toBe('1:1');
    pasteIntoCorpseLeavesServerUp('bmx-inputoff-predead');
  }, 40_000);

  it('secures a pre-dead pane before ANY probe in the public reattach spawn path', async () => {
    const name = 'bmx-inputoff-concurrent';
    expect(tmux('new-session', '-d', '-s', name, 'exit 3',
      ';', 'set-option', '-t', name, 'remain-on-exit', 'on').status).toBe(0);
    expect(await waitForCorpse(name)).toBe('1:0');
    spawnSync(realTmux!, ['-L', socket, 'load-buffer', '-'], { input: 'x\ny', env: { ...process.env }, timeout: 5_000 });

    // Hit the real server-version probe and paste AT THAT POINT, before the
    // probe can return. This catches an unsafe ordering even when the final
    // corpse is eventually reaped and the later state happens to look correct.
    const shimDir = join(dir, 'shim');
    mkdirSync(shimDir, { recursive: true });
    const marker = join(dir, 'version-probe-hit');
    const shim = join(shimDir, 'tmux');
    writeFileSync(shim, `#!/bin/sh
case " $* " in
  *"display-message -p #{version}"*)
    touch ${marker}
    ${realTmux} -L ${socket} paste-buffer -t ${name} -p
    ;;
esac
exec ${realTmux} "$@"
`);
    chmodSync(shim, 0o755);
    process.env.PATH = `${shimDir}:${process.env.PATH}`;
    const before = String(tmux('display-message', '-p', '-t', 'keepalive', '#{pid}').stdout).trim();
    const backend = new TmuxPipeBackend(name, { ownsSession: true, isReattach: true, socketName: socket });
    backends.push(backend);
    const workdir = mkdtempSync(join(dir, 'cwd-'));
    backend.spawn('/bin/sh', ['-c', 'exit 0'], {
      cwd: workdir, cols: 100, rows: 30, env: { ...process.env } as Record<string, string>, paneLaunchDir: workdir,
    });
    expect(existsSync(marker)).toBe(true);
    expect(tmux('has-session', '-t', 'keepalive').status).toBe(0);
    expect(String(tmux('display-message', '-p', '-t', 'keepalive', '#{pid}').stdout).trim()).toBe(before);
  }, 40_000);
});
