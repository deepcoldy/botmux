/**
 * Where tmux REALLY puts its server socket.
 *
 * The gate probes one path and the tmux client then talks to whatever tmux
 * resolves — if those differ, the owner probe fails, the listener census
 * reads an empty path and the gate allows a cold start next to a live server.
 * These tests pin the resolution to the measured tmux behaviour, including a
 * comparison against the real tmux binary.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveTmuxSocketRoot,
  tmuxSocketPathIn,
  TMUX_DEFAULT_SOCKET_ROOT,
} from '../src/adapters/backend/tmux-socket-root.js';
import { hostTmuxSocketDirs, realTmuxBinary, tmuxFenceShimScript } from './helpers/tmux-fence.js';

const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveTmuxSocketRoot', () => {
  it('uses /tmp when TMUX_TMPDIR is unset or empty', () => {
    expect(resolveTmuxSocketRoot({})).toBe(TMUX_DEFAULT_SOCKET_ROOT);
    expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: '' })).toBe(TMUX_DEFAULT_SOCKET_ROOT);
  });

  it('uses an existing directory verbatim', () => {
    const dir = tempDir('tmux-root-ok-');
    expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: dir })).toBe(dir);
  });

  it('falls back to /tmp for a directory that does not exist', () => {
    expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: join(tmpdir(), 'tmux-root-absent-') }))
      .toBe(TMUX_DEFAULT_SOCKET_ROOT);
  });

  it('falls back to /tmp for a path that is not a directory', () => {
    const dir = tempDir('tmux-root-file-');
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: file })).toBe(TMUX_DEFAULT_SOCKET_ROOT);
  });

  it('does not treat TMUX_TMPDIR as a colon separated list', () => {
    // tmux uses the value as ONE path: a colon makes the whole string a path
    // that does not resolve, so tmux falls back to /tmp.
    const dir = tempDir('tmux-root-list-');
    expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: `${dir}:${dir}` })).toBe(TMUX_DEFAULT_SOCKET_ROOT);
    expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: `${dir}:/tmp` })).toBe(TMUX_DEFAULT_SOCKET_ROOT);
  });

  it('builds the socket path under the resolved root', () => {
    const dir = tempDir('tmux-root-path-');
    expect(tmuxSocketPathIn(dir, 42, 'botmux')).toBe(`${dir}/tmux-42/botmux`);
    expect(tmuxSocketPathIn(dir, 42)).toBe(`${dir}/tmux-42/default`);
  });
});

describe('real tmux agrees with the resolution', () => {
  const posix = process.platform !== 'win32';
  const tmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  const usable = posix && tmux.status === 0;

  it.skipIf(!usable)('puts the socket under an existing TMUX_TMPDIR', () => {
    const dir = tempDir('tmux-real-ok-');
    const label = `bmx-root-probe-${process.pid}`;
    // A real server under a private root: the fence keeps it off the host.
    const started = spawnSync('tmux', ['-L', label, 'new-session', '-d', '-s', 'probe', 'sleep 5'], {
      encoding: 'utf8', env: { ...process.env, TMUX_TMPDIR: dir },
    });
    if (started.status !== 0) return; // no usable tmux here — nothing to compare
    try {
      expect(existsSync(join(dir, `tmux-${uid}`, label))).toBe(true);
      expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: dir })).toBe(dir);
    } finally {
      spawnSync('tmux', ['-L', label, 'kill-server'], { encoding: 'utf8', env: { ...process.env, TMUX_TMPDIR: dir } });
    }
  });

  it.skipIf(!usable)('never uses a TMUX_TMPDIR tmux cannot resolve — tmux lands it on /tmp', () => {
    const missing = join(tmpdir(), 'tmux-real-absent-');
    const label = `bmx-root-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    // The fence shim would REFUSE this call (tmux would use the host's /tmp
    // socket directory) and a refusal fails the whole run by design — so the
    // real binary is used for this one comparison. `display-message` never
    // boots a server and the label is private to this probe, so the call can
    // only read back the path tmux resolved; the assertion below proves that
    // nothing was created at it.
    const real = realTmuxBinary();
    if (!real) return;
    const probe = spawnSync(real, ['-L', label, 'display-message', '-p', '#{socket_path}'], {
      encoding: 'utf8', env: { ...process.env, TMUX_TMPDIR: missing },
    });
    const said = `${probe.stderr ?? ''}${probe.stdout ?? ''}`;
    expect(said).toContain(`/tmux-${uid}/${label}`);
    expect(said).not.toContain(missing);
    expect(existsSync(join('/tmp', `tmux-${uid}`, label))).toBe(false);
    expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: missing })).toBe(TMUX_DEFAULT_SOCKET_ROOT);
  });
});

describe('the fence resolves sockets the way tmux does', () => {
  const posix = process.platform !== 'win32';

  it.skipIf(!posix)('refuses a colon separated TMUX_TMPDIR (tmux lands it on /tmp)', () => {
    const work = mkdtempSync(join(tmpdir(), 'tmux-fence-list-'));
    try {
      const fakeReal = join(work, 'real-tmux');
      writeFileSync(fakeReal, '#!/bin/sh\necho "REAL:$*"\n');
      chmodSync(fakeReal, 0o755);
      const denyLog = join(work, 'denied.log');
      writeFileSync(denyLog, '');
      const shim = join(work, 'tmux');
      writeFileSync(shim, tmuxFenceShimScript(fakeReal, hostTmuxSocketDirs({}), denyLog));
      chmodSync(shim, 0o755);
      const privateRoot = join(work, 'private');
      mkdirSync(privateRoot);

      const r = spawnSync(shim, ['kill-server'], {
        encoding: 'utf8', env: { PATH: process.env.PATH, TMUX_TMPDIR: `${join(work, 'missing')}:${privateRoot}` },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('refusing host tmux socket');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
