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

// ⚠️ `require` INSIDE the factory, not the factory's `importOriginal` argument:
// that argument is vitest-only (bun passes nothing, so awaiting it throws and the
// whole file dies). A top-level `import * as actual` does not work either —
// vitest hoists `vi.mock` above the imports, so the factory would read the
// namespace before initialisation. Resolving at factory-call time satisfies both
// runners; verified on each.
vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
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

  it('returns "unknown" when the deadline raced a clean exit (ETIMEDOUT + numeric status) — 2026-08-23 regression', () => {
    // Under heavy load the probe client can finish and exit cleanly in the
    // same window the exec deadline fires; Node attaches BOTH the numeric
    // status and the ETIMEDOUT error. A deadline is never an authoritative
    // server answer — reading this shape as 'missing' fed destructive
    // liveness/kill-verify counters during the 08-23 restart storm.
    bothThrow(
      { code: 'ETIMEDOUT', status: 1, signal: null, stderr: Buffer.from('') },
      { code: 'ETIMEDOUT', status: 1, signal: null, stderr: Buffer.from('') },
    );
    expect(TmuxBackend.probeSession(NAME)).toBe('unknown');
  });

  it('returns "unknown" on a clean CONNECTION-level failure (server stall ⇒ instant ECONNREFUSED), NOT "missing"', () => {
    // Linux fails unix-socket connect() with an instant clean ECONNREFUSED when
    // the shared server's accept backlog overflows — the client never reached
    // the server, so the clean exit-1 proves nothing about this session.
    // (2026-08-20: misreading this as 'missing' made kill-verify / liveness
    // consumers treat dozens of live sessions as gone simultaneously.)
    const stderr = Buffer.from('error connecting to /tmp/tmux-0/default (Connection refused)');
    bothThrow({ status: 1, signal: null, stderr }, { status: 1, signal: null, stderr });
    expect(TmuxBackend.probeSession(NAME)).toBe('unknown');
  });

  it('returns "unknown" when the connection died mid-command (lost server)', () => {
    const stderr = Buffer.from('lost server');
    bothThrow({ status: 1, signal: null, stderr }, { status: 1, signal: null, stderr });
    expect(TmuxBackend.probeSession(NAME)).toBe('unknown');
  });

  it('keeps "no server running" as authoritative "missing" (a down server provably has no sessions)', () => {
    const stderr = Buffer.from('no server running on /tmp/tmux-0/default');
    bothThrow({ status: 1, signal: null, stderr }, { status: 1, signal: null, stderr });
    expect(TmuxBackend.probeSession(NAME)).toBe('missing');
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
