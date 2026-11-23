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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveTmuxSocketRoot,
  probeTmuxSessionWithLegacyRoot,
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

  it('uses an existing directory verbatim, realpathsed the way tmux reports it', () => {
    const dir = tempDir('tmux-root-ok-');
    expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: dir })).toBe(realpathSync(dir));
  });

  it('falls back to /tmp for a directory that does not exist', () => {
    expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: join(tmpdir(), 'tmux-root-absent-') }))
      .toBe(TMUX_DEFAULT_SOCKET_ROOT);
  });

  it('uses a resolvable non-directory path verbatim — real tmux fails hard there, no /tmp fallback', () => {
    // tmux's boundary is whether the value RESOLVES, not whether it is a
    // directory: a regular file makes tmux die with "couldn't create
    // directory <file>/tmux-<uid> (Not a directory)" while still targeting
    // that path. Falling back to /tmp here would census an unrelated root.
    const dir = tempDir('tmux-root-file-');
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: file })).toBe(realpathSync(file));
  });

  it('realpaths an existing directory instead of returning the link spelling', () => {
    const target = tempDir('tmux-root-target-');
    const link = join(tmpdir(), `tmux-root-link-${process.pid}`);
    symlinkSync(target, link);
    dirs.push(link);
    expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: link })).toBe(realpathSync(target));
  });

  it('resolves a relative value against the given cwd, not this process cwd', () => {
    const cwdA = tempDir('tmux-root-cwda-');
    const rel = join(cwdA, 'rel');
    mkdirSync(rel);
    const cwdB = tempDir('tmux-root-cwdb-'); // no 'rel' inside
    expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: 'rel' }, cwdA)).toBe(realpathSync(rel));
    expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: 'rel' }, cwdB)).toBe(TMUX_DEFAULT_SOCKET_ROOT);
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

