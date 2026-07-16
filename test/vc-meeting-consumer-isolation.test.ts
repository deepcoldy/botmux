import { describe, expect, it } from 'vitest';
import { evaluateVcMeetingConsumerIsolation } from '../src/services/vc-meeting-consumer-isolation.js';

describe('VC meeting consumer managed side-effect isolation', () => {
  it.each(['pty', 'tmux'] as const)(
    'accepts a Linux sandbox on the %s backend',
    (backendType) => {
      expect(evaluateVcMeetingConsumerIsolation({
        sandbox: true,
        platform: 'linux',
        backendType,
      })).toEqual({ ok: true });
    },
  );

  it('rejects an unsandboxed local receiver', () => {
    expect(evaluateVcMeetingConsumerIsolation({
      sandbox: false,
      platform: 'linux',
      backendType: 'tmux',
    })).toMatchObject({ ok: false, reason: 'sandbox_required' });
  });

  it.each(['riff', 'herdr', 'zellij'] as const)(
    'rejects the %s backend even when sandbox=true',
    (backendType) => {
      expect(evaluateVcMeetingConsumerIsolation({
        sandbox: true,
        platform: 'linux',
        backendType,
      })).toMatchObject({ ok: false, reason: 'backend_unsupported' });
    },
  );

  it('rejects macOS because its current sandbox does not confine credential reads', () => {
    expect(evaluateVcMeetingConsumerIsolation({
      sandbox: true,
      platform: 'darwin',
      backendType: 'pty',
    })).toMatchObject({ ok: false, reason: 'platform_unsupported' });
  });
});
