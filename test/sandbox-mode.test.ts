import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  envSandboxMode,
  normalizeSandboxMode,
  normalizeScratchStorage,
  resolveSandboxMode,
  resolveSpawnNetworkShape,
  sandboxBoolValue,
  sandboxIsActive,
  sessionCardSandboxMode,
} from '../src/adapters/cli/sandbox-mode.js';
import { sandboxEnabled } from '../src/adapters/backend/sandbox.js';

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

describe('sandboxEnabled (global BOTMUX_SANDBOX force)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each(['1', 'oncall', 'scratch'])('BOTMUX_SANDBOX=%s forces the sandbox', raw => {
    vi.stubEnv('BOTMUX_SANDBOX', raw);
    expect(sandboxEnabled()).toBe(true);
  });

  it.each([undefined, '', '0', 'false'])('BOTMUX_SANDBOX=%s does not force it', raw => {
    vi.stubEnv('BOTMUX_SANDBOX', raw);
    expect(sandboxEnabled()).toBe(false);
  });

  it('treats an invalid value as forced (the worker refuses to spawn with it)', () => {
    vi.stubEnv('BOTMUX_SANDBOX', 'yes');
    expect(sandboxEnabled()).toBe(true);
  });
});

describe('resolveSandboxMode', () => {
  it('an active env value (1 / oncall / scratch) forces that mode on every bot', () => {
    expect(resolveSandboxMode({ configSandbox: 'oncall', envValue: 'scratch' })).toBe('scratch');
    expect(resolveSandboxMode({ configSandbox: false, envValue: '1' })).toBe('oncall');
    expect(resolveSandboxMode({ configSandbox: 'scratch', envValue: 'oncall' })).toBe('oncall');
  });

  it('an inactive env value (0 / false / empty / unset) never turns off a bot\'s own sandbox', () => {
    for (const envValue of ['0', 'false', '', undefined]) {
      expect(resolveSandboxMode({ configSandbox: true, envValue })).toBe('oncall');
      expect(resolveSandboxMode({ configSandbox: 'oncall', envValue })).toBe('oncall');
      expect(resolveSandboxMode({ configSandbox: 'scratch', envValue })).toBe('scratch');
      expect(resolveSandboxMode({ configSandbox: false, readIsolation: true, envValue })).toBe('oncall');
      expect(resolveSandboxMode({ configSandbox: false, envValue })).toBe('off');
    }
  });

  it('an invalid env value still fails closed even when the bot config is valid', () => {
    expect(() => resolveSandboxMode({ configSandbox: true, envValue: 'no' })).toThrow(/invalid BOTMUX_SANDBOX/);
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

describe('sessionCardSandboxMode (what the session card claims)', () => {
  it('a session frozen off on a BOTMUX_SANDBOX-forced daemon is shown as the forced mode', () => {
    expect(sessionCardSandboxMode(false, undefined, '1')).toBe('oncall');
    expect(sessionCardSandboxMode(undefined, undefined, 'scratch')).toBe('scratch');
    expect(sessionCardSandboxMode(true, undefined, 'scratch')).toBe('scratch');
  });

  it('without a force it shows the frozen decision', () => {
    expect(sessionCardSandboxMode(true, undefined, undefined)).toBe('oncall');
    expect(sessionCardSandboxMode('scratch', undefined, '0')).toBe('scratch');
    expect(sessionCardSandboxMode(false, undefined, undefined)).toBe('off');
  });

  it("the worker's own engaged report wins: a bypassed sandbox is off, an unexplained engaged one is oncall", () => {
    expect(sessionCardSandboxMode(true, false, '1')).toBe('off');
    expect(sessionCardSandboxMode(false, true, undefined)).toBe('oncall');
  });

  it('a typo\'d env value (the worker refuses to start) falls back to the frozen mode instead of throwing', () => {
    expect(sessionCardSandboxMode(false, undefined, 'yes')).toBe('off');
  });
});
