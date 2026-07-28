import { describe, expect, it } from 'vitest';
import {
  decideCodexRunnerFreshness,
  shouldHoldCodexRunnerInput,
  transitionOnCodexRunnerPrompt,
} from '../src/services/codex-runner-freshness.js';

describe('Codex App runner freshness', () => {
  const stale = {
    cliId: 'codex-app',
    adoptMode: false,
    persistentReattach: true,
    currentBuildId: 'new',
    persistedBuildId: 'old',
  };

  it('holds a stale busy runner until old idle then fresh prompt-ready', () => {
    expect(decideCodexRunnerFreshness(stale).state).toBe('stale_waiting_idle');
    expect(shouldHoldCodexRunnerInput('stale_waiting_idle')).toBe(true);
    const oldIdle = transitionOnCodexRunnerPrompt('stale_waiting_idle');
    expect(oldIdle).toEqual({ state: 'restarting_fresh', action: 'reload' });
    expect(shouldHoldCodexRunnerInput(oldIdle.state)).toBe(true);
    expect(transitionOnCodexRunnerPrompt(oldIdle.state)).toEqual({
      state: 'current',
      action: 'publish_ready',
    });
  });

  it('fails safe for unknown identity and excludes adopt/non-app sessions', () => {
    expect(decideCodexRunnerFreshness({ ...stale, currentBuildId: undefined }).state).toBe('unknown');
    expect(decideCodexRunnerFreshness({ ...stale, adoptMode: true }).reason).toBe('adopt_session');
    expect(decideCodexRunnerFreshness({ ...stale, cliId: 'codex' }).reason).toBe('not_codex_app');
  });

  it('fails closed when a requested fresh replacement reattaches the old backend', () => {
    expect(decideCodexRunnerFreshness({
      ...stale,
      replacementExpectedFresh: true,
    })).toEqual({
      state: 'failed',
      reason: 'replacement_reattached',
      persistOnReady: false,
    });
    expect(shouldHoldCodexRunnerInput('failed')).toBe(true);
    expect(decideCodexRunnerFreshness({
      ...stale,
      currentBuildId: undefined,
      replacementExpectedFresh: true,
    }).reason).toBe('replacement_reattached');
  });
});
