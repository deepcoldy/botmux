import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetHcAvailabilityCache } from '../src/setup/ensure-hc.js';
import {
  ensureBackendAvailable,
  probeHcFunctional,
  type BackendAvailabilityDeps,
} from '../src/services/backend-availability.js';

function deps(overrides: Partial<BackendAvailabilityDeps> = {}): BackendAvailabilityDeps {
  return {
    ensureTmux: vi.fn(async () => ({ installed: true, version: 'tmux 3.5', freshInstall: false, binaryPresent: true })),
    ensureHerdr: vi.fn(async () => ({ installed: true, version: 'herdr 0.7.3', freshInstall: false })),
    probeZellijFunctional: vi.fn(() => ({ ok: true, version: 'zellij 0.44.1' })),
    probeZmxFunctional: vi.fn(() => ({ ok: true, version: 'zmx 0.7.0' })),
    probeHcFunctional: vi.fn(() => ({ ok: true, version: 'hc 0.1.19' })),
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
    expect(d.probeZmxFunctional).not.toHaveBeenCalled();
    expect(d.probeHcFunctional).not.toHaveBeenCalled();
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

  it('probes zmx independently instead of falling through to the zellij probe', async () => {
    const d = deps({
      probeZmxFunctional: vi.fn(() => ({ ok: false, reason: 'zmx 0.5.9 过旧' })),
    });
    await expect(ensureBackendAvailable('zmx', d)).resolves.toEqual({
      ok: false,
      backendType: 'zmx',
      reason: 'zmx 0.5.9 过旧',
      manualCommand: '安装 ZMX >= 0.7.0：macOS 用 brew install neurosnap/tap/zmx；Linux 用官方 release binary；或 mise use -g github:neurosnap/zmx@latest',
    });
    expect(d.probeZmxFunctional).toHaveBeenCalledTimes(1);
    expect(d.probeZellijFunctional).not.toHaveBeenCalled();
  });

  it('probes hc on its own and never installs it', async () => {
    const d = deps({
      probeHcFunctional: vi.fn(() => ({ ok: false as const, reason: '没有可用的 herdr-core >= 0.1.19' })),
    });
    const result = await ensureBackendAvailable('hc', d);
    expect(result).toMatchObject({ ok: false, backendType: 'hc', reason: '没有可用的 herdr-core >= 0.1.19' });
    expect(result.ok === false && result.manualCommand).toContain('BOTMUX_HC_BIN');
    expect(d.probeHcFunctional).toHaveBeenCalledTimes(1);
    expect(d.probeZellijFunctional).not.toHaveBeenCalled();
    expect(d.ensureTmux).not.toHaveBeenCalled();
    expect(d.ensureHerdr).not.toHaveBeenCalled();

    await expect(ensureBackendAvailable('hc', deps())).resolves.toEqual({ ok: true, backendType: 'hc', version: 'hc 0.1.19' });
  });
});

describe('probeHcFunctional', () => {
  it('refuses a usable binary whose runtime dir is missing, before any hc call', () => {
    // Unix socket paths are capped at 107 bytes; keep them out of a long TMPDIR.
    const root = mkdtempSync('/tmp/bmhcv-');
    try {
      const bin = join(root, 'fake-hc');
      writeFileSync(bin, '#!/bin/sh\necho "hc 0.1.19"\n', { mode: 0o755 });
      resetHcAvailabilityCache();
      const env = { ...process.env, BOTMUX_HC_BIN: bin, XDG_RUNTIME_DIR: join(root, 'absent') };
      const result = probeHcFunctional(env);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain(join(root, 'absent'));

      resetHcAvailabilityCache();
      expect(probeHcFunctional({ ...env, XDG_RUNTIME_DIR: root })).toEqual({ ok: true, version: 'hc 0.1.19' });
    } finally {
      resetHcAvailabilityCache();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
