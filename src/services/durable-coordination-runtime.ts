import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { DurableCoordinationStore } from './durable-coordination.js';
import {
  ExternalDurableCoordinationStore,
  type ExternalDurableCoordinationStoreConfig,
} from './external-durable-coordination-store.js';

export type DurableCoordinationMode = 'disabled' | 'shadow' | 'primary';

export interface DurableCoordinationRuntime {
  mode: 'shadow' | 'primary';
  provider: string;
  store: DurableCoordinationStore;
  close(): Promise<void>;
  terminate(): void;
}

function modeFromEnv(env: NodeJS.ProcessEnv): DurableCoordinationMode {
  const raw = env.BOTMUX_COORDINATION_MODE?.trim();
  const mode = raw || 'disabled';
  if (mode !== 'disabled' && mode !== 'shadow' && mode !== 'primary') {
    throw new Error('BOTMUX_COORDINATION_MODE must be disabled, shadow, or primary');
  }
  return mode;
}

function optionalTimeout(value: string | undefined, name: string): number | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 300_000) {
    throw new Error(`${name} must be an integer between 100 and 300000`);
  }
  return parsed;
}

function providerArgs(value: string | undefined): string[] {
  if (value === undefined || !value.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('BOTMUX_COORDINATION_PROVIDER_ARGS_JSON must be a JSON array');
  }
  if (!Array.isArray(parsed)
      || parsed.length > 64
      || parsed.some(item => typeof item !== 'string' || item.length > 4096)) {
    throw new Error('BOTMUX_COORDINATION_PROVIDER_ARGS_JSON must contain at most 64 strings');
  }
  return parsed;
}

function providerConfig(env: NodeJS.ProcessEnv): ExternalDurableCoordinationStoreConfig {
  const command = env.BOTMUX_COORDINATION_PROVIDER_BIN?.trim();
  if (!command || !isAbsolute(command)) {
    throw new Error('BOTMUX_COORDINATION_PROVIDER_BIN must be an absolute executable path');
  }
  try {
    accessSync(command, constants.X_OK);
    if (!statSync(command).isFile()) throw new Error('not a file');
  } catch {
    throw new Error('BOTMUX_COORDINATION_PROVIDER_BIN must be an executable regular file');
  }
  return {
    command,
    args: providerArgs(env.BOTMUX_COORDINATION_PROVIDER_ARGS_JSON),
    env,
    ...(optionalTimeout(env.BOTMUX_COORDINATION_PROVIDER_HANDSHAKE_TIMEOUT_MS, 'BOTMUX_COORDINATION_PROVIDER_HANDSHAKE_TIMEOUT_MS') !== undefined
      ? { handshakeTimeoutMs: optionalTimeout(env.BOTMUX_COORDINATION_PROVIDER_HANDSHAKE_TIMEOUT_MS, 'BOTMUX_COORDINATION_PROVIDER_HANDSHAKE_TIMEOUT_MS') }
      : {}),
    ...(optionalTimeout(env.BOTMUX_COORDINATION_PROVIDER_REQUEST_TIMEOUT_MS, 'BOTMUX_COORDINATION_PROVIDER_REQUEST_TIMEOUT_MS') !== undefined
      ? { requestTimeoutMs: optionalTimeout(env.BOTMUX_COORDINATION_PROVIDER_REQUEST_TIMEOUT_MS, 'BOTMUX_COORDINATION_PROVIDER_REQUEST_TIMEOUT_MS') }
      : {}),
  };
}

export async function initializeDurableCoordinationRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: { allowPrimary?: boolean } = {},
): Promise<DurableCoordinationRuntime | undefined> {
  const mode = modeFromEnv(env);
  if (mode === 'disabled') return undefined;
  if (mode === 'primary' && options.allowPrimary !== true) {
    throw new Error(
      'BOTMUX_COORDINATION_MODE=primary is unavailable until the daemon primary data path is explicitly enabled',
    );
  }
  const store = await ExternalDurableCoordinationStore.connect(providerConfig(env));
  const provider = store.provider;
  if (!provider) {
    store.terminate();
    throw new Error('durable coordination provider did not identify itself');
  }
  return {
    mode,
    provider,
    store,
    close: () => store.close(),
    terminate: () => store.terminate(),
  };
}
