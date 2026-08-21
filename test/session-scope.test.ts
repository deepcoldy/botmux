import { describe, expect, it, vi } from 'vitest';
import {
  probeSessionScopeCapabilities,
  sessionScopeUnitName,
  stopSessionScope,
  wrapCommandInSessionScope,
} from '../src/core/session-scope.js';

function result(status: number, stdout = '', stderr = ''): any {
  return { status, stdout, stderr, error: undefined };
}

describe('owned session systemd scope', () => {
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
    );
    expect(wrapped.bin).toBe('systemd-run');
    expect(wrapped.args).toContain('--property=MemoryMax=5000000');
    expect(wrapped.args.slice(-3)).toEqual(['--', '/usr/bin/node', 'cli.js']);
    expect(wrapped.unitName).toBe('botmux-session-abc-123.scope');
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
