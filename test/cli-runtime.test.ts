import { describe, expect, it } from 'vitest';

import {
  normalizeCliRuntimeConfig,
  resolveCliRuntime,
  runtimeIdentityKey,
  runtimeInstallationKey,
  runtimePathOverride,
  sameRuntimeIdentity,
  snapshotCliRuntime,
  type CliRuntimeSnapshot,
} from '../src/adapters/cli/runtime.js';

describe('normalizeCliRuntimeConfig', () => {
  it('accepts a configured runtime and preserves an executable path containing spaces', () => {
    expect(normalizeCliRuntimeConfig({
      id: 'vendor-codex.1',
      displayName: 'Vendor Codex',
      executable: '/Applications/Vendor Codex/bin/vendorCodex',
      update: { provider: 'npm', packageName: ' @vendor/codex ' },
    }, 'bot.cliRuntime')).toEqual({
      id: 'vendor-codex.1',
      displayName: 'Vendor Codex',
      executable: '/Applications/Vendor Codex/bin/vendorCodex',
      update: { provider: 'npm', packageName: '@vendor/codex' },
    });
  });

  it.each(['auto', 'self', 'none'] as const)('accepts the %s update provider', (provider) => {
    expect(normalizeCliRuntimeConfig({
      id: 'vendor',
      executable: 'vendorCodex',
      update: { provider },
    }, 'cliRuntime').update).toEqual({ provider });
  });

  it('allows the optional fields to be omitted', () => {
    expect(normalizeCliRuntimeConfig({ id: 'vendor', executable: 'vendorCodex' }, 'cliRuntime'))
      .toEqual({ id: 'vendor', executable: 'vendorCodex' });
  });

  it('strictly validates runtime ids', () => {
    const valid64 = `a${'b'.repeat(63)}`;
    expect(normalizeCliRuntimeConfig({ id: valid64, executable: 'x' }, 'runtime').id).toBe(valid64);
    for (const id of ['', '-bad', '.bad', 'has space', `a${'b'.repeat(64)}`, 'bad/slash']) {
      expect(() => normalizeCliRuntimeConfig({ id, executable: 'x' }, 'runtime')).toThrow(/runtime: id must match/);
    }
  });

  it('reserves the official Codex runtime id for the built-in descriptor', () => {
    for (const id of ['codex', 'Codex', 'CODEX']) {
      expect(() => normalizeCliRuntimeConfig({ id, executable: 'vendorCodex' }, 'runtime'))
        .toThrow(/reserved.*official Codex runtime/i);
    }
  });

  it('requires a plain object and rejects unknown fields', () => {
    for (const raw of [null, [], 'vendor']) {
      expect(() => normalizeCliRuntimeConfig(raw, 'bot.cliRuntime')).toThrow(/bot\.cliRuntime: must be an object/);
    }
    expect(() => normalizeCliRuntimeConfig({
      id: 'vendor', executable: 'vendorCodex', surprise: true,
    }, 'bot.cliRuntime')).toThrow(/unknown field: surprise/);
  });

  it('requires a short, non-empty, single-line display name', () => {
    for (const displayName of ['', '   ', 'Vendor\nCodex', 'Vendor\rCodex', 'Vendor\tCodex', 'Vendor\u001bCodex', `x${'界'.repeat(64)}`]) {
      expect(() => normalizeCliRuntimeConfig({
        id: 'vendor', executable: 'vendorCodex', displayName,
      }, 'runtime')).toThrow(/displayName/);
    }
    expect(normalizeCliRuntimeConfig({
      id: 'vendor', executable: 'vendorCodex', displayName: '界'.repeat(64),
    }, 'runtime').displayName).toBe('界'.repeat(64));
    expect(normalizeCliRuntimeConfig({
      id: 'vendor', executable: 'vendorCodex', displayName: '  Vendor Codex  ',
    }, 'runtime').displayName).toBe('Vendor Codex');
  });

  it('accepts only bare command names or absolute POSIX/Windows paths', () => {
    for (const executable of ['', '  ', 'vendor\0codex', 'vendor\ncodex', 'vendor\rcodex']) {
      expect(() => normalizeCliRuntimeConfig({ id: 'vendor', executable }, 'runtime')).toThrow(/executable/);
    }
    for (const executable of ['./vendorCodex', '../vendorCodex', 'bin/vendorCodex', String.raw`bin\vendorCodex`, 'vendor Codex']) {
      expect(() => normalizeCliRuntimeConfig({ id: 'vendor', executable }, 'runtime'))
        .toThrow(/bare command name or an absolute POSIX\/Windows path/);
    }
    expect(normalizeCliRuntimeConfig({ id: 'vendor', executable: 'vendorCodex' }, 'runtime').executable)
      .toBe('vendorCodex');
    expect(normalizeCliRuntimeConfig({
      id: 'vendor', executable: '/opt/Vendor Codex/vendorCodex',
    }, 'runtime').executable).toBe('/opt/Vendor Codex/vendorCodex');
    expect(normalizeCliRuntimeConfig({
      id: 'vendor', executable: String.raw`C:\Program Files\Vendor Codex\vendorCodex.exe`,
    }, 'runtime').executable).toBe(String.raw`C:\Program Files\Vendor Codex\vendorCodex.exe`);
    expect(normalizeCliRuntimeConfig({
      id: 'vendor', executable: String.raw`\\server\share\Vendor Codex\vendorCodex.exe`,
    }, 'runtime').executable).toBe(String.raw`\\server\share\Vendor Codex\vendorCodex.exe`);
  });

  it('requires a distinct executable alias for a custom Codex runtime', () => {
    for (const executable of ['codex', 'CODEX', '/opt/vendor/codex', String.raw`C:\Vendor\codex.exe`]) {
      expect(() => normalizeCliRuntimeConfig({ id: 'vendor', executable }, 'runtime'))
        .toThrow(/basename "codex" is reserved/i);
    }
  });

  it('strictly validates update provider shape', () => {
    const base = { id: 'vendor', executable: 'vendorCodex' };
    expect(() => normalizeCliRuntimeConfig({ ...base, update: 'auto' }, 'runtime')).toThrow(/update: must be an object/);
    expect(() => normalizeCliRuntimeConfig({ ...base, update: { provider: 'other' } }, 'runtime')).toThrow(/provider/);
    expect(() => normalizeCliRuntimeConfig({ ...base, update: { provider: 'npm' } }, 'runtime')).toThrow(/packageName is required/);
    expect(() => normalizeCliRuntimeConfig({ ...base, update: { provider: 'npm', packageName: ' ' } }, 'runtime')).toThrow(/packageName is required/);
    expect(() => normalizeCliRuntimeConfig({ ...base, update: { provider: 'self', packageName: 'x' } }, 'runtime')).toThrow(/only valid/);
    expect(() => normalizeCliRuntimeConfig({ ...base, update: { provider: 'self', extra: true } }, 'runtime')).toThrow(/unknown field/);
    for (const packageName of ['UPPER', '@scope', '@Scope/pkg', '../pkg', 'has space']) {
      expect(() => normalizeCliRuntimeConfig({ ...base, update: { provider: 'npm', packageName } }, 'runtime'))
        .toThrow(/valid lowercase npm package name/);
    }
  });
});

