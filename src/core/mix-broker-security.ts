import type { ChildProcess, StdioOptions } from 'node:child_process';
import { fstatSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import {
  privateBrokerContainmentEnabled,
  type SandboxNetworkPolicy,
} from './sandbox-network-policy.js';

export const MIX_BROKER_APP_KEY_ENV = 'BYTEDCLI_AI_AUTH_APP_KEY';
export const MIX_ACTOR_WRITE_ROLLOUT_ENV = 'BOTMUX_MIX_ACTOR_WRITE_ENABLED';
export const MIX_BROKER_SECRET_FD_ENV = 'BOTMUX_MIX_BROKER_SECRET_FD';
export const MIX_BROKER_SECRET_FD = 4;
export const MIX_BROKER_CHILD_SECRET_FD = 3;

export interface MixBrokerWorkerChannel {
  stdio: StdioOptions;
  secret?: string;
}

export function prepareMixBrokerWorkerChannel(
  pluginIds: readonly string[] | undefined,
  env: NodeJS.ProcessEnv,
  containmentConfigured: boolean,
): MixBrokerWorkerChannel {
  const enabled = env[MIX_ACTOR_WRITE_ROLLOUT_ENV] === '1';
  const secret = env[MIX_BROKER_APP_KEY_ENV]?.trim();
  const provision = enabled && containmentConfigured && pluginIds?.includes('mix') && !!secret;
  return {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc', provision ? 'pipe' : 'ignore'],
    ...(provision ? { secret } : {}),
  };
}

export function actorWriteContainmentConfigured(input: {
  platform: string;
  backendType: string;
  sandboxMode: 'off' | 'oncall' | 'scratch';
  networkPolicy: SandboxNetworkPolicy | undefined;
  adopt: boolean;
}): boolean {
  return input.platform === 'linux'
    && input.backendType === 'pty'
    && input.sandboxMode === 'oncall'
    && !input.adopt
    && privateBrokerContainmentEnabled(input.networkPolicy);
}

export function serveMixBrokerSecret(
  child: Pick<ChildProcess, 'stdio'>,
  secret: string | undefined,
): void {
  if (!secret) return;
  const stream = child.stdio[MIX_BROKER_SECRET_FD] as Duplex | null | undefined;
  if (!stream || typeof stream.write !== 'function' || typeof stream.on !== 'function') {
    throw new Error('MIX broker secret pipe was not created');
  }
  const appKey = secret.trim();
  let requests = '';
  stream.on('error', () => undefined);
  stream.on('data', chunk => {
    requests += String(chunk);
    while (requests.includes('\n')) {
      const newline = requests.indexOf('\n');
      const request = requests.slice(0, newline);
      requests = requests.slice(newline + 1);
      if (request !== 'KEY') continue;
      stream.write(`${Buffer.byteLength(appKey)}\n${appKey}`);
    }
  });
}

export function inheritedMixBrokerSecretFd(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (env[MIX_BROKER_SECRET_FD_ENV] !== String(MIX_BROKER_SECRET_FD)) return undefined;
  try {
    fstatSync(MIX_BROKER_SECRET_FD);
    return MIX_BROKER_SECRET_FD;
  } catch {
    return undefined;
  }
}

export function actorWriteCapabilityEnabled(input: {
  platform: string;
  mixPluginEnabled: boolean;
  inheritedSecretFd: number | undefined;
  sandboxEngaged: boolean;
  mcpSocketMounted: boolean;
  pidNamespaceRetained: boolean;
  networkPolicy: SandboxNetworkPolicy | undefined;
}): boolean {
  return input.platform === 'linux'
    && input.mixPluginEnabled
    && input.inheritedSecretFd === MIX_BROKER_SECRET_FD
    && input.sandboxEngaged
    && input.mcpSocketMounted
    && input.pidNamespaceRetained
    && privateBrokerContainmentEnabled(input.networkPolicy);
}
