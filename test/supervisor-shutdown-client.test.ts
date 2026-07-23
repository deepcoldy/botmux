import { describe, expect, it, vi } from 'vitest';
import {
  requestAttestedDaemonShutdown,
  requestAttestedDaemonShutdownBatch,
} from '../src/cli/supervisor-shutdown-client.js';
import type { AttestedPm2DaemonShutdownTarget } from '../src/cli/pm2-shutdown-capability.js';

const target: AttestedPm2DaemonShutdownTarget = {
  name: 'botmux-a',
  pid: 101,
  larkAppId: 'cli_a',
  ipcPort: 7901,
  bootInstanceId: 'boot-a',
  processStartIdentity: 'birth-a',
};

describe('attested daemon supervisor shutdown client', () => {
  it('accepts only an exact 202 ACK from the target boot/birth', () => {
    const postMany = vi.fn(() => [{
      status: 202,
      bodyRaw: JSON.stringify({
        ok: true,
        accepted: true,
        larkAppId: 'cli_a',
        bootInstanceId: 'boot-a',
        processStartIdentity: 'birth-a',
      }),
    }]);
    expect(() => requestAttestedDaemonShutdown(target, 'secret', {
      readStartIdentity: () => 'birth-a',
      postMany,
    })).not.toThrow();
    expect(postMany).toHaveBeenCalledOnce();
  });

  it('never contacts a same-PID successor with a different birth', () => {
    const postMany = vi.fn();
    expect(() => requestAttestedDaemonShutdown(target, 'secret', {
      readStartIdentity: () => 'birth-b',
      postMany,
    })).toThrow(/process generation changed/);
    expect(postMany).not.toHaveBeenCalled();
  });

  it('fails closed on a generation-mismatch response', () => {
    expect(() => requestAttestedDaemonShutdown(target, 'secret', {
      readStartIdentity: () => 'birth-a',
      postMany: () => [{
        status: 409,
        bodyRaw: JSON.stringify({ ok: false, error: 'supervisor_shutdown_generation_mismatch' }),
      }],
    })).toThrow(/rejected exact supervisor shutdown.*status 409/);
  });

  it('dispatches the initial fleet in one batch so a timeout does not suppress peers', () => {
    const peer = { ...target, name: 'botmux-b', pid: 202, larkAppId: 'cli_b', ipcPort: 7902,
      bootInstanceId: 'boot-b', processStartIdentity: 'birth-b' };
    const postMany = vi.fn((inputs) => {
      expect(inputs).toHaveLength(2);
      return [
        { error: 'supervisor shutdown request timed out' },
        { status: 202, bodyRaw: JSON.stringify({
          ok: true, accepted: true, larkAppId: 'cli_b', bootInstanceId: 'boot-b',
          processStartIdentity: 'birth-b',
        }) },
      ];
    });
    const attempts = requestAttestedDaemonShutdownBatch([target, peer], 'secret', {
      readStartIdentity: pid => pid === 101 ? 'birth-a' : 'birth-b',
      postMany,
    });
    expect(postMany).toHaveBeenCalledOnce();
    expect(attempts.map(attempt => attempt.ok)).toEqual([false, true]);
  });
});
