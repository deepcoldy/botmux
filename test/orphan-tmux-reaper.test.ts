import { describe, it, expect } from 'vitest';
import {
  reapOrphanTmuxServers,
  ensureServerThenReapOrphanTmuxServers,
  orphanTmuxReaperEnabled,
  reaperCandidateSocketNames,
  parseLsofSocketBindings,
  argvCarriesBotmuxSession,
  defaultSocketPath,
  type SocketBinding,
} from '../src/core/orphan-tmux-reaper.js';
import type { ProcSnapshot } from '../src/core/worker-pool.js';

// Must honour process.env: the unit project's tmux fence (test/helpers/tmux-fence.ts)
// redirects TMUX_TMPDIR to a private root; a hard-coded {} here computes the host's
// /tmp socket, matches no fixture binding, and silently turns every reap test red
// (or green-for-the-wrong-reason outside the fence).
const SOCK = defaultSocketPath(process.env, process.getuid(), undefined);
/** Fixture path for a named (-L) socket under the same fence root. */
const namedSocket = (name: string) => defaultSocketPath(process.env, process.getuid(), name);
/** Fixture path computed by the IMPLEMENTATION for an invalid uid (-1 guard). */
const SOCK_UID_NEG1 = defaultSocketPath(process.env, -1, undefined);

const tmuxServer = (pid: number, ppid = 1, extra = ''): ProcSnapshot => ({
  pid,
  ppid,
  cmd: `tmux new-session -d -P -F #{pid} #{session_id} -s bmx-deadbeef -x 160 -y 50${extra} -- /bin/zsh`,
});

/** Default seam tail: the signal "succeeds" and the server is instantly gone,
 *  so tests never poll real pids or pay the 3 s bounded wait. */
const DEAD_ON_SIGNAL = { isAlive: () => false, sleep: () => {} } as const;

