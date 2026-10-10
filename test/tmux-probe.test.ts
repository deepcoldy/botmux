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

  it('keeps a missing socket file ("No such file or directory") as "unknown" — the general probe never upgrades it', () => {
    // The cold-machine tie-break lives ONLY in the read-isolation gate
    // (serverAbsentOnColdMachine + resolveReadIsolationPaneProbe); kill-verify /
    // close / wake consumers of probeSession must keep #962's semantics.
    const stderr = Buffer.from('error connecting to /private/tmp/tmux-501/default (No such file or directory)');
    mockedExecSync.mockImplementation((() => { throw err({ status: 1, signal: null, stderr }); }) as any);
    mockedExecFileSync.mockImplementation(((cmd: string) => {
      if (cmd === 'ps') return '';
      throw err({ status: 1, signal: null, stderr });
    }) as any);
    expect(TmuxBackend.probeSession(NAME)).toBe('unknown');
    expect(mockedExecFileSync.mock.calls.map(c => c[0])).not.toContain('ps');
  });

  it('hasSession() stays a conservative boolean wrapper (false on unknown)', () => {
    bothThrow({ status: 127, signal: null }, { code: 'ENOENT', status: null, signal: null });
    expect(TmuxBackend.hasSession(NAME)).toBe(false);
  });
});

describe('TmuxBackend.serverAbsentOnColdMachine (read-isolation cold-machine check)', () => {
  // A reboot wipes /tmp, so before anything has started a server every probe
  // reads the socket-missing connect error. 2026-10-02: every read-isolated bot
  // of a machine was refused until an unsandboxed bot happened to spawn first.
  const UID = typeof process.getuid === 'function' ? process.getuid() : 501;
  const OTHER = UID + 100000;
  const enoent = Buffer.from('error connecting to /private/tmp/tmux-501/default (No such file or directory)');

  function drive(
    tmux: Record<string, unknown> | 'ok',
    ps: (() => string) | { throws: Record<string, unknown> },
  ): { result: boolean; calls: string[] } {
    const calls: string[] = [];
    mockedExecFileSync.mockImplementation(((cmd: string) => {
      calls.push(cmd);
      if (cmd === 'tmux') {
        if (tmux === 'ok') return '';
        throw err(tmux);
      }
      if (cmd === 'ps') {
        if (typeof ps === 'function') return ps();
        throw err(ps.throws);
      }
      throw new Error(`unexpected command ${cmd}`);
    }) as any);
    return { result: TmuxBackend.serverAbsentOnColdMachine(), calls };
  }
  const socketMissing = { status: 1, signal: null, stderr: enoent };
  const noTmuxPs = () => [`    0 /sbin/launchd`, `${UID} /opt/homebrew/bin/node`, `${OTHER} /opt/homebrew/bin/tmux`].join('\n');

  it('is true when the socket file is missing AND no tmux process of this user is visible', () => {
    const r = drive(socketMissing, noTmuxPs);
    expect(r.result).toBe(true);
    expect(r.calls).toEqual(['tmux', 'ps']);
  });

  it('is false when a tmux process of this user is visible (socket may have been cleaned under a live server)', () => {
    expect(drive(socketMissing, () => `${UID} /opt/homebrew/bin/node\n${UID} /opt/homebrew/bin/tmux\n`).result).toBe(false);
  });

  it('is false when the tmux process belongs to the EFFECTIVE uid (setuid launcher)', () => {
    if (typeof process.geteuid !== 'function') return;
    const spy = vi.spyOn(process, 'geteuid').mockReturnValue(OTHER);
    try {
      expect(drive(socketMissing, noTmuxPs).result).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('is false for a Linux-renamed server thread ("tmux: server")', () => {
    expect(drive(socketMissing, () => `${UID} bash\n${UID} tmux: server\n`).result).toBe(false);
  });

  it('is false when ps fails, times out, or prints nothing parseable', () => {
    expect(drive(socketMissing, { throws: { code: 'ENOENT', status: null, signal: null } }).result).toBe(false);
    expect(drive(socketMissing, { throws: { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' } }).result).toBe(false);
    expect(drive(socketMissing, () => '').result).toBe(false);
    expect(drive(socketMissing, () => 'garbage without uid columns\n').result).toBe(false);
  });

  it('never consults ps unless tmux reported a missing socket file', () => {
    for (const tmux of [
      'ok' as const,
      { status: 1, signal: null, stderr: Buffer.from('no server running on /tmp/tmux-0/default') },
      { status: 1, signal: null, stderr: Buffer.from('error connecting to /tmp/tmux-0/default (Connection refused)') },
      { status: 1, signal: null, stderr: Buffer.from('lost server') },
      { code: 'ETIMEDOUT', status: 1, signal: null, stderr: enoent },
      { signal: 'SIGTERM', status: null, killed: true, stderr: enoent },
      { code: 'ENOENT', status: null, signal: null },
    ]) {
      const r = drive(tmux, noTmuxPs);
      expect(r.result).toBe(false);
      expect(r.calls).toEqual(['tmux']);
    }
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

describe('TmuxBackend.sessionChildPid', () => {
  it('returns the pane pid when tmux reports a numeric child pid', () => {
    mockedExecFileSync.mockImplementation((() => Buffer.from('12345\n')) as any);

    expect(TmuxBackend.sessionChildPid(NAME)).toBe(12345);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'tmux',
      ['display-message', '-p', '-t', NAME, '#{pane_pid}'],
      expect.objectContaining({
        encoding: 'utf8',
        timeout: 3000,
      }),
    );
  });

  it('returns null when the pane pid is absent, malformed, or unqueryable', () => {
    mockedExecFileSync.mockImplementationOnce((() => Buffer.from('not-a-pid\n')) as any);
    expect(TmuxBackend.sessionChildPid(NAME)).toBeNull();

    mockedExecFileSync.mockImplementationOnce((() => Buffer.from('0\n')) as any);
    expect(TmuxBackend.sessionChildPid(NAME)).toBeNull();

    mockedExecFileSync.mockImplementationOnce((() => { throw new Error('tmux unavailable'); }) as any);
    expect(TmuxBackend.sessionChildPid(NAME)).toBeNull();
  });
});