describe('legacy strict-session root probing', () => {
  it('offers a legacy root only when the old session exists and restores the probe env', () => {
    const previous = process.env.TMUX_TMPDIR;
    const currentRoot = join(tmpdir(), 'current-root');
    process.env.TMUX_TMPDIR = currentRoot;
    const legacyRoot = join(tmpdir(), 'legacy-root');
    try {
      const seenRoots: Array<string | undefined> = [];
      const result = probeTmuxSessionWithLegacyRoot({
        strict: true,
        legacyRoot,
        probe: () => {
          seenRoots.push(process.env.TMUX_TMPDIR);
          return seenRoots.length === 1 ? 'missing' : 'exists';
        },
      });
      expect(result).toEqual({ probe: 'exists', legacySocketRoot: legacyRoot });
      expect(seenRoots).toEqual([currentRoot, legacyRoot]);
      expect(process.env.TMUX_TMPDIR).toBe(currentRoot);
    } finally {
      if (previous === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = previous;
    }
  });

  it('keeps unknown indeterminate and never probes legacy for inherit', () => {
    const previous = process.env.TMUX_TMPDIR;
    const currentRoot = join(tmpdir(), 'current-root');
    process.env.TMUX_TMPDIR = currentRoot;
    const legacyRoot = join(tmpdir(), 'legacy-root');
    try {
      let calls = 0;
      const unknown = probeTmuxSessionWithLegacyRoot({
        strict: true, legacyRoot,
        probe: () => ++calls === 1 ? 'missing' : 'unknown',
      });
      expect(unknown).toEqual({ probe: 'unknown' });
      expect(calls).toBe(2);
      expect(process.env.TMUX_TMPDIR).toBe(currentRoot);
      calls = 0;
      const inherited = probeTmuxSessionWithLegacyRoot({
        strict: false, legacyRoot,
        probe: () => { calls++; return 'missing'; },
      });
      expect(inherited).toEqual({ probe: 'missing' });
      expect(calls).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = previous;
    }
  });
});

describe('real tmux agrees with the resolution', () => {
  const posix = process.platform !== 'win32';
  const tmux = spawnSync('tmux', ['-V'], { encoding: 'utf8', timeout: 3000 });
  const usable = posix && tmux.status === 0;
  // Unix socket paths cap at ~107 chars; on hosts whose tmpdir() realpaths to
  // a long prefix these server-starting probes would fail the bind (or the
  // fence shim's own resolution) and silently skip instead of comparing — so
  // probe roots go under a short real directory.
  const shortBase = posix && existsSync('/tmp') ? '/tmp' : tmpdir();
  const probeRoot = (prefix: string): string => {
    const dir = mkdtempSync(join(shortBase, prefix));
    dirs.push(dir);
    return dir;
  };

  it.skipIf(!usable)('puts the socket under an existing TMUX_TMPDIR', () => {
    const dir = probeRoot('tmux-real-ok-');
    const label = `bmx-root-probe-${process.pid}`;
    // A real server under a private root: the fence keeps it off the host.
    const started = spawnSync('tmux', ['-L', label, 'new-session', '-d', '-s', 'probe', 'sleep 5'], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, TMUX_TMPDIR: dir },
    });
    if (started.status !== 0) return; // no usable tmux here — nothing to compare
    try {
      expect(existsSync(join(dir, `tmux-${uid}`, label))).toBe(true);
      expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: dir })).toBe(realpathSync(dir));
    } finally {
      spawnSync('tmux', ['-L', label, 'kill-server'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, TMUX_TMPDIR: dir } });
    }
  });

  it.skipIf(!usable)('reports the realpathsed socket path for a symlinked TMUX_TMPDIR', () => {
    const target = probeRoot('tmux-real-target-');
    const link = join(shortBase, `tmux-real-link-${process.pid}`);
    rmSync(link, { force: true });
    symlinkSync(target, link);
    dirs.push(link);
    const label = `bmx-root-lk-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const started = spawnSync('tmux', ['-L', label, 'new-session', '-d', '-s', 'probe', 'sleep 5'], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, TMUX_TMPDIR: link },
    });
    if (started.status !== 0) return;
    try {
      const said = spawnSync('tmux', ['-L', label, 'display-message', '-p', '#{socket_path}'], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, TMUX_TMPDIR: link },
      });
      expect(String(said.stdout ?? '').trim().startsWith(realpathSync(target))).toBe(true);
      expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: link })).toBe(realpathSync(target));
    } finally {
      spawnSync('tmux', ['-L', label, 'kill-server'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, TMUX_TMPDIR: link } });
    }
  });

  it.skipIf(!usable)('fails hard on a regular-file TMUX_TMPDIR instead of falling back to /tmp', () => {
    // The fence shim would land this on /tmp and refuse it, so the premise is
    // compared against the real binary only: tmux dies with "Not a directory"
    // at the file path and never creates the default-server socket.
    const real = realTmuxBinary();
    if (!real) return;
    const dir = probeRoot('tmux-real-file-');
    const file = join(dir, 'plain-file');
    writeFileSync(file, 'x');
    const label = `bmx-root-file-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const r = spawnSync(real, ['-L', label, 'new-session', '-d'], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, TMUX_TMPDIR: file },
    });
    const said = `${r.stderr ?? ''}${r.stdout ?? ''}`;
    expect(r.status).not.toBe(0);
    expect(said).toContain('Not a directory');
    expect(said).toContain(realpathSync(file)); // tmux realpaths the value before failing
    expect(existsSync(join('/tmp', `tmux-${uid}`, label))).toBe(false);
    expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: file })).toBe(realpathSync(file));
  });

  it.skipIf(!usable)('resolves a relative TMUX_TMPDIR against the invoking cwd', () => {
    const real = realTmuxBinary();
    if (!real) return;
    const work = probeRoot('tmux-real-cwd-');
    const rel = join(work, 'rel');
    mkdirSync(rel);
    const label = `bmx-root-rel-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const started = spawnSync(real, ['-L', label, 'new-session', '-d', '-s', 'probe', 'sleep 5'], {
      encoding: 'utf8', timeout: 5000, cwd: work, env: { ...process.env, TMUX_TMPDIR: 'rel' },
    });
    if (started.status !== 0) return;
    try {
      expect(existsSync(join(rel, `tmux-${uid}`, label))).toBe(true);
      expect(resolveTmuxSocketRoot({ TMUX_TMPDIR: 'rel' }, work)).toBe(realpathSync(rel));
    } finally {
      spawnSync(real, ['-L', label, 'kill-server'], { encoding: 'utf8', timeout: 5000, cwd: work, env: { ...process.env, TMUX_TMPDIR: 'rel' } });
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
      encoding: 'utf8', timeout: 5000, env: { ...process.env, TMUX_TMPDIR: missing },
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
