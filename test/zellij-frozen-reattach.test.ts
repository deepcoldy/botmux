/**
 * Regression for PR #836 (F1 follow-up): a caller that has already frozen the
 * reattach-vs-fresh decision (the worker's tri-state probe, reset to 'missing'
 * after any teardown gate) must have that decision honoured VERBATIM by
 * ZellijBackend.spawn(). The pre-existing `this.reattaching ||= hasSession()`
 * self-heal would otherwise re-run the same load-fragile `list-sessions` and,
 * on a post-kill session that has not fully died yet, flip a frozen `false`
 * back to attach — reattaching to the very pane the gate just removed.
 *
 * Run:  pnpm vitest run test/zellij-frozen-reattach.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process so ZellijBackend.hasSession()/probeSession() are
// controllable: a 'true'-looking list-sessions output simulates the not-yet-
// reaped session a live re-probe would still see.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pid: 4242,
  })),
}));

import { execFileSync } from 'node:child_process';
import * as pty from 'node-pty';
import { ZellijBackend } from '../src/adapters/backend/zellij-backend.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedPtySpawn = vi.mocked(pty.spawn);

const SESSION = 'bmx-frozen01';
const spawnOpts = { cwd: '/tmp', cols: 80, rows: 24, env: { PATH: '/usr/bin' } };

// Make list-sessions report the session as LIVE — i.e. hasSession() === true.
function listSessionsReportsLive() {
  mockedExecFileSync.mockReturnValue(`${SESSION} [Created 1s ago] \n` as unknown as Buffer);
}

describe('ZellijBackend frozen reattach decision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSessionsReportsLive();
  });

  it('honours a frozen isReattach:false even when a live re-probe would say the session exists', () => {
    // This is the teardown case: the gate killed the pane and froze the
    // decision to fresh, but the session lingers in list-sessions.
    const be = new ZellijBackend(SESSION, { ownsSession: true, isReattach: false, reattachDecision: 'frozen' });
    be.spawn('claude', [], spawnOpts);

    expect(be.isReattach).toBe(false);
    // The self-heal probe must NOT have run.
    expect(mockedExecFileSync).not.toHaveBeenCalled();
    // And the spawn must be a FRESH session (--new-session-with-layout), not an
    // attach to the pane the teardown removed.
    const args = mockedPtySpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--new-session-with-layout');
    expect(args).not.toContain('attach');
  });

  it('honours a frozen isReattach:true when the session is live', () => {
    const be = new ZellijBackend(SESSION, { ownsSession: true, isReattach: true, reattachDecision: 'frozen' });
    be.spawn('claude', [], spawnOpts);

    expect(be.isReattach).toBe(true);
    const args = mockedPtySpawn.mock.calls[0][1] as string[];
    expect(args).toContain('attach');
    expect(args).not.toContain('--new-session-with-layout');
  });

  it('still self-heals in auto mode (default) — a live session flips isReattach true', () => {
    // Default callers (no frozen decision) keep the PR#249 self-heal: a daemon
    // restart that left the CLI running must reattach.
    const be = new ZellijBackend(SESSION, { ownsSession: true, isReattach: false });
    be.spawn('claude', [], spawnOpts);

    expect(be.isReattach).toBe(true);
    // The self-heal probe DID run (list-sessions).
    expect(mockedExecFileSync).toHaveBeenCalled();
    const args = mockedPtySpawn.mock.calls[0][1] as string[];
    expect(args).toContain('attach');
  });

  it('auto mode with a genuinely missing session stays fresh', () => {
    mockedExecFileSync.mockReturnValue('' as unknown as Buffer); // no live sessions
    const be = new ZellijBackend(SESSION, { ownsSession: true, isReattach: false });
    be.spawn('claude', [], spawnOpts);

    expect(be.isReattach).toBe(false);
    const args = mockedPtySpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--new-session-with-layout');
  });

  /**
   * The reattach bias is a BET, not a fact: the worker reattaches on an
   * indeterminate existence probe because a live pane is likelier than a gone
   * one under load. When the session turns out to be provably absent, `attach`
   * exits 1 ("No session with the name … found!"), which reads as a CLI crash
   * and burns a restart — so a frozen `attach` must downgrade to a fresh spawn
   * on an AUTHORITATIVE 'missing'.
   */
  it('downgrades a frozen reattach to a fresh spawn when the session is provably absent', () => {
    mockedExecFileSync.mockReturnValue('' as unknown as Buffer); // authoritative: no live sessions
    const be = new ZellijBackend(SESSION, { ownsSession: true, isReattach: true, reattachDecision: 'frozen' });
    be.spawn('claude', [], spawnOpts);

    expect(be.isReattach).toBe(false);
    const args = mockedPtySpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--new-session-with-layout');
    expect(args).not.toContain('attach');
  });

  it('keeps a frozen reattach when the probe is INDETERMINATE (bias preserved)', () => {
    // list-sessions failing (timeout/spawn error) is 'unknown', not 'missing' —
    // the bias must survive it, otherwise the whole point of the fix is lost.
    mockedExecFileSync.mockImplementation((() => { throw new Error('ETIMEDOUT'); }) as any);
    const be = new ZellijBackend(SESSION, { ownsSession: true, isReattach: true, reattachDecision: 'frozen' });
    be.spawn('claude', [], spawnOpts);

    expect(be.isReattach).toBe(true);
    const args = mockedPtySpawn.mock.calls[0][1] as string[];
    expect(args).toContain('attach');
  });

  it('NEVER flips a frozen fresh decision into an attach, even if the session looks live', () => {
    // The teardown guarantee: the downgrade above is one-directional. A gate that
    // killed the pane froze `false`; a lingering not-yet-reaped session must not
    // resurrect the reattach.
    listSessionsReportsLive();
    const be = new ZellijBackend(SESSION, { ownsSession: true, isReattach: false, reattachDecision: 'frozen' });
    be.spawn('claude', [], spawnOpts);

    expect(be.isReattach).toBe(false);
    const args = mockedPtySpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--new-session-with-layout');
    expect(args).not.toContain('attach');
  });
});

