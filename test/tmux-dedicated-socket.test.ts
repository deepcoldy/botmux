/**
 * botmux-managed tmux sessions live on a dedicated server (`-L botmux`) frozen
 * per session in persistentBackendTarget.socketName; targets without it are the
 * default server (pre-isolation rows and the BOTMUX_TMUX_SOCKET=default opt-out).
 */
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionProbe } from '../src/adapters/backend/types.js';
import {
  isValidTmuxSocketName,
  managedTmuxCandidateSockets,
  normaliseTmuxSocketName,
  preferredManagedTmuxSocket,
  tmuxCommand,
  tmuxSocketArgs,
} from '../src/adapters/backend/tmux-socket.js';
import { resolveManagedTmuxPlacement, selectSessionBackend } from '../src/adapters/backend/session-backend-selector.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import {
  killPersistentBackendTarget,
  persistentBackendTargetKey,
  probePersistentBackendTarget,
  probePersistentBackendTargets,
} from '../src/core/persistent-backend.js';
import { startUnreachableTmuxServer } from './helpers/unreachable-tmux-server.js';

afterEach(() => vi.restoreAllMocks());

describe('socket name resolution', () => {
  it('defaults new sessions to the dedicated socket and honours the opt-out', () => {
    expect(preferredManagedTmuxSocket({})).toBe('botmux');
    expect(preferredManagedTmuxSocket({ BOTMUX_TMUX_SOCKET: '' })).toBe('botmux');
    expect(preferredManagedTmuxSocket({ BOTMUX_TMUX_SOCKET: 'default' })).toBeUndefined();
    expect(preferredManagedTmuxSocket({ BOTMUX_TMUX_SOCKET: ' fleet-2 ' })).toBe('fleet-2');
  });

  it('never lets a malformed override fall back onto the shared default server', () => {
    expect(preferredManagedTmuxSocket({ BOTMUX_TMUX_SOCKET: 'a b' })).toBe('botmux');
    expect(preferredManagedTmuxSocket({ BOTMUX_TMUX_SOCKET: '../x' })).toBe('botmux');
    expect(isValidTmuxSocketName('..')).toBe(false);
  });

  it('normalises persisted names and refuses ones it cannot address safely', () => {
    expect(normaliseTmuxSocketName(undefined)).toBeUndefined();
    expect(normaliseTmuxSocketName('default')).toBeUndefined();
    expect(normaliseTmuxSocketName('botmux')).toBe('botmux');
    expect(() => normaliseTmuxSocketName('x;y')).toThrow(/invalid tmux socket name/);
  });

  it('builds argv and command prefixes only for a named server', () => {
    expect(tmuxSocketArgs(undefined)).toEqual([]);
    expect(tmuxSocketArgs('botmux')).toEqual(['-L', 'botmux']);
    expect(tmuxCommand(undefined)).toBe('tmux');
    expect(tmuxCommand('botmux')).toBe('tmux -L botmux');
  });

  it('lists the recorded server (or the default one) before the preferred one, deduplicated', () => {
    expect(managedTmuxCandidateSockets(undefined, 'botmux')).toEqual([undefined, 'botmux']);
    expect(managedTmuxCandidateSockets('botmux', 'botmux')).toEqual(['botmux']);
    expect(managedTmuxCandidateSockets('old', 'botmux')).toEqual(['old', 'botmux']);
    expect(managedTmuxCandidateSockets(undefined, undefined)).toEqual([undefined]);
  });
});

