/**
 * schedule-model-override.test.ts
 *
 * Per-task model / reasoning effort (ScheduledTask.model / .reasoningEffort),
 * resolved against the live bot at fire time.
 *
 * The point of the unit is fail-soft: a schedule pins its model months before a
 * run, and by then the bot may run another CLI or a model that dropped a level.
 * None of that may turn into a skipped run — it degrades to the bot's own
 * configuration and reports why.
 */
import { describe, it, expect } from 'vitest';
import { resolveScheduleModelOverride } from '../src/core/schedule-model-override.js';

const CODEX = { cliId: 'codex' as const, model: 'gpt-5.5' };

describe('resolveScheduleModelOverride — nothing asked for', () => {
  it('a task without an override resolves to nothing and warns about nothing', () => {
    expect(resolveScheduleModelOverride({}, CODEX)).toEqual({ warnings: [] });
  });

  it('an all-whitespace model is not an override', () => {
    expect(resolveScheduleModelOverride({ model: '   ' }, CODEX)).toEqual({ warnings: [] });
  });
});

describe('resolveScheduleModelOverride — codex', () => {
  it('passes a pinned model and effort through', () => {
    expect(resolveScheduleModelOverride(
      { model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
      CODEX,
    )).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', warnings: [] });
  });

  it('trims the stored model', () => {
    expect(resolveScheduleModelOverride({ model: '  gpt-5.2  ' }, CODEX).model).toBe('gpt-5.2');
  });

  it('validates effort against the TASK model, not the bot model', () => {
    // ultra exists on gpt-5.6-sol but not on the bot's configured gpt-5.5. The
    // task pinned the former, so the pairing is legal.
    const resolved = resolveScheduleModelOverride(
      { model: 'gpt-5.6-sol', reasoningEffort: 'ultra' },
      CODEX,
    );
    expect(resolved).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'ultra', warnings: [] });
  });

  it('drops an effort the resolved model does not offer, keeping the model', () => {
    const resolved = resolveScheduleModelOverride(
      { model: 'gpt-5.5', reasoningEffort: 'ultra' },
      CODEX,
    );
    expect(resolved.model).toBe('gpt-5.5');
    expect(resolved.reasoningEffort).toBeUndefined();
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain('ultra');
  });

  it('an effort-only task is validated against the BOT model', () => {
    // No task model → the run uses gpt-5.5, which caps at xhigh.
    expect(resolveScheduleModelOverride({ reasoningEffort: 'ultra' }, CODEX).reasoningEffort)
      .toBeUndefined();
    expect(resolveScheduleModelOverride({ reasoningEffort: 'high' }, CODEX))
      .toEqual({ reasoningEffort: 'high', warnings: [] });
  });
});

describe('resolveScheduleModelOverride — CLI gate', () => {
  it('drops both on a CLI without the per-turn model contract', () => {
    // Mirrors the trigger API gate: a codex model id must never reach a Gemini
    // bot just because someone re-pointed the task's bot.
    const resolved = resolveScheduleModelOverride(
      { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      { cliId: 'gemini' },
    );
    expect(resolved.model).toBeUndefined();
    expect(resolved.reasoningEffort).toBeUndefined();
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain('gemini');
  });

  it('says so explicitly when the bot has no cliId at all', () => {
    const resolved = resolveScheduleModelOverride({ model: 'gpt-5.5' }, {});
    expect(resolved.model).toBeUndefined();
    expect(resolved.warnings[0]).toContain('(unset)');
  });

  it('a task with no override stays silent even on an unsupported CLI', () => {
    expect(resolveScheduleModelOverride({}, { cliId: 'gemini' })).toEqual({ warnings: [] });
  });

  it('claude-code takes an override too, but not codex-only ultra', () => {
    expect(resolveScheduleModelOverride(
      { model: 'claude-opus-5', reasoningEffort: 'max' },
      { cliId: 'claude-code' },
    )).toEqual({ model: 'claude-opus-5', reasoningEffort: 'max', warnings: [] });

    const ultra = resolveScheduleModelOverride(
      { model: 'claude-opus-5', reasoningEffort: 'ultra' },
      { cliId: 'claude-code' },
    );
    expect(ultra.model).toBe('claude-opus-5');
    expect(ultra.reasoningEffort).toBeUndefined();
  });
});
