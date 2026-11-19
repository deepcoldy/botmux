/**
 * The tmux test fence (test/helpers/tmux-fence.ts) must refuse every route a
 * test has used to reach the host's tmux servers, and let private ones through.
 * The shim under test wraps a FAKE "real tmux" that only echoes its argv, so no
 * tmux server is ever contacted here.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  it('honours a colon-separated TMUX_TMPDIR the way tmux does (first entry that resolves)', () => {
    const r = run(['kill-server'], { TMUX_TMPDIR: `${join(work, 'missing')}:${privateRoot}` });
    expect(r.status).toBe(0);
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
