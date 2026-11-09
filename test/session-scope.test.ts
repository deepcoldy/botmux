import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  __testOnly_resetSessionScopeCapabilityCache,
  INITIAL_PID_NAMESPACE,
  isBotmuxSessionScopeUnit,
  isSessionScopeUnitFor,
  memoryControllerPlacementVerified,
  probeSessionScopeCapabilities,
  probeSystemdPidNamespace,
  prepareSessionScopedLaunch,
  releaseSessionScopeForSpawn,
  stopAllSessionScopes,
  sessionScopePayloadPid,
  sessionScopeUnitName,
  stopSessionScope,
  systemdPidNamespace,
  userSystemdBusEnv,
  wrapCommandInSessionScope,
  type SystemdPidNamespace,
} from '../src/core/session-scope.js';

function result(status: number, stdout = '', stderr = ''): any {
  return { status, stdout, stderr, error: undefined };
}

const SHARED: SystemdPidNamespace = { shared: true, basis: 'initial-namespace', namespace: INITIAL_PID_NAMESPACE };
const NOT_SHARED: SystemdPidNamespace = { shared: false, reason: 'user systemd runs in another PID namespace' };
/** What a check that could not run at all concludes. */
const FAILED_CHECK = probeSystemdPidNamespace({
  platform: 'linux',
  readlink: () => { throw new Error('EACCES'); },
});
const initialNamespace = (): string => INITIAL_PID_NAMESPACE;