describe('reapOrphanTmuxServers (default socket)', () => {
  it('reaps a botmux tmux server displaced from the default socket', () => {
    const killed: number[] = [];
    const procs = [
      tmuxServer(100),                       // reachable, owns the socket — spared
      tmuxServer(200),                       // displaced orphan — reaped
    ];
    const bindings: SocketBinding[] = [
      { pid: 100, path: SOCK },
      { pid: 200, path: SOCK },
    ];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (pid) => killed.push(pid),
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(1);
    expect(killed).toEqual([200]);
  });

  it('reaps a displaced server booted by the reaper bootstrap (bmx-reap-bootstrap-<pid>)', () => {
    const killed: number[] = [];
    const procs: ProcSnapshot[] = [
      tmuxServer(100),
      // The reaper's own bootstrap booted this generation; a later real bmx
      // session attached but the server argv stays the bootstrap's forever.
      { pid: 200, ppid: 1, cmd: 'tmux new-session -d -s bmx-reap-bootstrap-4321 -x 80 -y 24' },
    ];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (p) => killed.push(p),
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(1);
    expect(killed).toEqual([200]);
  });

  it('never reaps when no reachable server can be identified (busy/unknown = keep)', () => {
    const killed: number[] = [];
    const procs = [tmuxServer(200)];
    const bindings: SocketBinding[] = [{ pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: null,
      kill: (p) => killed.push(p),
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(0);
    expect(killed).toEqual([]);
  });

  it('reaps nothing on a healthy single server (it IS the reachable owner)', () => {
    const killed: number[] = [];
    const procs = [tmuxServer(100)];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (p) => killed.push(p),
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(0);
  });

  it('spares a displaced server that is NOT botmux-owned (user interactive tmux)', () => {
    const killed: number[] = [];
    const procs: ProcSnapshot[] = [
      tmuxServer(100),
      { pid: 200, ppid: 1, cmd: 'tmux new-session -d -s work -x 160 -y 50 -- /bin/zsh' },
      { pid: 201, ppid: 200, cmd: '/bin/zsh -l' },
    ];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (p) => killed.push(p),
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(0);
  });

  it('spares a non-tmux process even when its argv text contains new-session -s bmx-*', () => {
    // argvCarriesBotmuxSession deliberately does not require argv[0]=tmux; the
    // isTmuxBinary gate upstream is what separates a real server from, e.g., a
    // node worker whose command line merely mentions the same tokens.
    const killed: number[] = [];
    const procs: ProcSnapshot[] = [
      tmuxServer(100),
      { pid: 200, ppid: 1, cmd: 'node /opt/botmux/worker.js -- new-session -s bmx-12345678' },
    ];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (p) => killed.push(p),
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(0);
    expect(killed).toEqual([]);
  });

  it('ignores bindings on other socket paths', () => {
    const killed: number[] = [];
    const procs = [
      tmuxServer(100),
      { pid: 200, ppid: 1, cmd: 'tmux new-session -s bmx-11111111' },
    ];
    const bindings: SocketBinding[] = [
      { pid: 100, path: SOCK },
      { pid: 200, path: `${SOCK}.probe-tmp` },   // a -L probe socket, not default
    ];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (p) => killed.push(p),
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(0);
  });

  it('honours BOTMUX_DISABLE_ORPHAN_TMUX_REAP=1', () => {
    let killed = false;
    const procs = [tmuxServer(100), tmuxServer(200)];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      env: { BOTMUX_DISABLE_ORPHAN_TMUX_REAP: '1' },
      kill: () => { killed = true; },
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(0);
    expect(killed).toBe(false);
  });

  it('counts an ESRCH on the signal as reaped (it exited on its own)', () => {
    const procs = [tmuxServer(100), tmuxServer(200)];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: () => { throw Object.assign(new Error('No such process'), { code: 'ESRCH' }); },
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(1);
  });

  it('does not count a server still alive after the bounded post-SIGTERM wait', () => {
    const killed: number[] = [];
    const polls: number[] = [];
    const procs = [tmuxServer(100), tmuxServer(200)];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (p) => killed.push(p),
      isAlive: () => true,   // ignores SIGHUP / stuck in teardown
      sleep: (ms) => { polls.push(ms); },
    });
    expect(n).toBe(0);
    expect(killed).toEqual([200]);
    expect(polls.length).toBeGreaterThan(0);
  });

  it('skips the pass when the reachable owner changes between the two probes (TOCTOU)', () => {
    const killed: number[] = [];
    const procs = [tmuxServer(100), tmuxServer(200)];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      reProbeReachableServerPid: () => 999,
      kill: (p) => killed.push(p),
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(0);
    expect(killed).toEqual([]);
  });

  it('is a no-op off linux/darwin and without getuid', () => {
    const procs = [tmuxServer(100), tmuxServer(200)];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    expect(reapOrphanTmuxServers({
      procs, socketBindings: bindings, reachableServerPid: 100,
      platform: 'win32', uid: 1, kill: () => { throw new Error('must not kill'); },
      ...DEAD_ON_SIGNAL,
    })).toBe(0);
    // The uid<0 guard: the fixture binding path MUST be computed by the
    // implementation for uid -1 itself — a SOCK-shaped fixture would already
    // mismatch at the path filter and make this case green even with the guard
    // deleted (false coverage).
    const negBindings: SocketBinding[] = [{ pid: 200, path: SOCK_UID_NEG1 }];
    const negProcs: ProcSnapshot[] = [tmuxServer(200)];
    const killed: number[] = [];
    expect(reapOrphanTmuxServers({
      procs: negProcs, socketBindings: negBindings, reachableServerPid: 100,
      platform: 'darwin', uid: -1, kill: (p) => killed.push(p),
      ...DEAD_ON_SIGNAL,
    })).toBe(0);
    expect(killed).toEqual([]);
  });
});

