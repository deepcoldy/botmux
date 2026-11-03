import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  MIX_ACTOR_WRITE_ROLLOUT_ENV,
  MIX_BROKER_APP_KEY_ENV,
  MIX_BROKER_SECRET_FD,
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

  it('keeps the rollout default off and provisions a pipe only for an explicit enabled MIX plugin', () => {
    const base = { [MIX_BROKER_APP_KEY_ENV]: 'secret' };
    expect(prepareMixBrokerWorkerChannel(['mix'], base, true)).toEqual({
      stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'ignore'],
    });
    expect(prepareMixBrokerWorkerChannel(['other'], {
      ...base,
      [MIX_ACTOR_WRITE_ROLLOUT_ENV]: '1',
    }, true)).toEqual({ stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'ignore'] });
    expect(prepareMixBrokerWorkerChannel(['mix'], {
      ...base,
      [MIX_ACTOR_WRITE_ROLLOUT_ENV]: 'true',
    }, true)).toEqual({ stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'ignore'] });
    expect(prepareMixBrokerWorkerChannel(['mix'], {
      ...base,
      [MIX_ACTOR_WRITE_ROLLOUT_ENV]: '1',
    }, false)).toEqual({ stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'ignore'] });

    const enabled = prepareMixBrokerWorkerChannel(['mix'], {
      ...base,
      [MIX_ACTOR_WRITE_ROLLOUT_ENV]: '1',
    }, true);
    expect(enabled.stdio).toEqual(['ignore', 'pipe', 'pipe', 'ipc', 'pipe']);
    expect(enabled.secret).toBe('secret');
  });

  it('answers broker requests on the daemon-owned pipe without closing the channel', () => {
    class SecretPipe extends EventEmitter {
      readonly responses: string[] = [];
      destroyed = false;
      write(value: string) { this.responses.push(value); return true; }
    }
    const pipe = new SecretPipe();
    const child = { stdio: [null, null, null, null, pipe] } as any;
    serveMixBrokerSecret(child, '  app-key  ');
    pipe.emit('data', Buffer.from('KEY\n'));
    expect(pipe.responses).toEqual(['7\napp-key']);
    expect(pipe.listenerCount('data')).toBe(1);
  });
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

  it('requires the rollout pipe and every containment property', () => {
    const base = {
      platform: 'linux',
      mixPluginEnabled: true,
      inheritedSecretFd: MIX_BROKER_SECRET_FD,
      sandboxEngaged: true,
      mcpSocketMounted: true,
      pidNamespaceRetained: true,
      networkPolicy: contained,
    } as const;
    expect(actorWriteCapabilityEnabled(base)).toBe(true);
    expect(actorWriteCapabilityEnabled({ ...base, inheritedSecretFd: undefined })).toBe(false);
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
