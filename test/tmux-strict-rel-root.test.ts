/**
 * End-to-end pin for the strict relative-$TMUX_TMPDIR control plane.
 *
 * A relative $TMUX_TMPDIR resolves per-cwd. The launch cwd (sandbox cold
 * start) that creates the tmux server differs from the worker cwd every later
 * ambient control command runs in — so creation, control and teardown must
 * not each resolve their own root. Real tmux + real TmuxPipeBackend, two
 * private roots, never touching /tmp:
 *
 *   worker cwd W with W/rel, launch cwd O with O/rel, TMUX_TMPDIR=rel
 *     → the server must be created at O/rel (the launch side),
 *     → control commands (options/resize/write) must address that server,
 *     → destroySession() must kill exactly that server.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';

const posix = process.platform !== 'win32';
let tmuxOnPath: string | undefined;
try { tmuxOnPath = execFileSync('which', ['tmux'], { encoding: 'utf8', timeout: 3000 }).trim(); } catch { /* optional */ }
const usable = posix && !!tmuxOnPath;
const uid = typeof process.getuid === 'function' ? process.getuid() : 0;

describe.skipIf(!usable)('strict relative TMUX_TMPDIR: the control plane follows the launch cwd', () => {
  it('create, control and destroy all address the server created at the launch side', async () => {
    // Short /tmp-based roots: unix socket paths cap at ~107 chars, and a
    // session-scoped tmpdir on this host realpaths to a much longer prefix.
    const work = mkdtempSync('/tmp/tmux-strict-rel-');
    mkdirSync(join(work, 'W', 'rel'), { recursive: true });
    mkdirSync(join(work, 'O', 'rel'), { recursive: true });
    const workerCwd = realpathSync(join(work, 'W'));
    const launchCwd = realpathSync(join(work, 'O'));
    const launchRoot = realpathSync(join(launchCwd, 'rel'));
    const workerRoot = realpathSync(join(workerCwd, 'rel'));
    const socket = `bmxrel${process.pid}`;
    const name = `bmx-strictrel-${process.pid}`;
    const savedCwd = process.cwd();
    const savedTmpdir = process.env.TMUX_TMPDIR;

    // The worker process sits in W; only the LAUNCH cwd has the sandbox view.
    process.chdir(workerCwd);
    process.env.TMUX_TMPDIR = 'rel';
    const backend = new TmuxPipeBackend(name, { createSession: true, ownsSession: true, socketName: socket });
    try {
      backend.spawn('/bin/sh', ['-c', 'sleep 30'], {
        cwd: launchCwd, cols: 80, rows: 24,
        env: { PATH: process.env.PATH!, HOME: launchCwd, SHELL: '/bin/sh' },
        strictEnv: true,
      });

      // Creation landed on the LAUNCH side root, and only there.
      expect(existsSync(join(launchRoot, `tmux-${uid}`, socket))).toBe(true);
      expect(existsSync(join(workerRoot, `tmux-${uid}`, socket))).toBe(false);

      // Ambient control commands (no cwd of their own) must address that
      // same server: resize and write both exec tmux through tmuxEnv().
      backend.resize(120, 40);
      expect(backend.write('echo ping\r')).not.toBe(false);
      // capture is an ambient control command too: it must reach the SAME
      // server. A control plane that still resolves `rel` at the worker cwd
      // finds no server there, so the capture REJECTS instead of resolving.
      await expect(backend.captureViewportAsync()).resolves.toBeTypeOf('string');
      // The server the control plane talks to is the launch-side one: the
      // reported socket path proves WHICH server answered.
      const probeAlive = spawnSync(tmuxOnPath!, ['-L', socket, 'display-message', '-p', '#{socket_path}'], {
        encoding: 'utf8', timeout: 5_000,
        env: { ...process.env, TMUX_TMPDIR: launchRoot },
      });
      expect(probeAlive.status).toBe(0);
      expect(String(probeAlive.stdout).trim()).toBe(join(launchRoot, `tmux-${uid}`, socket));

      // destroySession() is a deliberate teardown (kill() does not fire the
      // observed-exit callbacks), so effectiveness is asserted against the
      // server itself: the destroy must hit the server that was CREATED. A
      // pre-fix control plane resolves `rel` at the worker cwd and leaves
      // this server running. tmux keeps the socket FILE after the last
      // kill-session (measured), so "no server running" — naming the
      // launch-side path — is the authoritative death certificate.
      backend.destroySession();
      const probeGone = spawnSync(tmuxOnPath!, ['-L', socket, 'display-message', '-p', '#{pid}'], {
        encoding: 'utf8', timeout: 5_000,
        env: { ...process.env, TMUX_TMPDIR: launchRoot },
      });
      expect(probeGone.status).not.toBe(0);
      expect(String(probeGone.stderr)).toContain('no server running');
      expect(String(probeGone.stderr)).toContain(join(launchRoot, `tmux-${uid}`, socket));
    } finally {
      process.chdir(savedCwd);
      if (savedTmpdir === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = savedTmpdir;
      // Belt and braces for the pre-fix (red) run: kill any server this test
      // left on either private root before removing the directories.
      for (const root of [launchRoot, workerRoot]) {
        spawnSync(tmuxOnPath!, ['-L', socket, 'kill-server'], {
          encoding: 'utf8', timeout: 5_000, env: { ...process.env, TMUX_TMPDIR: root },
        });
      }
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});
