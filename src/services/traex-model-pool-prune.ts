import {
  normalizeTraexAutoModelConfig,
  traexAutoModelPolicyKey,
  type TraexAutoModelConfig,
} from './traex-auto-model.js';
import { rmwBotEntry } from './config-store.js';
import { createHash } from 'node:crypto';
import { botEnvLayer } from '../core/session-env.js';
import { normalizeEnvPolicy } from '../core/env-policy.js';

export function traexCatalogConfigKey(entry: Record<string, any>): string {
  const layer = botEnvLayer(entry);
  return createHash('sha256').update(JSON.stringify([
    entry.cliId, entry.cliPathOverride, entry.cliConfigDir, entry.credentialsSourceDir,
    Object.entries(layer.set).sort(([a], [b]) => a.localeCompare(b)), [...layer.unset].sort(),
    normalizeEnvPolicy(entry.envPolicy), entry.wrapperCli, entry.cliLaunchMode, entry.backendType,
  ])).digest('hex');
}

export type TraexModelPoolPruneResult = {
  status: 'applied' | 'unchanged' | 'superseded' | 'failed' | 'timed_out';
  removedModels: string[];
  config?: TraexAutoModelConfig;
};

export function prunedTraexModelPool(
  config: TraexAutoModelConfig, availableModels: ReadonlySet<string>,
): { removedModels: string[]; config: TraexAutoModelConfig } {
  const available = new Set([...availableModels].map(model => model.trim().toLowerCase()));
  if (!available.size) return { removedModels: [], config };
  const removedModels = config.models.filter(model => !available.has(model.toLowerCase()));
  const models = config.models.filter(model => available.has(model.toLowerCase()));
  const removed = new Set(removedModels.map(model => model.toLowerCase()));
  const modelSettings = config.modelSettings && Object.fromEntries(
    Object.entries(config.modelSettings).filter(([model]) => !removed.has(model.toLowerCase())),
  );
  return {
    removedModels,
    config: {
      ...config, models,
      ...(modelSettings ? { modelSettings } : {}),
      ...(models.length === 0 ? { catalogUnavailable: true as const } : {}),
    },
  };
}

/** Notify outside the file lock, then CAS under the existing durable config
 * coordinator. A manual edit while notification is in flight wins. */
export async function pruneSavedTraexModelPool(input: {
  larkAppId: string;
  expectedPolicyKey: string;
  expectedContextKey?: string;
  availableModels: readonly string[];
  isCurrent: () => boolean;
  notify: (removedModels: string[]) => Promise<void>;
  /** Runs after the durable write while the same file lock is still held. */
  onCommitted?: (config: TraexAutoModelConfig) => void | Promise<void>;
  path?: string;
}): Promise<TraexModelPoolPruneResult> {
  const available = new Set(input.availableModels.map(model => model.trim().toLowerCase()));
  if (!available.size || available.size > 3000
    || [...available].some(model => !model || model.length > 256)) {
    return { status: 'failed', removedModels: [] };
  }
  const plan = (entry: any): TraexModelPoolPruneResult => {
    const current = normalizeTraexAutoModelConfig(entry.traexAutoModel).config;
    if (!input.isCurrent() || entry.cliId !== 'traex' || entry.model !== 'auto'
      || entry.wrapperCli || entry.cliLaunchMode || entry.existingAppServerEndpoint
      || !current) {
      return { status: 'superseded', removedModels: [] };
    }
    if (input.expectedContextKey && traexCatalogConfigKey(entry) !== input.expectedContextKey) {
      return { status: 'superseded', removedModels: [] };
    }
    if (traexAutoModelPolicyKey(current) !== input.expectedPolicyKey) {
      return { status: 'superseded', removedModels: [], config: current };
    }
    const next = prunedTraexModelPool(current, available);
    return { status: next.removedModels.length ? 'applied' : 'unchanged', ...next };
  };
  const options = input.path ? { path: input.path } : {};
  const preview = await rmwBotEntry<TraexModelPoolPruneResult>(
    input.larkAppId, entry => ({ write: false, result: plan(entry) }), options,
  );
  if (!preview.ok) return { status: 'failed', removedModels: [] };
  if (preview.result.status !== 'applied') return preview.result;
  await input.notify(preview.result.removedModels);
  let committedConfig: TraexAutoModelConfig | undefined;
  const committed = await rmwBotEntry<TraexModelPoolPruneResult>(input.larkAppId, entry => {
    const next = plan(entry);
    if (next.status === 'applied') {
      entry.traexAutoModel = next.config;
      committedConfig = next.config;
    }
    return { write: next.status === 'applied', result: next };
  }, {
    ...options,
    onCommitted: async () => {
      if (committedConfig) await input.onCommitted?.(committedConfig);
    },
  });
  return committed.ok ? committed.result : { status: 'failed', removedModels: [] };
}
