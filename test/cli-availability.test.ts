import * as childProcess from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_CLI_IDS } from '../src/adapters/cli/registry.js';
import {
  checkCliAvailability,
  cliUnavailableMessage,
  hasAgentLaunchConfigChanged,
} from '../src/setup/cli-availability.js';

// Pass-through spies: every process the availability check could start (the
// login-shell `command -v` probe, `forge doctor`) goes through these.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
    execFileSync: vi.fn(actual.execFileSync),
    execSync: vi.fn(actual.execSync),
  };
});

const originalPath = process.env.PATH;
const originalMircli = process.env.MIRCLI_BIN;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalMircli === undefined) delete process.env.MIRCLI_BIN;
  else process.env.MIRCLI_BIN = originalMircli;
});

function executable(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

describe('CLI launch availability', () => {
  it('only treats actual Agent launch-field changes as a new availability gate', () => {
    const current = {
      cliId: 'codex' as const,
      cliPathOverride: '/missing/codex',
      wrapperCli: undefined,
    };
    expect(hasAgentLaunchConfigChanged(current, { ...current })).toBe(false);
    expect(hasAgentLaunchConfigChanged(current, { ...current, cliId: 'claude-code' })).toBe(true);
    expect(hasAgentLaunchConfigChanged(current, { ...current, cliPathOverride: '/usr/bin/codex' })).toBe(true);
    expect(hasAgentLaunchConfigChanged(current, { ...current, wrapperCli: 'ttadk codex' })).toBe(true);
    expect(hasAgentLaunchConfigChanged(current, { ...current, cliLaunchMode: 'forge-traex' })).toBe(true);
  });

  it('never starts a process for a PATH-only check, for any CLI', () => {
    process.env.PATH = '';
    vi.mocked(childProcess.spawnSync).mockClear();
    vi.mocked(childProcess.execFileSync).mockClear();
    vi.mocked(childProcess.execSync).mockClear();

    expect(checkCliAvailability({ cliId: 'pi' }, { shellFallback: false })).toMatchObject({
      available: false,
      command: 'pi',
    });
    for (const cliId of ALL_CLI_IDS) checkCliAvailability({ cliId }, { shellFallback: false });

    // A resolvable Forge x TraeX pair must not run `forge doctor` either.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-availability-'));
    try {
      executable(dir, 'traex');
      executable(dir, 'forge');
      process.env.PATH = dir;
      expect(checkCliAvailability({ cliId: 'traex', cliLaunchMode: 'forge-traex' }, { shellFallback: false }))
        .toMatchObject({ available: true, command: 'forge' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(childProcess.spawnSync).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
    expect(childProcess.execSync).not.toHaveBeenCalled();
  });

  it('checks the wrapper binary instead of the replaced adapter binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-availability-'));
    try {
      const gateway = executable(dir, 'test-gateway');
      process.env.PATH = dir;
      const result = checkCliAvailability({
        cliId: 'codex',
        cliPathOverride: '/definitely/missing/codex',
        wrapperCli: 'test-gateway codex',
      }, { shellFallback: false });
      expect(result).toMatchObject({ available: true, command: 'test-gateway', resolvedPath: gateway });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing wrapper even when the underlying CLI exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-availability-'));
    try {
      executable(dir, 'codex');
      process.env.PATH = dir;
      const result = checkCliAvailability({
        cliId: 'codex',
        wrapperCli: 'missing-gateway codex',
      }, { shellFallback: false });
      expect(result).toMatchObject({ available: false, command: 'missing-gateway' });
      expect(result.reason).toContain('command -v missing-gateway');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks the nested Codex App and Mir runner dependencies', () => {
    process.env.PATH = '';
    process.env.MIRCLI_BIN = '/definitely/missing/mircli';
    expect(checkCliAvailability({
      cliId: 'codex-app',
      cliPathOverride: '/definitely/missing/codex',
    }, { shellFallback: false })).toMatchObject({
      available: false,
      command: '/definitely/missing/codex',
    });
    expect(checkCliAvailability({ cliId: 'mir' }, { shellFallback: false })).toMatchObject({
      available: false,
      command: '/definitely/missing/mircli',
    });
  });

  it('requires both traex and forge for Forge x TraeX launch mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-availability-'));
    try {
      const forge = executable(dir, 'forge');
      executable(dir, 'traex');
      process.env.PATH = dir;

      expect(checkCliAvailability({
        cliId: 'traex',
        cliLaunchMode: 'forge-traex',
      }, { shellFallback: false })).toMatchObject({
        available: true,
        command: 'forge',
        resolvedPath: forge,
      });

      rmSync(forge);
      const missingForge = checkCliAvailability({
        cliId: 'traex',
        cliLaunchMode: 'forge-traex',
      }, { shellFallback: false });
      expect(missingForge).toMatchObject({ available: false, command: 'forge' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs forge doctor when shell fallback checks are enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-availability-'));
    try {
      executable(dir, 'traex');
      const forge = join(dir, 'forge');
      writeFileSync(forge, '#!/bin/sh\nif [ "$1" = doctor ]; then exit 7; fi\nexit 0\n');
      chmodSync(forge, 0o755);
      process.env.PATH = dir;

      const result = checkCliAvailability({
        cliId: 'traex',
        cliLaunchMode: 'forge-traex',
      });
      expect(result.available).toBe(false);
      expect(result.reason).toContain('forge doctor 检查失败');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not require a local executable for API-backed agents', () => {
    process.env.PATH = '';
    expect(checkCliAvailability({ cliId: 'mira' }, { shellFallback: false }))
      .toEqual({ available: true, localExecutableRequired: false });
    expect(checkCliAvailability({ cliId: 'riff' }, { shellFallback: false }))
      .toEqual({ available: true, localExecutableRequired: false });
  });

  it('builds an actionable user-facing failure message', () => {
    process.env.PATH = '';
    const message = cliUnavailableMessage({
      cliId: 'codex',
      cliPathOverride: '/definitely/missing/codex',
    }, 'Codex');
    expect(message).toContain('无法启动 Codex');
    expect(message).toContain('/definitely/missing/codex');
    expect(message).toContain('daemon');
  });
});
