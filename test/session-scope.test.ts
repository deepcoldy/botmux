import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  isBotmuxSessionScopeUnit,
  isSessionScopeUnitFor,
  probeSessionScopeCapabilities,
  prepareSessionScopedLaunch,
  releaseSessionScopeForSpawn,
  stopAllSessionScopes,
  sessionScopePayloadPid,
  sessionScopeUnitName,
  stopSessionScope,
  userSystemdBusEnv,
  wrapCommandInSessionScope,
} from '../src/core/session-scope.js';

function result(status: number, stdout = '', stderr = ''): any {
  return { status, stdout, stderr, error: undefined };
}

describe('owned session systemd scope', () => {
  it('resolves only the fixed supervisor with one observable foreground child', () => {
    const wrapped = wrapCommandInSessionScope('probe', 'cli', [], undefined,
      { cleanupSupported: true, memoryControllerSupported: false }, {});
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

  it.skipIf(process.platform === 'win32')('keeps a parent outside the scope while preserving stdin, argv and exit status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-scope-parent-'));
    try {
      // Model systemd-run --scope's exec: the payload keeps its PID. A tmux
      // server may migrate its original pane PID after this exec has happened.
      writeFileSync(join(dir, 'systemd-run'), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
      const argument = 'literal spaces; $(must-not-run)';
      const wrapped = wrapCommandInSessionScope('parent-boundary', '/bin/sh', [
        '-c', 'IFS= read -r line; printf "%s\\n%s\\n%s\\n" "$$" "$line" "$1"; exit 7', '_', argument,
      ], undefined, { cleanupSupported: true, memoryControllerSupported: false }, {});
      const child = spawnSync(wrapped.bin, wrapped.args, {
        env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` },
        input: 'interactive input\n', encoding: 'utf8', timeout: 5_000,
      });
      expect(child.status, child.stderr).toBe(7);
      const [payloadPid, input, receivedArgument] = child.stdout.trimEnd().split('\n');
      expect(Number(payloadPid)).toBeGreaterThan(1);
      expect(Number(payloadPid)).not.toBe(child.pid);
      expect(input).toBe('interactive input');
      expect(receivedArgument).toBe(argument);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('leaves commands unchanged when session scopes are unavailable', () => {
    const capabilities = { cleanupSupported: false, memoryControllerSupported: false };
    expect(wrapCommandInSessionScope('plain', 'cli', ['argument'], undefined, capabilities)).toEqual({
      bin: 'cli', args: ['argument'], capabilities,
    });
  });

  it('derives the canonical user bus environment from a verified socket', () => {
    const isSocket = vi.fn((path: string) => path === '/run/user/1001/bus');
    expect(userSystemdBusEnv({ platform: 'linux', uid: 1001, isSocket })).toEqual({
      XDG_RUNTIME_DIR: '/run/user/1001',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1001/bus',
    });
    expect(isSocket).toHaveBeenCalledWith('/run/user/1001/bus');
    expect(userSystemdBusEnv({ platform: 'darwin', uid: 1001, isSocket })).toBeUndefined();
    expect(userSystemdBusEnv({ platform: 'linux', uid: 1001, isSocket: () => false })).toBeUndefined();
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
    );
    expect(wrapped.args.some(arg => arg.includes('MemoryMax'))).toBe(false);
  });

  it('stops the exact session scope and never acts for adopted/non-Linux callers', () => {
    const run = vi.fn(() => result(0));
    stopSessionScope('ABC/123', { platform: 'linux', run });
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
    expect(releaseSessionScopeForSpawn(sid, 3, { platform: 'linux', run, readFile, ...clock() }))
      .toEqual({ unitName: base });
    expect(calls.some(c => c[2] === 'kill')).toBe(false);
  });

  it('SIGKILLs a scope that survives stop and then reuses the name', () => {
    const { run, calls } = fakeSystemd({ states: { [base]: 'active' }, killClears: true });
    expect(releaseSessionScopeForSpawn(sid, 3, { platform: 'linux', run, readFile, ...clock() }))
      .toEqual({ unitName: base });
    expect(calls).toContainEqual(['systemctl', '--user', 'kill', '--signal=SIGKILL', base]);
  });

  it('never relaunches under a name that is still held, and reports what holds it', () => {
    const { run } = fakeSystemd({ states: { [base]: 'active' } });
    const release = releaseSessionScopeForSpawn(sid, 3, {
      platform: 'linux', run, readFile, workerPid: 777, ...clock(),
    });
    expect(release.unitName).not.toBe(base);
    expect(release.unitName).toBe(sessionScopeFallbackName(777, 3));
    expect(release.blocked).toContain('4242 stuck-cli --serve');
    // Still recognised as this session's (and a botmux) scope everywhere else.
    expect(isSessionScopeUnitFor(sid, release.unitName)).toBe(true);
    expect(isBotmuxSessionScopeUnit(release.unitName)).toBe(true);
    const wrapped = wrapCommandInSessionScope(sid, 'cli', [], undefined,
      { cleanupSupported: true, memoryControllerSupported: false }, {}, release.unitName);
    expect(wrapped.args).toContain(`--unit=${release.unitName}`);
    expect(sessionScopePayloadPid(99, {
      platform: 'linux',
      readFile: path => path.endsWith('/cmdline') ? `${wrapped.args.join('\0')}\0` : '123 ',
    })).toBe(123);
  });

  it('clears a failed unit so its name can be created again', () => {
    const { run, calls } = fakeSystemd({ states: { [base]: 'failed' } });
    expect(releaseSessionScopeForSpawn(sid, 1, { platform: 'linux', run, readFile, ...clock() }))
      .toEqual({ unitName: base });
    expect(calls).toContainEqual(['systemctl', '--user', 'reset-failed', base]);
  });

  it('also stops fallback scopes an earlier worker of the same session left behind', () => {
    const stale = sessionScopeFallbackName(555, 2);
    const other = sessionScopeUnitName('0b2e5f6a-0000-4000-8000-000000000000').replace('.scope', '-p1g1.scope');
    const { run, calls } = fakeSystemd({ states: { [stale]: 'active' }, stopClears: true, listed: [stale, other] });
    releaseSessionScopeForSpawn(sid, 1, { platform: 'linux', run, readFile, ...clock() });
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
      platform: 'linux', run, readFile, workerPid: 9, ...clock(),
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
    expect(stopAllSessionScopes(sid, { platform: 'linux', run })).toBe(true);
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
      platform: 'linux', run, readFile, workerPid: 42, now: time.now, sleep: time.sleep, budgetMs: 8_000,
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

