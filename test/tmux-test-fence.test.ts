/**
 * The tmux test fence (test/helpers/tmux-fence.ts) must refuse every route a
 * test has used to reach the host's tmux servers, and let private ones through.
 * The shim under test wraps a FAKE "real tmux" that only echoes its argv, so no
 * tmux server is ever contacted here.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { hostTmuxSocketDirs, tmuxFenceShimScript } from './helpers/tmux-fence.js';

const posix = process.platform !== 'win32';
const work = mkdtempSync('/tmp/bmxt-selftest-');
const privateRoot = join(work, 'private');
mkdirSync(privateRoot);
const fakeReal = join(work, 'real-tmux');
writeFileSync(fakeReal, '#!/bin/sh\necho "REAL:$*"\n');
chmodSync(fakeReal, 0o755);
const denyLog = join(work, 'denied.log');
const shim = join(work, 'tmux');
writeFileSync(shim, tmuxFenceShimScript(fakeReal, hostTmuxSocketDirs({}), denyLog));
chmodSync(shim, 0o755);
const uid = typeof process.getuid === 'function' ? process.getuid() : 0;

afterAll(() => rmSync(work, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string | undefined>) {
  writeFileSync(denyLog, '');
  const clean: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const r = spawnSync(shim, args, { env: clean, encoding: 'utf8', cwd: work });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, denied: readFileSync(denyLog, 'utf8') };
}

describe.skipIf(!posix)('tmux test fence shim', () => {
  it('refuses a bare client with no TMUX_TMPDIR (agent `tmux kill-server` in its own pane)', () => {
    const r = run(['kill-server'], {});
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('refusing host tmux socket');
    expect(r.denied).toContain(`/tmux-${uid}/default`);
  });

  it('refuses a TMUX_TMPDIR that does not exist — tmux silently falls back to /tmp', () => {
    const r = run(['new-session', '-d', '-s', 'x'], { TMUX_TMPDIR: join(work, 'never-created') });
    expect(r.status).toBe(1);
    expect(r.denied).toContain(`/tmux-${uid}/default`);
  });

  it('refuses an inherited TMUX that points at a host server, unless -L/-S overrides it', () => {
    const tmux = `/tmp/tmux-${uid}/default,123,0`;
    expect(run(['kill-server'], { TMUX: tmux, TMUX_TMPDIR: privateRoot }).status).toBe(1);
    const labelled = run(['-L', 'x', 'kill-server'], { TMUX: tmux, TMUX_TMPDIR: privateRoot });
    expect(labelled.status).toBe(0);
    expect(labelled.stdout.trim()).toBe('REAL:-L x kill-server');
  });

  it('refuses the dedicated botmux socket of the host as well as the default one', () => {
    expect(run(['-L', 'botmux', 'list-sessions'], {}).status).toBe(1);
    expect(run(['-uLbotmux', 'list-sessions'], {}).status).toBe(1);
    expect(run(['-S', `/tmp/tmux-${uid}/default`, 'kill-server'], {}).status).toBe(1);
  });

  it('lets private sockets and version probes through untouched', () => {
    const viaTmpdir = run(['-f', '/dev/null', '-L', 'botmux', 'new-session', '-d'], { TMUX_TMPDIR: privateRoot });
    expect(viaTmpdir.status).toBe(0);
    expect(viaTmpdir.stdout.trim()).toBe('REAL:-f /dev/null -L botmux new-session -d');
    const viaSocket = run(['-S', join(privateRoot, 'sock'), 'kill-server'], {});
    expect(viaSocket.status).toBe(0);
    expect(run(['-V'], {}).stdout.trim()).toBe('REAL:-V');
    expect(run([], { TMUX_TMPDIR: privateRoot }).status).toBe(0);
    expect(run(['kill-server'], {}).denied).not.toBe('');
  });

  it('refuses a colon-separated TMUX_TMPDIR — tmux treats it as one path and falls back to /tmp', () => {
    // tmux does NOT read $TMUX_TMPDIR as a list: the whole value is one path,
    // and a value that does not name an existing directory makes tmux use /tmp.
    // So such a call really targets the host socket directory and must be
    // refused (the fence's own resolution has to match tmux's, or it would
    // wave through a call that drives the host default server).
    const r = run(['kill-server'], { TMUX_TMPDIR: `${join(work, 'missing')}:${privateRoot}` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing host tmux socket');
    expect(r.denied).toContain(`/tmux-${uid}/default`);
  });

  it('refuses an existing host root whose NAME contains a colon', () => {
    // tmux resolves $TMUX_TMPDIR as ONE path, so a directory literally named
    // "fleet:root" is a real root the shim can land on. Registration must
    // cover the COMPLETE value — a colon-split-only list would register /tmp
    // and the colon-free fragments, waving the real host root through.
    const hostRoot = join(work, 'fleet:root');
    mkdirSync(hostRoot);
    const colonShim = join(work, 'tmux-colon-host');
    writeFileSync(colonShim, tmuxFenceShimScript(fakeReal, hostTmuxSocketDirs({ TMUX_TMPDIR: hostRoot }), denyLog));
    chmodSync(colonShim, 0o755);
    writeFileSync(denyLog, '');
    const r = spawnSync(colonShim, ['-L', 'x', 'new-session', '-d'], {
      env: { PATH: process.env.PATH, TMUX_TMPDIR: hostRoot }, encoding: 'utf8', cwd: work,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing host tmux socket');
    expect(readFileSync(denyLog, 'utf8')).toContain(join(hostRoot, `tmux-${uid}`));
  });

  it('refuses a TMUX_TMPDIR symlinked to a host root before tmux-<uid> exists there', () => {
    // tmux realpath()s $TMUX_TMPDIR, so a symlink to a host socket root lands
    // the server in that root. The fence must resolve it the same way even
    // when <root>/tmux-<uid> does not exist yet (fresh host, nothing to cd into).
    const hostRoot = join(work, 'host-root');
    mkdirSync(hostRoot);
    const link = join(work, 'host-root-link');
    symlinkSync(hostRoot, link);
    const hostShim = join(work, 'tmux-host-root');
    writeFileSync(hostShim, tmuxFenceShimScript(fakeReal, [join(realpathSync(hostRoot), `tmux-${uid}`)], denyLog));
    chmodSync(hostShim, 0o755);
    writeFileSync(denyLog, '');
    const r = spawnSync(hostShim, ['-L', 'x', 'new-session', '-d'], {
      env: { PATH: process.env.PATH, TMUX_TMPDIR: link }, encoding: 'utf8', cwd: work,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('refusing host tmux socket');
  });
});

describe.skipIf(!posix)('this test process is fenced', () => {
  it('has an existing private TMUX_TMPDIR and no inherited TMUX', () => {
    const dir = process.env.TMUX_TMPDIR;
    expect(dir).toBeTruthy();
    expect(statSync(dir!).isDirectory()).toBe(true);
    expect(hostTmuxSocketDirs({})).not.toContain(join(dir!, `tmux-${uid}`));
    expect(process.env.TMUX).toBeUndefined();
    expect(process.env.TMUX_PANE).toBeUndefined();
  });

  it('makes the `tmux` on PATH refuse a host socket when the host has tmux', () => {
    const located = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
    if (!located) return; // no tmux on this host: nothing to wrap
    // Throwaway log: this deliberate refusal must not fail the file's own fence.
    const log = join(work, 'self-check.log');
    writeFileSync(log, '');
    const label = `bmx-fence-selfcheck-${process.pid}`;
    const r = spawnSync(located, ['-L', label, 'list-sessions'], {
      env: { PATH: process.env.PATH, BOTMUX_TMUX_FENCE_LOG: log },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(readFileSync(log, 'utf8')).toContain(`/tmux-${uid}/${label}`);
    expect(existsSync(`/tmp/tmux-${uid}/${label}`)).toBe(false);
  });
});
