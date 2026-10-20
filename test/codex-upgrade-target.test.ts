import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const mocks = vi.hoisted(() => ({ homedir: vi.fn<() => string>(), resolve: vi.fn<(command: string) => string>() }));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: mocks.homedir }));
vi.mock('../src/adapters/cli/registry.js', () => ({ resolveCommandReal: mocks.resolve }));

import { resolveCodexUpgradeCommand } from '../src/services/codex-upgrade-target.js';

let directory: string;
let home: string;
let standalone: string;
let current: string;
let entry: string;
let oldNpm: string;

function file(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n', { mode: 0o755 });
  return path;
}

function install(version = '0.153.4'): string {
  const target = file(join(standalone, 'releases', version, 'bin', 'codex'));
  symlinkSync(join('releases', version), current);
  mkdirSync(dirname(entry), { recursive: true });
  symlinkSync(join(current, 'bin', 'codex'), entry);
  return realpathSync(target);
}

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-codex-upgrade-target-')));
  home = join(directory, 'home');
  mkdirSync(home);
  standalone = join(home, '.codex', 'packages', 'standalone');
  current = join(standalone, 'current');
  entry = join(home, '.local', 'bin', 'codex');
  oldNpm = file(join(directory, 'npm', 'bin', 'codex'));
  mocks.homedir.mockReset().mockReturnValue(home);
  mocks.resolve.mockReset().mockImplementation(command => command === 'codex' ? oldNpm : realpathSync(command));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('Codex automatic-upgrade installation selection', () => {
  it.each([undefined, { source: 'official' }])('prefers managed current to the older npm PATH binary for runtime %j', cliRuntime => {
    const managed = install();
    expect(resolveCodexUpgradeCommand({ cliRuntime })).toBe(managed);
    expect(mocks.resolve).toHaveBeenCalledWith(managed);
    expect(mocks.resolve).not.toHaveBeenCalledWith('codex');
  });

  it('keeps an explicit override even when the official managed installation exists', () => {
    install();
    const override = file(join(directory, 'custom', 'codex'));
    expect(resolveCodexUpgradeCommand({ cliPathOverride: override })).toBe(override);
    expect(mocks.resolve).toHaveBeenCalledWith(override);
    expect(mocks.homedir).not.toHaveBeenCalled();
  });

  it('keeps the configured runtime resolver, including an explicit configured path', () => {
    install();
    const override = file(join(directory, 'configured', 'codex'));
    expect(resolveCodexUpgradeCommand({ cliRuntime: { source: 'configured' } })).toBe(oldNpm);
    expect(resolveCodexUpgradeCommand({ cliRuntime: { source: 'configured' }, cliPathOverride: override })).toBe(override);
    expect(mocks.homedir).not.toHaveBeenCalled();
  });

  it('uses the existing resolver when no managed current installation exists', () => {
    expect(resolveCodexUpgradeCommand()).toBe(oldNpm);
    expect(mocks.resolve).toHaveBeenCalledWith('codex');
  });

  it('does not treat a broken current symlink as an absent installation', () => {
    mkdirSync(standalone, { recursive: true });
    symlinkSync('releases/missing', current);
    expect(() => resolveCodexUpgradeCommand()).toThrow('Cannot select the managed Codex upgrade target');
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each(['binary', 'entry'] as const)('rejects a managed installation missing its %s', missing => {
    const managed = install();
    unlinkSync(missing === 'binary' ? managed : entry);
    expect(() => resolveCodexUpgradeCommand()).toThrow('Cannot select the managed Codex upgrade target');
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('rejects a user entry that still points at a different installation', () => {
    install();
    unlinkSync(entry);
    symlinkSync(oldNpm, entry);
    expect(() => resolveCodexUpgradeCommand()).toThrow('does not point to managed current');
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('rejects matching pointers that escape the canonical release directory', () => {
    install();
    const outside = file(join(directory, 'outside', 'bin', 'codex'));
    unlinkSync(current);
    symlinkSync(dirname(dirname(outside)), current);
    expect(() => resolveCodexUpgradeCommand()).toThrow('not a releases/<release>/bin/codex executable');
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('rejects an extra nesting level inside releases', () => {
    install();
    file(join(standalone, 'releases', '0.154.0', 'nested', 'bin', 'codex'));
    unlinkSync(current);
    symlinkSync('releases/0.154.0/nested', current);
    expect(() => resolveCodexUpgradeCommand()).toThrow('not a releases/<release>/bin/codex executable');
  });

  it('rereads current on every observation without caching the previous release', () => {
    const first = install();
    expect(resolveCodexUpgradeCommand()).toBe(first);
    for (const version of ['0.154.0', '0.155.0']) {
      const next = file(join(standalone, 'releases', version, 'bin', 'codex'));
      unlinkSync(current);
      symlinkSync(join('releases', version), current);
      expect(resolveCodexUpgradeCommand()).toBe(next);
    }
  });

  it('canonicalizes a symlinked home and ignores a bot-specific CODEX_HOME', () => {
    const managed = install();
    const alias = join(directory, 'home-alias');
    symlinkSync(home, alias);
    mocks.homedir.mockReturnValue(alias);
    vi.stubEnv('CODEX_HOME', join(directory, 'isolated-bot-codex'));
    expect(resolveCodexUpgradeCommand()).toBe(managed);
  });
});