describe('resolveCliRuntime', () => {
  it('resolves plain Codex to the official runtime with its internal update source', () => {
    const runtime = resolveCliRuntime({ cliId: 'codex' });
    expect(runtime).toEqual({
      id: 'codex',
      displayName: 'Codex',
      executable: 'codex',
      source: 'official',
      update: { provider: 'internal' },
    });
    expect(runtimePathOverride(runtime)).toBeUndefined();
  });

  it('resolves a configured Codex runtime and defaults its update provider to auto', () => {
    const runtime = resolveCliRuntime({
      cliId: 'codex',
      cliRuntime: { id: 'vendor', executable: '/opt/vendor/vendorCodex' },
    });
    expect(runtime).toEqual({
      id: 'vendor',
      displayName: 'vendor',
      executable: '/opt/vendor/vendorCodex',
      source: 'configured',
      update: { provider: 'auto' },
    });
    expect(runtimePathOverride(runtime)).toBe('/opt/vendor/vendorCodex');
  });

  it('turns a legacy path into a basename-based runtime snapshot', () => {
    expect(resolveCliRuntime({
      cliId: 'codex',
      cliPathOverride: '/opt/Vendor Codex/vendorCodex',
    })).toEqual({
      id: 'vendorCodex',
      displayName: 'vendorCodex',
      executable: '/opt/Vendor Codex/vendorCodex',
      source: 'legacy-path',
      update: { provider: 'auto' },
    });
    expect(resolveCliRuntime({
      cliId: 'codex',
      cliPathOverride: String.raw`C:\Program Files\Vendor Codex\vendorCodex.exe`,
    })).toMatchObject({ id: 'vendorCodex.exe', displayName: 'vendorCodex.exe' });
    // cliPathOverride is a legacy compatibility surface: unlike the new
    // structured executable field, existing relative launchers remain valid.
    expect(resolveCliRuntime({ cliId: 'codex', cliPathOverride: './vendorCodex' }))
      .toMatchObject({ id: 'vendorCodex', executable: './vendorCodex', source: 'legacy-path' });
  });

  it('supports legacy path snapshots for other adapters but no plain snapshot', () => {
    expect(resolveCliRuntime({ cliId: 'claude-code' })).toBeUndefined();
    expect(resolveCliRuntime({ cliId: 'claude-code', cliPathOverride: '/opt/gateway/claude-w' }))
      .toMatchObject({ id: 'claude-w', source: 'legacy-path' });
  });

  it('rejects structured runtimes for non-Codex adapters and unequal legacy shadows', () => {
    const cliRuntime = { id: 'vendor', executable: 'vendorCodex' };
    expect(() => resolveCliRuntime({ cliId: 'claude-code', cliRuntime }))
      .toThrow(/only for cliId "codex"/);
    expect(resolveCliRuntime({ cliId: 'codex', cliRuntime, cliPathOverride: 'vendorCodex' }))
      .toMatchObject({ id: 'vendor', executable: 'vendorCodex', source: 'configured' });
    expect(() => resolveCliRuntime({ cliId: 'codex', cliRuntime, cliPathOverride: 'otherCodex' }))
      .toThrow(/must exactly match/);
  });
});

