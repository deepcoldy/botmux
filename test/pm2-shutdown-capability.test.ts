import { describe, expect, it, vi } from 'vitest';
import { SUPERVISOR_SHUTDOWN_PROTOCOL } from '../src/core/supervisor-shutdown-protocol.js';
import {
  assertPm2DaemonShutdownCapabilitiesIn,
  type Pm2ShutdownCapabilityRuntime,
} from '../src/cli/pm2-shutdown-capability.js';

function descriptor(
  pid: number,
  protocol: string | null = SUPERVISOR_SHUTDOWN_PROTOCOL,
): string {
  return JSON.stringify({
    larkAppId: `app-${pid}`,
    ipcPort: 7_900 + pid,
    bootInstanceId: `boot-${pid}`,
    pid,
    processStartIdentity: `birth-${pid}`,
    lastHeartbeat: 100_000,
    ...(protocol ? { supervisorShutdownProtocol: protocol } : {}),
  });
}

function runtime(
  files: Record<string, string>,
  alive = new Set([101, 202]),
): Pm2ShutdownCapabilityRuntime {
  return {
    now: () => 100_000,
    exists: () => true,
    readdir: () => Object.keys(files),
    read: path => files[path.split('/').pop()!]!,
    mtime: () => 100_000,
    isAlive: pid => alive.has(pid),
    readStartIdentity: pid => alive.has(pid) ? `birth-${pid}` : undefined,
  };
}

describe('in-memory daemon shutdown capability rollout fence', () => {
  it('accepts one fresh exact-protocol descriptor for every live daemon target', () => {
    expect(() => assertPm2DaemonShutdownCapabilitiesIn(
      'restart',
      [{ name: 'botmux-a', pid: 101 }, { name: 'botmux-b', pid: 202 }],
      '/registry',
      runtime({ 'a.json': descriptor(101), 'b.json': descriptor(202) }),
    )).not.toThrow();
  });

  it('blocks an old in-memory daemon lacking the new capability before signal', () => {
    const signal = vi.fn();
    expect(() => {
      assertPm2DaemonShutdownCapabilitiesIn(
        'restart',
        [{ name: 'botmux-a', pid: 101 }],
        '/registry',
        runtime({ 'a.json': descriptor(101, null) }),
      );
      signal(101);
    }).toThrow(/does not attest.*first-upgrade boundary.*Session\/Riff workload is idle.*must not be reported as applied/);
    expect(signal).not.toHaveBeenCalled();
  });

  it('fails closed when a live target has no fresh matching descriptor', () => {
    expect(() => assertPm2DaemonShutdownCapabilitiesIn(
      'stop',
      [{ name: 'botmux-a', pid: 101 }],
      '/registry',
      runtime({ 'other.json': descriptor(202) }),
    )).toThrow(/botmux-a\/101 has no matching fresh daemon descriptor/);
  });

  it('rejects duplicate fresh descriptors for one live PID', () => {
    expect(() => assertPm2DaemonShutdownCapabilitiesIn(
      'restart',
      [{ name: 'botmux-a', pid: 101 }],
      '/registry',
      runtime({ 'a.json': descriptor(101), 'copy.json': descriptor(101) }),
    )).toThrow(/multiple fresh descriptors claim live PID 101/);
  });

  it('rejects a stale capability when the PID now belongs to a new birth', () => {
    const reused = runtime({ 'a.json': descriptor(101) });
    reused.readStartIdentity = () => 'birth-successor';
    expect(() => assertPm2DaemonShutdownCapabilitiesIn(
      'restart-immediately-before-signal',
      [{ name: 'botmux-a', pid: 101 }],
      '/registry',
      reused,
    )).toThrow(/process-start identity does not match its descriptor/);
  });

  it('does not require capability from a generation proven already dead', () => {
    expect(() => assertPm2DaemonShutdownCapabilitiesIn(
      'restart',
      [{ name: 'botmux-a', pid: 101 }],
      '/registry',
      runtime({}, new Set()),
    )).not.toThrow();
  });
});
