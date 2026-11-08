/**
 * Per-task model / reasoning-effort resolution for scheduled tasks.
 *
 * A schedule stores `model` / `reasoningEffort` as plain user intent, captured
 * possibly months before the run and validated against the bot as it was THEN.
 * By fire time the bot may run another CLI entirely, or the pinned model may not
 * offer that effort level. This resolves the intent against the live bot config
 * and reports what it had to drop.
 *
 * Dropping is deliberate: a scheduled run that refuses to fire because a model
 * name went stale is strictly worse than one that runs on the bot's default and
 * says so — the same fail-soft rule `sessionAgentConfig` already applies to a
 * session-level effort whose model stopped supporting it.
 */
import type { CliId } from '../adapters/cli/types.js';
import { cliModelSupportsReasoningEffort } from '../services/codex-reasoning-effort.js';
import type { ScheduleReasoningEffort } from '../services/schedule-store.js';
import { allowsTaskModelOverride } from './launch-model-capability.js';

export interface ScheduleModelOverride {
  /** Feeds DaemonSession.spawnModelOverride — absent means "bot's model". */
  model?: string;
  /** Feeds session.reasoningEffort — absent means "bot's effort". */
  reasoningEffort?: ScheduleReasoningEffort;
  /** Human-readable reasons an intent was dropped; the caller logs them. Empty
   *  when the task asked for nothing, or got everything it asked for. */
  warnings: string[];
}

/**
 * Resolve a task's stored override against the bot that will actually run it.
 *
 * The CLI policy mirrors the trigger API (`trigger-session.ts`), independently
 * of bot-level reasoning controls and general adapter model support.
 */
export function resolveScheduleModelOverride(
  task: { model?: string; reasoningEffort?: ScheduleReasoningEffort },
  botCfg: { cliId?: CliId; model?: string },
): ScheduleModelOverride {
  const model = task.model?.trim() || undefined;
  const requestedEffort = task.reasoningEffort;
  if (!model && !requestedEffort) return { warnings: [] };

  if (!allowsTaskModelOverride(botCfg.cliId)) {
    return {
      warnings: [
        `CLI ${botCfg.cliId ?? '(unset)'} does not support per-task model/effort; `
        + 'running on the bot configuration instead',
      ],
    };
  }

  const warnings: string[] = [];
  // Effort is validated against the model this run will actually use, which is
  // the task's own model when it pinned one and the bot's otherwise.
  const effectiveModel = model ?? botCfg.model;
  let reasoningEffort = requestedEffort;
  if (reasoningEffort
      && !cliModelSupportsReasoningEffort(botCfg.cliId, effectiveModel, reasoningEffort)) {
    warnings.push(
      `model ${effectiveModel ?? '(CLI default)'} does not support reasoning effort `
      + `${reasoningEffort}; running without it`,
    );
    reasoningEffort = undefined;
  }

  return { ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), warnings };
}
