import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CLI_RUNTIME_UPDATE_CHECK_INTERVAL_MS,
  buildCliRuntimeUpdateCard,
  filterCliRuntimeUpdateEntriesForTargets,
  cliRuntimeUpdateStorePathIn,
  probeCodexRuntimeUpdate,
  readCliRuntimeUpdateStoreFrom,
  resolveNpmPackageForExecutable,
  runCliRuntimeUpdateAudit,
  selectCodexRuntimeUpdateTargets,
  writeCliRuntimeUpdateStoreTo,
  type CliRuntimeUpdateEntry,
  type CliRuntimeUpdateStore,
  type CliRuntimeUpdateTarget,
} from '../src/core/cli-runtime-update.js';

function runtimeTarget(
  overrides: Partial<CliRuntimeUpdateTarget> = {},
): CliRuntimeUpdateTarget {
  return {
    cliId: 'codex',
    runtimeId: 'codex',
    displayName: 'Codex',
    binPath: 'codex',
    provider: 'internal',
    ...overrides,
  };
}

function updateEntry(
  overrides: Partial<CliRuntimeUpdateEntry> = {},
): CliRuntimeUpdateEntry {
  const entry = {
    cliId: 'codex',
    runtimeId: 'codex',
    displayName: 'Codex',
    binPath: 'codex',
    installationPath: overrides.installationPath ?? resolve(overrides.binPath ?? 'codex'),
    provider: 'internal',
    managed: true,
    current: '0.144.1',
    latest: '0.144.3',
    updateAvailable: true,
    updateCommand: 'codex update',
    lastCheckedAt: 123,
    ...overrides,
  };
  return {
    ...entry,
    sourceFingerprint: overrides.sourceFingerprint
      ?? JSON.stringify([
        entry.provider,
        entry.provider === 'npm' || entry.provider === 'auto' ? entry.packageName ?? '' : '',
      ]),
  };
}

describe('selectCodexRuntimeUpdateTargets', () => {
  it('keeps official fallback internal and maps explicit update providers', () => {
    const resolve = vi.fn((override?: string) => override ?? '/usr/bin/codex');

    expect(selectCodexRuntimeUpdateTargets([
      { cliId: 'codex' },
      // Same official runtime/binary: target de-duplication is independent of bot count.
      { cliId: 'codex-app', wrapperCli: 'npx -y @openai/codex' },
      { cliId: 'codex', cliPathOverride: '/opt/legacy-codex' },
      {
        cliId: 'codex',
        cliRuntime: {
          id: 'auto-codex',
          displayName: 'Auto Codex',
          executable: '/opt/auto-codex',
          update: { provider: 'auto' },
        },
      },
      {
        cliId: 'codex',
        cliRuntime: {
          id: 'npm-codex',
          displayName: 'NPM Codex',
          executable: '/opt/npm-codex',
          update: { provider: 'npm', packageName: '@acme/npm-codex' },
        },
      },
      {
        cliId: 'codex',
        cliRuntime: {
          id: 'self-codex',
          executable: '/opt/self-codex',
          update: { provider: 'self' },
        },
      },
      {
        cliId: 'codex',
        cliRuntime: {
          id: 'quiet-codex',
          executable: '/opt/quiet-codex',
          update: { provider: 'none' },
        },
      },
      { cliId: 'claude-code' },
    ], resolve)).toEqual([
      runtimeTarget({ binPath: '/usr/bin/codex' }),
      runtimeTarget({
        runtimeId: 'legacy-codex',
        displayName: 'legacy-codex',
        binPath: '/opt/legacy-codex',
        provider: 'auto',
      }),
      runtimeTarget({
        runtimeId: 'auto-codex',
        displayName: 'Auto Codex',
        binPath: '/opt/auto-codex',
        provider: 'auto',
      }),
      runtimeTarget({
        runtimeId: 'npm-codex',
        displayName: 'NPM Codex',
        binPath: '/opt/npm-codex',
        provider: 'npm',
        packageName: '@acme/npm-codex',
      }),
      runtimeTarget({
        runtimeId: 'self-codex',
        displayName: 'self-codex',
        binPath: '/opt/self-codex',
        provider: 'self',
      }),
    ]);
    // none still participates in source-conflict detection, but is omitted from
    // the returned audit targets when it is the only policy for this runtime.
    expect(resolve).toHaveBeenCalledWith('/opt/quiet-codex');
  });

  it('keeps valid runtimes when another configured executable cannot resolve', () => {
    expect(selectCodexRuntimeUpdateTargets([
      { cliId: 'codex', cliPathOverride: '/missing/codex' },
      { cliId: 'codex', cliPathOverride: '/good/good-codex' },
    ], (override) => {
      if (override === '/missing/codex') throw new Error('missing');
      return override!;
    })).toEqual([
      runtimeTarget({
        runtimeId: 'good-codex',
        displayName: 'good-codex',
        binPath: '/good/good-codex',
        provider: 'auto',
      }),
    ]);
  });

  it('deduplicates only identical sources and skips conflicting providers or npm packages', () => {
    const configured = (update: { provider: 'auto' | 'none' } | { provider: 'npm'; packageName: string }) => ({
      cliId: 'codex',
      cliRuntime: {
        id: 'vendor-codex',
        executable: '/opt/vendor-codex',
        update,
      },
    });
    const resolve = (override?: string) => override ?? '/usr/bin/codex';

    expect(selectCodexRuntimeUpdateTargets([
      configured({ provider: 'npm', packageName: '@vendor/codex' }),
      configured({ provider: 'npm', packageName: '@vendor/codex' }),
    ], resolve)).toEqual([
      runtimeTarget({
        runtimeId: 'vendor-codex',
        displayName: 'vendor-codex',
        binPath: '/opt/vendor-codex',
        provider: 'npm',
        packageName: '@vendor/codex',
      }),
    ]);

    expect(selectCodexRuntimeUpdateTargets([
      configured({ provider: 'auto' }),
      configured({ provider: 'npm', packageName: '@vendor/codex' }),
    ], resolve)).toEqual([]);
    expect(selectCodexRuntimeUpdateTargets([
      configured({ provider: 'npm', packageName: '@vendor/codex-a' }),
      configured({ provider: 'npm', packageName: '@vendor/codex-b' }),
    ], resolve)).toEqual([]);
    expect(selectCodexRuntimeUpdateTargets([
      configured({ provider: 'none' }),
      configured({ provider: 'auto' }),
    ], resolve)).toEqual([]);
  });

  it('fails closed when different runtime identities resolve to the same installation', () => {
    const sharedBin = '/opt/shared/vendor-codex';
    expect(selectCodexRuntimeUpdateTargets([
      {
        cliId: 'codex',
        cliRuntime: {
          id: 'vendor-a',
          executable: 'vendor-a',
          update: { provider: 'npm', packageName: '@vendor/a' },
        },
      },
      {
        cliId: 'codex',
        cliRuntime: {
          id: 'vendor-b',
          executable: 'vendor-b',
          update: { provider: 'npm', packageName: '@vendor/b' },
        },
      },
    ], () => sharedBin)).toEqual([]);
  });
});