describe('resolveManagedTmuxPlacement', () => {
  const probes = (answers: Record<string, SessionProbe>) => {
    const calls: Array<string | undefined> = [];
    const probe = (socket: string | undefined): SessionProbe => {
      calls.push(socket);
      return answers[socket ?? 'default'] ?? 'missing';
    };
    return { calls, probe };
  };

  it('reattaches a live pre-isolation pane where it is (no forced migration)', () => {
    const { calls, probe } = probes({ default: 'exists', botmux: 'missing' });
    expect(resolveManagedTmuxPlacement({ recordedSocketName: undefined, preferred: 'botmux', probe }))
      .toEqual({ socketName: undefined, probe: 'exists' });
    expect(calls).toEqual([undefined]);
  });

  it('finds a pane on the preferred server even when its target report was lost', () => {
    const { probe } = probes({ default: 'missing', botmux: 'exists' });
    expect(resolveManagedTmuxPlacement({ recordedSocketName: undefined, preferred: 'botmux', probe }))
      .toEqual({ socketName: 'botmux', probe: 'exists' });
  });

  it('creates on the preferred server when nothing is live anywhere', () => {
    const { calls, probe } = probes({});
    expect(resolveManagedTmuxPlacement({ recordedSocketName: undefined, preferred: 'botmux', probe }))
      .toEqual({ socketName: 'botmux', probe: 'missing' });
    expect(calls).toEqual([undefined, 'botmux']);
  });

  it('treats a recorded socket as authoritative and never probes the default server for it', () => {
    const { calls, probe } = probes({ botmux: 'exists', default: 'exists' });
    expect(resolveManagedTmuxPlacement({ recordedSocketName: 'botmux', preferred: 'botmux', probe }))
      .toEqual({ socketName: 'botmux', probe: 'exists' });
    expect(calls).toEqual(['botmux']);
  });

  it('moves a session whose recorded server lost its pane to the preferred server', () => {
    const { probe } = probes({ old: 'missing', botmux: 'missing' });
    expect(resolveManagedTmuxPlacement({ recordedSocketName: 'old', preferred: 'botmux', probe }))
      .toEqual({ socketName: 'botmux', probe: 'missing' });
  });

  it('pins an indeterminate answer to the server that could not answer', () => {
    const { probe } = probes({ default: 'unknown', botmux: 'missing' });
    expect(resolveManagedTmuxPlacement({ recordedSocketName: undefined, preferred: 'botmux', probe }))
      .toEqual({ socketName: undefined, probe: 'unknown' });
    const later = probes({ default: 'unknown', botmux: 'exists' });
    expect(resolveManagedTmuxPlacement({ recordedSocketName: undefined, preferred: 'botmux', probe: later.probe }))
      .toEqual({ socketName: 'botmux', probe: 'exists' });
  });

  it('keeps the historical single default-server probe under the opt-out', () => {
    const { calls, probe } = probes({});
    expect(resolveManagedTmuxPlacement({ recordedSocketName: undefined, preferred: undefined, probe }))
      .toEqual({ socketName: undefined, probe: 'missing' });
    expect(calls).toEqual([undefined]);
  });
});

describe('selectSessionBackend (tmux)', () => {
  const sessionId = 'abcdef12-3456-7890-abcd-ef1234567890';

  it('freezes the dedicated socket into the backend and the persisted target', () => {
    for (const hasExistingSession of [false, true]) {
      const selected = selectSessionBackend({ sessionId, backendType: 'tmux', hasExistingSession, tmuxSocketName: 'botmux' });
      expect((selected.backend as { socketName?: string }).socketName).toBe('botmux');
      expect(selected.persistentBackendTarget).toEqual({ backendType: 'tmux', sessionName: 'bmx-abcdef12', socketName: 'botmux' });
      expect(selected.isReattach).toBe(hasExistingSession);
    }
  });

  it('keeps the historical target shape for the default server', () => {
    const selected = selectSessionBackend({ sessionId, backendType: 'tmux', hasExistingSession: true });
    expect((selected.backend as { socketName?: string }).socketName).toBeUndefined();
    expect(selected.persistentBackendTarget).toStrictEqual({ backendType: 'tmux', sessionName: 'bmx-abcdef12' });
  });
});

