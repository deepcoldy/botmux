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
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }

describe.skipIf(!realTmux)('a managed tmux pane refuses input once its CLI died', () => {
  let dir: string;
  const socket = 'bmxinputoff';
  const saved: Record<string, string | undefined> = {};
  const backends: TmuxPipeBackend[] = [];
  const tmux = (...args: string[]) =>
    spawnSync(realTmux!, ['-L', socket, ...args], { encoding: 'utf8', timeout: 5_000, env: { ...process.env } });

  /** Poll until the pane is dead (before the backend reaps it), then return
   *  its `#{pane_dead}:#{pane_input_off}` answer. */
  const waitForCorpse = async (name: string): Promise<string> => {
    const deadline = Date.now() + 20_000;
    let last = '';
    while (Date.now() < deadline) {
      last = String(tmux('display-message', '-p', '-t', name, '#{pane_dead}:#{pane_input_off}').stdout ?? '').trim();
      if (last.startsWith('1:')) return last;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`pane ${name} never died (last answer: ${JSON.stringify(last)})`);
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
    for (const key of ['TMUX_TMPDIR', 'SHELL', 'TMUX', 'TMUX_PANE']) saved[key] = process.env[key];
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
    expect(await waitForCorpse('bmx-inputoff-fresh')).toBe('1:1');
    pasteIntoCorpseLeavesServerUp('bmx-inputoff-fresh');
  }, 40_000);

  it('backfills the hook on a session an older build created, when reattaching', async () => {
    // Created the way an older build did: remain-on-exit, but no hook.
    expect(tmux('new-session', '-d', '-s', 'bmx-inputoff-old', 'sleep 2; exit 3',
      ';', 'set-option', '-t', 'bmx-inputoff-old', 'remain-on-exit', 'on').status).toBe(0);
    const backend = new TmuxPipeBackend('bmx-inputoff-old', { ownsSession: true, isReattach: true, socketName: socket });
    backends.push(backend);
    const workdir = mkdtempSync(join(dir, 'cwd-'));
    backend.spawn('/bin/sh', ['-c', 'exit 0'], {
      cwd: workdir, cols: 100, rows: 30, env: { ...process.env } as Record<string, string>, paneLaunchDir: workdir,
    });
    expect(await waitForCorpse('bmx-inputoff-old')).toBe('1:1');
    pasteIntoCorpseLeavesServerUp('bmx-inputoff-old');
  }, 40_000);
});