describe('resolveNpmPackageForExecutable', () => {
  it('returns the single package whose bin mapping owns the exact executable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-npm-owner-'));
    try {
      const packageDir = join(dir, 'node_modules', '@vendor', 'codex');
      mkdirSync(join(packageDir, 'bin'), { recursive: true });
      const binPath = join(packageDir, 'bin', 'vendor-codex.js');
      writeFileSync(binPath, '#!/usr/bin/env node\n');
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
        name: '@vendor/codex',
        bin: { 'vendor-codex': 'bin/vendor-codex.js' },
      }));

      expect(resolveNpmPackageForExecutable(binPath)).toEqual({
        packageName: '@vendor/codex',
        packageRoot: realpathSync(packageDir),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns unmanaged when multiple manifests claim the same executable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-npm-owner-ambiguous-'));
    try {
      const innerDir = join(dir, 'packages', 'inner');
      mkdirSync(innerDir, { recursive: true });
      const binPath = join(innerDir, 'vendor-codex.js');
      writeFileSync(binPath, '#!/usr/bin/env node\n');
      writeFileSync(join(innerDir, 'package.json'), JSON.stringify({
        name: '@vendor/inner-codex',
        bin: { 'vendor-codex': 'vendor-codex.js' },
      }));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: '@vendor/outer-codex',
        bin: { 'vendor-codex': 'packages/inner/vendor-codex.js' },
      }));

      expect(resolveNpmPackageForExecutable(binPath)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('filterCliRuntimeUpdateEntriesForTargets', () => {
  it('hides removed or source-changed badges before the next audit and refreshes the display name', () => {
    const entries = [
      updateEntry({
        runtimeId: 'codex',
        displayName: 'Codex',
        binPath: '/usr/bin/codex',
        provider: 'internal',
      }),
      updateEntry({
        runtimeId: 'vendor-codex',
        displayName: 'Old Vendor Name',
        binPath: '/opt/vendor-codex',
        provider: 'auto',
      }),
      updateEntry({
        runtimeId: 'removed-codex',
        displayName: 'Removed Codex',
        binPath: '/opt/removed-codex',
        provider: 'auto',
      }),
    ];
    const visible = filterCliRuntimeUpdateEntriesForTargets(entries, [
      runtimeTarget({
        runtimeId: 'vendor-codex',
        displayName: 'Vendor Codex',
        binPath: '/opt/vendor-codex',
        provider: 'auto',
      }),
    ]);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      runtimeId: 'vendor-codex',
      displayName: 'Vendor Codex',
      provider: 'auto',
    });

    expect(filterCliRuntimeUpdateEntriesForTargets(entries, [
      runtimeTarget({
        runtimeId: 'vendor-codex',
        binPath: '/opt/vendor-codex',
        provider: 'npm',
        packageName: '@vendor/codex',
      }),
    ])).toEqual([]);
  });

  it('refreshes auto ownership before showing a badge and strips unknown-source latest data', () => {
    const entry = updateEntry({
      runtimeId: 'vendor-codex',
      displayName: 'Vendor Codex',
      binPath: '/opt/vendor-codex',
      provider: 'auto',
      packageName: '@vendor/codex-a',
      current: '1.0.0',
      latest: '1.1.0',
      updateAvailable: true,
      updateCommand: 'npm install -g @vendor/codex-a@latest',
      installTarget: '/opt/node_modules/@vendor/codex-a',
      lastNotifiedVersion: '1.1.0',
    });
    const target = runtimeTarget({
      runtimeId: 'vendor-codex',
      displayName: 'Renamed Vendor Codex',
      binPath: '/opt/vendor-codex',
      provider: 'auto',
    });

    expect(filterCliRuntimeUpdateEntriesForTargets(
      [entry],
      [target],
      () => ({ packageName: '@vendor/codex-b', packageRoot: '/opt/node_modules/@vendor/codex-b' }),
    )).toEqual([]);

    const known = filterCliRuntimeUpdateEntriesForTargets(
      [entry],
      [target],
      () => ({ packageName: '@vendor/codex-a', packageRoot: '/opt/node_modules/@vendor/codex-a' }),
    );
    expect(known).toHaveLength(1);
    expect(known[0]).toMatchObject({
      latest: '1.1.0',
      updateAvailable: true,
      updateCommand: null,
      installTarget: '/opt/node_modules/@vendor/codex-a',
    });

    const unknown = filterCliRuntimeUpdateEntriesForTargets([updateEntry({
      ...entry,
      packageName: undefined,
      sourceFingerprint: JSON.stringify(['auto', '']),
    })], [target], () => null);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({
      displayName: 'Renamed Vendor Codex',
      provider: 'auto',
      managed: false,
      latest: null,
      updateAvailable: false,
      updateCommand: null,
      sourceFingerprint: JSON.stringify(['auto', '']),
    });
    expect(unknown[0]).not.toHaveProperty('packageName');
    expect(unknown[0]).not.toHaveProperty('installTarget');
    expect(unknown[0]).not.toHaveProperty('lastNotifiedVersion');
  });
});

