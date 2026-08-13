import { describe, expect, it } from 'vitest';
import { evaluateVcMeetingConsumerIsolation } from '../src/services/vc-meeting-consumer-isolation.js';

describe('VC meeting consumer managed side-effect isolation (plan B: operator owns sandbox)', () => {
  it.each(['pty', 'tmux'] as const)(
    'reports a real boundary for a Linux sandbox on the %s backend',
    (backendType) => {
      expect(evaluateVcMeetingConsumerIsolation({
        sandbox: true,
        platform: 'linux',
        backendType,
      })).toEqual({ ok: true, isolated: true });
    },
  );

  it.each(['pty', 'tmux', 'riff', 'herdr', 'zellij'] as const)(
    'allows an unsandboxed receiver on the %s backend but marks it not-isolated',
    (backendType) => {
      // Plan B: no sandbox requested → eligible, credential exposed (isolated:false).
      expect(evaluateVcMeetingConsumerIsolation({
        sandbox: false,
        platform: 'linux',
        backendType,
      })).toEqual({ ok: true, isolated: false });
    },
  );

  it('treats sandbox:undefined the same as off (eligible, not isolated)', () => {
    expect(evaluateVcMeetingConsumerIsolation({
      sandbox: undefined,
      platform: 'linux',
      backendType: 'pty',
    })).toEqual({ ok: true, isolated: false });
  });

  it.each(['riff', 'herdr', 'zellij'] as const)(
    'FAILS CLOSED when sandbox is requested but the %s backend cannot deliver it',
    (backendType) => {
      // An explicit isolation request must never be silently downgraded.
      expect(evaluateVcMeetingConsumerIsolation({
        sandbox: true,
        platform: 'linux',
        backendType,
      })).toMatchObject({ ok: false, reason: 'backend_unsupported' });
    },
  );

  it('FAILS CLOSED when sandbox is requested on macOS (Seatbelt exposes the credential, no host relay)', () => {
    expect(evaluateVcMeetingConsumerIsolation({
      sandbox: true,
      platform: 'darwin',
      backendType: 'pty',
    })).toMatchObject({ ok: false, reason: 'platform_unsupported' });
  });

  it('allows an unsandboxed receiver on macOS (no isolation requested → no downgrade to refuse)', () => {
    expect(evaluateVcMeetingConsumerIsolation({
      sandbox: false,
      platform: 'darwin',
      backendType: 'pty',
    })).toEqual({ ok: true, isolated: false });
  });
});
