import type { ChildProcess, StdioOptions } from 'node:child_process';
import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import {
  privateBrokerContainmentEnabled,
  type SandboxNetworkPolicy,
} from './sandbox-network-policy.js';

export const MIX_BROKER_APP_KEY_ENV = 'BYTEDCLI_AI_AUTH_APP_KEY';
export const MIX_ACTOR_WRITE_ROLLOUT_ENV = 'BOTMUX_MIX_ACTOR_WRITE_ENABLED';
export const MIX_BROKER_SECRET_FD_ENV = 'BOTMUX_MIX_BROKER_SECRET_FD';
export const MIX_BROKER_SECRET_CHANNEL_ENV = 'BOTMUX_MIX_BROKER_SECRET_CHANNEL';
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
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
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
  child: Pick<ChildProcess, 'connected' | 'on' | 'off' | 'send'>,
  secret: string | undefined,
): void {
  if (!secret) return;
  const appKey = secret.trim();
  const active = new Set<Socket>();
  let reservedChannels = 0;
  const onMessage = (raw: unknown) => {
    const message = raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
    if (message?.type !== 'mix_broker_secret_channel_request'
      || typeof message.requestId !== 'string') return;
    const requestId = message.requestId;
    if (reservedChannels >= 128) {
      if (child.connected) child.send({
        type: 'mix_broker_secret_channel_result',
        requestId,
        ok: false,
        error: 'mix_broker_secret_channel_limit',
      });
      return;
    }
    reservedChannels += 1;
    void createMixBrokerSecretSocketPair().then(({ daemonSocket, workerSocket }) => {
      if (!child.connected) {
        reservedChannels -= 1;
        daemonSocket.destroy();
        workerSocket.destroy();
        return;
      }
      active.add(daemonSocket);
      daemonSocket.once('close', () => {
        if (active.delete(daemonSocket)) reservedChannels -= 1;
      });
      serveOneShotMixBrokerSecret(daemonSocket, appKey);
      child.send({
        type: 'mix_broker_secret_channel_result',
        requestId,
        ok: true,
      }, workerSocket, error => {
        workerSocket.destroy();
        if (error) daemonSocket.destroy();
      });
    }).catch(() => {
      reservedChannels -= 1;
      if (child.connected) child.send({
        type: 'mix_broker_secret_channel_result',
        requestId,
        ok: false,
        error: 'mix_broker_secret_channel_unavailable',
      });
    });
  };
  const cleanup = () => {
    child.off('message', onMessage);
    for (const socket of active) socket.destroy();
    active.clear();
  };
  child.on('message', onMessage);
  child.on('exit', cleanup);
}

async function createMixBrokerSecretSocketPair(): Promise<{
  daemonSocket: Socket;
  workerSocket: Socket;
}> {
  const server = createServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('MIX broker channel address unavailable');
    const accepted = once(server, 'connection') as Promise<[Socket]>;
    const workerSocket = createConnection({ host: '127.0.0.1', port: address.port });
    await once(workerSocket, 'connect');
    const [daemonSocket] = await accepted;
    daemonSocket.setNoDelay(true);
    workerSocket.setNoDelay(true);
    return { daemonSocket, workerSocket };
  } finally {
    if (server.listening) server.close();
  }
}

function serveOneShotMixBrokerSecret(socket: Socket, secret: string): void {
  const response = Buffer.from(`${Buffer.byteLength(secret)}\n${secret}`, 'utf8');
  let request = '';
  let settled = false;
  const clear = () => {
    response.fill(0);
    request = '';
  };
  const fail = () => {
    if (settled) return;
    settled = true;
    clear();
    socket.destroy();
  };
  const timeout = setTimeout(fail, 10_000);
  timeout.unref();
  socket.on('error', fail);
  socket.on('close', () => {
    clearTimeout(timeout);
    clear();
  });
  socket.on('data', chunk => {
    if (settled) return;
    request += String(chunk);
    if (request.length > 16) {
      fail();
      return;
    }
    const newline = request.indexOf('\n');
    if (newline < 0) return;
    if (request.slice(0, newline) !== 'KEY' || request.slice(newline + 1).length > 0) {
      fail();
      return;
    }
    settled = true;
    clearTimeout(timeout);
    socket.end(response, clear);
  });
}

export function mixBrokerSecretChannelEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[MIX_BROKER_SECRET_CHANNEL_ENV] === 'ipc';
}

export function actorWriteCapabilityEnabled(input: {
  platform: string;
  mixPluginEnabled: boolean;
  secretChannelEnabled: boolean;
  sandboxEngaged: boolean;
  mcpSocketMounted: boolean;
  pidNamespaceRetained: boolean;
  networkPolicy: SandboxNetworkPolicy | undefined;
}): boolean {
  return input.platform === 'linux'
    && input.mixPluginEnabled
    && input.secretChannelEnabled
    && input.sandboxEngaged
    && input.mcpSocketMounted
    && input.pidNamespaceRetained
    && privateBrokerContainmentEnabled(input.networkPolicy);
}