describe('probeCodexRuntimeUpdate', () => {
  it('uses matching official doctor data without querying any registry', async () => {
    const runFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === '--version') return 'codex-cli 0.144.1';
      return JSON.stringify({
        codexVersion: '0.144.1',
        checks: {
          updates: {
            id: 'updates.status',
            details: {
              'latest version': '0.144.3',
              'cached latest version': '0.144.2',
              'update action': 'npm install -g @openai/codex',
              'npm update target': '/opt/npm/@openai/codex',
            },
          },
        },
      });
    });
    const fetchLatest = vi.fn(async () => '9.9.9');
    const fetchNpmLatest = vi.fn(async () => '9.9.9');

    await expect(probeCodexRuntimeUpdate(
      runtimeTarget({ binPath: '/usr/bin/codex' }),
      { runFile, fetchLatest, fetchNpmLatest },
    )).resolves.toEqual({
      current: '0.144.1',
      latest: '0.144.3',
      managed: true,
      updateCommand: 'npm install -g @openai/codex',
      installTarget: '/opt/npm/@openai/codex',
    });
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(fetchNpmLatest).not.toHaveBeenCalled();
  });

  it('allows only the official internal provider to fall back to @openai/codex', async () => {
    const runFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === '--version') return 'codex-cli 0.120.0';
      throw new Error('unexpected argument --json');
    });
    const fetchLatest = vi.fn(async () => '0.144.3');

    await expect(probeCodexRuntimeUpdate(
      runtimeTarget(),
      { runFile, fetchLatest },
    )).resolves.toEqual({
      current: '0.120.0',
      latest: '0.144.3',
      managed: true,
      updateCommand: 'codex update',
    });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('keeps executable current and rejects a mismatched official doctor report', async () => {
    const runFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === '--version') return 'codex-cli 0.120.0';
      return JSON.stringify({
        codexVersion: '0.119.0',
        checks: [{
          id: 'updates.status',
          details: {
            'latest version probe': '9.9.9',
            'update action': 'npm install -g @vendor/codex',
            'npm update target': '/opt/vendor/codex',
          },
        }],
      });
    });
    const fetchLatest = vi.fn(async () => '0.121.0');

    await expect(probeCodexRuntimeUpdate(runtimeTarget(), { runFile, fetchLatest })).resolves.toEqual({
      current: '0.120.0',
      latest: '0.121.0',
      managed: true,
      updateCommand: 'codex update',
    });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy/custom auto unmanaged when package provenance is unknown', async () => {
    const runFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === '--version') return 'acme-codex 1.2.3';
      throw new Error('doctor unsupported');
    });
    const fetchLatest = vi.fn(async () => '99.0.0');
    const fetchNpmLatest = vi.fn(async () => '99.0.0');
    const resolveNpmPackage = vi.fn(() => null);

    await expect(probeCodexRuntimeUpdate(
      runtimeTarget({
        runtimeId: 'acme-codex',
        displayName: 'Acme Codex',
        binPath: '/opt/acme-codex',
        provider: 'auto',
      }),
      { runFile, fetchLatest, fetchNpmLatest, resolveNpmPackage },
    )).resolves.toEqual({
      current: '1.2.3',
      latest: null,
      managed: false,
      updateCommand: null,
    });
    expect(resolveNpmPackage).toHaveBeenCalledWith('/opt/acme-codex');
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(fetchNpmLatest).not.toHaveBeenCalled();
  });

  it('does not inherit a cached doctor latest when auto provenance is unknown', async () => {
    const runFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === '--version') return 'vendor-codex 1.2.3';
      return JSON.stringify({
        codexVersion: '1.2.3',
        checks: [{
          id: 'updates.status',
          details: { 'cached latest version': '99.0.0' },
        }],
      });
    });

    await expect(probeCodexRuntimeUpdate(
      runtimeTarget({
        runtimeId: 'vendor-codex',
        displayName: 'Vendor Codex',
        binPath: '/opt/vendor-codex',
        provider: 'auto',
      }),
      { runFile, resolveNpmPackage: () => null },
    )).resolves.toEqual({
      current: '1.2.3',
      latest: null,
      managed: false,
      updateCommand: null,
    });
    expect(runFile).toHaveBeenCalledTimes(1);
    expect(runFile).toHaveBeenCalledWith('/opt/vendor-codex', ['--version'], 5_000);
  });

  it('never trusts an inherited upstream doctor for a custom auto runtime', async () => {
    const runFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === '--version') return 'vendor-codex 3.4.5';
      return JSON.stringify({
        codexVersion: '0.144.0',
        checks: [{
          id: 'updates.status',
          details: {
            'latest version probe': '0.145.0',
            'update action': 'npm install -g @openai/codex',
          },
        }],
      });
    });

    await expect(probeCodexRuntimeUpdate(
      runtimeTarget({
        runtimeId: 'vendor-codex',
        displayName: 'Vendor Codex',
        binPath: '/opt/vendor-codex',
        provider: 'auto',
      }),
      { runFile, resolveNpmPackage: () => null },
    )).resolves.toEqual({
      current: '3.4.5',
      latest: null,
      managed: false,
      updateCommand: null,
    });
    expect(runFile).toHaveBeenCalledTimes(1);
  });

  it('queries the exact npm owner discovered for an auto runtime', async () => {
    const runFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === '--version') return 'acme-codex 1.2.3';
      throw new Error('doctor unsupported');
    });
    const fetchLatest = vi.fn(async () => '99.0.0');
    const fetchNpmLatest = vi.fn(async (packageName: string) => {
      expect(packageName).toBe('@acme/codex');
      return '1.3.0';
    });
    const resolveNpmPackage = vi.fn(() => ({
      packageName: '@acme/codex',
      packageRoot: '/opt/node_modules/@acme/codex',
    }));

    await expect(probeCodexRuntimeUpdate(
      runtimeTarget({
        runtimeId: 'acme-codex',
        displayName: 'Acme Codex',
        binPath: '/opt/bin/acme-codex',
        provider: 'auto',
      }),
      { runFile, fetchLatest, fetchNpmLatest, resolveNpmPackage },
    )).resolves.toEqual({
      current: '1.2.3',
      latest: '1.3.0',
      managed: true,
      packageName: '@acme/codex',
      updateCommand: null,
      installTarget: '/opt/node_modules/@acme/codex',
    });
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(fetchNpmLatest).toHaveBeenCalledWith('@acme/codex');
  });

  it('honors an explicit npm provider even when doctor advertises another stream', async () => {
    const runFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === '--version') return 'vendor-codex 3.0.0';
      return JSON.stringify({
        codexVersion: '3.0.0',
        checks: [{
          id: 'updates.status',
          details: {
            'latest version probe': '99.0.0',
            'update action': 'codex update',
          },
        }],
      });
    });
    const fetchNpmLatest = vi.fn(async (packageName: string) => {
      expect(packageName).toBe('@vendor/codex');
      return '3.1.0';
    });

    await expect(probeCodexRuntimeUpdate(
      runtimeTarget({
        runtimeId: 'vendor-codex',
        displayName: 'Vendor Codex',
        binPath: '/opt/vendor-codex',
        provider: 'npm',
        packageName: '@vendor/codex',
      }),
      { runFile, fetchNpmLatest },
    )).resolves.toEqual({
      current: '3.0.0',
      latest: '3.1.0',
      managed: true,
      updateCommand: 'npm install -g @vendor/codex@latest',
    });
    expect(fetchNpmLatest).toHaveBeenCalledTimes(1);
    expect(runFile).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to doctor cache when the explicit npm source is unavailable', async () => {
    const runFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === '--version') return 'vendor-codex 3.0.0';
      return JSON.stringify({
        codexVersion: '3.0.0',
        checks: [{ id: 'updates.status', details: { 'cached latest version': '99.0.0' } }],
      });
    });

    await expect(probeCodexRuntimeUpdate(
      runtimeTarget({
        runtimeId: 'vendor-codex',
        displayName: 'Vendor Codex',
        binPath: '/opt/vendor-codex',
        provider: 'npm',
        packageName: '@vendor/codex',
      }),
      { runFile, fetchNpmLatest: async () => null },
    )).resolves.toEqual({
      current: '3.0.0',
      latest: null,
      managed: true,
      updateCommand: 'npm install -g @vendor/codex@latest',
    });
  });

  it('lets self-managed runtimes use doctor cache but never npm fallback', async () => {
    const runFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === '--version') return 'self-codex 2.0.0';
      return JSON.stringify({
        codexVersion: '2.0.0',
        checks: [{
          id: 'updates.status',
          details: {
            'cached latest version': '2.1.0',
            'update action': 'self-codex update',
          },
        }],
      });
    });
    const fetchNpmLatest = vi.fn(async () => '99.0.0');

    await expect(probeCodexRuntimeUpdate(
      runtimeTarget({
        runtimeId: 'self-codex',
        displayName: 'Self Codex',
        binPath: 'self-codex',
        provider: 'self',
      }),
      { runFile, fetchNpmLatest },
    )).resolves.toEqual({
      current: '2.0.0',
      latest: '2.1.0',
      managed: true,
      updateCommand: 'self-codex update',
    });
    expect(fetchNpmLatest).not.toHaveBeenCalled();
  });

  it('leaves self-managed runtimes unmanaged when doctor current mismatches the executable', async () => {
    const runFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === '--version') return 'vendor-codex 2.0.0';
      return JSON.stringify({
        codexVersion: '0.144.0',
        checks: [{
          id: 'updates.status',
          details: {
            'latest version probe': '99.0.0',
            'update action': 'npm install -g @openai/codex',
          },
        }],
      });
    });

    await expect(probeCodexRuntimeUpdate(
      runtimeTarget({
        runtimeId: 'vendor-codex',
        displayName: 'Vendor Codex',
        binPath: '/opt/vendor-codex',
        provider: 'self',
      }),
      { runFile },
    )).resolves.toEqual({
      current: '2.0.0',
      latest: null,
      managed: false,
      updateCommand: null,
    });
  });
});

