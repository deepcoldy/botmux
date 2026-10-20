/**
 * A managed TmuxPipeBackend.spawn() creates the detached session first and only
 * then sets up the FIFO / wake fd / pipe-pane. When a later step fails, the
 * worker retires the session THIS spawn created before it rolls the sandbox
 * tree back — exactly that session (by tmux session id), never a same-named
 * one another generation created in the meantime.
 *
 * Real tmux on a private socket (PATH shim); the wake-fd failure is the
 * backend's own test seam.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setStartupTmuxRetrySleepForTests, TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }

describe.skipIf(!realTmux)('TmuxPipeBackend.retireSessionCreatedBySpawn', () => {
  let dir: string;
  let socket: string;
  const saved: Record<string, string | undefined> = {};
  const name = 'bmx-retire01';
  const tmux = (...args: string[]) => spawnSync(realTmux!, ['-S', socket, ...args], { encoding: 'utf8' });
  const sessionId = (): string => tmux('display-message', '-p', '-t', `=${name}:`, '#{session_id}').stdout.trim();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmux-retire-'));
    socket = join(dir, 'socket');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -S '${socket}' "$@"\n`, { mode: 0o755 });
    for (const key of ['PATH', 'SHELL', 'TMUX', 'TMUX_PANE', 'BOTMUX_TEST_FORCE_WAKE_OPEN_FAIL']) saved[key] = process.env[key];
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.SHELL = '/bin/sh';
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    process.env.BOTMUX_TEST_FORCE_WAKE_OPEN_FAIL = '1';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    tmux('kill-server');
    rmSandboxScratch(dir);
  });

  const failedSpawn = (): TmuxPipeBackend => {
    const backend = new TmuxPipeBackend(name, { createSession: true, ownsSession: true });
    expect(() => backend.spawn('/bin/sh', ['-c', 'sleep 300'], {
      cwd: dir, cols: 80, rows: 24, env: { PATH: process.env.PATH!, HOME: dir },
    })).toThrow(/EMFILE: injected by test/);
    return backend;
  };

  it('kills the session the failed spawn created', () => {
    const backend = failedSpawn();
    expect(sessionId()).toMatch(/^\$\d+$/);
    expect(backend.retireSessionCreatedBySpawn()).toBe(true);
    expect(tmux('has-session', '-t', `=${name}`).status).not.toBe(0);
    // Nothing left to claim on a second call.
    expect(backend.retireSessionCreatedBySpawn()).toBe(false);
  });

  it.each([
    // The last session gone takes the server with it: the replacement lives on
    // a NEW server, where session ids restart at $0.
    ['on a new tmux server', false],
    ['on the same tmux server', true],
  ])('never kills a same-named session that replaced it %s', (_label, keepServer) => {
    const backend = failedSpawn();
    if (keepServer) expect(tmux('new-session', '-d', '-s', 'keeper', '--', 'sleep', '300').status).toBe(0);
    expect(tmux('kill-session', '-t', `=${name}`).status).toBe(0);
    expect(tmux('new-session', '-d', '-s', name, '--', 'sleep', '300').status).toBe(0);
    const foreign = sessionId();
    expect(backend.retireSessionCreatedBySpawn()).toBe(false);
    expect(sessionId()).toBe(foreign);
  });

  // The first new-session dies with a connection error, but meanwhile another
  // creator (a racing worker) made the same-named session; the retry then sees
  // "duplicate session". Nothing proves that session is ours: never claim it,
  // never retire it.
  it('never claims a same-named session its retry collided with', () => {
    const raced = join(dir, 'raced');
    writeFileSync(join(dir, 'bin', 'tmux'), `#!/bin/sh
if [ "$1" = new-session ] && [ ! -e '${raced}' ]; then
  : > '${raced}'
  '${realTmux}' -S '${socket}' new-session -d -s '${name}' -- sleep 300
  echo 'error connecting to ${socket} (Connection refused)' >&2
  exit 1
fi
exec '${realTmux}' -S '${socket}' "$@"
`, { mode: 0o755 });
    setStartupTmuxRetrySleepForTests(() => {});
    try {
      const backend = failedSpawn();
      const competitor = sessionId();
      expect(competitor).toMatch(/^\$\d+$/);
      expect(backend.retireSessionCreatedBySpawn()).toBe(false);
      expect(sessionId()).toBe(competitor);
    } finally {
      setStartupTmuxRetrySleepForTests(null);
    }
  });

  // The tmux server exits between an identity check and a kill, and its
  // replacement hands the saved id ($0) to an unrelated session (any name).
  // The shim swaps the server right before the retire command reaches tmux; the
  // check and the kill being ONE server-side command is what keeps the
  // unrelated session alive.
  it('a server swapped right before the retire command cannot cost an unrelated session', () => {
    const swapFlag = join(dir, 'swap-server');
    writeFileSync(join(dir, 'bin', 'tmux'), `#!/bin/sh
if [ -e '${swapFlag}' ] && { [ "$1" = if-shell ] || [ "$1" = kill-session ]; }; then
  rm -f '${swapFlag}'
  '${realTmux}' -S '${socket}' kill-server
  while '${realTmux}' -S '${socket}' list-sessions >/dev/null 2>&1; do sleep 0.05; done
  '${realTmux}' -S '${socket}' new-session -d -s unrelated -- sleep 300 || exit 97
fi
exec '${realTmux}' -S '${socket}' "$@"
`, { mode: 0o755 });
    const backend = failedSpawn();
    writeFileSync(swapFlag, '');
    expect(backend.retireSessionCreatedBySpawn()).toBe(false);
    expect(tmux('display-message', '-p', '-t', '=unrelated:', '#{session_id}').stdout.trim()).toBe('$0');
  });

  it('claims nothing when its own new-session never succeeded', () => {
    const backend = new TmuxPipeBackend(name, { createSession: true, ownsSession: true });
    expect(tmux('new-session', '-d', '-s', 'unrelated', '--', 'sleep', '300').status).toBe(0);
    expect(backend.retireSessionCreatedBySpawn()).toBe(false);
    expect(tmux('has-session', '-t', '=unrelated').status).toBe(0);
  });
});
