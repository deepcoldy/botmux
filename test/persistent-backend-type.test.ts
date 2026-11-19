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

import { ZmxBackend } from '../src/adapters/backend/zmx-backend.js';
import {
  getSessionPersistentBackendType,
  isRiffBackendSession,
  killPersistentBackendTarget,
  probePersistentBackendTarget,
  probePersistentBackendTargetAfterKill,
  killPersistentSession,
  probePersistentSessions,
  probePersistentBackendTargets,
  persistentBackendTargetKey,
  resolvePersistentBackendTarget,
  resolvePairedSpawnBackendType,
  resolveSpawnBackendType,
  shouldRejectPersistentPostKillProbe,
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

  it('keeps the running persistent backend authoritative after bot config hot-switches to PTY', () => {
    bot.backendType = 'pty';
    expect(getSessionPersistentBackendType(ds({ initBackend: 'zmx', sessionBackend: 'zmx' }))).toBe('zmx');
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

  it('allows an agent-less deterministic Herdr host only with its complete owner id', () => {
    const sessionId = 'abcdef123456';
    const resolved = resolvePersistentBackendTarget('herdr', sessionId, undefined);
    expect(resolved).toEqual({
      backendType: 'herdr',
      sessionName: 'bmx-abcdef12',
      sessionId,
    });
    const killAgent = vi.spyOn(HerdrBackend, 'killAgent').mockImplementation(() => {});
    const killSession = vi.spyOn(HerdrBackend, 'killSession').mockImplementation(() => {});
    const probeSession = vi.spyOn(HerdrBackend, 'probeSession').mockReturnValue('exists');
    const probeAgent = vi.spyOn(HerdrBackend, 'probeAgent').mockReturnValue('exists');
    expect(probePersistentBackendTarget(resolved)).toBe('exists');
    const batch = probePersistentBackendTargets([resolved]);
    expect(batch.get(persistentBackendTargetKey(resolved))).toBe('exists');
    killPersistentBackendTarget(resolved, sessionId);

    expect(probeSession).toHaveBeenCalledTimes(2);
    expect(probeSession).toHaveBeenNthCalledWith(1, 'bmx-abcdef12');
    expect(probeSession).toHaveBeenNthCalledWith(2, 'bmx-abcdef12');
    expect(killSession).toHaveBeenCalledWith('bmx-abcdef12');
    expect(probeAgent).not.toHaveBeenCalled();
    expect(killAgent).not.toHaveBeenCalled();
    probeSession.mockRestore();
    probeAgent.mockRestore();
    killAgent.mockRestore();
    killSession.mockRestore();
  });

  it('keeps shared/custom/missing-owner/mismatched/blank-agent Herdr targets fail-closed', () => {
    const sessionId = 'abcdef123456';
    const targets = [
      { backendType: 'herdr' as const, sessionName: 'botmux', sessionId },
      { backendType: 'herdr' as const, sessionName: 'team-shared', sessionId },
      { backendType: 'herdr' as const, sessionName: 'bmx-abcdef12' },
      { backendType: 'herdr' as const, sessionName: 'bmx-abcdef12-extra', sessionId },
      { backendType: 'herdr' as const, sessionName: 'bmx-abcdef12', agentName: '   ', sessionId },
    ];
    const killAgent = vi.spyOn(HerdrBackend, 'killAgent').mockImplementation(() => {});
    const killSession = vi.spyOn(HerdrBackend, 'killSession').mockImplementation(() => {});
    const probeSession = vi.spyOn(HerdrBackend, 'probeSession').mockReturnValue('exists');
    const probeAgent = vi.spyOn(HerdrBackend, 'probeAgent').mockReturnValue('exists');

    for (const target of targets) {
      expect(probePersistentBackendTarget(target)).toBe('unknown');
      const batch = probePersistentBackendTargets([target]);
      expect(batch.get(persistentBackendTargetKey(target))).toBe('unknown');
      expect(() => killPersistentBackendTarget(target, sessionId)).toThrow(/exact exclusive owner/);
    }
    const exclusive = resolvePersistentBackendTarget('herdr', sessionId, undefined);
    expect(() => killPersistentBackendTarget(exclusive, 'different-owner')).toThrow(/exact exclusive owner/);

    expect(probeAgent).not.toHaveBeenCalled();
    expect(probeSession).not.toHaveBeenCalled();
    expect(killAgent).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    probeAgent.mockRestore();
    probeSession.mockRestore();
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
  it('routes a frozen Riff worker through drain + durable lineage ACK, never direct SIGTERM', () => {
    bot.backendType = 'pty';
    expect(shutdownBackendDisposition(ds({ sessionBackend: 'riff' }))).toBe('remote-drain-detach');
  });
  it('routes a frozen Mojo worker through the same durable remote drain, never direct SIGTERM', () => {
    bot.backendType = 'pty';
    expect(shutdownBackendDisposition(ds({ sessionBackend: 'mojo' }))).toBe('remote-drain-detach');
  });
});

describe('probePersistentSessions', () => {
  it('keeps identical ZMX names separate by directory and batches each directory once', () => {
    const probe = vi.spyOn(ZmxBackend, 'probeSessions').mockImplementation(env => ({
      ok: true,
      sessions: env?.ZMX_DIR === '/tmp/zmx-a' ? ['bmx-same'] : [],
      unhealthySessions: [], raw: '',
    }));
    try {
      const a = { backendType: 'zmx' as const, sessionName: 'bmx-same', socketDir: '/tmp/zmx-a' };
      const b = { ...a, socketDir: '/tmp/zmx-b' };
      const snapshot = probePersistentBackendTargets([a, b, a, { ...a, sessionName: 'bmx-other' }]);
      expect(snapshot.get(persistentBackendTargetKey(a))).toBe('exists');
      expect(snapshot.get(persistentBackendTargetKey(b))).toBe('missing');
      expect(snapshot.size).toBe(3);
      expect(probe).toHaveBeenCalledTimes(2);
    } finally { probe.mockRestore(); }
  });

  it('uses the persisted directory for workerless teardown and retains the ownership fence', () => {
    const kill = vi.spyOn(ZmxBackend, 'killManagedSession').mockImplementation(() => {});
    const target = { backendType: 'zmx' as const, sessionName: 'bmx-owned', socketDir: '/tmp/created-zmx' };
    try {
      expect(() => killPersistentBackendTarget(target)).toThrow(/session id/);
      expect(kill).not.toHaveBeenCalled();
      killPersistentBackendTarget(target, 'complete-session-id');
      expect(kill).toHaveBeenCalledWith('bmx-owned', 'complete-session-id', undefined,
        expect.objectContaining({ ZMX_DIR: '/tmp/created-zmx' }));
    } finally { kill.mockRestore(); }
  });

  it('classifies all ZMX names from one full-list snapshot', () => {
    const probe = vi.spyOn(ZmxBackend, 'probeSessions').mockReturnValue({
      ok: true,
      sessions: ['bmx-live'],
      unhealthySessions: ['bmx-timeout'],
      raw: '',
    });

    expect([...probePersistentSessions('zmx', [
      'bmx-live',
      'bmx-timeout',
      'bmx-missing',
      'bmx-live',
    ])]).toEqual([
      ['bmx-live', 'exists'],
      ['bmx-timeout', 'unknown'],
      ['bmx-missing', 'missing'],
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
    probe.mockRestore();
  });

  it('keeps every ZMX name unknown when the shared snapshot fails', () => {
    const probe = vi.spyOn(ZmxBackend, 'probeSessions').mockReturnValue({ ok: false });
    expect([...probePersistentSessions('zmx', ['bmx-a', 'bmx-b']).values()]).toEqual([
      'unknown',
      'unknown',
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
    probe.mockRestore();
  });
});

describe('persistent post-kill probe policy', () => {
  it.each([
    { backendType: 'tmux', probe: 'missing', reject: false },
    { backendType: 'tmux', probe: 'unknown', reject: false },
    { backendType: 'tmux', probe: 'exists', reject: true },
    { backendType: 'herdr', probe: 'missing', reject: false },
    { backendType: 'herdr', probe: 'unknown', reject: false },
    { backendType: 'herdr', probe: 'exists', reject: true },
    { backendType: 'zellij', probe: 'missing', reject: false },
    { backendType: 'zellij', probe: 'unknown', reject: false },
    { backendType: 'zellij', probe: 'exists', reject: true },
    { backendType: 'zmx', probe: 'missing', reject: false },
    { backendType: 'zmx', probe: 'unknown', reject: true },
    { backendType: 'zmx', probe: 'exists', reject: true },
  ] as const)(
    '$backendType + $probe → reject=$reject',
    ({ backendType, probe, reject }) => {
      expect(shouldRejectPersistentPostKillProbe(backendType, probe)).toBe(reject);
    },
  );
});

describe('probePersistentBackendTargetAfterKill', () => {
  const target = { backendType: 'tmux', sessionName: 'bmx-abcdef12' } as const;
  const run = (answers: Array<'exists' | 'missing' | 'unknown'>, attempts?: number) => {
    const seen: string[] = [];
    const slept: number[] = [];
    const result = probePersistentBackendTargetAfterKill(target, {
      ...(attempts !== undefined ? { attempts } : {}),
      probe: probed => { seen.push(probed.sessionName); return answers[seen.length - 1] ?? 'unknown'; },
      sleep: ms => { slept.push(ms); },
    });
    return { result, probes: seen.length, slept };
  };

  it('re-probes an unknown answer until tmux answers for itself', () => {
    expect(run(['unknown', 'missing'])).toMatchObject({ result: 'missing', probes: 2 });
    expect(run(['unknown', 'unknown', 'exists'])).toMatchObject({ result: 'exists', probes: 3 });
  });

  it('returns an authoritative answer at once, without waiting', () => {
    for (const answer of ['exists', 'missing'] as const) {
      expect(run([answer, 'missing'])).toEqual({ result: answer, probes: 1, slept: [] });
    }
  });

  it('probes once without waiting when no retry is allowed', () => {
    for (const attempts of [1, 0]) {
      expect(run(['unknown', 'missing'], attempts)).toEqual({ result: 'unknown', probes: 1, slept: [] });
    }
  });

  it('does not wait on a herdr target that is unknown by construction', () => {
    const probe = vi.fn(() => 'missing' as const);
    const sleep = vi.fn();
    const shared = { backendType: 'herdr', sessionName: 'shared-host' } as const;
    expect(probePersistentBackendTargetAfterKill(shared, { probe, sleep })).toBe('unknown');
    expect(probe).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stays unknown once the bounded attempts are used up, waiting between them', () => {
    const { result, probes, slept } = run(['unknown', 'unknown', 'unknown', 'missing'], 3);
    expect(result).toBe('unknown');
    expect(probes).toBe(3);
    expect(slept).toHaveLength(2);
    expect(slept[1]!).toBeGreaterThan(slept[0]!);
  });
});

describe('killPersistentSession ZMX ownership fence', () => {
  it('refuses name-only deletion and delegates the complete UUID to the managed kill', () => {
    expect(() => killPersistentSession('zmx', 'bmx-abcdef12')).toThrow(/name-only ZMX kill/);

    const kill = vi.spyOn(ZmxBackend, 'killManagedSession').mockImplementation(() => {});
    killPersistentSession('zmx', 'bmx-abcdef12', 'abcdef12-1111-2222-3333-444444444444');
    expect(kill).toHaveBeenCalledWith(
      'bmx-abcdef12',
      'abcdef12-1111-2222-3333-444444444444',
    );
    kill.mockRestore();
  });
});

describe('isRiffBackendSession (restart guard freeze-once)', () => {
  it('prefers the live worker stamp over a stale persisted backend', () => {
    expect(isRiffBackendSession(ds({ initBackend: 'riff', sessionBackend: 'tmux' }))).toBe(true);
    expect(isRiffBackendSession(ds({ initBackend: 'tmux', sessionBackend: 'riff' }))).toBe(false);
  });

  it('falls back to the persisted backend for a restored worker', () => {
    expect(isRiffBackendSession(ds({ sessionBackend: 'riff' }))).toBe(true);
    expect(isRiffBackendSession(ds({ sessionBackend: 'tmux' }))).toBe(false);
  });
});

describe('resolvePairedBackendId (browser-safe spawn pairing)', () => {
  it('matches reconcileRiffBackendType and resolves override → daemon default', async () => {
    const { reconcilePairedBackendId, resolvePairedBackendId } = await import('../src/core/remote-cli-ids.js');
    const { reconcileRiffBackendType } = await import('../src/core/persistent-backend.js');
    for (const [cli, resolved, fallback] of [
      ['claude-code', 'tmux', 'zmx'], ['claude-code', 'riff', 'zmx'], ['claude-code', 'riff', 'mojo'],
      ['riff', 'tmux', 'tmux'], ['mojo', 'pty', 'riff'], ['codex', 'zmx', 'riff'],
    ] as const) {
      expect(reconcilePairedBackendId(cli, resolved, fallback)).toBe(reconcileRiffBackendType(cli, resolved as any, fallback as any));
    }
    expect(resolvePairedBackendId('claude-code', null, 'riff')).toBe('pty');
    expect(resolvePairedBackendId('claude-code', 'tmux', 'zmx')).toBe('tmux');
    expect(resolvePairedBackendId('claude-code', '', 'zmx')).toBe('zmx');
    expect(resolvePairedBackendId('riff', 'tmux', 'zmx')).toBe('riff');
    // Older daemon that does not report its default, no override: unknown.
    expect(resolvePairedBackendId('claude-code', null, null)).toBeUndefined();
  });
});