describe('runCliRuntimeUpdateAudit', () => {
  it('deduplicates runtime targets, honors TTL, and notifies once per latest', async () => {
    let now = 1_000_000;
    let store: CliRuntimeUpdateStore = { entries: {} };
    let latest = '0.144.3';
    const probe = vi.fn(async () => ({
      current: '0.144.1',
      latest,
      managed: true,
      updateCommand: 'codex update',
    }));
    const notified: string[] = [];
    const target = runtimeTarget({ binPath: '/usr/bin/codex' });
    const deps = () => ({
      now: () => now,
      targets: () => [target, { ...target }],
      readStore: () => store,
      writeStore: (next: CliRuntimeUpdateStore) => { store = structuredClone(next); },
      probe,
      notify: async (entry: CliRuntimeUpdateEntry) => { notified.push(entry.latest!); },
    });

    await runCliRuntimeUpdateAudit(deps());
    expect(probe).toHaveBeenCalledTimes(1);
    expect(notified).toEqual(['0.144.3']);
    expect(store.entries['codex:/usr/bin/codex'].displayName).toBe('Codex');

    now += 60 * 60 * 1_000;
    await runCliRuntimeUpdateAudit(deps());
    expect(probe).toHaveBeenCalledTimes(1);

    now += CLI_RUNTIME_UPDATE_CHECK_INTERVAL_MS;
    await runCliRuntimeUpdateAudit(deps());
    expect(probe).toHaveBeenCalledTimes(2);
    expect(notified).toEqual(['0.144.3']);

    latest = '0.145.0';
    now += CLI_RUNTIME_UPDATE_CHECK_INTERVAL_MS;
    await runCliRuntimeUpdateAudit(deps());
    expect(notified).toEqual(['0.144.3', '0.145.0']);
  });

  it('persists removal of a legacy auto command inside TTL without probing', async () => {
    const now = 1_500_000;
    const key = 'vendor-codex:/opt/vendor-codex';
    let store: CliRuntimeUpdateStore = {
      entries: {
        [key]: updateEntry({
          runtimeId: 'vendor-codex',
          displayName: 'Vendor Codex',
          binPath: '/opt/vendor-codex',
          provider: 'auto',
          packageName: '@vendor/codex',
          current: '1.0.0',
          latest: '1.1.0',
          updateCommand: 'npm install -g @vendor/codex@latest',
          installTarget: '/opt/node_modules/@vendor/codex',
          lastCheckedAt: now - 1_000,
        }),
      },
    };
    const probe = vi.fn();
    const writeStore = vi.fn((next: CliRuntimeUpdateStore) => {
      store = structuredClone(next);
    });

    await runCliRuntimeUpdateAudit({
      now: () => now,
      targets: () => [runtimeTarget({
        runtimeId: 'vendor-codex',
        displayName: 'Vendor Codex',
        binPath: '/opt/vendor-codex',
        provider: 'auto',
      })],
      readStore: () => store,
      writeStore,
      resolveAutoPackage: () => ({
        packageName: '@vendor/codex',
        packageRoot: '/opt/node_modules/@vendor/codex',
      }),
      probe,
    });

    expect(probe).not.toHaveBeenCalled();
    expect(writeStore).toHaveBeenCalledTimes(1);
    expect(store.entries[key]).toMatchObject({
      latest: '1.1.0',
      updateAvailable: true,
      updateCommand: null,
      installTarget: '/opt/node_modules/@vendor/codex',
      lastCheckedAt: now - 1_000,
    });
  });

  it('carries a real reader migration through audit and rewrites the old store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-runtime-auto-migration-'));
    const now = 1_500_000;
    const key = 'vendor-codex:/opt/vendor-codex';
    try {
      writeCliRuntimeUpdateStoreTo(dir, {
        entries: {
          [key]: updateEntry({
            runtimeId: 'vendor-codex',
            displayName: 'Vendor Codex',
            binPath: '/opt/vendor-codex',
            provider: 'auto',
            packageName: '@vendor/codex',
            current: '1.0.0',
            latest: '1.1.0',
            updateCommand: 'npm install -g @vendor/codex@latest',
            installTarget: '/opt/node_modules/@vendor/codex',
            lastCheckedAt: now - 1_000,
          }),
        },
      });
      expect(readCliRuntimeUpdateStoreFrom(dir).entries[key]?.updateCommand).toBeNull();

      const probe = vi.fn();
      const writeStore = vi.fn((store: CliRuntimeUpdateStore) => {
        writeCliRuntimeUpdateStoreTo(dir, store);
      });
      await runCliRuntimeUpdateAudit({
        now: () => now,
        targets: () => [runtimeTarget({
          runtimeId: 'vendor-codex',
          displayName: 'Vendor Codex',
          binPath: '/opt/vendor-codex',
          provider: 'auto',
        })],
        readStore: () => readCliRuntimeUpdateStoreFrom(dir),
        writeStore,
        resolveAutoPackage: () => ({
          packageName: '@vendor/codex',
          packageRoot: '/opt/node_modules/@vendor/codex',
        }),
        probe,
      });

      expect(probe).not.toHaveBeenCalled();
      expect(writeStore).toHaveBeenCalledTimes(1);
      const persisted = JSON.parse(readFileSync(cliRuntimeUpdateStorePathIn(dir), 'utf8')) as {
        entries: Record<string, CliRuntimeUpdateEntry>;
      };
      expect(persisted.entries[key]).toMatchObject({
        latest: '1.1.0',
        updateAvailable: true,
        updateCommand: null,
        installTarget: '/opt/node_modules/@vendor/codex',
        lastCheckedAt: now - 1_000,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears stale latest data after a successful unmanaged probe', async () => {
    let store: CliRuntimeUpdateStore = {
      entries: {
        'acme-codex:/opt/acme-codex': updateEntry({
          runtimeId: 'acme-codex',
          displayName: 'Acme Codex',
          binPath: '/opt/acme-codex',
          provider: 'auto',
          current: '1.0.0',
          latest: '99.0.0',
          updateCommand: 'codex update',
          lastCheckedAt: 1,
        }),
      },
    };
    const notify = vi.fn();

    await runCliRuntimeUpdateAudit({
      now: () => CLI_RUNTIME_UPDATE_CHECK_INTERVAL_MS + 10,
      targets: () => [runtimeTarget({
        runtimeId: 'acme-codex',
        displayName: 'Acme Codex',
        binPath: '/opt/acme-codex',
        provider: 'auto',
      })],
      readStore: () => store,
      writeStore: (next) => { store = structuredClone(next); },
      probe: async () => ({
        current: '1.0.0',
        latest: null,
        managed: false,
        updateCommand: null,
      }),
      notify,
    });

    expect(store.entries['acme-codex:/opt/acme-codex']).toMatchObject({
      managed: false,
      current: '1.0.0',
      latest: null,
      updateAvailable: false,
      updateCommand: null,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('bypasses TTL and resets the notification watermark when provider changes', async () => {
    const now = 2_000_000;
    const key = 'vendor-codex:/opt/vendor-codex';
    let store: CliRuntimeUpdateStore = {
      entries: {
        [key]: updateEntry({
          runtimeId: 'vendor-codex',
          displayName: 'Vendor Codex',
          binPath: '/opt/vendor-codex',
          provider: 'auto',
          current: '1.0.0',
          latest: '1.1.0',
          updateCommand: 'npm install -g @openai/codex',
          lastCheckedAt: now - 1_000,
          lastNotifiedVersion: '1.1.0',
        }),
      },
    };
    const probe = vi.fn(async () => ({
      current: '1.0.0',
      latest: '1.1.0',
      managed: true,
      updateCommand: 'npm install -g @vendor/codex@latest',
    }));
    const notify = vi.fn(async () => {});

    await runCliRuntimeUpdateAudit({
      now: () => now,
      targets: () => [runtimeTarget({
        runtimeId: 'vendor-codex',
        displayName: 'Vendor Codex',
        binPath: '/opt/vendor-codex',
        provider: 'npm',
        packageName: '@vendor/codex',
      })],
      readStore: () => store,
      writeStore: (next) => { store = structuredClone(next); },
      probe,
      notify,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(store.entries[key]).toMatchObject({
      provider: 'npm',
      packageName: '@vendor/codex',
      sourceFingerprint: JSON.stringify(['npm', '@vendor/codex']),
      current: '1.0.0',
      latest: '1.1.0',
      updateCommand: 'npm install -g @vendor/codex@latest',
      lastNotifiedVersion: '1.1.0',
    });
  });

  it('refreshes auto package ownership before TTL and isolates its notification watermark', async () => {
    const now = 2_500_000;
    const key = 'vendor-codex:/opt/vendor-codex';
    let store: CliRuntimeUpdateStore = {
      entries: {
        [key]: updateEntry({
          runtimeId: 'vendor-codex',
          displayName: 'Vendor Codex',
          binPath: '/opt/vendor-codex',
          provider: 'auto',
          packageName: '@vendor/codex-a',
          current: '1.0.0',
          latest: '1.1.0',
          updateCommand: 'npm install -g @vendor/codex-a@latest',
          installTarget: '/opt/node_modules/@vendor/codex-a',
          lastCheckedAt: now - 1_000,
          lastNotifiedVersion: '1.1.0',
        }),
      },
    };
    const resolveAutoPackage = vi.fn(() => ({
      packageName: '@vendor/codex-b',
      packageRoot: '/opt/node_modules/@vendor/codex-b',
    }));
    const probe = vi.fn(async (target: CliRuntimeUpdateTarget) => {
      expect(target).toMatchObject({
        provider: 'auto',
        packageName: '@vendor/codex-b',
        packageRoot: '/opt/node_modules/@vendor/codex-b',
      });
      return {
        current: '1.0.0',
        latest: '1.1.0',
        managed: true,
        packageName: '@vendor/codex-b',
        // Audit is a trust boundary too: a custom/injected probe must not make
        // an auto target regain an inferred package-manager command.
        updateCommand: 'npm install -g @vendor/codex-b@latest',
        installTarget: '/opt/node_modules/@vendor/codex-b',
      };
    });
    const notify = vi.fn(async () => {});

    await runCliRuntimeUpdateAudit({
      now: () => now,
      targets: () => [runtimeTarget({
        runtimeId: 'vendor-codex',
        displayName: 'Vendor Codex',
        binPath: '/opt/vendor-codex',
        provider: 'auto',
      })],
      readStore: () => store,
      writeStore: (next) => { store = structuredClone(next); },
      resolveAutoPackage,
      probe,
      notify,
    });

    expect(resolveAutoPackage).toHaveBeenCalledWith('/opt/vendor-codex');
    expect(probe).toHaveBeenCalledTimes(1);
    // Same latest number must notify again because it now belongs to package B,
    // not package A's notification watermark.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(store.entries[key]).toMatchObject({
      provider: 'auto',
      packageName: '@vendor/codex-b',
      sourceFingerprint: JSON.stringify(['auto', '@vendor/codex-b']),
      current: '1.0.0',
      latest: '1.1.0',
      updateCommand: null,
      installTarget: '/opt/node_modules/@vendor/codex-b',
      lastNotifiedVersion: '1.1.0',
    });
  });

  it('does not inherit status or notification state when the npm package changes and probing fails', async () => {
    const now = 3_000_000;
    const key = 'vendor-codex:/opt/vendor-codex';
    let store: CliRuntimeUpdateStore = {
      entries: {
        [key]: updateEntry({
          runtimeId: 'vendor-codex',
          displayName: 'Vendor Codex',
          binPath: '/opt/vendor-codex',
          provider: 'npm',
          packageName: '@vendor/codex-old',
          current: '1.0.0',
          latest: '9.9.9',
          updateCommand: 'npm install -g @vendor/codex-old@latest',
          installTarget: '/opt/vendor/codex-old',
          lastCheckedAt: now - 1_000,
          lastNotifiedVersion: '9.9.9',
        }),
      },
    };
    const probe = vi.fn(async () => { throw new Error('offline'); });

    await runCliRuntimeUpdateAudit({
      now: () => now,
      targets: () => [runtimeTarget({
        runtimeId: 'vendor-codex',
        displayName: 'Vendor Codex',
        binPath: '/opt/vendor-codex',
        provider: 'npm',
        packageName: '@vendor/codex-new',
      })],
      readStore: () => store,
      writeStore: (next) => { store = structuredClone(next); },
      probe,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(store.entries[key]).toEqual({
      cliId: 'codex',
      runtimeId: 'vendor-codex',
      displayName: 'Vendor Codex',
      binPath: '/opt/vendor-codex',
      installationPath: '/opt/vendor-codex',
      provider: 'npm',
      packageName: '@vendor/codex-new',
      sourceFingerprint: JSON.stringify(['npm', '@vendor/codex-new']),
      managed: true,
      current: null,
      latest: null,
      updateAvailable: false,
      updateCommand: null,
      lastCheckedAt: now,
    });
  });

  it('skips an installation when audit targets disagree on its update source', async () => {
    let store: CliRuntimeUpdateStore = { entries: {} };
    const probe = vi.fn();
    await runCliRuntimeUpdateAudit({
      now: () => 5_000,
      targets: () => [
        runtimeTarget({ runtimeId: 'vendor-codex', binPath: '/opt/vendor-codex', provider: 'auto' }),
        runtimeTarget({
          runtimeId: 'vendor-codex',
          binPath: '/opt/vendor-codex',
          provider: 'npm',
          packageName: '@vendor/codex',
        }),
      ],
      readStore: () => store,
      writeStore: (next) => { store = structuredClone(next); },
      probe,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(store.entries).toEqual({});
  });

  it('skips an installation when the same binary is assigned different runtime ids', async () => {
    let store: CliRuntimeUpdateStore = { entries: {} };
    const probe = vi.fn();
    await runCliRuntimeUpdateAudit({
      now: () => 5_000,
      targets: () => [
        runtimeTarget({
          runtimeId: 'vendor-a',
          binPath: '/opt/shared/vendor-codex',
          provider: 'npm',
          packageName: '@vendor/a',
        }),
        runtimeTarget({
          runtimeId: 'vendor-b',
          binPath: '/opt/shared/vendor-codex',
          provider: 'npm',
          packageName: '@vendor/b',
        }),
      ],
      readStore: () => store,
      writeStore: (next) => { store = structuredClone(next); },
      probe,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(store.entries).toEqual({});
  });

  it('marks failed probes checked so an hourly tick does not retry noisily', async () => {
    let store: CliRuntimeUpdateStore = { entries: {} };
    const probe = vi.fn(async () => { throw new Error('offline'); });
    const deps = {
      now: () => 5_000,
      targets: () => [runtimeTarget({ binPath: '/bad/codex' })],
      readStore: () => store,
      writeStore: (next: CliRuntimeUpdateStore) => { store = structuredClone(next); },
      probe,
    };
    await runCliRuntimeUpdateAudit(deps);
    await runCliRuntimeUpdateAudit(deps);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('removes persisted runtimes that are no longer configured', async () => {
    let store: CliRuntimeUpdateStore = {
      entries: {
        'old-codex:/old/codex': updateEntry({
          runtimeId: 'old-codex',
          displayName: 'Old Codex',
          binPath: '/old/codex',
        }),
      },
    };
    await runCliRuntimeUpdateAudit({
      now: () => 5_000,
      targets: () => [],
      readStore: () => store,
      writeStore: (next) => { store = structuredClone(next); },
      probe: vi.fn(),
    });
    expect(store.entries).toEqual({});
  });
});

describe('CLI runtime update store and card', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-cli-update-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('persists runtime identity and derives updateAvailable on read', () => {
    writeCliRuntimeUpdateStoreTo(dir, {
      entries: {
        'acme-codex:/opt/acme-codex': updateEntry({
          runtimeId: 'acme-codex',
          displayName: 'Acme Codex',
          binPath: '/opt/acme-codex',
          provider: 'npm',
          packageName: '@acme/codex',
          current: '1.0.0',
          latest: '1.1.0',
          updateAvailable: false,
          updateCommand: 'npm install -g @acme/codex@latest',
        }),
      },
    });

    expect(cliRuntimeUpdateStorePathIn(dir)).toBe(join(dir, 'cli-runtime-updates.json'));
    expect(readCliRuntimeUpdateStoreFrom(dir).entries['acme-codex:/opt/acme-codex']).toMatchObject({
      runtimeId: 'acme-codex',
      displayName: 'Acme Codex',
      provider: 'npm',
      packageName: '@acme/codex',
      sourceFingerprint: JSON.stringify(['npm', '@acme/codex']),
      managed: true,
      updateAvailable: true,
    });
  });

  it('retains auto package identity but strips a legacy inferred update command', () => {
    writeCliRuntimeUpdateStoreTo(dir, {
      entries: {
        'vendor-codex:/opt/vendor-codex': updateEntry({
          runtimeId: 'vendor-codex',
          displayName: 'Vendor Codex',
          binPath: '/opt/vendor-codex',
          provider: 'auto',
          packageName: '@vendor/codex',
          current: '1.0.0',
          latest: '1.1.0',
          updateCommand: 'npm install -g @vendor/codex@latest',
        }),
      },
    });

    expect(readCliRuntimeUpdateStoreFrom(dir).entries['vendor-codex:/opt/vendor-codex'])
      .toMatchObject({
        provider: 'auto',
        packageName: '@vendor/codex',
        sourceFingerprint: JSON.stringify(['auto', '@vendor/codex']),
        managed: true,
        latest: '1.1.0',
        updateAvailable: true,
        updateCommand: null,
      });
  });

  it('reads v1 official Codex entries with compatible identity defaults', () => {
    writeFileSync(cliRuntimeUpdateStorePathIn(dir), JSON.stringify({
      entries: {
        'codex:/usr/bin/codex': {
          cliId: 'codex',
          binPath: '/usr/bin/codex',
          current: '0.144.1',
          latest: '0.144.3',
          updateAvailable: false,
          updateCommand: 'codex update',
          lastCheckedAt: 123,
        },
      },
    }));

    expect(readCliRuntimeUpdateStoreFrom(dir).entries['codex:/usr/bin/codex']).toEqual(
      updateEntry({
        binPath: '/usr/bin/codex',
        lastCheckedAt: 123,
      }),
    );
  });

  it('never upgrades an incomplete custom store entry to the official provider', () => {
    writeFileSync(cliRuntimeUpdateStorePathIn(dir), JSON.stringify({
      entries: {
        'vendor-codex:/opt/vendor-codex': {
          cliId: 'codex',
          runtimeId: 'vendor-codex',
          displayName: 'Vendor Codex',
          binPath: '/opt/vendor-codex',
          current: '1.0.0',
          latest: '1.1.0',
          updateAvailable: true,
          updateCommand: 'codex update',
          lastCheckedAt: 123,
        },
      },
    }));

    expect(readCliRuntimeUpdateStoreFrom(dir).entries['vendor-codex:/opt/vendor-codex'])
      .toMatchObject({
        provider: 'auto',
        managed: false,
        latest: null,
        updateAvailable: false,
        updateCommand: null,
        sourceFingerprint: JSON.stringify(['auto', '']),
      });
  });

  it('uses runtime display name in an owner-only reminder', () => {
    const card = buildCliRuntimeUpdateCard(updateEntry({
      runtimeId: 'acme-codex',
      displayName: 'Acme Codex',
      binPath: '/opt/acme-codex',
      provider: 'npm',
      current: '1.0.0',
      latest: '1.1.0',
      updateCommand: 'npm install -g @acme/codex@latest',
    }), { dashboardUrl: 'http://dashboard', locale: 'zh' });

    expect(card).toContain('Acme Codex');
    expect(card).toContain('1.0.0');
    expect(card).toContain('1.1.0');
    expect(card).toContain('npm install -g @acme/codex@latest');
    expect(card).toContain('不会自动安装');
    expect(card).not.toContain('button');
  });

  it('escapes a runtime display name only in the Markdown body', () => {
    const displayName = 'Acme *Codex* <at id=all></at>';
    const card = JSON.parse(buildCliRuntimeUpdateCard(updateEntry({
      runtimeId: 'acme-codex',
      displayName,
      provider: 'npm',
    }), { locale: 'en' }));

    expect(card.header.title).toEqual({
      tag: 'plain_text',
      content: `New ${displayName} version available`,
    });
    expect(card.elements[0].content).toContain(
      'Acme \\*Codex\\* \\<at id=all\\>\\</at\\>',
    );
    expect(card.elements[0].content).not.toContain('<at id=all></at>');
  });

  it('does not invent an update command for an unmanaged runtime', () => {
    const card = buildCliRuntimeUpdateCard(updateEntry({
      runtimeId: 'unknown-codex',
      displayName: 'Unknown Codex',
      provider: 'auto',
      managed: false,
      current: '1.0.0',
      latest: null,
      updateAvailable: false,
      updateCommand: null,
    }), { locale: 'zh' });

    expect(card).toContain('Unknown Codex');
    expect(card).not.toContain('codex update');
  });
});

describe('runCliRuntimeUpdateAudit with FNM rotating launcher symlinks', () => {
  let dir: string;
  let realInstall: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-cli-runtime-fnm-'));
    // One real installation, mirroring @openai/codex under an fnm node version.
    mkdirSync(join(dir, 'install', 'bin'), { recursive: true });
    realInstall = join(dir, 'install', 'bin', 'codex.js');
    writeFileSync(realInstall, '#!/usr/bin/env node\n');
    realInstall = realpathSync(realInstall);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Mint a fresh per-shell launcher symlink like fnm's
   * `/run/user/.../fnm_multishells/<pid>_.../bin/codex`, all resolving to the
   * single real install. */
  function rotatingBin(shellId: string): string {
    const shellBin = join(dir, 'multishells', shellId, 'bin');
    mkdirSync(shellBin, { recursive: true });
    const link = join(shellBin, 'codex');
    symlinkSync(realInstall, link);
    return link;
  }

  it('does not re-probe or re-notify within 24h when the raw path rotates but realpath is stable (criteria 1)', async () => {
    let now = 1_000_000;
    let store: CliRuntimeUpdateStore = { entries: {} };
    const probe = vi.fn(async (target: CliRuntimeUpdateTarget) => ({
      current: '0.146.0',
      latest: '0.147.0',
      managed: true,
      updateCommand: `${target.binPath} update`,
    }));
    const notified: string[] = [];
    const deps = (binPath: string) => ({
      now: () => now,
      targets: () => [runtimeTarget({ runtimeId: 'codex', binPath, provider: 'internal' })],
      readStore: () => store,
      writeStore: (next: CliRuntimeUpdateStore) => { store = structuredClone(next); },
      probe,
      notify: async (entry: CliRuntimeUpdateEntry) => { notified.push(entry.latest!); },
    });

    // First tick: fresh shell -> probe + notify once.
    await runCliRuntimeUpdateAudit(deps(rotatingBin('101_aaa')));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(notified).toEqual(['0.147.0']);

    const key = `codex:${realInstall}`;
    expect(Object.keys(store.entries)).toEqual([key]);
    expect(store.entries[key].installationPath).toBe(realInstall);

    // Second tick 1h later: new fnm shell -> new raw path, same realpath.
    // TTL must hold and the watermark must survive: no probe, no notify.
    now += 60 * 60 * 1_000;
    await runCliRuntimeUpdateAudit(deps(rotatingBin('202_bbb')));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(notified).toEqual(['0.147.0']);
    expect(Object.keys(store.entries)).toEqual([key]);
  });

  it('re-probes after 24h through a rotated path but does not notify again for the same latest (criteria 2)', async () => {
    let now = 1_000_000;
    let store: CliRuntimeUpdateStore = { entries: {} };
    const probe = vi.fn(async () => ({
      current: '0.146.0',
      latest: '0.147.0',
      managed: true,
      updateCommand: 'codex update',
    }));
    const notified: string[] = [];
    const deps = (binPath: string) => ({
      now: () => now,
      targets: () => [runtimeTarget({ runtimeId: 'codex', binPath, provider: 'internal' })],
      readStore: () => store,
      writeStore: (next: CliRuntimeUpdateStore) => { store = structuredClone(next); },
      probe,
      notify: async (entry: CliRuntimeUpdateEntry) => { notified.push(entry.latest!); },
    });

    await runCliRuntimeUpdateAudit(deps(rotatingBin('301_aaa')));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(notified).toEqual(['0.147.0']);

    // > 24h later, through a rotated launcher path: TTL elapses so we re-probe,
    // but the unchanged latest must not notify again.
    now += CLI_RUNTIME_UPDATE_CHECK_INTERVAL_MS + 1;
    await runCliRuntimeUpdateAudit(deps(rotatingBin('302_bbb')));
    expect(probe).toHaveBeenCalledTimes(2);
    expect(notified).toEqual(['0.147.0']);
  });

  it('treats a launcher retargeted to a different real install as a new identity (criteria 3)', async () => {
    let now = 1_000_000;
    let store: CliRuntimeUpdateStore = { entries: {} };
    const probe = vi.fn(async () => ({
      current: '0.146.0',
      latest: '0.147.0',
      managed: true,
      updateCommand: 'codex update',
    }));
    const notified: string[] = [];
    const deps = (binPath: string) => ({
      now: () => now,
      targets: () => [runtimeTarget({ runtimeId: 'codex', binPath, provider: 'internal' })],
      readStore: () => store,
      writeStore: (next: CliRuntimeUpdateStore) => { store = structuredClone(next); },
      probe,
      notify: async (entry: CliRuntimeUpdateEntry) => { notified.push(entry.latest!); },
    });

    await runCliRuntimeUpdateAudit(deps(rotatingBin('401_aaa')));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(notified).toEqual(['0.147.0']);
    const firstKey = `codex:${realInstall}`;

    // A genuinely different install (upgrade to a new node version dir) is a new
    // realpath. Even within the old TTL window it must re-probe under its own
    // key and notify on its own merits — not inherit the prior watermark.
    mkdirSync(join(dir, 'install-v2', 'bin'), { recursive: true });
    const realInstallV2 = join(dir, 'install-v2', 'bin', 'codex.js');
    writeFileSync(realInstallV2, '#!/usr/bin/env node\n');
    const canonicalInstallV2 = realpathSync(realInstallV2);
    const shellBin = join(dir, 'multishells', '402_bbb', 'bin');
    mkdirSync(shellBin, { recursive: true });
    const link = join(shellBin, 'codex');
    symlinkSync(realInstallV2, link);

    now += 60 * 60 * 1_000; // still inside the 24h TTL of the old entry
    await runCliRuntimeUpdateAudit(deps(link));
    expect(probe).toHaveBeenCalledTimes(2);
    expect(notified).toEqual(['0.147.0', '0.147.0']);
    const secondKey = `codex:${canonicalInstallV2}`;
    expect(secondKey).not.toBe(firstKey);
    expect(store.entries[secondKey].installationPath).toBe(canonicalInstallV2);
  });

  it('migrates a legacy raw-path entry onto the stable key without re-notifying (criteria = safe upgrade)', async () => {
    const now = 5_000_000;
    // Store written by an older build: keyed by a now-dead fnm launcher path,
    // no installationPath, already carrying a notification watermark.
    const deadRawPath = join(dir, 'multishells', 'OLD_dead', 'bin', 'codex');
    const legacyKey = `codex:${deadRawPath}`;
    let store: CliRuntimeUpdateStore = {
      entries: {
        [legacyKey]: {
          ...updateEntry({
            runtimeId: 'codex',
            binPath: deadRawPath,
            provider: 'internal',
            current: '0.146.0',
            latest: '0.147.0',
            updateCommand: 'codex update',
            lastCheckedAt: now - 1_000,
            lastNotifiedVersion: '0.147.0',
          }),
          // Simulate a pre-fix persisted row: identity field absent.
          installationPath: undefined as unknown as string,
        },
      },
    };
    const probe = vi.fn(async () => ({
      current: '0.146.0',
      latest: '0.147.0',
      managed: true,
      updateCommand: 'codex update',
    }));
    const notify = vi.fn(async () => {});

    // A live shell resolves to the real install; TTL has not elapsed.
    await runCliRuntimeUpdateAudit({
      now: () => now,
      targets: () => [runtimeTarget({ runtimeId: 'codex', binPath: rotatingBin('501_live'), provider: 'internal' })],
      readStore: () => store,
      writeStore: (next: CliRuntimeUpdateStore) => { store = structuredClone(next); },
      probe,
      notify,
    });

    const stableKey = `codex:${realInstall}`;
    // Legacy row was moved onto the stable identity; watermark carried over so
    // upgrading botmux does not fire one more notification, and TTL is honored.
    expect(Object.keys(store.entries)).toEqual([stableKey]);
    expect(store.entries[stableKey]).toMatchObject({
      installationPath: realInstall,
      lastNotifiedVersion: '0.147.0',
      latest: '0.147.0',
    });
    expect(probe).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not migrate a dead orphan onto an arbitrary install when two live installs share runtimeId+source (ambiguous group)', async () => {
    const now = 5_500_000;
    // Two genuinely distinct installs of the same distribution (e.g. one under
    // an old node version dir, one under a new one), both currently live and
    // both sharing runtimeId 'codex' + the same update source. Neither has a
    // persisted entry yet.
    mkdirSync(join(dir, 'install-b', 'bin'), { recursive: true });
    mkdirSync(join(dir, 'install-c', 'bin'), { recursive: true });
    const installB = join(dir, 'install-b', 'bin', 'codex.js');
    const installC = join(dir, 'install-c', 'bin', 'codex.js');
    writeFileSync(installB, '#!/usr/bin/env node\n');
    writeFileSync(installC, '#!/usr/bin/env node\n');
    const canonicalInstallB = realpathSync(installB);
    const canonicalInstallC = realpathSync(installC);
    const binB = join(dir, 'multishells', 'B_live', 'bin');
    const binC = join(dir, 'multishells', 'C_live', 'bin');
    mkdirSync(binB, { recursive: true });
    mkdirSync(binC, { recursive: true });
    symlinkSync(installB, join(binB, 'codex'));
    symlinkSync(installC, join(binC, 'codex'));

    // A single dead orphan from a removed install, same runtimeId+source,
    // carrying a within-TTL watermark. Adopting it onto B or C by iteration
    // order would suppress that install's next probe/notify — the bug.
    const deadRawPath = join(dir, 'multishells', 'OLD_dead', 'bin', 'codex');
    const orphanKey = `codex:${resolve(deadRawPath)}`;
    let store: CliRuntimeUpdateStore = {
      entries: {
        [orphanKey]: updateEntry({
          runtimeId: 'codex',
          binPath: deadRawPath,
          provider: 'internal',
          current: '0.146.0',
          latest: '0.147.0',
          updateCommand: 'codex update',
          lastCheckedAt: now - 1_000,
          lastNotifiedVersion: '0.147.0',
        }),
      },
    };
    const probe = vi.fn(async () => ({
      current: '0.146.0',
      latest: '0.147.0',
      managed: true,
      updateCommand: 'codex update',
    }));
    const notified: string[] = [];

    await runCliRuntimeUpdateAudit({
      now: () => now,
      targets: () => [
        runtimeTarget({ runtimeId: 'codex', binPath: join(binB, 'codex'), provider: 'internal' }),
        runtimeTarget({ runtimeId: 'codex', binPath: join(binC, 'codex'), provider: 'internal' }),
      ],
      readStore: () => store,
      writeStore: (next: CliRuntimeUpdateStore) => { store = structuredClone(next); },
      probe,
      notify: async (entry: CliRuntimeUpdateEntry) => { notified.push(entry.latest!); },
    });

    // Ambiguous group: no migration. Each live install probes and notifies
    // under its own canonical identity; the dead orphan is pruned.
    const keyB = `codex:${canonicalInstallB}`;
    const keyC = `codex:${canonicalInstallC}`;
    expect(probe).toHaveBeenCalledTimes(2);
    expect(notified).toEqual(['0.147.0', '0.147.0']);
    expect(Object.keys(store.entries).sort()).toEqual([keyB, keyC].sort());
    expect(store.entries[keyB]?.installationPath).toBe(canonicalInstallB);
    expect(store.entries[keyC]?.installationPath).toBe(canonicalInstallC);
  });

  it('reindexes a pre-fix entry whose rotating symlink is still alive, keeping its watermark (criteria 1/4 boundary)', async () => {
    const now = 6_000_000;
    // Reviewer boundary: an older build persisted this row keyed by a rotating
    // launcher path that HAPPENS to still resolve at upgrade time, and the row
    // has no installationPath. The real reader must recover the stable identity
    // from that live path so the entry reindexes (not "stale-only migrates")
    // onto the canonical key — otherwise the carried watermark would be lost and
    // the first post-upgrade audit would notify once more.
    const aliveOldBin = rotatingBin('601_old_alive');
    const legacyKey = `codex:${aliveOldBin}`; // pre-fix key = raw path
    // Write a v-without-installationPath store straight to disk, then read it
    // back through the production reader (not an in-memory shortcut).
    writeFileSync(cliRuntimeUpdateStorePathIn(dir), JSON.stringify({
      entries: {
        [legacyKey]: {
          cliId: 'codex',
          runtimeId: 'codex',
          displayName: 'Codex',
          binPath: aliveOldBin,
          provider: 'internal',
          managed: true,
          current: '0.146.0',
          latest: '0.147.0',
          updateAvailable: true,
          updateCommand: 'codex update',
          lastCheckedAt: now - 1_000,
          lastNotifiedVersion: '0.147.0',
          // installationPath intentionally absent (pre-fix store).
        },
      },
    }));
    // The reader derives installationPath from the still-live raw path.
    const recovered = readCliRuntimeUpdateStoreFrom(dir);
    expect(recovered.entries[legacyKey]?.installationPath).toBe(realInstall);

    const probe = vi.fn(async () => ({
      current: '0.146.0',
      latest: '0.147.0',
      managed: true,
      updateCommand: 'codex update',
    }));
    const notify = vi.fn(async () => {});

    // Next audit uses a freshly rotated launcher path (different raw path, same
    // realpath), still inside the 24h TTL.
    await runCliRuntimeUpdateAudit({
      now: () => now,
      targets: () => [runtimeTarget({ runtimeId: 'codex', binPath: rotatingBin('602_new_alive'), provider: 'internal' })],
      readStore: () => readCliRuntimeUpdateStoreFrom(dir),
      writeStore: (next: CliRuntimeUpdateStore) => { writeCliRuntimeUpdateStoreTo(dir, next); },
      probe,
      notify,
    });

    const persisted = JSON.parse(readFileSync(cliRuntimeUpdateStorePathIn(dir), 'utf8')) as {
      entries: Record<string, CliRuntimeUpdateEntry>;
    };
    const stableKey = `codex:${realInstall}`;
    expect(Object.keys(persisted.entries)).toEqual([stableKey]);
    expect(persisted.entries[stableKey]).toMatchObject({
      installationPath: realInstall,
      lastNotifiedVersion: '0.147.0',
      lastCheckedAt: now - 1_000,
    });
    // Watermark survived and TTL held: no re-probe, no extra notification.
    expect(probe).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
