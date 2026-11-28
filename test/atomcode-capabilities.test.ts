import { describe, expect, it } from 'vitest';
import {
  ATOMCODE_REASONING_EFFORTS,
  cliModelSupportsReasoningEffort,
  isConfigurableReasoningCliId,
  reasoningEffortsForCliModel,
} from '../src/services/codex-reasoning-effort.js';
import {
  APP_RUNNER_OSC_CLI_IDS,
  hasAppRunnerOscControlChannel,
  hasTurnTerminalCapability,
} from '../src/services/turn-terminal-capability.js';
import { runnerFinalOutcome } from '../src/services/runner-final-outcome.js';
import { LAUNCH_MODEL_CLI_IDS, botAcceptsLaunchModel } from '../src/core/launch-model-capability.js';
import { MinimaxFinalReceiver } from '../src/services/minimax-final-control.js';

describe('AtomCode runtime capabilities', () => {
  it('enables OSC runner control channel and reliable turn terminal', () => {
    expect(APP_RUNNER_OSC_CLI_IDS.has('atomcode')).toBe(true);
    expect(hasAppRunnerOscControlChannel('atomcode')).toBe(true);
    expect(hasTurnTerminalCapability({ cliId: 'atomcode' })).toBe(true);
  });

  it('maps runner final errorCode outcomes identically to ACP runners', () => {
    expect(runnerFinalOutcome('atomcode', undefined)).toEqual({ status: 'completed' });
    expect(runnerFinalOutcome('atomcode', 'cancelled')).toEqual({ status: 'cancelled', errorCode: 'cancelled' });
    expect(runnerFinalOutcome('atomcode', 'turn_budget_exhausted')).toEqual({
      status: 'failed',
      errorCode: 'turn_budget_exhausted',
    });
    expect(runnerFinalOutcome('atomcode', 'unexpected')).toEqual({
      status: 'failed',
      errorCode: 'execution_failed',
    });
  });

  it('uses the dynamic CLI label in chunked final error notices', () => {
    const delivered: Array<Record<string, unknown>> = [];
    const receiver = new MinimaxFinalReceiver(payload => delivered.push(payload), undefined, () => 'AtomCode');
    receiver.accept('final-end', { id: 'missing-start', total: 1, turnId: 't1' }, { turnId: 't1' });
    expect(delivered[0]).toMatchObject({
      errorCode: 'execution_failed',
      content: 'AtomCode 最终回答缺少起始帧。',
    });
  });

  it('exposes launch model and AtomCode ACP reasoning efforts (high, max)', () => {
    expect(LAUNCH_MODEL_CLI_IDS.has('atomcode')).toBe(true);
    expect(botAcceptsLaunchModel({ cliId: 'atomcode' })).toBe(true);
    expect(isConfigurableReasoningCliId('atomcode')).toBe(true);
    expect(ATOMCODE_REASONING_EFFORTS).toEqual(['high', 'max']);
    expect(reasoningEffortsForCliModel('atomcode', 'codingplan/glm-5')).toEqual(['high', 'max']);
    expect(cliModelSupportsReasoningEffort('atomcode', undefined, 'high')).toBe(true);
    expect(cliModelSupportsReasoningEffort('atomcode', undefined, 'max')).toBe(true);
    expect(cliModelSupportsReasoningEffort('atomcode', undefined, 'low')).toBe(false);
    expect(cliModelSupportsReasoningEffort('atomcode', undefined, 'ultra')).toBe(false);
  });
});
