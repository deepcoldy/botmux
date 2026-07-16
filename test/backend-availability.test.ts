import { describe, expect, it, vi } from 'vitest';
import { ensureBackendAvailable, type BackendAvailabilityDeps } from '../src/services/backend-availability.js';

function deps(overrides: Partial<BackendAvailabilityDeps> = {}): BackendAvailabilityDeps {
  return {
    ensureTmux: vi.fn(async () => ({ installed: true, version: 'tmux 3.5', freshInstall: false, binaryPresent: true })),
    ensureHerdr: vi.fn(async () => ({ installed: true, version: 'herdr 0.7.3', freshInstall: false })),
    probeZellijFunctional: vi.fn(() => ({ ok: true, version: 'zellij 0.44.1' })),
    ...overrides,
  };
}

describe('ensureBackendAvailable', () => {
  it('accepts pty without probing or installing anything', async () => {
    const d = deps();
    await expect(ensureBackendAvailable('pty', d)).resolves.toEqual({ ok: true, backendType: 'pty' });
    expect(d.ensureTmux).not.toHaveBeenCalled();
    expect(d.ensureHerdr).not.toHaveBeenCalled();
    expect(d.probeZellijFunctional).not.toHaveBeenCalled();
  });

  it('prepares tmux and herdr before a dashboard save is allowed', async () => {
    const d = deps();
    await expect(ensureBackendAvailable('tmux', d)).resolves.toMatchObject({ ok: true, version: 'tmux 3.5' });
    await expect(ensureBackendAvailable('herdr', d)).resolves.toMatchObject({ ok: true, version: 'herdr 0.7.3' });
    expect(d.ensureTmux).toHaveBeenCalledTimes(1);
    expect(d.ensureHerdr).toHaveBeenCalledTimes(1);
  });

  it('returns an actionable failure and lets the caller avoid persisting an unavailable backend', async () => {
    const d = deps({
      ensureHerdr: vi.fn(async () => ({
        installed: false,
        freshInstall: false,
        reason: '官方 install.sh 执行失败',
        manualCommand: 'curl -fsSL https://herdr.dev/install.sh | sh',
      })),
    });
    await expect(ensureBackendAvailable('herdr', d)).resolves.toEqual({
      ok: false,
      backendType: 'herdr',
      reason: '官方 install.sh 执行失败',
      manualCommand: 'curl -fsSL https://herdr.dev/install.sh | sh',
    });
  });

  it('probes zellij and reports its minimum-version/install hint', async () => {
    const d = deps({
      probeZellijFunctional: vi.fn(() => ({ ok: false, reason: 'zellij 0.43.0 过旧' })),
    });
    await expect(ensureBackendAvailable('zellij', d)).resolves.toEqual({
      ok: false,
      backendType: 'zellij',
      reason: 'zellij 0.43.0 过旧',
      manualCommand: '请安装 zellij >= 0.44.0 后重试',
    });
  });
});
