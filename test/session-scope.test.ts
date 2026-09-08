import { describe, expect, it, vi } from 'vitest';
import {
  probeSessionScopeCapabilities,
  sessionScopeUnitName,
  stopSessionScope,
  userSystemdBusEnv,
  wrapCommandInSessionScope,
} from '../src/core/session-scope.js';

function result(status: number, stdout = '', stderr = ''): any {
  return { status, stdout, stderr, error: undefined };
}

describe('owned session systemd scope', () => {
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
    expect(wrapped.args.slice(0, 3)).toEqual([
      'XDG_RUNTIME_DIR=/run/user/1001',
      'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus',
      'systemd-run',
    ]);
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
