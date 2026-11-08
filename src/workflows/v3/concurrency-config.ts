/**
 * Resolve the v3 runtime's three-layer concurrency caps (global / perBot /
 * perCli) for one drive.
 *
 * Precedence, per field: an explicit override (CLI flag, daemon dep) > the
 * host's `workflow.concurrency` in `~/.botmux/config.json` > the runtime's
 * code default (global 4 / perBot 1 / perCli 2, left to `runWorkflow`).
 * Fields that resolve to nothing are omitted so the runtime default applies.
 */
import type { WorkflowConcurrencyConfig } from '../../global-config.js';
import type { V3RuntimeOptions } from './shared-node-runtime.js';

export interface V3ConcurrencyOverrides {
  global?: number;
  perBot?: number;
  /** Applies to every CLI, including ones listed in config `perCliById`. */
  perCli?: number;
}

export type V3ConcurrencyOptions = Pick<
  V3RuntimeOptions,
  'globalConcurrency' | 'perBotConcurrency' | 'perCliConcurrency' | 'perCliConcurrencyById'
>;

export function resolveV3Concurrency(
  config: WorkflowConcurrencyConfig | undefined,
  overrides: V3ConcurrencyOverrides = {},
): V3ConcurrencyOptions {
  const out: V3ConcurrencyOptions = {};
  const global = overrides.global ?? config?.global;
  if (global !== undefined) out.globalConcurrency = global;
  const perBot = overrides.perBot ?? config?.perBot;
  if (perBot !== undefined) out.perBotConcurrency = perBot;
  if (overrides.perCli !== undefined) {
    // An explicit per-CLI cap is a single knob for this run: it wins over the
    // config's per-CLI table too, otherwise `--max-per-cli 1` would not hold.
    out.perCliConcurrency = overrides.perCli;
  } else {
    if (config?.perCli !== undefined) out.perCliConcurrency = config.perCli;
    if (config?.perCliById && Object.keys(config.perCliById).length > 0) {
      out.perCliConcurrencyById = { ...config.perCliById };
    }
  }
  return out;
}