/**
 * Root-cause regression (found in review of the rebased head): zellij exits **1**
 * with stderr `No active zellij sessions found.` when there are simply no
 * sessions. The original bare `catch` reported that authoritative "zero" as
 * {ok:false} → `probeSession() === 'unknown'`, so on a CLEAN HOST (the normal
 * first-start path) the gate granted its indeterminate-probe exemption and the
 * frozen decision became `attach` — against a name that does not exist, which
 * exits 1 every time. Verified against real zellij 0.44.1.
 */
describe('ZellijBackend.probeLiveSessions exit-code classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function failWith(props: Record<string, unknown>) {
    mockedExecFileSync.mockImplementation((() => {
      throw Object.assign(new Error('Command failed'), props);
    }) as any);
  }

  it('treats the documented "no active sessions" exit 1 as an authoritative EMPTY list', () => {
    failWith({ status: 1, stderr: Buffer.from('No active zellij sessions found.\n') });

    expect(ZellijBackend.probeLiveSessions()).toEqual({ ok: true, sessions: [] });
    // The decisive consequence: a clean host reports 'missing', NOT 'unknown'.
    expect(ZellijBackend.probeSession('bmx-anything')).toBe('missing');
  });

  it('degrades to unknown (not missing) if zellij ever reworded the no-sessions line', () => {
    // Deliberate trade-off: emptiness requires zellij's explicit answer, so an
    // unrecognised message fails SAFE (unknown → keep the reattach bias) rather
    // than asserting "gone" from a silent non-zero exit. The message is
    // hardcoded upstream at our 0.44.0 floor, so this is a future-proofing
    // direction choice, not a live regression.
    failWith({ status: 1, stderr: Buffer.from('没有活动的 zellij 会话\n') });

    expect(ZellijBackend.probeLiveSessions()).toEqual({ ok: false });
    expect(ZellijBackend.probeSession('bmx-anything')).toBe('unknown');
  });

  it('treats a DEADLINE that raced a clean exit as unknown (ETIMEDOUT + numeric status, no signal)', () => {
    // Minimal counter-example from review: Node's timeout can fire while the
    // child is exiting, so the error carries ETIMEDOUT *and* a clean status=1
    // with empty output — indistinguishable from "no sessions" by status alone.
    // Reading it as 'missing' would turn the exact high-load timeout this PR
    // exists to tolerate back into an authoritative "gone", and would let the
    // strict post-kill path treat an unconfirmed kill as proven termination.
    // Mirrors TmuxBackend.probeSession, which checks the deadline FIRST.
    failWith({
      code: 'ETIMEDOUT', status: 1, signal: null,
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
    });

    expect(ZellijBackend.probeLiveSessions()).toEqual({ ok: false });
    expect(ZellijBackend.probeSession('bmx-anything')).toBe('unknown');
  });

  it('lets the DEADLINE win even when the no-sessions line is also present', () => {
    // This is the case that actually isolates the deadline check: with empty
    // stderr an ETIMEDOUT would return unknown anyway (via the "needs an
    // explicit answer" path), so removing the deadline guard would go unnoticed.
    // Here zellij's real message IS present, so only checking the deadline first
    // keeps it indeterminate — otherwise a timed-out probe that happened to race
    // an empty listing becomes an authoritative "gone".
    failWith({
      code: 'ETIMEDOUT', status: 1, signal: null,
      stdout: Buffer.alloc(0), stderr: Buffer.from('No active zellij sessions found.\n'),
    });

    expect(ZellijBackend.probeLiveSessions()).toEqual({ ok: false });
    expect(ZellijBackend.probeSession('bmx-anything')).toBe('unknown');
  });

  it('does not call a SILENT non-zero exit empty (needs zellij\'s explicit answer)', () => {
    // A quiet exit 1 with no stderr proves nothing about liveness.
    failWith({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });

    expect(ZellijBackend.probeLiveSessions()).toEqual({ ok: false });
    expect(ZellijBackend.probeSession('bmx-anything')).toBe('unknown');
  });

  it('does NOT treat a usage error (clap exit 2) as emptiness even with empty stderr', () => {
    // Real zellij 0.44.1 exits 2 for a bogus flag/subcommand. Such an answer
    // proves nothing about liveness, so it must stay indeterminate — and an
    // empty stderr must not sneak it through as "no sessions".
    failWith({ status: 2, stdout: Buffer.from(''), stderr: Buffer.from('') });

    expect(ZellijBackend.probeLiveSessions()).toEqual({ ok: false });
    expect(ZellijBackend.probeSession('bmx-anything')).toBe('unknown');
  });

  it('still honours live rows printed alongside a non-zero exit 1', () => {
    // Defensive: if a future zellij lists sessions AND exits 1, the live rows
    // are authoritative — do not report a live pane as gone.
    failWith({ status: 1, stdout: Buffer.from('bmx-live [Created 1s ago] \n'), stderr: Buffer.from('') });

    expect(ZellijBackend.probeLiveSessions()).toEqual({ ok: true, sessions: ['bmx-live'] });
    expect(ZellijBackend.probeSession('bmx-live')).toBe('exists');
  });

  it('treats a spawn failure (binary absent → no numeric status) as unknown', () => {
    failWith({ code: 'ENOENT', status: undefined, signal: undefined });

    expect(ZellijBackend.probeLiveSessions()).toEqual({ ok: false });
    expect(ZellijBackend.probeSession('bmx-anything')).toBe('unknown');
  });

  it('treats a timeout (killed by signal) as unknown', () => {
    failWith({ code: 'ETIMEDOUT', signal: 'SIGTERM', status: undefined });

    expect(ZellijBackend.probeLiveSessions()).toEqual({ ok: false });
    expect(ZellijBackend.probeSession('bmx-anything')).toBe('unknown');
  });

  it('does NOT read some other answered failure as emptiness', () => {
    // A different non-zero exit (bad flag, corrupt cache) is not proof that
    // zero sessions exist, so it must not become an authoritative 'missing'.
    failWith({ status: 2, stderr: Buffer.from('error: unexpected argument\n') });

    expect(ZellijBackend.probeLiveSessions()).toEqual({ ok: false });
    expect(ZellijBackend.probeSession('bmx-anything')).toBe('unknown');
  });

  it('still filters EXITED corpses out of a successful listing', () => {
    mockedExecFileSync.mockReturnValue(
      'bmx-live [Created 1s ago] \nbmx-dead [Created 2d ago] (EXITED - attach to resurrect)\n' as unknown as Buffer,
    );

    expect(ZellijBackend.probeLiveSessions()).toEqual({ ok: true, sessions: ['bmx-live'] });
    expect(ZellijBackend.probeSession('bmx-dead')).toBe('missing');
    expect(ZellijBackend.probeSession('bmx-live')).toBe('exists');
  });
});
