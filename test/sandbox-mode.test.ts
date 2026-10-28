import { describe, expect, it } from 'vitest';
import {
  envSandboxMode,
  normalizeSandboxMode,
  normalizeScratchStorage,
  resolveSandboxMode,
  resolveSpawnNetworkShape,
  sandboxBoolValue,
  sandboxIsActive,
} from '../src/adapters/cli/sandbox-mode.js';

describe('normalizeSandboxMode', () => {
  it('maps legacy boolean/absent values', () => {
    expect(normalizeSandboxMode(undefined)).toBe('off');
    expect(normalizeSandboxMode(null)).toBe('off');
    expect(normalizeSandboxMode(false)).toBe('off');
    expect(normalizeSandboxMode(true)).toBe('oncall');
  });

  it('accepts the three explicit strings', () => {
    expect(normalizeSandboxMode('off')).toBe('off');
    expect(normalizeSandboxMode('oncall')).toBe('oncall');
    expect(normalizeSandboxMode('scratch')).toBe('scratch');
  });

  it('fails closed on garbage instead of silently running unsandboxed', () => {
    expect(() => normalizeSandboxMode('Oncall')).toThrow(/invalid sandbox mode/);
    expect(() => normalizeSandboxMode('scratch ')).toThrow(/invalid sandbox mode/);
    expect(() => normalizeSandboxMode(1)).toThrow(/invalid sandbox mode/);
    expect(() => normalizeSandboxMode({})).toThrow(/invalid sandbox mode/);
  });

  it('exposes active/boolean predicates', () => {
    expect(sandboxIsActive('off')).toBe(false);
    expect(sandboxIsActive('oncall')).toBe(true);
    expect(sandboxIsActive('scratch')).toBe(true);
    expect(sandboxBoolValue(true)).toBe(true);
    expect(sandboxBoolValue('scratch')).toBe(true);
    expect(sandboxBoolValue(false)).toBe(false);
    expect(sandboxBoolValue(undefined)).toBe(false);
  });
});

describe('envSandboxMode (BOTMUX_SANDBOX)', () => {
  it('keeps the legacy 1=oncall meaning and adds scratch', () => {
    expect(envSandboxMode(undefined)).toBe('off');
    expect(envSandboxMode('')).toBe('off');
    expect(envSandboxMode('0')).toBe('off');
    expect(envSandboxMode('false')).toBe('off');
    expect(envSandboxMode('1')).toBe('oncall');
    expect(envSandboxMode('oncall')).toBe('oncall');
    expect(envSandboxMode('scratch')).toBe('scratch');
  });

  it('throws on unknown values (never silently off)', () => {
    expect(() => envSandboxMode('2')).toThrow(/invalid BOTMUX_SANDBOX/);
    expect(() => envSandboxMode('yes')).toThrow(/invalid BOTMUX_SANDBOX/);
  });
});

describe('resolveSandboxMode', () => {
  it('env override wins', () => {
    expect(resolveSandboxMode({ configSandbox: 'oncall', envValue: 'scratch' })).toBe('scratch');
    expect(resolveSandboxMode({ configSandbox: 'scratch', envValue: '0' })).toBe('off');
  });

  it('legacy readIsolation implies oncall', () => {
    expect(resolveSandboxMode({ configSandbox: false, readIsolation: true })).toBe('oncall');
  });

  it('falls back to the normalized config value', () => {
    expect(resolveSandboxMode({ configSandbox: 'scratch' })).toBe('scratch');
    expect(resolveSandboxMode({ configSandbox: true })).toBe('oncall');
    expect(resolveSandboxMode({})).toBe('off');
  });

  it('an invalid config value fails closed', () => {
    expect(() => resolveSandboxMode({ configSandbox: 'nope' })).toThrow(/invalid sandbox mode/);
  });
});

describe('normalizeScratchStorage', () => {
  it('defaults to tmpfs', () => {
    expect(normalizeScratchStorage(undefined)).toBe('tmpfs');
    expect(normalizeScratchStorage(null)).toBe('tmpfs');
  });

  it('accepts the two values, rejects garbage', () => {
    expect(normalizeScratchStorage('disk')).toBe('disk');
    expect(normalizeScratchStorage('tmpfs')).toBe('tmpfs');
    expect(() => normalizeScratchStorage('ram')).toThrow(/invalid scratchStorage/);
  });
});

describe('resolveSpawnNetworkShape (identity-model single source)', () => {
  it('reports no sandbox and shared loopback for off', () => {
    expect(resolveSpawnNetworkShape({ mode: 'off', sandboxNetwork: false })).toEqual({
      sandboxEngaged: false, netEnabled: false, loopbackShared: true,
    });
    // Frozen network inputs must not matter when no sandbox engages.
    expect(resolveSpawnNetworkShape({ mode: 'off' })).toEqual({
      sandboxEngaged: false, netEnabled: false, loopbackShared: true,
    });
  });

  it('oncall without policy follows the frozen network switch', () => {
    expect(resolveSpawnNetworkShape({ mode: 'oncall', sandboxNetwork: true })).toEqual({
      sandboxEngaged: true, netEnabled: true, loopbackShared: true,
    });
    expect(resolveSpawnNetworkShape({ mode: 'oncall', sandboxNetwork: false })).toEqual({
      sandboxEngaged: true, netEnabled: false, loopbackShared: false,
    });
    expect(resolveSpawnNetworkShape({ mode: 'oncall' })).toEqual({
      sandboxEngaged: true, netEnabled: true, loopbackShared: true,
    });
  });

  it('oncall with a slirp policy keeps networking on but cuts host loopback', () => {
    expect(resolveSpawnNetworkShape({
      mode: 'oncall', sandboxNetwork: true, sandboxNetworkPolicy: { mode: 'slirp' },
    })).toEqual({ sandboxEngaged: true, netEnabled: true, loopbackShared: false });
  });

  it('scratch follows the frozen network switch and ignores policy-shaped input', () => {
    // networkPolicySupportError rejects policy outside oncall before spawn;
    // the shape helper itself stays a pure table (scratch + policy is
    // unreachable, not silently mis-shaped here).
    expect(resolveSpawnNetworkShape({ mode: 'scratch', sandboxNetwork: false })).toEqual({
      sandboxEngaged: true, netEnabled: false, loopbackShared: false,
    });
    expect(resolveSpawnNetworkShape({ mode: 'scratch', sandboxNetwork: true })).toEqual({
      sandboxEngaged: true, netEnabled: true, loopbackShared: true,
    });
  });
});
