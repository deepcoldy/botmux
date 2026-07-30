import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSessionStopped } from '../src/core/session-liveness.js';
import type { Session } from '../src/types.js';

const persistentProbe = vi.hoisted(() => vi.fn());

vi.mock('../src/core/persistent-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/persistent-backend.js')>();
  return {
    ...actual,
    probePersistentBackendTarget: persistentProbe,
  };
});

// Minimal Session stub — isSessionStopped only reads pid / adoptedFrom /
// sessionId / backend metadata / suspendedColdResume.
function session(over: Partial<Session>): Session {
  return { sessionId: '0123456789abcdef', status: 'active', ...over } as Session;
}

describe('isSessionStopped — botmux-suspended sessions are not zombies', () => {
  beforeEach(() => {
    persistentProbe.mockReset();
  });

  it('treats a cold-resume-suspended session (no pid, tmux destroyed) as NOT stopped', () => {
    // This is the data-loss guard: botmux cap-suspend clears the pid AND
    // destroys the backing CLI/tmux, so the generic zombie heuristic would
    // classify it as stopped and let the "清僵尸" sweep permanently close a
    // session that should cold-resume on the next message. The persisted
    // marker must beat the heuristic (mirrors the CLI list prune guard).
    expect(isSessionStopped(session({ suspendedColdResume: true, pid: undefined }))).toBe(false);
  });

  it('still reports a real zombie (dead pid, no marker) as stopped', () => {
    // pid 1 is init — alive but not ours; use an unused-high pid that is dead.
    // No suspendedColdResume marker → falls through to the pid/tmux heuristic.
    // With no pid and no bmx-* tmux pane, it is a stopped zombie.
    expect(isSessionStopped(session({ suspendedColdResume: undefined, pid: undefined }))).toBe(true);
  });

  it.each([
    {
      label: 'shared Herdr agent',
      backendType: 'herdr' as const,
      persistentBackendTarget: {
        backendType: 'herdr' as const,
        sessionName: 'botmux',
        agentName: 'botmux-01234567',
      },
    },
    {
      label: 'managed ZMX session',
      backendType: 'zmx' as const,
      persistentBackendTarget: {
        backendType: 'zmx' as const,
        sessionName: 'bmx-01234567',
      },
    },
  ])('keeps a workerless live $label out of destructive zombie cleanup', ({
    backendType,
    persistentBackendTarget,
  }) => {
    persistentProbe.mockReturnValueOnce('exists');

    expect(isSessionStopped(session({
      backendType,
      persistentBackendTarget,
      pid: undefined,
    }))).toBe(false);
    expect(persistentProbe).toHaveBeenCalledWith(persistentBackendTarget);
  });

  it.each([
    ['unknown', false],
    ['missing', true],
  ] as const)('treats a persistent-target %s probe as stopped=%s', (probe, stopped) => {
    persistentProbe.mockReturnValueOnce(probe);
    expect(isSessionStopped(session({
      backendType: 'zmx',
      persistentBackendTarget: {
        backendType: 'zmx',
        sessionName: 'bmx-01234567',
      },
      pid: undefined,
    }))).toBe(stopped);
  });

  it('does not call a remote Riff task stopped just because no local tmux pane exists', () => {
    expect(isSessionStopped(session({ backendType: 'riff', pid: undefined }))).toBe(false);
  });
});
