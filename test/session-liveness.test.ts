import { describe, expect, it } from 'vitest';
import { isSessionStopped } from '../src/core/session-liveness.js';
import type { Session } from '../src/types.js';

// Minimal Session stub — isSessionStopped reads pid / adoptedFrom / cliId /
// lastCliInput / suspendedColdResume. A real managed session always carries a
// frozen `cliId` (stamped at spawn for every backend, incl. riff/zmx), so the
// default stub includes one; scratch-row cases clear it explicitly.
function session(over: Partial<Session>): Session {
  return { sessionId: '0123456789abcdef', status: 'active', cliId: 'claude-code', ...over } as Session;
}

describe('isSessionStopped — real managed sessions are dormant, not zombies', () => {
  it('treats a cold-resume-suspended session (no pid, backing destroyed) as NOT stopped', () => {
    // botmux cap-suspend clears the pid AND destroys the backing CLI/tmux to
    // reclaim memory. It must cold-resume on the next message, never be swept.
    expect(isSessionStopped(session({ suspendedColdResume: true, pid: undefined }))).toBe(false);
  });

  it('treats a real managed session with a dead pid as NOT stopped (dormant, transcript-backed)', () => {
    // The core of the host-reboot fix: no live pid + no marker, but it DID run a
    // CLI (cliId frozen), so its transcript on disk cold-resumes on the next
    // message (resume→fresh fallback if the transcript is gone). Not a zombie.
    expect(isSessionStopped(session({ suspendedColdResume: undefined, pid: undefined }))).toBe(false);
  });

  it('treats a never-started scratch row (no cliId/lastCliInput/adopt, dead pid) as stopped', () => {
    // A row that never became a real CLI session (unconfirmed /adopt picker,
    // /help, abandoned /relay picker) is a disposable scratch — safe to close.
    expect(isSessionStopped(session({ cliId: undefined, pid: undefined }))).toBe(true);
    expect(isSessionStopped(session({ cliId: undefined, lastCliInput: 'x', pid: undefined }))).toBe(false);
  });

  it.each([
    ['exists'],
    ['unknown'],
    ['missing'],
  ] as const)('never sweeps a workerless real Herdr row regardless of a %s backing probe', (_probe) => {
    // A missing backing pane is no longer a close trigger for any backend: the
    // whole-server-vs-solo-pane ambiguity (defeated by the shared tmux socket)
    // is gone from the decision. A real Herdr row with a dead pid is dormant.
    expect(isSessionStopped(session({
      backendType: 'herdr',
      persistentBackendTarget: {
        backendType: 'herdr',
        sessionName: 'botmux',
        agentName: 'botmux-01234567',
      },
      pid: undefined,
    }))).toBe(false);
  });

  it('keeps a workerless real ZMX row recoverable (no backing probe needed)', () => {
    expect(isSessionStopped(session({
      backendType: 'zmx',
      persistentBackendTarget: { backendType: 'zmx', sessionName: 'bmx-01234567' },
      pid: undefined,
    }))).toBe(false);
  });

  it('keeps a workerless real tmux row recoverable after its pane vanished (host reboot)', () => {
    expect(isSessionStopped(session({ backendType: 'tmux', pid: undefined }))).toBe(false);
  });

  it('keeps a real pty row (no persistent backend) recoverable when its pid is dead', () => {
    // pty was previously the ONLY backend the sweep unconditionally called
    // stopped. Under the unified invariant a real pty session with a transcript
    // cold-resumes exactly like the others — never a dead end.
    expect(isSessionStopped(session({ backendType: 'pty', pid: undefined }))).toBe(false);
  });

  it('keeps a legacy (undefined backend) real row recoverable — cannot prove it was ever tmux', () => {
    expect(isSessionStopped(session({ backendType: undefined, pid: undefined }))).toBe(false);
  });

  it('does not call a remote Riff task stopped just because no local process exists', () => {
    expect(isSessionStopped(session({ backendType: 'riff', pid: undefined }))).toBe(false);
  });

  it('reports an adopted session with a dead external pid as stopped (external pid authoritative)', () => {
    // Adopt wraps a foreign CLI we never spawned and hold no transcript for, so
    // its own pid — not a botmux transcript — decides. Dead external pid = stop.
    expect(isSessionStopped(session({
      cliId: undefined,
      adoptedFrom: { source: 'tmux', originalCliPid: 999999 } as any,
      pid: undefined,
    }))).toBe(true);
  });

  it('keeps an adopted session alive while its external pid is still running', () => {
    expect(isSessionStopped(session({
      cliId: undefined,
      adoptedFrom: { source: 'tmux', originalCliPid: process.pid } as any,
      pid: undefined,
    }))).toBe(false);
  });
});
