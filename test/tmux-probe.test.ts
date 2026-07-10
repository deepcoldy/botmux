/**
 * Unit tests for TmuxBackend.probeSession() — the tri-state existence probe
 * used by restore's zombie-close decision.
 *
 * The hazard these pin: a probe FAILURE (tmux not on PATH, not executable,
 * hung) must classify as 'unknown', never 'missing' — because restore turns
 * 'missing' into a destructive closeSession(). A shell-string `execSync` leaks
 * the shell's own command-not-found / not-executable exit codes (127 / 126) as
 * clean numeric statuses, which a naive "non-zero status ⇒ missing" rule would
 * misread as "session gone". Running the binary directly via execFileSync keeps
 * those failures as ENOENT/EACCES (no numeric status) ⇒ 'unknown'.
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

describe('TmuxBackend.serverState', () => {
  it('returns "running" when list-sessions succeeds (exit 0 ⇒ server up with ≥1 session)', () => {
    mockedExecFileSync.mockImplementation((() => '') as any);
    expect(TmuxBackend.serverState()).toBe('running');
  });

  it('returns "down" on clean non-zero exit ("no server running")', () => {
    // This is the host-reboot signal: the whole tmux server is gone.
    mockedExecFileSync.mockImplementation((() => { throw err({ status: 1, signal: null }); }) as any);
    expect(TmuxBackend.serverState()).toBe('down');
  });

  it('returns "unknown" when tmux is not found (ENOENT), NOT "down"', () => {
    mockedExecFileSync.mockImplementation((() => { throw err({ code: 'ENOENT', status: null, signal: null }); }) as any);
    expect(TmuxBackend.serverState()).toBe('unknown');
  });

  it('returns "unknown" on timeout (killed by signal), NOT "down"', () => {
    mockedExecFileSync.mockImplementation((() => { throw err({ signal: 'SIGTERM', status: null, killed: true }); }) as any);
    expect(TmuxBackend.serverState()).toBe('unknown');
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
