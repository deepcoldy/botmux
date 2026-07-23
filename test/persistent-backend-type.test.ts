/**
 * getSessionPersistentBackendType precedence + the PTY退役 legacy-safety fix.
 *
 * Regression target (Codex P1 on PR #289): after the default backend flipped to
 * always-tmux, a session created under the OLD probe-based default (implicit PTY
 * on a tmux-less host) — with no per-session backendType stamped and a bot that
 * pins no backend — must NOT be re-derived as tmux. Otherwise restore probes for
 * a `bmx-<sid>` pane that never existed and zombie-closes a recoverable session.
 *
 * Run:  pnpm vitest run test/persistent-backend-type.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable per-test bot backend config the mocked getBot returns.
const bot = vi.hoisted(() => ({ backendType: undefined as string | undefined }));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: { backendType: bot.backendType } })),
}));

import {
  getSessionPersistentBackendType,
  killPersistentBackendTarget,
  managedTargetsForCliChange,
  probePersistentBackendTarget,
  resolvePersistentBackendTarget,
  resolvePairedSpawnBackendType,
  resolveSpawnBackendType,
  shutdownBackendDisposition,
} from '../src/core/persistent-backend.js';
import { HerdrBackend } from '../src/adapters/backend/herdr-backend.js';

function ds(opts: { initBackend?: string; sessionBackend?: string }): any {
  return {
    larkAppId: 'app1',
    initConfig: opts.initBackend ? { backendType: opts.initBackend } : undefined,
    session: { sessionId: 'abcdef12', backendType: opts.sessionBackend },
  };
}

describe('getSessionPersistentBackendType', () => {
  beforeEach(() => { bot.backendType = undefined; });

  it('prefers the live worker initConfig backend', () => {
    expect(getSessionPersistentBackendType(ds({ initBackend: 'tmux', sessionBackend: 'zellij' }))).toBe('tmux');
  });

  it('falls back to the backend stamped on the persisted session', () => {
    expect(getSessionPersistentBackendType(ds({ sessionBackend: 'zellij' }))).toBe('zellij');
  });

  it('uses an explicit per-bot backend when the session has none stamped', () => {
    bot.backendType = 'herdr';
    expect(getSessionPersistentBackendType(ds({}))).toBe('herdr');
  });

  it('LEGACY SAFETY: unstamped session + bot pins no backend → undefined (not tmux), so restore keeps it for lazy resume instead of zombie-closing', () => {
    bot.backendType = undefined;
    expect(getSessionPersistentBackendType(ds({}))).toBeUndefined();
  });

  it('a stamped pty session is not a persistent backend', () => {
    expect(getSessionPersistentBackendType(ds({ sessionBackend: 'pty' }))).toBeUndefined();
    expect(getSessionPersistentBackendType(ds({ initBackend: 'pty' }))).toBeUndefined();
  });
});

describe('shared Herdr persistent target', () => {
  it('preserves a recorded host session + agent and rejects a mismatched stale stamp', () => {
    const shared = {
      backendType: 'herdr' as const,
      sessionName: 'work',
      agentName: 'botmux-abcdef12',
    };
    expect(resolvePersistentBackendTarget('herdr', 'abcdef123456', shared)).toEqual(shared);
    expect(resolvePersistentBackendTarget('tmux', 'abcdef123456', shared)).toEqual({
      backendType: 'tmux',
      sessionName: 'bmx-abcdef12',
    });
  });

  it('returns exact shared agents for CLI-change cleanup and excludes adopted panes', () => {
    const targets = managedTargetsForCliChange('herdr', [
      {
        sessionId: 'abcdef123456',
        persistentBackendTarget: {
          backendType: 'herdr',
          sessionName: 'botmux',
          agentName: 'botmux-abcdef12',
        },
      },
      {
        sessionId: 'user-pane',
        adoptedFrom: { source: 'herdr', herdrSessionName: 'collie', herdrPaneId: 'w3:p1' },
      },
    ] as any);

    expect(targets).toEqual([{
      backendType: 'herdr',
      sessionName: 'botmux',
      agentName: 'botmux-abcdef12',
    }]);
  });

  it('probes and kills only the recorded agent rather than the host session', () => {
    const target = {
      backendType: 'herdr' as const,
      sessionName: 'work',
      agentName: 'botmux-abcdef12',
    };
    const probeAgent = vi.spyOn(HerdrBackend, 'probeAgent').mockReturnValue('exists');
    const killAgent = vi.spyOn(HerdrBackend, 'killAgent').mockImplementation(() => {});
    const killSession = vi.spyOn(HerdrBackend, 'killSession').mockImplementation(() => {});

    expect(probePersistentBackendTarget(target)).toBe('exists');
    killPersistentBackendTarget(target);

    expect(probeAgent).toHaveBeenCalledWith('work', 'botmux-abcdef12');
    expect(killAgent).toHaveBeenCalledWith('work', 'botmux-abcdef12');
    expect(killSession).not.toHaveBeenCalled();
    probeAgent.mockRestore();
    killAgent.mockRestore();
    killSession.mockRestore();
  });
});

// ── Freeze-once (PR #397) — cover the ACTUAL call sites, not just the helper.
// These test the two tiny functions production now calls (worker-pool forkWorker
// via resolveSpawnBackendType, daemon shutdown via shutdownBackendDisposition), so
// reverting either call site to live config turns them RED — the helper-only tests
// stayed green on the buggy code (Codex #397 delta review).
describe('resolveSpawnBackendType (forkWorker freeze-once)', () => {
  it('an existing session keeps its spawn-time stamp even when the bot backend was switched since', () => {
    expect(resolveSpawnBackendType('herdr', 'tmux', 'tmux')).toBe('herdr'); // stamped herdr, bot now tmux
    expect(resolveSpawnBackendType('pty', 'herdr', 'tmux')).toBe('pty');    // stamped pty, bot now herdr
  });
  it('a brand-new session (no stamp) resolves from live bot config, then the daemon default', () => {
    expect(resolveSpawnBackendType(undefined, 'herdr', 'tmux')).toBe('herdr');
    expect(resolveSpawnBackendType(undefined, undefined, 'tmux')).toBe('tmux');
  });
});

describe('resolvePairedSpawnBackendType (Riff pairing at every spawn decision)', () => {
  it('falls back from a stale riff backend for non-Riff CLIs', () => {
    expect(resolvePairedSpawnBackendType('codex-app', undefined, 'riff', 'tmux')).toBe('tmux');
    expect(resolvePairedSpawnBackendType('codex-app', 'riff', undefined, 'pty')).toBe('pty');
  });

  it('forces the Riff backend for a Riff CLI even when config or a session stamp is local', () => {
    expect(resolvePairedSpawnBackendType('riff', undefined, 'pty', 'tmux')).toBe('riff');
    expect(resolvePairedSpawnBackendType('riff', 'tmux', undefined, 'pty')).toBe('riff');
  });
});

describe('shutdownBackendDisposition (shutdown freeze-once)', () => {
  beforeEach(() => { bot.backendType = undefined; });
  it('detaches on a frozen persistent backend even when the live bot backend is now non-persistent (frozen must win, else this would wrongly close)', () => {
    bot.backendType = 'pty'; // operator switched the bot to a non-persistent backend post-spawn
    expect(shutdownBackendDisposition(ds({ sessionBackend: 'herdr' }))).toBe('detach');
  });
  it('closes a frozen pty session even after the bot flips to herdr (never detaches a pane it never had)', () => {
    bot.backendType = 'herdr';
    expect(shutdownBackendDisposition(ds({ sessionBackend: 'pty' }))).toBe('close');
  });
});
