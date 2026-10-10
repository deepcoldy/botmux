import { describe, expect, it } from 'vitest';
import { parseBotConfigsFromText } from '../src/bot-registry.js';
import { normalizeRemoteRunnerConfig } from '../src/adapters/backend/remote-runner-config.js';
import { createCliAdapterSync, rawCliExecutable } from '../src/adapters/cli/registry.js';
import { isRemoteBackendType, resolvePairedSpawnBackendType } from '../src/core/persistent-backend.js';

describe('remote runner config surface', () => {
  it('normalizes protocol expectations without accepting provider-specific data', () => {
    expect(normalizeRemoteRunnerConfig({
      expectedProvider: 'example-provider',
      requiredCapabilities: ['start', 'resume', 'turn', 'cancel', 'reattach'],
      handshakeTimeoutMs: 2_000,
      operationTimeoutMs: 5_000,
    })).toEqual({
      expectedProvider: 'example-provider',
      requiredCapabilities: ['start', 'resume', 'turn', 'cancel', 'reattach'],
      handshakeTimeoutMs: 2_000,
      operationTimeoutMs: 5_000,
    });
    expect(() => normalizeRemoteRunnerConfig({ endpoint: 'internal.example' }))
      .toThrow(/unsupported field/);
    expect(() => normalizeRemoteRunnerConfig({ requiredCapabilities: ['vendor-extension'] }))
      .toThrow(/unsupported capability/);
  });

  it('loads remote-runner without embedding credentials or provider endpoints', () => {
    const [config] = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'cli_remote_runner',
      larkAppSecret: 'secret',
      cliId: 'remote-runner',
      backendType: 'remote-runner',
      cliPathOverride: '/opt/example/bin/provider',
      remoteRunner: {
        expectedProvider: 'example-provider',
        requiredCapabilities: ['start', 'resume', 'turn', 'cancel', 'detach', 'status'],
      },
    }]));
    expect(config.cliId).toBe('remote-runner');
    expect(config.backendType).toBe('remote-runner');
    expect(config.remoteRunner).toMatchObject({ expectedProvider: 'example-provider' });
    expect(config.remoteRunner).not.toHaveProperty('env');
  });

  it('registers the CLI/backend pair and keeps the provider binary overridable', () => {
    expect(isRemoteBackendType('remote-runner')).toBe(true);
    expect(resolvePairedSpawnBackendType('remote-runner', undefined, undefined, 'tmux'))
      .toBe('remote-runner');
    expect(rawCliExecutable('remote-runner')).toBe('botmux-remote-runner');
    expect(createCliAdapterSync('remote-runner', '/opt/example/provider').resolvedBin)
      .toBe('/opt/example/provider');
  });
});