describe('runtime snapshots and identity', () => {
  it('returns a detached snapshot copy', () => {
    const runtime: CliRuntimeSnapshot = {
      id: 'vendor',
      displayName: 'Vendor Codex',
      executable: '/opt/vendor-a',
      source: 'configured',
      update: { provider: 'npm', packageName: '@vendor/codex' },
    };
    const snapshot = snapshotCliRuntime(runtime)!;
    expect(snapshot).toEqual(runtime);
    expect(snapshot).not.toBe(runtime);
    expect(snapshot.update).not.toBe(runtime.update);
    expect(snapshotCliRuntime(undefined)).toBeUndefined();
  });

  it('compares cliId, runtime source/id, and normalized wrapper', () => {
    const leftRuntime: CliRuntimeSnapshot = {
      id: 'vendor', displayName: 'Vendor A', executable: '/opt/a', source: 'configured',
      update: { provider: 'self' },
    };
    const rightRuntime: CliRuntimeSnapshot = {
      id: 'vendor', displayName: 'Renamed Vendor', executable: '/opt/b', source: 'configured',
      update: { provider: 'none' },
    };
    const left = { cliId: 'codex', cliRuntime: leftRuntime, wrapperCli: '  aiden x codex  ' };
    const right = { cliId: 'codex', cliRuntime: rightRuntime, wrapperCli: 'aiden x codex' };
    expect(sameRuntimeIdentity(left, right)).toBe(true);
    expect(runtimeIdentityKey(left)).toBe(runtimeIdentityKey(right));

    expect(sameRuntimeIdentity(left, { ...right, cliId: 'claude-code' })).toBe(false);
    expect(sameRuntimeIdentity(left, {
      ...right,
      cliRuntime: { ...rightRuntime, id: 'official-codex' },
    })).toBe(false);
    expect(sameRuntimeIdentity(left, { ...right, wrapperCli: undefined })).toBe(false);
  });

  it('backfills source-aware identity for official Codex and legacy frozen paths', () => {
    expect(sameRuntimeIdentity(
      { cliId: 'codex' },
      { cliId: 'codex', cliRuntime: { id: 'codex' } },
    )).toBe(true);
    expect(sameRuntimeIdentity(
      { cliId: 'codex', cliPathOverride: '/old/install/vendorCodex' },
      { cliId: 'codex', cliRuntime: { id: 'vendorCodex' } },
    )).toBe(false);
    expect(sameRuntimeIdentity(
      { cliId: 'codex', cliPathOverride: '/old/install/vendorCodex' },
      { cliId: 'codex', cliRuntime: { id: 'vendorCodex', source: 'legacy-path' } },
    )).toBe(true);
    expect(sameRuntimeIdentity(
      { cliId: 'codex', cliPathOverride: '/old/install/codex' },
      { cliId: 'codex' },
    )).toBe(false);
  });

  it('separates version caches for two installations of the same runtime id', () => {
    const base = {
      cliId: 'codex',
      cliRuntime: { id: 'vendor-codex', executable: '/opt/vendor-a/codex' },
    };
    expect(runtimeInstallationKey(base)).not.toBe(runtimeInstallationKey({
      ...base,
      cliRuntime: { ...base.cliRuntime, executable: '/opt/vendor-b/codex' },
    }));
    expect(runtimeInstallationKey(base)).toBe(runtimeInstallationKey({
      ...base,
      cliPathOverride: '/ignored/shadow',
    }));
    expect(runtimeInstallationKey({ cliId: 'codex' })).toBe(runtimeInstallationKey({
      cliId: 'codex',
      cliRuntime: {
        id: 'codex', displayName: 'Codex', executable: 'codex', source: 'official',
        update: { provider: 'internal' },
      },
    }));
    expect(runtimeInstallationKey({ cliId: 'codex', cliPathOverride: 'codex' }))
      .not.toBe(runtimeInstallationKey({ cliId: 'codex' }));
  });
});