describe('owned session systemd scope', () => {
  it('resolves only the fixed supervisor with one observable foreground child', () => {
    const wrapped = wrapCommandInSessionScope('probe', 'cli', [], undefined,
      { cleanupSupported: true, memoryControllerSupported: false }, {}, undefined, SHARED);
    const commandLine = wrapped.args.join('\0') + '\0';
    const resolve = (argv = commandLine, children = '123 ') => sessionScopePayloadPid(99, {
      platform: 'linux',
      readFile: path => path.endsWith('/cmdline') ? argv : children,
    });
    expect(resolve()).toBe(123);
    // A copied label is not evidence: arbitrary shells must retain their input
    // guard even while they have a foreground child (e.g. an rcfile command).
    expect(resolve('/bin/sh\0-c\0sleep 300\0botmux-session-scope\0')).toBe(99);
    expect(resolve(commandLine.replace('"$@"; status=$?; exit "$status"', 'exec "$@"'))).toBe(99);
    // A pane launched before the in-pane PID namespace check ran systemd-run directly.
    const beforeCheck = commandLine.replace(/\/bin\/sh\0-c\0ns=[^\0]*\0botmux-scope-pidns\0pid:\[\d+\]\0/, '');
    expect(beforeCheck).not.toBe(commandLine);
    expect(resolve(beforeCheck)).toBe(123);
    expect(resolve(commandLine.replace(/ns=[^\0]*/, 'exec "$@"'))).toBe(99);
    for (const children of ['', '123 124 ', 'bad', '0', '1', '99']) {
      expect(resolve(commandLine, children)).toBe(99);
    }
    expect(sessionScopePayloadPid(99, {
      platform: 'linux', readFile: () => { throw new Error('process gone'); },
    })).toBe(99);
    expect(sessionScopePayloadPid(99, {
      platform: 'darwin', readFile: () => { throw new Error('must not inspect proc'); },
    })).toBe(99);
  });

  /** Runs a wrapped payload through the real supervisor and a fake systemd-run
   *  that, like `systemd-run --scope`, execs the payload in place (a tmux server
   *  may migrate the original pane PID after that exec). */
  function runSupervised(pidNamespace: SystemdPidNamespace) {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-scope-parent-'));
    try {
      writeFileSync(join(dir, 'systemd-run'),
        '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nBOTMUX_FAKE_SCOPE=1 exec "$@"\n', { mode: 0o755 });
      const payload = join(dir, 'payload');
      writeFileSync(payload,
        '#!/bin/sh\nIFS= read -r line\nprintf "%s\\n%s\\n%s\\n%s\\n" "$$" "$line" "$1" "${BOTMUX_FAKE_SCOPE:-none}"\nexit 7\n', { mode: 0o755 });
      const argument = 'literal spaces; $(must-not-run)';
      const wrapped = wrapCommandInSessionScope('parent-boundary', payload, [argument],
        undefined, { cleanupSupported: true, memoryControllerSupported: false }, {}, undefined, pidNamespace);
      const child = spawnSync(wrapped.bin, wrapped.args, {
        env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` },
        input: 'interactive input\n', encoding: 'utf8', timeout: 5_000,
      });
      expect(child.status, child.stderr).toBe(7);
      const [payloadPid, input, receivedArgument, scoped] = child.stdout.trimEnd().split('\n');
      expect(Number(payloadPid)).toBeGreaterThan(1);
      expect(Number(payloadPid)).not.toBe(child.pid);
      expect(input).toBe('interactive input');
      expect(receivedArgument).toBe(argument);
      return { scoped: scoped === '1' };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it.runIf(process.platform === 'linux')('keeps a parent outside the scope while preserving stdin, argv and exit status', () => {
    const here: SystemdPidNamespace = { shared: true, basis: 'user-bus', namespace: readlinkSync('/proc/self/ns/pid') };
    expect(runSupervised(here)).toEqual({ scoped: true });
  });

  // The pane is a child of the backend's server, which need not share the
  // worker's PID namespace; there systemd-run would send a PID from the wrong one.
  it.skipIf(process.platform === 'win32')('runs the payload unscoped, just as transparently, from a pane in another PID namespace', () => {
    expect(runSupervised({ shared: true, basis: 'initial-namespace', namespace: 'pid:[1]' })).toEqual({ scoped: false });
  });

  it('leaves commands unchanged when session scopes are unavailable', () => {
    const capabilities = { cleanupSupported: false, memoryControllerSupported: false };
    expect(wrapCommandInSessionScope('plain', 'cli', ['argument'], undefined, capabilities)).toEqual({
      bin: 'cli', args: ['argument'], capabilities,
    });
  });

  it('derives the canonical user bus environment from a verified socket', () => {
    const isSocket = vi.fn((path: string) => path === '/run/user/1001/bus');
    expect(userSystemdBusEnv({ platform: 'linux', uid: 1001, isSocket, env: {} })).toEqual({
      XDG_RUNTIME_DIR: '/run/user/1001',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1001/bus',
    });
    expect(isSocket).toHaveBeenCalledWith('/run/user/1001/bus');
    expect(userSystemdBusEnv({ platform: 'darwin', uid: 1001, isSocket, env: {} })).toBeUndefined();
    expect(userSystemdBusEnv({ platform: 'linux', uid: 1001, isSocket: () => false, env: {} })).toBeUndefined();
  });

  it('uses only the bus variables fenced-run passed through and derives none', () => {
    const isSocket = vi.fn(() => true);
    const derived = { XDG_RUNTIME_DIR: '/run/user/1001', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1001/bus' };
    const fenced = (env: NodeJS.ProcessEnv) =>
      userSystemdBusEnv({ platform: 'linux', uid: 1001, isSocket, env: { BOTMUX_FENCED_RUN: '1', ...env } });
    expect(fenced({})).toBeUndefined();
    expect(fenced({ XDG_RUNTIME_DIR: '/tmp/probe-runtime' })).toEqual({ XDG_RUNTIME_DIR: '/tmp/probe-runtime' });
    expect(fenced({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/private-bus' }))
      .toEqual({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/private-bus' });
    expect(fenced(derived)).toEqual(derived);
    expect(isSocket).not.toHaveBeenCalled();
    // Outside the fence a missing variable still means "not exported" (cron, ssh without pam),
    // and the verified canonical bus still wins over an inherited one.
    expect(userSystemdBusEnv({ platform: 'linux', uid: 1001, isSocket, env: { BOTMUX_FENCED_RUN: '0' } })).toEqual(derived);
    expect(userSystemdBusEnv({
      platform: 'linux', uid: 1001, isSocket, env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/private-bus' },
    })).toEqual(derived);
  });

  it('fails open on unsupported platforms', () => {
    expect(probeSessionScopeCapabilities({ platform: 'darwin' })).toMatchObject({
      cleanupSupported: false,
      memoryControllerSupported: false,
    });
  });

  it('reports cleanup but not MemoryMax on cgroup-v1/hybrid hosts', () => {
    const run = vi.fn((command: string) => command === 'systemd-run'
      ? result(0)
      : result(0, '/user.slice/user-1001.slice/user@1001.service\n'));
    expect(probeSessionScopeCapabilities({
      platform: 'linux',
      run,
      readlink: initialNamespace,
      exists: () => false,
    })).toEqual({
      cleanupSupported: true,
      memoryControllerSupported: false,
      reason: 'scope cleanup works, but a delegated cgroup-v2 memory controller was not verified',
    });
  });

  it('requires verified cgroup-v2 memory delegation before adding MemoryMax', () => {
    const run = vi.fn((command: string, args: readonly string[]) => {
      if (command === 'systemd-run' || command === 'sh') return result(0);
      if (args.includes('botmux-scope-probe-')) return result(0);
      if (args.some(arg => arg.includes('-memory.scope'))) {
        return result(0, '/user.slice/user-1001.slice/user@1001.service/app.slice/probe.scope\n');
      }
      return result(0, '/user.slice/user-1001.slice/user@1001.service\n');
    });
    const capabilities = probeSessionScopeCapabilities({
      platform: 'linux',
      run,
      readlink: initialNamespace,
      exists: path => path === '/sys/fs/cgroup/cgroup.controllers' || path.endsWith('/memory.max'),
      readFile: path => path.endsWith('/memory.max')
        ? '16777216'
        : path.endsWith('cgroup.controllers') ? 'cpu io memory' : 'cpu memory',
    });
    expect(capabilities).toEqual({ cleanupSupported: true, memoryControllerSupported: true });
    const wrapped = wrapCommandInSessionScope(
      'ABC/123',
      '/usr/bin/node',
      ['cli.js'],
      { sessionMemoryMaxBytes: 5_000_000 },
      capabilities,
      {
        XDG_RUNTIME_DIR: '/run/user/1001',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1001/bus',
      },
      undefined,
      SHARED,
    );
    expect(wrapped.bin).toBe('/usr/bin/env');
    expect(wrapped.args.slice(0, 2)).toEqual([
      'XDG_RUNTIME_DIR=/run/user/1001',
      'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus',
    ]);
    expect(wrapped.args).toContain('systemd-run');
    expect(wrapped.args).toContain('--property=MemoryMax=5000000');
    expect(wrapped.args.slice(-3)).toEqual(['--', '/usr/bin/node', 'cli.js']);
    expect(wrapped.unitName).toBe('botmux-session-abc-123.scope');
  });

  // REGRESSION GUARD (cgroup-v2 gate): a cgroup-v1 host can still satisfy every
  // DOWNSTREAM check — the delegation reads succeed and the probe scope's
  // memory.max both exists and holds the probe limit. Only the explicit
  // /sys/fs/cgroup/cgroup.controllers gate can reject it. Without that gate we
  // would promise an enforceable MemoryMax that v1 silently drops, so this case
  // pins the gate itself rather than the checks behind it.
  it('rejects a cgroup-v1 host even when every downstream check would pass', () => {
    const run = vi.fn((command: string, args: readonly string[]) => {
      if (command === 'systemd-run' || command === 'sh') return result(0);
      if (args.some(arg => arg.includes('-memory.scope'))) {
        return result(0, '/user.slice/user-1001.slice/user@1001.service/app.slice/probe.scope\n');
      }
      return result(0, '/user.slice/user-1001.slice/user@1001.service\n');
    });
    const capabilities = probeSessionScopeCapabilities({
      platform: 'linux',
      run,
      readlink: initialNamespace,
      // The v2 root marker is ABSENT (this is what makes the host v1) while
      // memory.max resolves — i.e. delegation + placement would both "pass".
      exists: path => path.endsWith('/memory.max'),
      readFile: path => (path.endsWith('/memory.max') ? '16777216' : 'cpu io memory'),
    });
    expect(capabilities.cleanupSupported).toBe(true);
    expect(capabilities.memoryControllerSupported).toBe(false);
    // And the refusal must actually suppress the property, not just the flag.
    const wrapped = wrapCommandInSessionScope(
      'v1-host',
      '/usr/bin/node',
      ['cli.js'],
      { sessionMemoryMaxBytes: 5_000_000 },
      capabilities,
      {},
      undefined,
      SHARED,
    );
    expect(wrapped.args.some(arg => arg.includes('MemoryMax'))).toBe(false);
  });

  // REGRESSION GUARD (placement verification): delegation can look correct on
  // paper (cgroup.controllers lists memory and subtree_control enables it) while
  // the live scope does NOT land in a memory-enabled cgroup — here the probe
  // scope's memory.max is missing. Accepting delegation alone would claim an
  // unenforceable limit, so placement must be verified against the real scope.
  it('rejects paper-only delegation when the live scope has no memory.max', () => {
    const run = vi.fn((command: string, args: readonly string[]) => {
      if (command === 'systemd-run' || command === 'sh') return result(0);
      if (args.some(arg => arg.includes('-memory.scope'))) {
        return result(0, '/user.slice/user-1001.slice/user@1001.service/app.slice/probe.scope\n');
      }
      return result(0, '/user.slice/user-1001.slice/user@1001.service\n');
    });
    const capabilities = probeSessionScopeCapabilities({
      platform: 'linux',
      run,
      readlink: initialNamespace,
      // v2 root marker present and delegation readable, but the probe scope's
      // memory.max never materialises.
      exists: path => path === '/sys/fs/cgroup/cgroup.controllers',
      readFile: path => (path.endsWith('cgroup.controllers') ? 'cpu io memory' : 'cpu memory'),
    });
    expect(capabilities.cleanupSupported).toBe(true);
    expect(capabilities.memoryControllerSupported).toBe(false);
  });


  it('does not claim or apply MemoryMax when only scope cleanup works', () => {
    const wrapped = wrapCommandInSessionScope(
      'session-1',
      'node',
      ['cli.js'],
      { sessionMemoryMaxBytes: 5_000_000 },
      { cleanupSupported: true, memoryControllerSupported: false },
      {},
      undefined,
      SHARED,
    );
    expect(wrapped.args.some(arg => arg.includes('MemoryMax'))).toBe(false);
  });

  it('stops the exact session scope and never acts for adopted/non-Linux callers', () => {
    const run = vi.fn(() => result(0));
    stopSessionScope('ABC/123', { platform: 'linux', pidNamespace: SHARED, run });
    expect(run).toHaveBeenCalledWith('systemctl', [
      '--user', 'stop', sessionScopeUnitName('ABC/123'),
    ]);
    run.mockClear();
    stopSessionScope('ABC/123', { platform: 'darwin', run });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('releasing a session scope name before a fresh launch', () => {
  const sid = 'fc17c9ee-fa8f-46f4-93cc-58c7ac288696';
  const base = sessionScopeUnitName(sid);
  const linux = { platform: 'linux' as const, pidNamespace: SHARED };

  /** Fake systemctl: `states` is the ActiveState per unit; `stop`/`kill`
   *  either clear it or leave it (a payload that ignores the signal). */
  function fakeSystemd(opts: {
    states: Record<string, string>;
    stopClears?: boolean;
    killClears?: boolean;
    listed?: string[];
  }) {
    const calls: string[][] = [];
    const run = vi.fn((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      const [, verb, unit] = args;
      if (verb === 'list-units') return result(0, (opts.listed ?? []).map(u => `${u} loaded active running scope`).join('\n'));
      if (verb === 'stop') {
        if (opts.stopClears) delete opts.states[unit!];
        return result(opts.stopClears || !opts.states[unit!] ? 0 : 1);
      }
      if (verb === 'kill') {
        if (opts.killClears) delete opts.states[args[3]!];
        return result(0);
      }
      if (verb === 'reset-failed') { delete opts.states[unit!]; return result(0); }
      if (verb === 'show') {
        if (args.includes('--property=ControlGroup')) return result(0, `/user.slice/${unit}\n`);
        return result(0, `${opts.states[unit!] ?? 'inactive'}\n`);
      }
      return result(1);
    });
    return { run, calls };
  }

  /** Fake clock: sleeping advances it, so the SIGKILL wait loop and the
   *  release budget run instantly and deterministically. */
  function clock(start = 0) {
    let t = start;
    return { now: () => t, sleep: (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
  }

  const readFile = (path: string): string => {
    if (path.endsWith('/cgroup.procs')) return '4242\n';
    if (path === '/proc/4242/cmdline') return 'stuck-cli\0--serve\0';
    throw new Error(`unexpected read ${path}`);
  };

  it('reuses the deterministic name once stop really retired the old scope', () => {
    const { run, calls } = fakeSystemd({ states: { [base]: 'active' }, stopClears: true });
    expect(releaseSessionScopeForSpawn(sid, 3, { ...linux, run, readFile, ...clock() }))
      .toEqual({ unitName: base });
    expect(calls.some(c => c[2] === 'kill')).toBe(false);
  });

  it('SIGKILLs a scope that survives stop and then reuses the name', () => {
    const { run, calls } = fakeSystemd({ states: { [base]: 'active' }, killClears: true });
    expect(releaseSessionScopeForSpawn(sid, 3, { ...linux, run, readFile, ...clock() }))
      .toEqual({ unitName: base });
    expect(calls).toContainEqual(['systemctl', '--user', 'kill', '--signal=SIGKILL', base]);
  });

  it('never relaunches under a name that is still held, and reports what holds it', () => {
    const { run } = fakeSystemd({ states: { [base]: 'active' } });
    const release = releaseSessionScopeForSpawn(sid, 3, {
      ...linux, run, readFile, workerPid: 777, ...clock(),
    });
    expect(release.unitName).not.toBe(base);
    expect(release.unitName).toBe(sessionScopeFallbackName(777, 3));
    expect(release.blocked).toContain('4242 stuck-cli --serve');
    // Still recognised as this session's (and a botmux) scope everywhere else.
    expect(isSessionScopeUnitFor(sid, release.unitName)).toBe(true);
    expect(isBotmuxSessionScopeUnit(release.unitName)).toBe(true);
    const wrapped = wrapCommandInSessionScope(sid, 'cli', [], undefined,
      { cleanupSupported: true, memoryControllerSupported: false }, {}, release.unitName, SHARED);
    expect(wrapped.args).toContain(`--unit=${release.unitName}`);
    expect(sessionScopePayloadPid(99, {
      platform: 'linux',
      readFile: path => path.endsWith('/cmdline') ? `${wrapped.args.join('\0')}\0` : '123 ',
    })).toBe(123);
  });

  it('clears a failed unit so its name can be created again', () => {
    const { run, calls } = fakeSystemd({ states: { [base]: 'failed' } });
    expect(releaseSessionScopeForSpawn(sid, 1, { ...linux, run, readFile, ...clock() }))
      .toEqual({ unitName: base });
    expect(calls).toContainEqual(['systemctl', '--user', 'reset-failed', base]);
  });

  it('also stops fallback scopes an earlier worker of the same session left behind', () => {
    const stale = sessionScopeFallbackName(555, 2);
    const other = sessionScopeUnitName('0b2e5f6a-0000-4000-8000-000000000000').replace('.scope', '-p1g1.scope');
    const { run, calls } = fakeSystemd({ states: { [stale]: 'active' }, stopClears: true, listed: [stale, other] });
    releaseSessionScopeForSpawn(sid, 1, { ...linux, run, readFile, ...clock() });
    expect(calls).toContainEqual(['systemctl', '--user', 'stop', stale]);
    expect(calls).not.toContainEqual(['systemctl', '--user', 'stop', other]);
  });

  it('does nothing off Linux', () => {
    const run = vi.fn(() => result(0));
    expect(releaseSessionScopeForSpawn(sid, 1, { platform: 'darwin', run })).toEqual({ unitName: base });
    expect(stopAllSessionScopes(sid, { platform: 'darwin', run })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('launches under the name the release picked', () => {
    const { run } = fakeSystemd({ states: { [base]: 'active' } });
    const { scoped, release } = prepareSessionScopedLaunch(sid, 4, 'cli', ['--x'], undefined, {
      ...linux, run, readFile, workerPid: 9, ...clock(),
      capabilities: { cleanupSupported: true, memoryControllerSupported: false }, systemdEnv: undefined,
    });
    expect(release.unitName).toBe(sessionScopeFallbackName(9, 4));
    expect(scoped.unitName).toBe(release.unitName);
    expect(scoped.args).toContain(`--unit=${release.unitName}`);
    expect(scoped.args).not.toContain(`--unit=${base}`);
  });

  it('close / restart stops every scope of the session, also fallbacks it never launched itself', () => {
    // A worker that reattached a persistent pane never ran the launch that
    // picked the fallback name; systemd still knows it.
    const stale = sessionScopeFallbackName(1111, 1);
    const stuck = sessionScopeFallbackName(2222, 3);
    const { run, calls } = fakeSystemd({
      states: { [base]: 'active', [stale]: 'active', [stuck]: 'active' },
      listed: [stale, stuck],
    });
    // stop clears the deterministic and the first fallback; the second ignores it.
    run.mockImplementation(((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      if (args[1] === 'list-units') return result(0, `${stale} loaded active running x\n${stuck} loaded active running x\n`);
      if (args[1] === 'stop') return result(args[2] === stuck ? 1 : 0);
      return result(0);
    }) as any);
    expect(stopAllSessionScopes(sid, { ...linux, run })).toBe(true);
    expect(calls).toContainEqual(['systemctl', '--user', 'stop', stale]);
    expect(calls).toContainEqual(['systemctl', '--user', 'stop', stuck]);
    expect(calls).toContainEqual(['systemctl', '--user', 'kill', '--signal=SIGKILL', stuck]);
    expect(calls).toContainEqual(['systemctl', '--user', 'stop', base]);
  });

  it('bounds the synchronous cleanup: past the budget it launches under a fresh name instead of waiting', () => {
    const leftovers = [1, 2, 3, 4].map(g => sessionScopeFallbackName(500 + g, g));
    const time = clock();
    const calls: string[][] = [];
    const run = vi.fn((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      if (args[1] === 'list-units') return result(0, leftovers.map(u => `${u} loaded active running x`).join('\n'));
      // Every stop hangs until systemctl's own 5s timeout.
      if (args[1] === 'stop') { time.advance(5_000); return result(1); }
      if (args[1] === 'show') return result(0, args.includes('--property=ControlGroup') ? '' : 'active\n');
      return result(0);
    });
    const release = releaseSessionScopeForSpawn(sid, 7, {
      ...linux, run, readFile, workerPid: 42, now: time.now, sleep: time.sleep, budgetMs: 8_000,
    });
    expect(release.unitName).toBe(sessionScopeFallbackName(42, 7));
    expect(release.blocked).toContain('ran out of time');
    // Two leftovers fit in the budget (each also SIGKILLed); the rest wait for
    // the next launch rather than blocking this one.
    expect(calls.filter(c => c[2] === 'stop')).toHaveLength(2);
    expect(calls.filter(c => c[2] === 'kill')).toHaveLength(2);
    expect(time.now()).toBeLessThanOrEqual(10_000);
  });

  it('matches only this session\'s own scope names', () => {
    expect(isSessionScopeUnitFor(sid, base)).toBe(true);
    expect(isSessionScopeUnitFor(sid, base.replace('.scope', '-p12g3.scope'))).toBe(true);
    expect(isSessionScopeUnitFor(sid, base.replace('.scope', '-pxg3.scope'))).toBe(false);
    expect(isSessionScopeUnitFor(sid, base.replace('.scope', '-p12g3-x.scope'))).toBe(false);
    expect(isSessionScopeUnitFor(sid, sessionScopeUnitName(`${sid}0`))).toBe(false);
  });

  function sessionScopeFallbackName(pid: number, generation: number): string {
    return base.replace('.scope', `-p${pid}g${generation}.scope`);
  }
});


// A sandbox with its own PID namespace (bwrap --unshare-pid, /proc remounted)
// that still reaches the host's user bus: the PID a scope operation sends is
// resolved by user systemd in the HOST namespace, where the same number is an
// unrelated process that then lands in — and is stopped with — the scope.
describe('which PID namespace user systemd resolves PIDs in', () => {
  const BOX = 'pid:[4026532999]';
  const OTHER = 'pid:[4026533000]';

  /** This process, its /proc and the user bus as seen from inside. `self` and
   *  the PIDs in `namespaces` are what /proc/<pid>/ns/pid reads here. */
  function world(opts: {
    self?: string;
    nspid?: string;
    busStatus?: ReturnType<typeof result>;
    managerReply?: ReturnType<typeof result>;
    namespaces?: Record<string, string>;
    systemd?: (command: string, args: readonly string[]) => ReturnType<typeof result>;
  } = {}) {
    const namespaces: Record<string, string> = { self: opts.self ?? BOX, ...opts.namespaces };
    const calls: string[][] = [];
    const run = vi.fn((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      if (command === 'busctl' && args.includes('status')) return opts.busStatus ?? result(0, 'Unique=:1.42\nUID=0\n');
      if (command === 'busctl' && args.includes('GetConnectionUnixProcessID')) return opts.managerReply ?? result(0, 'u 1234\n');
      return opts.systemd?.(command, args) ?? result(1, '', `unexpected ${command}`);
    });
    return {
      calls,
      run,
      options: {
        platform: 'linux' as const,
        run,
        readlink: (path: string) => {
          const ns = namespaces[/^\/proc\/([^/]+)\/ns\/pid$/.exec(path)?.[1] ?? ''];
          if (!ns) throw new Error(`ENOENT: ${path}`);
          return ns;
        },
        readFile: (path: string) => {
          if (path === '/proc/self/status' && opts.nspid !== '') return `Name:\tnode\nNSpid:\t${opts.nspid ?? '42'}\n`;
          throw new Error(`ENOENT: ${path}`);
        },
      },
    };
  }

  /** The isolated sandbox the scopes were moving host processes from: the bus
   *  peer is outside (no PID), and a local process happens to carry the PID
   *  number the host's user systemd has, so its /proc entry reads as ours. */
  const isolated = () => world({ namespaces: { 1234: BOX } });
  const hostSystemd = (command: string, args: readonly string[]) => {
    if (command === 'systemctl' && args.includes('show')) return result(0, '/user.slice/user-0.slice/user@0.service\n');
    return result(0);
  };

  it('trusts the initial PID namespace without asking anyone', () => {
    const host = world({ self: INITIAL_PID_NAMESPACE });
    expect(probeSystemdPidNamespace(host.options)).toEqual(SHARED);
    expect(host.run).not.toHaveBeenCalled();
  });

  /** A container running its own user manager, which socket-activates its bus:
   *  the bus peer and org.freedesktop.systemd1 are both PID 57, in this namespace. */
  const container = { busStatus: result(0, 'PID=57\nUID=0\n'), managerReply: result(0, 'u 57\n'), namespaces: { 57: BOX } };

  it('accepts an inner namespace only when the user bus and user systemd are both in it', () => {
    expect(probeSystemdPidNamespace(world(container).options)).toEqual({ shared: true, basis: 'user-bus', namespace: BOX });
  });

  it('refuses the isolated sandbox even though a local process carries user systemd\'s PID number', () => {
    expect(probeSystemdPidNamespace(isolated().options)).toEqual({ shared: false, reason: expect.any(String) });
  });

  // A proxy in this namespace relays the host's user bus: the peer (60) is
  // local, the bus names user systemd by its host PID (1234), and a local
  // process happens to carry that number too.
  it('refuses a user bus that a local proxy relays from outside', () => {
    const relayed = world({ busStatus: result(0, 'PID=60\n'), namespaces: { 60: BOX, 1234: BOX } });
    expect(probeSystemdPidNamespace(relayed.options)).toEqual({ shared: false, reason: expect.stringContaining('not served by user systemd') });
  });

  // Each case breaks exactly one link of the container above.
  it.each<[string, Parameters<typeof world>[0] & { platform?: NodeJS.Platform }]>([
    ['not on Linux', { ...container, platform: 'darwin' as const }],
    ['own namespace unreadable', { ...container, self: '' }],
    ['/proc numbers an outer namespace (two NSpid columns)', { ...container, nspid: '9876\t42' }],
    ['no NSpid line', { ...container, nspid: '' }],
    ['busctl missing', { ...container, busStatus: { status: null, stdout: '', stderr: '', error: new Error('spawnSync busctl ENOENT') } }],
    ['bus peer outside (no PID)', { ...container, busStatus: result(0, 'UID=0\n') }],
    ['bus peer in another namespace', { ...container, namespaces: { 57: OTHER } }],
    ['bus peer namespace unreadable', { ...container, namespaces: {} }],
    ['bus refuses to name user systemd', { ...container, managerReply: result(1, '', 'Name has no owner') }],
    ['bus names no PID for user systemd', { ...container, managerReply: result(0, 'u 0\n') }],
    ['bus served by a standalone daemon, not user systemd', { ...container, managerReply: result(0, 'u 60\n'), namespaces: { 57: BOX, 60: BOX } }],
  ])('counts a check that cannot be completed as not shared: %s', (_label, { platform, ...opts }) => {
    const { options } = world(opts);
    expect(probeSystemdPidNamespace({ ...options, platform: platform ?? options.platform }))
      .toEqual({ shared: false, reason: expect.any(String) });
  });

  it('keeps a shared verdict for the life of the process and re-checks a refusal after a minute', () => {
    __testOnly_resetSessionScopeCapabilityCache();
    const verdicts: SystemdPidNamespace[] = [NOT_SHARED, { shared: true, basis: 'user-bus', namespace: BOX }, NOT_SHARED];
    const probe = vi.fn(() => verdicts.shift()!);
    let t = 1_000;
    const now = () => t;
    try {
      expect(systemdPidNamespace(probe, now)).toEqual(NOT_SHARED);
      t += 59_000;
      expect(systemdPidNamespace(probe, now)).toEqual(NOT_SHARED);
      expect(probe).toHaveBeenCalledTimes(1);
      t += 2_000;
      expect(systemdPidNamespace(probe, now)).toEqual({ shared: true, basis: 'user-bus', namespace: BOX });
      // A later bus hiccup must not strand the scopes created meanwhile.
      t += 24 * 3_600_000;
      expect(systemdPidNamespace(probe, now)).toEqual({ shared: true, basis: 'user-bus', namespace: BOX });
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      __testOnly_resetSessionScopeCapabilityCache();
    }
  });

  describe('scope capability probe (also `botmux worker-budget status`)', () => {
    it('probes with a real scope where user systemd shares the namespace', () => {
      for (const where of [world({ self: INITIAL_PID_NAMESPACE, systemd: hostSystemd }),
        world({ busStatus: result(0, 'PID=57\n'), managerReply: result(0, 'u 57\n'), namespaces: { 57: BOX }, systemd: hostSystemd })]) {
        expect(probeSessionScopeCapabilities({ ...where.options, exists: () => false })).toMatchObject({ cleanupSupported: true });
        expect(where.calls.some(([command]) => command === 'systemd-run')).toBe(true);
      }
    });

    it.each([
      ['in another namespace', isolated],
      ['when the check fails', () => world({ self: '', systemd: hostSystemd })],
    ])('hands user systemd no PID %s and says why', (_label, make) => {
      const where = make();
      const capabilities = probeSessionScopeCapabilities({ ...where.options, exists: () => true });
      expect(capabilities).toEqual({ cleanupSupported: false, memoryControllerSupported: false, reason: expect.any(String) });
      expect(where.calls.filter(([command]) => command !== 'busctl')).toEqual([]);
    });
  });

  describe('MemoryMax placement probe', () => {
    function memoryProbe(pidNamespace: SystemdPidNamespace) {
      const run = vi.fn((command: string, args: readonly string[]) => (command === 'systemctl' && args.includes('show')
        ? result(0, '/user.slice/user-0.slice/user@0.service/app.slice/probe-memory.scope\n')
        : result(0)));
      const verified = memoryControllerPlacementVerified('botmux-scope-probe-1', {
        run, exists: () => true, readFile: () => '16777216\n', pidNamespace,
      });
      return { verified, run };
    }

    it('starts and stops its 16 MB scope where user systemd shares the namespace', () => {
      const { verified, run } = memoryProbe(SHARED);
      expect(verified).toBe(true);
      expect(run.mock.calls.map(([command]) => command)).toContain('sh');
      expect(run).toHaveBeenCalledWith('systemctl', ['--user', 'stop', 'botmux-scope-probe-1-memory.scope']);
    });

    it.each([['in another namespace', NOT_SHARED], ['when the check failed', FAILED_CHECK]])(
      'starts and stops nothing %s', (_label, pidNamespace) => {
        const { verified, run } = memoryProbe(pidNamespace);
        expect(verified).toBe(false);
        expect(run).not.toHaveBeenCalled();
      },
    );
  });

  describe('launch command', () => {
    const scopeWorks = { cleanupSupported: true, memoryControllerSupported: true };

    it('wraps the CLI in systemd-run where user systemd shares the namespace', () => {
      const wrapped = wrapCommandInSessionScope('s1', 'cli', ['--x'], { sessionMemoryMaxBytes: 5_000_000 }, scopeWorks, {}, undefined, SHARED);
      expect(wrapped.args).toContain('systemd-run');
      expect(wrapped.unitName).toBe(sessionScopeUnitName('s1'));
    });

    it.each([['in another namespace', NOT_SHARED], ['when the check failed', FAILED_CHECK]])(
      'launches the CLI unscoped %s and says why', (_label, pidNamespace) => {
        const wrapped = wrapCommandInSessionScope('s1', 'cli', ['--x'], { sessionMemoryMaxBytes: 5_000_000 }, scopeWorks, {}, undefined, pidNamespace);
        expect(wrapped).toEqual({
          bin: 'cli',
          args: ['--x'],
          capabilities: { cleanupSupported: false, memoryControllerSupported: false, reason: expect.any(String) },
        });
      },
    );

    it.each([['in another namespace', NOT_SHARED], ['when the check failed', FAILED_CHECK]])(
      'a fresh launch neither retires nor creates scopes %s', (_label, pidNamespace) => {
        const run = vi.fn(() => result(0));
        const { scoped, release } = prepareSessionScopedLaunch('s1', 2, 'cli', ['--x'], undefined, {
          platform: 'linux', pidNamespace, run, capabilities: scopeWorks, systemdEnv: {},
        });
        expect(release).toEqual({ unitName: sessionScopeUnitName('s1') });
        expect(scoped.bin).toBe('cli');
        expect(scoped.args).toEqual(['--x']);
        expect(run).not.toHaveBeenCalled();
      },
    );
  });
});

describe('a scope holding processes botmux did not start', () => {
  const sid = '5d0c4a52-41a8-4c55-9d2e-3a7f1c0e9b61';
  const base = sessionScopeUnitName(sid);
  const controlGroup = `/user.slice/user-0.slice/user@0.service/app.slice/${base}`;
  /** The scope became active one day after boot. */
  const SCOPE_STARTED_S = 86_400;
  const linux = { platform: 'linux' as const, pidNamespace: SHARED };

  /** `cmdline` as a string splits on spaces; `ppid` defaults to 1. */
  type Proc = { startedS: number; cmdline: string | string[]; ppid?: number };
  const chronyd: Proc = { startedS: 4, cmdline: '/usr/sbin/chronyd -F 2' };
  /** The AI CLI: systemd-run attaches first and execs it, seconds before the scope is active. */
  const cliStartedEarly: Proc = { startedS: SCOPE_STARTED_S - 9, cmdline: 'claude --resume' };
  const cliChild: Proc = { startedS: SCOPE_STARTED_S + 600, cmdline: 'node mcp-server.js' };
  /** The pane's scope supervisor started for `unit`; it stays outside the scope. */
  const supervisorFor = (unit: string): Proc => ({
    startedS: SCOPE_STARTED_S - 700,
    cmdline: wrapCommandInSessionScope(sid, 'claude', ['--resume'], undefined,
      { cleanupSupported: true, memoryControllerSupported: false }, {}, unit, linux.pidNamespace).args,
  });

  function statLine(pid: string, proc: Proc): string {
    return `${pid} (tmux: server) S ${proc.ppid ?? 1} ${pid} ${pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${proc.startedS * 100} 1024 64\n`;
  }

  function scopeWorld(procs: Record<string, Proc>, opts: {
    shown?: ReturnType<typeof result>;
    cgroupRoot?: string;
    listed?: string[];
    /** Visible in /proc but not in the scope. */
    outside?: Record<string, Proc>;
  } = {}) {
    const calls: string[][] = [];
    const run = vi.fn((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      if (args[1] === 'list-units') return result(0, (opts.listed ?? []).map(unit => `${unit} loaded active running x`).join('\n'));
      if (args[1] === 'show' && args.includes('--property=ActiveEnterTimestampMonotonic')) {
        return opts.shown ?? result(0, `LoadState=loaded\nActiveEnterTimestampMonotonic=${SCOPE_STARTED_S * 1_000_000}\nControlGroup=${controlGroup}\n`);
      }
      if (args[1] === 'show') return result(0, args.includes('--property=ControlGroup') ? `${controlGroup}\n` : 'active\n');
      return result(0);
    });
    const readFile = (path: string): string => {
      if (path === `${opts.cgroupRoot ?? '/sys/fs/cgroup'}${controlGroup}/cgroup.procs`) return `${Object.keys(procs).join('\n')}\n`;
      const [, pid, file] = /^\/proc\/(\d+)\/(stat|cmdline)$/.exec(path) ?? [];
      const proc = pid ? procs[pid] ?? opts.outside?.[pid] : undefined;
      if (!proc) throw new Error(`ENOENT: ${path}`);
      if (file === 'stat') return statLine(pid!, proc);
      return `${(typeof proc.cmdline === 'string' ? proc.cmdline.split(' ') : proc.cmdline).join('\0')}\0`;
    };
    const warn = vi.fn();
    const verbs = (verb: string) => calls.filter(call => call[2] === verb);
    return { run, readFile, warn, verbs };
  }

  it('leaves it running and says which processes are foreign', () => {
    const scope = scopeWorld({ 812: chronyd, 4242: cliStartedEarly });
    expect(stopSessionScope(sid, { ...linux, run: scope.run, readFile: scope.readFile, warn: scope.warn })).toBe(false);
    expect(scope.verbs('stop')).toEqual([]);
    expect(scope.warn).toHaveBeenCalledTimes(1);
    expect(scope.warn.mock.calls[0][0]).toContain('812 /usr/sbin/chronyd -F 2');
    expect(scope.warn.mock.calls[0][0]).not.toContain('4242');
  });

  it('finds them through the cgroup-v1 systemd hierarchy too', () => {
    const scope = scopeWorld({ 812: chronyd }, { cgroupRoot: '/sys/fs/cgroup/systemd' });
    expect(stopSessionScope(sid, { ...linux, run: scope.run, readFile: scope.readFile, warn: scope.warn })).toBe(false);
    expect(scope.verbs('stop')).toEqual([]);
  });

  it('still stops a scope whose CLI started seconds before the scope did', () => {
    const scope = scopeWorld({ 4242: cliStartedEarly, 4300: cliChild });
    expect(stopSessionScope(sid, { ...linux, run: scope.run, readFile: scope.readFile, warn: scope.warn })).toBe(true);
    expect(scope.verbs('stop')).toEqual([['systemctl', '--user', 'stop', base]]);
    expect(scope.warn).not.toHaveBeenCalled();
  });

  it('leaves it running when a process predates the scope by ten minutes', () => {
    const postgres: Proc = { startedS: SCOPE_STARTED_S - 600, cmdline: '/usr/lib/postgresql/15/bin/postgres -D /var/lib/postgresql/15/main' };
    const scope = scopeWorld({ 5150: postgres, 4242: cliStartedEarly });
    expect(stopSessionScope(sid, { ...linux, run: scope.run, readFile: scope.readFile, warn: scope.warn })).toBe(false);
    expect(scope.verbs('stop')).toEqual([]);
    expect(scope.warn.mock.calls[0][0]).toContain('5150 /usr/lib/postgresql/15/bin/postgres');
  });

  it('still stops a scope that user systemd took minutes to start: its CLI is the child of this unit\'s supervisor', () => {
    const cliKeptWaiting: Proc = { startedS: SCOPE_STARTED_S - 600, cmdline: 'claude --resume', ppid: 4100 };
    const scope = scopeWorld({ 4242: cliKeptWaiting, 4300: cliChild }, { outside: { 4100: supervisorFor(base) } });
    expect(stopSessionScope(sid, { ...linux, run: scope.run, readFile: scope.readFile, warn: scope.warn })).toBe(true);
    expect(scope.verbs('stop')).toEqual([['systemctl', '--user', 'stop', base]]);
    expect(scope.warn).not.toHaveBeenCalled();
  });

  it('takes only the supervisor of this very unit as proof', () => {
    const childOfOther: Proc = { startedS: SCOPE_STARTED_S - 600, cmdline: 'claude --resume', ppid: 4100 };
    const scope = scopeWorld({ 4242: childOfOther }, { outside: { 4100: supervisorFor(base.replace('.scope', '-p555g2.scope')) } });
    expect(stopSessionScope(sid, { ...linux, run: scope.run, readFile: scope.readFile, warn: scope.warn })).toBe(false);
    expect(scope.verbs('stop')).toEqual([]);
  });

  it.each([
    ['systemd does not show the unit', { shown: result(1, '', 'Failed to connect to bus') }, { 812: chronyd }],
    ['the scope has no start time', { shown: result(0, `ActiveEnterTimestampMonotonic=0\nControlGroup=${controlGroup}\n`) }, { 812: chronyd }],
    ['its cgroup is unreadable', { cgroupRoot: '/nonexistent' }, { 812: chronyd }],
    ['the process exited meanwhile', {}, {}],
  ])('stops as before when that cannot be told: %s', (_label, opts, procs) => {
    const scope = scopeWorld(procs, opts);
    stopSessionScope(sid, { ...linux, run: scope.run, readFile: scope.readFile, warn: scope.warn });
    expect(scope.verbs('stop')).toEqual([['systemctl', '--user', 'stop', base]]);
    expect(scope.warn).not.toHaveBeenCalled();
  });

  // The usual case at a fresh launch: the previous scope is long gone. The
  // guard's one `show` answers it, so no stop, kill or ActiveState query follows.
  it('neither stops nor kills a scope systemd does not know, and reuses its name at once', () => {
    const gone = result(0, 'LoadState=not-found\nActiveEnterTimestampMonotonic=0\nControlGroup=\n');
    const fallback = base.replace('.scope', '-p555g2.scope');
    const scope = scopeWorld({}, { shown: gone, listed: [fallback] });
    const options = { ...linux, run: scope.run, readFile: scope.readFile, warn: scope.warn };
    expect(stopSessionScope(sid, options)).toBe(false);
    expect(stopAllSessionScopes(sid, options)).toBe(false);
    scope.run.mockClear();
    expect(releaseSessionScopeForSpawn(sid, 2, options)).toEqual({ unitName: base });
    expect(scope.run.mock.calls.map(([, args]) => args[1])).toEqual(['list-units', 'show', 'show']);
    expect([...scope.verbs('stop'), ...scope.verbs('kill')]).toEqual([]);
  });

  it('a fresh launch moves to a new name instead of killing what holds the old one', () => {
    const scope = scopeWorld({ 812: chronyd, 4242: cliStartedEarly });
    let t = 0;
    const release = releaseSessionScopeForSpawn(sid, 3, {
      ...linux, run: scope.run, readFile: scope.readFile, warn: scope.warn, workerPid: 777,
      now: () => t, sleep: ms => { t += ms; },
    });
    expect(release.unitName).toBe(base.replace('.scope', '-p777g3.scope'));
    expect(release.blocked).toContain('812 /usr/sbin/chronyd -F 2');
    expect(scope.verbs('stop')).toEqual([]);
    expect(scope.verbs('kill')).toEqual([]);
  });

  it('close / restart leaves such scopes running, without SIGKILL', () => {
    const fallback = base.replace('.scope', '-p555g2.scope');
    const scope = scopeWorld({ 812: chronyd }, { listed: [fallback] });
    expect(stopAllSessionScopes(sid, { ...linux, run: scope.run, readFile: scope.readFile, warn: scope.warn })).toBe(false);
    expect(scope.verbs('stop')).toEqual([]);
    expect(scope.verbs('kill')).toEqual([]);
    expect(scope.warn).toHaveBeenCalledTimes(2);
  });

  it.each([['in another namespace', NOT_SHARED], ['when the check failed', FAILED_CHECK]])(
    'touches no scope at all %s', (_label, pidNamespace) => {
      const scope = scopeWorld({ 4242: cliChild }, { listed: [base.replace('.scope', '-p555g2.scope')] });
      const options = { platform: 'linux' as const, pidNamespace, run: scope.run, readFile: scope.readFile, warn: scope.warn };
      expect(stopSessionScope(sid, options)).toBe(false);
      expect(stopAllSessionScopes(sid, options)).toBe(false);
      expect(releaseSessionScopeForSpawn(sid, 1, options)).toEqual({ unitName: base });
      expect(scope.run).not.toHaveBeenCalled();
    },
  );
});
