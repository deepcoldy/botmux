/**
 * tmux 2.8 releases a dead pane's event before pipe-pane can use it: subscribing
 * to that corpse crashes the entire server. A modern binary cannot reproduce
 * this bug, so this regression runs only against a real 2.8 (not a version shim).
 * Each run owns an explicit private -S socket, including its neighbour session;
 * even the guard-removal mutation can only crash this test's server.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  TmuxPipeBackend,
  __testOnly_liveFifoReaderCount,
  setStartupTmuxRetrySleepForTests,
} from '../src/adapters/backend/tmux-pipe-backend.js';
import { resetTmuxVersionCacheForTests } from '../src/setup/ensure-tmux.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';

let realTmux: string | undefined;
let realVersion = '';
try {
  realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8', timeout: 3000 }).trim();
  realVersion = execFileSync(realTmux, ['-V'], { encoding: 'utf8', timeout: 3000 }).trim();
} catch { /* tmux is optional */ }

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

it.skipIf(!realTmux || !/^tmux 2\.8(?:\s|$)/.test(realVersion))(
  'real tmux 2.8: a CLI dying during the attach retry cannot crash its neighbour', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmx-legacy-guard-'));
    const socket = join(root, 'socket');
    const shimDir = join(root, 'bin');
    const failOnce = join(root, 'fail-once');
    mkdirSync(shimDir);
    // Inject one recoverable attach failure. Match either command shape so
    // removing the if-shell guard still drives the SAME death-during-retry race.
    writeFileSync(join(shimDir, 'tmux'), `#!/bin/sh
case "$1" in
  if-shell|pipe-pane)
    if [ -f ${quote(failOnce)} ]; then
      rm ${quote(failOnce)}
      echo 'error connecting to private socket (Connection refused)' >&2
      exit 1
    fi ;;
esac
exec ${quote(realTmux!)} -S ${quote(socket)} "$@"
`, { mode: 0o755 });
    const env = privateTmuxEnv(root, { PATH: `${shimDir}:${process.env.PATH}`, SHELL: '/bin/sh' });
    const tmux = (...args: string[]) => spawnSync(realTmux!, ['-S', socket, ...args], {
      env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const backend = new TmuxPipeBackend('bmx-retry', { createSession: true, ownsSession: true });
    const readersBefore = __testOnly_liveFifoReaderCount();
    const exits: Array<number | null> = [];
    let retries = 0;
    try {
      for (const key of ['PATH', 'SHELL', 'TMUX_TMPDIR'] as const) vi.stubEnv(key, env[key]!);
      vi.stubEnv('TMUX', '');
      vi.stubEnv('TMUX_PANE', '');
      resetTmuxVersionCacheForTests();
      expect(tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'bmx-neighbour', 'sleep 60').status).toBe(0);
      writeFileSync(failOnce, 'fail');
      // Control the retry wait instead of sleeping a wall-clock second. The
      // real shell exits only after that first failure; wait for its published
      // status before allowing the second subscription attempt to run.
      setStartupTmuxRetrySleepForTests(() => {
        retries += 1;
        expect(retries).toBe(1);
        expect(tmux('send-keys', '-t', 'bmx-retry', 'Enter').status).toBe(0);
        const deadline = Date.now() + 5000;
        let death = '';
        do {
          death = tmux('display-message', '-p', '-t', 'bmx-retry', '#{pane_dead}:#{pane_dead_status}').stdout.trim();
          if (death === '1:77') break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        } while (Date.now() < deadline);
        expect(death).toBe('1:77');
      });
      backend.onExit(code => exits.push(code));
      expect(() => backend.spawn('/bin/sh', ['-c', 'read line; exit 77'], {
        cwd: root, cols: 80, rows: 24, launchShell: '/bin/sh',
        env: env as Record<string, string>, paneLaunchDir: root,
      })).toThrow(/exit status=77/);
      // Also wire a listener after spawn(), as the production worker does:
      // infrastructure/startup failure must not leave a sticky process exit.
      backend.onExit(code => exits.push(code));
      expect(retries).toBe(1);
      expect(exits).toEqual([]);
      expect(__testOnly_liveFifoReaderCount()).toBe(readersBefore);
      expect(tmux('has-session', '-t', 'bmx-neighbour').status).toBe(0);
      expect(tmux('display-message', '-p', '-t', 'bmx-retry', '#{pane_dead}:#{pane_dead_status}').stdout.trim()).toBe('1:77');
      expect(existsSync(failOnce)).toBe(false);
    } finally {
      setStartupTmuxRetrySleepForTests(null);
      backend.kill();
      tmux('kill-server');
      vi.unstubAllEnvs();
      resetTmuxVersionCacheForTests();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
