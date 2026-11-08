/**
 * Real-tmux Linux integration test for the anti-fork guard.
 *
 * Reproduces the orphan-birth topology on the suite's PRIVATE, short-path
 * tmux fence root (process.env.TMUX_TMPDIR, set by test/tmux-fence-setup.ts)
 * with a unique -L label per case — nothing can reach a host tmux server:
 *
 *   1. boot server A with a bmx-* session and read its pid;
 *   2. unlink A's socket file (the tmpfiles/cleanup trigger);
 *   3. a plain `new-session` FORKS a second server B — two LISTENING unix
 *      sockets on one pathname, distinct inodes (the bug);
 *   4. the guard instead recovers A with SIGUSR1 (same pid, session survives,
 *      still one listener) and, once reachable, attaches.
 *
 * Unit project (*.integration.test.ts matches *.test.ts) so Linux CI runs it;
 * skipped off Linux / without tmux so macOS `bun run test` stays green.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { linuxListeningServerPids, resolveBootDirective, tmuxSocketPath } from '../src/core/tmux-server-guard.js';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
function tmuxVersion(): { major: number; minor: number } | null {
  try {
    const m = /(\d+)\.(\d+)/.exec(execFileSync('tmux', ['-V'], { encoding: 'utf8' }));
    return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
  } catch { return null; }
}
const VER = tmuxVersion();
const supportsN = VER !== null && (VER.major > 3 || (VER.major === 3 && VER.minor >= 2));

// The fence provides a short, private TMUX_TMPDIR (unix socket paths cap at
// ~107 chars, so os.tmpdir() under botmux's session root is unusable).
const TMPDIR = process.env.TMUX_TMPDIR;
const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
function env(label: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  if (TMPDIR) e.TMUX_TMPDIR = TMPDIR;
  delete e.TMUX;
  delete e.TMUX_PANE;
  void label;
  return e;
}
function sockPath(label: string): string {
  return tmuxSocketPath({ TMUX_TMPDIR: TMPDIR }, uid, label);
}
function t(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('tmux', args, { encoding: 'utf8', env: env(''), timeout: 5000 });
  return { status: r.status, stdout: r.stdout.trim(), stderr: (r.stderr ?? '').trim() };
}

// Track every server pid we boot so afterAll can reap even an unlinked/stopped
// one (kill-server cannot reach it): CONT → TERM → bounded → KILL.
const tracked = new Set<number>();
function boot(label: string, session: string): number {
  expect(t(['-L', label, 'new-session', '-d', '-s', session, '-x', '80', '-y', '24']).status).toBe(0);
  const pid = Number(t(['-L', label, 'display-message', '-p', '#{pid}']).stdout);
  tracked.add(pid);
  return pid;
}

describe.skipIf(process.platform !== 'linux' || !hasTmux || !TMPDIR)('tmux anti-fork guard (real tmux, two servers)', () => {
  afterAll(() => {
    for (const pid of tracked) {
      try { process.kill(pid, 'SIGCONT'); } catch { /* gone */ }
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    for (const pid of tracked) {
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('plain new-session after socket unlink FORKS a competing server (the bug topology)', () => {
    const label = `afbug${process.pid}`;
    const socketPath = sockPath(label);
    const pidA = boot(label, 'bmx-deadbeef');

    rmSync(socketPath, { force: true });
    expect(t(['-L', label, 'new-session', '-d', '-s', 'bmx-cafef00d', '-x', '80', '-y', '24']).status).toBe(0);
    const pidB = Number(t(['-L', label, 'display-message', '-p', '#{pid}']).stdout);
    tracked.add(pidB);
    expect(pidB).not.toBe(pidA);

    // Exactly two LISTENING servers, A (orphan) and B (reachable), same pathname.
    expect((linuxListeningServerPids(socketPath) ?? []).sort((a, b) => a - b))
      .toEqual([pidA, pidB].sort((a, b) => a - b));
  });

  it('the guard RECREATES the socket via SIGUSR1 instead of forking (one bmx listener, ENOENT)', () => {
    const label = `afrec${process.pid}`;
    const socketPath = sockPath(label);
    const pidA = boot(label, 'bmx-deadbeef');
    rmSync(socketPath, { force: true });
    expect(t(['-L', label, 'display-message', '-p', '#{pid}']).status).not.toBe(0);

    const directive = resolveBootDirective(label, { env: env(label), platform: 'linux' });
    expect(directive.mode).toBe('recreate-socket');
    if (directive.mode === 'recreate-socket') expect(directive.pid).toBe(pidA);

    // The production gate polls once after signalling; allow the re-bind.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    // Same pid answers again, its session survived, still ONE listener.
    expect(Number(t(['-L', label, 'display-message', '-p', '#{pid}']).stdout)).toBe(pidA);
    expect(t(['-L', label, 'has-session', '-t', 'bmx-deadbeef']).status).toBe(0);
    expect(linuxListeningServerPids(socketPath)).toEqual([pidA]);
  });

  it('a true cold start (never booted) is allowed to boot without -N', () => {
    const label = `afcold${process.pid}`;
    expect(resolveBootDirective(label, { env: env(label), platform: 'linux' }))
      .toEqual({ mode: 'spawn', noFork: false });
  });

  it.runIf(supportsN)('tmux >= 3.2: a reachable owner attaches with -N; -N refuses to boot cold', () => {
    const label = `afnn${process.pid}`;
    boot(label, 'bmx-deadbeef');
    expect(resolveBootDirective(label, { env: env(label), platform: 'linux' }))
      .toEqual({ mode: 'spawn', noFork: true });
    expect(t(['-N', '-L', `afnempty${process.pid}`, 'new-session', '-d', '-s', 'x']).status).not.toBe(0);
  });

  it('old tmux (< 3.2) attaches without -N', () => {
    if (supportsN) return;
    const label = `afold${process.pid}`;
    boot(label, 'bmx-deadbeef');
    expect(resolveBootDirective(label, { env: env(label), platform: 'linux' }))
      .toEqual({ mode: 'spawn', noFork: false });
  });
});
