import { describe, expect, it } from 'vitest';

import {
  buildForgeTraexLaunch,
  decorateResumeForCliLaunchMode,
  normalizeCliLaunchMode,
  validateCliLaunchModeConfig,
} from '../src/core/cli-launch-mode.js';

describe('Forge x TraeX launch helpers', () => {
  it('turns TraeX argv into Forge --agent-args with POSIX quoting', () => {
    const launch = buildForgeTraexLaunch([
      '--no-alt-screen',
      '--model',
      "o'clock model",
      '-C',
      '/repo path',
    ], (bin) => `/opt/bin/${bin}`);

    expect(launch.bin).toBe('/opt/bin/forge');
    expect(launch.args).toEqual([
      'run',
      '--agent',
      'traex',
      '--agent-args',
      "'--no-alt-screen' '--model' 'o'\\''clock model' '-C' '/repo path'",
    ]);
  });

  it('decorates adapter resume commands as a Forge TraeX resume', () => {
    expect(decorateResumeForCliLaunchMode('traex resume abc-123', 'forge-traex'))
      .toBe("forge run --agent traex --agent-args 'resume abc-123'");
    expect(decorateResumeForCliLaunchMode('traex resume abc-123', undefined))
      .toBe('traex resume abc-123');
  });

  it('preserves backslash-escaped TOML strings through Forge agent-args splitting', () => {
    const launch = buildForgeTraexLaunch([
      '-c',
      'hooks.PreToolUse=[{matcher="spawn_agent",hooks=[{type="command",command="\\"/path/hook\\""}]}]',
    ]);

    expect(launch.args).toEqual([
      'run',
      '--agent',
      'traex',
      '--agent-args',
      '\'-c\' \'hooks.PreToolUse=[{matcher="spawn_agent",hooks=[{type="command",command="\\\\"/path/hook\\\\""}]}]\'',
    ]);
  });

  it('normalizes and fail-closes unsupported launch-mode combinations', () => {
    expect(normalizeCliLaunchMode('forge-traex')).toBe('forge-traex');
    expect(normalizeCliLaunchMode('')).toBeUndefined();
    expect(() => normalizeCliLaunchMode('forge')).toThrow(/must be "forge-traex"/);

    expect(() => validateCliLaunchModeConfig({
      cliId: 'traex',
      cliLaunchMode: 'forge-traex',
    })).not.toThrow();
    expect(() => validateCliLaunchModeConfig({
      cliId: 'codex',
      cliLaunchMode: 'forge-traex',
    })).toThrow(/supported only for cliId "traex"/);
    expect(() => validateCliLaunchModeConfig({
      cliId: 'traex',
      cliLaunchMode: 'forge-traex',
      wrapperCli: 'aiden x traex',
    })).toThrow(/cannot be combined with wrapperCli/);
    expect(() => validateCliLaunchModeConfig({
      cliId: 'traex',
      cliLaunchMode: 'forge-traex',
      sandbox: true,
    })).toThrow(/sandbox or readIsolation/);
  });
});
