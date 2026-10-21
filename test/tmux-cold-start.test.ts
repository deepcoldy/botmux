import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { tmuxEnv } from '../src/setup/ensure-tmux.js';

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('private tmux server did not become ready');
    await delay(10);
  }
}

it.skipIf(process.platform !== 'linux' || spawnSync('tmux', ['-V'], { timeout: 3000 }).status !== 0)(
  'permits a real cold start but preserves an unlinked live server and its pane', async () => {
    // A short, private path with a space exercises the real stderr/proc format.
    // -D keeps this server in a child process we own, even after unlink; cleanup
    // never needs to contact the user's default server or guess a server PID.
    const socketRoot = mkdtempSync('/tmp/bmx cold-');
    vi.stubEnv('TMUX_TMPDIR', socketRoot);
    const socketPath = join(socketRoot, `tmux-${process.getuid!()}`, 'default');
    const name = 'cold-start-instance';
    const env = tmuxEnv();
    const tmux = (args: string[]) => execFileSync('tmux', args, {
      env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    let server: ReturnType<typeof spawn> | undefined;
    let exited: Promise<void> | undefined;
    try {
      expect(TmuxBackend.probeSession(name)).toBe('unknown');
      expect(() => TmuxBackend.assertInstanceIdentity(name, 'binding-a')).not.toThrow();
      expect(existsSync(socketPath)).toBe(false);

      server = spawn('tmux', ['-D', '-f', '/dev/null'], { env, stdio: 'ignore' });
      exited = new Promise<void>(resolve => {
        server!.once('exit', () => resolve());
        server!.once('error', () => resolve());
      });
      await waitUntil(() => existsSync(socketPath));
      tmux(['new-session', '-d', '-s', name, '-e', 'BOTMUX_CODEX_INSTANCE_BINDING=binding-a', '/bin/sleep', '60']);
      expect(Number(tmux(['display-message', '-p', '-t', name, '#{pid}']))).toBe(server.pid);
      expect(tmux(['display-message', '-p', '-t', name, '#{socket_path}'])).toBe(socketPath);
      const panePid = tmux(['display-message', '-p', '-t', name, '#{pane_pid}']);
      expect(() => TmuxBackend.assertInstanceIdentity(name, 'binding-a')).not.toThrow();
      expect(() => TmuxBackend.assertInstanceIdentity(name, 'binding-b')).toThrow(/preserved/);

      unlinkSync(socketPath);
      expect(readFileSync('/proc/net/unix', 'utf8')).toContain(` ${socketPath}\n`);
      expect(TmuxBackend.probeSession(name)).toBe('unknown');
      expect(() => TmuxBackend.assertInstanceIdentity(name, 'binding-a')).toThrow(/preserved/);
      expect(() => process.kill(Number(panePid), 0)).not.toThrow();

      server.kill('SIGUSR1');
      await waitUntil(() => existsSync(socketPath));
      expect(() => TmuxBackend.assertInstanceIdentity(name, 'binding-a')).not.toThrow();
      expect(tmux(['display-message', '-p', '-t', name, '#{pane_pid}'])).toBe(panePid);
    } finally {
      if (server && exited) {
        server.kill('SIGTERM');
        await Promise.race([exited, delay(3000)]);
        if (server.exitCode === null && server.signalCode === null) {
          server.kill('SIGKILL');
          await exited;
        }
      }
      vi.unstubAllEnvs();
      rmSync(socketRoot, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== 'linux' || spawnSync('tmux', ['-V'], { timeout: 3000 }).status !== 0)(
  'creates a bound managed pipe session from cold and fences reattachment without touching the pane', () => {
    const socketRoot = mkdtempSync('/tmp/bmx pipe-');
    vi.stubEnv('TMUX_TMPDIR', socketRoot);
    const socketPath = join(socketRoot, `tmux-${process.getuid!()}`, 'default');
    const name = 'cold-pipe-instance';
    const env = tmuxEnv();
    const tmux = (args: string[]) => execFileSync('tmux', args, {
      env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const opts = {
      cwd: socketRoot, cols: 80, rows: 24, launchShell: '/bin/sh',
      env: { ...process.env, BOTMUX_CODEX_INSTANCE_BINDING: 'binding-a' } as Record<string, string>,
    };
    const fresh = new TmuxPipeBackend(name, { createSession: true, ownsSession: true });
    const same = new TmuxPipeBackend(name, { ownsSession: true, isReattach: true });
    const rejected = new TmuxPipeBackend(name, { ownsSession: true, isReattach: true });
    try {
      expect(TmuxBackend.probeSession(name)).toBe('unknown');
      expect(() => TmuxBackend.assertInstanceIdentity(name, 'binding-a')).not.toThrow();
      fresh.spawn('/bin/sleep', ['60'], opts);
      expect(tmux(['show-environment', '-t', name, 'BOTMUX_CODEX_INSTANCE_BINDING']))
        .toBe('BOTMUX_CODEX_INSTANCE_BINDING=binding-a');
      const panePid = tmux(['display-message', '-p', '-t', name, '#{pane_pid}']);
      fresh.kill();
      expect(() => same.spawn('', [], opts)).not.toThrow();
      expect(tmux(['display-message', '-p', '-t', name, '#{pane_pid}'])).toBe(panePid);
      tmux(['set-option', '-t', name, 'status', 'off']);

      const wrong = { ...opts, env: { ...opts.env, BOTMUX_CODEX_INSTANCE_BINDING: 'binding-b' } };
      expect(() => rejected.spawn('', [], wrong)).toThrow(/preserved/);
      expect(tmux(['show-options', '-v', '-t', name, 'status'])).toBe('off');
      expect(tmux(['display-message', '-p', '-t', name, '#{pane_pipe}'])).toBe('1');
      expect(tmux(['display-message', '-p', '-t', name, '#{pane_pid}'])).toBe(panePid);

      tmux(['set-environment', '-u', '-t', name, 'BOTMUX_CODEX_INSTANCE_BINDING']);
      expect(() => rejected.spawn('', [], opts)).toThrow(/preserved/);
      expect(tmux(['show-options', '-v', '-t', name, 'status'])).toBe('off');
      expect(tmux(['display-message', '-p', '-t', name, '#{pane_pid}'])).toBe(panePid);
    } finally {
      same.kill();
      fresh.kill();
      rejected.kill();
      // Only this test's exact socket is eligible for cleanup, including when
      // a partial spawn failed before the backend could record its reader.
      spawnSync('tmux', ['-S', socketPath, 'kill-server'], { env, timeout: 3000, stdio: 'ignore' });
      vi.unstubAllEnvs();
      rmSync(socketRoot, { recursive: true, force: true });
    }
  },
);
