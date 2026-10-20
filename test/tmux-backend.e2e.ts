/**
 * E2E test: tmux session lifecycle on the live backend (TmuxPipeBackend) and
 * TmuxBackend's static helpers.
 *
 * Verifies:
 * 1. TmuxPipeBackend.spawn() creates a tmux session and captures output via pipe-pane
 * 2. kill() detaches without destroying the tmux session
 * 3. A second TmuxPipeBackend with the same name re-attaches (isReattach) and
 *    repairs stale detached geometry
 * 4. destroySession() kills the tmux session
 * 5. TmuxBackend.listBotmuxSessions() enumerates bmx-* sessions
 *
 * Requires: tmux installed (skips if not available)
 * Run: bun run vitest run --project e2e test/tmux-backend.e2e.ts
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { linuxIsolationLaunchViaArgsFile } from '../src/core/linux-isolation.js';

const TEST_SESSION = 'bmx-test0001';
const TEST_TIMEOUT = 15_000;
const canRunBwrap = process.platform === 'linux'
  && ['x64', 'arm64', 'ia32', 'arm'].includes(process.arch)
  && spawnSync('bwrap', [
    '--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc',
    '--', '/bin/true',
  ], { stdio: 'ignore', timeout: 5_000 }).status === 0;

describe('tmux session lifecycle (TmuxPipeBackend + TmuxBackend statics)', () => {
  beforeEach(() => {
    // Ensure clean state
    TmuxBackend.killSession(TEST_SESSION);
  });

  afterEach(() => {
    // Cleanup
    TmuxBackend.killSession(TEST_SESSION);
  });

  it.skipIf(!TmuxBackend.isAvailable())('spawn creates tmux session and captures output', async () => {
    const backend = new TmuxPipeBackend(TEST_SESSION, { createSession: true, ownsSession: true });
    const output: string[] = [];

    // pipe-pane only streams output produced AFTER the subscription is attached,
    // so emit repeatedly rather than once.
    backend.spawn('/bin/bash', ['-c', 'while :; do echo HELLO_TMUX; sleep 0.3; done'], spawnOpts());

    backend.onData((data) => output.push(data));

    // Wait for output
    await waitFor(() => output.join('').includes('HELLO_TMUX'), 5000);
    expect(output.join('')).toContain('HELLO_TMUX');

    // Tmux session should exist
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(true);
    expect(backend.isReattach).toBe(false);

    // Detach (stop the pipe subscription, tmux survives)
    backend.kill();
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(true);
  }, TEST_TIMEOUT);

  it.skipIf(!TmuxBackend.isAvailable() || !canRunBwrap)(
    'starts a sandbox whose bwrap options exceed tmux command limits',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'botmux-tmux-bwrap-args-'));
      const backend = new TmuxPipeBackend(TEST_SESSION, { createSession: true, ownsSession: true });
      const output: string[] = [];
      const longOptions = [
        '--ro-bind', '/', '/',
        '--unshare-user', '--unshare-pid', '--proc', '/proc', '--dev', '/dev',
        ...Array.from({ length: 512 }, (_, index) => [
          '--setenv',
          `BOTMUX_LONG_OPTION_${index}`,
          `padding-${index}-${'x'.repeat(40)}`,
        ]).flat(),
      ];
      const launch = linuxIsolationLaunchViaArgsFile(
        'bwrap',
        longOptions,
        ['/bin/sh', '-c', 'while :; do echo COMPACT_TMUX_BWRAP_OK; sleep 1; done'],
        root,
      );
      try {
        backend.spawn(launch.bin, launch.args, {
          cwd: root,
          cols: 80,
          rows: 24,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        });
        backend.onData(data => output.push(data));
        await waitFor(() => output.join('').includes('COMPACT_TMUX_BWRAP_OK'), 8_000);
        expect(output.join('')).toContain('COMPACT_TMUX_BWRAP_OK');
        expect(existsSync(launch.argsFile)).toBe(false);
      } finally {
        backend.destroySession();
        launch.cleanup();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it.skipIf(!TmuxBackend.isAvailable())('re-attach captures output from surviving session', async () => {
    // Phase 1: Create session
    const be1 = new TmuxPipeBackend(TEST_SESSION, { createSession: true, ownsSession: true });
    be1.spawn('/bin/bash', ['-c', 'echo PHASE1; while :; do echo TICK; sleep 0.3; done'], spawnOpts());

    const out1: string[] = [];
    be1.onData((data) => out1.push(data));
    await waitFor(() => out1.join('').includes('TICK'), 5000);

    // Detach
    be1.kill();
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(true);

    // Phase 2: Re-attach
    const be2 = new TmuxPipeBackend(TEST_SESSION, { ownsSession: true, isReattach: true });
    const out2: string[] = [];

    // spawn() on a reattach must subscribe to the surviving pane, not create one
    be2.spawn('/bin/bash', ['-c', 'echo SHOULD_NOT_RUN'], spawnOpts());

    be2.onData((data) => out2.push(data));
    expect(be2.isReattach).toBe(true);

    // The surviving CLI keeps producing output through the new subscription,
    // and the screen snapshot still carries what Phase 1 printed.
    await waitFor(() => out2.join('').includes('TICK'), 5000);
    expect(be2.captureCurrentScreen()).toContain('PHASE1');

    // Should NOT contain SHOULD_NOT_RUN (bin/args are ignored on re-attach)
    expect(out2.join('')).not.toContain('SHOULD_NOT_RUN');
    expect(be2.captureCurrentScreen()).not.toContain('SHOULD_NOT_RUN');

    // destroySession kills tmux
    be2.destroySession();
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(false);
  }, TEST_TIMEOUT);

  it.skipIf(!TmuxBackend.isAvailable())('tmux pipe reattach repairs stale detached geometry', async () => {
    const first = new TmuxPipeBackend(TEST_SESSION, { createSession: true, ownsSession: true });
    first.spawn('/bin/bash', ['-c', 'sleep 60'], {
      cwd: '/tmp',
      cols: 60,
      rows: 56,
      env: { ...process.env } as Record<string, string>,
    });
    await waitFor(() => TmuxBackend.hasSession(TEST_SESSION), 5000);
    first.kill();

    const second = new TmuxPipeBackend(TEST_SESSION, { ownsSession: true, isReattach: true });
    second.spawn('/bin/bash', ['-c', 'echo SHOULD_NOT_RUN'], {
      cwd: '/tmp',
      cols: 160,
      rows: 50,
      env: { ...process.env } as Record<string, string>,
    });

    await waitFor(() => {
      const size = execFileSync(
        'tmux', ['display-message', '-p', '-t', TEST_SESSION, '#{pane_width}x#{pane_height}'],
        { encoding: 'utf-8' },
      ).trim();
      return size === '160x50';
    }, 5000);
    expect(second.getPaneSize()).toEqual({ cols: 160, rows: 50 });
    second.destroySession();
  }, TEST_TIMEOUT);

  it.skipIf(!TmuxBackend.isAvailable())('destroySession kills tmux session', async () => {
    const backend = new TmuxPipeBackend(TEST_SESSION, { createSession: true, ownsSession: true });
    backend.spawn('/bin/bash', ['-c', 'sleep 60'], spawnOpts());
    // `tmux new-session` is async — under full-suite load the registration in
    // the tmux server can lag behind pty.spawn returning. Poll briefly so the
    // assertion measures the steady state, not the race.
    await waitFor(() => TmuxBackend.hasSession(TEST_SESSION), 5000);

    backend.destroySession();
    await waitFor(() => !TmuxBackend.hasSession(TEST_SESSION), 5000);
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(false);
  }, TEST_TIMEOUT);

  it.skipIf(!TmuxBackend.isAvailable())('listBotmuxSessions returns bmx- sessions', async () => {
    const backend = new TmuxPipeBackend(TEST_SESSION, { createSession: true, ownsSession: true });
    backend.spawn('/bin/bash', ['-c', 'sleep 60'], spawnOpts());
    await waitFor(() => TmuxBackend.listBotmuxSessions().includes(TEST_SESSION), 5000);
    expect(TmuxBackend.listBotmuxSessions()).toContain(TEST_SESSION);

    backend.destroySession();
  }, TEST_TIMEOUT);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function spawnOpts() {
  return {
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    env: { ...process.env } as Record<string, string>,
  };
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(check, 100);
    };
    check();
  });
}
