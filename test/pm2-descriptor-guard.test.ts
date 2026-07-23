import { describe, expect, it, vi } from 'vitest';
import {
  assertNoUnregisteredLiveDaemonDescriptorsIn,
  type Pm2DescriptorGuardRuntime,
} from '../src/cli/pm2-descriptor-guard.js';

function runtime(
  raw: string,
  options: { alive?: boolean; mtime?: number; startIdentity?: string } = {},
): Pm2DescriptorGuardRuntime {
  return {
    now: () => 100_000,
    exists: () => true,
    readdir: () => ['app.json'],
    read: () => raw,
    mtime: () => options.mtime ?? 100_000,
    isAlive: () => options.alive ?? true,
    readStartIdentity: () => options.startIdentity ?? 'birth-77',
  };
}

describe('PM2/live-daemon descriptor reconciliation', () => {
  it('blocks a mutation when jlist is empty and a fresh descriptor is semantic garbage', () => {
    const mutate = vi.fn();
    expect(() => {
      assertNoUnregisteredLiveDaemonDescriptorsIn('start', [], '/registry', runtime('{}'));
      mutate();
    }).toThrow(/fresh daemon descriptor.*invalid pid\/app id\/heartbeat/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('blocks a live descriptor PID absent from the PM2 projection', () => {
    const raw = JSON.stringify({ larkAppId: 'app', pid: 77, lastHeartbeat: 100_000 });
    expect(() => assertNoUnregisteredLiveDaemonDescriptorsIn(
      'restart', [], '/registry', runtime(raw),
    )).toThrow(/app:77/);
  });

  it('accepts a valid fresh descriptor only when its live PID is registered', () => {
    const raw = JSON.stringify({ larkAppId: 'app', pid: 77, lastHeartbeat: 100_000 });
    expect(() => assertNoUnregisteredLiveDaemonDescriptorsIn(
      'stop', [{ pid: 77 }], '/registry', runtime(raw),
    )).not.toThrow();
  });

  it('ignores stale semantic garbage', () => {
    expect(() => assertNoUnregisteredLiveDaemonDescriptorsIn(
      'start', [], '/registry', runtime('{}', { mtime: 0 }),
    )).not.toThrow();
  });

  it('blocks a stale descriptor whose live PID still has the exact recorded birth', () => {
    const raw = JSON.stringify({
      larkAppId: 'app',
      pid: 77,
      processStartIdentity: 'birth-77',
      lastHeartbeat: 0,
    });
    expect(() => assertNoUnregisteredLiveDaemonDescriptorsIn(
      'start', [], '/registry', runtime(raw, { mtime: 0 }),
    )).toThrow(/daemon descriptor PID\(s\).*live but absent.*app:77/);
  });

  it('ignores a stale descriptor after proving its recorded PID is dead', () => {
    const raw = JSON.stringify({
      larkAppId: 'app',
      pid: 77,
      processStartIdentity: 'birth-77',
      lastHeartbeat: 0,
    });
    expect(() => assertNoUnregisteredLiveDaemonDescriptorsIn(
      'start', [], '/registry', runtime(raw, { alive: false, mtime: 0 }),
    )).not.toThrow();
  });

  it('ignores a stale descriptor after proving the PID belongs to a different birth', () => {
    const raw = JSON.stringify({
      larkAppId: 'app',
      pid: 77,
      processStartIdentity: 'birth-77',
      lastHeartbeat: 0,
    });
    expect(() => assertNoUnregisteredLiveDaemonDescriptorsIn(
      'start', [], '/registry', runtime(raw, { mtime: 0, startIdentity: 'birth-successor' }),
    )).not.toThrow();
  });

  it('fails closed when an old-format stale descriptor still names a live PID', () => {
    const raw = JSON.stringify({ larkAppId: 'app', pid: 77, lastHeartbeat: 0 });
    expect(() => assertNoUnregisteredLiveDaemonDescriptorsIn(
      'start', [], '/registry', runtime(raw, { mtime: 0 }),
    )).toThrow(/stale daemon descriptor.*live PID 77.*no process-start identity/);
  });
});