describe('ensureServerThenReapOrphanTmuxServers (multi-socket orchestrator)', () => {
  /**
   * Seam harness: per-socket probe state plus records of every side effect, so
   * census-first ("no boot on an empty socket") and the bootstrap flow can be
   * asserted without real tmux.
   */
  function harness(opts: {
    sockets: Array<{
      name: string | undefined;
      bindings: SocketBinding[];
      owner: { kind: 'reachable'; pid: number } | { kind: 'down' } | { kind: 'unknown' };
      /** Owner pid reported by the post-bootstrap re-probe. */
      afterBootstrapPid?: number;
      procs: ProcSnapshot[];
    }>;
  }) {
    const probes: Array<string | undefined> = [];
    const booted: string[] = [];
    const cleaned: string[] = [];
    const killed: number[] = [];
    const allBindings = opts.sockets.flatMap(s => s.bindings);
    const allProcs = [...new Map(opts.sockets.flatMap(s => s.procs.map(p => [p.pid, p]))).values()];
    const state = new Map(opts.sockets.map(s => [s.name === undefined ? '__default__' : s.name, s.owner]));
    const key = (n: string | undefined) => n === undefined ? '__default__' : n;
    const n = ensureServerThenReapOrphanTmuxServers({
      socketNames: opts.sockets.map(s => s.name),
      procs: allProcs,
      socketBindings: allBindings,
      env: process.env,
      platform: 'darwin',
      uid: process.getuid(),
      probeOwner: (name) => { probes.push(name); const o = state.get(key(name))!; return o; },
      bootstrap: (name, session) => {
        booted.push(`${name ?? 'default'}:${session}`);
        const after = opts.sockets.find(s => s.name === name)?.afterBootstrapPid;
        if (after) state.set(key(name), { kind: 'reachable', pid: after });
        return true;
      },
      cleanupBootstrap: (name, session) => { cleaned.push(`${name ?? 'default'}:${session}`); },
      kill: (pid) => { killed.push(pid); },
      ...DEAD_ON_SIGNAL,
    });
    return { n, probes, booted, cleaned, killed };
  }

  it('reaps a displaced server on the dedicated -L botmux socket (#2107)', () => {
    const PATH = namedSocket('botmux');
    const r = harness({
      sockets: [{
        name: 'botmux',
        bindings: [{ pid: 100, path: PATH }, { pid: 200, path: PATH }],
        owner: { kind: 'reachable', pid: 100 },
        procs: [tmuxServer(100), tmuxServer(200)],
      }],
    });
    expect(r.n).toBe(1);
    expect(r.killed).toEqual([200]);
    expect(r.booted).toEqual([]);           // reachable owner ⇒ no bootstrap boot
    expect(r.cleaned).toEqual([]);
  });

  it('census-first: a socket with no listener is skipped without probing OR booting', () => {
    const r = harness({
      sockets: [{
        name: undefined,
        bindings: [],                        // nothing bound — empty host socket
        owner: { kind: 'reachable', pid: 100 },  // must NOT even be consulted
        procs: [],
      }, {
        name: 'botmux',
        bindings: [],
        owner: { kind: 'down' },             // must NOT trigger a bootstrap
        procs: [],
      }],
    });
    expect(r.n).toBe(0);
    expect(r.probes).toEqual([]);
    expect(r.booted).toEqual([]);            // the whole point: never boot default to probe
    expect(r.cleaned).toEqual([]);
  });

  it('boots a bootstrap when a listener exists but the owner is down, reaps, cleans up', () => {
    const PATH = namedSocket('botmux');
    const r = harness({
      sockets: [{
        name: 'botmux',
        bindings: [{ pid: 200, path: PATH }],  // only the displaced server listens
        owner: { kind: 'down' },
        afterBootstrapPid: 300,              // bootstrap boots a fresh reachable owner
        procs: [
          tmuxServer(200),
          { pid: 300, ppid: 1, cmd: 'tmux new-session -d -s bmx-reap-bootstrap-7 -x 80 -y 24' },
        ],
      }],
    });
    expect(r.n).toBe(1);
    expect(r.killed).toEqual([200]);
    expect(r.booted.length).toBe(1);
    expect(r.booted[0]!.startsWith('botmux:bmx-reap-bootstrap-')).toBe(true);
    expect(r.cleaned).toEqual(r.booted);     // bootstrap removed
  });

  it('skips a socket whose owner probe is unknown (never boots, never kills)', () => {
    const PATH = namedSocket('botmux');
    const r = harness({
      sockets: [{
        name: 'botmux',
        bindings: [{ pid: 200, path: PATH }],
        owner: { kind: 'unknown' },
        procs: [tmuxServer(200)],
      }],
    });
    expect(r.n).toBe(0);
    expect(r.killed).toEqual([]);
    expect(r.booted).toEqual([]);
  });

  it('handles default and dedicated sockets independently in one pass', () => {
    const NAMED = namedSocket('botmux');
    const r = harness({
      sockets: [
        // default: healthy single server, nothing reaped
        {
          name: undefined,
          bindings: [{ pid: 100, path: SOCK }],
          owner: { kind: 'reachable', pid: 100 },
          procs: [tmuxServer(100)],
        },
        // dedicated: displaced, one reaped
        {
          name: 'botmux',
          bindings: [{ pid: 300, path: NAMED }, { pid: 400, path: NAMED }],
          owner: { kind: 'reachable', pid: 300 },
          procs: [
            { pid: 300, ppid: 1, cmd: 'tmux new-session -d -s bmx-aaaaaaaa -x 80 -y 24' },
            { pid: 400, ppid: 1, cmd: 'tmux new-session -d -s bmx-bbbbbbbb -x 80 -y 24' },
          ],
        },
      ],
    });
    expect(r.n).toBe(1);
    expect(r.killed).toEqual([400]);
  });

  it('honours the env kill-switch before any probing', () => {
    const PATH = namedSocket('botmux');
    let probed = false;
    const n = ensureServerThenReapOrphanTmuxServers({
      socketNames: ['botmux'],
      procs: [tmuxServer(200)],
      socketBindings: [{ pid: 200, path: PATH }],
      env: { BOTMUX_DISABLE_ORPHAN_TMUX_REAP: '1', ...process.env },
      platform: 'darwin',
      uid: process.getuid(),
      probeOwner: () => { probed = true; return { kind: 'reachable', pid: 100 }; },
      kill: () => { throw new Error('must not kill'); },
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(0);
    expect(probed).toBe(false);
  });
});

describe('orphan tmux reaper helpers', () => {
  it('orphanTmuxReaperEnabled requires BOTH the tmux backend and the default-off switch', () => {
    expect(orphanTmuxReaperEnabled('tmux', true)).toBe(true);
    expect(orphanTmuxReaperEnabled('tmux', false)).toBe(false); // default OFF — the whole point
    expect(orphanTmuxReaperEnabled('pty', true)).toBe(false);
    expect(orphanTmuxReaperEnabled('herdr', true)).toBe(false);
  });

  it('argvCarriesBotmuxSession matches botmux session names on any socket', () => {
    // The fingerprint is argv-only and socket-agnostic: -L placement must not
    // affect whether a displaced server is recognized.
    expect(argvCarriesBotmuxSession('tmux -L botmux new-session -d -s bmx-1a2b3c4d -x 160')).toBe(true);
    expect(argvCarriesBotmuxSession('tmux new-session -d -s bmx-1a2b3c4d -x 160')).toBe(true);
    expect(argvCarriesBotmuxSession('tmux new-session -s bmx-diag-1a2b3c4d')).toBe(true);
    expect(argvCarriesBotmuxSession('tmux new-session -d -s bmx-reap-bootstrap-4321')).toBe(true);
    expect(argvCarriesBotmuxSession('tmux new-session -s work')).toBe(false);
    expect(argvCarriesBotmuxSession('tmux new-session -s bmx-short')).toBe(false);
    expect(argvCarriesBotmuxSession('grep -s bmx-1a2b3c4d')).toBe(false); // no new-session
  });

  it('reaperCandidateSocketNames merges recorded, default, and preferred sockets', () => {
    // With no BOTMUX_TMUX_SOCKET override the preferred socket is 'botmux'.
    const names = reaperCandidateSocketNames([undefined, 'botmux', 'team-a', 'botmux'], {
      ...process.env,
      BOTMUX_TMUX_SOCKET: '',
    });
    expect(names).toContain(undefined);             // default (legacy records)
    expect(names).toContain('botmux');              // dedicated preferred
    expect(names).toContain('team-a');              // per-session frozen name
    expect(new Set(names).size).toBe(names.length); // deduped
  });

  it('parseLsofSocketBindings extracts pathname-bound sockets per pid', () => {
    const dump = [
      'p100', 'ctmux',
      'f6', 'tunix', 'n/private/tmp/tmux-501/default',
      'f9', 'tunix', 'n->0x1234',                                   // client end
      'p200', 'ctmux',
      'f3', 'tunix', 'n/private/tmp/tmux-501/default',
    ].join('\n');
    expect(parseLsofSocketBindings(dump)).toEqual([
      { pid: 100, path: '/private/tmp/tmux-501/default' },
      { pid: 200, path: '/private/tmp/tmux-501/default' },
    ]);
  });

  it('defaultSocketPath honours TMUX_TMPDIR, uid, and socket name', () => {
    expect(defaultSocketPath({}, 501, undefined)).toBe('/tmp/tmux-501/default');
    expect(defaultSocketPath({}, 501)).toBe('/tmp/tmux-501/default');
    expect(defaultSocketPath({ TMUX_TMPDIR: '/var/tmp' }, 42, 'botmux')).toBe('/var/tmp/tmux-42/botmux');
    expect(defaultSocketPath({ TMUX_TMPDIR: '/var/tmp' }, 42)).toBe('/var/tmp/tmux-42/default');
  });
});
