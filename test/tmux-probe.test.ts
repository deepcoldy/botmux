/**
 * Unit tests for TmuxBackend.probeSession() — the tri-state existence probe
 * used by restore to decide re-attach ('exists') vs keep-for-lazy-cold-resume
 * ('missing'/'unknown').
 *
 * The hazard these pin: a probe FAILURE (tmux not on PATH, not executable,
 * hung) must classify as 'unknown', never 'exists' — so a flaky/unavailable
 * tmux can't be mistaken for a live pane and drive a bogus re-attach. A
 * shell-string `execSync` leaks the shell's own command-not-found /
 * not-executable exit codes (127 / 126) as clean numeric statuses, which a
 * naive "non-zero status ⇒ missing" rule would misread. Running the binary
 * directly via execFileSync keeps those failures as ENOENT/EACCES (no numeric
 * status) ⇒ 'unknown'.
 *
 * Both execSync and execFileSync are mocked per scenario so the test pins the
 * intended CLASSIFICATION regardless of which child_process API the impl uses.
 *
 * Run:  pnpm vitest run test/tmux-probe.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn(), execFileSync: vi.fn() };
});

import { execSync, execFileSync } from 'node:child_process';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';

const mockedExecSync = vi.mocked(execSync);
const mockedExecFileSync = vi.mocked(execFileSync);

const NAME = 'bmx-deadbeef';

function err(props: Record<string, unknown>): Error {
  return Object.assign(new Error('cmd failed'), props);
}

/** Drive BOTH child_process entry points with the same logical outcome, so the
 *  asserted classification holds whether the impl shells out (execSync) or runs
 *  the binary directly (execFileSync). */
function bothThrow(syncProps: Record<string, unknown>, fileProps: Record<string, unknown>) {
  mockedExecSync.mockImplementation((() => { throw err(syncProps); }) as any);
  mockedExecFileSync.mockImplementation((() => { throw err(fileProps); }) as any);
}

beforeEach(() => {
  mockedExecSync.mockReset();
  mockedExecFileSync.mockReset();
});

describe('TmuxBackend.probeSession', () => {
  it('returns "exists" when has-session succeeds (exit 0)', () => {
    mockedExecSync.mockImplementation((() => '') as any);
    mockedExecFileSync.mockImplementation((() => '') as any);
    expect(TmuxBackend.probeSession(NAME)).toBe('exists');
  });

  it('returns "missing" when the server answers and the session is absent (clean exit 1)', () => {
    bothThrow({ status: 1, signal: null }, { status: 1, signal: null });
    expect(TmuxBackend.probeSession(NAME)).toBe('missing');
  });

  it('returns "unknown" when tmux is not found (command-not-found / ENOENT), NOT "missing"', () => {
    // Shell path surfaces command-not-found as a *clean* exit 127; the direct
    // execFileSync path surfaces it as ENOENT (no numeric status).
    bothThrow({ status: 127, signal: null }, { code: 'ENOENT', status: null, signal: null });
    expect(TmuxBackend.probeSession(NAME)).toBe('unknown');
  });

  it('returns "unknown" when tmux is not executable (permission / EACCES), NOT "missing"', () => {
    bothThrow({ status: 126, signal: null }, { code: 'EACCES', status: null, signal: null });
    expect(TmuxBackend.probeSession(NAME)).toBe('unknown');
  });

  it('returns "unknown" on timeout (killed by signal)', () => {
    bothThrow({ signal: 'SIGTERM', status: null, killed: true }, { signal: 'SIGTERM', status: null, killed: true });
    expect(TmuxBackend.probeSession(NAME)).toBe('unknown');
  });

  it('hasSession() stays a conservative boolean wrapper (false on unknown)', () => {
    bothThrow({ status: 127, signal: null }, { code: 'ENOENT', status: null, signal: null });
    expect(TmuxBackend.hasSession(NAME)).toBe(false);
  });
});

describe('TmuxBackend.killSession', () => {
  it('bounds teardown against a wedged shared server', () => {
    mockedExecFileSync.mockImplementation((() => '') as any);
    TmuxBackend.killSession(NAME);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'tmux',
      ['kill-session', '-t', NAME],
      expect.objectContaining({ timeout: 3000 }),
    );
  });
});

/**
 * Regression: 2026-08-12. `has-session` is cheap (~20ms) but still needs a
 * fork+exec, so at load ~70 it was killed by its own timeout before tmux ran.
 * One such timeout was reported as a verdict, and the caller treated a live
 * session as gone — gating five healthy sessions with "本机 tmux 不可用".
 */
describe('TmuxBackend.probeSessionWithRetry', () => {
  it('retries a timeout and returns "exists" when a later attempt gets through', () => {
    let calls = 0;
    mockedExecFileSync.mockImplementation((() => {
      calls += 1;
      if (calls === 1) throw err({ signal: 'SIGTERM', status: null, killed: true });
      return '';
    }) as any);

    expect(TmuxBackend.probeSessionWithRetry(NAME, { baseDelayMs: 0 })).toBe('exists');
    expect(calls).toBe(2);
  });

  it('does NOT retry an authoritative answer — "missing" costs exactly one call', () => {
    // Retrying a clean exit 1 would add latency to the common cold-start path
    // and could mask a genuine absence, so authoritative answers return at once.
    let calls = 0;
    mockedExecFileSync.mockImplementation((() => {
      calls += 1;
      throw err({ status: 1, signal: null });
    }) as any);

    expect(TmuxBackend.probeSessionWithRetry(NAME, { baseDelayMs: 0 })).toBe('missing');
    expect(calls).toBe(1);
  });

  it('still reports "unknown" when every attempt times out (no false verdict)', () => {
    let calls = 0;
    mockedExecFileSync.mockImplementation((() => {
      calls += 1;
      throw err({ signal: 'SIGTERM', status: null, killed: true });
    }) as any);

    expect(TmuxBackend.probeSessionWithRetry(NAME, { attempts: 3, baseDelayMs: 0 })).toBe('unknown');
    expect(calls).toBe(3);
  });
});
