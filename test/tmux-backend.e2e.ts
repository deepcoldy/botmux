/**
 * E2E test: TmuxBackend spawn, output capture, detach, and re-attach.
 *
 * Verifies:
 * 1. TmuxBackend.spawn() creates a tmux session and captures output via pty
 * 2. kill() detaches without destroying the tmux session
 * 3. A second TmuxBackend with the same name re-attaches and captures output
 * 4. destroySession() kills the tmux session
 *
 * Requires: tmux installed (skips if not available)
 * Run: pnpm vitest run test/tmux-backend.e2e.ts
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';

const TEST_SESSION = 'bmx-test0001';
const TEST_TIMEOUT = 15_000;

describe('TmuxBackend', () => {
  beforeEach(() => {
    // Ensure clean state
    TmuxBackend.killSession(TEST_SESSION);
  });

  afterEach(() => {
    // Cleanup
    TmuxBackend.killSession(TEST_SESSION);
  });

  it.skipIf(!TmuxBackend.isAvailable())('spawn creates tmux session and captures output', async () => {
    const backend = new TmuxBackend(TEST_SESSION);
    const output: string[] = [];

    // Spawn a simple command that outputs something and stays alive
    backend.spawn('/bin/bash', ['-c', 'echo HELLO_TMUX && sleep 60'], {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { ...process.env } as Record<string, string>,
    });

    backend.onData((data) => output.push(data));

    // Wait for output
    await waitFor(() => output.join('').includes('HELLO_TMUX'), 5000);
    expect(output.join('')).toContain('HELLO_TMUX');

    // Tmux session should exist
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(true);
    expect(backend.isReattach).toBe(false);

    // Detach (kill pty viewer, tmux survives)
    backend.kill();
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(true);
  }, TEST_TIMEOUT);

  it.skipIf(!TmuxBackend.isAvailable())('re-attach captures output from surviving session', async () => {
    // Phase 1: Create session
    const be1 = new TmuxBackend(TEST_SESSION);
    be1.spawn('/bin/bash', ['-c', 'echo PHASE1 && sleep 60'], {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { ...process.env } as Record<string, string>,
    });

    const out1: string[] = [];
    be1.onData((data) => out1.push(data));
    await waitFor(() => out1.join('').includes('PHASE1'), 5000);

    // Detach
    be1.kill();
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(true);

    // Phase 2: Re-attach
    const be2 = new TmuxBackend(TEST_SESSION);
    const out2: string[] = [];

    // spawn() with same name → should attach, not create
    be2.spawn('/bin/bash', ['-c', 'echo SHOULD_NOT_RUN'], {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { ...process.env } as Record<string, string>,
    });

    be2.onData((data) => out2.push(data));
    expect(be2.isReattach).toBe(true);

    // Wait for tmux to replay screen content (PHASE1 should be visible)
    await waitFor(() => out2.join('').length > 0, 5000);

    // Should NOT contain SHOULD_NOT_RUN (bin/args are ignored on re-attach)
    expect(out2.join('')).not.toContain('SHOULD_NOT_RUN');

    // destroySession kills tmux
    be2.destroySession();
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(false);
  }, TEST_TIMEOUT);

  it.skipIf(!TmuxBackend.isAvailable())('destroySession kills tmux session', async () => {
    const backend = new TmuxBackend(TEST_SESSION);
    backend.spawn('/bin/bash', ['-c', 'sleep 60'], {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { ...process.env } as Record<string, string>,
    });
    // `tmux new-session` is async — under full-suite load the registration in
    // the tmux server can lag behind pty.spawn returning. Poll briefly so the
    // assertion measures the steady state, not the race.
    await waitFor(() => TmuxBackend.hasSession(TEST_SESSION), 5000);

    backend.destroySession();
    await waitFor(() => !TmuxBackend.hasSession(TEST_SESSION), 5000);
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(false);
  }, TEST_TIMEOUT);

  it.skipIf(!TmuxBackend.isAvailable())('listBotmuxSessions returns bmx- sessions', async () => {
    const backend = new TmuxBackend(TEST_SESSION);
    backend.spawn('/bin/bash', ['-c', 'sleep 60'], {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { ...process.env } as Record<string, string>,
    });
    await waitFor(() => TmuxBackend.listBotmuxSessions().includes(TEST_SESSION), 5000);
    expect(TmuxBackend.listBotmuxSessions()).toContain(TEST_SESSION);

    backend.destroySession();
  }, TEST_TIMEOUT);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

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
