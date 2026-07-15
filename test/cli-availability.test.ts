import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkCliAvailability,
  cliUnavailableMessage,
  hasAgentLaunchConfigChanged,
} from '../src/setup/cli-availability.js';

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
  });

  it('keeps PATH-only checks shell-free by avoiding adapter resolvedBin getters', () => {
    const source = readFileSync(new URL('../src/setup/cli-availability.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('createCliAdapterSync');

    process.env.PATH = '';
    expect(checkCliAvailability({ cliId: 'pi' }, { shellFallback: false })).toMatchObject({
      available: false,
      command: 'pi',
    });
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
