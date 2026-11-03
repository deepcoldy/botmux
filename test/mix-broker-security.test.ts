import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIX_ACTOR_WRITE_ROLLOUT_ENV,
  MIX_BROKER_APP_KEY_ENV,
  actorWriteContainmentConfigured,
  actorWriteCapabilityEnabled,
  prepareMixBrokerWorkerChannel,
  serveMixBrokerSecret,
} from '../src/core/mix-broker-security.js';
import { sessionEnvWorkerBase } from '../src/core/worker-pool.js';
import { parseSandboxNetworkPolicy } from '../src/core/sandbox-network-policy.js';

describe('MIX broker host secret channel', () => {
  it('removes the App Key from the generic worker environment', () => {
    const previous = process.env[MIX_BROKER_APP_KEY_ENV];
    process.env[MIX_BROKER_APP_KEY_ENV] = 'worker-must-not-see-this';
    try {
      expect(sessionEnvWorkerBase()[MIX_BROKER_APP_KEY_ENV]).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[MIX_BROKER_APP_KEY_ENV];
      else process.env[MIX_BROKER_APP_KEY_ENV] = previous;
    }
  });

  it('keeps the rollout default off and provisions channels only for an explicit enabled MIX plugin', () => {
    const base = { [MIX_BROKER_APP_KEY_ENV]: 'secret' };
    expect(prepareMixBrokerWorkerChannel(['mix'], base, true)).toEqual({
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    expect(prepareMixBrokerWorkerChannel(['other'], {
      ...base,
      [MIX_ACTOR_WRITE_ROLLOUT_ENV]: '1',
    }, true)).toEqual({ stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    expect(prepareMixBrokerWorkerChannel(['mix'], {
      ...base,
      [MIX_ACTOR_WRITE_ROLLOUT_ENV]: 'true',
    }, true)).toEqual({ stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    expect(prepareMixBrokerWorkerChannel(['mix'], {
      ...base,
      [MIX_ACTOR_WRITE_ROLLOUT_ENV]: '1',
    }, false)).toEqual({ stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });

    const enabled = prepareMixBrokerWorkerChannel(['mix'], {
      ...base,
      [MIX_ACTOR_WRITE_ROLLOUT_ENV]: '1',
    }, true);
    expect(enabled.stdio).toEqual(['ignore', 'pipe', 'pipe', 'ipc']);
    expect(enabled.secret).toBe('secret');
  });

  it('delivers 40 overlapping broker handshakes without partial frames or leaks', async () => {
    const secret = 'forty-way-overlap-secret';
    const worker = spawn(process.env.NODE_BINARY ?? 'node', [
      resolve('test/fixtures/mix-broker-concurrency-worker.mjs'),
      '40',
    ], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'pipe'],
    });
    serveMixBrokerSecret(worker, secret);
    worker.stdout.setEncoding('utf8');
    worker.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    worker.stdout.on('data', chunk => { stdout += chunk; });
    worker.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(worker, 'close');
    expect(code, stderr).toBe(0);
    const results = JSON.parse(stdout) as Array<{
      code: number | null;
      signal: string | null;
      stderr: string;
      result?: { id: string; secret: string; appKeyInEnv: boolean; secretInArgv: boolean };
    }>;
    expect(results).toHaveLength(40);
    expect(results.filter(result => result.code === 0), JSON.stringify(results)).toHaveLength(40);
    expect(results.map(result => result.result?.id).sort((a, b) => Number(a) - Number(b)))
      .toEqual(Array.from({ length: 40 }, (_, index) => String(index)));
    for (const result of results) {
      expect(result.result).toMatchObject({
        secret,
        appKeyInEnv: false,
        secretInArgv: false,
      });
    }
  }, 15_000);

  it('caps overlapping live broker channels at 128', async () => {
    const worker = spawn(process.env.NODE_BINARY ?? 'node', [
      resolve('test/fixtures/mix-broker-channel-limit-worker.mjs'),
      '129',
    ], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    serveMixBrokerSecret(worker, 'channel-limit-secret');
    worker.stdout.setEncoding('utf8');
    worker.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    worker.stdout.on('data', chunk => { stdout += chunk; });
    worker.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(worker, 'close');
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ successes: 128, failures: 1 });
  }, 15_000);
});

describe('MIX actor-write capability', () => {
  const contained = parseSandboxNetworkPolicy({
    version: 1,
    public: { mode: 'allow' },
    private: { mode: 'block' },
    proxyMode: 'reject',
  });

  it('provisions credentials only for a statically full local containment configuration', () => {
    const base = {
      platform: 'linux',
      backendType: 'pty',
      sandboxMode: 'oncall' as const,
      networkPolicy: contained,
      adopt: false,
    };
    expect(actorWriteContainmentConfigured(base)).toBe(true);
    expect(actorWriteContainmentConfigured({ ...base, backendType: 'tmux' })).toBe(false);
    expect(actorWriteContainmentConfigured({ ...base, sandboxMode: 'off' })).toBe(false);
    expect(actorWriteContainmentConfigured({ ...base, networkPolicy: undefined })).toBe(false);
    expect(actorWriteContainmentConfigured({ ...base, adopt: true })).toBe(false);
  });

  it('requires the rollout channel and every containment property', () => {
    const base = {
      platform: 'linux',
      mixPluginEnabled: true,
      secretChannelEnabled: true,
      sandboxEngaged: true,
      mcpSocketMounted: true,
      pidNamespaceRetained: true,
      networkPolicy: contained,
    } as const;
    expect(actorWriteCapabilityEnabled(base)).toBe(true);
    expect(actorWriteCapabilityEnabled({ ...base, secretChannelEnabled: false })).toBe(false);
    expect(actorWriteCapabilityEnabled({ ...base, platform: 'darwin' })).toBe(false);
    expect(actorWriteCapabilityEnabled({ ...base, sandboxEngaged: false })).toBe(false);
    expect(actorWriteCapabilityEnabled({ ...base, mcpSocketMounted: false })).toBe(false);
    expect(actorWriteCapabilityEnabled({ ...base, pidNamespaceRetained: false })).toBe(false);
    expect(actorWriteCapabilityEnabled({ ...base, networkPolicy: undefined })).toBe(false);
    expect(actorWriteCapabilityEnabled({
      ...base,
      networkPolicy: parseSandboxNetworkPolicy({
        version: 1,
        public: { mode: 'allow' },
        private: { mode: 'block' },
        proxyMode: 'trusted-egress',
      }),
    })).toBe(false);
  });
});
