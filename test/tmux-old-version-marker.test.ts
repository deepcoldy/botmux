/**
 * Regression for #1959: `new-session -e` only exists since tmux 3.2. On older
 * builds the backend must not send -e (a deterministic "unknown flag" launch
 * failure) and must instead persist the codex instance binding with
 * `set-environment` after a proven-fresh creation.
 *
 * The PATH shim reports an old/unknown version and rejects both
 * `new-session -e` and `remain-on-exit failed`, delegating to a real binary.
 *
 * Isolation is mandatory (see test/tmux-test-isolation-guard.test.ts and the
 * 2026-10-20 incident): an inherited TMUX makes a client ignore TMUX_TMPDIR and
 * talk to the caller's server, so every env is built with privateTmuxEnv()
 * (strips TMUX/TMUX_PANE) and cleanup targets the explicit private -S socket.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { resetTmuxVersionCacheForTests } from '../src/setup/ensure-tmux.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';

// Resolved at module load, before PATH is stubbed, so it points at the REAL
// binary the shim delegates to (never the shim itself, which would recurse).
function realTmuxPath(): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'tmux');
    try {
      execFileSync(candidate, ['-V'], { stdio: 'ignore', timeout: 3000 });
      return candidate;
    } catch { /* keep scanning */ }
  }
  return null;
}

const realTmux = realTmuxPath();

it.skipIf(process.platform !== 'linux' || spawnSync('tmux', ['-V'], { timeout: 3000 }).status !== 0 || !realTmux).each(['2.8', '3.1c', 'unknown'])(
  'tmux %s creates and reattaches a bound session without unsupported flags/options', async (version) => {
    const workRoot = mkdtempSync(join(tmpdir(), 'bmx oldtmux-'));
    const shimDir = join(workRoot, 'bin');
    const socketRoot = join(workRoot, 'sock');
    mkdirSync(shimDir, { recursive: true });
    // tmux silently falls back to /tmp when TMUX_TMPDIR does not exist —
    // without this the test would drive (and kill-server) the HOST server.
    mkdirSync(socketRoot, { recursive: true });
    const shim = join(shimDir, 'tmux');
    writeFileSync(shim, `#!/bin/sh
# Emulates pre-3.2 tmux and an unavailable version probe.
if [ "$1" = "-V" ]; then echo "tmux ${version}"; exit 0; fi
# Server-side version answer: report the SAME emulated version, otherwise the
# (real, modern) server spawned through this shim would answer its actual
# version and the backend would correctly conclude failed is supported.
for a in "$@"; do
  if [ "$a" = "#{version}" ]; then
    case "${version}" in unknown) echo "not-a-version";; *) echo "${version}";; esac
    exit 0
  fi
done
previous=''
seen=0
for a in "$@"; do
  if [ "$previous" = "remain-on-exit" ] && [ "$a" = "failed" ]; then
    echo "bad value: failed" >&2
    exit 1
  fi
  if [ $seen -eq 1 ] && [ "$a" = "-e" ]; then
    echo "command new-session: unknown flag -e" >&2
    exit 1
  fi
  [ "$a" = "new-session" ] && seen=1
  previous=$a
done
exec ${realTmux} "$@"
`);
    chmodSync(shim, 0o755);

    const pathWithShim = `${shimDir}:${process.env.PATH}`;
    // The backend's version/has-session probes read process.env, so stub both
    // there too; privateTmuxEnv() is what strips an inherited TMUX for safety.
    vi.stubEnv('PATH', pathWithShim);
    vi.stubEnv('TMUX_TMPDIR', socketRoot);
    resetTmuxVersionCacheForTests();
    const env = privateTmuxEnv(socketRoot, { PATH: pathWithShim }) as Record<string, string>;
    const privateSocket = join(socketRoot, `tmux-${process.getuid!()}`, 'default');
    const tmux = (args: string[]) => execFileSync('tmux', args, {
      env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const name = 'bmx-oldtmux';
    const fresh = new TmuxPipeBackend(name, { createSession: true, ownsSession: true });
    try {
      // The shim rejects both unsupported protocol features.
      expect(tmux(['-V'])).toBe(`tmux ${version}`);
      expect(spawnSync('tmux', ['new-session', '-d', '-s', 'probe', '-e', 'X=y', 'true'], { env }).status).toBe(1);
      expect(spawnSync('tmux', ['set-option', 'remain-on-exit', 'failed'], { env }).status).toBe(1);

      // The bound managed session still comes up (pre-fix this threw deterministically).
      expect(() => fresh.spawn('/bin/sleep', ['600'], {
        cwd: workRoot, cols: 80, rows: 24, launchShell: '/bin/sh',
        env: { ...env, BOTMUX_CODEX_INSTANCE_BINDING: 'binding-a' },
      })).not.toThrow();
      // Marker persisted in the session table via set-environment.
      expect(tmux(['show-environment', '-t', name, 'BOTMUX_CODEX_INSTANCE_BINDING']))
        .toBe('BOTMUX_CODEX_INSTANCE_BINDING=binding-a');
      expect(tmux(['show-options', '-w', '-v', '-t', name, 'remain-on-exit'])).toBe('on');

      // Same identity reattaches; a wrong identity is fenced without touching the pane.
      tmux(['set-option', '-t', name, 'remain-on-exit', 'off']);
      const same = new TmuxPipeBackend(name, { ownsSession: true, isReattach: true });
      try {
        expect(() => same.spawn('', [], {
          cwd: workRoot, cols: 80, rows: 24, launchShell: '/bin/sh',
          env: { ...env, BOTMUX_CODEX_INSTANCE_BINDING: 'binding-a' },
        })).not.toThrow();
        expect(tmux(['show-options', '-w', '-v', '-t', name, 'remain-on-exit'])).toBe('on');
        const wrong = new TmuxPipeBackend(name, { ownsSession: true, isReattach: true });
        expect(() => wrong.spawn('', [], {
          cwd: workRoot, cols: 80, rows: 24, launchShell: '/bin/sh',
          env: { ...env, BOTMUX_CODEX_INSTANCE_BINDING: 'binding-b' },
        })).toThrow(/preserved/);
      } finally {
        same.kill();
      }

      // `on` also keeps exit 0. The backend must deliver it and remove the
      // retained pane rather than leaving a completed session addressable.
      const clean = new TmuxPipeBackend('bmx-oldtmux-clean', { createSession: true, ownsSession: true });
      try {
        const exited = new Promise<number | null>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('clean exit was not reported')), 20_000);
          clean.onExit(code => { clearTimeout(timer); resolve(code); });
        });
        clean.spawn('/bin/sh', ['-c', 'read line; exit 0'], {
          cwd: workRoot, cols: 80, rows: 24, launchShell: '/bin/sh', env,
        });
        expect(clean.write('finish\r')).toBe(true);
        expect(await exited).toBe(0);
        expect(spawnSync('tmux', ['has-session', '-t', 'bmx-oldtmux-clean'], { env }).status).toBe(1);
      } finally {
        clean.kill();
      }
    } finally {
      fresh.kill();
      // Explicit -S socket is immune to an inherited TMUX; never bare kill-server.
      spawnSync('tmux', ['-S', privateSocket, 'kill-server'], { env, timeout: 3000, stdio: 'ignore' });
      vi.unstubAllEnvs();
      resetTmuxVersionCacheForTests();
      rmSync(workRoot, { recursive: true, force: true });
    }
  },
);

afterAll(() => resetTmuxVersionCacheForTests());