describe('persistent tmux targets', () => {
  const legacy = { backendType: 'tmux' as const, sessionName: 'bmx-abcdef12' };
  const dedicated = { ...legacy, socketName: 'botmux' };

  it('keys a default-server target the same with or without an explicit empty socket, and apart from the dedicated one', () => {
    expect(persistentBackendTargetKey({ ...legacy, socketName: undefined })).toBe(persistentBackendTargetKey(legacy));
    expect(persistentBackendTargetKey(dedicated)).not.toBe(persistentBackendTargetKey(legacy));
  });

  it('probes and kills on the recorded server only', () => {
    const probe = vi.spyOn(TmuxBackend, 'probeSession').mockReturnValue('exists');
    const kill = vi.spyOn(TmuxBackend, 'killSession').mockImplementation(() => {});
    expect(probePersistentBackendTarget(dedicated)).toBe('exists');
    killPersistentBackendTarget(dedicated);
    expect(probe).toHaveBeenLastCalledWith('bmx-abcdef12', 'botmux');
    expect(kill).toHaveBeenLastCalledWith('bmx-abcdef12', 'botmux');

    probePersistentBackendTarget(legacy);
    killPersistentBackendTarget(legacy);
    expect(probe).toHaveBeenLastCalledWith('bmx-abcdef12');
    expect(kill).toHaveBeenLastCalledWith('bmx-abcdef12');
  });

  it('answers a batch per server, not per name', () => {
    vi.spyOn(TmuxBackend, 'probeSession').mockImplementation((_name, socket) => (socket === 'botmux' ? 'exists' : 'missing'));
    const snapshot = probePersistentBackendTargets([legacy, dedicated]);
    expect(snapshot.get(persistentBackendTargetKey(legacy))).toBe('missing');
    expect(snapshot.get(persistentBackendTargetKey(dedicated))).toBe('exists');
  });
});

const hasTmux = spawnSync('tmux', ['-V']).status === 0;

// Runs inside the test fence's private TMUX_TMPDIR, so no host server is touched.
describe.skipIf(process.platform !== 'linux' || !hasTmux)('named socket that has never had a server', () => {
  it('reads as provably missing (kernel socket table), while the default server stays strict', () => {
    const socket = `bmx-never-${process.pid}`;
    expect(TmuxBackend.probeSession('bmx-abcdef12', socket)).toBe('missing');
    expect(TmuxBackend.probeSessionForLaunch('bmx-abcdef12', socket)).toBe('missing');
    // No default server in this private root either: the socket file is
    // missing, and the default server keeps its historical 'unknown'.
    expect(TmuxBackend.probeSession('bmx-abcdef12')).toBe('unknown');
  });

  it('lets teardown verification treat a never-started default server as holding nothing', () => {
    expect(TmuxBackend.probeSessionForTeardown('bmx-diag-abcdef12')).toBe('missing');
    expect(TmuxBackend.probeSession('bmx-diag-abcdef12')).toBe('unknown');
  });

  it('lets an instance-bound launch through instead of refusing a server that does not exist', () => {
    expect(() => TmuxBackend.assertInstanceIdentity('bmx-abcdef12', 'binding-a', `bmx-never-${process.pid}`)).not.toThrow();
  });
});

// After the never-started cases above: these leave a server behind until stop().
describe.skipIf(process.platform !== 'linux' || !hasTmux)('live server whose socket file was unlinked', () => {
  // The shell is alive, only unreachable by path, and the kernel still binds
  // the pathname: teardown verification must not read that as "nothing there".
  it('stays unknown to teardown verification on the default server (legacy recorded server)', async () => {
    const server = startUnreachableTmuxServer('bmx-diag-unlinkd');
    try {
      expect(TmuxBackend.probeSessionForTeardown('bmx-diag-unlinkd')).toBe('unknown');
    } finally {
      await server.stop();
    }
  });

  it('stays unknown to teardown verification on the dedicated server', async () => {
    const server = startUnreachableTmuxServer('bmx-diag-unlinkn', 'botmux');
    try {
      expect(TmuxBackend.probeSessionForTeardown('bmx-diag-unlinkn', 'botmux')).toBe('unknown');
    } finally {
      await server.stop();
    }
  });
});
