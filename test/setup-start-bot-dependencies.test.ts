import { describe, expect, it, vi } from 'vitest';
import { ensureBotStartDependencies } from '../src/setup/index.js';
import { findInvalidFleetCredentials } from '../src/setup/local-bot.js';

describe('ensureBotStartDependencies (0->1 start-bot preflight)', () => {
  it('succeeds silently when tmux is installed and functional', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const runEnsureTmux = vi.fn(async () => ({
      installed: true,
      version: 'tmux 3.4',
      freshInstall: false,
      binaryPresent: true,
    }));
    const runEnsureFonts = vi.fn(async () => ({ fontDir: '/tmp/fonts', ready: ['CJK'], failed: [] }));
    try {
      const result = await ensureBotStartDependencies(
        {
          effectiveBackend: 'tmux',
          cliId: 'claude-code',
          isApiOnly: false,
          isFirstBotTransition: true,
          ptyOptIn: false,
          quiet: true,
          platform: 'darwin',
        },
        { ensureTmux: runEnsureTmux, ensureFonts: runEnsureFonts },
      );
      expect(result).toEqual({ ok: true });
      expect(runEnsureTmux).toHaveBeenCalledWith(undefined, expect.objectContaining({ quiet: true }));
      expect(runEnsureFonts).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('returns dependency_missing when tmux is genuinely absent on a tmux bot (including local apiOnly bots)', async () => {
    const runEnsureTmux = vi.fn(async () => ({
      installed: false,
      freshInstall: false,
      binaryPresent: false,
      reason: '自动安装 tmux 失败',
      manualCommand: 'brew install tmux',
    }));
    const runEnsureFonts = vi.fn(async () => ({ fontDir: '/tmp/fonts', ready: [], failed: [] }));

    const result = await ensureBotStartDependencies(
      {
        effectiveBackend: 'tmux',
        cliId: 'claude-code',
        isApiOnly: true,
        isFirstBotTransition: true,
        ptyOptIn: false,
        quiet: true,
        platform: 'linux',
      },
      { ensureTmux: runEnsureTmux, ensureFonts: runEnsureFonts },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('dependency_missing');
      expect(result.message).toContain('brew install tmux');
      expect(result.message).toContain('BACKEND_TYPE=pty');
    }
    expect(runEnsureFonts).not.toHaveBeenCalled();
  });

  it('degrades gracefully when tmux binary is present but probe flaked, and skips tmux for pty backend', async () => {
    const runEnsureTmux = vi.fn(async () => ({
      installed: false,
      freshInstall: false,
      binaryPresent: true,
      reason: 'server start timed out',
    }));
    const brokenPresent = await ensureBotStartDependencies(
      {
        effectiveBackend: 'tmux',
        isFirstBotTransition: true,
        ptyOptIn: false,
        quiet: true,
        platform: 'darwin',
      },
      { ensureTmux: runEnsureTmux },
    );
    expect(brokenPresent).toEqual({ ok: true });

    const runEnsureTmuxPty = vi.fn();
    const ptyResult = await ensureBotStartDependencies(
      {
        effectiveBackend: 'pty',
        isFirstBotTransition: true,
        ptyOptIn: false,
        quiet: true,
        platform: 'darwin',
      },
      { ensureTmux: runEnsureTmuxPty },
    );
    expect(ptyResult).toEqual({ ok: true });
    expect(runEnsureTmuxPty).not.toHaveBeenCalled();
  });

  it('fails with dependency_missing when hc binary is absent and invokes best-effort herdr + fonts on Linux 0->1', async () => {
    const hcRes = await ensureBotStartDependencies(
      {
        effectiveBackend: 'hc',
        isFirstBotTransition: true,
        ptyOptIn: false,
        quiet: true,
      },
      {
        checkHcDependency: () => ({
          availability: { ok: false, reason: 'herdr-core not found' },
          binaryPresent: false,
        }),
      },
    );
    expect(hcRes.ok).toBe(false);
    if (!hcRes.ok) {
      expect(hcRes.reason).toBe('dependency_missing');
      expect(hcRes.message).toContain('BOTMUX_HC_BIN');
    }

    const runEnsureHerdr = vi.fn(async () => ({ installed: true, version: '0.8.0', freshInstall: false }));
    const runEnsureHerdrIntegrations = vi.fn(async () => ({
      attempted: ['claude-code'],
      installed: [],
      alreadyInstalled: ['claude-code'],
      failed: [],
      unsupportedCliIds: [],
    }));
    const runEnsureFonts = vi.fn(async () => ({ fontDir: '/tmp/fonts', ready: ['CJK'], failed: [] }));
    const herdrRes = await ensureBotStartDependencies(
      {
        effectiveBackend: 'herdr',
        cliId: 'claude-code',
        isApiOnly: false,
        isFirstBotTransition: true,
        ptyOptIn: false,
        quiet: true,
        platform: 'linux',
        skipFontsDownload: false,
      },
      {
        ensureHerdr: runEnsureHerdr,
        ensureHerdrIntegrations: runEnsureHerdrIntegrations,
        ensureFonts: runEnsureFonts,
      },
    );
    expect(herdrRes).toEqual({ ok: true });
    expect(runEnsureHerdr).toHaveBeenCalledWith(expect.objectContaining({ quiet: true }));
    expect(runEnsureHerdrIntegrations).toHaveBeenCalledWith(['claude-code']);
    expect(runEnsureFonts).toHaveBeenCalledWith(undefined, expect.objectContaining({ quiet: true }));
  });
});

describe('findInvalidFleetCredentials whitespace fidelity', () => {
  it('rejects credentials with leading or trailing whitespace instead of validating trimmed copies', async () => {
    const validate = vi.fn(async () => ({ ok: true as const }));
    const invalid = await findInvalidFleetCredentials(
      [{ larkAppId: ' cli_valid ', larkAppSecret: ' secret ' }],
      {
        validate,
        brandOf: () => 'feishu',
      },
    );
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.reason).toContain('首尾空白');
    expect(validate).not.toHaveBeenCalled();
  });
});
