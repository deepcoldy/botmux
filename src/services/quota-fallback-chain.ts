/**
 * Same-bot CLI/model fallback chain for quota and rate limits.
 *
 * Step 0 is the bot's own launch configuration; `steps` continue in order.
 * A session only ever moves forward along the chain. Each CLI occupies one
 * contiguous run of steps, so a session never returns to a CLI whose native
 * conversation it already left.
 */
import type { CliId } from '../adapters/cli/types.js';
import { CLI_DISPLAY_NAMES } from '../adapters/cli/display-names.js';
import { retiredCli } from '../adapters/cli/retired-cli.js';
import { isRemoteCliId } from '../core/remote-cli-ids.js';
import { RPC_CAPABLE_CLIS } from './codex-rpc-input-policy.js';
import { normalizeQuotaFallbackKinds, type QuotaFallbackKind } from './quota-fallback.js';
import { DEFAULT_MODEL_VALUE_PATTERN } from '../core/model-value-pattern.js';
import { t, type Locale } from '../i18n/index.js';

export interface QuotaFallbackChainStep {
  cliId: CliId;
  /** Missing means the CLI's own default model. */
  model?: string;
}

export interface QuotaFallbackChainConfig {
  enabled: true;
  kinds: QuotaFallbackKind[];
  steps: QuotaFallbackChainStep[];
}

/** Where a session currently sits on its bot's chain (1-based step index). */
export interface QuotaFallbackSessionState {
  step: number;
  cliId: CliId;
  model?: string;
}

export interface QuotaFallbackChainBot {
  cliId: CliId;
  model?: string;
  backendType?: string;
  codexRpcInput?: boolean;
}

export type QuotaFallbackChainNormalization =
  | { config: QuotaFallbackChainConfig; error?: undefined }
  | { config?: undefined; error?: string };

function knownCliId(value: unknown): CliId | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return Object.hasOwn(CLI_DISPLAY_NAMES, id) && !retiredCli(id) ? id as CliId : undefined;
}

/**
 * Normalize the optional bots.json block. An invalid enabled block is disabled
 * as one unit and reported, never applied partially.
 */
export function normalizeQuotaFallbackChainConfig(
  raw: unknown,
  bot: QuotaFallbackChainBot,
): QuotaFallbackChainNormalization {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'quotaFallbackChain must be an object' };
  }
  const value = raw as Record<string, unknown>;
  if (value.enabled !== true) return {};

  if (isRemoteCliId(bot.cliId) || (bot.backendType !== undefined && isRemoteCliId(bot.backendType))) {
    return { error: 'quotaFallbackChain is not supported for remote backends' };
  }
  const normalizedKinds = normalizeQuotaFallbackKinds(value.kinds, 'quotaFallbackChain');
  if ('error' in normalizedKinds) return { error: normalizedKinds.error };

  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    return { error: 'quotaFallbackChain.steps must contain at least one step' };
  }

  const steps: QuotaFallbackChainStep[] = [];
  let previous: { cliId: CliId; model?: string } = { cliId: bot.cliId, model: bot.model?.trim() || undefined };
  const leftClis = new Set<CliId>();
  for (const [index, rawStep] of value.steps.entries()) {
    const label = `quotaFallbackChain.steps[${index}]`;
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
      return { error: `${label} must be an object` };
    }
    const entry = rawStep as Record<string, unknown>;
    const cliId = knownCliId(entry.cliId);
    if (!cliId) return { error: `${label}.cliId must be a supported CLI id` };
    if (isRemoteCliId(cliId)) return { error: `${label}.cliId must run locally` };
    if (cliId !== bot.cliId && bot.codexRpcInput === true && !RPC_CAPABLE_CLIS.has(cliId)) {
      return { error: `${label}.cliId cannot use the bot's codexRpcInput` };
    }
    if (entry.model !== undefined && entry.model !== null && typeof entry.model !== 'string') {
      return { error: `${label}.model must be a string` };
    }
    const model = typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : undefined;
    if (model !== undefined && (!DEFAULT_MODEL_VALUE_PATTERN.test(model) || model.toLowerCase() === 'auto')) {
      return { error: `${label}.model must be a concrete model id` };
    }
    if (cliId !== previous.cliId) {
      leftClis.add(previous.cliId);
      if (leftClis.has(cliId)) {
        return { error: `${label} returns to ${cliId} after the chain already left it` };
      }
    } else if (!model) {
      // A resumed conversation without a launch model keeps the model that just hit its limit.
      return { error: `${label}.model is required when the step stays on ${cliId}` };
    } else if (model === previous.model) {
      return { error: `${label} repeats the previous CLI and model` };
    }
    steps.push(model ? { cliId, model } : { cliId });
    previous = { cliId, model };
  }
  return { config: { enabled: true, kinds: normalizedKinds.kinds, steps } };
}

/** The step a session moves to after a limit of `kind`, if the chain has one. */
export function nextQuotaFallbackStep(
  config: QuotaFallbackChainConfig | undefined,
  state: QuotaFallbackSessionState | undefined,
  kind: QuotaFallbackKind,
): { state: QuotaFallbackSessionState; step: QuotaFallbackChainStep } | undefined {
  if (!config?.enabled || !config.kinds.includes(kind)) return undefined;
  const index = state?.step ?? 0;
  const step = config.steps[index];
  if (!step) return undefined;
  return {
    step,
    state: { step: index + 1, cliId: step.cliId, ...(step.model ? { model: step.model } : {}) },
  };
}

export function quotaFallbackAgentLabel(cliId: CliId, model?: string): string {
  const name = CLI_DISPLAY_NAMES[cliId] ?? cliId;
  return model ? `${name} · ${model}` : name;
}

/**
 * First input for the next agent. A fresh CLI is told to read the previous
 * agent's session file, the topic history and the workspace before continuing;
 * a same-CLI model switch resumes the native conversation and only needs the
 * continuation.
 */
export function buildQuotaFallbackPrompt(input: {
  freshCli: boolean;
  from: string;
  to: string;
  userPrompt: string;
  transcriptPath?: string;
  locale: Locale;
}): string {
  const vars = { from: input.from, to: input.to };
  const head = input.freshCli
    ? [
        t('worker.quota_chain.handoff_prompt', vars, input.locale),
        input.transcriptPath
          ? t('worker.quota_chain.handoff_transcript', { path: input.transcriptPath }, input.locale)
          : t('worker.quota_chain.handoff_no_transcript', {}, input.locale),
        t('worker.quota_chain.handoff_history', {}, input.locale),
        t('worker.quota_chain.handoff_check', {}, input.locale),
      ].join('\n')
    : t('worker.quota_chain.continue_prompt', vars, input.locale);
  return `${head}\n\n${t('worker.quota_chain.request_label', {}, input.locale)}\n${input.userPrompt}`;
}
